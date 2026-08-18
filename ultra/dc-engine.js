/* Ultra DC — the Sega Dreamcast side of the Ultra emulator, as a pure engine.
 * =====================================================================
 * A second console core alongside the N64's MIPS interpreter in engine.js:
 * the Dreamcast's CPU is a Hitachi SH-4 — 16-bit fixed-width instructions,
 * little-endian, sixteen GPRs, a T (test) bit instead of compare-into-
 * register, a PR link register, and delayed branches. This file implements
 * a deterministic SH-4 integer-subset interpreter (delay slots, MACL,
 * PC-relative literal pools), little-endian main RAM + VRAM, a simplified
 * PowerVR framebuffer scanout in RGB565 (the DC's common pixel format), a
 * Maple controller word using the real active-low button bits, an SH-4
 * assembler with literal-pool support, a disassembler, IP.BIN /
 * 1ST_READ.BIN identification, and two homebrew demos written in SH-4
 * assembly and assembled in-engine.
 *
 * Honest scope: integer SH-4 only. No PowerVR tile accelerator (3D), no
 * FPU, no AICA audio, no Maple DMA, no BIOS/syscalls — so real disc dumps
 * are identified and their bootstrap genuinely executed, but they halt at
 * the first instruction outside this subset (the UI names it). The
 * bundled demos are real SH-4 programs and run fully.
 *
 * Unit-tested in scripts/test-ultra-logic.mjs, rendered by index.html.
 * Classic script on purpose — browser <script>, smoke sandbox, and
 * module.exports all load the same file.
 */
