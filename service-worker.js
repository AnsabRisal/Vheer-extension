/**
 * Vheer Story Studio — Service Worker (Manifest V3)
 *
 * Supports both https://vheer.com/app/text-to-image (Text→Image) and
 * https://vheer.com/app/image-to-video (Image→Video). Test connection and
 * message routing are mode-aware: the side panel passes its mode, and tab
 * lookup targets the route for that mode.
 *
 * Connection model: URL match (per mode) → content script → DOM ready → key
 * control found (prompt textarea / upload input). No frame/iframe concept.
 * Every message targets the top document.
 *
 * Orchestrates: page detection (URL), test fill / test generate, queue
 * management, shot processing, native-download interception + rename,
 * between-shot delay (fixed or random), and resume on restart.
 */

importScripts('lib/parser.js', 'lib/storage.js');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  delayMode: 'fixed',       // 'fixed' | 'random'
  delayBetweenShotsSec: 6,
  delayMinSec: 25,          // for random mode
  delayMaxSec: 45,          // for random mode
  filenameFormat: 'SHOT{N}',
  retries: 3,
  projectName: 'Vheer Project',
  // --- Watchdog settings ---
  maxStallSec: 90,          // silent period before STALLED verdict
  maxGenSec: 600,           // hard cap per generation attempt (10 min)
  pollIntervalMs: 2000,     // watchdog tick interval
  recoveryDelaySec: 5,      // pause after overlay/popup dismiss before retry
  retryDelaySec: 25         // delay before retry after reload/stall (video mode)
};

const TARGET_URL = 'https://vheer.com/app/text-to-image';
const TARGET_URL_VIDEO = 'https://vheer.com/app/image-to-video';

/** Does `path` equal `route` or descend under `route + '/'`? */
function pathMatchesVheer(path, route) {
  return path === route || path.startsWith(route + '/');
}

/**
 * Validate a Vheer app URL by parsing it (hostname + pathname).
 * Accepts both the Text→Image and Image→Video routes.
 * Tolerates trailing slash, query params, hashes, and trailing punctuation.
 */
function isVheerAppUrl(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host !== 'vheer.com' && host !== 'www.vheer.com') return false;
    // Normalize: strip a single trailing period (accidental punctuation).
    let path = url.pathname.toLowerCase();
    if (path.endsWith('.')) path = path.slice(0, -1);
    return pathMatchesVheer(path, '/app/text-to-image') || pathMatchesVheer(path, '/app/image-to-video');
  } catch (e) {
    return false;
  }
}

/** True only on the Image→Video page. */
function isVheerVideoUrl(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host !== 'vheer.com' && host !== 'www.vheer.com') return false;
    let path = url.pathname.toLowerCase();
    if (path.endsWith('.')) path = path.slice(0, -1);
    return pathMatchesVheer(path, '/app/image-to-video');
  } catch (e) {
    return false;
  }
}

/**
 * DEBUG-ONLY mirror of isVheerAppUrl() for the service-worker side.
 * Logs each comparison's result. Does not change the validator.
 */
