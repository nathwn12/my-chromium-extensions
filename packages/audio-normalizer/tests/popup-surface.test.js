const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

// This package is "type": "commonjs", so import.meta.url is a syntax error here;
// pathToFileURL(__filename) is the equivalent URL base for the relative read.
const html = readFileSync(new URL('../popup.html', pathToFileURL(__filename)), 'utf8');

const PRESERVED_IDS = [
  'hostname',
  'status-pill',
  'status-text',
  'toggle',
  'gain-slider',
  'gain-value',
  'reset-btn',
  'exclude-btn',
];

test('popup: every QA-read id appears exactly once', () => {
  for (const id of PRESERVED_IDS) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} appears exactly once`);
  }
});

test('popup: no preset or Speech/Boost copy survives', () => {
  assert.doesNotMatch(html, /data-preset/);
  assert.doesNotMatch(html, /Speech|Boost/);
});

test('popup: Reset and the exclude control are the only two buttons', () => {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
  assert.equal(buttons.length, 2, 'exactly two buttons in the popup');
  assert.match(buttons[0], /id="reset-btn"/, 'Reset sits first');
  assert.match(buttons[0], />\s*Reset\s*</, 'with a visible Reset label');
  assert.match(buttons[1], /id="exclude-btn"/);
  assert.match(buttons[1], />\s*Exclude site\s*</, 'with a visible Exclude label');
  assert.doesNotMatch(html, /data-preset/, 'no preset buttons');
});
