/**
 * Vheer Story Studio — Side Panel Logic
 *
 * Handles: import, page tools (connection / inspect / fill / generate),
 * queue display, controls, settings, and a live debug console.
 */

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  btnDiagnostics: $('#btn-diagnostics'),
  btnImport: $('#btn-import'), fileInput: $('#file-input'), importStatus: $('#import-status'),
  secProject: $('#sec-project'), projectName: $('#project-name'), shotCount: $('#shot-count'),
  secVheer: $('#sec-vheer'), vheerStatus: $('#vheer-status'), testResult: $('#test-result'),
  testDumpWrap: $('#test-dump-wrap'), testDump: $('#test-dump'),
  btnTestConn: $('#btn-test-conn'), btnInspect: $('#btn-inspect'),
  btnTestFill: $('#btn-test-fill'), btnTestGen: $('#btn-test-gen'),
  secControls: $('#sec-controls'),
  btnStart: $('#btn-start'), btnPause: $('#btn-pause'), btnResume: $('#btn-resume'), btnStop: $('#btn-stop'),
  progressFill: $('#progress-fill'),
  statCompleted: $('#stat-completed'), statFailed: $('#stat-failed'), statWaiting: $('#stat-waiting'),
  secDelay: $('#sec-delay'), delayCountdown: $('#delay-countdown'),
  btnSkipDelay: $('#btn-skip-delay'), btnDelayPause: $('#btn-delay-pause'), btnDelayStop: $('#btn-delay-stop'),
  secCanary: $('#sec-canary'), canaryBanner: $('#canary-banner'),
  secQueue: $('#sec-queue'), shotList: $('#shot-list'),
  viewMain: $('#view-main'), viewInspect: $('#view-inspect'), viewDebug: $('#view-debug'), viewSettings: $('#view-settings'),
  inspectContent: $('#inspect-content'), btnInspectBack: $('#btn-inspect-back'),
  debugLog: $('#debug-log'),
  btnDebugToggle: $('#btn-debug-toggle'),
  btnDebugBack: $('#btn-debug-back'), btnDebugClear: $('#btn-debug-clear'),
  btnSettings: $('#btn-settings'), btnSettingsBack: $('#btn-settings-back'),
  setDelayMode: $('#set-delay-mode'), setDelayModeRandom: $('#set-delay-mode-random'),
  setDelay: $('#set-delay'), setDelayMin: $('#set-delay-min'), setDelayMax: $('#set-delay-max'),
  fixedDelayFields: $('#fixed-delay-fields'), randomDelayFields: $('#random-delay-fields'),
  setRetries: $('#set-retries'), setFilename: $('#set-filename'), setProject: $('#set-project'),
  // Watchdog settings
  setMaxStall: $('#set-max-stall'), setMaxGen: $('#set-max-gen'),
  setPollInterval: $('#set-poll-interval'), setRecoveryDelay: $('#set-recovery-delay'),
  setRetryDelay: $('#set-retry-delay'),
  // Live stats
  secStats: $('#sec-stats'),
  statGenCompleted: $('#stat-gen-completed'), statGenRemaining: $('#stat-gen-remaining'),
  statGenRetries: $('#stat-gen-retries'), statGenFailures: $('#stat-gen-failures'),
  statGenAvg: $('#stat-gen-avg'), statGenLongest: $('#stat-gen-longest'),
  statGenEta: $('#stat-gen-eta'),
  // Mode switcher
  btnModeImage: $('#btn-mode-image'), btnModeVideo: $('#btn-mode-video'),
  // Video mode
  btnVideoImport: $('#btn-video-import'), videoFileInput: $('#video-file-input'), videoImportStatus: $('#video-import-status'),
  btnPickFolder: $('#btn-pick-folder'), folderInput: $('#folder-input'), folderStatus: $('#folder-status'),
  secVideoFolder: $('#sec-video-folder'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let queue = null;
let settings = null;
let delayEndTime = null;
let countdownInterval = null;
let mode = 'image';          // 'image' | 'video'
let videoQueue = null;       // separate video project/queue
let folderFiles = {};        // filename → File (chosen Images folder)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format seconds into a human-readable string. */
function formatSec(s) {
  if (s == null || s === 0) return '—';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m + 'm ' + sec + 's';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function send(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, r => resolve(r || { ok: false, error: 'No response' }));
  });
}