function diagnoseVheerUrl(href) {
  const out = {
    location: 'service-worker',
    rawHref: href,
    jsonStringify: JSON.stringify(href),
    expectedUrl: TARGET_URL,
    validatorResult: isVheerAppUrl(href)
  };
  try {
    const url = new URL(href);
    out.protocol = url.protocol;
    out.hostname = url.hostname;
    out.hostnameLower = url.hostname.toLowerCase();
    out.pathname = url.pathname;
    let path = url.pathname.toLowerCase();
    if (path.endsWith('.')) path = path.slice(0, -1);
    out.pathnameNormalized = path;

    out.stepProtocolOk = url.protocol === 'http:' || url.protocol === 'https:';
    out.stepHostnameOk = out.hostnameLower === 'vheer.com' || out.hostnameLower === 'www.vheer.com';
    out.stepPathnameOk = pathMatchesVheer(path, '/app/text-to-image') || pathMatchesVheer(path, '/app/image-to-video');

    // Extra instrumentation fields (informational only — not used by validator).
    out.hostnameMatch = out.hostnameLower === 'vheer.com';
    out.hostnameWwwMatch = out.hostnameLower === 'www.vheer.com';
    out.pathnameExactMatch = path === '/app/text-to-image' || path === '/app/image-to-video';
    out.pathnamePrefixMatch = path.startsWith('/app/text-to-image/') || path.startsWith('/app/image-to-video/');
    out.hrefExactMatch = href === TARGET_URL || href === TARGET_URL_VIDEO;
    out.hrefStartsWith = !!href && (href.startsWith(TARGET_URL) || href.startsWith(TARGET_URL_VIDEO));
    out.hrefEndsWithPath = !!href && (href.endsWith('/app/text-to-image') || href.endsWith('/app/image-to-video'));
    out.hrefEndsWithPathSlash = !!href && (href.endsWith('/app/text-to-image/') || href.endsWith('/app/image-to-video/'));

    const failed = [];
    if (!out.stepProtocolOk) failed.push('protocol');
    if (!out.stepHostnameOk) failed.push('hostname');
    if (!out.stepPathnameOk) failed.push('pathname');
    out.failedChecks = failed;

    out.allStepsOk = out.stepProtocolOk && out.stepHostnameOk && out.stepPathnameOk;
    out.ok = out.allStepsOk;
    out.failedStep = failed.length === 0 ? 'none' : failed[0];
  } catch (e) {
    out.parseError = e.message;
    out.failedStep = 'URL parse error';
    out.failedChecks = ['URL parse error'];
    out.ok = false;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

function emptyQueue(mode = 'image') {
  return {
    mode,                    // 'image' | 'video' — which parser/provider owns this queue
    projectName: '',
    shots: [],
    currentShotNumber: null,
    status: 'idle',          // idle | running | paused | done | error
    stats: { waiting: 0, completed: 0, failed: 0, approved: 0, generating: 0 },
    delayEndsAt: null,       // timestamp when the current delay expires
    // Canary / health-check state (image mode only; one shot gates the batch).
    canaryDone: false,       // canary shot completed successfully → batch may run
    canaryShot: null,        // shot number currently serving as the canary
    canaryState: null,       // 'running' | 'completed' | 'failed' | null
    error: null              // batch-level error (e.g. canary failed)
  };
}

function recomputeStats(shots) {
  const stats = {
    waiting: 0, completed: 0, failed: 0, approved: 0, generating: 0,
    retries: 0, avgGenSec: 0, longestSec: 0
  };
  for (const s of shots) { if (stats[s.status] !== undefined) stats[s.status]++; }
  // Aggregate timing stats from completed shots with valid duration.
  stats.retries = shots.reduce((sum, s) => sum + (s.retryCount || 0), 0);
  const timed = shots.filter(s => s.status === 'completed' && s.durationSec != null);
  if (timed.length) {
    stats.avgGenSec = Math.round(timed.reduce((sum, s) => sum + s.durationSec, 0) / timed.length);
    stats.longestSec = Math.max(...timed.map(s => s.durationSec));
  }
  return stats;
}

function nextPending(shots) {
  return shots.find(s => s.status === 'waiting' || s.status === 'generating') || null;
}

function formatFilename(num, total, format, ext = '.png') {
  const w = Math.max(3, String(total).length);
  return (format || 'SHOT{N}').replace('{N}', String(num).padStart(w, '0')) + ext;
}

function delaySec(settings) {
  if (settings.delayMode === 'random') {
    const min = Math.min(settings.delayMinSec, settings.delayMaxSec);
    const max = Math.max(settings.delayMinSec, settings.delayMaxSec);
    return Math.round(min + Math.random() * (max - min));
  }
  return settings.delayBetweenShotsSec || 6;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/** Storage key for a queue, by mode. Image keeps the legacy 'queue' key. */
function queueKey(mode) {
  return mode === 'video' ? 'videoQueue' : 'queue';
}

async function saveQueue(queue) {
  queue.stats = recomputeStats(queue.shots);
  await Storage.set({ [queueKey(queue.mode)]: queue });
}

async function loadQueue(mode) {
  const key = queueKey(mode);
  const s = await Storage.get(key);
  return (s && s[key]) || emptyQueue(mode);
}

async function loadSettings() {
  const { settings } = await Storage.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function broadcastQueue(queue) {
  queue.stats = recomputeStats(queue.shots);
  broadcast({ type: queue.mode === 'video' ? 'VIDEO_QUEUE_UPDATE' : 'QUEUE_UPDATE', queue });
}

function debugLog(step, detail, ok = true) {
  const entry = { ts: Date.now(), step, detail: detail || '', ok };
  console[ok ? 'log' : 'warn']('[SW]', ok ? '✓' : '✗', step, detail || '');
  broadcast({ type: 'DEBUG_LOG', entry });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Tabs whose content script has announced CONTENT_READY (cache, not required). */
const readyTabs = new Set();

// Prune the cache when a tab closes.
chrome.tabs.onRemoved.addListener((tabId) => { readyTabs.delete(tabId); });

/**
 * Send a message to a tab's MAIN frame, retrying with backoff on:
 *  - "Receiving end does not exist" / "Could not establish connection"
 *    (listener not registered yet — race right after a page load), and
 *  - a resolved-but-empty response (undefined: listener present but did not
 *    call sendResponse — stale/broken content script).
 * Fixes both the injection race and the "message delivered, no reply" case.
 */
async function sendToMainFrame(tabId, msg, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
      if (resp === undefined && i < retries - 1) {
        lastErr = new Error('no response from content script');
        await sleep(300 * (i + 1));
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      const m = (err && err.message) || '';
      if (/Receiving end does not exist|Could not establish connection/i.test(m)) {
        if (i < retries - 1) await sleep(300 * (i + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function handleSaveSettings(newSettings) {
  const merged = { ...DEFAULT_SETTINGS, ...(newSettings || {}) };
  await Storage.set({ settings: merged });
  debugLog('Settings saved', 'delay=' + merged.delayBetweenShotsSec + 's');
  return { ok: true, settings: merged };
}

// ---------------------------------------------------------------------------
// Vheer tab / content-script connection
// ---------------------------------------------------------------------------

/**
 * Find the Vheer tab for a generation mode (prefer a ready one, then the page).
 * Image runs target Text→Image tabs only; video runs target Image→Video only —
 * the two workflows never cross-contaminate.
 * Pass { video: true } to target the Image→Video route.
 */
async function findTargetTab(opts) {
  const video = opts && opts.video;
  const tabs = await chrome.tabs.query({ url: '*://vheer.com/app/*' });
  const valid = tabs.filter(t => t.url && isVheerAppUrl(t.url));
  const pool = video ? valid.filter(t => isVheerVideoUrl(t.url)) : valid.filter(t => !isVheerVideoUrl(t.url));
  return pool.find(t => readyTabs.has(t.id)) || pool[0] || null;
}

/**
 * Inject the content script and SURFACE a silent top-level crash back to the
 * SW. MV3 executeScript does not reject when the injected script throws at
 * top level — it resolves with per-frame InjectionResult[] (errors only in
 * the `error` field) and the exception lands in the page console, invisible
 * to us. So we inspect the results AND probe a "loaded" flag the script sets
 * on success. This is what distinguishes "injected fine" from "injected and
 * crashed" (candidate B).
 */
async function injectVheerScript(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content-scripts/vheer.js']
    });
    const frames = (results || []).map(r => ({
      frameId: r.frameId,
      ranCleanly: !r.error,
      error: r.error || undefined
    }));
    debugLog('Injection OK', frames.length + ' frames' + (frames.some(f => f.error) ? ' (SOME FRAMES ERRORED)' : ''));
    for (const f of frames) {
      if (f.error) debugLog('Injection frame error', 'frame ' + f.frameId + ': ' + f.error, false);
    }

    // Probe the "loaded" flag in the same isolated world.
    await sleep(150);
    try {
      const probe = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: () => ({
          loaded: !!window.__vheerStoryLoaded,
          error: window.__vheerStoryError || null,
          version: window.__vheerStoryVersion || null
        })
      });
      const p = probe && probe[0] && probe[0].result;
      debugLog('Injection probe', p
        ? 'loaded=' + p.loaded + (p.error ? ' CRASH: ' + String(p.error).slice(0, 160) : '') + (p.version ? ' v' + p.version : '')
        : 'no probe result');
    } catch (eProbe) {
      debugLog('Injection probe failed', eProbe.message, false);
    }

    return { ok: true, frames };
  } catch (e) {
    console.error('[SW] executeScript FAILED:', e);
    debugLog('Injection ERROR', e.message, false);
    return { ok: false, error: e.message, fullError: e };
  }
}

/**
 * Make sure a live content script is listening in the tab.
 * If the declarative injection is stale (page loaded before an extension
 * reload, or an SPA route change), re-inject content-scripts/vheer.js
 * programmatically, then confirm with a retried PING.
 * Returns the PING payload (incl. content-script version) on success.
 */
async function ensureContentScript(tabId) {
  let pong = null;
  try {
    pong = await sendToMainFrame(tabId, { type: 'PING' });
  } catch (err) {
    pong = null;
  }
  if (pong && pong.ok) {
    readyTabs.add(tabId);
    return { ok: true, pong };
  }

  // No live script — inject it programmatically, then re-PING.
  const inj = await injectVheerScript(tabId);
  const injected = inj.ok;
  await sleep(400);
  try {
    pong = await sendToMainFrame(tabId, { type: 'PING' });
    if (pong && pong.ok) {
      readyTabs.add(tabId);
      return { ok: true, injected, pong };
    }
    return { ok: false, error: 'Content script unreachable after injection', injected };
  } catch (e3) {
    return { ok: false, error: 'Content script unreachable: ' + e3.message, injected };
  }
}

/**
 * Full connection handshake used by Test Connection:
 *   PING (inject if absent) → CHECK_READY (retried), with a FORCED
 *   re-injection fallback when CHECK_READY gets no reply at all.
 *
 * Defends against the two cases that bite in practice:
 *   a) SPA navigation — the page routed to /app/text-to-image without a full
 *      load, so the declarative injection never ran; re-injection fixes it.
 *   b) A stale/broken content script whose PING answers but whose CHECK_READY
 *      handler doesn't reply (old version still resident after a reload).
 */
async function connectToContentScript(tabId) {
  const ensured = await ensureContentScript(tabId);
  if (!ensured.ok) {
    return { ok: false, step: 'script', error: ensured.error, diagnostics: { injected: ensured.injected } };
  }
  const version = (ensured.pong && ensured.pong.version) || 'unknown';
  debugLog('Content script reachable', 'v' + version + (ensured.injected ? ' (fresh injection)' : ''));

  // CHECK_READY with no-response retries (sendToMainFrame handles the backoff).
  let ready;
  try {
    ready = await sendToMainFrame(tabId, { type: 'CHECK_READY' });
  } catch (err) {
    return { ok: false, step: 'messaging', error: 'CHECK_READY threw: ' + err.message };
  }

  // No reply → force a fresh re-injection (idempotent: the new instance
  // removes the stale listener), probe whether it actually loaded, then try
  // CHECK_READY one final time.
  if (ready === null || ready === undefined) {
    debugLog('CHECK_READY no response', 'forcing fresh re-injection', false);
    const inj = await injectVheerScript(tabId);
    await sleep(500);
    try {
      ready = await sendToMainFrame(tabId, { type: 'CHECK_READY' });
    } catch (err) {
      return { ok: false, step: 'messaging', error: 'CHECK_READY (after re-inject) threw: ' + err.message };
    }
    if (ready === null || ready === undefined) {
      return {
        ok: false,
        step: 'no-response',
        error: 'Content script still did not respond after fresh re-injection (injection ok=' + inj.ok + '). Refresh the Vheer tab and retry. See debug console for the injection probe result.',
        reInjected: true,
        injection: inj
      };
    }
  }

  return { ok: true, ready };
}

/** Send a message to the Vheer tab's content script (main frame only). */
async function routeToContentScript(msg) {
  const isVideo = (msg && msg.mode) === 'video';
  const tab = await findTargetTab(isVideo ? { video: true } : undefined);
  if (!tab) return { ok: false, step: 'tab', error: 'No Vheer tab found. Open ' + (isVideo ? TARGET_URL_VIDEO : TARGET_URL) };

  const ensured = await ensureContentScript(tab.id);
  if (!ensured.ok) return { ok: false, step: 'script', error: ensured.error };

  try {
    const resp = await sendToMainFrame(tab.id, msg);
    return resp;
  } catch (err) {
    return { ok: false, step: 'messaging', error: 'Content script not responding: ' + err.message };
  }
}

// ---------------------------------------------------------------------------
// Test Connection
// ---------------------------------------------------------------------------

async function handleTestConnection(msg) {
  const isVideo = (msg && msg.mode) === 'video';
  const targetUrl = isVideo ? TARGET_URL_VIDEO : TARGET_URL;
  debugLog('Testing connection…', isVideo ? 'VIDEO mode (image-to-video)' : 'IMAGE mode (text-to-image)');

  const tab = await findTargetTab(isVideo ? { video: true } : undefined);
  if (!tab) {
    debugLog('No Vheer tab', 'Navigate to ' + targetUrl, false);
    return { ok: false, step: 'tab', error: 'No Vheer tab found. Open ' + targetUrl };
  }
  debugLog('Vheer tab found', tab.url);

  // Full handshake: PING (inject if absent) → CHECK_READY (retried), with
  // forced re-injection if CHECK_READY gets no reply. Defends against SPA
  // navigation and stale/broken content scripts.
  const conn = await connectToContentScript(tab.id);
  if (!conn.ok) {
    debugLog('Connection failed', conn.error, false);
    return { ...conn, tabUrl: tab.url };
  }
  const ready = conn.ready;

  // TRACE STEP 4 (received on SW): reply from content script.
  debugLog('TRACE 4/4', 'sendMessage resolved. ready=' + (ready === null ? 'null' : ready === undefined ? 'undefined' : 'object'));

  // CASE 1: still no reply (connectToContentScript already re-injected once).
  if (ready === null || ready === undefined) {
    console.log('READY-VALUE raw:', ready);
    debugLog('Content script did not respond', 'no reply to CHECK_READY', false);
    return {
      ok: false,
      step: 'no-response',
      error: 'Content script did not respond to CHECK_READY even after fresh re-injection. Refresh the Vheer tab and retry.',
      tabUrl: tab.url
    };
  }

  // CASE 2: content script replied but reported not-ready.
  if (!ready.ok) {
    const info = ready.info || {};
    const csDiag = ready.urlDiag || null;
    const reason = ready.error || (info.targetPage === false
      ? 'URL does not match ' + targetUrl + ' — Actual: ' + (info.url || tab.url)
      : 'content script reported not ready');
    console.log('READY-VALUE raw:', ready);
    console.log('READY-VALUE ready.ok:', ready.ok);
    console.log('READY-VALUE ready.info:', info);
    console.log('READY-VALUE ready.urlDiag:', csDiag);
    debugLog('Content script not ready', reason, false);
    return {
      ok: false,
      step: 'content-script-not-ready',
      error: reason,
      info,
      urlDiag: csDiag ? { sw: diagnoseVheerUrl(tab.url), cs: csDiag } : null
    };
  }

  const info = ready.info || {};
  debugLog('URL verified', info.url);

  const promptFound = !!info.promptFound;
  const uploadFound = !!info.uploadFound;
  if (isVideo) {
    if (uploadFound) debugLog('Upload Input Found', 'detected');
    else debugLog('Upload Input Found', 'NOT detected — check the element dump', false);
  } else if (promptFound) {
    debugLog('Prompt Found', 'textarea detected');
  } else {
    // Dump every candidate element so we can see what the page actually has.
    const els = info.elements;
    const counts = els && els.counts
      ? `textarea=${els.counts.textareas} input=${els.counts.inputs} button=${els.counts.buttons} select=${els.counts.selects} editable=${els.counts.contenteditable}`
      : 'no element dump';
    debugLog('Prompt Found', 'NOT detected — dumping elements (' + counts + ')', false);
  }

  debugLog('Connected to Vheer', 'CONNECTED');
  return {
    ok: true,
    status: 'CONNECTED',
    mode: isVideo ? 'video' : 'image',
    generatorDetected: !!info.generateFound,
    promptFound,
    uploadFound,
    info,
    tabUrl: tab.url
  };
}

// ---------------------------------------------------------------------------
// Download interception + rename
// ---------------------------------------------------------------------------

/** Set while a shot's download is expected. onDeterminingFilename renames it. */
let expectedDownload = null;

// ---------------------------------------------------------------------------
// In-flight run control (hard Stop). One AbortController per run; Stop calls
// abort() so every await in the per-shot pipeline bails immediately, and the
// runStopped flag makes event-driven handlers (onChanged, alarms, failShot)
// ignore stale work instead of continuing it.
// ---------------------------------------------------------------------------

let activeRun = null;   // AbortController for the current run
let currentSignal = null; // the run's signal (checked at every await)
let runStopped = false; // true from Stop until the next Start/Resume

// Shots currently being processed (`${mode}:${shotNumber}`). Guarantees exactly
// one pipeline per shot: a second processShot() for the same shot is blocked
// instead of duplicating every DOM action on the Vheer page.
const _activeShots = new Set();

function beginRun() {
  runStopped = false;
  activeRun = new AbortController();
  currentSignal = activeRun.signal;
  return currentSignal;
}

function stopRun() {
  runStopped = true;
  if (activeRun) { try { activeRun.abort(); } catch (e) {} activeRun = null; }
  currentSignal = null;
}

function isRunStopped() { return runStopped; }

/** Clear every pending per-shot timer so nothing can fire late after Stop. */
function clearAllShotAlarms() {
  chrome.alarms.getAll((alarms) => {
    for (const a of alarms || []) {
      if (a.name.startsWith('retry-') || a.name.startsWith('dl-timeout-') || a.name.startsWith('gen-timeout-')) {
        chrome.alarms.clear(a.name);
      }
    }
  });
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!expectedDownload) { suggest(); return; }
  if (isRunStopped()) { suggest(); return; }  // stopped — let it fall through unrenamed
  const { shotNumber, projectName, total, mode } = expectedDownload;
  const isVideo = mode === 'video';
  const folder = isVideo ? 'Videos' : 'Images';
  const ext = isVideo ? '.mp4' : '.png';
  const filename = projectName + '/' + folder + '/' + formatFilename(shotNumber, total, 'SHOT{N}', ext);
  debugLog('Download Started', filename);
  // The download started — re-arm the watchdog for slow downloads.
  chrome.alarms.create(isVideo ? 'dl-timeout-video-' + shotNumber : 'dl-timeout-' + shotNumber, { delayInMinutes: 10 });
  suggest({ filename, conflictAction: 'overwrite' });
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!expectedDownload) return;
  if (isRunStopped()) return; // Stop pressed — ignore in-flight download events
  if (delta.state && delta.state.current === 'complete') {
    await handleDownloadComplete(delta.id);
  } else if (delta.state && delta.state.current === 'interrupted') {
    const { shotNumber, mode } = expectedDownload;
    const m = mode === 'video' ? 'video' : 'image';
    expectedDownload = null;
    chrome.alarms.clear(m === 'video' ? 'dl-timeout-video-' + shotNumber : 'dl-timeout-' + shotNumber);
    debugLog('Download interrupted', 'retrying shot ' + shotNumber, false);
    failShot(m, shotNumber, 'Download interrupted');
  }
});

async function handleDownloadComplete(downloadId) {
  const { shotNumber, mode } = expectedDownload;
  const m = mode === 'video' ? 'video' : 'image';
  expectedDownload = null;
  chrome.alarms.clear(m === 'video' ? 'dl-timeout-video-' + shotNumber : 'dl-timeout-' + shotNumber);
  chrome.alarms.clear(m === 'video' ? 'retry-video-' + shotNumber : 'retry-' + shotNumber);
  chrome.alarms.clear(m === 'video' ? 'gen-timeout-video-' + shotNumber : 'gen-timeout-' + shotNumber);
  if (isRunStopped()) return; // Stop pressed — don't advance the queue

  const queue = await loadQueue(m);
  const settings = await loadSettings();
  const shot = queue.shots.find(s => s.number === shotNumber);
  if (!shot || shot.status === 'completed') return;

  const verified = await verifyDownload(downloadId, 30000);
  if (!verified.ok) {
    debugLog('Download verification failed', verified.error, false);
    failShot(m, shotNumber, 'Verification: ' + verified.error);
    return;
  }

  debugLog('Download Completed', verified.details);
  shot.status = 'completed';
  shot.retryCount = 0;
  shot.endedAt = Date.now();
  shot.durationSec = (shot.startedAt && shot.endedAt)
    ? Math.round((shot.endedAt - shot.startedAt) / 1000) : null;
  queue.currentShotNumber = null;

  // Canary passed → unlock the batch (image mode only; persisted across restarts).
  if (m !== 'video' && queue.canaryShot === shotNumber && queue.canaryState === 'running') {
    queue.canaryDone = true;
    queue.canaryShot = null;
    queue.canaryState = 'completed';
    debugLog('Canary passed', 'SHOT ' + shotNumber + ' — starting batch');
    broadcast({ type: 'CANARY_SUCCEEDED', shotNumber });
  }

  await saveQueue(queue);
  broadcastQueue(queue);

  // Structured shot report for the sidepanel.
  broadcast({
    type: 'SHOT_REPORT',
    shotNumber,
    startedAt: shot.startedAt,
    generationSec: shot.durationSec,
    retries: shot.retryCount || 0,
    downloaded: true,
    status: 'SUCCESS'
  });

  // VIDEO: after a confirmed download, Vheer stays on the completed-result
  // state (generated video + Download/Delete buttons). The next shot cannot
  // upload until that result is deleted. So click Delete, wait for the fresh
  // upload state, and only then advance — with NO arbitrary between-shot delay.
  if (m === 'video') {
    debugLog('Video Cleanup', 'SHOT ' + shotNumber + ' — resetting Vheer result state');
    try {
      const tab = await findTargetTab({ video: true });
      if (!tab) {
        // No tab to clean up — fall back to the normal (delayed) advance.
        debugLog('Video Cleanup', 'no Vheer tab — skipping cleanup', false);
        scheduleNextShot(m, settings);
        return;
      }
      // Single-shot: retries=1 so the cleanup is sent exactly once. The content
      // script's async cleanup can take up to 30s, and sendToMainFrame would
      // otherwise treat a late/undefined response as a failure and re-send —
      // which produced the duplicate "Delete Clicked" in the logs.
      const cleanup = await sendToMainFrame(tab.id, {
        type: 'POST_DOWNLOAD_CLEANUP',
        shotNumber
      }, 1);
      if (cleanup && cleanup.ok) {
        debugLog('Video Cleanup COMPLETE', 'SHOT ' + shotNumber + ' — upload control usable');
        await advanceQueue(m);
        return;
      }
      var cleanupReason = (cleanup && (cleanup.error || cleanup.stage)) || 'no response';
    } catch (e) {
      cleanupReason = 'exception: ' + e.message;
    }
    // The MP4 downloaded, but Vheer's result state was NOT reset — starting the
    // next shot would fail. Do NOT silently advance: halt with a clear error so
    // the user can reset the page manually and press Start to resume.
    debugLog('Video Cleanup Failed', cleanupReason, false);
    queue.status = 'error';
    queue.error = 'SHOT ' + shotNumber + ' downloaded but cleanup failed: ' + cleanupReason;
    chrome.alarms.clear('next-shot-video');
    chrome.alarms.clear('next-shot');
    await saveQueue(queue);
    broadcastQueue(queue);
    debugLog('BATCH HALTED', queue.error, false);
    return;
  }

  // IMAGE: Vheer shows a result state (Download / Delete controls) after each
  // generation. Click Delete and confirm the page has reset before scheduling
  // the next shot — the same sync pattern used by the video workflow, adapted
  // for the Text→Image page (checks Generate-button readiness instead of
  // upload-input readiness).
  debugLog('Image Cleanup', 'SHOT ' + shotNumber + ' — resetting Vheer result state');
  try {
    const tab = await findTargetTab();
    if (!tab) {
      // No tab visible — fall back to the normal delayed advance.
      debugLog('Image Cleanup', 'no Vheer tab — scheduling next shot without cleanup', false);
      scheduleNextShot(m, settings);
      return;
    }
    // retries=1: the content-script cleanup is async (up to 30 s). Using more
    // retries risks sending a second Delete click while the first is still in
    // flight — the same issue that was fixed for the video workflow.
    const cleanup = await sendToMainFrame(tab.id, {
      type: 'POST_IMAGE_DOWNLOAD_CLEANUP',
      shotNumber
    }, 1);
    if (cleanup && cleanup.ok) {
      debugLog('Image Cleanup COMPLETE', 'SHOT ' + shotNumber + ' — scheduling next shot');
      scheduleNextShot(m, settings);
      return;
    }
    var imageCleanupReason = (cleanup && (cleanup.error || cleanup.stage)) || 'no response';
  } catch (e) {
    imageCleanupReason = 'exception: ' + e.message;
  }
  // PNG downloaded but Vheer result state NOT reset — starting the next shot
  // would fail. Halt with a clear error; press Start to resume from this shot.
  debugLog('Image Cleanup Failed', imageCleanupReason, false);
  queue.status = 'error';
  queue.error = 'SHOT ' + shotNumber + ' downloaded but image cleanup failed: ' + imageCleanupReason;
  chrome.alarms.clear('next-shot');
  chrome.alarms.clear('next-shot-video');
  await saveQueue(queue);
  broadcastQueue(queue);
  debugLog('BATCH HALTED', queue.error, false);
}

/**
 * Immediately start the next pending shot with NO between-shot delay. The
 * Vheer result-state reset (Delete + upload control ready) is the sync point,
 * not a timer.
 */
async function advanceQueue(mode) {
  chrome.alarms.clear('next-shot-video');
  chrome.alarms.clear('next-shot');
  const queue = await loadQueue(mode);
  if (queue.status !== 'running') return;
  const next = nextPending(queue.shots);
  if (next) {
    debugLog('Queue advancing', 'starting SHOT ' + String(next.number).padStart(3, '0'));
    processShot(mode, next.number);
  } else {
    queue.status = 'done';
    await saveQueue(queue);
    broadcastQueue(queue);
  }
}

/** Poll a download until it is complete or interrupted. */
function verifyDownload(downloadId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      chrome.downloads.search({ id: downloadId }, (results) => {
        if (!results || !results.length) {
          if (Date.now() < deadline) { setTimeout(check, 500); return; }
          resolve({ ok: false, error: 'Download not found' });
          return;
        }
        const d = results[0];
        if (d.state === 'complete') {
          resolve({
            ok: true,
            details: (d.filename || '') + ' (' + d.fileSize + ' bytes)',
            filename: d.filename,
            fileSize: d.fileSize
          });
        } else if (d.state === 'interrupted') {
          resolve({ ok: false, error: 'Download interrupted: ' + (d.error || 'unknown') });
        } else {
          if (Date.now() < deadline) { setTimeout(check, 500); }
          else { resolve({ ok: false, error: 'Download timed out' }); }
        }
      });
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Delay scheduling
// ---------------------------------------------------------------------------

function scheduleNextShot(mode, settings) {
  if (isRunStopped()) return; // Stop pressed — don't schedule the next shot
  const sec = delaySec(settings);
  const endsAt = Date.now() + sec * 1000;
  const m = mode === 'video' ? 'video' : 'image';

  loadQueue(m).then((q) => { q.delayEndsAt = endsAt; saveQueue(q); });

  const alarmName = m === 'video' ? 'next-shot-video' : 'next-shot';
  chrome.alarms.create(alarmName, { delayInMinutes: Math.max(0.05, sec / 60) });
  debugLog('Delay Running', sec + 's before next shot (' + m + ')');
  broadcast({ type: 'DELAY_STARTED', seconds: sec, endsAt });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // --- Between-shot delay (mode-aware) ---
  if (alarm.name === 'next-shot' || alarm.name === 'next-shot-video') {
    const mode = alarm.name === 'next-shot-video' ? 'video' : 'image';
    const queue = await loadQueue(mode);
    queue.delayEndsAt = null;
    await saveQueue(queue);

    if (queue.status !== 'running') return;
    const next = nextPending(queue.shots);
    if (next) processShot(mode, next.number);
    else { queue.status = 'done'; await saveQueue(queue); broadcastQueue(queue); }
  }

  // --- Retry timers (retry-<n> = image, retry-video-<n> = video) ---
  if (alarm.name.startsWith('retry-video-')) {
    const num = parseInt(alarm.name.replace('retry-video-', ''), 10);
    const queue = await loadQueue('video');
    if (queue.status !== 'running') {
      debugLog('Stale retry ignored', 'shot ' + num + ' (queue ' + queue.status + ')');
      return;
    }
    const shot = queue.shots.find(s => s.number === num);
    if (shot && shot.status === 'generating') processShot('video', num, shot.retryCount + 1);
  } else if (alarm.name.startsWith('retry-')) {
    const num = parseInt(alarm.name.replace('retry-', ''), 10);
    const queue = await loadQueue('image');
    if (queue.status !== 'running') {
      debugLog('Stale retry ignored', 'shot ' + num + ' (queue ' + queue.status + ')');
      return;
    }
    const shot = queue.shots.find(s => s.number === num);
    if (shot && shot.status === 'generating') processShot('image', num, shot.retryCount + 1);
  }

  // --- Download / generation guards (mode-aware) ---
  if (alarm.name.startsWith('dl-timeout-video-')) {
    const num = parseInt(alarm.name.replace('dl-timeout-video-', ''), 10);
    const q = await loadQueue('video');
    const s = q.shots.find(x => x.number === num);
    if (!s || s.status === 'completed' || s.status === 'failed' || q.status !== 'running') {
      debugLog('Download timeout ignored', 'video shot ' + num + ' is ' + (s && s.status) + ' / queue ' + q.status);
      return;
    }
    debugLog('Download timeout', 'video shot ' + num, false);
    if (expectedDownload && expectedDownload.shotNumber === num) expectedDownload = null;
    failShot('video', num, 'Download timeout');
  } else if (alarm.name.startsWith('dl-timeout-')) {
    const num = parseInt(alarm.name.replace('dl-timeout-', ''), 10);
    const q = await loadQueue('image');
    const s = q.shots.find(x => x.number === num);
    // The download already completed (or the shot is no longer active) — this
    // is a stale alarm, ignore it instead of reprocessing good output.
    if (!s || s.status === 'completed' || s.status === 'failed' || q.status !== 'running') {
      debugLog('Download timeout ignored', 'shot ' + num + ' is ' + (s && s.status) + ' / queue ' + q.status);
      return;
    }
    debugLog('Download timeout', 'shot ' + num, false);
    if (expectedDownload && expectedDownload.shotNumber === num) expectedDownload = null;
    failShot('image', num, 'Download timeout');
  }

  if (alarm.name.startsWith('gen-timeout-video-')) {
    const num = parseInt(alarm.name.replace('gen-timeout-video-', ''), 10);
    const q = await loadQueue('video');
    const s = q.shots.find(x => x.number === num);
    if (!s || s.status === 'completed' || s.status === 'failed' || q.status !== 'running') {
      debugLog('Gen timeout ignored', 'video shot ' + num + ' is ' + (s && s.status) + ' / queue ' + q.status);
      return;
    }
    debugLog('Generation timeout', 'video shot ' + num + ' exceeded hard cap — reloading', false);
    const tab = await findTargetTab({ video: true });
    if (tab) {
      try { await chrome.tabs.reload(tab.id); } catch (e) {}
    }
    if (expectedDownload && expectedDownload.shotNumber === num) expectedDownload = null;
    failShot('video', num, 'Generation watchdog timeout');
  } else if (alarm.name.startsWith('gen-timeout-')) {
    const num = parseInt(alarm.name.replace('gen-timeout-', ''), 10);
    const q = await loadQueue('image');
    const s = q.shots.find(x => x.number === num);
    // Idempotency: if shot already completed/failed or queue not running, ignore.
    if (!s || s.status === 'completed' || s.status === 'failed' || q.status !== 'running') {
      debugLog('Gen timeout ignored', 'shot ' + num + ' is ' + (s && s.status) + ' / queue ' + q.status);
      return;
    }
    debugLog('Generation timeout', 'shot ' + num + ' exceeded hard cap — reloading', false);
    // Reload the tab to clear any stuck generation state.
    const tab = await findTargetTab();
    if (tab) {
      try { await chrome.tabs.reload(tab.id); } catch (e) {}
    }
    if (expectedDownload && expectedDownload.shotNumber === num) expectedDownload = null;
    failShot('image', num, 'Generation watchdog timeout');
  }
});

// ---------------------------------------------------------------------------
// Watchdog config helper
// ---------------------------------------------------------------------------

/** Build the watchdog payload sent to the content script in RUN_SHOT. */
function buildWatchdogConfig(settings) {
  return {
    maxStallSec:      settings.maxStallSec,
    maxGenSec:        settings.maxGenSec,
    pollIntervalMs:   settings.pollIntervalMs,
    recoveryDelaySec: settings.recoveryDelaySec,
    retryDelaySec:    settings.retryDelaySec,
    maxRetries:       settings.retries
  };
}

// ---------------------------------------------------------------------------
// Shot processing
// ---------------------------------------------------------------------------

async function processShot(mode, shotNumber, attempt = 0) {
  if (isRunStopped()) return;

  // Exactly one pipeline per shot. A second processShot() for the same shot is
  // blocked here instead of duplicating upload/prompt/generate/download/delete
  // on the Vheer page. The key is cleared in the finally below.
  const shotKey = mode + ':' + shotNumber;
  if (_activeShots.has(shotKey)) {
    debugLog('Duplicate processShot blocked', shotKey + ' already running', false);
    return;
  }
  _activeShots.add(shotKey);

  const signal = currentSignal;
  const abort = () => signal && signal.aborted;
  const runId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  try {
  const queue = await loadQueue(mode);
  const settings = await loadSettings();
  const shot = queue.shots.find(s => s.number === shotNumber);
  if (!shot) return;

  shot.status = 'generating';
  shot.retryCount = shot.retryCount || 0;
  queue.currentShotNumber = shotNumber;
  await saveQueue(queue);
  broadcastQueue(queue);
  if (abort()) return;

  debugLog('Processing SHOT ' + shotNumber, 'attempt ' + (attempt + 1) + ' [run ' + runId + ']');

  // Find Vheer tab (mode-aware: video targets the Image→Video route).
  const tab = await findTargetTab(mode === 'video' ? { video: true } : undefined);
  if (abort()) return;
  if (!tab) {
    debugLog('No Vheer tab', 'Waiting for user…', false);
    shot.status = 'waiting';
    queue.currentShotNumber = null;
    await saveQueue(queue);
    broadcastQueue(queue);
    broadcast({ type: 'NO_VHEER_TAB', shotNumber, mode });
    return;
  }

  try {
    const ensured = await ensureContentScript(tab.id);
    if (abort()) return;
    if (!ensured.ok) throw new Error(ensured.error);

    // VIDEO MODE: the content script runs the full Image→Video workflow —
    // upload → verify → model/duration/resolution → prompt → generate → wait →
    // download. A shot is only marked COMPLETED in handleDownloadComplete, after
    // the native download is verified. So this branch mirrors the image branch:
    // arm the interceptor + watchdog, run the pipeline, then wait for download.
    if (mode === 'video') {
      shot.startedAt = Date.now();
      await saveQueue(queue);
      const total = queue.shots.length;
      const projectName = queue.projectName || settings.projectName;
      expectedDownload = { shotNumber, projectName, total, mode: 'video' };

      // Generation hard-cap alarm (SW-side backstop, like image mode).
      const genTimeoutMin = Math.max(1, (settings.maxGenSec + 60) / 60);
      chrome.alarms.create('gen-timeout-video-' + shotNumber, { delayInMinutes: genTimeoutMin });

      const result = await runVideoPipeline(tab, shot, settings, runId);
      if (abort()) {
        expectedDownload = null;
        chrome.alarms.clear('gen-timeout-video-' + shotNumber);
        return;
      }
      if (!result) {
        expectedDownload = null;
        chrome.alarms.clear('gen-timeout-video-' + shotNumber);
        throw new Error('Content script rejected RUN_VIDEO_STEP (no response)');
      }
      if (!result.ok) {
        expectedDownload = null;
        chrome.alarms.clear('gen-timeout-video-' + shotNumber);
        if (result.recovery && result.recovery.length) debugLog('Recoveries', result.recovery.join('; '));
        if (result.verdict === 'stalled' || result.verdict === 'slow-over-cap') {
          debugLog('Reloading Vheer', 'verdict: ' + result.verdict + ' — ' + result.error, false);
          try { await chrome.tabs.reload(tab.id); } catch (e) {}
        }
        failShot('video', shotNumber, (result.stage ? result.stage + ': ' : '') + (result.error || result.verdict || 'Video step failed'));
        return;
      }

      // Pipeline succeeded and Download was clicked — generation watchdog is
      // done; the download guard takes over (re-armed to 10 min on rename).
      chrome.alarms.clear('gen-timeout-video-' + shotNumber);
      debugLog('Video pipeline complete', 'verdict: ' + (result.verdict || 'complete') + ' — waiting for download…');
      chrome.alarms.create('dl-timeout-video-' + shotNumber, { delayInMinutes: 5 });
      return;
    }

    // Arm the download interceptor BEFORE sending RUN_SHOT (image mode).
    const total = queue.shots.length;
    const projectName = queue.projectName || settings.projectName;
    expectedDownload = { shotNumber, projectName, total };

    // Record generation start time (persisted so timing survives SW restart).
    shot.startedAt = Date.now();
    await saveQueue(queue);

    // Build watchdog config for the content script.
    const watchdog = buildWatchdogConfig(settings);

    // Arm generation hard-cap alarm (SW-side backstop for MV3 lifetime).
    // Runs slightly after the content script's own cap so it only fires as a safety net.
    const genTimeoutMin = Math.max(1, (settings.maxGenSec + 60) / 60);
    chrome.alarms.create('gen-timeout-' + shotNumber, { delayInMinutes: genTimeoutMin });

    const result = await sendToMainFrame(tab.id, {
      type: 'RUN_SHOT',
      shotNumber,
      masterPrompt: shot.masterPrompt,
      watchdog
    });
    if (abort()) {
      expectedDownload = null;
      chrome.alarms.clear('gen-timeout-' + shotNumber);
      return;
    }

    if (!result) {
      expectedDownload = null;
      chrome.alarms.clear('gen-timeout-' + shotNumber);
      throw new Error('Content script rejected command (no response)');
    }

    // Handle verdict-based non-ok results from the content script.
    if (!result.ok) {
      expectedDownload = null;
      chrome.alarms.clear('gen-timeout-' + shotNumber);
      const verdict = result.verdict || '';

      // Emit content-script recovery events for the debug log.
      if (result.recovery && result.recovery.length) {
        debugLog('Recoveries', result.recovery.join('; '));
      }

      // On stall or hard-cap: the page is likely frozen — reload it so
      // the next retry starts from a clean state (no duplicate clicks).
      if (verdict === 'stalled' || verdict === 'slow-over-cap') {
        debugLog('Reloading Vheer', 'verdict: ' + verdict + ' — ' + result.error, false);
        try { await chrome.tabs.reload(tab.id); } catch (e) {}
      }

      failShot(mode, shotNumber, result.error || verdict || 'Command failed');
      return;
    }

    // Generation complete — clear the generation alarm, keep download alarm active.
    chrome.alarms.clear('gen-timeout-' + shotNumber);
    debugLog('Command accepted', 'verdict: ' + (result.verdict || 'complete') + ' — waiting for download…');

    // "Download never started" guard. Re-armed to 10 min in
    // onDeterminingFilename once the download actually begins, and cleared
    // in handleDownloadComplete on success.
    chrome.alarms.create('dl-timeout-' + shotNumber, { delayInMinutes: 5 });

  } catch (err) {
    debugLog('SHOT ' + shotNumber + ' failed', err.message, false);
    expectedDownload = null;
    chrome.alarms.clear('gen-timeout-' + shotNumber);
    failShot(mode, shotNumber, err.message);
  }
  } finally {
    _activeShots.delete(shotKey);
  }
}

/** Mark a shot failed (or retry it) and advance the queue. */
async function failShot(mode, shotNumber, reason) {
  const queue = await loadQueue(mode);
  const settings = await loadSettings();
  const shot = queue.shots.find(s => s.number === shotNumber);
  if (!shot) return;
  if (isRunStopped()) return; // Stop pressed — don't retry or advance

  // Idempotency guard: never fail/retry a shot that already completed.
  if (shot.status === 'completed') {
    chrome.alarms.clear('dl-timeout-' + shotNumber);
    chrome.alarms.clear('retry-' + shotNumber);
    chrome.alarms.clear('gen-timeout-' + shotNumber);
    debugLog('Stale failure ignored', 'shot ' + shotNumber + ' already completed');
    return;
  }

  const attempt = (shot.retryCount || 0) + 1;
  if (attempt <= settings.retries) {
    shot.status = 'generating';
    shot.retryCount = attempt;
    // Reset startedAt so the next attempt gets a fresh generation timer.
    shot.startedAt = Date.now();
    await saveQueue(queue);
    broadcastQueue(queue);

    // Use faster retryDelaySec for stall/over-cap (page was reloaded, recover quickly);
    // use exponential backoff for generic failures (3s, 6s, 12s … capped at 60s).
    const isStall = /stalled|slow-over-cap|timeout|watchdog/i.test(reason);
    const backoffMin = isStall
      ? Math.max(settings.retryDelaySec || 10, 3) / 60
      : Math.min(0.05 * Math.pow(2, attempt - 1), 1);
    debugLog('Retrying', 'attempt ' + attempt + '/' + settings.retries +
      ' (backoff ' + Math.round(backoffMin * 60) + 's, reason: ' + reason + ')');
    const retryAlarm = mode === 'video' ? 'retry-video-' + shotNumber : 'retry-' + shotNumber;
    chrome.alarms.create(retryAlarm, { delayInMinutes: backoffMin });
  } else {
    // Permanent failure — record timing and emit a structured shot report.
    shot.status = 'failed';
    shot.endedAt = Date.now();
    shot.durationSec = (shot.startedAt && shot.endedAt)
      ? Math.round((shot.endedAt - shot.startedAt) / 1000) : null;
    queue.currentShotNumber = null;
    await saveQueue(queue);
    broadcastQueue(queue);

    // Structured shot report for the sidepanel.
    broadcast({
      type: 'SHOT_REPORT',
      shotNumber,
      startedAt: shot.startedAt,
      generationSec: shot.durationSec,
      retries: attempt - 1,
      downloaded: false,
      status: 'FAILED',
      reason
    });

    // CANARY failed permanently → abort the entire batch (image mode only).
    if (mode !== 'video' && queue.canaryShot === shotNumber && queue.canaryState === 'running' && !queue.canaryDone) {
      queue.status = 'error';
      queue.error = 'Canary shot ' + shotNumber + ' failed after ' + settings.retries + ' attempts: ' + reason;
      queue.canaryShot = null;
      queue.canaryState = 'failed';
      chrome.alarms.clear('next-shot');
      await saveQueue(queue);
      broadcastQueue(queue);
      broadcast({ type: 'CANARY_FAILED', shotNumber, error: reason });
      debugLog('CANARY FAILED', 'aborting batch: ' + reason, false);
      return;
    }

    if (mode === 'video') {
      // VIDEO: a permanently-failed shot must halt the batch — never silently
      // continue. The stage is already embedded in `reason`. Press Start to
      // resume from the next waiting shot.
      queue.status = 'error';
      queue.error = 'SHOT ' + shotNumber + ' failed after ' + attempt + ' attempt(s) at: ' + reason;
      chrome.alarms.clear('next-shot-video');
      chrome.alarms.clear('next-shot');
      await saveQueue(queue);
      broadcastQueue(queue);
      debugLog('BATCH HALTED', queue.error, false);
      return;
    }

    scheduleNextShot(mode, settings);
  }
}

// ---------------------------------------------------------------------------
// Queue control (mode-aware: 'image' or 'video')
// ---------------------------------------------------------------------------

async function handleStartQueue(mode) {
  const queue = await loadQueue(mode);
  if (queue.status === 'running') return { ok: true };

  beginRun(); // new run → fresh AbortController, clear the stopped flag
  // Reset any previous batch-level error.
  queue.error = null;
  queue.canaryState = null;
  queue.status = 'running';
  await saveQueue(queue);
  broadcastQueue(queue);
  debugLog('Queue started', queue.shots.filter(s => s.status === 'waiting').length + ' shots pending (' + mode + ')');

  const shot = nextPending(queue.shots);
  if (!shot) {
    queue.status = 'done';
    await saveQueue(queue);
    broadcastQueue(queue);
    return { ok: true };
  }

  // CANARY: gate the batch on one full end-to-end shot (image mode only).
  // Once the canary succeeds, canaryDone stays true (even across restarts) so
  // it is never re-run; if it fails, failShot() aborts the whole queue.
  if (mode !== 'video' && !queue.canaryDone) {
    queue.canaryShot = shot.number;
    queue.canaryState = 'running';
    await saveQueue(queue);
    broadcastQueue(queue);
    broadcast({ type: 'CANARY_STARTED', shotNumber: shot.number });
    debugLog('Canary run', 'SHOT ' + shot.number + ' — batch gates on this shot');
  }

  processShot(mode, shot.number);
  return { ok: true };
}

async function handlePauseQueue(mode) {
  const queue = await loadQueue(mode);
  queue.status = 'paused';
  queue.delayEndsAt = null;
  await saveQueue(queue);
  broadcastQueue(queue);
  chrome.alarms.clear(mode === 'video' ? 'next-shot-video' : 'next-shot');
  debugLog('Queue paused (' + mode + ')');
  return { ok: true };
}

async function handleResumeQueue(mode) {
  const queue = await loadQueue(mode);
  if (queue.status !== 'paused') return { ok: false, error: 'Not paused' };
  beginRun(); // resumed run → fresh AbortController
  queue.status = 'running';
  await saveQueue(queue);
  broadcastQueue(queue);
  debugLog('Queue resumed (' + mode + ')');

  const shot = nextPending(queue.shots);
  if (!shot) {
    queue.status = 'done';
    await saveQueue(queue);
    broadcastQueue(queue);
    return { ok: true };
  }

  processShot(mode, shot.number);
  return { ok: true };
}

async function handleStopQueue(mode) {
  // HARD STOP: abort every in-flight await in the shot pipeline, so any
  // mid-flight async work exits immediately instead of continuing to run.
  stopRun();

  // Cancel every pending per-shot timer (retry-*, dl-timeout-*) so nothing can
  // fire late and reprocess a shot after Stop.
  clearAllShotAlarms();
  chrome.alarms.clear('next-shot');
  chrome.alarms.clear('next-shot-video');

  const queue = await loadQueue(mode);
  queue.status = 'idle';
  queue.currentShotNumber = null;
  queue.delayEndsAt = null;
  queue.canaryShot = null;
  queue.canaryState = null;
  // Note: canaryDone is intentionally preserved — a finished canary is not re-run.
  for (const s of queue.shots) { if (s.status === 'generating') s.status = 'waiting'; }
  await saveQueue(queue);
  broadcastQueue(queue);

  expectedDownload = null;

  // Tell the content script to halt any in-flight fill/generate/wait loop so
  // the page stops clicking buttons on its own (fire-and-forget).
  const tab = await findTargetTab(mode === 'video' ? { video: true } : undefined);
  if (tab) {
    try {
      chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUTOMATION' }, { frameId: 0 }).catch(() => {});
    } catch (e) {}
  }

  debugLog('Queue stopped', 'all in-flight work halted (' + mode + ')');
  return { ok: true };
}

async function handleSkipDelay(mode) {
  chrome.alarms.clear('next-shot');
  chrome.alarms.clear('next-shot-video');
  const queue = await loadQueue(mode);
  queue.delayEndsAt = null;
  await saveQueue(queue);
  broadcastQueue(queue);
  debugLog('Delay skipped (' + mode + ')');

  if (queue.status === 'running') {
    const shot = nextPending(queue.shots);
    if (shot) processShot(mode, shot.number);
  }
  return { ok: true };
}

async function handleGetState() {
  const q  = await loadQueue('image');
  const vq = await loadQueue('video');
  const s  = await loadSettings();
  // Stamp an ephemeral flag so the side panel can label a restored queue
  // differently from a freshly-imported one.  This flag is NOT written to
  // Chrome storage (loadQueue / saveQueue never touch it) and is NOT present
  // in broadcastQueue() broadcasts, so it disappears the moment a new import
  // or any queue-update replaces the in-memory object.
  if (q.shots  && q.shots.length)  q.restoredFromStorage  = true;
  if (vq.shots && vq.shots.length) vq.restoredFromStorage = true;
  return { ok: true, queue: q, videoQueue: vq, settings: s };
}

async function handleRegenerateShot(mode, shotNumber) {
  const queue = await loadQueue(mode);
  const shot = queue.shots.find(s => s.number === shotNumber);
  if (!shot) return { ok: false, error: 'Shot not found' };
  shot.status = 'waiting';
  shot.retryCount = 0;
  await saveQueue(queue);
  broadcastQueue(queue);
  if (queue.status === 'idle') handleStartQueue(mode);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function handleImportFile(content, projectName) {
  if (!content || !projectName) return { ok: false, error: 'Missing content or project name' };
  const parsed = parsePromptFile(content);
  const { shots, warnings, errors = [] } = parsed;
  if (errors.length) {
    return { ok: false, error: 'Invalid numbered prompt session: ' + errors.join(' | '), warnings, errors };
  }
  if (!shots.length) return { ok: false, error: 'No shots found', warnings };

  // Full shared queue shape (mode:'image'). Fresh import → new batch → the
  // canary runs again.
  const queue = emptyQueue('image');
  queue.projectName = projectName;
  queue.shots = shots;
  await saveQueue(queue);
  broadcastQueue(queue);
  debugLog('Imported', shots.length + ' shots from ' + projectName);
  return { ok: true, count: shots.length, warnings };
}

// ===========================================================================
// VIDEO MODE — runs on the SAME shared queue engine as Image mode (mode:'video'
// stored under 'videoQueue'). Only the per-shot provider step differs: upload
// the source image + paste the prompt instead of RUN_SHOT. No generation, no
// download in this milestone.
// ===========================================================================

async function handleImportVideoFile(content, projectName) {
  if (!content || !projectName) return { ok: false, error: 'Missing content or project name' };
  const parsed = parseVideoPromptFile(content);
  const { shots, warnings, errors = [] } = parsed;
  if (errors.length) {
    return { ok: false, error: 'Invalid numbered prompt session: ' + errors.join(' | '), warnings, errors };
  }
  if (!shots.length) {
    debugLog('Video import', '0 shots — ' + String(content).length + ' chars, preview: ' + JSON.stringify(String(content).slice(0, 120)), false);
    return { ok: false, error: 'No SHOT blocks parsed — expected SHOT001 + IMAGE / VIDEO PROMPT / NEGATIVE PROMPT sections. Received ' + String(content).length + ' chars.', warnings };
  }

  // Full shared queue shape (mode:'video'), replacing any previous video import.
  const vq = emptyQueue('video');
  vq.projectName = projectName;
  vq.shots = shots;
  await saveQueue(vq);
  broadcastQueue(vq);
  debugLog('Video import', shots.length + ' shots from ' + projectName);
  return { ok: true, count: shots.length, warnings };
}

/**
 * The video provider step, called by the shared processShot():
 *   side panel → SHOT###.png bytes → content script uploads → waits for the
 *   preview → pastes VIDEO PROMPT (+ NEGATIVE PROMPT) → verifies → STOP.
 * Throws on failure; processShot handles retry/fail via the shared budget.
 */
async function runVideoPipeline(tab, shot, settings, runId) {
  // Ask the side panel for this shot's source image bytes.
  const image = await requestImageBytes(shot.number);
  if (!image || !image.base64) {
    throw new Error((image && image.error) || 'No image file for SHOT ' + shot.number);
  }

  // Per-shot data is IMAGE + PROMPT only. Model / duration / resolution /
  // aspect ratio are fixed session settings the user configures manually on the
  // Vheer page before pressing Start — the automation never touches them.
  // retries=1: the pipeline runs the whole Image→Video workflow and can take
  // minutes; a re-send would re-run it and duplicate every DOM action.
  const result = await sendToMainFrame(tab.id, {
    type: 'RUN_VIDEO_STEP',
    shotNumber: shot.number,
    prompt: shot.prompt,
    watchdog: buildWatchdogConfig(settings),
    filename: image.filename,
    imageBase64: image.base64,
    runId
  }, 1);
  if (!result) throw new Error('Content script rejected RUN_VIDEO_STEP (no response)');
  // Return both outcomes — processShot decides (it reloads on stalled/over-cap
  // and reports the exact stage on failure).
  return result;
}

// --- Side panel image transfer (port) ---------------------------------------
// The side panel holds the chosen Images folder in memory. When a video shot
// needs its source image, the SW asks over this port and gets base64 back.

let panelPort = null;
let uploadRequestResolve = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'aistudio-panel') return;
  panelPort = port;
  port.onMessage.addListener((msg) => {
    if (msg.type === 'UPLOAD_IMAGE' && uploadRequestResolve) {
      const done = uploadRequestResolve;
      uploadRequestResolve = null;
      done(msg);
    }
  });
  port.onDisconnect.addListener(() => { if (panelPort === port) panelPort = null; });
});

