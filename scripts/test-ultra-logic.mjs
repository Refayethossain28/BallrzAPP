#!/usr/bin/env node
/**
 * Unit tests for ultra/engine.js — the pure Nintendo 64 emulator core
 * behind Ultra: the MIPS R4300i integer interpreter (delay slots, HI/LO,
 * big-endian RDRAM), the two-pass MIPS assembler and disassembler, the
 * simplified VI/controller MMIO, ROM byte-order identification
 * (.z64/.v64/.n64), and the two bundled demo cartridges (gradient + pong).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-ultra-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'ultra', 'engine.js'), 'utf8'), sandbox, { filename: 'ultra/engine.js' });
const E = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

// Assemble one program, boot a console with it, run to halt, return state.
function runProgram(src, maxSteps = 10000) {
  const asm = E.assemble(src);
  assert.equal(asm.ok, true, 'assembles clean: ' + asm.errors.join('; '));
  const s = E.makeState();
  E.loadProgram(s, asm.words, asm.base);
  E.run(s, maxSteps);
  return s;
}

/* ---------- assembler encodings (checked against the real MIPS ISA) ---------- */
test('assembler emits canonical MIPS encodings', () => {
  const words = (src) => E.assemble(src).words.map((w) => w >>> 0);
  deepEq(words('addiu $t0, $zero, 5'), [0x24080005]);
  deepEq(words('lui $a0, 0x8010'), [0x3C048010]);
  deepEq(words('jr $ra'), [0x03E00008]);
  deepEq(words('sll $t0, $t1, 4'), [0x00094100]);
  deepEq(words('sh $t8, 0($t2)'), [0xA5580000]);
  deepEq(words('addu $v0, $a0, $a1'), [0x00851021]);
  deepEq(words('nop'), [0]);
});
test('branches encode relative to the delay slot, jumps absolute', () => {
  // beq at base: skipping one instruction = offset 1
  const asm = E.assemble('beq $zero, $zero, skip\nnop\nskip: break');
  deepEq(asm.words[0] >>> 0, 0x10000001);
  const j = E.assemble('start: j start');
  deepEq(j.words[0] >>> 0, ((2 << 26) | ((0x80001000 >>> 2) & 0x3FFFFFF)) >>> 0);
});
test('li pseudo expands by immediate size, la always lui+ori', () => {
  assert.equal(E.assemble('li $t0, 320').words.length, 1);
  assert.equal(E.assemble('li $t0, -4').words.length, 1);
  assert.equal(E.assemble('li $t0, 0x12345').words.length, 2);
  const la = E.assemble('la $t0, target\ntarget: .word 7');
  deepEq(la.words.slice(0, 2).map((w) => w >>> 0), [0x3C088000, 0x35081008]);
});
test('assembler reports errors with line numbers instead of emitting junk', () => {
  const bad = E.assemble('addiu $t0, $zero, 1\nfrobnicate $t0\nori $t1, $bogus, 2');
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  assert.ok(bad.errors[0].includes('line 2'));
  assert.ok(bad.errors[1].includes('bad register'));
});
test('disassembler round-trips the common encodings', () => {
  assert.equal(E.disasm(0x24080005, 0), 'addiu $t0, $zero, 5');
  assert.equal(E.disasm(0x03E00008, 0), 'jr $ra');
  assert.equal(E.disasm(0, 0), 'nop');
  assert.equal(E.disasm(0xA5580000, 0), 'sh $t8, 0($t2)');
});

