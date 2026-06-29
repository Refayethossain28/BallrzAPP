import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareChauffeurMessage, sendChauffeurMessage, MAX_CHAT_MESSAGE, type ChatBackend } from './chat.ts';

test('prepareChauffeurMessage trims and keeps a valid role', () => {
  const m = prepareChauffeurMessage({ bookingRef: ' APX-1 ', message: '  on my way  ', fromRole: 'driver' });
  assert.deepEqual(m, { bookingRef: 'APX-1', message: 'on my way', fromRole: 'driver' });
});

test('prepareChauffeurMessage normalizes an unknown role to client', () => {
  const m = prepareChauffeurMessage({ bookingRef: 'APX-1', message: 'hi', fromRole: 'hacker' });
  assert.equal(m.fromRole, 'client');
});

test('prepareChauffeurMessage rejects missing ref / empty / too long', () => {
  assert.throws(() => prepareChauffeurMessage({ message: 'hi' }), /bookingRef/);
  assert.throws(() => prepareChauffeurMessage({ bookingRef: 'APX-1', message: '   ' }), /message is required/);
  assert.throws(() => prepareChauffeurMessage({ bookingRef: 'APX-1', message: 'x'.repeat(MAX_CHAT_MESSAGE + 1) }), /too long/);
});

test('sendChauffeurMessage sends the prepared payload', async () => {
  let sent: unknown = null;
  const backend: ChatBackend = { sendChauffeurMessage: async (d) => { sent = d; return { ok: true }; } };
  const ok = await sendChauffeurMessage(backend, { bookingRef: 'APX-1', message: ' hello ', fromRole: 'client' });
  assert.equal(ok, true);
  assert.deepEqual(sent, { bookingRef: 'APX-1', message: 'hello', fromRole: 'client' });
});

test('sendChauffeurMessage validates before checking the backend (throws on bad input)', async () => {
  await assert.rejects(sendChauffeurMessage(null, { bookingRef: 'APX-1', message: '' }), /message is required/);
});

test('sendChauffeurMessage returns false when offline but input is valid', async () => {
  assert.equal(await sendChauffeurMessage(null, { bookingRef: 'APX-1', message: 'hi' }), false);
});