/** Ask the side panel for the source-image bytes for a shot. */
function requestImageBytes(shotNumber) {
  return new Promise((resolve) => {
    if (!panelPort) { resolve({ error: 'Side panel not connected — reopen it and pick the Images folder' }); return; }
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; uploadRequestResolve = null; resolve({ error: 'Timed out waiting for SHOT ' + shotNumber }); } }, 20000);
    const done = (msg) => { if (!settled) { settled = true; clearTimeout(timer); resolve(msg); } };
    uploadRequestResolve = done;
    panelPort.postMessage({ type: 'REQUEST_UPLOAD', shotNumber });
  });
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

/** Resolve a handler promise into a sendResponse, always answering. */
function respond(promise, sendResponse) {
  Promise.resolve(promise)
    .then(r => sendResponse(r || { ok: false, error: 'No response' }))
    .catch(err => sendResponse({ ok: false, error: err.message }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // --- Queue control (mode-aware: 'image' | 'video') ---
    case 'START_QUEUE':    respond(handleStartQueue(msg.mode), sendResponse); return true;
    case 'PAUSE_QUEUE':    respond(handlePauseQueue(msg.mode), sendResponse); return true;
    case 'RESUME_QUEUE':   respond(handleResumeQueue(msg.mode), sendResponse); return true;
    case 'STOP_QUEUE':     respond(handleStopQueue(msg.mode), sendResponse); return true;
    case 'GET_STATE':      respond(handleGetState(), sendResponse); return true;
    case 'REGENERATE_SHOT': respond(handleRegenerateShot(msg.mode, msg.shotNumber), sendResponse); return true;
    case 'SKIP_DELAY':     respond(handleSkipDelay(msg.mode), sendResponse); return true;

    // --- Video mode (import only; run control uses START_QUEUE/STOP_QUEUE + mode) ---
    case 'IMPORT_VIDEO_FILE': respond(handleImportVideoFile(msg.content, msg.projectName), sendResponse); return true;

    // --- File import ---
    case 'IMPORT_FILE':    respond(handleImportFile(msg.content, msg.projectName), sendResponse); return true;

    // --- Settings ---
    case 'SAVE_SETTINGS':  respond(handleSaveSettings(msg.settings), sendResponse); return true;

    // --- Test / inspect ---
    case 'TEST_CONNECTION': respond(handleTestConnection(msg), sendResponse); return true;
    case 'TEST_FILL':      respond(routeToContentScript(msg), sendResponse); return true;
    case 'TEST_GENERATE':  respond(routeToContentScript(msg), sendResponse); return true;
    case 'INSPECT_PAGE':   respond(routeToContentScript(msg), sendResponse); return true;

    // --- From content scripts ---
    case 'CONTENT_READY':
      debugLog('Content script connected', sender.tab?.url || 'unknown');
      if (sender.tab) readyTabs.add(sender.tab.id);
      break;
    case 'CS_CRASH':
      console.error('[SW] Content script CRASHED:', msg.error, '\n', msg.stack || '');
      debugLog('Content script CRASHED', msg.error || 'unknown error', false);
      break;
    case 'DEBUG_LOG':
      broadcast({ type: 'DEBUG_LOG', entry: msg.entry });
      break;
    case 'URL_DIAG':
      console.log('[URL-DIAG] from content-script:', JSON.stringify(msg.diag));
      break;
  }
});

