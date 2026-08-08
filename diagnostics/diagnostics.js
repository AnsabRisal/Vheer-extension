/**
 * Vheer Story Studio — Diagnostics Page
 *
 * Reports the simplified injection chain:
 *   1. Can we reach the service worker?
 *   2. Is a Vheer tab open (for the selected mode)?
 *   3. Is the content script alive?
 *   4. Does the URL match the target page?
 *   5. Is the key control detected (prompt textarea / upload input)?
 *
 * The generation mode comes from the ?mode= query param (set by the side panel).
 */

const $ = (sel) => document.querySelector(sel);
const logEl = $('#log');
const resultsEl = $('#results');
const mode = new URLSearchParams(location.search).get('mode') === 'video' ? 'video' : 'image';

function log(text, cls) {
  const span = document.createElement('span');
  span.className = cls || '';
  span.textContent = text + '\n';
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}

function addRow(label, status, detail) {
  const cls = status === 'ok' ? 'ok' : status === 'fail' ? 'fail' : status === 'wait' ? 'wait' : 'info';
  const badgeCls = status === 'ok' ? 'ok' : status === 'fail' ? 'fail' : 'wait';
  const row = document.createElement('div');
  row.className = 'row ' + cls;
  row.innerHTML = `<span class="badge ${badgeCls}">${status === 'ok' ? '✓' : status === 'fail' ? '✗' : '…'}</span>` +
    `<span class="label">${label}</span>` +
    (detail ? `<span class="detail">${detail}</span>` : '');
  resultsEl.appendChild(row);
}

function send(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, r => resolve(r || { ok: false, error: 'No response from SW' }));
  });
}

async function runDiagnostics() {
  resultsEl.innerHTML = '';
  logEl.innerHTML = '';
  const btn = $('#btn-run');
  btn.disabled = true;
  btn.textContent = 'Running…';

  try {
    addRow('Service Worker', 'wait', 'PING…');
    log('1. Sending TEST_CONNECTION to service worker…', 'warn');
    const r = await send({ type: 'TEST_CONNECTION', mode }).catch(e => ({ ok: false, error: e.message }));
    log('   SW response: ' + JSON.stringify(r).slice(0, 300));
    resultsEl.lastChild.remove();

    if (!r || (!r.ok && r.error === 'No response from SW')) {
      addRow('Service Worker', 'fail', 'Cannot reach SW — is the extension loaded?');
      log('   FAIL: Service worker is not responding.', 'err');
      btn.disabled = false;
      btn.textContent = 'Run Diagnostics';
      return;
    }
    addRow('Service Worker', 'ok', 'Responsive');
    log('   OK: Service worker is alive.', 'ok');

    // Tab + URL
    if (r.step === 'tab') {
      addRow('Vheer Tab', 'fail', r.error);
      log('   FAIL: No Vheer tab found.', 'err');
    } else {
      addRow('Vheer Tab', 'ok', (r.tabUrl || '').slice(0, 70));
      log('   OK: Vheer tab found.', 'ok');
    }

    if (r.step === 'script') {
      addRow('Content Script', 'fail', r.error || 'unreachable');
      log('   FAIL: Content script not responding (injection failed).', 'err');
    } else if (r.step === 'messaging') {
      addRow('Content Script', 'fail', r.error);
      log('   FAIL: Messaging error: ' + (r.error || ''), 'err');
    } else if (r.step === 'no-response') {
      addRow('Content Script', 'fail', r.error);
      log('   FAIL: No response to CHECK_READY — refresh the Vheer tab and retry.', 'err');
    } else if (r.step === 'content-script-not-ready') {
      addRow('Content Script', 'fail', r.error);
      log('   FAIL: Content script reported not ready.', 'err');
    } else if (r.step === 'url') {
      addRow('URL Verified', 'fail', (r.info && r.info.url || '').slice(0, 70));
      log('   FAIL: URL does not match target page.', 'err');
    } else if (r.ok) {
      addRow('Content Script', 'ok', 'Alive');
      log('   OK: Content script is alive.', 'ok');
      addRow('URL Verified', 'ok', (r.info && r.info.url || '').slice(0, 70));
      log('   OK: URL matches target page.', 'ok');

      if (mode === 'video') {
        if (r.uploadFound) {
          addRow('Upload Input', 'ok', 'Detected');
          log('   OK: Upload input found.', 'ok');
        } else {
          addRow('Upload Input', 'fail', 'Not found');
          log('   FAIL: No upload input detected.', 'err');
        }
      } else if (r.promptFound) {
        addRow('Prompt Textarea', 'ok', 'Detected');
        log('   OK: Prompt textarea found.', 'ok');
      } else {
        addRow('Prompt Textarea', 'fail', 'Not found');
        log('   FAIL: No prompt textarea detected.', 'err');
      }

      addRow('Generate Button', r.generatorDetected ? 'ok' : 'fail',
        r.generatorDetected ? 'Found' : 'Not found');
      log('   Generate button: ' + (r.generatorDetected ? 'found' : 'NOT found'),
        r.generatorDetected ? 'ok' : 'err');
    } else {
      addRow('Connection', 'fail', r.error || 'Unknown error');
      log('   FAIL: ' + (r.error || 'Unknown'), 'err');
    }

    if (r.ok) {
      addRow('Connection', 'ok', 'CONNECTED');
      log('\nFinal: CONNECTED ✓', 'ok');
    } else {
      addRow('Connection', 'fail', r.error || 'Not connected');
      log('\nFinal: NOT CONNECTED ✗', 'err');
    }

  } catch (err) {
    addRow('Error', 'fail', err.message);
    log('FATAL: ' + err.message + '\n' + err.stack, 'err');
  }

  btn.disabled = false;
  btn.textContent = 'Run Diagnostics';
}

// Auto-run on load.
runDiagnostics();