// Listen for messages from the service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'QUEUE_UPDATE') { queue = msg.queue; renderQueue(); }
  if (msg.type === 'VIDEO_QUEUE_UPDATE') { videoQueue = msg.queue; renderQueue(); }
  if (msg.type === 'DEBUG_LOG') appendDebug(msg.entry);
  if (msg.type === 'SHOT_REPORT') appendShotReport(msg);
  if (msg.type === 'DELAY_STARTED') startCountdown(msg.endsAt, msg.seconds);
  if (msg.type === 'CANARY_STARTED') {
    showCanaryBanner('🛡 Canary run: SHOT ' + String(msg.shotNumber).padStart(3, '0') + ' — verifying end-to-end before batch', 'status-banner');
  }
  if (msg.type === 'CANARY_SUCCEEDED') {
    showCanaryBanner('🛡 Canary passed — running batch', 'status-banner status-banner--ok');
  }
  if (msg.type === 'CANARY_FAILED') {
    showCanaryBanner('🛑 Canary failed: SHOT ' + String(msg.shotNumber).padStart(3, '0') + ' — ' + (msg.error || 'unknown') + '. Batch aborted. Fix and press Start.', 'status-banner status-banner--err');
  }
  if (msg.type === 'NO_VHEER_TAB') {
    const url = (msg.mode === 'video') ? 'https://vheer.com/app/image-to-video' : 'https://vheer.com/app/text-to-image';
    els.vheerStatus.textContent = '⚠ Open ' + url + ' to continue';
    els.vheerStatus.className = 'status-banner';
  }
});

/** Show/hide the canary / batch-error banner. */
function showCanaryBanner(text, cls) {
  els.canaryBanner.textContent = text || '';
  els.canaryBanner.className = cls || 'status-banner';
  els.secCanary.classList.toggle('hidden', !text);
}

// ---------------------------------------------------------------------------
// Diagnostics page
// ---------------------------------------------------------------------------

els.btnDiagnostics.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics/index.html') + '?mode=' + mode });
});

// ---------------------------------------------------------------------------
// File import
// ---------------------------------------------------------------------------

els.btnImport.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const content = await file.text();
  let name = file.name.replace(/\.[^.]+$/, '').trim();
  if (!name || /^all.master/i.test(name)) name = 'Imported Project';

  els.importStatus.textContent = 'Importing…';
  els.importStatus.className = 'status-text';
  const r = await send({ type: 'IMPORT_FILE', content, projectName: name });
  if (r.ok) {
    els.importStatus.textContent = (r.count || 0) + ' prompt jobs loaded';
    els.importStatus.className = 'status-text status-text--ok';
    refresh();
  } else {
    els.importStatus.textContent = r.error || 'Failed';
    els.importStatus.className = 'status-text status-text--err';
  }
});

// ---------------------------------------------------------------------------
// Page tools
// ---------------------------------------------------------------------------

function setTestResult(text, cls) {
  els.testResult.textContent = text;
  els.testResult.className = 'status-text ' + (cls || '');
}

/** Render the element dump (candidates) into the collapsible area. */
function showElementDump(elements) {
  if (!elements) {
    els.testDumpWrap.classList.add('hidden');
    return;
  }
  els.testDump.innerHTML = '';
  renderDocSection(els.testDump, elements);
  els.testDumpWrap.classList.remove('hidden');
}

// --- Test Connection -------------------------------------------------------