// ---------------------------------------------------------------------------
// Extension icon → open side panel
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ---------------------------------------------------------------------------
// Resume on browser restart
// ---------------------------------------------------------------------------

chrome.runtime.onStartup.addListener(async () => {
  // Resume whichever queue was left running (image and/or video; each persists
  // independently, though only one runs at a time).
  for (const mode of ['image', 'video']) {
    const queue = await loadQueue(mode);
    if (queue.status !== 'running') continue;
    beginRun(); // resumed after restart → fresh AbortController
    debugLog('Resuming after restart (' + mode + ')');
    const settings = await loadSettings();
    if (queue.delayEndsAt && queue.delayEndsAt > Date.now()) {
      const remaining = Math.ceil((queue.delayEndsAt - Date.now()) / 1000);
      chrome.alarms.create(mode === 'video' ? 'next-shot-video' : 'next-shot', { delayInMinutes: Math.max(0.05, remaining / 60) });
      debugLog('Resuming delay', remaining + 's remaining (' + mode + ')');
      broadcast({ type: 'DELAY_STARTED', seconds: remaining, endsAt: queue.delayEndsAt });
    } else {
      const next = nextPending(queue.shots);
      if (next) processShot(mode, next.number);
      else { queue.status = 'done'; await saveQueue(queue); broadcastQueue(queue); }
    }
  }
});

console.log('[SW] Vheer Story Studio service worker loaded.');