/* ---------- CPU semantics ---------- */
test('arithmetic, logic and signed/unsigned compares', () => {
  const s = runProgram([
    'li $t0, -1',
    'li $t1, 1',
    'addu $t2, $t0, $t1     ; -1 + 1 = 0',
    'slt  $t3, $t0, $t1     ; signed: -1 < 1',
    'sltu $t4, $t0, $t1     ; unsigned: 0xFFFFFFFF < 1 is false',
    'nor  $t5, $zero, $zero ; ~0',
    'xori $t6, $t1, 0xFFFF',
    'break',
  ].join('\n'));
  const r = s.gpr;
  assert.equal(r[10], 0);
  assert.equal(r[11], 1);
  assert.equal(r[12], 0);
  assert.equal(r[13], -1);
  assert.equal(r[14], 0xFFFE);
});
test('the branch delay slot executes; the instruction after it is skipped', () => {
  const s = runProgram([
    'li $t0, 1',
    'b skip',
    'li $t0, 2   ; delay slot — runs',
    'li $t0, 3   ; jumped over — never runs',
    'skip: break',
  ].join('\n'));
  assert.equal(s.gpr[8], 2);
});
test('jal/jr call and return; $ra points past the delay slot', () => {
  const s = runProgram([
    'jal sub',
    'nop',
    'break',
    'sub: li $v0, 42',
    'jr $ra',
    'nop',
  ].join('\n'));
  assert.equal(s.gpr[2], 42);
  assert.equal(s.gpr[31] >>> 0, 0x80001008);
  assert.equal(s.stopReason, 'break');
});
test('mult produces a full 64-bit HI/LO result', () => {
  const s = runProgram([
    'li $t0, 0x12345678',
    'li $t1, 0x7654321',
    'mult $t0, $t1',
    'mfhi $t2',
    'mflo $t3',
    'break',
  ].join('\n'));
  const prod = BigInt(0x12345678) * BigInt(0x7654321);
  assert.equal(s.gpr[10], Number((prod >> 32n) & 0xFFFFFFFFn) | 0);
  assert.equal(s.gpr[11], Number(prod & 0xFFFFFFFFn) | 0);
});
test('div truncates toward zero with the remainder in HI', () => {
  const s = runProgram('li $t0, -7\nli $t1, 2\ndiv $t0, $t1\nmfhi $t2\nmflo $t3\nbreak');
  assert.equal(s.gpr[11], -3);
  assert.equal(s.gpr[10], -1);
});
test('RDRAM is big-endian; lb/lh sign-extend, lbu/lhu do not', () => {
  const s = runProgram([
    'lui $t0, 0x8000',
    'li  $t1, 0x11228344',
    'sw  $t1, 0x100($t0)',
    'lb  $t2, 0x100($t0)   ; 0x11 — MSB first',
    'lbu $t3, 0x102($t0)   ; 0x83',
    'lb  $t4, 0x102($t0)   ; sign-extends to -125',
    'lh  $t5, 0x102($t0)   ; 0x8344 → negative',
    'lhu $t6, 0x102($t0)',
    'break',
  ].join('\n'));
  assert.equal(s.gpr[10], 0x11);
  assert.equal(s.gpr[11], 0x83);
  assert.equal(s.gpr[12], (0x83 << 24) >> 24);
  assert.equal(s.gpr[13], (0x8344 << 16) >> 16);
  assert.equal(s.gpr[14], 0x8344);
});
test('$zero is hardwired: writes to it vanish', () => {
  const s = runProgram('li $zero, 99\naddiu $t0, $zero, 3\nbreak');
  assert.equal(s.gpr[0], 0);
  assert.equal(s.gpr[8], 3);
});
test('an instruction outside the integer subset halts with its name', () => {
  const s = E.makeState();
  E.loadProgram(s, [0xC4000000], 0x80001000); // lwc1 — needs the FPU
  E.run(s, 10);
  assert.equal(s.halted, true);
  assert.ok(s.stopReason.includes('lwc1'), s.stopReason);
  assert.equal(s.stopPc >>> 0, 0x80001000);
});

/* ---------- MMIO: video interface + controller ---------- */
test('VI registers latch through KSEG1; VI_CURRENT write is vsync', () => {
  const s = E.makeState();
  E.write32(s, 0xA4400004, 0x123000);
  E.write32(s, 0xA4400008, 320);
  assert.equal(s.viOrigin, 0x123000);
  assert.equal(s.viWidth, 320);
  assert.equal(s.frameDone, false);
  E.write32(s, 0xA4400010, 0);
  assert.equal(s.frameDone, true);
  assert.equal(s.frame, 1);
  assert.equal(E.read32(s, 0xA4400010) >>> 0, 1);
});
test('controller reads use the real N64 button bits', () => {
  const s = E.makeState();
  E.setButtons(s, E.BUTTONS.A | E.BUTTONS.D_LEFT);
  assert.equal(E.read32(s, 0xA4800000) >>> 0, 0x8200);
  assert.equal(E.BUTTONS.START, 0x1000);
});

