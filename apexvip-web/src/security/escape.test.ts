import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escape.ts';

test('escapeHtml neutralises the five HTML-special characters', () => {
  assert.equal(escapeHtml('<img onerror=x>'), '&lt;img onerror=x&gt;');
  assert.equal(escapeHtml(`"quoted" & 'apostrophes'`), '&quot;quoted&quot; &amp; &#39;apostrophes&#39;');
});

test('escapeHtml is a no-op on clean strings and stringifies non-strings', () => {
  assert.equal(escapeHtml('Mayfair, London W1'), 'Mayfair, London W1');
  assert.equal(escapeHtml(185), '185');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml blocks attribute breakouts (inline onclick strings)', () => {
  const hostile = `'); alert(1); ('`;
  assert.ok(!escapeHtml(hostile).includes(`'`));
});