els.btnTestConn.addEventListener('click', async () => {
  setTestResult('Testing…');
  const r = await send({ type: 'TEST_CONNECTION', mode });
  if (r.ok) {
    const isVideo = mode === 'video';
    let detail;
    if (isVideo) {
      detail = r.uploadFound
        ? '✓ Upload input found' + (r.generatorDetected ? '' : ' (no Generate button)')
        : '⚠ Connected, but upload input NOT found — element dump below';
      showElementDump(r.uploadFound ? null : (r.info && r.info.elements));
    } else {
      detail = r.promptFound
        ? '✓ Prompt textarea found' + (r.generatorDetected ? '' : ' (no Generate button)')
        : '⚠ Connected, but prompt textarea NOT found — element dump below';
      showElementDump(r.promptFound ? null : (r.info && r.info.elements));
    }
    setTestResult('✓ CONNECTED to Vheer — ' + detail, 'status-text--ok');
    els.vheerStatus.textContent = isVideo ? '✓ Connected to Vheer Video' : '✓ Connected to Vheer';
    els.vheerStatus.className = 'status-banner status-banner--ok';
  } else {
    const stepLabel = ({
      tab: 'no-tab', script: 'injection-failed', messaging: 'messaging-error',
      'no-response': 'no-response', 'content-script-not-ready': 'cs-not-ready', url: 'url'
    })[r.step] || 'failed';
    setTestResult('✗ [' + stepLabel + '] ' + (r.error || 'FAILED'), 'status-text--err');
    // Show which URL comparison failed, if the CS provided a diagnostic.
    if (r.urlDiag && (r.urlDiag.cs || r.urlDiag.sw)) {
      const d = r.urlDiag.cs || r.urlDiag.sw;
      console.log('[URL-DIAG]', JSON.stringify(r.urlDiag));
    }
    els.vheerStatus.textContent = '⚠ ' + (r.error || 'Not connected');
    els.vheerStatus.className = 'status-banner';
    showElementDump(null);
  }
});

// --- Inspect Page ----------------------------------------------------------

els.btnInspect.addEventListener('click', async () => {
  setTestResult('Inspecting page…');
  const r = await send({ type: 'INSPECT_PAGE', mode });
  if (r.ok) {
    renderInspect(r.info);
    showView('inspect');
  } else {
    setTestResult('✗ ' + (r.error || 'Inspect failed'), 'status-text--err');
  }
});

function renderElementCard(el) {
  const row = document.createElement('div');
  row.className = 'inspect-card ' + (el.visible === 'visible' ? '' : 'inspect-hidden');
  let html = `<div class="inspect-row"><span class="inspect-key">${esc(el.tag)}${el.index != null ? '[' + el.index + ']' : ''}</span>` +
    `<span class="inspect-val inspect-vis ${el.visible === 'visible' ? 'ok' : 'err'}">${esc(el.visible)}${el.disabled ? ' · disabled' : ''}</span></div>`;
  if (el.id) html += `<div class="inspect-attr"><span>id</span>${esc(el.id)}</div>`;
  if (el.className) html += `<div class="inspect-attr"><span>class</span>${esc(el.className)}</div>`;
  if (el.name) html += `<div class="inspect-attr"><span>name</span>${esc(el.name)}</div>`;
  if (el.placeholder) html += `<div class="inspect-attr"><span>placeholder</span>${esc(el.placeholder)}</div>`;
  if (el.ariaLabel) html += `<div class="inspect-attr"><span>aria-label</span>${esc(el.ariaLabel)}</div>`;
  if (el.innerText) html += `<div class="inspect-attr"><span>innerText</span>${esc(el.innerText)}</div>`;
  row.innerHTML = html;
  return row;
}

function renderDocSection(container, doc) {
  const title = document.createElement('h3');
  title.textContent = doc.label ? doc.label + ' — ' : '';
  const counts = doc.counts || {};
  title.textContent += `Elements (textarea=${counts.textareas} input=${counts.inputs} button=${counts.buttons} select=${counts.selects} editable=${counts.contenteditable})`;
  container.appendChild(title);

  const sections = [
    { title: 'Textareas', items: doc.textareas },
    { title: 'Inputs', items: doc.inputs },
    { title: 'Selects', items: doc.selects },
    { title: 'Contenteditable', items: doc.editables },
    { title: 'Buttons', items: doc.buttons }
  ];

  for (const sec of sections) {
    const h = document.createElement('div');
    h.className = 'inspect-subhead';
    h.textContent = sec.title + ' (' + sec.items.length + ')';
    container.appendChild(h);
    if (!sec.items.length) {
      const none = document.createElement('div');
      none.className = 'inspect-row inspect-none';
      none.textContent = '— none —';
      container.appendChild(none);
      continue;
    }
    for (const el of sec.items) container.appendChild(renderElementCard(el));
  }
}

