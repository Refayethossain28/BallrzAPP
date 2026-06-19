#!/usr/bin/env node
/**
 * Unit tests for ripple/engine.js — the pure messaging core behind Ripple
 * (rich text, slash commands, reactions, disappearing/scheduled messages,
 * polls, full-text search, chat summaries, sync de-duplication and the demo
 * auto-responder). Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-ripple-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'ripple', 'engine.js'), 'utf8'), sandbox, { filename: 'ripple/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 5, 19, 12, 0, 0); // 2026-06-19 12:00
const { SECOND, MINUTE, HOUR, DAY } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const msg = (over = {}) => E.createMessage({ chatId: 'c1', senderId: 'them', text: 'hi', ts: NOW, ...over });
// Values returned from the vm sandbox carry the sandbox's Array/Object
// prototypes, so deepStrictEqual rejects them cross-realm — compare by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ---------- rich text ---------- */
test('renderText escapes HTML before formatting (no injection)', () => {
  const out = E.renderText('<img src=x onerror=1> *bold*');
  assert.ok(!out.includes('<img'), 'raw tag must be escaped');
  assert.ok(out.includes('&lt;img'), 'angle bracket escaped');
  assert.ok(out.includes('<strong>bold</strong>'), 'bold still applied');
});
test('renderText links, italics, code, strike', () => {
  assert.ok(E.renderText('see https://x.com/a_b now').includes('<a href="https://x.com/a_b"'));
  assert.ok(E.renderText('_hi_').includes('<em>hi</em>'));
  assert.ok(E.renderText('`x=1`').includes('<code>x=1</code>'));
  assert.ok(E.renderText('~no~').includes('<del>no</del>'));
});
test('extractMentions returns unique lowercased handles', () => {
  deepEq(E.extractMentions('hey @Sam and @sam and @jo_1'), ['sam', 'jo_1']);
});

/* ---------- slash commands ---------- */
test('parseCommand: plain text passes through', () => {
  assert.equal(E.parseCommand('hello world').cmd, null);
});
test('parseCommand: /shrug appends kaomoji', () => {
  assert.ok(E.parseCommand('/shrug oh well').text.endsWith('¯\\_(ツ)_/¯'));
});
test('parseCommand: /poll parses question + options', () => {
  const p = E.parseCommand('/poll Pizza tonight? | yes | no | maybe');
  assert.equal(p.cmd, 'poll');
  assert.equal(p.question, 'Pizza tonight?');
  deepEq(p.options, ['yes', 'no', 'maybe']);
});
test('parseCommand: /poll needs two options', () => {
  assert.equal(E.parseCommand('/poll only one').cmd, 'error');
});
test('parseCommand: /remind parses duration + text', () => {
  const r = E.parseCommand('/remind 10m take cake out');
  assert.equal(r.cmd, 'remind');
  assert.equal(r.seconds, 600);
  assert.equal(r.text, 'take cake out');
});
test('parseDuration understands units (bare = minutes)', () => {
  assert.equal(E.parseDuration('30'), 1800);
  assert.equal(E.parseDuration('90s'), 90);
  assert.equal(E.parseDuration('2h'), 7200);
  assert.equal(E.parseDuration('1d'), 86400);
  assert.equal(E.parseDuration('garbage'), 0);
});

/* ---------- reactions / edit / unsend ---------- */
test('toggleReaction adds then removes, pruning empty', () => {
  const m = msg();
  E.toggleReaction(m, '👍', 'me');
  deepEq(m.reactions['👍'], ['me']);
  E.toggleReaction(m, '👍', 'me');
  assert.ok(!('👍' in m.reactions), 'empty reaction key pruned');
});
test('reactionSummary sorts by count desc', () => {
  const m = msg();
  E.toggleReaction(m, '❤', 'a'); E.toggleReaction(m, '❤', 'b'); E.toggleReaction(m, '👍', 'a');
  const s = E.reactionSummary(m);
  assert.equal(s[0].emoji, '❤'); assert.equal(s[0].count, 2);
});
test('editMessage records editedAt; not on deleted', () => {
  const m = msg();
  E.editMessage(m, 'fixed', NOW + 1000);
  assert.equal(m.text, 'fixed'); assert.equal(m.editedAt, NOW + 1000);
  E.unsendMessage(m, NOW + 2000);
  E.editMessage(m, 'nope', NOW + 3000);
  assert.equal(m.text, '', 'cannot edit an unsent message');
});
test('unsendMessage blanks content and becomes system', () => {
  const m = msg({ text: 'secret' });
  E.unsendMessage(m, NOW);
  assert.equal(m.deleted, true); assert.equal(m.text, ''); assert.equal(m.type, 'system');
});