/* ---------- ROM cartridges ---------- */
function fakeRomZ64() {
  const rom = new Uint8Array(0x1000 + 8);
  rom.set([0x80, 0x37, 0x12, 0x40], 0);
  rom.set([0x80, 0x00, 0x04, 0x00], 8);            // entry 0x80000400
  rom.set([0xDE, 0xAD, 0xBE, 0xEF], 0x10);         // crc1
  for (let i = 0; i < 10; i++) rom[0x20 + i] = 'ULTRA TEST'.charCodeAt(i);
  // code at 0x1000: ori $t0, $zero, 7 ; break
  rom.set([0x34, 0x08, 0x00, 0x07, 0x00, 0x00, 0x00, 0x0D], 0x1000);
  return rom;
}
test('identifyRom parses a .z64 header (name, entry, crc)', () => {
  const info = E.identifyRom(fakeRomZ64());
  assert.equal(info.ok, true);
  assert.equal(info.format, 'z64');
  assert.equal(info.name, 'ULTRA TEST');
  assert.equal(info.entry >>> 0, 0x80000400);
  assert.equal(info.crc1 >>> 0, 0xDEADBEEF);
});
test('.v64 and .n64 byte orders normalize to identical big-endian bytes', () => {
  const z = fakeRomZ64();
  const v = new Uint8Array(z.length), n = new Uint8Array(z.length);
  for (let i = 0; i < z.length; i += 4) {
    v[i] = z[i + 1]; v[i + 1] = z[i]; v[i + 2] = z[i + 3]; v[i + 3] = z[i + 2];
    n[i] = z[i + 3]; n[i + 1] = z[i + 2]; n[i + 2] = z[i + 1]; n[i + 3] = z[i];
  }
  const iv = E.identifyRom(v), inn = E.identifyRom(n);
  assert.equal(iv.format, 'v64');
  assert.equal(inn.format, 'n64');
  deepEq(Array.from(iv.bytes.slice(0, 0x40)), Array.from(z.slice(0, 0x40)));
  deepEq(Array.from(inn.bytes.slice(0, 0x40)), Array.from(z.slice(0, 0x40)));
  assert.equal(iv.name, 'ULTRA TEST');
});
test('junk bytes are rejected, not booted', () => {
  assert.equal(E.identifyRom(new Uint8Array(16)).ok, false);
  const junk = new Uint8Array(0x40).fill(0x55);
  assert.equal(E.identifyRom(junk).ok, false);
});
test('archives are rejected with a useful message, not run as code', () => {
  const arc = (sig) => { const b = new Uint8Array(0x80); b.set(sig, 0); return E.identifyRom(b); };
  const sevenz = arc([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]);
  assert.equal(sevenz.ok, false);
  assert.ok(/\.7z archive/.test(sevenz.error), sevenz.error);
  assert.ok(/extract/.test(sevenz.error));
  assert.equal(arc([0x50, 0x4B, 0x03, 0x04]).ok, false); // zip
  assert.equal(arc([0x1F, 0x8B]).ok, false);             // gzip
  assert.ok(/\.rar archive/.test(arc([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07]).error));
});
test('bootRom copies code from ROM offset 0x1000 to the entry point and runs it', () => {
  const s = E.makeState();
  E.bootRom(s, E.identifyRom(fakeRomZ64()));
  assert.equal(s.halted, false);
  E.run(s, 10);
  assert.equal(s.gpr[8], 7);
  assert.equal(s.stopReason, 'break');
});