function renderInspect(info) {
  const c = els.inspectContent;
  c.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'inspect-header';
  const counts = info.counts || {};
  header.innerHTML = `
    <div class="inspect-row"><span class="inspect-key">URL</span><span class="inspect-val">${esc(info.url)}</span></div>
    <div class="inspect-row"><span class="inspect-key">Title</span><span class="inspect-val">${esc(info.title)}</span></div>
    <div class="inspect-row"><span class="inspect-key">Framework</span><span class="inspect-val">${esc(info.framework)}</span></div>
    <div class="inspect-row"><span class="inspect-key">Ready state</span><span class="inspect-val">${esc(info.readyState)}</span></div>
    <div class="inspect-row"><span class="inspect-key">window.top===window</span><span class="inspect-val">${info.isTop ? 'true' : 'false'}</span></div>
    <div class="inspect-row"><span class="inspect-key">Iframes</span><span class="inspect-val">${(info.frames || []).length}</span></div>
    <div class="inspect-row"><span class="inspect-key">Counts</span><span class="inspect-val">textarea=${counts.textareas} input=${counts.inputs} button=${counts.buttons} select=${counts.selects} contenteditable=${counts.contenteditable}</span></div>
    <div class="inspect-row"><span class="inspect-key">Prompt found</span><span class="inspect-val">${info.promptFound ? '✓ yes' : '✗ no'}</span></div>
    <div class="inspect-row"><span class="inspect-key">Generate btn</span><span class="inspect-val">${info.generateFound ? '✓ yes' : '✗ no'}</span></div>
  `;
  c.appendChild(header);

  // Iframes
  if ((info.frames || []).length) {
    const h = document.createElement('h3');
    h.textContent = 'Iframes (' + info.frames.length + ')';
    c.appendChild(h);
    for (const f of info.frames) {
      const row = document.createElement('div');
      row.className = 'inspect-card';
      row.innerHTML = `
        <div class="inspect-row"><span class="inspect-key">src</span><span class="inspect-val">${esc(f.src || '(empty)')}</span></div>
        ${f.title ? `<div class="inspect-attr"><span>title</span>${esc(f.title)}</div>` : ''}
        ${f.id ? `<div class="inspect-attr"><span>id</span>${esc(f.id)}</div>` : ''}
        <div class="inspect-attr"><span>same-origin</span>${f.sameOrigin ? 'yes' : 'no'}</div>
        <div class="inspect-attr"><span>accessible</span>${f.accessible ? 'yes' : 'no'}</div>
      `;
      c.appendChild(row);
    }
  }

  // Main document + any accessible frame documents.
  if (info.main) renderDocSection(c, info.main);
  for (const fd of info.frameDocs || []) renderDocSection(c, fd);
}

// --- Test Fill -------------------------------------------------------------

els.btnTestFill.addEventListener('click', async () => {
  setTestResult('Filling prompt…');
  const r = await send({ type: 'TEST_FILL', text: 'TEST FROM AI STORY STUDIO', mode });
  if (r.ok) {
    setTestResult('✓ Prompt filled (' + (r.chars || '?') + ' chars, ' + (r.method || '?') + ')', 'status-text--ok');
  } else {
    setTestResult('✗ ' + (r.error || 'Fill failed'), 'status-text--err');
  }
});

// --- Test Generate ---------------------------------------------------------

els.btnTestGen.addEventListener('click', async () => {
  setTestResult('Clicking Generate…');
  const r = await send({ type: 'TEST_GENERATE', mode });
  if (r.ok) {
    setTestResult('✓ Generate clicked', 'status-text--ok');
  } else {
    setTestResult('✗ ' + (r.error || 'Generate failed'), 'status-text--err');
  }
});

// ---------------------------------------------------------------------------
// Queue controls
// ---------------------------------------------------------------------------

/** The import-status element for the active mode (image or video). */
function importStatusEl() {
  return mode === 'video' ? els.videoImportStatus : els.importStatus;
}

els.btnStart.addEventListener('click', async () => {
  const r = await send({ type: 'START_QUEUE', mode });
  if (!r.ok && r.error) {
    const el = importStatusEl();
    el.textContent = r.error;
    el.className = 'status-text status-text--err';
  }
});

