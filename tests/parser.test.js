'use strict';
const assert = require('assert');
const {
  parseUniversalPromptSession,
  parseOrdinalPromptSession,
  parsePromptFile,
  parseVideoPromptFile
} = require('../lib/parser.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const S = '----------------------------------';
const S_SHORT = '-----------------';
const SEP = '-----------------------------';   // 29 hyphens — ordinal-file style

const block = (id, prompt) => `${S}\n${id}\n${S}\n${prompt}\n${S}`;
const blockShort = (id, prompt) => `${S_SHORT}\n${id}\n${S_SHORT}\n${prompt}\n${S_SHORT}`;

function session(...blocks) { return blocks.join('\n\n'); }

// Build an ordinal-format session from an array of { ordinal, prompt } pairs.
function ordinalSession(entries) {
  const lines = [];
  for (const e of entries) {
    lines.push(SEP);
    lines.push(`${e.ordinal} ${e.prompt}`);
  }
  lines.push(SEP);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ── UNIVERSAL NUMBERED SESSION (existing) ───────────────────────────────────
// ---------------------------------------------------------------------------

// Single job.
{
  const r = parseUniversalPromptSession(session(block(1, 'Prompt one')));
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.jobs.length, 1);
  assert.strictEqual(r.jobs[0].id, '1');
  assert.strictEqual(r.jobs[0].prompt, 'Prompt one');
}

// Variable-width separators (29 and 24 hyphens).
{
  const r = parseUniversalPromptSession(
    '-----------------------------\n1\nPrompt one\n------------------------\n\n' +
    '-----------------------------\n2\nPrompt two contains 2026 and hyphen-text\n------------------------'
  );
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.jobs.map(j => j.number), [1, 2]);
  assert.deepStrictEqual(r.jobs.map(j => j.prompt), [
    'Prompt one',
    'Prompt two contains 2026 and hyphen-text'
  ]);
}

// Short separator (17 hyphens).
{
  const r = parseUniversalPromptSession(
    '-----------------\n1\n-----------------\nFirst prompt\n-----------------\n\n' +
    '-----------------\n2\n-----------------\nSecond prompt\n-----------------'
  );
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.jobs.length, 2);
  assert.strictEqual(r.jobs[0].prompt, 'First prompt');
  assert.strictEqual(r.jobs[1].prompt, 'Second prompt');
}

// Compact form: separator → ID → prompt → separator (no separator between ID and prompt).
{
  const r = parseUniversalPromptSession(
    '-----------------\n1\nCompact prompt one\n-----------------\n\n' +
    '-----------------\n2\nCompact prompt two\n-----------------'
  );
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.jobs[0].prompt, 'Compact prompt one');
  assert.strictEqual(r.jobs[1].prompt, 'Compact prompt two');
}

// Inline hyphens in prompt text must NOT split the block.
{
  const r = parseUniversalPromptSession(
    blockShort(1, 'A cel-shaded 2D frame. Year 1942-1945. Low-key lighting.')
  );
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.jobs.length, 1);
  assert.strictEqual(r.jobs[0].prompt, 'A cel-shaded 2D frame. Year 1942-1945. Low-key lighting.');
}

// 105-job batch.
{
  const prompts = Array.from({ length: 105 }, (_, i) => block(i + 1, `Prompt ${i + 1}`));
  const r = parseUniversalPromptSession(prompts.join('\n\n'));
  assert.strictEqual(r.jobs.length, 105);
  assert.deepStrictEqual(r.jobs.slice(0, 3).map(j => j.number), [1, 2, 3]);
}

// Non-consecutive IDs generate warnings.
{
  const r = parseUniversalPromptSession(session(
    block(1, 'Line one\nLine two\nContains 42, hyphen-text, and **Markdown**.'),
    block(4, 'Prompt 4')
  ));
  assert.deepStrictEqual(r.jobs.map(j => j.number), [1, 4]);
  assert.strictEqual(r.jobs[0].prompt, 'Line one\nLine two\nContains 42, hyphen-text, and **Markdown**.');
  assert(r.warnings.includes('Missing job ID 2'));
  assert(r.warnings.includes('Missing job ID 3'));
}

// Universal adapter: image uses masterPrompt, video uses prompt.
{
  const image = parsePromptFile(session(block(1, 'IMAGE ONLY')));
  const video = parseVideoPromptFile(session(block(2, 'VIDEO ONLY')));
  assert.strictEqual(image.shots[0].masterPrompt, 'IMAGE ONLY');
  assert.strictEqual(video.shots[0].prompt, 'VIDEO ONLY');
  assert.strictEqual(image.shots[0].id, '1');
  assert.strictEqual(video.shots[0].id, '2');
}

