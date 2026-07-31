import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage, errorFingerprint, formatErrorReport, shouldReport } from './errors.ts';

test('errorMessage normalises Errors, error-likes and junk', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage({ message: 'firebase-ish' }), 'firebase-ish');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(undefined), 'unknown error');
});

test('fingerprint is stable for same message+frame, differs across errors', () => {
  const a = errorFingerprint('x failed', 'Error: x failed\n    at doX (app.js:1:2)');
  const b = errorFingerprint('x failed', 'Error: x failed\n    at doX (app.js:1:2)');
  const c = errorFingerprint('y failed', 'Error: y failed\n    at doY (app.js:9:9)');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('formatErrorReport caps sizes and carries app/screen context', () => {
  const r = formatErrorReport(new Error('m'.repeat(900)), { app: 'client', screen: 'home' });
  assert.equal(r.message.length, 500);
  assert.equal(r.app, 'client');
  assert.equal(r.screen, 'home');
  assert.ok(r.fingerprint.length > 0);
});

test('shouldReport dedupes fingerprints and hard-caps the session', () => {
  const seen = new Set<string>();
  assert.equal(shouldReport('f1', seen), true);
  assert.equal(shouldReport('f1', seen), false);          // duplicate
  for (let i = 0; i < 25; i++) shouldReport('f' + i, seen);
  assert.equal(shouldReport('fresh', seen, 20), false);   // capped
});