/* ---------- the demo cartridges ---------- */
test('gradient demo: one runFrame paints a deterministic, animated frame', () => {
  const a = E.bootDemo('gradient');
  const steps = E.runFrame(a, 600000);
  assert.equal(a.frameDone, true, 'frame completed inside the budget (' + steps + ' steps)');
  assert.equal(a.halted, false);
  const fb1 = E.framebufferRGBA(a, new Uint8Array(320 * 240 * 4));
  assert.ok(fb1.some((v, i) => i % 4 !== 3 && v !== 0), 'painted something');
  assert.equal(fb1[3], 255, 'opaque alpha');
  // deterministic: a second console renders the identical first frame
  const b = E.bootDemo('gradient');
  E.runFrame(b, 600000);
  const fb2 = E.framebufferRGBA(b, new Uint8Array(320 * 240 * 4));
  deepEq(Array.from(fb1.slice(0, 4000)), Array.from(fb2.slice(0, 4000)));
  // animated: the next frame scrolls the bands
  E.runFrame(b, 600000);
  const fb3 = E.framebufferRGBA(b, new Uint8Array(320 * 240 * 4));
  assert.notEqual(JSON.stringify(Array.from(fb2.slice(0, 4000))), JSON.stringify(Array.from(fb3.slice(0, 4000))));
});
test('pong demo: ball moves, and the d-pad drives the paddle', () => {
  const s = E.bootDemo('pong');
  E.runFrame(s, 600000);
  assert.equal(s.frameDone, true);
  // the program mirrors its state into RDRAM at 0x80000200
  assert.equal(E.read32(s, 0x80000200), 159, 'ball x advanced by dx');
  assert.equal(E.read32(s, 0x80000204), 82, 'ball y advanced by dy');
  assert.equal(E.read32(s, 0x80000210), 140, 'paddle still centered');
  E.setButtons(s, E.BUTTONS.D_LEFT);
  E.runFrame(s, 600000);
  assert.equal(E.read32(s, 0x80000210), 136, 'paddle slid left by 4');
  E.setButtons(s, E.BUTTONS.D_RIGHT);
  E.runFrame(s, 600000);
  E.runFrame(s, 600000);
  assert.equal(E.read32(s, 0x80000210), 144, 'paddle slid back right');
});
test('pong survives 120 frames without halting (walls bounce, misses reset)', () => {
  const s = E.bootDemo('pong');
  for (let i = 0; i < 120; i++) E.runFrame(s, 600000);
  assert.equal(s.halted, false, s.stopReason);
  assert.equal(s.frame, 120);
  const bx = E.read32(s, 0x80000200);
  assert.ok(bx >= 0 && bx <= 320, 'ball stayed on the court: ' + bx);
});
test('starfield demo: runs a frame, paints stars, is deterministic and animates', () => {
  const a = E.bootDemo('starfield');
  const steps = E.runFrame(a, 3000000);
  assert.equal(a.frameDone, true, 'frame completed inside the budget (' + steps + ' steps)');
  assert.equal(a.halted, false, a.stopReason);
  const fb1 = E.framebufferRGBA(a, new Uint8Array(320 * 240 * 4));
  // deep-space clear (0x0021) plus at least a few bright star pixels
  let bright = 0;
  for (let i = 0; i < fb1.length; i += 4) if (fb1[i] > 120 && fb1[i + 1] > 120) bright++;
  assert.ok(bright >= 10, 'painted a star field (' + bright + ' bright pixels)');
  const b = E.bootDemo('starfield');
  E.runFrame(b, 3000000);
  const fb2 = E.framebufferRGBA(b, new Uint8Array(320 * 240 * 4));
  deepEq(Array.from(fb1), Array.from(fb2)); // same seed → identical first frame
  for (let f = 0; f < 8; f++) E.runFrame(b, 3000000);
  const fb3 = E.framebufferRGBA(b, new Uint8Array(320 * 240 * 4));
  assert.notEqual(JSON.stringify(Array.from(fb1)), JSON.stringify(Array.from(fb3)), 'stars drifted');
});
test('starfield survives 90 frames without halting', () => {
  const s = E.bootDemo('starfield');
  for (let i = 0; i < 90; i++) E.runFrame(s, 3000000);
  assert.equal(s.halted, false, s.stopReason);
  assert.equal(s.frame, 90);
});