// Universal invalid inputs.
for (const [label, input, expected] of [
  ['duplicate IDs', session(block(1, 'A'), block(1, 'B')), 'Duplicate job ID 1'],
  ['non-numeric ID', session(block('ABC', 'Prompt')), 'Invalid job ID'],
  ['empty prompt', session(block(1, '   ')), 'missing prompt content'],
  ['missing closing delimiter', `${S}\n1\n${S}\nPrompt`, 'missing closing delimiter'],
  ['missing ID', `${S}\n${S}\nPrompt\n${S}`, 'Invalid job ID'],
  ['malformed delimiter', `================\n1\n${S}\nPrompt\n${S}`, 'invalid separator']
]) {
  const r = parseUniversalPromptSession(input);
  assert(
    r.errors.some(e => e.toLowerCase().includes(expected.toLowerCase())),
    `universal: "${label}" was not rejected — errors: ${JSON.stringify(r.errors)}`
  );
}

// Legacy SHOT format still works (backward compatibility).
{
  const r = parsePromptFile('SHOT 001\nMASTER PROMPT\nLegacy prompt');
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.shots[0].masterPrompt, 'Legacy prompt');
}

// ---------------------------------------------------------------------------
// ── ORDINAL IMAGE-PROMPT FORMAT ─────────────────────────────────────────────
// ---------------------------------------------------------------------------

// ── Task-specified exact test case ──────────────────────────────────────────
{
  const input =
    '-----------------------------\n' +
    '1st Create a clean illustrated image of a red apple sitting on a wooden table.\n' +
    '-----------------------------\n' +
    '2nd Create a clean illustrated image of a blue cup sitting beside an open book.\n' +
    '-----------------------------\n' +
    '3rd Create a clean illustrated image of a green plant beside a sunny window.\n' +
    '-----------------------------';

  const r = parseOrdinalPromptSession(input);
  assert.deepStrictEqual(r.errors, [], `task test case errors: ${JSON.stringify(r.errors)}`);
  assert.strictEqual(r.jobs.length, 3);

  assert.strictEqual(r.jobs[0].id,     '1');
  assert.strictEqual(r.jobs[0].number, 1);
  assert.strictEqual(r.jobs[0].prompt, 'Create a clean illustrated image of a red apple sitting on a wooden table.');

  assert.strictEqual(r.jobs[1].id,     '2');
  assert.strictEqual(r.jobs[1].number, 2);
  assert.strictEqual(r.jobs[1].prompt, 'Create a clean illustrated image of a blue cup sitting beside an open book.');

  assert.strictEqual(r.jobs[2].id,     '3');
  assert.strictEqual(r.jobs[2].number, 3);
  assert.strictEqual(r.jobs[2].prompt, 'Create a clean illustrated image of a green plant beside a sunny window.');

  // Provider must never receive the ordinal prefix or a separator.
  for (const job of r.jobs) {
    assert(!job.prompt.match(/^\d+(?:st|nd|rd|th)\b/), `ordinal leaked into prompt: ${job.prompt}`);
    assert(!job.prompt.includes('---'), `separator leaked into prompt: ${job.prompt}`);
  }
}

// ── All required ordinal forms ───────────────────────────────────────────────
{
  const cases = [
    { ordinal: '1st',   id: 1   },
    { ordinal: '2nd',   id: 2   },
    { ordinal: '3rd',   id: 3   },
    { ordinal: '4th',   id: 4   },
    { ordinal: '5th',   id: 5   },
    { ordinal: '10th',  id: 10  },
    { ordinal: '11th',  id: 11  },
    { ordinal: '12th',  id: 12  },
    { ordinal: '13th',  id: 13  },
    { ordinal: '21st',  id: 21  },
    { ordinal: '22nd',  id: 22  },
    { ordinal: '23rd',  id: 23  },
    { ordinal: '24th',  id: 24  },
    { ordinal: '100th', id: 100 }
  ];
  const input = ordinalSession(cases.map(c => ({ ordinal: c.ordinal, prompt: `Prompt for ${c.ordinal}` })));
  const r = parseOrdinalPromptSession(input);
  assert.deepStrictEqual(r.errors, [], `ordinal forms errors: ${JSON.stringify(r.errors)}`);
  assert.strictEqual(r.jobs.length, cases.length);
  for (let k = 0; k < cases.length; k++) {
    assert.strictEqual(r.jobs[k].number, cases[k].id,   `id mismatch at index ${k}`);
    assert.strictEqual(r.jobs[k].prompt, `Prompt for ${cases[k].ordinal}`, `prompt mismatch at index ${k}`);
  }
}

// ── Source order is preserved ────────────────────────────────────────────────
{
  const r = parseOrdinalPromptSession(
    ordinalSession([
      { ordinal: '1st', prompt: 'First' },
      { ordinal: '2nd', prompt: 'Second' },
      { ordinal: '3rd', prompt: 'Third' }
    ])
  );
  assert.deepStrictEqual(r.jobs.map(j => j.sourceOrder), [0, 1, 2]);
}