/* ---------- disappearing / scheduled ---------- */
test('createMessage sets expireAt from disappearSec', () => {
  const m = E.createMessage({ chatId: 'c1', senderId: 'me', ts: NOW, disappearSec: 60 });
  assert.equal(m.expireAt, NOW + 60000);
});
test('isExpired / isPending boundaries', () => {
  const exp = msg({ expireAt: NOW });
  assert.equal(E.isExpired(exp, NOW), true);
  assert.equal(E.isExpired(exp, NOW - 1), false);
  const sched = msg({ scheduledAt: NOW + 1000 });
  assert.equal(E.isPending(sched, NOW), true);
  assert.equal(E.isPending(sched, NOW + 1000), false);
});
test('tick partitions live / due / expired', () => {
  const live = msg({ id: 'a' });
  const expired = msg({ id: 'b', expireAt: NOW - 1 });
  const pending = msg({ id: 'c', scheduledAt: NOW + HOUR });
  const due = msg({ id: 'd', scheduledAt: NOW - 1 });
  const r = E.tick([live, expired, pending, due], NOW);
  deepEq(r.expired, ['b']);
  deepEq(r.due, ['d']);
  deepEq(r.live.map(m => m.id), ['a', 'd']);
});

/* ---------- polls ---------- */
test('votePoll is single-choice and toggles', () => {
  const m = E.createMessage({ chatId: 'c1', senderId: 'me', ts: NOW, type: 'poll',
    meta: { question: 'Q', options: ['a', 'b'], votes: {} } });
  E.votePoll(m, 0, 'u1'); E.votePoll(m, 1, 'u1'); // switches to b
  deepEq(m.meta.votes[0], []);
  deepEq(m.meta.votes[1], ['u1']);
  const tally = E.pollTally(m);
  assert.equal(tally[1].count, 1); assert.equal(tally[1].pct, 100);
});

/* ---------- search ---------- */
const corpus = [
  msg({ id: 's1', text: 'Lunch at the new ramen place tomorrow?', ts: NOW - DAY }),
  msg({ id: 's2', text: 'I love ramen so much', ts: NOW - HOUR }),
  msg({ id: 's3', text: 'meeting moved to 3pm', ts: NOW - 2 * DAY }),
  msg({ id: 's4', text: 'unsent', deleted: true })
];
test('searchMessages: AND semantics + ignores deleted', () => {
  const r = E.searchMessages(corpus, 'ramen', { now: NOW });
  deepEq(r.map(x => x.message.id).sort(), ['s1', 's2']);
  assert.equal(E.searchMessages(corpus, 'ramen meeting', { now: NOW }).length, 0);
});
test('searchMessages: exact phrase ranks above scattered tokens', () => {
  const r = E.searchMessages(corpus, 'love ramen', { now: NOW });
  assert.equal(r[0].message.id, 's2');
});
test('searchMessages: empty query → []', () => {
  deepEq(E.searchMessages(corpus, '   ', { now: NOW }), []);
});
test('snippet centres on the token with ellipses', () => {
  const s = E.snippet('a'.repeat(60) + ' needle ' + 'b'.repeat(60), 'needle');
  assert.ok(s.includes('needle')); assert.ok(s.startsWith('…')); assert.ok(s.endsWith('…'));
});

/* ---------- chat summaries ---------- */
test('summarizeChats: pinned first, then recency; unread + preview', () => {
  const chats = [
    E.createChat({ id: 'a', name: 'A', now: NOW - 5 * DAY }),
    E.createChat({ id: 'b', name: 'B', pinned: true, now: NOW - 5 * DAY }),
    E.createChat({ id: 'm', name: 'Muted', muted: true, now: NOW - 5 * DAY })
  ];
  const byChat = {
    a: [msg({ chatId: 'a', senderId: 'them', text: 'newest', ts: NOW })],
    b: [msg({ chatId: 'b', senderId: 'them', text: 'older', ts: NOW - HOUR })],
    m: [msg({ chatId: 'm', senderId: 'them', text: 'ping', ts: NOW })]
  };
  const rows = E.summarizeChats(chats, byChat, 'me', NOW);
  assert.equal(rows[0].chat.id, 'b', 'pinned floats to top despite older message');
  assert.equal(rows[1].chat.id, 'a');
  assert.equal(rows[1].unread, 1);
  assert.equal(rows[1].preview, 'newest');
  const muted = rows.find(r => r.chat.id === 'm');
  assert.equal(muted.unread, 0, 'muted chats never count unread');
});
test('totalUnread sums unmuted unread, ignores own + read', () => {
  const chats = [E.createChat({ id: 'a' })];
  const byChat = { a: [
    msg({ chatId: 'a', senderId: 'them', ts: NOW }),
    msg({ chatId: 'a', senderId: 'me', ts: NOW }),
    msg({ chatId: 'a', senderId: 'them', ts: NOW, readBy: ['me'] })
  ] };
  assert.equal(E.totalUnread(chats, byChat, 'me', NOW), 1);
});

