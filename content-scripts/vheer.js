/**
 * Vheer Story Studio — Vheer Adapter (Text-to-Image + Image-to-Video)
 *
 * Supports both https://vheer.com/app/text-to-image and
 * https://vheer.com/app/image-to-video. The content script detects the route
 * itself; the key control differs per route (prompt textarea vs upload input).
 *
 * Architecture (single file, sectioned like a provider module set):
 *   DETECTOR    — URL validation. No frames, no iframes, no heuristics.
 *   SELECTORS   — prompt textarea + generate + download + upload detection.
 *   INSPECTOR   — full-page DOM dump for debugging (incl. iframes).
 *   ACTIONS     — fill prompt, click generate, wait for image.
 *   VIDEO       — image upload + preview verification for Image→Video.
 *   DOWNLOADER  — click download; SW intercepts + renames + verifies.
 *
 * Connection model: verify URL → wait for DOM ready → find key control →
 * connected. The top document is the only thing inspected; no sub-frame
 * concept exists.
 */

(() => {
  'use strict';

  try {

  const TAG = '[Vheer-Story]';
  const VERSION = '7.3.0';
  const TARGET_URL = 'https://vheer.com/app/text-to-image';
  const TARGET_URL_VIDEO = 'https://vheer.com/app/image-to-video';

  // =========================================================================
  //  1. DUPLICATE-INJECTION GUARD. If a healthy instance already loaded, a
  //     second injection (e.g. the SW force re-injecting) must be a NO-OP —
  //     otherwise two copies both fill prompts and click buttons/downloads.
  // =========================================================================

  console.log(TAG, 'CONTENT SCRIPT LOADED v' + VERSION);
  console.log(TAG, 'window.location.href:', window.location.href);

  if (window.__vheerContentScriptActive) {
    console.log(TAG, 'Duplicate injection skipped — script already active');
    return;
  }

  // Remove listeners from ALL prior instances. We track every handle we ever
  // register so a later injection can remove them even if an earlier instance
  // crashed after registering (which leaves an orphaned listener that keeps
  // responding to messages → the exact double-action bug seen in the log).
  const priorHandles = (window.__vheerStoryHandles || []).slice();
  priorHandles.forEach((h) => {
    try { chrome.runtime.onMessage.removeListener(h); } catch (e) {}
  });
  if (priorHandles.length) console.log(TAG, 'Removed ' + priorHandles.length + ' stale listener(s)');
  window.__vheerStoryHandles = [];

  let _isTop = null;
  try {
    _isTop = window.self === window.top;
    console.log(TAG, 'window.top === window:', _isTop);
  } catch (e) {
    console.log(TAG, 'window.top check failed:', e.message);
  }

  function handleMessage(msg, sender, sendResponse) {
    console.log(TAG, 'MSG RECEIVED:', msg.type);

    if (msg.type === 'PING') {
      try {
        sendResponse({
          ok: true,
          pong: 'PONG',
          href: window.location.href,
          isTop: _isTop,
          adapter: 'vheer',
          version: VERSION
        });
      } catch (e) {
        console.error(TAG, 'PING response failed:', e);
      }
      return false;
    }

    if (handleMessage._fullHandler) {
      try {
        return handleMessage._fullHandler(msg, sender, sendResponse);
      } catch (e) {
        console.error(TAG, 'Full handler threw:', e);
        try { sendResponse({ ok: false, error: 'Handler error: ' + e.message }); } catch (e2) {}
        return false;
      }
    }

    console.warn(TAG, 'Full handler not initialized, ignoring:', msg.type);
    return false;
  }

  chrome.runtime.onMessage.addListener(handleMessage);

  // Track the handle IMMEDIATELY (before initFullHandler, which could crash) so
  // a future injection can always remove this listener — no orphans.
  window.__vheerStoryHandles.push(handleMessage);
  window.__vheerStoryHandle = handleMessage; // back-compat

  console.log(TAG, 'MESSAGE LISTENER REGISTERED');

  // =========================================================================
  //  2. INITIALIZATION
  // =========================================================================

  try {
    initFullHandler();
  } catch (err) {
    console.error(TAG, 'INITIALIZATION FAILED:', err.message);
    console.error(TAG, 'STACK:', err.stack);
  }

  function initFullHandler() {
    console.log(TAG, 'Initializing Vheer adapter…');

    // Set true by STOP_AUTOMATION so any in-flight fill/generate/wait loop
    // halts instead of continuing to click buttons after the user hits Stop.
    let _automationAborted = false;

    // Unique id for THIS content-script instance. If duplicate log lines carry
    // DIFFERENT instance ids, two copies of the script are running in the same
    // frame. Same instance id → a single copy received/executed twice.
    const _instanceId = 'cs-' + Math.random().toString(36).slice(2, 8);

    // Run id threaded through a shot's pipeline. If two log lines for the same
    // operation carry the SAME run id, the operation ran twice (re-entrancy).
    // Different run ids → two independent pipelines were started.
    let _currentRunId = null;

    // Guards: only one video pipeline / one post-download cleanup may run per
    // content-script instance at a time.
    let _videoPipelineActive = false;
    let _cleanupInProgress = false;

    // ---- Generic helpers ---------------------------------------------------

    function delay(min, max) {
      const ms = min + Math.random() * (max - min);
      return new Promise(r => setTimeout(r, ms));
    }

    function isVisible(el) {
      if (!el) return false;
      if (el.disabled) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function debugLog(step, detail, ok) {
      if (ok === undefined) ok = true;
      const entry = {
        ts: Date.now(), step, detail: detail || '', ok,
        frame: window.location.hostname,
        instance: _instanceId,
        runId: _currentRunId
      };
      const runTag = _currentRunId ? ' [run ' + _currentRunId + ']' : '';
      console[ok ? 'log' : 'warn'](TAG, ok ? '✓' : '✗', '[' + _instanceId + ']' + runTag, step, detail || '');
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG', entry }).catch(() => {});
    }

    // =========================================================================
    //  DETECTOR — page validation via parsed URL (hostname + pathname).
    //  Never compares the whole href as a string, so trailing slashes, query
    //  params, hashes, and tracking noise are all tolerated.
    // =========================================================================

    /** Does `path` equal `route` or descend under `route + '/'`? */
    function pathMatchesVheer(path, route) {
      return path === route || path.startsWith(route + '/');
    }

    function isTargetPage(href) {
      try {
        const url = new URL(href || window.location.href);
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
    function isVideoTargetPage(href) {
      try {
        const url = new URL(href || window.location.href);
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

    // -------------------------------------------------------------------------
    //  DEBUG-ONLY URL diagnostic. Mirrors isTargetPage() step-by-step so we can
    //  see exactly which comparison fails. Does NOT affect the validator.
    // -------------------------------------------------------------------------

    function diagnoseUrl(href) {
      const raw = href || window.location.href;
      const out = {
        location: 'content-script',
        locationHref: raw,
        jsonStringify: JSON.stringify(raw),
        expectedUrl: TARGET_URL,
        validatorResult: isTargetPage(raw)
      };
      try {
        const url = new URL(raw);
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
        out.hrefExactMatch = raw === TARGET_URL || raw === TARGET_URL_VIDEO;
        out.hrefStartsWith = raw.startsWith(TARGET_URL) || raw.startsWith(TARGET_URL_VIDEO);
        out.hrefEndsWithPath = raw.endsWith('/app/text-to-image') || raw.endsWith('/app/image-to-video');
        out.hrefEndsWithPathSlash = raw.endsWith('/app/text-to-image/') || raw.endsWith('/app/image-to-video/');

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

    // =========================================================================
    //  SELECTORS — element detection for the Vheer page.
    // =========================================================================

    function findPromptTextarea() {
      // 1. Vheer's prompt textarea has a distinctive placeholder.
      for (const ta of document.querySelectorAll('textarea')) {
        const ph = (ta.placeholder || '').toLowerCase();
        if (ph && /describe|image|prompt/i.test(ph) && isVisible(ta)) return ta;
      }
      // 2. Fallback: any visible textarea.
      for (const ta of document.querySelectorAll('textarea')) {
        if (isVisible(ta)) return ta;
      }
      return null;
    }

    /** All candidate prompt fields (for the "not found" dump). */
    function promptCandidates() {
      const out = [];
      document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]').forEach((el, i) => {
        out.push({
          index: i,
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          placeholder: el.placeholder || '',
          name: el.name || '',
          visible: isVisible(el),
          valuePreview: (el.value || el.textContent || '').slice(0, 40)
        });
      });
      return out;
    }

    function findGenerateButton() {
      for (const btn of document.querySelectorAll('button')) {
        const text = (btn.textContent || '').trim();
        if (isVisible(btn) && /^generate\b/i.test(text)) return btn;
      }
      for (const btn of document.querySelectorAll('button')) {
        const text = (btn.textContent || '').trim();
        if (isVisible(btn) && /generate/i.test(text)) return btn;
      }
      return null;
    }

    function findDownloadButton() {
      for (const btn of document.querySelectorAll('button')) {
        const text = (btn.textContent || '').trim();
        if (isVisible(btn) && /^download\b/i.test(text)) return btn;
      }
      for (const btn of document.querySelectorAll('button')) {
        const text = (btn.textContent || '').trim();
        if (isVisible(btn) && /download/i.test(text)) return btn;
      }
      return null;
    }

    /**
     * VIDEO: find the file input used to upload the source image.
     * Best-guess locator (page-specific to Vheer's image-to-video page):
     * a visible <input type="file">, preferring one whose accept mentions image.
     * Logs candidates so the real page can be inspected if nothing matches.
     */
    function findUploadInput() {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      if (!inputs.length) {
        debugLog('Upload Input', 'no <input type="file"> found');
        return null;
      }
      const visible = inputs.filter(i => isVisible(i));
      const pool = visible.length ? visible : inputs;
      const image = pool.find(i => /image/i.test(i.getAttribute('accept') || ''));
      if (image) return image;
      if (pool.length === 1) return pool[0];
      debugLog('Upload Input', pool.length + ' file inputs, picking first');
      return pool[0];
    }

    /**
     * VIDEO: look for an upload preview / uploaded-image thumbnail.
     * Best-guess indicators: a fully-loaded <img> with a blob:/data: src that
     * wasn't in the pre-upload snapshot, or a visible element whose class/id
     * suggests an upload preview. Returns the element or null.
     */
    function findUploadPreview(beforeImgs) {
      const imgs = Array.from(document.querySelectorAll('img'));
      for (const img of imgs) {
        const src = img.currentSrc || img.src || '';
        const isUpload = /^blob:/i.test(src) || /^data:image/i.test(src);
        if (!isUpload) continue;
        if (beforeImgs && beforeImgs.has(src)) continue;
        if (img.complete && img.naturalWidth > 0) return img;
      }
      // Fallback: a visible element hinting at a preview / thumbnail state.
      const hints = document.querySelectorAll('[class*="preview" i], [class*="thumbnail" i], [class*="uploaded" i], [role="img"]');
      for (const el of hints) {
        if (isVisible(el) && el.getBoundingClientRect().width > 40) return el;
      }
      return null;
    }

    // =========================================================================
    //  WAIT FOR PAGE — Vheer is an SPA; wait for the prompt to render.
    // =========================================================================

    /**
     * Resolves true when the prompt textarea appears (MutationObserver + poll).
     * NEVER rejects: if the observer can't attach, we fall back to polling only.
     * This guarantees the caller's sendResponse always fires.
     */
    function waitForPrompt(timeoutMs = 15000) {
      return new Promise((resolve) => {
        try {
          const found = findPromptTextarea();
          if (found) { resolve(true); return; }

          const start = Date.now();
          let observer = null;
          try {
            observer = new MutationObserver(() => {
              if (findPromptTextarea()) {
                observer.disconnect();
                resolve(true);
              }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
          } catch (e) {
            // Observer unavailable (e.g. documentElement missing) — poll only.
            observer = null;
          }

          const poll = setInterval(() => {
            if (findPromptTextarea()) {
              clearInterval(poll);
              if (observer) observer.disconnect();
              resolve(true);
            } else if (Date.now() - start > timeoutMs) {
              clearInterval(poll);
              if (observer) observer.disconnect();
              resolve(false);
            }
          }, 300);
        } catch (e) {
          resolve(false);
        }
      });
    }

    /** Resolves when the document reaches a given ready state. */
    function waitForReadyState(target = 'interactive', timeoutMs = 10000) {
      return new Promise((resolve) => {
        if (document.readyState === 'complete' || document.readyState === target) { resolve(true); return; }
        const start = Date.now();
        const poll = setInterval(() => {
          if (document.readyState === 'complete' || document.readyState === target) {
            clearInterval(poll);
            resolve(true);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(poll);
            resolve(false);
          }
        }, 200);
      });
    }

    // =========================================================================
    //  INSPECTOR — full-page dump for debugging (main doc + iframes).
    // =========================================================================

    function describeElement(el, index) {
      const visible = isVisible(el);
      let innerText = '';
      try {
        innerText = (el.innerText || el.value || '').trim().slice(0, 120);
      } catch (e) { /* ignore */ }
      return {
        index,
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
        name: el.name || '',
        placeholder: el.placeholder || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        visible: visible ? 'visible' : 'hidden',
        disabled: !!el.disabled,
        innerText
      };
    }

    /** Inspect a single document, capped to keep the payload sane. */
    function inspectDocument(doc, label) {
      const cap = (els, n = 40) => els.slice(0, n);
      const textareas = cap(Array.from(doc.querySelectorAll('textarea'))).map(describeElement);
      const inputs = cap(Array.from(doc.querySelectorAll('input'))).map(describeElement);
      const selects = cap(Array.from(doc.querySelectorAll('select'))).map(describeElement);
      const editables = cap(Array.from(doc.querySelectorAll('[contenteditable="true"]'))).map(describeElement);
      const buttons = cap(Array.from(doc.querySelectorAll('button'))).map(describeElement);
      return {
        label,
        url: doc.location ? doc.location.href : '',
        title: doc.title || '',
        counts: {
          textareas: doc.querySelectorAll('textarea').length,
          inputs: doc.querySelectorAll('input').length,
          buttons: doc.querySelectorAll('button').length,
          selects: doc.querySelectorAll('select').length,
          contenteditable: doc.querySelectorAll('[contenteditable="true"]').length
        },
        textareas, inputs, selects, editables, buttons
      };
    }

    /** Describe every iframe in the current document. */
    function inspectFrames() {
      const frames = [];
      for (const f of document.querySelectorAll('iframe')) {
        let sameOrigin = false;
        let accessible = false;
        try {
          const fOrigin = (() => {
            try { return new URL(f.src).origin; } catch { return ''; }
          })();
          sameOrigin = fOrigin === window.location.origin;
        } catch { /* ignore */ }
        try {
          accessible = f.contentDocument !== null;
        } catch { accessible = false; }
        frames.push({
          src: (f.src || '').slice(0, 150),
          title: f.title || '',
          id: f.id || '',
          sameOrigin,
          accessible
        });
      }
      return frames;
    }

    function inspectPage() {
      const main = inspectDocument(document, 'main-document');
      const frames = inspectFrames();
      const frameDocs = [];
      for (const f of document.querySelectorAll('iframe')) {
        try {
          if (f.contentDocument) frameDocs.push(inspectDocument(f.contentDocument, 'iframe:' + (f.src || 'unknown')));
        } catch { /* cross-origin — skip */ }
      }
      return {
        url: window.location.href,
        title: document.title,
        framework: detectFramework(),
        readyState: document.readyState,
        isTop: _isTop,
        counts: main.counts,
        main,
        frames,
        frameDocs,
        promptFound: !!findPromptTextarea(),
        generateFound: !!findGenerateButton()
      };
    }

    function detectFramework() {
      if (typeof window.__NEXT_DATA__ !== 'undefined' || typeof window.next !== 'undefined') return 'Next.js (React)';
      if (typeof window.__NUXT__ !== 'undefined') return 'Nuxt (Vue)';
      if (typeof window.React !== 'undefined') return 'React';
      if (typeof window.angular !== 'undefined') return 'Angular';
      if (typeof window.Vue !== 'undefined') return 'Vue';
      return 'unknown';
    }

    // =========================================================================
    //  ACTIONS — fill, click, wait.
    // =========================================================================

    /** Fill a SPECIFIC textarea (used for the main and negative prompts). */
    async function fillPromptOn(ta, text) {
      if (!ta) return { ok: false, error: 'Prompt textarea not found' };

      ta.focus();
      await delay(100, 300);

      // Strategy 1: execCommand — fires the framework's event handlers.
      try {
        ta.setSelectionRange(0, ta.value.length);
        await delay(30, 80);
        const ok = document.execCommand('insertText', false, text);
        if (ok && ta.value === text) {
          await delay(50, 150);
          return { ok: true, chars: ta.value.length, method: 'execCommand' };
        }
      } catch (e) { /* fall through */ }

      // Strategy 2: native value setter + event sequence.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(ta, text);
      else ta.value = text;

      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Process' }));
      ta.dispatchEvent(new Event('compositionend', { bubbles: true }));
      await delay(100, 250);

      if (!ta.value || ta.value.length < Math.min(text.length, 10)) {
        return { ok: false, error: 'Fill failed: got ' + ta.value.length + ' chars, expected ' + text.length };
      }
      return { ok: true, chars: ta.value.length, method: 'nativeSetter' };
    }

    /** Fill the main prompt textarea (Image and Video pages). */
    async function fillPrompt(text) {
      return fillPromptOn(findPromptTextarea(), text);
    }

    /** Full mouse sequence on any element. */
    async function humanClick(el) {
      if (!el) return { ok: false, error: 'Element not found' };

      await delay(120, 300);
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0
      };
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      await delay(40, 90);
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      await delay(30, 70);
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      await delay(20, 50);
      el.click();
      await delay(80, 160);
      return { ok: true };
    }

    async function clickGenerate() {
      const btn = findGenerateButton();
      if (!btn) return { ok: false, error: 'Generate button not found' };
      return humanClick(btn);
    }

    function snapshotImageSrcs() {
      const srcs = new Set();
      for (const img of document.querySelectorAll('img')) {
        const src = img.currentSrc || img.src;
        if (src && !src.startsWith('data:')) srcs.add(src);
      }
      return srcs;
    }

    function findNewImage(beforeSrcs) {
      for (const img of document.querySelectorAll('img')) {
        if (!img.complete || img.naturalWidth === 0) continue;
        const src = img.currentSrc || img.src;
        if (!src || src.startsWith('data:')) continue;
        if (!beforeSrcs.has(src)) return src;
      }
      return null;
    }

    // =======================================================================
    //  WATCHDOG — liveness probe, overlay detection, failure-popup detection.
    //  Replaces the old flat5-minute waitForImage with a Smart Watchdog that
    //  distinguishes "still generating" from "permanently stalled" by measuring
    //  whether the page is alive (network activity, DOM changes, text changes).
    // =======================================================================

    /**
     * Lightweight FNV-1a hash — used to fingerprint body text between ticks.
     * Capped at4096 chars to avoid perf hit on large DOMs.
     */
    function fnv1aHash(str) {
      let h = 2166136261;
      const max = Math.min(str.length, 4096);
      for (let i = 0; i < max; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 16777619) >>> 0;
      }
      return h;
    }

    /**
     * Find a dismiss/close control within a DOM scope.
     * Used by both overlay detection and failure-popup dismissal.
     */
    function findDismissControl(scope, pattern) {
      const pat = pattern || /close|dismiss|×|✕|ok|got it|okay|accept|continue|skip|no thanks|later|retry|try again/i;
      const controls = scope.querySelectorAll('button, a, [role="button"]');
      for (const el of controls) {
        if (!isVisible(el)) continue;
        const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        if (text && pat.test(text)) return el;
      }
      return null;
    }

    /**
     * Start a liveness probe for one shot's generation window.
     * Returns { getEvidence(), dispose() }.
     *
     * Tracks four independent liveness sources — any ONE firing means
     * "still alive"; all silent = stalled:
     *   1. Resource-timing delta  (network activity — status polls, image fetches)
     *   2. In-progress requests   (long-poll / SSE connections still open)
     *   3. MutationObserver count (DOM changes — progress re-renders, skeletons)
     *   4. Body-text hash         (status text / progress % / error text changed)
     */
    function startLivenessProbe() {
      // --- Source 1 & 2: Resource timing ---
      try {
        performance.clearResourceTimings();
        performance.setResourceTimingBufferSize(20000);
      } catch (e) { /* restricted in some contexts */ }
      let resourceSeenCount = 0;

      // --- Source 3: MutationObserver ---
      let mutationCount = 0;
      let observer = null;
      try {
        observer = new MutationObserver(function () { mutationCount++; });
        observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true, characterData: true
        });
      } catch (e) { observer = null; }

      // --- Source 4: Body-text hash ---
      let lastTextHash = 0;
      try {
        lastTextHash = fnv1aHash(document.body ? document.body.textContent || '' : '');
      } catch (e) { /* fallback */ }

      function getEvidence() {
        const ev = { network: false, longPoll: false, mutations: false, textChanged: false };

        // Source 1: new completed resource entries since last tick.
        try {
          const entries = performance.getEntriesByType('resource');
          const newCount = entries.length - resourceSeenCount;
          if (newCount > 0) ev.network = true;
          resourceSeenCount = entries.length;

          // Source 2: any request still in-flight (responseEnd === 0).
          const checkStart = Math.max(0, entries.length - 20);
          for (let i = entries.length - 1; i >= checkStart; i--) {
            const e = entries[i];
            if (e.responseEnd === 0 && e.startTime > 0) { ev.longPoll = true; break; }
          }
        } catch (perfErr) { /* performance unavailable */ }

        // Source 3: DOM mutations since last tick.
        if (mutationCount > 0) { ev.mutations = true; mutationCount = 0; }

        // Source 4: body-text hash changed.
        try {
          const curHash = fnv1aHash(document.body ? document.body.textContent || '' : '');
          if (curHash !== lastTextHash) { ev.textChanged = true; lastTextHash = curHash; }
        } catch (e) { /* fallback */ }

        return ev;
      }

      function dispose() {
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        mutationCount = 0;
        resourceSeenCount = 0;
      }

      return { getEvidence: getEvidence, dispose: dispose };
    }

    /**
     * Detect a closeable overlay (ad, modal, interstitial) that may be
     * blocking interaction with the Generate button or the result area.
     * Returns { found: boolean, closeBtn: Element|null }.
     */
    function detectCloseableOverlay() {
      // Strategy 1: elementFromPoint on the Generate button — something covering it?
      const genBtn = findGenerateButton();
      if (genBtn) {
        const rect = genBtn.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(cx, cy);
        if (topEl && !genBtn.contains(topEl) && topEl !== genBtn) {
          const container = topEl.closest('[role="dialog"], .modal, .overlay, .popup, [class*="modal"], [class*="overlay"], [class*="popup"]') || topEl;
          const closeBtn = findDismissControl(container);
          if (closeBtn) return { found: true, closeBtn: closeBtn };
        }
      }

      // Strategy 2: scan for visible overlay/modal elements with a dismiss control.
      const sel = '[role="dialog"], [role="alertdialog"], .modal, .overlay, .popup, .dialog, [class*="modal"], [class*="overlay"], [class*="popup"], [class*="banner"], [class*="ad-"], [class*="interstitial"]';
      const overlays = document.querySelectorAll(sel);
      for (let i = 0; i < overlays.length; i++) {
        const el = overlays[i];
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 100) continue; // skip tiny elements
        const btn = findDismissControl(el);
        if (btn) return { found: true, closeBtn: btn };
      }

      return { found: false, closeBtn: null };
    }

    /**
     * Detect a "Generation failed" popup / error dialog.
     * Returns { found, dismissBtn, text }.
     */
    function detectFailurePopup() {
      const failPatterns = /generation failed|failed to generate|something went wrong|error generating|could not generate|couldn't generate|unable to generate|generation error/i;
      const dismissPatterns = /close|dismiss|ok|got it|okay|continue|retry|try again/i;

      // Check visible alert / dialog / toast containers.
      const containers = document.querySelectorAll(
        '[role="alert"], [role="alertdialog"], [role="dialog"], .modal, .popup, .toast, .notification, ' +
        '[class*="toast"], [class*="notification"], [class*="alert"], [class*="error"], [class*="modal"], [class*="popup"]'
      );
      for (let i = 0; i < containers.length; i++) {
        const el = containers[i];
        if (!isVisible(el)) continue;
        const text = el.textContent || '';
        if (failPatterns.test(text)) {
          const dismissBtn = findDismissControl(el, dismissPatterns);
          return { found: true, dismissBtn: dismissBtn, text: text.trim().slice(0, 120) };
        }
      }

      // Broader: any visible element with failure text + a dismiss sibling.
      const allEls = document.querySelectorAll('div, p, span, section');
      for (let j = 0; j < allEls.length; j++) {
        const el2 = allEls[j];
        if (!isVisible(el2)) continue;
        const txt = el2.textContent || '';
        if (!failPatterns.test(txt)) continue;
        const scope = el2.closest('[role="dialog"], .modal, .popup, .toast, .notification, form') || el2.parentElement;
        if (!scope) continue;
        const btn2 = findDismissControl(scope, dismissPatterns);
        if (btn2) return { found: true, dismissBtn: btn2, text: txt.trim().slice(0, 120) };
      }

      return { found: false, dismissBtn: null, text: '' };
    }

    // =======================================================================
    //  WAIT FOR GENERATION — Smart Watchdog monitor.
    //  Replaces the old flat5-minute waitForImage. Continuously polls for:
    //    • completion signals (new image / download button / generate re-enabled)
    //    • liveness evidence  (network / mutations / text changes)
    //    • recovery actions   (overlay close / failure popup dismiss)
    //  and returns a verdict the service worker acts on.
    // =======================================================================

    /**
     * @param {Set} beforeSrcs   — image src snapshot taken before clicking Generate.
     * @param {object} cfg       — watchdog config from the service worker:
     *   { maxStallMs, maxGenMs, pollIntervalMs, recoveryDelayMs, maxRetries, shotNumber }
     * @returns {Promise<{ok, verdict, signal?, src?, error?, recovery?, evidence?}>}
     */
    function waitForGeneration(beforeSrcs, cfg) {
      const startTime = Date.now();
      const recoveryLog = [];         // track recovery actions performed this shot
      let probe = startLivenessProbe();
      let sawGenerateDisabled = false; // for the "disabled → enabled" transition signal
      let lastActivityAt = Date.now(); // initially "alive" (grace period for click to register)
      let failedPopupCount = 0;
      const popupRetries = cfg.maxRetries || 3;

      return new Promise(function (resolve) {
        const poll = function () {
          // --- Abort check ---
          if (_automationAborted) {
            probe.dispose();
            resolve({ ok: false, verdict: 'aborted', error: 'Aborted by Stop', recovery: recoveryLog });
            return;
          }

          const elapsed = Date.now() - startTime;

          // =================================================================
          //  COMPLETION SIGNALS
          // =================================================================

          // 1. New image appeared (src not in beforeSrcs, fully loaded).
          const newImg = findNewImage(beforeSrcs);
          if (newImg) {
            probe.dispose();
            resolve({ ok: true, verdict: 'complete', signal: 'new-image', src: newImg, recovery: recoveryLog });
            return;
          }

          // 2. Download button appeared — generation is done.
          const dlBtn = findDownloadButton();
          if (dlBtn) {
            probe.dispose();
            resolve({ ok: true, verdict: 'complete', signal: 'download-ready', recovery: recoveryLog });
            return;
          }

          // 3. Generate button transitioned disabled → enabled.
          //    Fixes the old false-positive where a stale previous image made
          //    "button enabled + image present" true immediately on the next shot.
          var gen = findGenerateButton();
          if (gen) {
            if (gen.disabled) {
              sawGenerateDisabled = true;
            } else if (sawGenerateDisabled) {
              const hasImg = Array.from(document.querySelectorAll('img'))
                .some(function (i) { return i.complete && i.naturalWidth > 0 && i.src && !i.src.startsWith('data:'); });
              if (hasImg && elapsed > 15000) {
                probe.dispose();
                resolve({ ok: true, verdict: 'complete', signal: 'generate-reenabled', recovery: recoveryLog });
                return;
              }
            }
          }

          // =================================================================
          //  RECOVERY 1 — Close overlay / ad blocking interaction
          // =================================================================

          const overlay = detectCloseableOverlay();
          if (overlay.found) {
            try { overlay.closeBtn.click(); } catch (e) {}
            recoveryLog.push('Overlay Closed');
            debugLog('Recovery', 'Overlay closed — continuing generation', true);
            lastActivityAt = Date.now(); // closing counts as activity, resets stall timer
          }

          // =================================================================
          //  RECOVERY 2 — Dismiss failure popup, retry generation
          // =================================================================

          const popup = detectFailurePopup();
          if (popup.found) {
            failedPopupCount++;
            if (failedPopupCount > popupRetries) {
              probe.dispose();
              resolve({
                ok: false, verdict: 'failed-popup-exhausted',
                error: 'Failure popup dismissed ' + failedPopupCount + ' times: ' + popup.text,
                recovery: recoveryLog
              });
              return;
            }
            if (popup.dismissBtn) {
              try { popup.dismissBtn.click(); } catch (e) {}
            }
            recoveryLog.push('Popup Closed (' + popup.text.slice(0, 50) + ')');
            debugLog('Recovery', 'Failure popup dismissed: ' + popup.text.slice(0, 80), true);
            lastActivityAt = Date.now();

            // After dismissal, wait recoveryDelay then re-click Generate.
            setTimeout(function () {
              if (_automationAborted) return;
              const genAgain = findGenerateButton();
              if (genAgain && isVisible(genAgain)) {
                humanClick(genAgain).then(function () {
                  debugLog('Retry After Popup', 'Generate clicked again — restarting monitor');
                  // Restart monitor with fresh baselines so old evidence doesn't carry over.
                  probe.dispose();
                  probe = startLivenessProbe();
                  sawGenerateDisabled = false;
                  lastActivityAt = Date.now();
                  beforeSrcs = snapshotImageSrcs();
                });
              }
              // If generate button not found/clickable, the next poll tick
              // will detect the resulting stall naturally.
            }, cfg.recoveryDelayMs || 5000);
          }

          // =================================================================
          //  LIVENESS ACCUMULATION
          //  Any one source firing = "page is alive, keep waiting."
          // =================================================================

          const evidence = probe.getEvidence();
          const hasLiveness = evidence.network || evidence.longPoll || evidence.mutations || evidence.textChanged;
          if (hasLiveness) {
            lastActivityAt = Date.now(); // reset the stall window
          }

          // =================================================================
          //  STALL CHECK — no liveness AND no completion for the stall window
          // =================================================================

          const silentFor = Date.now() - lastActivityAt;
          const gracePeriod = 10000; //10s grace at start for the click to register
          if (elapsed > gracePeriod && silentFor > cfg.maxStallMs) {
            const lastSource = evidence.network ? 'network' : evidence.longPoll ? 'longPoll'
              : evidence.mutations ? 'mutations' : evidence.textChanged ? 'textChanged' : 'none';
            probe.dispose();
            resolve({
              ok: false, verdict: 'stalled',
              error: 'No liveness for ' + Math.round(silentFor / 1000) + 's (last source: ' + lastSource + ')',
              recovery: recoveryLog, evidence: evidence
            });
            return;
          }

          // =================================================================
          //  HARD CAP — still "alive" but exceeded maximum generation time
          // =================================================================

          if (elapsed > cfg.maxGenMs) {
            probe.dispose();
            resolve({
              ok: false, verdict: 'slow-over-cap',
              error: 'Generation exceeded hard cap of ' + Math.round(cfg.maxGenMs / 1000) + 's',
              recovery: recoveryLog
            });
            return;
          }

          // --- Next tick ---
          setTimeout(poll, cfg.pollIntervalMs || 2000);
        };

        poll(); // start immediately
      });
    }

    // =========================================================================
    //  DOWNLOADER — click download; the SW intercepts, renames, verifies.
    // =========================================================================

    async function clickDownload() {
      const dl = findDownloadButton();
      if (!dl) return { ok: false, error: 'Download button not found', skipped: true };
      return humanClick(dl);
    }

    // =========================================================================
    //  VIDEO — image upload + preview verification for Image→Video.
    // =========================================================================

    /** Wait for the video page's upload input to render (SPA). */
    function waitForUploadInput(timeoutMs = 15000) {
      return new Promise((resolve) => {
        const start = Date.now();
        const poll = () => {
          if (findUploadInput()) { resolve(true); return; }
          if (Date.now() - start > timeoutMs) { resolve(false); return; }
          setTimeout(poll, 300);
        };
        poll();
      });
    }

    /** Decode a base64 string into a Uint8Array. */
    function base64ToBytes(b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }

    /**
     * Programmatically set the source-image file on the upload input.
     * `bytes` is a Uint8Array (decoded from the base64 the SW forwarded).
     */
    async function uploadImage(bytes, filename) {
      const input = findUploadInput();
      if (!input) return { ok: false, error: 'Upload input not found' };
      if (!bytes || !bytes.length) return { ok: false, error: 'No image bytes provided' };
      try {
        const mime = /\.png$/i.test(filename) ? 'image/png'
          : /\.jpe?g$/i.test(filename) ? 'image/jpeg'
          : /\.webp$/i.test(filename) ? 'image/webp' : 'image/png';
        const file = new File([bytes], filename, { type: mime });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await delay(100, 250);
        return { ok: true, filename, bytes: bytes.length };
      } catch (e) {
        return { ok: false, error: 'Upload failed: ' + e.message };
      }
    }

    /**
     * Poll until an upload preview appears (or timeout). Never assumes the
     * upload succeeded — only continues once a preview/state indicator shows.
     */
    function waitForUploadPreview(beforeImgs, timeoutMs = 60000) {
      return new Promise((resolve) => {
        const start = Date.now();
        const poll = () => {
          if (_automationAborted) { resolve({ ok: false, error: 'Aborted by Stop' }); return; }
          const preview = findUploadPreview(beforeImgs);
          if (preview) {
            resolve({ ok: true, signal: 'preview', src: preview.currentSrc || preview.src || '' });
            return;
          }
          if (Date.now() - start > timeoutMs) {
            resolve({ ok: false, error: 'Upload preview never appeared after ' + Math.round(timeoutMs / 1000) + 's' });
            return;
          }
          setTimeout(poll, 500);
        };
        poll();
      });
    }

    /**
     * VIDEO pipeline (Milestone 1 — STOPS before generation):
     *   upload source image → verify preview → paste video prompt.
     * Generation / watchdog / download come in a later milestone.
     */
    // =========================================================================
    //  VIDEO — Image→Video generation pipeline (model / duration / resolution /
    //  generate / download). Behaves like a careful human: every stage waits for
    //  the real DOM to confirm the previous step before advancing. Never assumes
    //  a click took effect.
    // =========================================================================

    /** The Download control: a button, or an <a download> / mp4 link. */
    function findVideoDownload() {
      const btn = findDownloadButton();
      if (btn) return btn;
      for (const a of document.querySelectorAll('a[download], a')) {
        const text = (a.textContent || '').trim();
        const href = a.getAttribute('href') || '';
        if (isVisible(a) && (/^download\b/i.test(text) || /download/i.test(text) || /\.mp4($|\?)/i.test(href))) return a;
      }
      return null;
    }

    /**
     * Any visible loading / progress / generating indicator. The body-text hint
     * only counts while the download control is not ready, so a lingering
     * "Generating…" status line cannot block the finish gate forever.
     */
    function hasLoadingIndicator() {
      const prog = document.querySelector('progress');
      if (prog && isVisible(prog)) return true;
      const hint = Array.from(document.querySelectorAll('[role="progressbar"], [class*="spinner" i], [class*="loading" i], [class*="progress" i], [class*="generating" i], [class*="render" i]'))
        .find(el => isVisible(el));
      if (hint) return true;
      const dl = findVideoDownload();
      if (dl && !dl.disabled) return false;
      try {
        const txt = document.body ? document.body.textContent || '' : '';
        if (/\b(generating|rendering|processing|creating|thinking)\b/i.test(txt)) return true;
      } catch (e) {}
      return false;
    }

    /** After clicking Generate, confirm it actually started (disabled or loading). */
    function waitVideoGenerationStart(genBtn, cfg) {
      const timeoutMs = ((cfg && cfg.maxStallSec) || 90) * 1000;
      const start = Date.now();
      return new Promise((resolve) => {
        const poll = () => {
          if (_automationAborted) { resolve({ ok: false, verdict: 'aborted', error: 'Aborted by Stop' }); return; }
          const btn = genBtn && genBtn.isConnected ? genBtn : findGenerateButton();
          if (btn && btn.disabled) { resolve({ ok: true, signal: 'generate-disabled' }); return; }
          if (hasLoadingIndicator()) { resolve({ ok: true, signal: 'loading' }); return; }
          if (Date.now() - start > timeoutMs) {
            resolve({ ok: false, verdict: 'no-start', error: 'Generate clicked but no loading state appeared after ' + Math.round(timeoutMs / 1000) + 's' });
            return;
          }
          setTimeout(poll, 500);
        };
        poll();
      });
    }

    /**
     * Wait for generation to finish: a NEW (not pre-existing) enabled Download
     * control appears and the loading state clears. Tracks liveness for stalls
     * and a hard cap.
     */
    function waitVideoGenerationFinish(cfg, preDownload) {
      const maxGenMs = ((cfg && cfg.maxGenSec) || 600) * 1000;
      const stallMs = ((cfg && cfg.maxStallSec) || 90) * 1000;
      const pollMs = (cfg && cfg.pollIntervalMs) || 2000;
      const start = Date.now();
      const probe = startLivenessProbe();
      let lastActivityAt = Date.now();
      return new Promise((resolve) => {
        const poll = () => {
          if (_automationAborted) { probe.dispose(); resolve({ ok: false, verdict: 'aborted', error: 'Aborted by Stop' }); return; }
          const dl = findVideoDownload();
          const loading = hasLoadingIndicator();
          if (dl && !dl.disabled && !loading && dl !== preDownload) {
            probe.dispose();
            resolve({ ok: true, verdict: 'complete', signal: 'download-ready' });
            return;
          }
          const ev = probe.getEvidence();
          if (ev.network || ev.longPoll || ev.mutations || ev.textChanged || loading) lastActivityAt = Date.now();
          const elapsed = Date.now() - start;
          if (elapsed > maxGenMs) {
            probe.dispose();
            resolve({ ok: false, verdict: 'slow-over-cap', error: 'Video generation exceeded hard cap (' + Math.round(maxGenMs / 1000) + 's)' });
            return;
          }
          if (Date.now() - lastActivityAt > stallMs) {
            probe.dispose();
            resolve({ ok: false, verdict: 'stalled', error: 'No generation activity for ' + Math.round(stallMs / 1000) + 's' });
            return;
          }
          setTimeout(poll, pollMs);
        };
        poll();
      });
    }

    /**
     * Full Image→Video pipeline for one shot. Each stage waits for the real DOM
     * to confirm the previous step; any failure returns { ok:false, stage,
     * error } and the queue stops the shot at that exact stage.
     */
    async function runVideoStep(msg) {
      debugLog('Connected to Vheer Video', window.location.href.slice(0, 60));
      _automationAborted = false;

      // Exactly one active pipeline per content-script instance. If a second
      // RUN_VIDEO_STEP arrives while the first is mid-flight, reject it instead
      // of duplicating every DOM action (upload / prompt / generate / download).
      if (_videoPipelineActive) {
        debugLog('Duplicate RUN_VIDEO_STEP blocked', 'pipeline already running', false);
        return { ok: false, stage: 'duplicate', error: 'Video pipeline already running in this content script' };
      }
      _videoPipelineActive = true;
      // Thread the SW's run id (or generate one) through every log line so the
      // side panel can tell re-entrancy (same run id twice) from two independent
      // pipelines (different run ids).
      _currentRunId = msg.runId || ('r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));

      try {
      const wd = msg.watchdog || {};
      const fail = (stage, detail, error) => {
        debugLog(stage, 'FAILED — ' + detail, false);
        return { ok: false, stage, error };
      };

      if (!isVideoTargetPage()) {
        debugLog('URL Verified', 'FAILED — not on video page', false);
        return { ok: false, stage: 'url', error: 'Not on ' + TARGET_URL_VIDEO };
      }
      debugLog('URL Verified', window.location.href.slice(0, 60));

      await waitForReadyState('interactive', 10000);
      const uploadReady = await waitForUploadInput(15000);
      if (!uploadReady) return fail('Upload Input', 'never appeared (SPA did not render)', 'Upload input never appeared (SPA did not render)');
      debugLog('Upload Input', 'detected');

      const bytes = msg.imageBase64 ? base64ToBytes(msg.imageBase64) : msg.imageBytes;
      const up = await uploadImage(bytes, msg.filename);
      if (_automationAborted) return { ok: false, stage: 'aborted', error: 'Aborted by Stop' };
      if (!up.ok) return fail('Image Uploaded', up.error, up.error);
      debugLog('Image Uploaded', up.filename + ' (' + up.bytes + ' bytes)');

      const beforeImgs = new Set(Array.from(document.querySelectorAll('img')).map(i => i.currentSrc || i.src).filter(Boolean));
      const preview = await waitForUploadPreview(beforeImgs);
      if (!preview.ok) return fail('Upload Verified', preview.error, preview.error);
      debugLog('Upload Verified', 'confirmed — ' + preview.src.slice(0, 60));

      // Model / duration / resolution / aspect ratio are FIXED SESSION SETTINGS:
      // the user configures the Vheer page manually before pressing Start. The
      // automation never opens, changes, or verifies them, and never fails
      // because of them.

      const fill = await fillPrompt(msg.prompt);
      if (_automationAborted) return { ok: false, stage: 'aborted', error: 'Aborted by Stop' };
      if (!fill.ok) return fail('Prompt Pasted', fill.error, fill.error);
      debugLog('Prompt Pasted', fill.chars + ' chars via ' + fill.method);

      const promptTa = findPromptTextarea();
      const promptVerified = !!promptTa && (promptTa.value || '').trim().length > 0;
      debugLog('Prompt Verified', promptVerified ? 'present (' + (promptTa && promptTa.value.length) + ' chars)' : 'NOT present', promptVerified);
      if (!promptVerified) return fail('Prompt Verified', 'prompt not present after filling', 'Prompt was not present after filling');

      const dlBefore = findVideoDownload();
      const genBtn = findGenerateButton();
      if (!genBtn) return fail('Generate Clicked', 'Generate button not found', 'Generate button not found');
      const clicked = await humanClick(genBtn);
      if (_automationAborted) return { ok: false, stage: 'aborted', error: 'Aborted by Stop' };
      if (!clicked.ok) return fail('Generate Clicked', clicked.error, clicked.error);
      debugLog('Generate Clicked', 'triggered');

      const started = await waitVideoGenerationStart(genBtn, wd);
      if (!started.ok) return started;
      debugLog('Generation Started', 'confirmed via ' + started.signal);

      const finished = await waitVideoGenerationFinish(wd, dlBefore);
      if (!finished.ok) return finished;
      debugLog('Generation Finished', 'download control ready');

      const dlBtn = findVideoDownload();
      if (!dlBtn) return fail('Download Started', 'download control vanished after generation', 'Download control not found after generation');
      const dlClicked = await humanClick(dlBtn);
      if (_automationAborted) return { ok: false, stage: 'aborted', error: 'Aborted by Stop' };
      if (!dlClicked.ok) return fail('Download Started', dlClicked.error, dlClicked.error);
      debugLog('Download Started', 'triggered — SW will intercept and verify the file');

      return {
        ok: true, verdict: 'complete', signal: 'download-ready', stage: 'download-triggered',
        shotNumber: msg.shotNumber,
        filename: msg.filename,
        uploadBytes: up.bytes,
        promptChars: fill.chars,
        promptVerified
      };
      } finally {
        _videoPipelineActive = false;
        _currentRunId = null;
      }
    }

    /** VIDEO: find Vheer's Delete button (shown on the completed-result state). */
    function findDeleteButton() {
      const patterns = /^delete\b|delete result|delete image|remove|clear result|clear|trash/i;
      for (const btn of document.querySelectorAll('button')) {
        if (!isVisible(btn)) continue;
        const text = (btn.textContent || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();
        const title = (btn.getAttribute('title') || '').trim();
        if (patterns.test(text) || patterns.test(aria) || patterns.test(title)) return btn;
      }
      return null;
    }

    /**
     * VIDEO: wait until Vheer is ready to accept the next image.  Readiness = a
     * usable file input exists (reacquired fresh from the DOM each tick).  The
     * raw <input type="file"> is deliberately HIDDEN by Vheer's UI — the user
     * clicks a visible dropzone/label that drives it.  Visibility of the input
     * is NOT a readiness condition; programmatic upload works on a hidden input.
     */
    function waitForFreshUploadState(timeoutMs = 30000) {
      return new Promise((resolve) => {
        const start = Date.now();
        const poll = () => {
          if (_automationAborted) { resolve({ ok: false, error: 'Aborted by Stop' }); return; }
          // Re-query the DOM every tick — Vheer's React may replace elements.
          const upload = findUploadInput();
          const usable = !!upload && !upload.disabled;
          if (usable) {
            resolve({ ok: true });
            return;
          }
          if (Date.now() - start > timeoutMs) {
            resolve({ ok: false, error: 'Upload control not detected after ' + Math.round(timeoutMs / 1000) + 's' });
            return;
          }
          setTimeout(poll, 500);
        };
        poll();
      });
    }

    /**
     * POST_DOWNLOAD_CLEANUP: after the SW confirms the MP4 download is complete,
     * click Vheer's Delete button ONCE and wait for the upload control to
     * re-appear.  Returns { ok:true } once the page is ready for the next upload.
     */
    async function performPostDownloadCleanup(msg) {
      const shotNumber = msg.shotNumber;

      if (_cleanupInProgress) {
        debugLog('Cleanup', 'SHOT ' + shotNumber + ' — already in progress, skipping', false);
        return { ok: false, stage: 'busy', error: 'Cleanup already in progress' };
      }
      _cleanupInProgress = true;

      try {
        const del = findDeleteButton();
        if (!del) {
          debugLog('Cleanup', 'SHOT ' + shotNumber + ' — no Delete button, checking if upload control exists');
          const fresh = await waitForFreshUploadState(15000);
          if (fresh.ok) {
            debugLog('Cleanup COMPLETE', 'SHOT ' + shotNumber + ' — upload control usable (no Delete needed)');
            return { ok: true, deleted: false };
          }
          debugLog('Cleanup', 'Delete button not found and upload control not detected', false);
          return { ok: false, stage: 'delete', error: 'Delete button not found and upload control not detected' };
        }

        debugLog('Cleanup', 'SHOT ' + shotNumber + ' — clicking Delete once');
        const clicked = await humanClick(del);
        if (_automationAborted) return { ok: false, stage: 'aborted', error: 'Aborted by Stop' };
        if (!clicked.ok) return { ok: false, stage: 'delete', error: 'Delete click failed: ' + clicked.error };
        debugLog('Cleanup', 'SHOT ' + shotNumber + ' — Delete clicked, waiting for upload control');

        const fresh = await waitForFreshUploadState(30000);
        if (!fresh.ok) {
          // Report the ACTUAL page state so the failure is diagnosable.
          const u = findUploadInput();
          const dropzone = Array.from(document.querySelectorAll('button, [role="button"], label, [class*="drop" i], [class*="upload" i]'))
            .find(el => isVisible(el));
          const dl = findVideoDownload();
          const delBtn = findDeleteButton();
          const reason = !u ? 'no file input in DOM'
            : u.disabled ? 'file input present but disabled'
            : 'file input present but associated upload control missing'
            + (dl ? ' / result Download control still visible' : '')
            + (delBtn ? ' / result Delete control still visible' : '')
            + (dropzone ? ' / visible dropzone: ' + (dropzone.textContent || dropzone.tagName).trim().slice(0, 40) : ' / no visible dropzone found');
          debugLog('Cleanup', 'upload control check: ' + reason, false);
          return { ok: false, stage: 'reset', error: 'Upload control not usable: ' + reason };
        }
        debugLog('Cleanup COMPLETE', 'SHOT ' + shotNumber + ' — upload control detected and usable');
        return { ok: true, deleted: true };
      } finally {
        _cleanupInProgress = false;
      }
    }

    /**
     * Dump the Image→Video automation controls (upload / generate / download +
     * all visible buttons) so the real page's DOM can be calibrated. Model,
     * duration, resolution and aspect ratio are intentionally NOT inspected —
     * they are fixed session settings the user configures manually.
     */
    function inspectVideoControls() {
      return {
        url: window.location.href.slice(0, 120),
        uploadInput: !!findUploadInput(),
        generateButton: !!findGenerateButton(),
        downloadControl: !!findVideoDownload(),
        buttons: Array.from(document.querySelectorAll('button')).filter(isVisible).slice(0, 40).map(b => (b.textContent || '').trim().slice(0, 40)).filter(Boolean)
      };
    }

    // =========================================================================
    //  RUN_SHOT — the automation flow.
    // =========================================================================

    async function runShot(msg) {
      debugLog('Connected to Vheer', window.location.href.slice(0, 60));
      _automationAborted = false; // fresh shot → fresh abort state

      if (!isTargetPage() || isVideoTargetPage()) {
        debugLog('URL Verified', 'FAILED — not on text-to-image page', false);
        return { ok: false, error: 'Not on ' + TARGET_URL };
      }
      debugLog('URL Verified', window.location.href.slice(0, 60));

      // Watchdog config from service worker (with safe defaults if absent).
      const wd = msg.watchdog || {};
      const watchdogCfg = {
        maxStallMs:      (wd.maxStallSec  || 90)  * 1000,
        maxGenMs:        (wd.maxGenSec    || 600) * 1000,
        pollIntervalMs:  wd.pollIntervalMs || 2000,
        recoveryDelayMs: (wd.recoveryDelaySec || 5) * 1000,
        maxRetries:      wd.maxRetries || 3,
        shotNumber:      msg.shotNumber
      };

      // Wait for the SPA to render the prompt textarea.
      await waitForReadyState('interactive', 10000);
      const rendered = await waitForPrompt(20000);
      if (!rendered) {
        debugLog('Prompt Found', 'FAILED — textarea never appeared', false);
        const candidates = promptCandidates();
        debugLog('Prompt Candidates', candidates.length + ' candidate elements', false);
        return { ok: false, error: 'Prompt textarea never appeared (SPA did not render)', candidates };
      }
      debugLog('Prompt Found', 'textarea detected');

      // Fill prompt.
      const fill = await fillPrompt(msg.masterPrompt);
      if (_automationAborted) return { ok: false, error: 'Aborted by Stop' };
      if (!fill.ok) {
        debugLog('Prompt Filled', 'FAILED — ' + fill.error, false);
        return fill;
      }
      debugLog('Prompt Filled', fill.chars + ' chars via ' + fill.method);

      // Find generate button.
      const gen = findGenerateButton();
      if (!gen) {
        debugLog('Generate Button Found', 'FAILED — no button', false);
        return { ok: false, error: 'Generate button not found' };
      }
      debugLog('Generate Button Found', '"' + (gen.textContent || '').trim().slice(0, 30) + '"');

      // Click generate, with a snapshot of existing images.
      const beforeSrcs = snapshotImageSrcs();
      const click = await clickGenerate();
      if (_automationAborted) return { ok: false, error: 'Aborted by Stop' };
      if (!click.ok) {
        debugLog('Generate Clicked', 'FAILED — ' + click.error, false);
        return click;
      }
      debugLog('Generate Clicked', 'watchdog active — monitoring generation…');

      // Smart Watchdog wait: monitors liveness + completion, handles recoveries,
      // and returns a verdict the service worker acts on.
      const genResult = await waitForGeneration(beforeSrcs, watchdogCfg);
      if (!genResult.ok) {
        debugLog('Image Detected', 'FAILED — ' + (genResult.error || genResult.verdict || 'unknown'), false);
        return genResult;
      }
      debugLog('Image Detected', genResult.signal + (genResult.src ? ' ' + genResult.src.slice(0, 60) : ''));

      // Click Download (best-effort).  The SW's onDeterminingFilename / onChanged
      // handles rename + verifyDownload; this is fire-and-forget from the CS side.
      const dl = await clickDownload();
      if (!dl.ok) {
        debugLog('Download Button Found', 'NOT FOUND — skipping auto-download', false);
        return {
          ok: true, verdict: 'complete', stage: 'generation-complete',
          shotNumber: msg.shotNumber, signal: genResult.signal,
          recovery: genResult.recovery, downloadSkipped: true
        };
      }
      debugLog('Download Button Found', 'clicked');
      debugLog('Download Started', 'waiting for file save…');

      return {
        ok: true, verdict: 'complete', stage: 'download-triggered',
        shotNumber: msg.shotNumber, signal: genResult.signal,
        recovery: genResult.recovery
      };
    }

    // =========================================================================
    //  Message handler
    // =========================================================================

    function onRuntimeMessage(msg, sender, sendResponse) {
      console.log(TAG, 'HANDLER:', msg.type);

      if (msg.type === 'CHECK_READY') {
        // The page is an SPA: wait for the KEY control to render before
        // reporting — the prompt textarea on Text→Image, the upload input on
        // Image→Video. The content script detects the route itself, so the SW
        // doesn't need to tell it which mode it's in.
        const isVideoPage = isVideoTargetPage();
        const waitForKey = isVideoPage ? waitForUploadInput(12000) : waitForPrompt(12000);
        waitForKey.then((keyFound) => {
          const pageOk = isTargetPage();
          if (!pageOk) {
            // INSTRUMENTATION (debug): dump every comparison so we can see
            // exactly why validation failed. No logic change.
            const d = diagnoseUrl(window.location.href);
            console.log(TAG, '[URL-DIAG]', JSON.stringify(d, null, 2));
            debugLog('URL-DIAG', 'failedStep=' + d.failedStep + ' hostname="' + d.hostname + '" path="' + d.pathname + '" json=' + d.jsonStringify, false);
            chrome.runtime.sendMessage({ type: 'URL_DIAG', diag: d }).catch(() => {});
          }
          if (pageOk) debugLog('Page Detected', window.location.href.slice(0, 60));
          else debugLog('Page Detected', 'FAILED — not on target page', false);

          const domReady = document.readyState === 'complete' || document.readyState === 'interactive';
          debugLog('DOM Ready', document.readyState, domReady);

          const promptFound = isVideoPage ? !!findPromptTextarea() : keyFound;
          const uploadFound = isVideoPage ? keyFound : false;
          if (isVideoPage) debugLog('Upload Input', uploadFound ? 'detected' : 'NOT detected — dumping elements', uploadFound);
          else if (promptFound) debugLog('Prompt Found', 'textarea detected');
          else debugLog('Prompt Found', 'NOT detected — dumping elements', false);

          sendResponse({
            ok: pageOk,
            mode: isVideoPage ? 'video' : 'image',
            frame: { isTop: _isTop, href: window.location.href, origin: window.location.origin, title: document.title },
            // INSTRUMENTATION: full URL diagnostic attached to the response.
            urlDiag: diagnoseUrl(window.location.href),
            info: {
              url: window.location.href,
              targetPage: pageOk,
              promptFound,
              uploadFound,
              generateFound: !!findGenerateButton(),
              // Full element dump so the SW / side panel can see the real DOM
              // when the key control isn't detected.
              elements: inspectDocument(document, 'main-document')
            }
          });
        });
        return true;
      }

      if (msg.type === 'INSPECT_PAGE') {
        const info = inspectPage();
        if (isVideoTargetPage()) {
          info.videoControls = inspectVideoControls();
          debugLog('Video Controls', 'upload=' + info.videoControls.uploadInput + ' | generate=' + info.videoControls.generateButton + ' | download=' + info.videoControls.downloadControl);
        }
        sendResponse({ ok: true, frame: { href: window.location.href }, info });
        return false;
      }

      if (msg.type === 'TEST_FILL') {
        waitForPrompt(12000).then(async (found) => {
          if (!found) {
            sendResponse({ ok: false, error: 'Prompt textarea not found', candidates: promptCandidates() });
            return;
          }
          const r = await fillPrompt(msg.text || 'TEST FROM AI STORY STUDIO');
          debugLog('Prompt Filled (test)', r.ok ? r.chars + ' chars' : r.error, r.ok);
          sendResponse(r);
        });
        return true;
      }

      if (msg.type === 'TEST_GENERATE') {
        clickGenerate()
          .then(r => { debugLog('Generate Clicked (test)', r.ok ? 'ok' : r.error, r.ok); sendResponse(r); })
          .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
      }

      if (msg.type === 'RUN_SHOT') {
        runShot(msg)
          .then(sendResponse)
          .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
      }

      if (msg.type === 'RUN_VIDEO_STEP') {
        runVideoStep(msg)
          .then(sendResponse)
          .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
      }

      if (msg.type === 'POST_DOWNLOAD_CLEANUP') {
        performPostDownloadCleanup(msg)
          .then(sendResponse)
          .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
      }

      if (msg.type === 'STOP_AUTOMATION') {
        _automationAborted = true;
        debugLog('Stop Received', 'aborting in-flight automation');
        sendResponse({ ok: true });
        return false;
      }

      return false;
    }

    // =========================================================================
    //  Attach + announce
    // =========================================================================

    handleMessage._fullHandler = onRuntimeMessage;
    console.log(TAG, 'Full handler attached');

    debugLog('Content script ready', window.location.pathname);

    if (isTargetPage()) {
      debugLog('URL Verified', window.location.href.slice(0, 60));
      chrome.runtime.sendMessage({
        type: 'CONTENT_READY', url: window.location.href, adapter: 'vheer'
      }).catch(() => {});
    }

  }

  // Signal successful, complete initialization. The SW probes this after an
  // executeScript injection to detect a silent top-level crash.
  window.__vheerContentScriptActive = true;
  window.__vheerStoryLoaded = true;
  window.__vheerStoryVersion = VERSION;

  } catch (err) {
    console.error('[Vheer-Story] FATAL: content script crashed on load:', err);
    console.error('[Vheer-Story] STACK:', err && err.stack);
    try { window.__vheerStoryError = String((err && err.stack) || err); } catch (e2) {}
    try {
      chrome.runtime.sendMessage({
        type: 'CS_CRASH',
        error: String((err && err.message) || err),
        stack: String((err && err.stack) || '')
      }).catch(() => {});
    } catch (e3) {}
  }
})();