// ── Long prompt — no truncation ──────────────────────────────────────────────
{
  const longPrompt =
    'A 76-year-old clockmaker named Ansel Whitlow, long weathered face with deep precision ' +
    'lines, warm parchment skin, pale blue-grey eyes, white arched eyebrows, 2D illustrated ' +
    'cel-shaded Storytime YouTube Animation style, 16:9 cinematic widescreen, high detail, ' +
    'professional animation production quality, 4K, sharp focus, clean edges.';
  const r = parseOrdinalPromptSession(
    ordinalSession([{ ordinal: '1st', prompt: longPrompt }])
  );
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.jobs[0].prompt, longPrompt);
}

// ── Numbers inside prompts do NOT become IDs ─────────────────────────────────
{
  const r = parseOrdinalPromptSession(
    ordinalSession([
      { ordinal: '1st', prompt: 'Shot 42, year 1942, frame 3 of 16, 4K quality.' },
      { ordinal: '2nd', prompt: 'Scene 99 with 2 characters on a 16:9 frame.' }
    ])
  );
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.jobs.length, 2);
  assert.strictEqual(r.jobs[0].prompt, 'Shot 42, year 1942, frame 3 of 16, 4K quality.');
  assert.strictEqual(r.jobs[1].prompt, 'Scene 99 with 2 characters on a 16:9 frame.');
}

// ── Inline hyphens in prompts do NOT become separators ───────────────────────
{
  const r = parseOrdinalPromptSession(
    ordinalSession([
      { ordinal: '1st', prompt: '2D cel-shaded, high-quality, low-key lighting, 1942-1945 era.' },
      { ordinal: '2nd', prompt: 'Warm amber-tinted, water-coloured illustrated background.' }
    ])
  );
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.jobs.length, 2);
  assert(r.jobs[0].prompt.includes('cel-shaded'));
  assert(r.jobs[0].prompt.includes('1942-1945'));
  assert(r.jobs[1].prompt.includes('amber-tinted'));
}

// ── parsePromptFile routes ordinal files to masterPrompt ─────────────────────
{
  const r = parsePromptFile(
    ordinalSession([
      { ordinal: '1st', prompt: 'A cinematic illustrated scene.' },
      { ordinal: '2nd', prompt: 'A close-up of weathered hands.' }
    ])
  );
  assert.deepStrictEqual(r.errors, [], `routing errors: ${JSON.stringify(r.errors)}`);
  assert.strictEqual(r.shots.length, 2);
  assert.strictEqual(r.shots[0].masterPrompt, 'A cinematic illustrated scene.');
  assert.strictEqual(r.shots[1].masterPrompt, 'A close-up of weathered hands.');
  assert.strictEqual(r.shots[0].negativePrompt, '');
  assert.strictEqual(r.shots[0].id, '1');
  assert.strictEqual(r.shots[1].id, '2');
}

// ── parseVideoPromptFile routes ordinal files to prompt ──────────────────────
{
  const r = parseVideoPromptFile(
    ordinalSession([
      { ordinal: '1st', prompt: 'A slow pan across the clock shop.' },
      { ordinal: '2nd', prompt: 'Hands carefully winding a pocket watch.' }
    ])
  );
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.shots.length, 2);
  assert.strictEqual(r.shots[0].prompt, 'A slow pan across the clock shop.');
  assert.strictEqual(r.shots[1].prompt, 'Hands carefully winding a pocket watch.');
}

// ── Arbitrary filename has no effect — detection is content-based ─────────────
// (simulated by feeding the same content regardless of an imaginary filename)
{
  const content = ordinalSession([
    { ordinal: '1st', prompt: 'Image from THE-SPARROW-CLOCK-IMAGE-PROMPTS.md' },
    { ordinal: '2nd', prompt: 'Image from MY-STORY-PROMPTS.md' }
  ]);
  const r = parseOrdinalPromptSession(content);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.jobs.length, 2);
}

// ── Variable separator widths (17, 29, 40 hyphens) all accepted ──────────────
{
  for (const sep of ['-----------------', '-----------------------------', '----------------------------------------']) {
    const input = `${sep}\n1st Prompt with ${sep.length}-hyphen separator\n${sep}`;
    const r = parseOrdinalPromptSession(input);
    assert.deepStrictEqual(r.errors, [], `sep length ${sep.length}: ${JSON.stringify(r.errors)}`);
    assert.strictEqual(r.jobs.length, 1);
    assert.strictEqual(r.jobs[0].prompt, `Prompt with ${sep.length}-hyphen separator`);
  }
}