els.btnPause.addEventListener('click', () => send({ type: 'PAUSE_QUEUE', mode }));
els.btnResume.addEventListener('click', () => send({ type: 'RESUME_QUEUE', mode }));
els.btnStop.addEventListener('click', () => send({ type: 'STOP_QUEUE', mode }));
els.btnSkipDelay.addEventListener('click', () => send({ type: 'SKIP_DELAY', mode }));
els.btnDelayPause.addEventListener('click', () => send({ type: 'PAUSE_QUEUE', mode }));
els.btnDelayStop.addEventListener('click', () => send({ type: 'STOP_QUEUE', mode }));

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

function showView(viewName) {
  els.viewMain.classList.toggle('hidden', viewName !== 'main');
  els.viewInspect.classList.toggle('hidden', viewName !== 'inspect');
  els.viewDebug.classList.toggle('hidden', viewName !== 'debug');
  els.viewSettings.classList.toggle('hidden', viewName !== 'settings');
}

els.btnInspectBack.addEventListener('click', () => showView('main'));
els.btnSettings.addEventListener('click', () => { showView('settings'); loadSettingsForm(); });
els.btnSettingsBack.addEventListener('click', () => { saveSettingsForm(); showView('main'); });

// Debug console is opened via the header debug button.
els.btnDebugToggle.addEventListener('click', () => showView('debug'));
els.btnDebugBack.addEventListener('click', () => showView('main'));

// ---------------------------------------------------------------------------
// Queue rendering
// ---------------------------------------------------------------------------

/** The queue the user is currently looking at (image or video). */
function activeQueue() {
  return mode === 'video' ? videoQueue : queue;
}

