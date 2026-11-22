// MOS 6502/6510 CPU core (documented opcodes plus the common stable
// undocumented ones). Instruction-level timing with page-cross penalties.
(function (root) {
  'use strict';

  // Base cycle counts per opcode.
  const CYCLES = [
    7, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 4, 4, 6, 6,
    2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
    6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 4, 4, 6, 6,
    2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
    6, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 3, 4, 6, 6,
    2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
    6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 5, 4, 6, 6,
    2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
    2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4,
    2, 6, 2, 6, 4, 4, 4, 4, 2, 5, 2, 5, 5, 5, 5, 5,
    2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4,
    2, 5, 2, 5, 4, 4, 4, 4, 2, 4, 2, 4, 4, 4, 4, 4,
    2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6,
    2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
    2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6,
    2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7
  ];

  const C = 1, Z = 2, I = 4, D = 8, B = 16, U = 32, V = 64, N = 128;

  class CPU {
    constructor(read, write) {
      this.read = read;
      this.write = write;
      this.a = 0; this.x = 0; this.y = 0; this.sp = 0xfd; this.p = I | U; this.pc = 0;
      this.irqLine = 0;        // bitmask of IRQ sources currently asserting
      this.nmiPending = false;
      this.jammed = false;
      this.extra = 0;
      this.cycles = 0;
    }

    reset() {
      this.sp = 0xfd; this.p = I | U; this.jammed = false;
      this.pc = this.read(0xfffc) | (this.read(0xfffd) << 8);
    }

    nmi() { this.nmiPending = true; }

    push(v) { this.write(0x100 | this.sp, v & 0xff); this.sp = (this.sp - 1) & 0xff; }
    pull() { this.sp = (this.sp + 1) & 0xff; return this.read(0x100 | this.sp); }

    setZN(v) { this.p = (this.p & ~(Z | N)) | (v === 0 ? Z : 0) | (v & N); return v; }

    interrupt(vector, brk) {
      this.push(this.pc >> 8); this.push(this.pc & 0xff);
      this.push((this.p | U | (brk ? B : 0)) & ~(brk ? 0 : B));
      this.p |= I;
      this.pc = this.read(vector) | (this.read(vector + 1) << 8);
    }

    // --- addressing helpers -----------------------------------------------
    fetch() { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
    fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }
    zp() { return this.fetch(); }
    zpx() { return (this.fetch() + this.x) & 0xff; }
    zpy() { return (this.fetch() + this.y) & 0xff; }
    abs() { return this.fetch16(); }
    abx(pen) { const b = this.fetch16(); const a = (b + this.x) & 0xffff; if (pen && (a & 0xff00) !== (b & 0xff00)) this.extra++; return a; }
    aby(pen) { const b = this.fetch16(); const a = (b + this.y) & 0xffff; if (pen && (a & 0xff00) !== (b & 0xff00)) this.extra++; return a; }
    izx() { const z = (this.fetch() + this.x) & 0xff; return this.read(z) | (this.read((z + 1) & 0xff) << 8); }
    izy(pen) {
      const z = this.fetch();
      const b = this.read(z) | (this.read((z + 1) & 0xff) << 8);
      const a = (b + this.y) & 0xffff;
      if (pen && (a & 0xff00) !== (b & 0xff00)) this.extra++;
      return a;
    }

    // --- ALU ------------------------------------------------------------------
    adc(v) {
      const c = this.p & C;
      if (this.p & D) {
        let lo = (this.a & 0x0f) + (v & 0x0f) + c;
        let hi = (this.a & 0xf0) + (v & 0xf0);
        if (lo > 9) { lo += 6; }
        if (lo > 0x0f) hi += 0x10;
        const zr = ((this.a + v + c) & 0xff) === 0;
        const ov = (~(this.a ^ v) & (this.a ^ hi) & 0x80) !== 0;
        if (hi > 0x90) hi += 0x60;
        this.p = (this.p & ~(C | Z | V | N)) | (hi > 0xff ? C : 0) | (zr ? Z : 0) | (ov ? V : 0) | (hi & N);
        this.a = ((hi & 0xf0) | (lo & 0x0f)) & 0xff;
      } else {
        const r = this.a + v + c;
        this.p = (this.p & ~(C | V)) | (r > 0xff ? C : 0) | ((~(this.a ^ v) & (this.a ^ r) & 0x80) ? V : 0);
        this.a = this.setZN(r & 0xff);
      }
    }
    sbc(v) {
      if (this.p & D) {
        const c = (this.p & C) ? 0 : 1;
        const r = this.a - v - c;
        let lo = (this.a & 0x0f) - (v & 0x0f) - c;
        let hi = (this.a & 0xf0) - (v & 0xf0);
        if (lo < 0) { lo -= 6; hi -= 0x10; }
        if (hi < 0) hi -= 0x60;
        this.p = (this.p & ~(C | V)) | (r >= 0 ? C : 0) | (((this.a ^ v) & (this.a ^ r) & 0x80) ? V : 0);
        this.setZN(r & 0xff);
        this.a = ((hi & 0xf0) | (lo & 0x0f)) & 0xff;
      } else this.adc(v ^ 0xff);
    }
    cmp(r, v) { const t = r - v; this.p = (this.p & ~C) | (t >= 0 ? C : 0); this.setZN(t & 0xff); }
    asl(v) { this.p = (this.p & ~C) | (v >> 7); return this.setZN((v << 1) & 0xff); }
    lsr(v) { this.p = (this.p & ~C) | (v & 1); return this.setZN(v >> 1); }
    rol(v) { const r = ((v << 1) | (this.p & C)) & 0xff; this.p = (this.p & ~C) | (v >> 7); return this.setZN(r); }
    ror(v) { const r = (v >> 1) | ((this.p & C) << 7); this.p = (this.p & ~C) | (v & 1); return this.setZN(r); }
    bit(v) { this.p = (this.p & ~(Z | V | N)) | ((this.a & v) ? 0 : Z) | (v & (V | N)); }
    branch(cond) {
      const off = this.fetch();
      if (cond) {
        const t = (this.pc + (off < 128 ? off : off - 256)) & 0xffff;
        this.extra += ((t & 0xff00) !== (this.pc & 0xff00)) ? 2 : 1;
        this.pc = t;
      }
    }
    rmw(addr, fn) { const v = this.read(addr); this.write(addr, v); const r = fn.call(this, v); this.write(addr, r); return r; }

    // Execute one instruction (or take a pending interrupt). Returns cycles used.
    step() {
      if (this.nmiPending) { this.nmiPending = false; this.interrupt(0xfffa, false); this.cycles += 7; return 7; }
      if (this.irqLine && !(this.p & I)) { this.interrupt(0xfffe, false); this.cycles += 7; return 7; }
      if (this.jammed) { this.cycles += 2; return 2; }
      const op = this.fetch();
      this.extra = 0;
      let a, v;
      switch (op) {
        // LDA
        case 0xa9: this.a = this.setZN(this.fetch()); break;
        case 0xa5: this.a = this.setZN(this.read(this.zp())); break;
        case 0xb5: this.a = this.setZN(this.read(this.zpx())); break;
        case 0xad: this.a = this.setZN(this.read(this.abs())); break;
        case 0xbd: this.a = this.setZN(this.read(this.abx(true))); break;
        case 0xb9: this.a = this.setZN(this.read(this.aby(true))); break;
        case 0xa1: this.a = this.setZN(this.read(this.izx())); break;
        case 0xb1: this.a = this.setZN(this.read(this.izy(true))); break;
        // LDX
        case 0xa2: this.x = this.setZN(this.fetch()); break;
        case 0xa6: this.x = this.setZN(this.read(this.zp())); break;
        case 0xb6: this.x = this.setZN(this.read(this.zpy())); break;
        case 0xae: this.x = this.setZN(this.read(this.abs())); break;
        case 0xbe: this.x = this.setZN(this.read(this.aby(true))); break;
        // LDY
        case 0xa0: this.y = this.setZN(this.fetch()); break;
        case 0xa4: this.y = this.setZN(this.read(this.zp())); break;
        case 0xb4: this.y = this.setZN(this.read(this.zpx())); break;
        case 0xac: this.y = this.setZN(this.read(this.abs())); break;
        case 0xbc: this.y = this.setZN(this.read(this.abx(true))); break;
        // STA
        case 0x85: this.write(this.zp(), this.a); break;
        case 0x95: this.write(this.zpx(), this.a); break;
        case 0x8d: this.write(this.abs(), this.a); break;
        case 0x9d: this.write(this.abx(false), this.a); break;
        case 0x99: this.write(this.aby(false), this.a); break;
        case 0x81: this.write(this.izx(), this.a); break;
        case 0x91: this.write(this.izy(false), this.a); break;
        // STX / STY
        case 0x86: this.write(this.zp(), this.x); break;
        case 0x96: this.write(this.zpy(), this.x); break;
        case 0x8e: this.write(this.abs(), this.x); break;
        case 0x84: this.write(this.zp(), this.y); break;
        case 0x94: this.write(this.zpx(), this.y); break;
        case 0x8c: this.write(this.abs(), this.y); break;
        // Transfers
        case 0xaa: this.x = this.setZN(this.a); break;
        case 0xa8: this.y = this.setZN(this.a); break;
        case 0x8a: this.a = this.setZN(this.x); break;
        case 0x98: this.a = this.setZN(this.y); break;
        case 0xba: this.x = this.setZN(this.sp); break;
        case 0x9a: this.sp = this.x; break;
        // Stack
        case 0x48: this.push(this.a); break;
        case 0x08: this.push(this.p | B | U); break;
        case 0x68: this.a = this.setZN(this.pull()); break;
        case 0x28: this.p = (this.pull() & ~B) | U; break;
        // Logic
        case 0x29: this.a = this.setZN(this.a & this.fetch()); break;
        case 0x25: this.a = this.setZN(this.a & this.read(this.zp())); break;
        case 0x35: this.a = this.setZN(this.a & this.read(this.zpx())); break;
        case 0x2d: this.a = this.setZN(this.a & this.read(this.abs())); break;
        case 0x3d: this.a = this.setZN(this.a & this.read(this.abx(true))); break;
        case 0x39: this.a = this.setZN(this.a & this.read(this.aby(true))); break;
        case 0x21: this.a = this.setZN(this.a & this.read(this.izx())); break;
        case 0x31: this.a = this.setZN(this.a & this.read(this.izy(true))); break;
        case 0x09: this.a = this.setZN(this.a | this.fetch()); break;
        case 0x05: this.a = this.setZN(this.a | this.read(this.zp())); break;
        case 0x15: this.a = this.setZN(this.a | this.read(this.zpx())); break;
        case 0x0d: this.a = this.setZN(this.a | this.read(this.abs())); break;
        case 0x1d: this.a = this.setZN(this.a | this.read(this.abx(true))); break;
        case 0x19: this.a = this.setZN(this.a | this.read(this.aby(true))); break;
        case 0x01: this.a = this.setZN(this.a | this.read(this.izx())); break;
        case 0x11: this.a = this.setZN(this.a | this.read(this.izy(true))); break;
        case 0x49: this.a = this.setZN(this.a ^ this.fetch()); break;
        case 0x45: this.a = this.setZN(this.a ^ this.read(this.zp())); break;
        case 0x55: this.a = this.setZN(this.a ^ this.read(this.zpx())); break;
        case 0x4d: this.a = this.setZN(this.a ^ this.read(this.abs())); break;
        case 0x5d: this.a = this.setZN(this.a ^ this.read(this.abx(true))); break;
        case 0x59: this.a = this.setZN(this.a ^ this.read(this.aby(true))); break;
        case 0x41: this.a = this.setZN(this.a ^ this.read(this.izx())); break;
        case 0x51: this.a = this.setZN(this.a ^ this.read(this.izy(true))); break;
        case 0x24: this.bit(this.read(this.zp())); break;
        case 0x2c: this.bit(this.read(this.abs())); break;
        // Arithmetic
        case 0x69: this.adc(this.fetch()); break;
        case 0x65: this.adc(this.read(this.zp())); break;
        case 0x75: this.adc(this.read(this.zpx())); break;
        case 0x6d: this.adc(this.read(this.abs())); break;
        case 0x7d: this.adc(this.read(this.abx(true))); break;
        case 0x79: this.adc(this.read(this.aby(true))); break;
        case 0x61: this.adc(this.read(this.izx())); break;
        case 0x71: this.adc(this.read(this.izy(true))); break;
        case 0xe9: case 0xeb: this.sbc(this.fetch()); break;
        case 0xe5: this.sbc(this.read(this.zp())); break;
        case 0xf5: this.sbc(this.read(this.zpx())); break;
        case 0xed: this.sbc(this.read(this.abs())); break;
        case 0xfd: this.sbc(this.read(this.abx(true))); break;
        case 0xf9: this.sbc(this.read(this.aby(true))); break;
        case 0xe1: this.sbc(this.read(this.izx())); break;
        case 0xf1: this.sbc(this.read(this.izy(true))); break;
        // Compare
        case 0xc9: this.cmp(this.a, this.fetch()); break;
        case 0xc5: this.cmp(this.a, this.read(this.zp())); break;
        case 0xd5: this.cmp(this.a, this.read(this.zpx())); break;
        case 0xcd: this.cmp(this.a, this.read(this.abs())); break;
        case 0xdd: this.cmp(this.a, this.read(this.abx(true))); break;
        case 0xd9: this.cmp(this.a, this.read(this.aby(true))); break;
        case 0xc1: this.cmp(this.a, this.read(this.izx())); break;
        case 0xd1: this.cmp(this.a, this.read(this.izy(true))); break;
        case 0xe0: this.cmp(this.x, this.fetch()); break;
        case 0xe4: this.cmp(this.x, this.read(this.zp())); break;
        case 0xec: this.cmp(this.x, this.read(this.abs())); break;
        case 0xc0: this.cmp(this.y, this.fetch()); break;
        case 0xc4: this.cmp(this.y, this.read(this.zp())); break;
        case 0xcc: this.cmp(this.y, this.read(this.abs())); break;
        // Inc / Dec
        case 0xe6: this.rmw(this.zp(), v => this.setZN((v + 1) & 0xff)); break;
        case 0xf6: this.rmw(this.zpx(), v => this.setZN((v + 1) & 0xff)); break;
        case 0xee: this.rmw(this.abs(), v => this.setZN((v + 1) & 0xff)); break;
        case 0xfe: this.rmw(this.abx(false), v => this.setZN((v + 1) & 0xff)); break;
        case 0xc6: this.rmw(this.zp(), v => this.setZN((v - 1) & 0xff)); break;
        case 0xd6: this.rmw(this.zpx(), v => this.setZN((v - 1) & 0xff)); break;
        case 0xce: this.rmw(this.abs(), v => this.setZN((v - 1) & 0xff)); break;
        case 0xde: this.rmw(this.abx(false), v => this.setZN((v - 1) & 0xff)); break;
        case 0xe8: this.x = this.setZN((this.x + 1) & 0xff); break;
        case 0xc8: this.y = this.setZN((this.y + 1) & 0xff); break;
        case 0xca: this.x = this.setZN((this.x - 1) & 0xff); break;
        case 0x88: this.y = this.setZN((this.y - 1) & 0xff); break;
        // Shifts
        case 0x0a: this.a = this.asl(this.a); break;
        case 0x06: this.rmw(this.zp(), this.asl); break;
        case 0x16: this.rmw(this.zpx(), this.asl); break;
        case 0x0e: this.rmw(this.abs(), this.asl); break;
        case 0x1e: this.rmw(this.abx(false), this.asl); break;
        case 0x4a: this.a = this.lsr(this.a); break;
        case 0x46: this.rmw(this.zp(), this.lsr); break;
        case 0x56: this.rmw(this.zpx(), this.lsr); break;
        case 0x4e: this.rmw(this.abs(), this.lsr); break;
        case 0x5e: this.rmw(this.abx(false), this.lsr); break;
        case 0x2a: this.a = this.rol(this.a); break;
        case 0x26: this.rmw(this.zp(), this.rol); break;
        case 0x36: this.rmw(this.zpx(), this.rol); break;
        case 0x2e: this.rmw(this.abs(), this.rol); break;
        case 0x3e: this.rmw(this.abx(false), this.rol); break;
        case 0x6a: this.a = this.ror(this.a); break;
        case 0x66: this.rmw(this.zp(), this.ror); break;
        case 0x76: this.rmw(this.zpx(), this.ror); break;
        case 0x6e: this.rmw(this.abs(), this.ror); break;
        case 0x7e: this.rmw(this.abx(false), this.ror); break;
        // Jumps
        case 0x4c: this.pc = this.abs(); break;
        case 0x6c: {
          a = this.abs();
          this.pc = this.read(a) | (this.read((a & 0xff00) | ((a + 1) & 0xff)) << 8);
          break;
        }
        case 0x20: {
          a = this.fetch16();
          const ret = (this.pc - 1) & 0xffff;
          this.push(ret >> 8); this.push(ret & 0xff);
          this.pc = a;
          break;
        }
        case 0x60: { const lo = this.pull(); this.pc = ((lo | (this.pull() << 8)) + 1) & 0xffff; break; }
        case 0x40: { this.p = (this.pull() & ~B) | U; const lo = this.pull(); this.pc = lo | (this.pull() << 8); break; }
        case 0x00: this.pc = (this.pc + 1) & 0xffff; this.interrupt(0xfffe, true); break;
        // Branches
        case 0x10: this.branch(!(this.p & N)); break;
        case 0x30: this.branch(this.p & N); break;
        case 0x50: this.branch(!(this.p & V)); break;
        case 0x70: this.branch(this.p & V); break;
        case 0x90: this.branch(!(this.p & C)); break;
        case 0xb0: this.branch(this.p & C); break;
        case 0xd0: this.branch(!(this.p & Z)); break;
        case 0xf0: this.branch(this.p & Z); break;
        // Flags
        case 0x18: this.p &= ~C; break;
        case 0x38: this.p |= C; break;
        case 0x58: this.p &= ~I; break;
        case 0x78: this.p |= I; break;
        case 0xb8: this.p &= ~V; break;
        case 0xd8: this.p &= ~D; break;
        case 0xf8: this.p |= D; break;
        case 0xea: break;

        // ---- common undocumented opcodes ----
        // NOPs with operands
        case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa: break;
        case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2: this.fetch(); break;
        case 0x04: case 0x44: case 0x64: this.zp(); break;
        case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4: this.zpx(); break;
        case 0x0c: this.abs(); break;
        case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc: this.abx(true); break;
        // LAX
        case 0xa7: this.a = this.x = this.setZN(this.read(this.zp())); break;
        case 0xb7: this.a = this.x = this.setZN(this.read(this.zpy())); break;
        case 0xaf: this.a = this.x = this.setZN(this.read(this.abs())); break;
        case 0xbf: this.a = this.x = this.setZN(this.read(this.aby(true))); break;
        case 0xa3: this.a = this.x = this.setZN(this.read(this.izx())); break;
        case 0xb3: this.a = this.x = this.setZN(this.read(this.izy(true))); break;
        // SAX
        case 0x87: this.write(this.zp(), this.a & this.x); break;
        case 0x97: this.write(this.zpy(), this.a & this.x); break;
        case 0x8f: this.write(this.abs(), this.a & this.x); break;
        case 0x83: this.write(this.izx(), this.a & this.x); break;
        // DCP / ISC / SLO / RLA / SRE / RRA (zp, abs, abs,x forms)
        case 0xc7: case 0xd7: case 0xcf: case 0xdf: case 0xdb: case 0xc3: case 0xd3:
          a = this.undocAddr(op); v = this.rmw(a, x => (x - 1) & 0xff); this.cmp(this.a, v); break;
        case 0xe7: case 0xf7: case 0xef: case 0xff: case 0xfb: case 0xe3: case 0xf3:
          a = this.undocAddr(op); v = this.rmw(a, x => (x + 1) & 0xff); this.sbc(v); break;
        case 0x07: case 0x17: case 0x0f: case 0x1f: case 0x1b: case 0x03: case 0x13:
          a = this.undocAddr(op); v = this.rmw(a, this.asl); this.a = this.setZN(this.a | v); break;
        case 0x27: case 0x37: case 0x2f: case 0x3f: case 0x3b: case 0x23: case 0x33:
          a = this.undocAddr(op); v = this.rmw(a, this.rol); this.a = this.setZN(this.a & v); break;
        case 0x47: case 0x57: case 0x4f: case 0x5f: case 0x5b: case 0x43: case 0x53:
          a = this.undocAddr(op); v = this.rmw(a, this.lsr); this.a = this.setZN(this.a ^ v); break;
        case 0x67: case 0x77: case 0x6f: case 0x7f: case 0x7b: case 0x63: case 0x73:
          a = this.undocAddr(op); v = this.rmw(a, this.ror); this.adc(v); break;
        case 0x0b: case 0x2b: this.a = this.setZN(this.a & this.fetch()); this.p = (this.p & ~C) | (this.a >> 7); break;
        case 0x4b: this.a &= this.fetch(); this.a = this.lsr(this.a); break;
        case 0xcb: { const t = (this.a & this.x) - this.fetch(); this.p = (this.p & ~C) | (t >= 0 ? C : 0); this.x = this.setZN(t & 0xff); break; }
        default:
          // JAM / KIL and the unstable opcodes: halt like the real chip.
          this.jammed = true;
          this.pc = (this.pc - 1) & 0xffff;
      }
      const c = CYCLES[op] + this.extra;
      this.cycles += c;
      return c;
    }

    // Address for the undocumented read-modify-write group (column decides mode).
    undocAddr(op) {
      switch (op & 0x1f) {
        case 0x03: return this.izx();
        case 0x07: return this.zp();
        case 0x0f: return this.abs();
        case 0x13: return this.izy(false);
        case 0x17: return (op & 0xc0) === 0x80 ? this.zpy() : this.zpx();
        case 0x1b: return this.aby(false);
        case 0x1f: return this.abx(false);
      }
      return this.abs();
    }
  }

  const api = { CPU, FLAGS: { C, Z, I, D, B, U, V, N } };
  root.C64 = root.C64 || {};
  root.C64.cpu = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