/* ---------- homebrew catalog + search ---------- */
test('every catalog entry is legal (bundled builtin or a search-out community link)', () => {
  for (const r of E.HOMEBREW) {
    assert.ok(r.kind === 'builtin' || r.kind === 'community', r.id + ' has a known kind');
    if (r.kind === 'builtin') assert.ok(E.DEMOS[r.demo], r.id + ' points at a real demo');
    // no catalog entry may carry a direct download URL to a commercial ROM
    assert.equal(r.url, undefined, r.id + ' must not hardcode a download URL');
  }
});
test('searchHomebrew tokenises and matches across fields; empty returns all', () => {
  deepEq(E.searchHomebrew('').map((r) => r.id).sort(),
    E.HOMEBREW.map((r) => r.id).sort());
  deepEq(E.searchHomebrew('pong').map((r) => r.id), ['pong']);
  deepEq(E.searchHomebrew('SPACE').map((r) => r.id), ['starfield']); // case-insensitive, genre field
  deepEq(E.searchHomebrew('tetris').map((r) => r.id), ['pom1-tetris']);
  deepEq(E.searchHomebrew('puzzle').map((r) => r.id).sort(), ['n64brew-gamejam', 'pom1-tetris']);
  // every token must hit — nonsense filters everything out
  deepEq(E.searchHomebrew('pong zzzznope').map((r) => r.id), []);
});
test('community entries resolve to a scoped web search, never a ROM host', () => {
  const community = E.HOMEBREW.filter((r) => r.kind === 'community');
  assert.ok(community.length >= 1);
  for (const r of community) {
    const u = E.homebrewSearchUrl(r);
    assert.ok(u.startsWith('https://duckduckgo.com/?q='), r.id + ' opens a search, not a download');
  }
});

test('framebuffer decode expands RGBA5551 correctly', () => {
  const s = E.makeState();
  // one white pixel then one pure red pixel at the framebuffer origin
  E.write16(s, 0x80100000, 0xFFFF);
  E.write16(s, 0x80100002, 0xF801);
  const out = E.framebufferRGBA(s, new Uint8Array(320 * 240 * 4));
  deepEq(Array.from(out.slice(0, 8)), [255, 255, 255, 255, 255, 0, 0, 255]);
});

/* ================= Sega Dreamcast (SH-4) side ================= */
const dcSandbox = { module: { exports: {} } };
dcSandbox.self = dcSandbox;
vm.createContext(dcSandbox);
vm.runInContext(readFileSync(join(ROOT, 'ultra', 'dc-engine.js'), 'utf8'), dcSandbox, { filename: 'ultra/dc-engine.js' });
const D = dcSandbox.module.exports;

// Assemble one SH-4 program, boot a console with it, run N steps, return state.
function runDc(src, steps = 200) {
  const asm = D.assemble(src);
  assert.equal(asm.ok, true, 'assembles clean: ' + asm.errors.join('; '));
  const s = D.makeState();
  D.loadProgram(s, asm.bytes, asm.base);
  D.run(s, steps);
  return s;
}

