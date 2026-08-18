/* Ultra — a Nintendo 64 emulator core, as a pure engine.
 * =====================================================================
 * Everything that IS the console lives here as deterministic, clock-free
 * functions with zero DOM and zero I/O: a MIPS R4300i integer-ISA
 * interpreter (with real branch delay slots, HI/LO, big-endian RDRAM), a
 * simplified VI (video interface) that scans out an RGBA5551 framebuffer
 * from RDRAM, a controller port using the real N64 button bit layout, a
 * ROM header identifier/normalizer for .z64/.v64/.n64 byte orders, a
 * two-pass MIPS assembler, a disassembler, and two homebrew demo ROMs
 * written in MIPS assembly and assembled in-engine.
 *
 * Honest scope: this executes the CPU's integer instruction set. There is
 * no RSP, no RDP (3D), no FPU, no TLB and no PIF boot rom — so commercial
 * ROMs are identified and loaded but halt at the first instruction outside
 * that subset (the UI reports exactly which one). The bundled demos are
 * real MIPS programs and run fully.
 *
 * Unit-tested in scripts/test-ultra-logic.mjs, rendered by index.html.
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  /* ================= machine constants ================= */

  var RDRAM_SIZE = 0x400000;       // 4 MB, like a stock console
  var FB_PHYS = 0x100000;          // where the demos park their framebuffer
  var SCREEN_W = 320, SCREEN_H = 240;

  // Simplified MMIO (physical addresses; reached through KSEG1 0xA4xxxxxx)
  var VI_BASE = 0x04400000;        // +0 status, +4 origin, +8 width, +0x10 current
  var VI_STATUS = 0x0, VI_ORIGIN = 0x4, VI_WIDTH = 0x8, VI_CURRENT = 0x10;
  var SI_PAD = 0x04800000;         // controller 1 buttons (simplified SI/PIF)

  // Real N64 controller button bits (standard pad, 16-bit word)
  var BUTTONS = {
    A: 0x8000, B: 0x4000, Z: 0x2000, START: 0x1000,
    D_UP: 0x0800, D_DOWN: 0x0400, D_LEFT: 0x0200, D_RIGHT: 0x0100,
    L: 0x0020, R: 0x0010, C_UP: 0x0008, C_DOWN: 0x0004, C_LEFT: 0x0002, C_RIGHT: 0x0001,
  };

  var REG_NAMES = ('zero at v0 v1 a0 a1 a2 a3 t0 t1 t2 t3 t4 t5 t6 t7 ' +
    's0 s1 s2 s3 s4 s5 s6 s7 t8 t9 k0 k1 gp sp fp ra').split(' ');

  /* ================= console state ================= */

  function makeState() {
    return {
      ram: new Uint8Array(RDRAM_SIZE),
      gpr: new Int32Array(32),
      hi: 0, lo: 0,
      pc: 0, nextPc: 0,
      cycles: 0,
      halted: true, stopReason: 'no program loaded', stopPc: 0,
      frame: 0, frameDone: false,
      pad: 0,
      viStatus: 0, viOrigin: FB_PHYS, viWidth: SCREEN_W,
      romName: '',
    };
  }

  /* ================= memory ================= */

  // KSEG0 (0x80000000 cached) and KSEG1 (0xA0000000 uncached) both map
  // straight onto physical addresses; everything else is passed through.
  function virtToPhys(addr) {
    addr = addr >>> 0;
    if (addr >= 0x80000000 && addr < 0xC0000000) return addr & 0x1FFFFFFF;
    return addr;
  }

  function read8(s, addr) {
    var p = virtToPhys(addr);
    if (p < RDRAM_SIZE) return s.ram[p];
    return (mmioRead(s, p & ~3) >>> ((3 - (p & 3)) * 8)) & 0xFF;
  }
  function read16(s, addr) {
    var p = virtToPhys(addr);
    if (p + 1 < RDRAM_SIZE) return (s.ram[p] << 8) | s.ram[p + 1];
    return (mmioRead(s, p & ~3) >>> ((p & 2) ? 0 : 16)) & 0xFFFF;
  }
  function read32(s, addr) {
    var p = virtToPhys(addr);
    if (p + 3 < RDRAM_SIZE) {
      return ((s.ram[p] << 24) | (s.ram[p + 1] << 16) | (s.ram[p + 2] << 8) | s.ram[p + 3]) >>> 0;
    }
    return mmioRead(s, p) >>> 0;
  }
  function write8(s, addr, v) {
    var p = virtToPhys(addr);
    if (p < RDRAM_SIZE) s.ram[p] = v & 0xFF;
  }
  function write16(s, addr, v) {
    var p = virtToPhys(addr);
    if (p + 1 < RDRAM_SIZE) { s.ram[p] = (v >>> 8) & 0xFF; s.ram[p + 1] = v & 0xFF; }
  }
  function write32(s, addr, v) {
    var p = virtToPhys(addr);
    if (p + 3 < RDRAM_SIZE) {
      s.ram[p] = (v >>> 24) & 0xFF; s.ram[p + 1] = (v >>> 16) & 0xFF;
      s.ram[p + 2] = (v >>> 8) & 0xFF; s.ram[p + 3] = v & 0xFF;
    } else mmioWrite(s, p, v >>> 0);
  }

  function mmioRead(s, p) {
    if (p === VI_BASE + VI_STATUS) return s.viStatus;
    if (p === VI_BASE + VI_ORIGIN) return s.viOrigin;
    if (p === VI_BASE + VI_WIDTH) return s.viWidth;
    if (p === VI_BASE + VI_CURRENT) return s.frame & 0x3FF; // doubles as a frame counter
    if (p === SI_PAD) return s.pad & 0xFFFF;
    return 0; // open bus
  }
  function mmioWrite(s, p, v) {
    if (p === VI_BASE + VI_STATUS) s.viStatus = v >>> 0;
    else if (p === VI_BASE + VI_ORIGIN) s.viOrigin = v & 0x1FFFFFFF;
    else if (p === VI_BASE + VI_WIDTH) s.viWidth = v & 0xFFF;
    else if (p === VI_BASE + VI_CURRENT) { s.frameDone = true; s.frame = (s.frame + 1) >>> 0; } // vsync
    // everything else: ignored (open bus)
  }

  function setButtons(s, mask) { s.pad = mask & 0xFFFF; }

  /* ================= the CPU (MIPS R4300i integer subset) ================= */

  function halt(s, atPc, reason) { s.halted = true; s.stopPc = atPc >>> 0; s.stopReason = reason; }

  // Names for the instructions we DON'T implement, so a real ROM's halt
  // message says what it actually needed.
  var OPC_NAMES = { 17: 'cop1 (FPU)', 18: 'cop2', 20: 'beql', 21: 'bnel', 22: 'blezl', 23: 'bgtzl', 24: 'daddi', 25: 'daddiu', 26: 'ldl', 27: 'ldr', 34: 'lwl', 38: 'lwr', 39: 'lwu', 42: 'swl', 44: 'sdl', 45: 'sdr', 46: 'swr', 49: 'lwc1', 53: 'ldc1', 55: 'ld', 57: 'swc1', 61: 'sdc1', 63: 'sd' };
  var FUNCT_NAMES = { 15: 'sync', 20: 'dsllv', 22: 'dsrlv', 23: 'dsrav', 28: 'dmult', 29: 'dmultu', 30: 'ddiv', 31: 'ddivu', 44: 'dadd', 45: 'daddu', 46: 'dsub', 47: 'dsubu', 48: 'tge', 52: 'teq', 56: 'dsll', 58: 'dsrl', 59: 'dsra', 60: 'dsll32', 62: 'dsrl32', 63: 'dsra32' };

  function stepOne(s) {
    if (s.halted) return false;
    var pc = s.pc >>> 0;
    var op = read32(s, pc) >>> 0;
    s.pc = s.nextPc >>> 0;
    s.nextPc = (s.pc + 4) >>> 0;
    s.cycles++;
    var r = s.gpr;
    var opc = op >>> 26;
    var rs = (op >>> 21) & 31, rt = (op >>> 16) & 31, rd = (op >>> 11) & 31, sa = (op >>> 6) & 31;
    var simm = (op << 16) >> 16;
    var uimm = op & 0xFFFF;
    var t;

    switch (opc) {
      case 0: { // SPECIAL
        var funct = op & 0x3F;
        switch (funct) {
          case 0: r[rd] = r[rt] << sa; break;               // sll
          case 2: r[rd] = r[rt] >>> sa; break;              // srl
          case 3: r[rd] = r[rt] >> sa; break;               // sra
          case 4: r[rd] = r[rt] << (r[rs] & 31); break;     // sllv
          case 6: r[rd] = r[rt] >>> (r[rs] & 31); break;    // srlv
          case 7: r[rd] = r[rt] >> (r[rs] & 31); break;     // srav
          case 8: s.nextPc = r[rs] >>> 0; break;            // jr
          case 9: t = r[rs] >>> 0; r[rd || 31] = (pc + 8) | 0; s.nextPc = t; break; // jalr
          case 12: halt(s, pc, 'syscall'); break;
          case 13: halt(s, pc, 'break'); break;
          case 16: r[rd] = s.hi; break;                     // mfhi
          case 17: s.hi = r[rs]; break;                     // mthi
          case 18: r[rd] = s.lo; break;                     // mflo
          case 19: s.lo = r[rs]; break;                     // mtlo
          case 24: case 25: {                               // mult / multu
            var a = funct === 24 ? BigInt(r[rs]) : BigInt(r[rs] >>> 0);
            var b = funct === 24 ? BigInt(r[rt]) : BigInt(r[rt] >>> 0);
            var prod = a * b;
            s.lo = Number(prod & 0xFFFFFFFFn) | 0;
            s.hi = Number((prod >> 32n) & 0xFFFFFFFFn) | 0;
            break;
          }
          case 26: {                                        // div
            if (r[rt] === 0) { s.lo = r[rs] >= 0 ? -1 : 1; s.hi = r[rs]; }
            else { s.lo = (r[rs] / r[rt]) | 0; s.hi = (r[rs] % r[rt]) | 0; }
            break;
          }
          case 27: {                                        // divu
            var un = r[rs] >>> 0, ud = r[rt] >>> 0;
            if (ud === 0) { s.lo = -1; s.hi = un | 0; }
            else { s.lo = (un / ud) | 0; s.hi = (un % ud) | 0; }
            break;
          }
          case 32: case 33: r[rd] = (r[rs] + r[rt]) | 0; break; // add/addu (no overflow trap)
          case 34: case 35: r[rd] = (r[rs] - r[rt]) | 0; break; // sub/subu
          case 36: r[rd] = r[rs] & r[rt]; break;
          case 37: r[rd] = r[rs] | r[rt]; break;
          case 38: r[rd] = r[rs] ^ r[rt]; break;
          case 39: r[rd] = ~(r[rs] | r[rt]); break;
          case 42: r[rd] = r[rs] < r[rt] ? 1 : 0; break;    // slt
          case 43: r[rd] = (r[rs] >>> 0) < (r[rt] >>> 0) ? 1 : 0; break; // sltu
          default:
            halt(s, pc, 'unimplemented instruction "' + (FUNCT_NAMES[funct] || ('special funct ' + funct)) + '"');
        }
        break;
      }
      case 1: { // REGIMM
        var cond = rt === 0 || rt === 16 ? r[rs] < 0 : r[rs] >= 0; // bltz(al)/bgez(al)
        if (rt === 16 || rt === 17) r[31] = (pc + 8) | 0;
        if (rt <= 1 || rt === 16 || rt === 17) { if (cond) s.nextPc = (s.pc + (simm << 2)) >>> 0; }
        else halt(s, pc, 'unimplemented regimm ' + rt);
        break;
      }
      case 2: s.nextPc = ((s.pc & 0xF0000000) | ((op & 0x3FFFFFF) << 2)) >>> 0; break; // j
      case 3: r[31] = (pc + 8) | 0; s.nextPc = ((s.pc & 0xF0000000) | ((op & 0x3FFFFFF) << 2)) >>> 0; break; // jal
      case 4: if (r[rs] === r[rt]) s.nextPc = (s.pc + (simm << 2)) >>> 0; break; // beq
      case 5: if (r[rs] !== r[rt]) s.nextPc = (s.pc + (simm << 2)) >>> 0; break; // bne
      case 6: if (r[rs] <= 0) s.nextPc = (s.pc + (simm << 2)) >>> 0; break;      // blez
      case 7: if (r[rs] > 0) s.nextPc = (s.pc + (simm << 2)) >>> 0; break;       // bgtz
      case 8: case 9: r[rt] = (r[rs] + simm) | 0; break;    // addi/addiu
      case 10: r[rt] = r[rs] < simm ? 1 : 0; break;         // slti
      case 11: r[rt] = (r[rs] >>> 0) < (simm >>> 0) ? 1 : 0; break; // sltiu
      case 12: r[rt] = r[rs] & uimm; break;                 // andi
      case 13: r[rt] = r[rs] | uimm; break;                 // ori
      case 14: r[rt] = r[rs] ^ uimm; break;                 // xori
      case 15: r[rt] = (uimm << 16) | 0; break;             // lui
      case 16: // COP0 — accept and ignore, so boot code gets further
        if (rs === 0) r[rt] = 0; // mfc0 reads back 0
        break;
      case 32: t = read8(s, (r[rs] + simm) | 0); r[rt] = (t << 24) >> 24; break;  // lb
      case 33: t = read16(s, (r[rs] + simm) | 0); r[rt] = (t << 16) >> 16; break; // lh
      case 35: r[rt] = read32(s, (r[rs] + simm) | 0) | 0; break;                  // lw
      case 36: r[rt] = read8(s, (r[rs] + simm) | 0); break;                       // lbu
      case 37: r[rt] = read16(s, (r[rs] + simm) | 0); break;                      // lhu
      case 40: write8(s, (r[rs] + simm) | 0, r[rt]); break;                       // sb
      case 41: write16(s, (r[rs] + simm) | 0, r[rt]); break;                      // sh
      case 43: write32(s, (r[rs] + simm) | 0, r[rt]); break;                      // sw
      case 47: break; // cache — nop
      default:
        halt(s, pc, 'unimplemented instruction "' + (OPC_NAMES[opc] || ('opcode ' + opc)) + '"');
    }
    r[0] = 0;
    return !s.halted;
  }

  function run(s, maxSteps) {
    var n = 0;
    while (n < maxSteps && stepOne(s)) n++;
    return n;
  }

  // One video frame: execute until the program signals vsync (a write to
  // VI_CURRENT), it halts, or the cycle budget runs out.
  function runFrame(s, maxSteps) {
    s.frameDone = false;
    var n = 0;
    while (n < maxSteps && !s.frameDone && stepOne(s)) n++;
    return n;
  }

  /* ================= video out ================= */

  // Scan the RGBA5551 framebuffer out of RDRAM into an RGBA8888 byte array
  // (320*240*4 long — e.g. an ImageData's .data). Pure read, no DOM.
  function framebufferRGBA(s, out) {
    var origin = s.viOrigin & 0x1FFFFFFF;
    var stride = (s.viWidth || SCREEN_W) * 2;
    var ram = s.ram, o = 0;
    for (var y = 0; y < SCREEN_H; y++) {
      var row = origin + y * stride;
      for (var x = 0; x < SCREEN_W; x++) {
        var p = row + x * 2;
        var v = p + 1 < RDRAM_SIZE ? (ram[p] << 8) | ram[p + 1] : 0;
        var r5 = (v >>> 11) & 31, g5 = (v >>> 6) & 31, b5 = (v >>> 1) & 31;
        out[o] = (r5 << 3) | (r5 >>> 2);
        out[o + 1] = (g5 << 3) | (g5 >>> 2);
        out[o + 2] = (b5 << 3) | (b5 >>> 2);
        out[o + 3] = 255;
        o += 4;
      }
    }
    return out;
  }

  /* ================= ROM cartridges ================= */

  // Identify a ROM dump by its first word and normalize to big-endian .z64.
  // z64 = native big-endian, v64 = 16-bit byteswapped, n64 = 32-bit little.
  function identifyRom(bytes) {
    if (!bytes || bytes.length < 0x40) return { ok: false, error: 'file too small to be an N64 ROM' };
    var b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];
    var format = null;
    if (b0 === 0x80 && b1 === 0x37 && b2 === 0x12 && b3 === 0x40) format = 'z64';
    else if (b0 === 0x37 && b1 === 0x80 && b2 === 0x40 && b3 === 0x12) format = 'v64';
    else if (b0 === 0x40 && b1 === 0x12 && b2 === 0x37 && b3 === 0x80) format = 'n64';
    if (!format) return { ok: false, error: 'no N64 ROM magic (0x80371240) in any byte order' };
    var be = normalizeRom(bytes, format);
    var entry = ((be[8] << 24) | (be[9] << 16) | (be[10] << 8) | be[11]) >>> 0;
    var crc1 = ((be[0x10] << 24) | (be[0x11] << 16) | (be[0x12] << 8) | be[0x13]) >>> 0;
    var crc2 = ((be[0x14] << 24) | (be[0x15] << 16) | (be[0x16] << 8) | be[0x17]) >>> 0;
    var name = '';
    for (var i = 0x20; i < 0x34; i++) { var c = be[i]; name += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; }
    return { ok: true, format: format, bytes: be, entry: entry, crc1: crc1, crc2: crc2, name: name.replace(/\s+$/, '').replace(/^\s+/, '') };
  }

  function normalizeRom(bytes, format) {
    var be = new Uint8Array(bytes.length);
    if (format === 'z64') { be.set(bytes); return be; }
    for (var i = 0; i + 3 < bytes.length; i += 4) {
      if (format === 'v64') { be[i] = bytes[i + 1]; be[i + 1] = bytes[i]; be[i + 2] = bytes[i + 3]; be[i + 3] = bytes[i + 2]; }
      else { be[i] = bytes[i + 3]; be[i + 1] = bytes[i + 2]; be[i + 2] = bytes[i + 1]; be[i + 3] = bytes[i]; }
    }
    return be;
  }

  // What the IPL3 bootloader does after the header checks: copy the first
  // megabyte of game code (ROM offset 0x1000) to the entry address and jump.
  function bootRom(s, info) {
    var entry = info.entry >>> 0;
    var dst = virtToPhys(entry);
    var len = Math.min(info.bytes.length - 0x1000, 0x100000, RDRAM_SIZE - dst);
    if (dst >= RDRAM_SIZE || len <= 0) { halt(s, entry, 'entry point outside RDRAM'); return s; }
    s.ram.set(info.bytes.subarray(0x1000, 0x1000 + len), dst);
    s.pc = entry;
    s.nextPc = (entry + 4) >>> 0;
    s.halted = false; s.stopReason = ''; s.romName = info.name;
    return s;
  }

  // Load an assembled homebrew program (array of 32-bit words) and point
  // the CPU at it.
  function loadProgram(s, words, base) {
    base = (base == null ? 0x80001000 : base) >>> 0;
    var p = virtToPhys(base);
    for (var i = 0; i < words.length; i++) {
      var w = words[i] >>> 0, q = p + i * 4;
      s.ram[q] = w >>> 24; s.ram[q + 1] = (w >>> 16) & 0xFF; s.ram[q + 2] = (w >>> 8) & 0xFF; s.ram[q + 3] = w & 0xFF;
    }
    s.pc = base; s.nextPc = (base + 4) >>> 0;
    s.halted = false; s.stopReason = '';
    return s;
  }

  /* ================= the assembler ================= */

  var REG_IDX = (function () {
    var m = {};
    for (var i = 0; i < 32; i++) { m[String(i)] = i; m[REG_NAMES[i]] = i; }
    m.s8 = 30;
    return m;
  })();

  function parseReg(tok, err) {
    var t = String(tok || '').replace(/^\$/, '').toLowerCase();
    if (t in REG_IDX) return REG_IDX[t];
    throw new Error(err + ': bad register "' + tok + '"');
  }

  function parseNum(tok, err) {
    var t = String(tok || '').trim();
    if (/^-?0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    throw new Error(err + ': bad number "' + tok + '"');
  }

  // fmt: how the operand list maps into the encoding.
  var OPS = {
    sll: { fmt: 'rd,rt,sa', funct: 0 }, srl: { fmt: 'rd,rt,sa', funct: 2 }, sra: { fmt: 'rd,rt,sa', funct: 3 },
    sllv: { fmt: 'rd,rt,rs', funct: 4 }, srlv: { fmt: 'rd,rt,rs', funct: 6 }, srav: { fmt: 'rd,rt,rs', funct: 7 },
    jr: { fmt: 'rs', funct: 8 }, jalr: { fmt: 'jalr', funct: 9 },
    syscall: { fmt: 'none', funct: 12 }, break: { fmt: 'none', funct: 13 },
    mfhi: { fmt: 'rd', funct: 16 }, mthi: { fmt: 'rs', funct: 17 },
    mflo: { fmt: 'rd', funct: 18 }, mtlo: { fmt: 'rs', funct: 19 },
    mult: { fmt: 'rs,rt', funct: 24 }, multu: { fmt: 'rs,rt', funct: 25 },
    div: { fmt: 'rs,rt', funct: 26 }, divu: { fmt: 'rs,rt', funct: 27 },
    add: { fmt: 'rd,rs,rt', funct: 32 }, addu: { fmt: 'rd,rs,rt', funct: 33 },
    sub: { fmt: 'rd,rs,rt', funct: 34 }, subu: { fmt: 'rd,rs,rt', funct: 35 },
    and: { fmt: 'rd,rs,rt', funct: 36 }, or: { fmt: 'rd,rs,rt', funct: 37 },
    xor: { fmt: 'rd,rs,rt', funct: 38 }, nor: { fmt: 'rd,rs,rt', funct: 39 },
    slt: { fmt: 'rd,rs,rt', funct: 42 }, sltu: { fmt: 'rd,rs,rt', funct: 43 },
    bltz: { fmt: 'rs,label', opc: 1, rt: 0 }, bgez: { fmt: 'rs,label', opc: 1, rt: 1 },
    bltzal: { fmt: 'rs,label', opc: 1, rt: 16 }, bgezal: { fmt: 'rs,label', opc: 1, rt: 17 },
    j: { fmt: 'target', opc: 2 }, jal: { fmt: 'target', opc: 3 },
    beq: { fmt: 'rs,rt,label', opc: 4 }, bne: { fmt: 'rs,rt,label', opc: 5 },
    blez: { fmt: 'rs,label', opc: 6, rt: 0 }, bgtz: { fmt: 'rs,label', opc: 7, rt: 0 },
    addi: { fmt: 'rt,rs,imm', opc: 8 }, addiu: { fmt: 'rt,rs,imm', opc: 9 },
    slti: { fmt: 'rt,rs,imm', opc: 10 }, sltiu: { fmt: 'rt,rs,imm', opc: 11 },
    andi: { fmt: 'rt,rs,imm', opc: 12 }, ori: { fmt: 'rt,rs,imm', opc: 13 }, xori: { fmt: 'rt,rs,imm', opc: 14 },
    lui: { fmt: 'rt,imm', opc: 15 },
    lb: { fmt: 'mem', opc: 32 }, lh: { fmt: 'mem', opc: 33 }, lw: { fmt: 'mem', opc: 35 },
    lbu: { fmt: 'mem', opc: 36 }, lhu: { fmt: 'mem', opc: 37 },
    sb: { fmt: 'mem', opc: 40 }, sh: { fmt: 'mem', opc: 41 }, sw: { fmt: 'mem', opc: 43 },
  };

  function splitOperands(rest) {
    return rest.trim() === '' ? [] : rest.split(',').map(function (x) { return x.trim(); });
  }

  // Size (in instructions) of one parsed line — pseudo-ops can expand.
  function lineSize(mn, ops, err) {
    if (mn === '.word') return ops.length;
    if (mn === 'li') {
      var v = parseNum(ops[1], err);
      return v >= -32768 && v <= 65535 ? 1 : 2;
    }
    if (mn === 'la') return 2;
    return 1;
  }

  function assemble(source, base) {
    base = (base == null ? 0x80001000 : base) >>> 0;
    var lines = String(source || '').split('\n');
    var items = [];      // {mn, ops, line, addr}
    var symbols = {};
    var errors = [];
    var addr = base;

    // pass 1 — labels and layout
    for (var ln = 0; ln < lines.length; ln++) {
      var text = lines[ln].replace(/[;#].*$|\/\/.*$/g, '').trim();
      while (true) {
        var lm = /^([A-Za-z_.$][\w.$]*)\s*:/.exec(text);
        if (!lm) break;
        symbols[lm[1]] = addr;
        text = text.slice(lm[0].length).trim();
      }
      if (!text) continue;
      var sp = text.search(/\s/);
      var mn = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();
      var ops = splitOperands(sp === -1 ? '' : text.slice(sp));
      var err = 'line ' + (ln + 1);
      try {
        var size = lineSize(mn, ops, err);
        items.push({ mn: mn, ops: ops, err: err, addr: addr });
        addr = (addr + size * 4) >>> 0;
      } catch (e) { errors.push(e.message); }
    }

    // pass 2 — encode
    var words = [];
    function label(tok, err) {
      if (tok in symbols) return symbols[tok] >>> 0;
      return parseNum(tok, err) >>> 0;
    }
    function branchOff(target, at, err) {
      var off = ((target - (at + 4)) | 0) >> 2;
      if (off < -32768 || off > 32767) throw new Error(err + ': branch out of range');
      return off & 0xFFFF;
    }
    function R(rs, rt, rd, sa, funct) { return ((rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | funct) >>> 0; }
    function I(opc, rs, rt, imm) { return ((opc << 26) | (rs << 21) | (rt << 16) | (imm & 0xFFFF)) >>> 0; }

    for (var i = 0; i < items.length; i++) {
      var it = items[i], o = it.ops, err2 = it.err, def = OPS[it.mn];
      try {
        if (it.mn === '.word') { for (var w = 0; w < o.length; w++) words.push(label(o[w], err2) >>> 0); continue; }
        if (it.mn === 'nop') { words.push(0); continue; }
        if (it.mn === 'move') { words.push(R(parseReg(o[1], err2), 0, parseReg(o[0], err2), 0, 37)); continue; } // or rd,rs,$0
        if (it.mn === 'b') { words.push(I(4, 0, 0, branchOff(label(o[0], err2), it.addr, err2))); continue; }
        if (it.mn === 'beqz') { words.push(I(4, parseReg(o[0], err2), 0, branchOff(label(o[1], err2), it.addr, err2))); continue; }
        if (it.mn === 'bnez') { words.push(I(5, parseReg(o[0], err2), 0, branchOff(label(o[1], err2), it.addr, err2))); continue; }
        if (it.mn === 'li') {
          var rv = parseReg(o[0], err2), v = parseNum(o[1], err2);
          if (v >= -32768 && v < 0) words.push(I(9, 0, rv, v));            // addiu
          else if (v >= 0 && v <= 65535) words.push(I(13, 0, rv, v));      // ori
          else { words.push(I(15, 0, rv, (v >>> 16) & 0xFFFF)); words.push(I(13, rv, rv, v & 0xFFFF)); }
          continue;
        }
        if (it.mn === 'la') {
          var rl = parseReg(o[0], err2), av = label(o[1], err2);
          words.push(I(15, 0, rl, (av >>> 16) & 0xFFFF));
          words.push(I(13, rl, rl, av & 0xFFFF));
          continue;
        }
        if (!def) throw new Error(err2 + ': unknown instruction "' + it.mn + '"');
        switch (def.fmt) {
          case 'rd,rs,rt': words.push(R(parseReg(o[1], err2), parseReg(o[2], err2), parseReg(o[0], err2), 0, def.funct)); break;
          case 'rd,rt,sa': words.push(R(0, parseReg(o[1], err2), parseReg(o[0], err2), parseNum(o[2], err2) & 31, def.funct)); break;
          case 'rd,rt,rs': words.push(R(parseReg(o[2], err2), parseReg(o[1], err2), parseReg(o[0], err2), 0, def.funct)); break;
          case 'rs': words.push(R(parseReg(o[0], err2), 0, 0, 0, def.funct)); break;
          case 'rd': words.push(R(0, 0, parseReg(o[0], err2), 0, def.funct)); break;
          case 'rs,rt': words.push(R(parseReg(o[0], err2), parseReg(o[1], err2), 0, 0, def.funct)); break;
          case 'jalr': {
            if (o.length === 1) words.push(R(parseReg(o[0], err2), 0, 31, 0, 9));
            else words.push(R(parseReg(o[1], err2), 0, parseReg(o[0], err2), 0, 9));
            break;
          }
          case 'none': words.push(R(0, 0, 0, 0, def.funct)); break;
          case 'rs,label': words.push(I(def.opc, parseReg(o[0], err2), def.rt, branchOff(label(o[1], err2), it.addr, err2))); break;
          case 'rs,rt,label': words.push(I(def.opc, parseReg(o[0], err2), parseReg(o[1], err2), branchOff(label(o[2], err2), it.addr, err2))); break;
          case 'target': {
            var tv = label(o[0], err2);
            words.push(((def.opc << 26) | ((tv >>> 2) & 0x3FFFFFF)) >>> 0);
            break;
          }
          case 'rt,rs,imm': words.push(I(def.opc, parseReg(o[1], err2), parseReg(o[0], err2), parseNum(o[2], err2))); break;
          case 'rt,imm': words.push(I(def.opc, 0, parseReg(o[0], err2), parseNum(o[1], err2))); break;
          case 'mem': {
            var mm = /^(-?\w*)\s*\(\s*(\$?\w+)\s*\)$/.exec(o[1] || '');
            if (!mm) throw new Error(err2 + ': bad memory operand "' + o[1] + '"');
            var off = mm[1] === '' ? 0 : parseNum(mm[1], err2);
            words.push(I(def.opc, parseReg(mm[2], err2), parseReg(o[0], err2), off));
            break;
          }
          default: throw new Error(err2 + ': internal format ' + def.fmt);
        }
      } catch (e) { errors.push(e.message); }
    }

    return { ok: errors.length === 0, words: words, errors: errors, symbols: symbols, base: base };
  }

  /* ================= disassembler (for the debugger panel) ================= */

  function rn(i) { return '$' + REG_NAMES[i]; }
  function hex(v) { return '0x' + (v >>> 0).toString(16); }

  function disasm(word, addr) {
    word = word >>> 0; addr = addr >>> 0;
    if (word === 0) return 'nop';
    var opc = word >>> 26, rs = (word >>> 21) & 31, rt = (word >>> 16) & 31,
      rd = (word >>> 11) & 31, sa = (word >>> 6) & 31, funct = word & 0x3F;
    var simm = (word << 16) >> 16;
    var btgt = hex(addr + 4 + (simm << 2));
    var jtgt = hex(((addr + 4) & 0xF0000000) | ((word & 0x3FFFFFF) << 2));
    var F = {
      0: 'sll', 2: 'srl', 3: 'sra', 4: 'sllv', 6: 'srlv', 7: 'srav', 32: 'add', 33: 'addu',
      34: 'sub', 35: 'subu', 36: 'and', 37: 'or', 38: 'xor', 39: 'nor', 42: 'slt', 43: 'sltu',
    };
    var IMM = { 8: 'addi', 9: 'addiu', 10: 'slti', 11: 'sltiu', 12: 'andi', 13: 'ori', 14: 'xori' };
    var MEM = { 32: 'lb', 33: 'lh', 35: 'lw', 36: 'lbu', 37: 'lhu', 40: 'sb', 41: 'sh', 43: 'sw' };
    if (opc === 0) {
      if (funct === 8) return 'jr ' + rn(rs);
      if (funct === 9) return 'jalr ' + rn(rd) + ', ' + rn(rs);
      if (funct === 12) return 'syscall';
      if (funct === 13) return 'break';
      if (funct === 16) return 'mfhi ' + rn(rd);
      if (funct === 17) return 'mthi ' + rn(rs);
      if (funct === 18) return 'mflo ' + rn(rd);
      if (funct === 19) return 'mtlo ' + rn(rs);
      if (funct === 24 || funct === 25 || funct === 26 || funct === 27) {
        return ({ 24: 'mult', 25: 'multu', 26: 'div', 27: 'divu' })[funct] + ' ' + rn(rs) + ', ' + rn(rt);
      }
      if (funct === 0 || funct === 2 || funct === 3) return F[funct] + ' ' + rn(rd) + ', ' + rn(rt) + ', ' + sa;
      if (funct === 4 || funct === 6 || funct === 7) return F[funct] + ' ' + rn(rd) + ', ' + rn(rt) + ', ' + rn(rs);
      if (F[funct]) return F[funct] + ' ' + rn(rd) + ', ' + rn(rs) + ', ' + rn(rt);
      return '.word ' + hex(word);
    }
    if (opc === 1) {
      var RI = { 0: 'bltz', 1: 'bgez', 16: 'bltzal', 17: 'bgezal' };
      if (RI[rt]) return RI[rt] + ' ' + rn(rs) + ', ' + btgt;
      return '.word ' + hex(word);
    }
    if (opc === 2) return 'j ' + jtgt;
    if (opc === 3) return 'jal ' + jtgt;
    if (opc === 4) return (rs === 0 && rt === 0 ? 'b ' + btgt : 'beq ' + rn(rs) + ', ' + rn(rt) + ', ' + btgt);
    if (opc === 5) return 'bne ' + rn(rs) + ', ' + rn(rt) + ', ' + btgt;
    if (opc === 6) return 'blez ' + rn(rs) + ', ' + btgt;
    if (opc === 7) return 'bgtz ' + rn(rs) + ', ' + btgt;
    if (IMM[opc]) return IMM[opc] + ' ' + rn(rt) + ', ' + rn(rs) + ', ' + simm;
    if (opc === 15) return 'lui ' + rn(rt) + ', ' + hex(word & 0xFFFF);
    if (opc === 16) return 'cop0';
    if (opc === 47) return 'cache';
    if (MEM[opc]) return MEM[opc] + ' ' + rn(rt) + ', ' + simm + '(' + rn(rs) + ')';
    return '.word ' + hex(word);
  }

  /* ================= built-in demo cartridges ================= */
  /* Real MIPS programs. Conventions: framebuffer at virtual 0x80100000
   * (physical 0x100000), VI registers via KSEG1 at 0xA4400000, controller
   * buttons at 0xA4800000. A frame ends with a store to VI_CURRENT. */

  var GRADIENT_SRC = [
    '; ULTRA GRADIENT — scrolling rainbow bands, straight into the framebuffer.',
    'start:',
    '  lui   $t0, 0xA440        ; VI registers (KSEG1)',
    '  lui   $t1, 0x0010',
    '  sw    $t1, 4($t0)        ; VI_ORIGIN = 0x00100000',
    '  li    $t2, 320',
    '  sw    $t2, 8($t0)        ; VI_WIDTH = 320',
    'frame:',
    '  lw    $s0, 16($t0)       ; frame counter (VI_CURRENT)',
    '  lui   $t9, 0x8010        ; dst = framebuffer',
    '  or    $s1, $zero, $zero  ; y = 0',
    'row:',
    '  addu  $t1, $s1, $s0      ; t = y + frame',
    '  or    $a0, $t1, $zero    ; r5 = tri(t)',
    '  jal   tri',
    '  nop',
    '  or    $s2, $v0, $zero',
    '  addiu $a0, $t1, 21       ; g5 = tri(t + 21)',
    '  jal   tri',
    '  nop',
    '  or    $s3, $v0, $zero',
    '  addiu $a0, $t1, 42       ; b5 = tri(t + 42)',
    '  jal   tri',
    '  nop',
    '  sll   $s2, $s2, 11       ; color = r<<11 | g<<6 | b<<1 | 1  (RGBA5551)',
    '  sll   $s3, $s3, 6',
    '  or    $s2, $s2, $s3',
    '  sll   $v0, $v0, 1',
    '  or    $s2, $s2, $v0',
    '  ori   $s2, $s2, 1',
    '  li    $t3, 320           ; fill one 320px row',
    'col:',
    '  sh    $s2, 0($t9)',
    '  addiu $t3, $t3, -1',
    '  bne   $t3, $zero, col',
    '  addiu $t9, $t9, 2        ; delay slot: advance dst',
    '  addiu $s1, $s1, 1',
    '  slti  $t4, $s1, 240',
    '  bne   $t4, $zero, row',
    '  nop',
    '  sw    $zero, 16($t0)     ; vsync — frame is done',
    '  j     frame',
    '  nop',
    '',
    '; tri(v): fold v&63 into a 0..31 triangle wave. In: $a0, out: $v0.',
    'tri:',
    '  andi  $a0, $a0, 63',
    '  slti  $t5, $a0, 32',
    '  bne   $t5, $zero, tri_done',
    '  or    $v0, $a0, $zero    ; delay slot: v0 = v',
    '  li    $t6, 63',
    '  subu  $v0, $t6, $a0',
    'tri_done:',
    '  jr    $ra',
    '  nop',
  ].join('\n');

  var PONG_SRC = [
    '; ULTRA PONG — d-pad slides the paddle, gold ball, green score dots.',
    'start:',
    '  lui   $t0, 0xA440        ; VI registers',
    '  lui   $t1, 0x0010',
    '  sw    $t1, 4($t0)        ; VI_ORIGIN = 0x00100000',
    '  li    $t2, 320',
    '  sw    $t2, 8($t0)',
    '  li    $s0, 157           ; ball x',
    '  li    $s1, 80            ; ball y',
    '  li    $s2, 2             ; ball dx',
    '  li    $s3, 2             ; ball dy',
    '  li    $s4, 140           ; paddle x',
    '  or    $s6, $zero, $zero  ; score',
    '',
    'frame:',
    '  lui   $t1, 0xA480        ; controller port',
    '  lw    $t2, 0($t1)',
    '  andi  $t3, $t2, 0x0200   ; D-pad left',
    '  beq   $t3, $zero, no_left',
    '  nop',
    '  addiu $s4, $s4, -4',
    'no_left:',
    '  andi  $t3, $t2, 0x0100   ; D-pad right',
    '  beq   $t3, $zero, no_right',
    '  nop',
    '  addiu $s4, $s4, 4',
    'no_right:',
    '  bgez  $s4, clamp_hi      ; clamp paddle to 0..280',
    '  nop',
    '  or    $s4, $zero, $zero',
    'clamp_hi:',
    '  slti  $t3, $s4, 281',
    '  bne   $t3, $zero, physics',
    '  nop',
    '  li    $s4, 280',
    '',
    'physics:',
    '  addu  $s0, $s0, $s2',
    '  addu  $s1, $s1, $s3',
    '  bgtz  $s0, wall_r        ; left wall',
    '  nop',
    '  subu  $s2, $zero, $s2',
    'wall_r:',
    '  slti  $t3, $s0, 314      ; right wall',
    '  bne   $t3, $zero, wall_t',
    '  nop',
    '  subu  $s2, $zero, $s2',
    'wall_t:',
    '  bgtz  $s1, paddle_zone   ; ceiling',
    '  nop',
    '  subu  $s3, $zero, $s3',
    'paddle_zone:',
    '  slti  $t3, $s1, 214      ; above the paddle line?',
    '  bne   $t3, $zero, draw',
    '  nop',
    '  addiu $t4, $s0, 6        ; ball right edge vs paddle left',
    '  slt   $t5, $t4, $s4',
    '  bne   $t5, $zero, miss',
    '  nop',
    '  addiu $t4, $s4, 40       ; paddle right edge vs ball left',
    '  slt   $t5, $t4, $s0',
    '  bne   $t5, $zero, miss',
    '  nop',
    '  subu  $s3, $zero, $s3    ; hit: bounce up, score++',
    '  li    $s1, 213',
    '  b     draw',
    '  addiu $s6, $s6, 1        ; delay slot',
    'miss:',
    '  slti  $t3, $s1, 240      ; let it fall off screen, then reset',
    '  bne   $t3, $zero, draw',
    '  nop',
    '  li    $s0, 157',
    '  li    $s1, 80',
    '  li    $s3, 2',
    '  or    $s6, $zero, $zero',
    '',
    'draw:',
    '  or    $a0, $zero, $zero  ; clear the screen',
    '  or    $a1, $zero, $zero',
    '  li    $a2, 320',
    '  li    $a3, 240',
    '  li    $t8, 0x10D5        ; deep night blue',
    '  jal   fillrect',
    '  nop',
    '  or    $a0, $s4, $zero    ; paddle',
    '  li    $a1, 220',
    '  li    $a2, 40',
    '  li    $a3, 6',
    '  li    $t8, 0xFFFF        ; white',
    '  jal   fillrect',
    '  nop',
    '  or    $a0, $s0, $zero    ; ball',
    '  or    $a1, $s1, $zero',
    '  li    $a2, 6',
    '  li    $a3, 6',
    '  lui   $t8, 0',
    '  ori   $t8, $t8, 0xFE09   ; gold',
    '  jal   fillrect',
    '  nop',
    '  or    $s7, $s6, $zero    ; score dots (cap at 16)',
    '  slti  $t3, $s7, 17',
    '  bne   $t3, $zero, dots',
    '  nop',
    '  li    $s7, 16',
    'dots:',
    '  or    $s5, $zero, $zero',
    'dot_loop:',
    '  slt   $t3, $s5, $s7',
    '  beq   $t3, $zero, publish',
    '  nop',
    '  sll   $a0, $s5, 3        ; x = 8 + i*8',
    '  addiu $a0, $a0, 8',
    '  li    $a1, 8',
    '  li    $a2, 5',
    '  li    $a3, 4',
    '  li    $t8, 0x0651        ; green',
    '  jal   fillrect',
    '  nop',
    '  b     dot_loop',
    '  addiu $s5, $s5, 1        ; delay slot',
    '',
    'publish:                   ; mirror game state into RDRAM for the debugger',
    '  lui   $t1, 0x8000',
    '  sw    $s0, 0x200($t1)',
    '  sw    $s1, 0x204($t1)',
    '  sw    $s2, 0x208($t1)',
    '  sw    $s3, 0x20C($t1)',
    '  sw    $s4, 0x210($t1)',
    '  sw    $s6, 0x214($t1)',
    '  lui   $t0, 0xA440',
    '  sw    $zero, 16($t0)     ; vsync',
    '  j     frame',
    '  nop',
    '',
    '; fillrect(x=$a0, y=$a1, w=$a2, h=$a3, color=$t8) on the 320-wide fb',
    'fillrect:',
    '  sll   $t0, $a1, 8        ; y*320 = y*256 + y*64',
    '  sll   $t1, $a1, 6',
    '  addu  $t0, $t0, $t1',
    '  addu  $t0, $t0, $a0',
    '  sll   $t0, $t0, 1',
    '  lui   $t1, 0x8010',
    '  addu  $t0, $t0, $t1      ; dst = fb + (y*320+x)*2',
    'fr_row:',
    '  or    $t2, $t0, $zero',
    '  or    $t3, $zero, $zero',
    'fr_col:',
    '  sh    $t8, 0($t2)',
    '  addiu $t3, $t3, 1',
    '  bne   $t3, $a2, fr_col',
    '  addiu $t2, $t2, 2        ; delay slot',
    '  addiu $t0, $t0, 640',
    '  addiu $a3, $a3, -1',
    '  bne   $a3, $zero, fr_row',
    '  nop',
    '  jr    $ra',
    '  nop',
  ].join('\n');

  var STARFIELD_SRC = [
    '; ULTRA STARFIELD — warp through 48 stars with an xorshift RNG, pure MIPS.',
    '; Star records live at RDRAM 0x2000: x,y,speed as three halfwords each.',
    'start:',
    '  lui   $t0, 0xA440',
    '  lui   $t1, 0x0010',
    '  sw    $t1, 4($t0)        ; VI_ORIGIN = 0x00100000',
    '  li    $t2, 320',
    '  sw    $t2, 8($t0)        ; VI_WIDTH = 320',
    '  li    $s7, 0x1234567     ; RNG state (nonzero seed)',
    '  li    $s0, 0x80002000    ; star table pointer',
    '  li    $s1, 48            ; stars to place',
    'init:',
    '  jal   rng',
    '  nop',
    '  andi  $t2, $v0, 511      ; x candidate 0..511',
    '  slti  $t3, $t2, 320',
    '  bne   $t3, $zero, init_x',
    '  nop',
    '  addiu $t2, $t2, -192     ; fold high values back into 0..319',
    'init_x:',
    '  sh    $t2, 0($s0)',
    '  jal   rng',
    '  nop',
    '  andi  $t3, $v0, 255      ; y candidate 0..255',
    '  slti  $t4, $t3, 240',
    '  bne   $t4, $zero, init_y',
    '  nop',
    '  addiu $t3, $t3, -16',
    'init_y:',
    '  sh    $t3, 2($s0)',
    '  jal   rng',
    '  nop',
    '  andi  $t4, $v0, 3',
    '  addiu $t4, $t4, 1        ; speed 1..4 (also the depth cue)',
    '  sh    $t4, 4($s0)',
    '  addiu $s0, $s0, 6',
    '  addiu $s1, $s1, -1',
    '  bne   $s1, $zero, init',
    '  nop',
    '',
    'frame:',
    '  lui   $t9, 0x8010        ; clear the framebuffer to deep space',
    '  li    $t8, 0x0021',
    '  li    $t7, 76800         ; 320*240 pixels',
    'clr:',
    '  sh    $t8, 0($t9)',
    '  addiu $t7, $t7, -1',
    '  bne   $t7, $zero, clr',
    '  addiu $t9, $t9, 2        ; delay slot: advance dst',
    '',
    '  li    $s0, 0x80002000',
    '  li    $s1, 48',
    'star:',
    '  lhu   $s2, 0($s0)        ; x',
    '  lhu   $s3, 2($s0)        ; y',
    '  lhu   $s4, 4($s0)        ; speed',
    '  subu  $s2, $s2, $s4      ; drift left by speed',
    '  bgez  $s2, moved',
    '  nop',
    '  li    $s2, 319           ; wrapped: respawn at the right edge',
    '  jal   rng',
    '  nop',
    '  andi  $s3, $v0, 255',
    '  slti  $t3, $s3, 240',
    '  bne   $t3, $zero, moved',
    '  nop',
    '  addiu $s3, $s3, -16',
    'moved:',
    '  sh    $s2, 0($s0)',
    '  sh    $s3, 2($s0)',
    '  sll   $t5, $s4, 3        ; intensity = speed*7 + 6, clamped to 31',
    '  subu  $t5, $t5, $s4',
    '  addiu $t5, $t5, 6',
    '  slti  $t3, $t5, 32',
    '  bne   $t3, $zero, shade',
    '  nop',
    '  li    $t5, 31',
    'shade:',
    '  sll   $t6, $t5, 11       ; pack a grey star: i<<11 | i<<6 | i<<1 | 1',
    '  sll   $t2, $t5, 6',
    '  or    $t6, $t6, $t2',
    '  sll   $t2, $t5, 1',
    '  or    $t6, $t6, $t2',
    '  ori   $t6, $t6, 1',
    '  sll   $t2, $s3, 8        ; addr = fb + (y*320 + x)*2',
    '  sll   $t3, $s3, 6',
    '  addu  $t2, $t2, $t3',
    '  addu  $t2, $t2, $s2',
    '  sll   $t2, $t2, 1',
    '  lui   $t3, 0x8010',
    '  addu  $t2, $t2, $t3',
    '  sh    $t6, 0($t2)        ; the star',
    '  addiu $s2, $s2, 1        ; a dimmer trailing pixel makes the streak',
    '  slti  $t3, $s2, 320',
    '  beq   $t3, $zero, next',
    '  nop',
    '  addiu $t2, $t2, 2',
    '  srl   $t4, $t5, 1',
    '  sll   $t6, $t4, 11',
    '  sll   $t3, $t4, 6',
    '  or    $t6, $t6, $t3',
    '  sll   $t3, $t4, 1',
    '  or    $t6, $t6, $t3',
    '  ori   $t6, $t6, 1',
    '  sh    $t6, 0($t2)',
    'next:',
    '  addiu $s0, $s0, 6',
    '  addiu $s1, $s1, -1',
    '  bne   $s1, $zero, star',
    '  nop',
    '  lui   $t0, 0xA440',
    '  sw    $zero, 16($t0)     ; vsync',
    '  j     frame',
    '  nop',
    '',
    '; rng: xorshift32 on $s7, result in $v0.',
    'rng:',
    '  sll   $t1, $s7, 13',
    '  xor   $s7, $s7, $t1',
    '  srl   $t1, $s7, 17',
    '  xor   $s7, $s7, $t1',
    '  sll   $t1, $s7, 5',
    '  xor   $s7, $s7, $t1',
    '  jr    $ra',
    '  or    $v0, $s7, $zero    ; delay slot: hand back the new state',
  ].join('\n');

  var DEMOS = {
    gradient: { name: 'ULTRA GRADIENT', tagline: 'scrolling rainbow, pure MIPS', source: GRADIENT_SRC },
    pong: { name: 'ULTRA PONG', tagline: 'd-pad plays, JAL draws', source: PONG_SRC },
    starfield: { name: 'ULTRA STARFIELD', tagline: 'xorshift warp, 48 stars', source: STARFIELD_SRC },
  };

  /* ================= homebrew ROM catalog + search ================= */
  /* Ultra ships with a curated catalog of freely-distributable content so
   * "search and play" never means hunting for pirated commercial ROMs. The
   * built-in kind boots instantly (they ARE the demos above); the community
   * kind points at the open homebrew scene — the search box opens a scoped
   * web search for that title's official, rights-cleared release, which the
   * user can then feed to Ultra's load-from-URL box. No commercial ROMs, no
   * automatic downloads of anyone's copyrighted game. */

  var HOMEBREW = [
    { id: 'gradient', title: 'Ultra Gradient', author: 'Ultra', year: 2026, genre: 'demo effect',
      license: 'MIT (bundled)', kind: 'builtin', demo: 'gradient',
      desc: 'A scrolling rainbow plasma written in MIPS assembly and assembled in-engine.' },
    { id: 'pong', title: 'Ultra Pong', author: 'Ultra', year: 2026, genre: 'arcade sports',
      license: 'MIT (bundled)', kind: 'builtin', demo: 'pong',
      desc: 'Playable Pong — the d-pad slides the paddle, walls bounce, the ball scores.' },
    { id: 'starfield', title: 'Ultra Starfield', author: 'Ultra', year: 2026, genre: 'demo effect space',
      license: 'MIT (bundled)', kind: 'builtin', demo: 'starfield',
      desc: 'A 48-star warp field driven by an xorshift RNG, streaks and depth cues included.' },
    { id: 'libdragon-examples', title: 'Libdragon Examples', author: 'Libdragon project', year: 2024,
      genre: 'homebrew demo toolkit', license: 'Unlicense / public domain', kind: 'community',
      query: 'libdragon n64 example roms release', desc: 'The open-source N64 SDK ships buildable example ROMs (public domain).' },
    { id: 'n64brew-gamejam', title: 'N64brew Game Jam', author: 'N64brew community', year: 2023,
      genre: 'homebrew games platformer puzzle racing', license: 'open source (per entry)', kind: 'community',
      query: 'n64brew game jam homebrew rom download', desc: 'Community game jam — dozens of original, freely-distributable homebrew games.' },
    { id: 'pom1-tetris', title: 'Open homebrew puzzle', author: 'homebrew scene', year: 2022,
      genre: 'puzzle tetris blocks', license: 'open source', kind: 'community',
      query: 'n64 homebrew tetris puzzle open source rom', desc: 'Open-source block/puzzle homebrew for the N64.' },
  ];

  // Pure, order-stable search: every whitespace token must match somewhere in
  // the entry (title/author/genre/desc/license). Empty query returns all.
  function searchHomebrew(query) {
    var toks = String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(Boolean);
    return HOMEBREW.filter(function (r) {
      if (!toks.length) return true;
      var hay = (r.title + ' ' + r.author + ' ' + r.genre + ' ' + r.desc + ' ' + r.license + ' ' + r.year).toLowerCase();
      for (var i = 0; i < toks.length; i++) if (hay.indexOf(toks[i]) === -1) return false;
      return true;
    }).map(function (r) {
      return { id: r.id, title: r.title, author: r.author, year: r.year, genre: r.genre,
        license: r.license, kind: r.kind, demo: r.demo || null, query: r.query || null, desc: r.desc };
    });
  }

  // The scoped web-search URL for a community entry — a search for its OWN
  // legal release, never a commercial ROM site.
  function homebrewSearchUrl(entry) {
    var q = (entry && entry.query) || (entry && entry.title) || 'n64 homebrew rom';
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(q);
  }

  // Assemble a demo and hand back a booted console.
  function bootDemo(key) {
    var demo = DEMOS[key];
    if (!demo) throw new Error('no demo named "' + key + '"');
    var asm = assemble(demo.source);
    if (!asm.ok) throw new Error('demo "' + key + '" failed to assemble: ' + asm.errors.join('; '));
    var s = makeState();
    loadProgram(s, asm.words, asm.base);
    s.romName = demo.name;
    return s;
  }

  /* ================= exports ================= */

  var api = {
    RDRAM_SIZE: RDRAM_SIZE, FB_PHYS: FB_PHYS, SCREEN_W: SCREEN_W, SCREEN_H: SCREEN_H,
    BUTTONS: BUTTONS, REG_NAMES: REG_NAMES,
    makeState: makeState, virtToPhys: virtToPhys,
    read8: read8, read16: read16, read32: read32,
    write8: write8, write16: write16, write32: write32,
    setButtons: setButtons,
    step: stepOne, run: run, runFrame: runFrame,
    framebufferRGBA: framebufferRGBA,
    identifyRom: identifyRom, normalizeRom: normalizeRom, bootRom: bootRom,
    loadProgram: loadProgram, assemble: assemble, disasm: disasm,
    DEMOS: DEMOS, bootDemo: bootDemo,
    HOMEBREW: HOMEBREW, searchHomebrew: searchHomebrew, homebrewSearchUrl: homebrewSearchUrl,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UltraEngine = api;
})(typeof self !== 'undefined' ? self : this);
