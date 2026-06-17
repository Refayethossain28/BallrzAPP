import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotification } from '../src/notifications.ts';
import { docStatus, EXPIRY_SOON_MS } from '../src/compliance.ts';

const ctx = { fromName: 'Priya', listingLabel: 'Hackney, London' };

test('message notification uses the preview, falling back to the listing', () => {
  assert.equal(buildNotification('message', { ...ctx, preview: 'Is it still available?' }).body, 'Is it still available?');
  assert.equal(buildNotification('message', { ...ctx, preview: '   ' }).body, 'About Hackney, London');
});

test('lifecycle events render distinct, named copy', () => {
  assert.match(buildNotification('viewing_proposed', ctx).body, /Priya proposed a viewing/);
  assert.match(buildNotification('signing_opened', ctx).title, /Signature requested/);
  assert.match(buildNotification('completed', ctx).title, /completed/);
});

test('docStatus reflects presence and expiry', () => {
  const now = 1_000_000_000_000;
  assert.equal(docStatus(undefined, now), 'missing');
  assert.equal(docStatus({ type: 'epc' }, now), 'valid');
  assert.equal(docStatus({ type: 'epc', expiresAt: now - 1 }, now), 'expired');
  assert.equal(docStatus({ type: 'epc', expiresAt: now + EXPIRY_SOON_MS - 1 }, now), 'expiring');
  assert.equal(docStatus({ type: 'epc', expiresAt: now + EXPIRY_SOON_MS + 86_400_000 }, now), 'valid');
});