function renderQueue() {
  const q = activeQueue();
  if (!q || !q.shots.length) {
    els.secProject.classList.add('hidden');
    els.secControls.classList.add('hidden');
    els.secDelay.classList.add('hidden');
    els.secQueue.classList.add('hidden');
    els.secStats.classList.add('hidden');
    return;
  }

  els.secProject.classList.remove('hidden');
  // Restored queues get a neutral label so the user is not misled into
  // thinking a file was just imported.  Once a fresh import fires (via
  // QUEUE_UPDATE from handleImportFile) the new queue has no
  // restoredFromStorage flag and the real project name appears.
  els.projectName.textContent = q.restoredFromStorage
    ? 'Restored Queue'
    : (q.projectName || settings?.projectName || '');
  const currentLabel = q.currentShotNumber != null
    ? ' · Prompt ' + q.currentShotNumber + ' / ' + q.shots.length
    : '';
  els.shotCount.textContent = q.shots.length + (mode === 'video' ? ' video prompts' : ' image prompts') + currentLabel;

  const completed = q.shots.filter(s => s.status === 'completed').length;
  const pct = Math.round((completed / q.shots.length) * 100);
  els.progressFill.style.width = pct + '%';

  const st = q.stats || {};
  els.statCompleted.textContent = st.completed || 0;
  els.statFailed.textContent = st.failed || 0;
  els.statWaiting.textContent = (st.waiting || 0) + (st.generating || 0);

  els.secControls.classList.remove('hidden');
  const running = q.status === 'running';
  const paused = q.status === 'paused';
  const generating = !!q.currentShotNumber;
  els.btnStart.classList.toggle('hidden', running || paused);
  els.btnPause.classList.toggle('hidden', !running || generating);
  els.btnResume.classList.toggle('hidden', !paused);
  els.btnStop.classList.toggle('hidden', !running && !paused);

  // Live statistics (always shown when queue has shots).
  els.secStats.classList.remove('hidden');
  renderStats();

  els.secDelay.classList.toggle('hidden', !q.delayEndsAt);

  // Canary / batch-error banner (rendered from persisted state, not just events).
  if (q.status === 'error' || q.canaryState === 'failed') {
    showCanaryBanner('🛑 ' + (q.error || 'Batch aborted') + ' — fix the issue and press Start.', 'status-banner status-banner--err');
  } else if (q.canaryState === 'running') {
    showCanaryBanner('🛡 Canary run: SHOT ' + String(q.canaryShot).padStart(3, '0') + ' — verifying end-to-end before batch', 'status-banner');
  } else {
    showCanaryBanner(null);
  }

  els.secQueue.classList.remove('hidden');
  els.shotList.innerHTML = '';
  const shots = [...q.shots].sort((a, b) => a.number - b.number).slice(0, 200);
  for (const s of shots) {
    const row = document.createElement('div');
    row.className = 'shot-row shot-' + s.status;
    const glyph = { completed: '✅', failed: '❌', generating: '⏳', waiting: '…', approved: '✅' }[s.status] || '…';
    const retry = s.retryCount ? ` <span class="text-dim">(retry ${s.retryCount})</span>` : '';
    row.innerHTML = `<span class="shot-glyph">${glyph}</span>` +
      `<span class="shot-num">Prompt ${String(s.number).padStart(3, '0')}</span>` +
      `<span class="shot-status">${s.status}</span>${retry}`;
    els.shotList.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Live statistics
// ---------------------------------------------------------------------------

function renderStats() {
  const q = activeQueue();
  if (!q || !q.shots.length) return;
  const st = q.stats || {};
  const total = q.shots.length;
  const remaining = (st.waiting || 0) + (st.generating || 0);

  els.statGenCompleted.textContent = st.completed || 0;
  els.statGenRemaining.textContent = remaining;
  els.statGenRetries.textContent = st.retries || 0;
  els.statGenFailures.textContent = st.failed || 0;
  els.statGenAvg.textContent = st.avgGenSec ? formatSec(st.avgGenSec) : '—';
  els.statGenLongest.textContent = st.longestSec ? formatSec(st.longestSec) : '—';

  // ETA: remaining shots × (avg gen time + avg delay between shots).
  if (remaining > 0 && st.avgGenSec) {
    const avgDelay = settings ? (settings.delayBetweenShotsSec || 6) : 6;
    const etaSec = Math.round(remaining * (st.avgGenSec + avgDelay));
    els.statGenEta.textContent = formatSec(etaSec);
  } else {
    els.statGenEta.textContent = '—';
  }
}

/** Render a structured SHOT_REPORT block in the debug console. */
function appendShotReport(report) {
  const div = document.createElement('div');
  div.className = 'shot-report shot-report--' + (report.status === 'SUCCESS' ? 'ok' : 'err');
  const shot = String(report.shotNumber).padStart(3, '0');
  const lines = [
    'SHOT' + shot + ' · ' + report.status,
    'Started: ' + (report.startedAt ? new Date(report.startedAt).toLocaleTimeString() : '—'),
    'Generation: ' + formatSec(report.generationSec),
    'Retries: ' + (report.retries || 0),
    'Downloaded: ' + (report.downloaded ? 'YES' : 'NO')
  ];
  if (report.reason) lines.push('Reason: ' + report.reason);
  div.textContent = lines.join('  ·  ');
  els.debugLog.appendChild(div);
  els.debugLog.scrollTop = els.debugLog.scrollHeight;
}

// ---------------------------------------------------------------------------
// Delay countdown
// ---------------------------------------------------------------------------

function startCountdown(endsAt, seconds) {
  delayEndTime = endsAt;
  els.secDelay.classList.remove('hidden');
  els.delayCountdown.textContent = '⏱ Next shot in ' + seconds + 's';
  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((delayEndTime - Date.now()) / 1000));
    els.delayCountdown.textContent = '⏱ Next shot in ' + remaining + 's';
    if (remaining <= 0) clearInterval(countdownInterval);
  }, 1000);
}

// ---------------------------------------------------------------------------
// Debug console
// ---------------------------------------------------------------------------

function appendDebug(entry) {
  const div = document.createElement('div');
  div.className = 'debug-line ' + (entry.ok ? 'ok' : 'err');
  const time = new Date(entry.ts || Date.now()).toLocaleTimeString();
  div.textContent = `${time} ${entry.ok ? '✓' : '✗'} ${entry.step}${entry.detail ? ' — ' + entry.detail : ''}`;
  els.debugLog.appendChild(div);
  els.debugLog.scrollTop = els.debugLog.scrollHeight;
  while (els.debugLog.children.length > 300) els.debugLog.removeChild(els.debugLog.firstChild);
}

els.btnDebugClear.addEventListener('click', () => { els.debugLog.innerHTML = ''; });

