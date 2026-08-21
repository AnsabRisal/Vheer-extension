const assert = require('assert');
const { parseUniversalPromptSession, parsePromptFile, parseVideoPromptFile } = require('../lib/parser.js');

const S = '----------------------------------';
const block = (id, prompt) => `${S}\n${id}\n${S}\n${prompt}\n${S}`;

function session(...blocks) { return blocks.join('\n\n'); }

// Valid universal sessions.
{
  const result = parseUniversalPromptSession(session(block(1, 'Prompt one')));
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.jobs.length, 1);
  assert.strictEqual(result.jobs[0].id, '1');
  assert.strictEqual(result.jobs[0].prompt, 'Prompt one');
}

{
  const prompts = Array.from({ length: 105 }, (_, i) => block(i + 1, `Prompt ${i + 1}`));
  const result = parseUniversalPromptSession(prompts.join('\n\n'));
  assert.strictEqual(result.jobs.length, 105);
  assert.deepStrictEqual(result.jobs.slice(0, 3).map(j => j.number), [1, 2, 3]);
}

{
  const result = parseUniversalPromptSession(session(
    block(1, 'Line one\nLine two\nContains 42, hyphen-text, and **Markdown**.'),
    block(4, 'Prompt 4')
  ));
  assert.deepStrictEqual(result.jobs.map(j => j.number), [1, 4]);
  assert.strictEqual(result.jobs[0].prompt, 'Line one\nLine two\nContains 42, hyphen-text, and **Markdown**.');
  assert(result.warnings.includes('Missing job ID 2'));
  assert(result.warnings.includes('Missing job ID 3'));
}

// The same protocol adapts to both existing queue formats and never includes
// the delimiter or ID in provider-facing prompt content.
{
  const image = parsePromptFile(session(block(1, 'IMAGE ONLY')));
  const video = parseVideoPromptFile(session(block(2, 'VIDEO ONLY')));
  assert.strictEqual(image.shots[0].masterPrompt, 'IMAGE ONLY');
  assert.strictEqual(video.shots[0].prompt, 'VIDEO ONLY');
  assert.strictEqual(image.shots[0].id, '1');
  assert.strictEqual(video.shots[0].id, '2');
}

// Invalid sessions are rejected with actionable errors.
for (const [label, input, expected] of [
  ['duplicate IDs', session(block(1, 'A'), block(1, 'B')), 'Duplicate job ID 1'],
  ['non-numeric ID', session(block('ABC', 'Prompt')), 'Invalid job ID'],
  ['empty prompt', session(block(1, '   ')), 'missing prompt content'],
  ['missing closing delimiter', `${S}\n1\n${S}\nPrompt`, 'missing closing delimiter'],
  ['missing ID', `${S}\n${S}\nPrompt\n${S}`, 'Invalid job ID'],
  ['malformed delimiter', `----------------\n1\n${S}\nPrompt\n${S}`, 'invalid separator']
]) {
  const result = parseUniversalPromptSession(input);
  assert(result.errors.some(error => error.toLowerCase().includes(expected.toLowerCase())), label + ' was not rejected');
}

// Existing SHOT format remains supported.
{
  const result = parsePromptFile('SHOT 001\nMASTER PROMPT\nLegacy prompt');
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(result.shots[0].masterPrompt, 'Legacy prompt');
}

console.log('Parser tests passed');