// ── Invalid: duplicate ordinals ───────────────────────────────────────────────
{
  const r = parseOrdinalPromptSession(
    ordinalSession([
      { ordinal: '1st', prompt: 'Prompt A' },
      { ordinal: '1st', prompt: 'Prompt B' }
    ])
  );
  assert(
    r.errors.some(e => e.toLowerCase().includes('duplicate')),
    `duplicate not detected — errors: ${JSON.stringify(r.errors)}`
  );
  assert.strictEqual(r.jobs.length, 1); // first occurrence is kept
}

// ── Invalid: malformed ordinal (no suffix) ────────────────────────────────────
{
  const r = parseOrdinalPromptSession(`${SEP}\n1 Prompt without suffix\n${SEP}`);
  assert(
    r.errors.some(e => e.toLowerCase().includes('expected ordinal')),
    `missing suffix not detected — errors: ${JSON.stringify(r.errors)}`
  );
}

// ── Invalid: non-ordinal text on entry line ───────────────────────────────────
{
  const r = parseOrdinalPromptSession(`${SEP}\nABC Some prompt\n${SEP}`);
  assert(
    r.errors.some(e => e.toLowerCase().includes('expected ordinal')),
    `non-ordinal not detected — errors: ${JSON.stringify(r.errors)}`
  );
}

// ── Invalid: empty prompt after ordinal ──────────────────────────────────────
// Note: the regex requires at least one non-whitespace char after the ordinal+space,
// so "1st   " (ordinal + spaces only) won't match ORDINAL_LINE and is treated as
// a malformed entry — the error category is "expected ordinal".
{
  const r = parseOrdinalPromptSession(`${SEP}\n1st\n${SEP}`);
  // "1st" with nothing after it does not match /^(\d+)(?:st|...)\\s+(.+)$/
  assert(r.errors.length > 0, 'bare ordinal with no prompt should produce an error');
}

// ── Invalid: missing separator between entries ────────────────────────────────
{
  // Two ordinal lines back-to-back without a separator between them.
  const r = parseOrdinalPromptSession(
    `${SEP}\n1st Prompt one\n2nd Prompt two\n${SEP}`
  );
  // "2nd Prompt two" is captured as part of Prompt one's body (no separator before it),
  // OR an error is produced. Either way, two valid independent jobs must NOT result.
  assert(r.jobs.length < 2 || r.errors.length > 0,
    'missing separator between entries should not silently produce two correct jobs');
}

// ── Exact format from task validation section (28-hyphen separators) ────────
// Verifies job[0].prompt / job[1].prompt isolation as specified.
{
  const input =
    '----------------------------\n' +
    '1st Generate a red apple.\n' +
    '----------------------------\n' +
    '2nd Generate a blue cup.\n' +
    '----------------------------';

  const r = parseOrdinalPromptSession(input);
  assert.deepStrictEqual(r.errors, [], `task-validation errors: ${JSON.stringify(r.errors)}`);
  assert.strictEqual(r.jobs.length, 2);
  assert.strictEqual(r.jobs[0].prompt, 'Generate a red apple.');
  assert.strictEqual(r.jobs[1].prompt, 'Generate a blue cup.');
  assert(!r.jobs[0].prompt.match(/^\d+(?:st|nd|rd|th)\b/), 'ordinal leaked into job 0');
  assert(!r.jobs[1].prompt.match(/^\d+(?:st|nd|rd|th)\b/), 'ordinal leaked into job 1');
  assert(!r.jobs[0].prompt.includes('---'), 'separator leaked into job 0');
  assert(!r.jobs[1].prompt.includes('---'), 'separator leaked into job 1');
}

// ---------------------------------------------------------------------------
// REGRESSION NOTE — "122 shots" false display on startup (Problem 2)
// ---------------------------------------------------------------------------
// Root cause: handleGetState() in service-worker.js calls loadQueue() which
// returns the full persisted queue (e.g. 122 shots, projectName="Imported Project").
// refresh() in sidepanel.js assigns this directly to `queue`, and renderQueue()
// renders the project section unconditionally whenever shots.length > 0.
//
// Fix: handleGetState() stamps queue.restoredFromStorage = true (ephemeral, not
// persisted).  renderQueue() uses that flag to display "Restored Queue" instead
// of the old projectName.  The flag is absent from broadcastQueue() broadcasts,
// so it disappears the moment a fresh import (QUEUE_UPDATE) replaces the object.
//
// This cannot be unit-tested in Node.js (Chrome APIs required).
// Manual browser verification steps:
//   1. Load extension with an old 122-shot queue already in Chrome storage.
//   2. Open the side panel — expect "Restored Queue  122 image prompts".
//   3. Import a 3-prompt ordinal file — expect normal "<projectName>  3 image prompts".
//   4. Close and reopen extension — expect "Restored Queue  3 image prompts" again.
// ---------------------------------------------------------------------------

console.log('Parser tests passed');