/* ---------- sync merge ---------- */
test('mergeMessages dedups by id, prefers newest edit, keeps ts order', () => {
  const a = [msg({ id: 'x', text: 'v1', ts: 1 }), msg({ id: 'y', text: 'y', ts: 3 })];
  const b = [msg({ id: 'x', text: 'v2', ts: 1, editedAt: 99 }), msg({ id: 'z', text: 'z', ts: 2 })];
  const out = E.mergeMessages(a, b);
  deepEq(out.map(m => m.id), ['x', 'z', 'y']);
  assert.equal(out[0].text, 'v2', 'edited copy wins');
});
test('mergeMessages: delete beats a plain copy', () => {
  const a = [msg({ id: 'x', text: 'here', ts: 5 })];
  const b = [msg({ id: 'x', text: '', ts: 5, deleted: true })];
  assert.equal(E.mergeMessages(a, b)[0].deleted, true);
});

/* ---------- time formatting ---------- */
test('relativeTime: now / minutes / time / Yesterday', () => {
  assert.equal(E.relativeTime(NOW - 30 * SECOND, NOW), 'now');
  assert.equal(E.relativeTime(NOW - 5 * MINUTE, NOW), '5m');
  assert.equal(E.relativeTime(NOW - DAY, NOW), 'Yesterday');
});
test('groupByDay splits into Today / Yesterday buckets', () => {
  const g = E.groupByDay([msg({ ts: NOW - DAY }), msg({ ts: NOW })], NOW);
  assert.equal(g.length, 2);
  assert.equal(g[0].label, 'Yesterday');
  assert.equal(g[1].label, 'Today');
});
test('formatDur mm:ss', () => {
  assert.equal(E.formatDur(75), '1:15');
  assert.equal(E.formatDur(5), '0:05');
});

/* ---------- Pulse: conversational rhythm engine ---------- */
// helper: build a back-and-forth thread with given gaps (seconds) between msgs
const thread = (gapsSec, opts = {}) => {
  const start = opts.start != null ? opts.start : NOW - 3 * DAY;
  let t = start, who = 0;
  const out = [E.createMessage({ chatId: 'c1', senderId: 'me', text: 'hi', ts: t })];
  for (const g of gapsSec) {
    t += g * SECOND; who ^= 1;
    out.push(E.createMessage({ chatId: 'c1', senderId: who ? 'them' : 'me', text: 'x', ts: t }));
  }
  return out;
};

test('conversationPulse: empty / single message is neutral "new"', () => {
  const p0 = E.conversationPulse([], 'me', NOW);
  assert.equal(p0.samples, 0);
  assert.equal(p0.tempo, 'new');
  const p1 = E.conversationPulse([msg({ senderId: 'me' })], 'me', NOW);
  assert.equal(p1.samples, 1);
  assert.equal(p1.tempo, 'new');
  assert.equal(E.formatPulse(p1).line, 'Finding your rhythm…');
});

test('conversationPulse: rapid volleys classify as rapid with a short beat', () => {
  // ~20s replies, recent → ends near now
  const msgs = thread(new Array(12).fill(20), { start: NOW - 5 * MINUTE });
  const p = E.conversationPulse(msgs, 'me', NOW);
  assert.equal(p.tempo, 'rapid');
  assert.ok(p.beatMs <= E.MINUTE, 'beat should be ≤1m for rapid chat, got ' + p.beatMs);
  assert.ok(p.syncScore >= 0 && p.syncScore <= 100);
});

test('conversationPulse: slow thread classifies relaxed/slow with a long beat', () => {
  const msgs = thread(new Array(8).fill(6 * 3600), { start: NOW - 30 * DAY }); // 6h gaps
  const p = E.conversationPulse(msgs, 'me', NOW);
  assert.ok(p.tempo === 'relaxed' || p.tempo === 'slow', 'got ' + p.tempo);
  assert.ok(p.beatMs >= E.HOUR, 'beat should be hours, got ' + p.beatMs);
});