// Open debug console from the header via a hidden keyboard shortcut OR the
// diagnostics page. Also allow opening via the status banner double-click.
els.vheerStatus.addEventListener('dblclick', () => showView('debug'));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadSettingsForm() {
  if (!settings) return;
  els.setDelayMode.checked = settings.delayMode !== 'random';
  els.setDelayModeRandom.checked = settings.delayMode === 'random';
  els.setDelay.value = settings.delayBetweenShotsSec;
  els.setDelayMin.value = settings.delayMinSec;
  els.setDelayMax.value = settings.delayMaxSec;
  els.setRetries.value = settings.retries;
  els.setFilename.value = settings.filenameFormat;
  els.setProject.value = settings.projectName || '';
  // Watchdog settings
  els.setMaxStall.value = settings.maxStallSec;
  els.setMaxGen.value = settings.maxGenSec;
  els.setPollInterval.value = settings.pollIntervalMs;
  els.setRecoveryDelay.value = settings.recoveryDelaySec;
  els.setRetryDelay.value = settings.retryDelaySec;
  toggleDelayFields();
}

function toggleDelayFields() {
  const random = els.setDelayModeRandom.checked;
  els.fixedDelayFields.classList.toggle('hidden', random);
  els.randomDelayFields.classList.toggle('hidden', !random);
}

els.setDelayMode.addEventListener('change', toggleDelayFields);
els.setDelayModeRandom.addEventListener('change', toggleDelayFields);

async function saveSettingsForm() {
  const newSettings = {
    ...(settings || {}),
    delayMode: els.setDelayModeRandom.checked ? 'random' : 'fixed',
    delayBetweenShotsSec: parseInt(els.setDelay.value, 10) || 6,
    delayMinSec: parseInt(els.setDelayMin.value, 10) || 25,
    delayMaxSec: parseInt(els.setDelayMax.value, 10) || 45,
    retries: parseInt(els.setRetries.value, 10) || 3,
    filenameFormat: els.setFilename.value.trim() || 'SHOT{N}',
    projectName: els.setProject.value.trim() || 'Vheer Project',
    // Watchdog settings
    maxStallSec: parseInt(els.setMaxStall.value, 10) || 90,
    maxGenSec: parseInt(els.setMaxGen.value, 10) || 600,
    pollIntervalMs: parseInt(els.setPollInterval.value, 10) || 2000,
    recoveryDelaySec: parseInt(els.setRecoveryDelay.value, 10) || 5,
    retryDelaySec: parseInt(els.setRetryDelay.value, 10) || 10
  };
  settings = newSettings;
  await send({ type: 'SAVE_SETTINGS', settings: newSettings });
}

// ---------------------------------------------------------------------------
// Video mode — mode switcher, video import, folder picker, video queue.
// ---------------------------------------------------------------------------

/** Local debug log (wraps appendDebug with an entry object). */
function debugLog(step, detail, ok) {
  appendDebug({ ts: Date.now(), step, detail, ok: ok !== false });
}

/** Switch the panel between Image and Video generation modes. */
function setMode(nextMode) {
  mode = nextMode === 'video' ? 'video' : 'image';
  els.viewMain.dataset.mode = mode;
  els.btnModeImage.classList.toggle('mode-btn--active', mode === 'image');
  els.btnModeVideo.classList.toggle('mode-btn--active', mode === 'video');
  // Folder picker is a video-mode feature; show it whenever video mode is on.
  els.secVideoFolder.classList.toggle('hidden', mode !== 'video');
  renderQueue();
}

els.btnModeImage.addEventListener('click', () => setMode('image'));
els.btnModeVideo.addEventListener('click', () => setMode('video'));

// --- Video import (separate project from the image queue) ---
els.btnVideoImport.addEventListener('click', () => els.videoFileInput.click());
els.videoFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const content = await file.text();
  let name = file.name.replace(/\.[^.]+$/, '').trim();
  if (!name) name = 'Video Project';

  els.videoImportStatus.textContent = 'Importing…';
  els.videoImportStatus.className = 'status-text';
  const r = await send({ type: 'IMPORT_VIDEO_FILE', content, projectName: name });
  if (r.ok) {
    els.videoImportStatus.textContent = (r.count || 0) + ' video prompt jobs loaded';
    els.videoImportStatus.className = 'status-text status-text--ok';
    refresh();
  } else {
    els.videoImportStatus.textContent = r.error || 'Failed';
    els.videoImportStatus.className = 'status-text status-text--err';
  }
});

