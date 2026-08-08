/**
 * Prompt file parser — pure browser JS, no dependencies.
 *
 * Parses ALL-MASTER-PROMPTS.md into structured shot objects.
 * Same logic as the Node.js promptReader.ts, but runs in the browser.
 *
 * Format:
 *   SHOT 001
 *   MASTER PROMPT
 *   ...prompt lines...
 *   NEGATIVE PROMPT
 *   ...negative lines...
 *   SHOT 002
 *   ...
 */

const SHOT_HEADER = /^SHOT\s+(\d+)\s*$/im;
const SECTION_HEADER = /^\s*(MASTER\s+PROMPT|NEGATIVE\s+PROMPT)\s*:?\s*(.*)$/i;

/**
 * Parse a single shot body (text between two SHOT headers).
 * Returns { master, negative } with trimmed content.
 */
function parseShotBody(body) {
  const master = [];
  const negative = [];
  let mode = 'none'; // none | master | negative

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const header = SECTION_HEADER.exec(line);
    if (header) {
      const section = header[1].toUpperCase();
      mode = section === 'MASTER PROMPT' ? 'master' : 'negative';
      // Inline content after header: "NEGATIVE PROMPT: blurry, noise"
      if (header[2]) {
        (mode === 'master' ? master : negative).push(header[2].trim());
      }
      continue;
    }

    if (mode === 'master') master.push(line);
    else if (mode === 'negative') negative.push(line);
  }

  return {
    master: master.join('\n').trim(),
    negative: negative.join('\n').trim()
  };
}

/**
 * Parse the full prompt file content.
 * Returns { shots: Shot[], warnings: string[] }.
 *
 * Each shot: { number, masterPrompt, negativePrompt, status: 'waiting', retryCount: 0 }
 */
function parsePromptFile(content) {
  const shots = [];
  const warnings = [];

  // Split on SHOT headers, keeping captured number.
  // Result: [preamble, "001", body1, "002", body2, ...]
  const tokens = content.split(/^SHOT\s+(\d+)\s*$/im);

  for (let i = 1; i < tokens.length; i += 2) {
    const number = parseInt(tokens[i], 10);
    const body = (tokens[i + 1] || '').trim();

    if (!body) {
      warnings.push(`SHOT ${number}: block is empty, skipping.`);
      continue;
    }

    const { master, negative } = parseShotBody(body);
    if (!master) {
      warnings.push(`SHOT ${number}: no MASTER PROMPT section found.`);
    }

    shots.push({
      number,
      masterPrompt: master,
      negativePrompt: negative,
      status: 'waiting',
      retryCount: 0
    });
  }

  shots.sort((a, b) => a.number - b.number);
  return { shots, warnings };
}

/** Section header inside a video SHOT block. Captures label + optional inline tail. */
const VIDEO_SECTION_HEADER = /^\s*(IMAGE|VIDEO\s+PROMPT|NEGATIVE\s+PROMPT|DURATION|MOTION\s+LEVEL)\s*:?\s*(.*)$/i;
/** Horizontal-rule separator lines between SHOT blocks (`------`). */
const VIDEO_SEPARATOR = /^\s*-{2,}\s*$/;

/**
 * Parse one video SHOT block into its sections:
 *   { image, prompt, negativePrompt, duration, motionLevel }
 *
 * Values may span multiple lines (the prompt/negative paragraphs). Any content
 * before the first section header is treated as a plain prompt (backward
 * compatible with the simple `SHOT001\nPrompt…` format). Separator lines,
 * blank lines, and CRLF are handled.
 */
function parseVideoShotBody(body) {
  const out = { image: '', prompt: '', negativePrompt: '', duration: '', motionLevel: '' };
  let section = null; // current section key ('' = none seen yet)
  const pending = [];
  let sawSectionHeader = false;

  const flush = () => {
    if (section) out[section] = pending.join('\n').trim();
    pending.length = 0;
  };

  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (VIDEO_SEPARATOR.test(line)) { flush(); section = null; continue; }

    const m = line.match(VIDEO_SECTION_HEADER);
    if (m) {
      sawSectionHeader = true;
      flush();
      const key = m[1].toLowerCase().replace(/\s+/g, '');
      section = key === 'videoprompt' ? 'prompt' : key === 'negativeprompt' ? 'negativePrompt' : key === 'motionlevel' ? 'motionLevel' : key;
      if (m[2] && m[2].trim()) pending.push(m[2].trim());
      continue;
    }

    if (line.trim() || section) pending.push(line);
  }
  flush();

  // No section headers at all → the whole body is a plain video prompt.
  if (!sawSectionHeader) {
    const plain = String(body || '').replace(/^\s*[\r\n]+|[\r\n]+$/g, '').trim();
    if (plain) { out.prompt = plain; out.image = ''; }
  }
  return out;
}

/**
 * Parse a VIDEO_PROMPTS.md file into structured video-shot objects.
 *
 * Production format (one block per shot, `------` separators optional):
 *   SHOT001
 *   IMAGE
 *   SHOT001.png
 *   VIDEO PROMPT
 *   <multi-line video prompt>
 *   NEGATIVE PROMPT
 *   <multi-line negative prompt>
 *   DURATION
 *   8s
 *   MOTION LEVEL
 *   STATIC
 *
 * Accepts both `SHOT001` and `SHOT 001`. Returns { shots, warnings } where
 * each shot is
 *   { number, image, prompt, negativePrompt, duration, motionLevel,
 *     status: 'waiting', retryCount: 0 }.
 */
function parseVideoPromptFile(content) {
  const shots = [];
  const warnings = [];

  // Split on SHOT headers, keeping captured number.
  // Result: [preamble, "001", body1, "002", body2, ...]
  const tokens = String(content || '').split(/^SHOT\s*(\d+)\s*$/im);

  for (let i = 1; i < tokens.length; i += 2) {
    const number = parseInt(tokens[i], 10);
    const body = (tokens[i + 1] || '').trim();

    if (!body) {
      warnings.push(`SHOT ${number}: block is empty, skipping.`);
      continue;
    }

    const parts = parseVideoShotBody(body);
    const prompt = parts.prompt.trim();
    if (!prompt) {
      warnings.push(`SHOT ${number}: no VIDEO PROMPT section found.`);
    }

    shots.push({
      number,
      image: parts.image.trim(),
      prompt,
      negativePrompt: parts.negativePrompt.trim(),
      duration: parts.duration.trim(),
      motionLevel: parts.motionLevel.trim(),
      status: 'waiting',
      retryCount: 0
    });
  }

  shots.sort((a, b) => a.number - b.number);
  return { shots, warnings };
}

// Export for service worker (importScripts) and content scripts.
if (typeof globalThis !== 'undefined') {
  globalThis.parsePromptFile = parsePromptFile;
  globalThis.parseVideoPromptFile = parseVideoPromptFile;
}