(function (root) {
  'use strict';

  /* ================= machine constants ================= */

  var RAM_SIZE = 0x200000;         // 2 MB slice of the 16 MB main RAM
  var VRAM_SIZE = 0x100000;        // 1 MB slice of the 8 MB VRAM
  var RAM_PHYS = 0x0C000000;       // main RAM physical base (P1 = 0x8C000000)
  var VRAM_PHYS = 0x05000000;      // VRAM physical base (P2 = 0xA5000000)
  var BIN_LOAD = 0x8C010000;       // where 1ST_READ.BIN loads on a real DC
  var IP_LOAD = 0x8C008000;        // where IP.BIN loads; bootstrap entry +0x300
  var SCREEN_W = 320, SCREEN_H = 240;

  // Simplified PowerVR/Maple MMIO (physical addresses, reached through P2)
  var PVR_FB_SOF = 0x005F8050;     // framebuffer start offset in VRAM (real FB_R_SOF1)
  var PVR_VSYNC = 0x005F8060;      // demo convention: any write = end of frame
  var MAPLE_PAD = 0x005F9000;      // controller condition word (active low)

  // Real Dreamcast controller bits (Maple condition word). Active LOW on
  // the wire — setButtons takes pressed-high and stores the inverted word.
  var BUTTONS = {
    A: 0x0004, B: 0x0002, X: 0x0400, Y: 0x0200, START: 0x0008,
    D_UP: 0x0010, D_DOWN: 0x0020, D_LEFT: 0x0040, D_RIGHT: 0x0080,
  };

  /* ================= console state ================= */

  function makeState() {
    return {
      ram: new Uint8Array(RAM_SIZE),
      vram: new Uint8Array(VRAM_SIZE),
      r: new Int32Array(16),
      pr: 0, mach: 0, macl: 0, t: 0,
      pc: 0, nextPc: 0,
      cycles: 0,
      halted: true, stopReason: 'no program loaded', stopPc: 0,
      frame: 0, frameDone: false,
      pad: 0xFFFF,                 // active low: all released
      fbOrigin: 0,
      romName: '',
    };
  }

  function setButtons(s, mask) { s.pad = (~mask) & 0xFFFF; }

  /* ================= memory (little-endian) ================= */

  function phys(a) { return (a >>> 0) & 0x1FFFFFFF; } // strip P1/P2 mirrors

  function region(s, p) {
    if (p >= RAM_PHYS && p < RAM_PHYS + RAM_SIZE) return { b: s.ram, o: p - RAM_PHYS };
    if (p >= VRAM_PHYS && p < VRAM_PHYS + VRAM_SIZE) return { b: s.vram, o: p - VRAM_PHYS };
    return null;
  }
  function read8(s, addr) {
    var g = region(s, phys(addr));
    return g ? g.b[g.o] : (mmioRead(s, phys(addr)) & 0xFF);
  }
  function read16(s, addr) {
    var g = region(s, phys(addr));
    if (g) return g.b[g.o] | (g.b[g.o + 1] << 8);
    return mmioRead(s, phys(addr)) & 0xFFFF;
  }
  function read32(s, addr) {
    var g = region(s, phys(addr));
    if (g) return (g.b[g.o] | (g.b[g.o + 1] << 8) | (g.b[g.o + 2] << 16) | (g.b[g.o + 3] << 24)) >>> 0;
    return mmioRead(s, phys(addr)) >>> 0;
  }
  function write8(s, addr, v) {
    var g = region(s, phys(addr));
    if (g) g.b[g.o] = v & 0xFF; else mmioWrite(s, phys(addr), v >>> 0);
  }
  function write16(s, addr, v) {
    var g = region(s, phys(addr));
    if (g) { g.b[g.o] = v & 0xFF; g.b[g.o + 1] = (v >>> 8) & 0xFF; }
    else mmioWrite(s, phys(addr), v >>> 0);
  }
  function write32(s, addr, v) {
    var g = region(s, phys(addr));
    if (g) { g.b[g.o] = v & 0xFF; g.b[g.o + 1] = (v >>> 8) & 0xFF; g.b[g.o + 2] = (v >>> 16) & 0xFF; g.b[g.o + 3] = (v >>> 24) & 0xFF; }
    else mmioWrite(s, phys(addr), v >>> 0);
  }

  function mmioRead(s, p) {
    if (p === PVR_FB_SOF) return s.fbOrigin;
    if (p === MAPLE_PAD) return s.pad & 0xFFFF;
    return 0;
  }
  function mmioWrite(s, p, v) {
    if (p === PVR_FB_SOF) s.fbOrigin = v & (VRAM_SIZE - 1);
    else if (p === PVR_VSYNC) { s.frameDone = true; s.frame = (s.frame + 1) >>> 0; }
    // everything else: open bus
  }

  /* ================= the CPU (SH-4 integer subset) ================= */

  function halt(s, atPc, reason) { s.halted = true; s.stopPc = atPc >>> 0; s.stopReason = reason; }

  function stepOne(s) {
    if (s.halted) return false;
    var pc = s.pc >>> 0;
    var op = read16(s, pc);
    s.pc = s.nextPc >>> 0;
    s.nextPc = (s.pc + 2) >>> 0;
    s.cycles++;
    var r = s.r;
    var n = (op >>> 8) & 0xF, m = (op >>> 4) & 0xF;
    var simm8 = (op << 24) >> 24;
    var d4 = op & 0xF, d8 = op & 0xFF;
    var t;

    switch (op >>> 12) {
      case 0x0:
        if (op === 0x0009) break;                                    // nop
        if (op === 0x000B) { s.nextPc = s.pr >>> 0; break; }         // rts (delayed)
        if ((op & 0xF0FF) === 0x0029) { r[n] = s.t; break; }         // movt
        if ((op & 0xF0FF) === 0x002A) { r[n] = s.pr; break; }        // sts pr,Rn
        if ((op & 0xF0FF) === 0x001A) { r[n] = s.macl; break; }      // sts macl,Rn
        if ((op & 0xF00F) === 0x0007) { s.macl = Math.imul(r[n], r[m]); break; } // mul.l
        halt(s, pc, 'unimplemented SH-4 instruction 0x' + op.toString(16));
        break;
      case 0x1: write32(s, (r[n] + d4 * 4) | 0, r[m]); break;        // mov.l Rm,@(disp,Rn)
      case 0x2:
        switch (op & 0xF) {
          case 0x0: write8(s, r[n], r[m]); break;                    // mov.b Rm,@Rn
          case 0x1: write16(s, r[n], r[m]); break;                   // mov.w
          case 0x2: write32(s, r[n], r[m]); break;                   // mov.l
          case 0x4: r[n] = (r[n] - 1) | 0; write8(s, r[n], r[m]); break;  // mov.b Rm,@-Rn
          case 0x5: r[n] = (r[n] - 2) | 0; write16(s, r[n], r[m]); break;
          case 0x6: r[n] = (r[n] - 4) | 0; write32(s, r[n], r[m]); break;
          case 0x8: s.t = (r[n] & r[m]) === 0 ? 1 : 0; break;        // tst
          case 0x9: r[n] = r[n] & r[m]; break;                       // and
          case 0xA: r[n] = r[n] ^ r[m]; break;                       // xor
          case 0xB: r[n] = r[n] | r[m]; break;                       // or
          default: halt(s, pc, 'unimplemented SH-4 instruction 0x' + op.toString(16));
        }
        break;
      case 0x3:
        switch (op & 0xF) {
          case 0x0: s.t = r[n] === r[m] ? 1 : 0; break;              // cmp/eq
          case 0x2: s.t = (r[n] >>> 0) >= (r[m] >>> 0) ? 1 : 0; break; // cmp/hs
          case 0x3: s.t = r[n] >= r[m] ? 1 : 0; break;               // cmp/ge
          case 0x6: s.t = (r[n] >>> 0) > (r[m] >>> 0) ? 1 : 0; break;  // cmp/hi
          case 0x7: s.t = r[n] > r[m] ? 1 : 0; break;                // cmp/gt
          case 0x8: r[n] = (r[n] - r[m]) | 0; break;                 // sub
          case 0xC: r[n] = (r[n] + r[m]) | 0; break;                 // add
          default: halt(s, pc, 'unimplemented SH-4 instruction 0x' + op.toString(16));
        }
        break;
      case 0x4:
        switch (op & 0xFF) {
          case 0x00: case 0x20: s.t = (r[n] >>> 31) & 1; r[n] = r[n] << 1; break; // shll/shal
          case 0x01: s.t = r[n] & 1; r[n] = r[n] >>> 1; break;       // shlr
          case 0x21: s.t = r[n] & 1; r[n] = r[n] >> 1; break;        // shar
          case 0x08: r[n] = r[n] << 2; break;                        // shll2
          case 0x09: r[n] = r[n] >>> 2; break;                       // shlr2
          case 0x18: r[n] = r[n] << 8; break;                        // shll8
          case 0x19: r[n] = r[n] >>> 8; break;                       // shlr8
          case 0x28: r[n] = r[n] << 16; break;                       // shll16
          case 0x29: r[n] = r[n] >>> 16; break;                      // shlr16
          case 0x10: r[n] = (r[n] - 1) | 0; s.t = r[n] === 0 ? 1 : 0; break; // dt
          case 0x11: s.t = r[n] >= 0 ? 1 : 0; break;                 // cmp/pz
          case 0x15: s.t = r[n] > 0 ? 1 : 0; break;                  // cmp/pl
          case 0x2B: s.nextPc = r[n] >>> 0; break;                   // jmp @Rn (delayed)
          case 0x0B: s.pr = (pc + 4) | 0; s.nextPc = r[n] >>> 0; break; // jsr @Rn
          case 0x2A: s.pr = r[n]; break;                             // lds Rn,pr
          default: halt(s, pc, 'unimplemented SH-4 instruction 0x' + op.toString(16));
        }
        break;
      case 0x5: r[n] = read32(s, (r[m] + d4 * 4) | 0) | 0; break;    // mov.l @(disp,Rm),Rn
      case 0x6:
        switch (op & 0xF) {
          case 0x0: t = read8(s, r[m]); r[n] = (t << 24) >> 24; break;   // mov.b @Rm,Rn
          case 0x1: t = read16(s, r[m]); r[n] = (t << 16) >> 16; break;  // mov.w
          case 0x2: r[n] = read32(s, r[m]) | 0; break;                   // mov.l
          case 0x3: r[n] = r[m]; break;                                  // mov
          case 0x4: t = (read8(s, r[m]) << 24) >> 24; r[m] = (r[m] + 1) | 0; r[n] = t; break; // mov.b @Rm+,Rn
          case 0x5: t = (read16(s, r[m]) << 16) >> 16; r[m] = (r[m] + 2) | 0; r[n] = t; break;
          case 0x6: t = read32(s, r[m]) | 0; r[m] = (r[m] + 4) | 0; r[n] = t; break;
          case 0x7: r[n] = ~r[m]; break;                                 // not
          case 0xB: r[n] = (0 - r[m]) | 0; break;                        // neg
          case 0xC: r[n] = r[m] & 0xFF; break;                           // extu.b
          case 0xD: r[n] = r[m] & 0xFFFF; break;                         // extu.w
          case 0xE: r[n] = (r[m] << 24) >> 24; break;                    // exts.b
          case 0xF: r[n] = (r[m] << 16) >> 16; break;                    // exts.w
          default: halt(s, pc, 'unimplemented SH-4 instruction 0x' + op.toString(16));
        }
        break;
      case 0x7: r[n] = (r[n] + simm8) | 0; break;                    // add #imm,Rn
      case 0x8:
        switch ((op >>> 8) & 0xF) {
          case 0x8: s.t = r[0] === simm8 ? 1 : 0; break;             // cmp/eq #imm,r0
          case 0x9: if (s.t) { t = (pc + 4 + simm8 * 2) >>> 0; s.pc = t; s.nextPc = (t + 2) >>> 0; } break; // bt
          case 0xB: if (!s.t) { t = (pc + 4 + simm8 * 2) >>> 0; s.pc = t; s.nextPc = (t + 2) >>> 0; } break; // bf
          case 0xD: if (s.t) s.nextPc = (pc + 4 + simm8 * 2) >>> 0; break;  // bt/s (delayed)
          case 0xF: if (!s.t) s.nextPc = (pc + 4 + simm8 * 2) >>> 0; break; // bf/s
          default: halt(s, pc, 'unimplemented SH-4 instruction 0x' + op.toString(16));
        }
        break;
      case 0x9: r[n] = (read16(s, (pc + 4 + d8 * 2) >>> 0) << 16) >> 16; break; // mov.w @(disp,PC),Rn
      case 0xA: s.nextPc = (pc + 4 + (((op & 0xFFF) << 20) >> 20) * 2) >>> 0; break; // bra (delayed)
      case 0xB: s.pr = (pc + 4) | 0; s.nextPc = (pc + 4 + (((op & 0xFFF) << 20) >> 20) * 2) >>> 0; break; // bsr
      case 0xC:
        switch ((op >>> 8) & 0xF) {
          case 0x7: r[0] = ((pc & ~3) + 4 + d8 * 4) | 0; break;      // mova
          case 0x8: s.t = (r[0] & d8) === 0 ? 1 : 0; break;          // tst #imm,r0
          case 0x9: r[0] = r[0] & d8; break;                         // and #imm,r0
          case 0xA: r[0] = r[0] ^ d8; break;                         // xor #imm,r0
          case 0xB: r[0] = r[0] | d8; break;                         // or #imm,r0
          default: halt(s, pc, 'unimplemented SH-4 instruction 0x' + op.toString(16) + ' (trap/syscall group)');
        }
        break;
      case 0xD: r[n] = read32(s, ((pc & ~3) + 4 + d8 * 4) >>> 0) | 0; break; // mov.l @(disp,PC),Rn
      case 0xE: r[n] = simm8; break;                                 // mov #imm,Rn
      default: // 0xF — the FPU
        halt(s, pc, 'FPU instruction 0x' + op.toString(16) + ' (SH-4 FPU not implemented)');
    }
    return !s.halted;
  }

  function run(s, maxSteps) {
    var i = 0;
    while (i < maxSteps && stepOne(s)) i++;
    return i;
  }
  function runFrame(s, maxSteps) {
    s.frameDone = false;
    var i = 0;
    while (i < maxSteps && !s.frameDone && stepOne(s)) i++;
    return i;
  }

  /* ================= video out (RGB565, little-endian) ================= */

  function framebufferRGBA(s, out) {
    var origin = s.fbOrigin & (VRAM_SIZE - 1);
    var vr = s.vram, o = 0;
    for (var y = 0; y < SCREEN_H; y++) {
      var row = origin + y * SCREEN_W * 2;
      for (var x = 0; x < SCREEN_W; x++) {
        var p = row + x * 2;
        var v = p + 1 < VRAM_SIZE ? vr[p] | (vr[p + 1] << 8) : 0;
        var r5 = (v >>> 11) & 31, g6 = (v >>> 5) & 63, b5 = v & 31;
        out[o] = (r5 << 3) | (r5 >>> 2);
        out[o + 1] = (g6 << 2) | (g6 >>> 4);
        out[o + 2] = (b5 << 3) | (b5 >>> 2);
        out[o + 3] = 255;
        o += 4;
      }
    }
    return out;
  }

  /* ================= discs & binaries ================= */

  function ascii(bytes, from, to) {
    var out = '';
    for (var i = from; i < to && i < bytes.length; i++) {
      var c = bytes[i];
      out += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
    }
    return out.replace(/\s+$/, '').replace(/^\s+/, '');
  }

  // Compressed archives and disc-image containers are NOT executable code —
  // a .7z/.zip/.rar holds the binary, it isn't one. Detect the common magic
  // bytes so we reject them with a useful message instead of trying to run a
  // container header as SH-4 instructions.
  function detectArchive(bytes) {
    function m(sig, at) { for (var i = 0; i < sig.length; i++) if (bytes[(at || 0) + i] !== sig[i]) return false; return true; }
    if (m([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])) return '.7z archive';
    if (m([0x50, 0x4B, 0x03, 0x04]) || m([0x50, 0x4B, 0x05, 0x06])) return '.zip archive';
    if (m([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07])) return '.rar archive';
    if (m([0x1F, 0x8B])) return '.gz archive';
    if (m([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00])) return '.xz archive';
    if (m([0x42, 0x5A, 0x68])) return '.bz2 archive';
    return null;
  }

  // IP.BIN (the DC boot sector) opens with the hardware ID; a raw,
  // unscrambled 1ST_READ.BIN has no magic at all — that's just how Sega
  // shipped it, so those load as plain binaries with a warning.
  function identifyDisc(bytes) {
    if (!bytes || bytes.length < 16) return { ok: false, error: 'file too small to be Dreamcast code' };
    var arc = detectArchive(bytes);
    if (arc) return { ok: false, error: 'this is a ' + arc + ', not runnable code — extract the IP.BIN or 1ST_READ.BIN inside it and load that' };
    if (ascii(bytes, 0, 16).indexOf('SEGA SEGAKATANA') === 0) {
      if (bytes.length < 0x100) return { ok: false, error: 'IP.BIN header truncated' };
      return {
        ok: true, kind: 'ip', bytes: bytes,
        maker: ascii(bytes, 0x10, 0x20),
        product: ascii(bytes, 0x40, 0x4A),
        bootFile: ascii(bytes, 0x60, 0x70),
        title: ascii(bytes, 0x80, 0x100) || 'UNTITLED',
      };
    }
    return {
      ok: true, kind: 'binary', bytes: bytes,
      title: 'raw SH-4 binary',
      note: 'No IP.BIN magic — treating this as an unscrambled 1ST_READ.BIN-style binary loaded at 0x8C010000.',
    };
  }

  function bootDisc(s, info) {
    var base = info.kind === 'ip' ? IP_LOAD : BIN_LOAD;
    var entry = info.kind === 'ip' ? IP_LOAD + 0x300 : BIN_LOAD; // IP.BIN bootstrap entry
    var dst = phys(base) - RAM_PHYS;
    var len = Math.min(info.bytes.length, RAM_SIZE - dst);
    s.ram.set(info.bytes.subarray(0, len), dst);
    s.pc = entry >>> 0;
    s.nextPc = (entry + 2) >>> 0;
    s.halted = false; s.stopReason = '';
    s.romName = info.title || '';
    return s;
  }

  function loadProgram(s, bytes, base) {
    base = (base == null ? BIN_LOAD : base) >>> 0;
    var dst = phys(base) - RAM_PHYS;
    s.ram.set(bytes.subarray(0, Math.min(bytes.length, RAM_SIZE - dst)), dst);
    s.pc = base; s.nextPc = (base + 2) >>> 0;
    s.halted = false; s.stopReason = '';
    return s;
  }

  /* ================= the SH-4 assembler ================= */

  function parseReg(tok, err) {
    var mm = /^r(\d{1,2})$/i.exec(String(tok || '').trim());
    if (mm && +mm[1] < 16) return +mm[1];
    throw new Error(err + ': bad register "' + tok + '"');
  }
  function parseNum(tok, err) {
    var s2 = String(tok || '').trim();
    if (/^-?0x[0-9a-f]+$/i.test(s2)) return parseInt(s2, 16);
    if (/^-?\d+$/.test(s2)) return parseInt(s2, 10);
    throw new Error(err + ': bad number "' + tok + '"');
  }

  // split operands on top-level commas: "@(4,r2)" stays together
  function splitOps(rest) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < rest.length; i++) {
      var c = rest[i];
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  var CMP_SUB = { eq: 0x0, hs: 0x2, ge: 0x3, hi: 0x6, gt: 0x7 };
  var SHIFT_OPS = {
    shll: 0x00, shal: 0x20, shlr: 0x01, shar: 0x21, shll2: 0x08, shlr2: 0x09,
    shll8: 0x18, shlr8: 0x19, shll16: 0x28, shlr16: 0x29, dt: 0x10,
  };
  var EXT_OPS = { not: 0x7, neg: 0xB, 'extu.b': 0xC, 'extu.w': 0xD, 'exts.b': 0xE, 'exts.w': 0xF };
  var LOGIC_OPS = { tst: 0x8, and: 0x9, xor: 0xA, or: 0xB };
  var LOGIC_IMM = { tst: 0xC8, and: 0xC9, xor: 0xCA, or: 0xCB };
  var MOV_SIZE = { 'mov.b': 0, 'mov.w': 1, 'mov.l': 2 };

  function assemble(source, base) {
    base = (base == null ? BIN_LOAD : base) >>> 0;
    var lines = String(source || '').split('\n');
    var items = [], symbols = {}, errors = [];
    var literals = [], litIndex = {}; // pooled 32-bit constants (raw expression → slot)
    var addr = base;

    // pass 1 — labels, layout, literal collection (every instr is 2 bytes)
    for (var ln = 0; ln < lines.length; ln++) {
      var text = lines[ln].replace(/;.*$|\/\/.*$/g, '').trim(); // ';' and '//' comment; '#' is the SH-4 immediate prefix
      while (true) {
        var lm = /^([A-Za-z_.$][\w.$]*)\s*:/.exec(text);
        if (!lm) break;
        symbols[lm[1]] = addr;
        text = text.slice(lm[0].length).trim();
      }
      if (!text) continue;
      var sp = text.search(/\s/);
      var mn = (sp === -1 ? text : text.slice(0, sp)).toLowerCase().replace('.s', '/s');
      var ops = splitOps(sp === -1 ? '' : text.slice(sp));
      if (mn === 'mov.l' && ops[0] && ops[0][0] === '=') {
        var key = ops[0].slice(1).trim();
        if (!(key in litIndex)) { litIndex[key] = literals.length; literals.push(key); }
      }
      items.push({ mn: mn, ops: ops, err: 'line ' + (ln + 1), addr: addr });
      addr = (addr + 2) >>> 0;
    }
    var poolBase = ((addr + 3) & ~3) >>> 0; // literal pool sits 4-aligned after the code

    // pass 2 — encode
    var code = [];
    function label(tok, err) {
      var t2 = String(tok || '').trim();
      if (t2 in symbols) return symbols[t2] >>> 0;
      return parseNum(t2, err) >>> 0;
    }
    function bdisp(target, at, bits, err) {
      var off = ((target - (at + 4)) | 0) >> 1;
      var lim = 1 << (bits - 1);
      if (off < -lim || off >= lim) throw new Error(err + ': branch out of range');
      return off & ((1 << bits) - 1);
    }

    for (var i = 0; i < items.length; i++) {
      var it = items[i], o = it.ops, err2 = it.err, mn2 = it.mn, w = -1;
      try {
        if (mn2 === 'nop') w = 0x0009;
        else if (mn2 === 'rts') w = 0x000B;
        else if (mn2 === 'bra') w = 0xA000 | bdisp(label(o[0], err2), it.addr, 12, err2);
        else if (mn2 === 'bsr') w = 0xB000 | bdisp(label(o[0], err2), it.addr, 12, err2);
        else if (mn2 === 'bt') w = 0x8900 | bdisp(label(o[0], err2), it.addr, 8, err2);
        else if (mn2 === 'bf') w = 0x8B00 | bdisp(label(o[0], err2), it.addr, 8, err2);
        else if (mn2 === 'bt/s') w = 0x8D00 | bdisp(label(o[0], err2), it.addr, 8, err2);
        else if (mn2 === 'bf/s') w = 0x8F00 | bdisp(label(o[0], err2), it.addr, 8, err2);
        else if (mn2 === 'jmp') w = 0x402B | (parseReg(o[0].replace('@', ''), err2) << 8);
        else if (mn2 === 'jsr') w = 0x400B | (parseReg(o[0].replace('@', ''), err2) << 8);
        else if (mn2 === 'lds') w = 0x402A | (parseReg(o[0], err2) << 8); // lds Rn,pr
        else if (mn2 === 'sts') {
          var src = o[0].toLowerCase();
          w = (src === 'pr' ? 0x002A : 0x001A) | (parseReg(o[1], err2) << 8);
        }
        else if (mn2 === 'mova') w = 0xC700 | ((label(o[0].replace(/^@\(|,pc\)$/gi, ''), err2) - (((it.addr & ~3) >>> 0) + 4)) >> 2 & 0xFF);
        else if (mn2 === 'mul.l') w = 0x0007 | (parseReg(o[1], err2) << 8) | (parseReg(o[0], err2) << 4);
        else if (mn2 === 'movt') w = 0x0029 | (parseReg(o[0], err2) << 8);
        else if (mn2 in SHIFT_OPS) w = 0x4000 | (parseReg(o[0], err2) << 8) | SHIFT_OPS[mn2];
        else if (mn2 === 'cmp/pz') w = 0x4011 | (parseReg(o[0], err2) << 8);
        else if (mn2 === 'cmp/pl') w = 0x4015 | (parseReg(o[0], err2) << 8);
        else if (/^cmp\//.test(mn2)) {
          var cs = CMP_SUB[mn2.slice(4)];
          if (cs === undefined) throw new Error(err2 + ': unknown compare "' + mn2 + '"');
          if (o[0][0] === '#') { // cmp/eq #imm,r0
            if (cs !== 0) throw new Error(err2 + ': only cmp/eq takes #imm');
            w = 0x8800 | (parseNum(o[0].slice(1), err2) & 0xFF);
          } else w = 0x3000 | (parseReg(o[1], err2) << 8) | (parseReg(o[0], err2) << 4) | cs;
        }
        else if (mn2 in EXT_OPS) w = 0x6000 | (parseReg(o[1], err2) << 8) | (parseReg(o[0], err2) << 4) | EXT_OPS[mn2];
        else if (mn2 in LOGIC_OPS && o[0][0] === '#') w = (LOGIC_IMM[mn2] << 8) | (parseNum(o[0].slice(1), err2) & 0xFF);
        else if (mn2 in LOGIC_OPS) w = 0x2000 | (parseReg(o[1], err2) << 8) | (parseReg(o[0], err2) << 4) | LOGIC_OPS[mn2];
        else if (mn2 === 'add' && o[0][0] === '#') w = 0x7000 | (parseReg(o[1], err2) << 8) | (parseNum(o[0].slice(1), err2) & 0xFF);
        else if (mn2 === 'add') w = 0x300C | (parseReg(o[1], err2) << 8) | (parseReg(o[0], err2) << 4);
        else if (mn2 === 'sub') w = 0x3008 | (parseReg(o[1], err2) << 8) | (parseReg(o[0], err2) << 4);
        else if (mn2 === 'mov' && o[0][0] === '#') w = 0xE000 | (parseReg(o[1], err2) << 8) | (parseNum(o[0].slice(1), err2) & 0xFF);
        else if (mn2 === 'mov') w = 0x6003 | (parseReg(o[1], err2) << 8) | (parseReg(o[0], err2) << 4);
        else if (mn2 in MOV_SIZE) {
          var sz = MOV_SIZE[mn2], a0 = o[0], a1 = o[1], mm2;
          if (a0[0] === '=') { // literal-pool pseudo (mov.l only)
            if (sz !== 2) throw new Error(err2 + ': literal pools are mov.l only');
            var slot = litIndex[a0.slice(1).trim()];
            var poolAddr = poolBase + slot * 4;
            var disp = (poolAddr - (((it.addr & ~3) >>> 0) + 4)) >> 2;
            if (disp < 0 || disp > 255) throw new Error(err2 + ': literal pool out of range');
            w = 0xD000 | (parseReg(a1, err2) << 8) | disp;
          } else if ((mm2 = /^@\(\s*([^,]+),\s*(r\d+)\s*\)$/i.exec(a0))) { // mov.l @(disp,Rm),Rn
            if (sz !== 2) throw new Error(err2 + ': @(disp,Rn) supported for mov.l only');
            w = 0x5000 | (parseReg(a1, err2) << 8) | (parseReg(mm2[2], err2) << 4) | ((parseNum(mm2[1], err2) >> 2) & 0xF);
          } else if ((mm2 = /^@\(\s*([^,]+),\s*(r\d+)\s*\)$/i.exec(a1))) { // mov.l Rm,@(disp,Rn)
            if (sz !== 2) throw new Error(err2 + ': @(disp,Rn) supported for mov.l only');
            w = 0x1000 | (parseReg(mm2[2], err2) << 8) | (parseReg(a0, err2) << 4) | ((parseNum(mm2[1], err2) >> 2) & 0xF);
          } else if (a0[0] === '@') { // load
            var post = /\+$/.test(a0);
            w = 0x6000 | (parseReg(a1, err2) << 8) | (parseReg(a0.replace(/[@+]/g, ''), err2) << 4) | (post ? 4 + sz : sz);
          } else if (a1[0] === '@') { // store
            var pre = a1.indexOf('-') !== -1;
            w = 0x2000 | (parseReg(a1.replace(/[@\-+]/g, ''), err2) << 8) | (parseReg(a0, err2) << 4) | (pre ? 4 + sz : sz);
          } else throw new Error(err2 + ': bad mov operands');
        }
        else throw new Error(err2 + ': unknown instruction "' + mn2 + '"');
        code.push(w & 0xFFFF);
      } catch (e) { errors.push(e.message); code.push(0x0009); }
    }

    // emit: code (16-bit LE), pad to pool, literals (32-bit LE)
    var size = (poolBase - base) + literals.length * 4;
    var bytes = new Uint8Array(size);
    for (var c = 0; c < code.length; c++) { bytes[c * 2] = code[c] & 0xFF; bytes[c * 2 + 1] = code[c] >>> 8; }
    for (var l = 0; l < literals.length; l++) {
      var v;
      try { v = label(literals[l], 'literal pool') >>> 0; }
      catch (e2) { errors.push(e2.message); v = 0; }
      var off = (poolBase - base) + l * 4;
      bytes[off] = v & 0xFF; bytes[off + 1] = (v >>> 8) & 0xFF; bytes[off + 2] = (v >>> 16) & 0xFF; bytes[off + 3] = (v >>> 24) & 0xFF;
    }
    return { ok: errors.length === 0, bytes: bytes, errors: errors, symbols: symbols, base: base };
  }

  /* ================= disassembler (debugger panel) ================= */

  function disasm(op, addr) {
    op &= 0xFFFF; addr >>>= 0;
    var n = (op >>> 8) & 0xF, m = (op >>> 4) & 0xF, d4 = op & 0xF, d8 = op & 0xFF;
    var simm = (op << 24) >> 24;
    var b8 = '0x' + ((addr + 4 + simm * 2) >>> 0).toString(16);
    var b12 = '0x' + ((addr + 4 + (((op & 0xFFF) << 20) >> 20) * 2) >>> 0).toString(16);
    var SZ = ['.b', '.w', '.l'];
    switch (op >>> 12) {
      case 0x0:
        if (op === 0x0009) return 'nop';
        if (op === 0x000B) return 'rts';
        if ((op & 0xF0FF) === 0x0029) return 'movt r' + n;
        if ((op & 0xF0FF) === 0x002A) return 'sts pr, r' + n;
        if ((op & 0xF0FF) === 0x001A) return 'sts macl, r' + n;
        if ((op & 0xF00F) === 0x0007) return 'mul.l r' + m + ', r' + n;
        break;
      case 0x1: return 'mov.l r' + m + ', @(' + d4 * 4 + ',r' + n + ')';
      case 0x2: {
        var st = { 0: 'mov.b', 1: 'mov.w', 2: 'mov.l', 8: 'tst', 9: 'and', 10: 'xor', 11: 'or' }[op & 0xF];
        if ((op & 0xF) <= 2) return st + ' r' + m + ', @r' + n;
        if ((op & 0xF) >= 4 && (op & 0xF) <= 6) return 'mov' + SZ[(op & 0xF) - 4] + ' r' + m + ', @-r' + n;
        if (st) return st + ' r' + m + ', r' + n;
        break;
      }
      case 0x3: {
        var c3 = { 0: 'cmp/eq', 2: 'cmp/hs', 3: 'cmp/ge', 6: 'cmp/hi', 7: 'cmp/gt', 8: 'sub', 12: 'add' }[op & 0xF];
        if (c3) return c3 + ' r' + m + ', r' + n;
        break;
      }
      case 0x4: {
        var s4 = { 0x00: 'shll', 0x01: 'shlr', 0x20: 'shal', 0x21: 'shar', 0x08: 'shll2', 0x09: 'shlr2', 0x18: 'shll8', 0x19: 'shlr8', 0x28: 'shll16', 0x29: 'shlr16', 0x10: 'dt', 0x11: 'cmp/pz', 0x15: 'cmp/pl' }[op & 0xFF];
        if (s4) return s4 + ' r' + n;
        if ((op & 0xFF) === 0x2B) return 'jmp @r' + n;
        if ((op & 0xFF) === 0x0B) return 'jsr @r' + n;
        if ((op & 0xFF) === 0x2A) return 'lds r' + n + ', pr';
        break;
      }
      case 0x5: return 'mov.l @(' + d4 * 4 + ',r' + m + '), r' + n;
      case 0x6: {
        var s6 = { 3: 'mov', 7: 'not', 11: 'neg', 12: 'extu.b', 13: 'extu.w', 14: 'exts.b', 15: 'exts.w' }[op & 0xF];
        if ((op & 0xF) <= 2) return 'mov' + SZ[op & 0xF] + ' @r' + m + ', r' + n;
        if ((op & 0xF) >= 4 && (op & 0xF) <= 6) return 'mov' + SZ[(op & 0xF) - 4] + ' @r' + m + '+, r' + n;
        if (s6) return s6 + ' r' + m + ', r' + n;
        break;
      }
      case 0x7: return 'add #' + simm + ', r' + n;
      case 0x8: {
        var b = { 8: 'cmp/eq #' + simm + ', r0', 9: 'bt ' + b8, 11: 'bf ' + b8, 13: 'bt/s ' + b8, 15: 'bf/s ' + b8 }[(op >>> 8) & 0xF];
        if (b) return b;
        break;
      }
      case 0x9: return 'mov.w @(0x' + ((addr + 4 + d8 * 2) >>> 0).toString(16) + '), r' + n;
      case 0xA: return 'bra ' + b12;
      case 0xB: return 'bsr ' + b12;
      case 0xC: {
        var cImm = { 7: 'mova', 8: 'tst', 9: 'and', 10: 'xor', 11: 'or' }[(op >>> 8) & 0xF];
        if (cImm === 'mova') return 'mova @(0x' + (((addr & ~3) + 4 + d8 * 4) >>> 0).toString(16) + '), r0';
        if (cImm) return cImm + ' #' + d8 + ', r0';
        break;
      }
      case 0xD: return 'mov.l @(0x' + (((addr & ~3) + 4 + d8 * 4) >>> 0).toString(16) + '), r' + n;
      case 0xE: return 'mov #' + simm + ', r' + n;
      case 0xF: return 'fpu 0x' + op.toString(16);
    }
    return '.word 0x' + op.toString(16);
  }

  /* ================= built-in demo cartridges ================= */
  /* Real SH-4 programs. Conventions: VRAM framebuffer via P2 at 0xA5000000
   * (RGB565), simplified PVR regs at 0xA05F8050 (origin) / 0xA05F8060
   * (vsync strobe), Maple pad word (ACTIVE LOW) at 0xA05F9000. */

  var WAVES_SRC = [
    '; DC WAVES — teal xor-plasma in RGB565, pure SH-4 with literal pools.',
    'start:',
    '  mov.l =0xA05F8050, r1',
    '  mov   #0, r0',
    '  mov.l r0, @r1            ; framebuffer origin = VRAM+0',
    '  mov   #0, r8             ; frame counter',
    '  mov.l =320, r9',
    '  mov.l =240, r10',
    'frame:',
    '  mov.l =0xA5000000, r4    ; dst = VRAM (P2, uncached)',
    '  mov   #0, r6             ; y',
    '  mov   r10, r11           ; rows remaining',
    'yloop:',
    '  mov   #0, r5             ; x',
    '  mov   r9, r7             ; columns remaining',
    'xloop:',
    '  mov   r5, r0',
    '  add   r8, r0',
    '  xor   r6, r0             ; v = (x + frame) ^ y',
    '  and   #63, r0',
    '  mov   r0, r3',
    '  shll2 r3',
    '  shll2 r3',
    '  shll  r3                 ; green = v << 5 (into the 6-bit green field)',
    '  shlr  r0                 ; blue  = v >> 1',
    '  or    r3, r0',
    '  mov.w r0, @r4',
    '  add   #2, r4',
    '  add   #1, r5',
    '  dt    r7',
    '  bf    xloop',
    '  add   #1, r6',
    '  dt    r11',
    '  bf    yloop',
    '  mov.l =0xA05F8060, r1',
    '  mov.l r0, @r1            ; vsync — frame is done',
    '  add   #1, r8',
    '  bra   frame',
    '  nop                      ; delay slot',
  ].join('\n');

  var PAD_SRC = [
    '; DC PAD — steer the orange block with the d-pad. Maple bits are',
    '; ACTIVE LOW, so tst sets T exactly when a button is held.',
    'start:',
    '  mov.l =0xA05F8050, r1',
    '  mov   #0, r0',
    '  mov.l r0, @r1',
    '  mov.l =152, r8           ; block x',
    '  mov.l =112, r9           ; block y',
    'frame:',
    '  mov.l =0xA5000000, r4    ; clear the screen',
    '  mov.l =76800, r7',
    '  mov.l =0x10A3, r0        ; deep teal background',
    'clr:',
    '  mov.w r0, @r4',
    '  add   #2, r4',
    '  dt    r7',
    '  bf    clr',
    '  mov.l =0xA05F9000, r1    ; read the pad',
    '  mov.l @r1, r0',
    '  mov   r0, r12',
    '  tst   #0x40, r0          ; d-pad left held?',
    '  bf    no_left',
    '  add   #-3, r8',
    'no_left:',
    '  mov   r12, r0',
    '  tst   #0x80, r0          ; right',
    '  bf    no_right',
    '  add   #3, r8',
    'no_right:',
    '  mov   r12, r0',
    '  tst   #0x10, r0          ; up',
    '  bf    no_up',
    '  add   #-3, r9',
    'no_up:',
    '  mov   r12, r0',
    '  tst   #0x20, r0          ; down',
    '  bf    no_down',
    '  add   #3, r9',
    'no_down:',
    '  cmp/pz r8                ; clamp x to 0..304',
    '  bt    cx1',
    '  mov   #0, r8',
    'cx1:',
    '  mov.l =304, r0',
    '  cmp/gt r0, r8',
    '  bf    cx2',
    '  mov   r0, r8',
    'cx2:',
    '  cmp/pz r9                ; clamp y to 0..224',
    '  bt    cy1',
    '  mov   #0, r9',
    'cy1:',
    '  mov.l =224, r0',
    '  cmp/gt r0, r9',
    '  bf    cy2',
    '  mov   r0, r9',
    'cy2:',
    '  mov.l =0x8C000200, r11   ; publish x/y for the debugger',
    '  mov.l r8, @r11',
    '  mov.l r9, @(4,r11)',
    '  mov   r9, r3             ; dst = vram + (y*320 + x)*2',
    '  shll8 r3',
    '  mov   r9, r2',
    '  shll2 r2',
    '  shll2 r2',
    '  shll2 r2',
    '  add   r2, r3',
    '  add   r8, r3',
    '  shll  r3',
    '  mov.l =0xA5000000, r4',
    '  add   r3, r4',
    '  mov   #16, r6            ; a 16x16 block',
    '  mov.l =0xFB2C, r1        ; Dreamcast-swirl orange',
    'row:',
    '  mov   #16, r7',
    '  mov   r4, r2',
    'px:',
    '  mov.w r1, @r2',
    '  add   #2, r2',
    '  dt    r7',
    '  bf    px',
    '  mov.l =640, r0',
    '  add   r0, r4',
    '  dt    r6',
    '  bf    row',
    '  mov.l =0xA05F8060, r1',
    '  mov.l r0, @r1            ; vsync',
    '  bra   frame',
    '  nop',
  ].join('\n');

  var DEMOS = {
    waves: { name: 'DC WAVES', tagline: 'xor plasma, pure SH-4', source: WAVES_SRC },
    pad: { name: 'DC PAD', tagline: 'active-low Maple steering', source: PAD_SRC },
  };

  function bootDemo(key) {
    var demo = DEMOS[key];
    if (!demo) throw new Error('no DC demo named "' + key + '"');
    var asm = assemble(demo.source);
    if (!asm.ok) throw new Error('DC demo "' + key + '" failed to assemble: ' + asm.errors.join('; '));
    var s = makeState();
    loadProgram(s, asm.bytes, asm.base);
    s.romName = demo.name;
    return s;
  }

  /* ================= exports ================= */

  var api = {
    RAM_SIZE: RAM_SIZE, VRAM_SIZE: VRAM_SIZE, SCREEN_W: SCREEN_W, SCREEN_H: SCREEN_H,
    BIN_LOAD: BIN_LOAD, IP_LOAD: IP_LOAD, BUTTONS: BUTTONS,
    makeState: makeState, setButtons: setButtons,
    read8: read8, read16: read16, read32: read32,
    write8: write8, write16: write16, write32: write32,
    step: stepOne, run: run, runFrame: runFrame,
    framebufferRGBA: framebufferRGBA,
    identifyDisc: identifyDisc, bootDisc: bootDisc, loadProgram: loadProgram,
    assemble: assemble, disasm: disasm,
    DEMOS: DEMOS, bootDemo: bootDemo,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UltraDC = api;
})(typeof self !== 'undefined' ? self : this);