// --- Source Images folder picker (files held in memory; re-pick on restart) ---
els.btnPickFolder.addEventListener('click', () => els.folderInput.click());
els.folderInput.addEventListener('change', (e) => {
  folderFiles = {};
  for (const f of e.target.files) folderFiles[f.name] = f;
  const count = Object.keys(folderFiles).length;
  els.folderStatus.textContent = count ? '📁 ' + count + ' files loaded from selected folder' : 'No files selected';
  els.folderStatus.className = 'status-text' + (count ? ' status-text--ok' : '');
  debugLog('Folder', count + ' source images loaded');
});

// Video run control uses the SHARED queue engine: the same Start/Stop buttons
// above send START_QUEUE/STOP_QUEUE with mode='video'. No separate video engine.

// --- Port to the service worker for per-shot image-byte requests (video) ---
// Reconnects if the MV3 service worker goes to sleep, so the image transfer
// stays available across SW restarts.
let panelPort = null;
function connectPanelPort() {
  try {
    panelPort = chrome.runtime.connect({ name: 'aistudio-panel' });
  } catch (e) {
    panelPort = null;
    setTimeout(connectPanelPort, 2000);
    return;
  }
  panelPort.onMessage.addListener((msg) => {
    if (msg.type !== 'REQUEST_UPLOAD') return;
    const shotNum = msg.shotNumber;
    const file = findImageForShot(shotNum);
    if (!file) {
      panelPort.postMessage({ type: 'UPLOAD_IMAGE', shotNumber: shotNum, error: 'No image found for SHOT ' + shotNum + ' — pick the Images folder first' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result).split(',')[1] || '';
      panelPort.postMessage({ type: 'UPLOAD_IMAGE', shotNumber: shotNum, filename: file.name, base64: b64 });
    };
    reader.onerror = () => panelPort.postMessage({ type: 'UPLOAD_IMAGE', shotNumber: shotNum, error: 'Could not read ' + file.name });
    reader.readAsDataURL(file);
  });
  panelPort.onDisconnect.addListener(() => {
    panelPort = null;
    setTimeout(connectPanelPort, 1000); // retry if the SW restarted
  });
}
connectPanelPort();

/** Find the source image for a shot in the picked folder (SHOT001.png, …). */
function findImageForShot(shotNumber) {
  const padded = String(shotNumber).padStart(3, '0');
  const prefixes = ['SHOT' + padded, 'SHOT' + shotNumber];
  for (const prefix of prefixes) {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const f = folderFiles[prefix + ext];
      if (f) return f;
    }
  }
  const match = Object.keys(folderFiles).find(n => n.startsWith('SHOT' + padded));
  return match ? folderFiles[match] : null;
}

// ---------------------------------------------------------------------------
// Refresh / init
// ---------------------------------------------------------------------------

async function refresh() {
  const state = await send({ type: 'GET_STATE' });
  if (state.ok) {
    queue = state.queue;
    videoQueue = state.videoQueue;
    settings = state.settings;
    setMode(mode);
    renderQueue();
  }
}

// Auto-run connection check on open.
(async () => {
  await refresh();
  const r = await send({ type: 'TEST_CONNECTION', mode });
  if (r.ok) {
    const isVideo = mode === 'video';
    const okSignal = isVideo ? r.uploadFound : r.promptFound;
    els.vheerStatus.textContent = okSignal
      ? (isVideo ? '✓ Connected to Vheer Video — upload input found' : '✓ Connected to Vheer — prompt found')
      : (isVideo ? '✓ Connected to Vheer Video — upload input NOT found (element dump below)' : '✓ Connected to Vheer — prompt NOT found (element dump below)');
    els.vheerStatus.className = 'status-banner status-banner--ok';
    if (!okSignal) {
      setTestResult(isVideo ? '⚠ Upload input NOT found — review the element dump' : '⚠ Prompt textarea NOT found — review the element dump', 'status-text--err');
      showElementDump(r.info && r.info.elements);
    }
  } else {
    els.vheerStatus.textContent = '⚠ ' + (r.error || 'Not connected');
    els.vheerStatus.className = 'status-banner';
  }
})();