test('DC: SH-4 assembler emits canonical encodings', () => {
  const words = (src) => {
    const b = D.assemble(src).bytes;
    return [b[0] | (b[1] << 8)];
  };
  deepEq(words('mov #5, r1'), [0xE105]);
  deepEq(words('add #-1, r2'), [0x72FF]);
  deepEq(words('mov r3, r4'), [0x6433]);
  deepEq(words('mov.l @r1, r2'), [0x6212]);
  deepEq(words('mov.w r0, @r4'), [0x2401]);
  deepEq(words('dt r7'), [0x4710]);
  deepEq(words('rts'), [0x000B]);
  deepEq(words('nop'), [0x0009]);
  deepEq(words('tst #0x40, r0'), [0xC840]);
  deepEq(words('cmp/gt r0, r8'), [0x3807]);
  deepEq(words('jsr @r2'), [0x420B]);
  deepEq(words('start: bra start'), [0xAFFE]); // disp -2 in 12 bits
});
test('DC: literal pool loads a 32-bit constant PC-relative', () => {
  const s = runDc('mov.l =0x12345678, r1\nspin: bra spin\nnop', 50);
  assert.equal(s.r[1], 0x12345678);
});
test('DC: arithmetic, shifts, extends', () => {
  const s = runDc([
    'mov #10, r1',
    'add #5, r1        ; 15',
    'mov r1, r2',
    'shll2 r2          ; 60',
    'add r1, r2        ; 75',
    'sub r1, r3        ; 0 - 15',
    'neg r1, r4        ; -15',
    'mov.l =0x8081, r5',
    'exts.b r5, r6     ; 0x81 sign-extends',
    'extu.w r5, r7',
    'spin: bra spin',
    'nop',
  ].join('\n'), 60);
  assert.equal(s.r[1], 15);
  assert.equal(s.r[2], 75);
  assert.equal(s.r[3], -15);
  assert.equal(s.r[4], -15);
  assert.equal(s.r[6], (0x81 << 24) >> 24);
  assert.equal(s.r[7], 0x8081);
});
test('DC: bra has a delay slot; bt does not', () => {
  const s = runDc([
    'mov #0, r3',
    'bra over',
    'add #1, r3        ; delay slot — runs',
    'add #8, r3        ; jumped over',
    'over:',
    'mov #1, r0',
    'cmp/eq #1, r0',
    'bt skip',
    'add #16, r3       ; bt taken with NO delay slot — must not run',
    'skip:',
    'spin: bra spin',
    'nop',
  ].join('\n'), 60);
  assert.equal(s.r[3], 1);
  assert.equal(s.t, 1);
});
test('DC: bsr/rts round-trip through PR', () => {
  const s = runDc([
    'bsr sub',
    'nop',
    'add #1, r4        ; runs after return',
    'spin: bra spin',
    'nop',
    'sub:',
    'mov #42, r4',
    'rts',
    'nop',
  ].join('\n'), 60);
  assert.equal(s.r[4], 43);
});
test('DC: dt counts down and sets T at zero; mul.l fills MACL', () => {
  const s = runDc([
    'mov #5, r1',
    'loop: dt r1',
    'bf loop',
    'mov.l =12345, r2',
    'mov.l =-7, r3',
    'mul.l r2, r3',
    'sts macl, r4',
    'spin: bra spin',
    'nop',
  ].join('\n'), 100);
  assert.equal(s.r[1], 0);
  assert.equal(s.r[4], 12345 * -7);
});
test('DC: RAM is little-endian (opposite of the N64)', () => {
  const s = runDc([
    'mov.l =0x8C000100, r1',
    'mov.l =0x11223344, r2',
    'mov.l r2, @r1',
    'mov.b @r1, r3     ; LSB lives at the lowest address',
    'spin: bra spin',
    'nop',
  ].join('\n'), 50);
  assert.equal(s.r[3], 0x44);
  assert.equal(D.read16(s, 0x8C000100), 0x3344);
});
test('DC: Maple pad is active-low with the real button bits', () => {
  const s = D.makeState();
  assert.equal(D.read32(s, 0xA05F9000), 0xFFFF, 'nothing pressed = all high');
  D.setButtons(s, D.BUTTONS.A | D.BUTTONS.D_LEFT);
  assert.equal(D.read32(s, 0xA05F9000), (~(0x0004 | 0x0040)) & 0xFFFF);
  assert.equal(D.BUTTONS.START, 0x0008);
});
test('DC: PVR origin latch + vsync strobe', () => {
  const s = D.makeState();
  D.write32(s, 0xA05F8050, 0x1000);
  assert.equal(s.fbOrigin, 0x1000);
  assert.equal(s.frameDone, false);
  D.write32(s, 0xA05F8060, 0);
  assert.equal(s.frameDone, true);
  assert.equal(s.frame, 1);
});
test('DC: an FPU instruction halts with its name', () => {
  const s = D.makeState();
  D.loadProgram(s, new Uint8Array([0x0C, 0xF0]), 0x8C010000); // 0xF00C little-endian
  D.run(s, 5);
  assert.equal(s.halted, true);
  assert.ok(s.stopReason.includes('FPU'), s.stopReason);
});
test('DC: identifyDisc parses an IP.BIN header, flags raw binaries', () => {
  const ip = new Uint8Array(0x100);
  const put = (str, at) => { for (let i = 0; i < str.length; i++) ip[at + i] = str.charCodeAt(i); };
  put('SEGA SEGAKATANA ', 0x00);
  put('SEGA ENTERPRISES', 0x10);
  put('HDR-0042  ', 0x40);
  put('1ST_READ.BIN', 0x60);
  put('ULTRA WAVE DEMO', 0x80);
  const info = D.identifyDisc(ip);
  assert.equal(info.ok, true);
  assert.equal(info.kind, 'ip');
  assert.equal(info.title, 'ULTRA WAVE DEMO');
  assert.equal(info.bootFile, '1ST_READ.BIN');
  assert.equal(info.product, 'HDR-0042');
  const raw = D.identifyDisc(new Uint8Array(64).fill(9));
  assert.equal(raw.kind, 'binary');
  assert.equal(D.identifyDisc(new Uint8Array(4)).ok, false);
});
test('DC: an archive is rejected, not mislabeled a "raw SH-4 binary"', () => {
  const b = new Uint8Array(0x80); b.set([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C], 0); // .7z
  const info = D.identifyDisc(b);
  assert.equal(info.ok, false);
  assert.ok(/\.7z archive/.test(info.error), info.error);
  assert.ok(/extract/.test(info.error));
  const zip = new Uint8Array(0x80); zip.set([0x50, 0x4B, 0x03, 0x04], 0);
  assert.equal(D.identifyDisc(zip).ok, false);
});
test('DC: bootDisc runs the IP.BIN bootstrap entry at +0x300', () => {
  const ip = new Uint8Array(0x400);
  const put = (str, at) => { for (let i = 0; i < str.length; i++) ip[at + i] = str.charCodeAt(i); };
  put('SEGA SEGAKATANA ', 0x00);
  // bootstrap at 0x300: mov #7, r1 ; then an FPU word to stop
  ip[0x300] = 0x07; ip[0x301] = 0xE1;
  ip[0x302] = 0x0C; ip[0x303] = 0xF0;
  const s = D.makeState();
  D.bootDisc(s, D.identifyDisc(ip));
  assert.equal(s.pc >>> 0, 0x8C008300);
  D.run(s, 10);
  assert.equal(s.r[1], 7);
  assert.equal(s.halted, true);
});
test('DC: waves demo paints a deterministic, animated RGB565 frame', () => {
  const a = D.bootDemo('waves');
  const steps = D.runFrame(a, 2500000);
  assert.equal(a.frameDone, true, 'frame completed inside the budget (' + steps + ' steps)');
  assert.equal(a.halted, false, a.stopReason);
  const fb1 = D.framebufferRGBA(a, new Uint8Array(320 * 240 * 4));
  assert.ok(fb1.some((v, i) => i % 4 === 1 && v > 100), 'green plasma present');
  const b = D.bootDemo('waves');
  D.runFrame(b, 2500000);
  const fb2 = D.framebufferRGBA(b, new Uint8Array(320 * 240 * 4));
  deepEq(Array.from(fb1.slice(0, 4000)), Array.from(fb2.slice(0, 4000)));
  D.runFrame(b, 2500000);
  const fb3 = D.framebufferRGBA(b, new Uint8Array(320 * 240 * 4));
  assert.notEqual(JSON.stringify(Array.from(fb2.slice(0, 4000))), JSON.stringify(Array.from(fb3.slice(0, 4000))));
});
test('DC: pad demo steers the block with active-low Maple bits', () => {
  const s = D.bootDemo('pad');
  D.runFrame(s, 2500000);
  assert.equal(s.frameDone, true);
  assert.equal(D.read32(s, 0x8C000200), 152, 'block starts centered');
  assert.equal(D.read32(s, 0x8C000204), 112);
  D.setButtons(s, D.BUTTONS.D_RIGHT);
  D.runFrame(s, 2500000);
  assert.equal(D.read32(s, 0x8C000200), 155, 'block slid right by 3');
  D.setButtons(s, D.BUTTONS.D_UP);
  D.runFrame(s, 2500000);
  assert.equal(D.read32(s, 0x8C000204), 109, 'block slid up by 3');
  D.setButtons(s, 0);
  for (let i = 0; i < 30; i++) D.runFrame(s, 2500000);
  assert.equal(s.halted, false, s.stopReason);
  assert.equal(s.frame, 33);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nultra: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);