test('conversationPulse: shrinking gaps read as "warming"', () => {
  const g = [3600, 3600, 1800, 1800, 600, 120, 60, 30];
  const total = g.reduce((a, b) => a + b, 0);
  const msgs = thread(g, { start: NOW - (total + 2) * SECOND }); // ends ~now
  const p = E.conversationPulse(msgs, 'me', NOW);
  assert.equal(p.momentum, 'warming');
});

test('conversationPulse: a long silence reads as "quiet"', () => {
  // brisk early chat, then nothing for two days
  const msgs = thread([60, 60, 60, 60], { start: NOW - 2 * DAY - 5 * MINUTE });
  const p = E.conversationPulse(msgs, 'me', NOW);
  assert.equal(p.momentum, 'quiet');
  assert.ok(p.idleMs > DAY);
});

test('conversationPulse: lead/balance reflects who talks more', () => {
  const mine = [0, 1, 2, 3, 4].map(i =>
    E.createMessage({ chatId: 'c1', senderId: 'me', text: 'x', ts: NOW - (5 - i) * MINUTE }));
  mine.push(E.createMessage({ chatId: 'c1', senderId: 'them', text: 'x', ts: NOW }));
  const p = E.conversationPulse(mine, 'me', NOW);
  assert.equal(p.lead, 'you lead');
  assert.ok(p.balance > 0.2);
});

test('conversationPulse is deterministic and ignores deleted/system/future msgs', () => {
  const base = thread(new Array(6).fill(45), { start: NOW - 30 * MINUTE });
  const noisy = base.concat([
    E.createMessage({ chatId: 'c1', senderId: 'me', type: 'system', text: 'joined', ts: NOW - MINUTE }),
    E.createMessage({ chatId: 'c1', senderId: 'me', text: 'gone', ts: NOW - MINUTE, deleted: true }),
    E.createMessage({ chatId: 'c1', senderId: 'me', text: 'later', ts: NOW + HOUR, scheduledAt: NOW + HOUR })
  ]);
  const a = E.conversationPulse(base, 'me', NOW);
  const b = E.conversationPulse(noisy, 'me', NOW);
  assert.equal(a.cadenceMs, b.cadenceMs, 'noise must not change the cadence');
  assert.equal(a.syncScore, b.syncScore);
});

test('beatsToSeconds scales the beat and never goes below 15s', () => {
  const p = E.conversationPulse(thread(new Array(8).fill(40), { start: NOW - 6 * MINUTE }), 'me', NOW);
  assert.equal(E.beatsToSeconds(p, 3), Math.max(15, Math.round(p.beatMs * 3 / SECOND)));
  assert.ok(E.beatsToSeconds({ beatMs: 1000 }, 1) >= 15);
});

test('niceDuration snaps to friendly buckets', () => {
  assert.equal(E.niceDuration(33 * SECOND), 30 * SECOND);
  assert.equal(E.niceDuration(50 * MINUTE), 60 * MINUTE);
});

test('formatPulse renders a compact rhythm line', () => {
  const p = E.conversationPulse(thread(new Array(10).fill(25), { start: NOW - 5 * MINUTE }), 'me', NOW);
  const f = E.formatPulse(p);
  assert.ok(/sync \d+/.test(f.line));
  assert.ok(f.line.includes('beat'));
  assert.equal(f.tempo, 'Rapid');
});

/* ---------- reply outlook (best time to reach) ---------- */
test('replyOutlook finds the hour they usually reply (recency-weighted)', () => {
  const hourOf = ts => new Date(ts).getUTCHours();
  const base = Date.UTC(2026, 5, 19, 21, 0, 0); // now = 21:00 UTC
  const msgs = [];
  for (let d = 1; d <= 8; d++) // them, every recent day at 21:00 UTC
    msgs.push(E.createMessage({ chatId: 'c1', senderId: 'them', text: 'x', ts: base - d * DAY }));
  // a couple of stale off-peak ones that should be outweighed by recency
  msgs.push(E.createMessage({ chatId: 'c1', senderId: 'them', text: 'x', ts: Date.UTC(2026, 4, 1, 9, 0, 0) }));
  const o = E.replyOutlook(msgs, 'me', base, { hourOf });
  assert.equal(o.bestHour, 21, 'peak hour is 21');
  assert.equal(o.bestHour12, '9 PM');
  assert.ok(o.activeNow, 'now (21:00) should read as active');
  assert.ok(o.nowScore > 0.6);
});
test('replyOutlook ignores my own messages and sparse history', () => {
  const hourOf = ts => new Date(ts).getUTCHours();
  const mine = [];
  for (let d = 1; d <= 8; d++) mine.push(E.createMessage({ chatId: 'c1', senderId: 'me', ts: NOW - d * HOUR }));
  const o = E.replyOutlook(mine, 'me', NOW, { hourOf });
  assert.equal(o.samples, 0);
  assert.equal(o.bestHour, -1);
  assert.equal(o.label, 'Not enough history yet');
});
test('echoReplyDelay mirrors cadence within bounds', () => {
  const fast = E.echoReplyDelay({ cadenceMs: 6 * SECOND });
  const slow = E.echoReplyDelay({ cadenceMs: 5 * MINUTE });
  assert.ok(fast >= 700 && fast <= 6000);
  assert.equal(slow, 6000, 'slow chat clamps to the max');
  assert.ok(slow >= fast);
  assert.equal(E.echoReplyDelay(null), Math.round(750)); // default 1500*0.5
});

