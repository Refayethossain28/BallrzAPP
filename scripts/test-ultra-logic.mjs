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
test('framebuffer decode expands RGBA5551 correctly', () => {
  const s = E.makeState();
  // one white pixel then one pure red pixel at the framebuffer origin
  E.write16(s, 0x80100000, 0xFFFF);
  E.write16(s, 0x80100002, 0xF801);
  const out = E.framebufferRGBA(s, new Uint8Array(320 * 240 * 4));
  deepEq(Array.from(out.slice(0, 8)), [255, 255, 255, 255, 255, 0, 0, 255]);
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