test('nextPeakTime returns the next future moment at their peak hour', () => {
  const out = { bestHour: 9 };
  const t = E.nextPeakTime(out, NOW);
  assert.ok(t > NOW, 'must be in the future');
  assert.equal(new Date(t).getHours(), 9, 'lands on the peak hour (local)');
  assert.ok(t - NOW <= DAY, 'within the next 24h');
  assert.equal(E.nextPeakTime({ bestHour: -1 }, NOW), null);
});

/* ---------- group pulse ---------- */
test('groupPulse ranks who carries the room', () => {
  const hourOf = ts => new Date(ts).getUTCHours();
  const base = Date.UTC(2026, 5, 19, 20, 0, 0);
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push(E.createMessage({ chatId: 'g', senderId: 'maya', text: 'x', ts: base - i * HOUR }));
  for (let i = 0; i < 3; i++) msgs.push(E.createMessage({ chatId: 'g', senderId: 'leo', text: 'x', ts: base - i * HOUR }));
  msgs.push(E.createMessage({ chatId: 'g', senderId: 'me', text: 'x', ts: base - HOUR }));
  const g = E.groupPulse(msgs, 'me', base, { hourOf });
  assert.equal(g.topSpeaker, 'maya');
  assert.equal(g.leaders[0].id, 'maya');
  assert.ok(g.leaders[0].share > 0.5);
  assert.ok(g.leaders.find(l => l.id === 'me').isMe);
  // shares sum to ~1
  assert.ok(Math.abs(g.leaders.reduce((a, l) => a + l.share, 0) - 1) < 1e-9);
});
test('groupPulse finds the liveliest hour and ignores system/deleted', () => {
  const hourOf = ts => new Date(ts).getUTCHours();
  const base = Date.UTC(2026, 5, 19, 20, 30, 0);
  const msgs = [];
  for (let d = 0; d < 6; d++) msgs.push(E.createMessage({ chatId: 'g', senderId: 'leo', text: 'x', ts: base - d * DAY })); // 20:00 UTC
  msgs.push(E.createMessage({ chatId: 'g', senderId: 'leo', type: 'system', text: 'joined', ts: base }));
  const g = E.groupPulse(msgs, 'me', base, { hourOf });
  assert.equal(g.bestHour, 20);
  assert.equal(g.samples, 6, 'system message excluded');
});

test('previewText masks undecrypted encrypted messages', () => {
  assert.equal(E.previewText({ type: 'text', enc: { v: 1, iv: 'x', ct: 'y' }, text: '' }), '🔒 Encrypted message');
  // once decrypted in memory the plaintext shows
  assert.equal(E.previewText({ type: 'text', enc: { v: 1, iv: 'x', ct: 'y' }, text: 'hello' }), 'hello');
  // a deleted encrypted message still reads as unsent
  assert.equal(E.previewText({ enc: { v: 1 }, deleted: true, text: '' }), '🚫 This message was unsent');
});

/* ---------- demo auto-responder ---------- */
test('autoReply is deterministic and responsive', () => {
  assert.equal(E.autoReply('hey', { seed: 1 }), E.autoReply('hey', { seed: 1 }));
  assert.ok(/👋/.test(E.autoReply('hello')));
  assert.ok(E.autoReply('what time?').length > 0);
  assert.ok(/🔐/.test(E.autoReply('is this private?')) || E.autoReply('is this private?').length > 0);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`✗ ${name}\n   ${err.message}`); process.exit(1); }
}
console.log(`✓ ripple engine: ${passed}/${tests.length} tests passed`);
