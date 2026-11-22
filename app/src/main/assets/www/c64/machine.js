// Commodore 64 (PAL) machine: memory map + banking, VIC-II (line-based
// renderer with text/bitmap modes, sprites, raster IRQ), two CIAs (timers,
// keyboard, joystick, TOD), SID, and helpers to boot and run programs.
(function (root) {
  'use strict';

  const CYCLES_PER_LINE = 63;
  const LINES = 312;
  const CYCLES_PER_FRAME = CYCLES_PER_LINE * LINES;      // 19656
  const W = 384, H = 272, FIRST_LINE = 16;               // visible window
  // "Colodore" palette
  const PALETTE = [
    0x000000, 0xffffff, 0x813338, 0x75cec8, 0x8e3c97, 0x56ac4d, 0x2e2c9b, 0xedf171,
    0x8e5029, 0x553800, 0xc46c71, 0x4a4a4a, 0x7b7b7b, 0xa9ff9f, 0x706deb, 0xb2b2b2
  ];
  // ABGR for little-endian ImageData
  const PAL32 = PALETTE.map(c => 0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | (c >> 16));

  // ---------------------------------------------------------------- CIA ------
  class CIA {
    constructor(name, onIrq) {
      this.name = name; this.onIrq = onIrq;
      this.reset();
    }
    reset() {
      this.pra = 0xff; this.prb = 0xff; this.ddra = 0; this.ddrb = 0;
      this.ta = 0xffff; this.tb = 0xffff; this.la = 0xffff; this.lb = 0xffff;
      this.cra = 0; this.crb = 0; this.icr = 0; this.mask = 0;
      this.tod = [0, 0, 0, 1]; this.todLatch = null; this.todStopped = false; this.alarm = [0, 0, 0, 0];
      this.sdr = 0;
      this.irqOut = false;
    }
    update() {
      const active = (this.icr & this.mask & 0x1f) !== 0;
      if (active !== this.irqOut) { this.irqOut = active; this.onIrq(active); }
    }
    clock(c) {
      let underA = 0;
      if (this.cra & 1) {
        this.ta -= c;
        while (this.ta < 0) {
          underA++;
          this.icr |= 1;
          if (this.cra & 8) { this.cra &= ~1; this.ta = this.la; break; }
          this.ta += this.la + 1;
          if (this.la === 0) { this.ta = 0; break; }
        }
      }
      if (this.crb & 1) {
        const mode = (this.crb >> 5) & 3;
        const ticks = mode === 0 ? c : (mode >= 2 ? underA : 0);
        if (ticks) {
          this.tb -= ticks;
          while (this.tb < 0) {
            this.icr |= 2;
            if (this.crb & 8) { this.crb &= ~1; this.tb = this.lb; break; }
            this.tb += this.lb + 1;
            if (this.lb === 0) { this.tb = 0; break; }
          }
        }
      }
      if (this.icr & this.mask & 3) this.update();
    }
    // Called 10 times per second.
    tickTod() {
      if (this.todStopped) return;
      const bcdInc = (v, max) => { let lo = (v & 15) + 1, hi = v >> 4; if (lo > 9) { lo = 0; hi++; } const r = (hi << 4) | lo; return r > max ? null : r; };
      let t = this.tod;
      let n = bcdInc(t[0], 9); if (n !== null) t[0] = n; else {
        t[0] = 0; n = bcdInc(t[1], 0x59); if (n !== null) t[1] = n; else {
          t[1] = 0; n = bcdInc(t[2], 0x59); if (n !== null) t[2] = n; else {
            t[2] = 0; let h = t[3] & 0x1f, pm = t[3] & 0x80; h = h === 0x12 ? 1 : (bcdInc(h, 0x12) || 1); if (h === 0x12) pm ^= 0x80; t[3] = h | pm;
          }
        }
      }
      if (t[0] === this.alarm[0] && t[1] === this.alarm[1] && t[2] === this.alarm[2] && t[3] === this.alarm[3]) { this.icr |= 4; this.update(); }
    }
    read(r, portA, portB) {
      switch (r & 15) {
        case 0: return portA;
        case 1: return portB;
        case 2: return this.ddra;
        case 3: return this.ddrb;
        case 4: return this.ta & 0xff;
        case 5: return this.ta >> 8;
        case 6: return this.tb & 0xff;
        case 7: return this.tb >> 8;
        case 8: { const v = (this.todLatch || this.tod)[0]; this.todLatch = null; return v; }
        case 9: return (this.todLatch || this.tod)[1];
        case 10: return (this.todLatch || this.tod)[2];
        case 11: this.todLatch = this.tod.slice(); return this.tod[3];
        case 12: return this.sdr;
        case 13: {
          const v = (this.icr & 0x1f) | ((this.icr & this.mask & 0x1f) ? 0x80 : 0);
          this.icr = 0; this.update();
          return v;
        }
        case 14: return this.cra & 0xef;
        case 15: return this.crb & 0xef;
      }
      return 0xff;
    }
    write(r, v) {
      switch (r & 15) {
        case 0: this.pra = v; break;
        case 1: this.prb = v; break;
        case 2: this.ddra = v; break;
        case 3: this.ddrb = v; break;
        case 4: this.la = (this.la & 0xff00) | v; break;
        case 5: this.la = (this.la & 0xff) | (v << 8); if (!(this.cra & 1)) this.ta = this.la; break;
        case 6: this.lb = (this.lb & 0xff00) | v; break;
        case 7: this.lb = (this.lb & 0xff) | (v << 8); if (!(this.crb & 1)) this.tb = this.lb; break;
        case 8: case 9: case 10: case 11: {
          const i = (r & 15) - 8;
          const target = (this.crb & 0x80) ? this.alarm : this.tod;
          target[i] = v;
          if (target === this.tod) this.todStopped = i !== 0 ? true : false;
          break;
        }
        case 12: this.sdr = v; break;
        case 13:
          if (v & 0x80) this.mask |= v & 0x1f; else this.mask &= ~(v & 0x1f);
          this.update();
          break;
        case 14: if (v & 0x10) this.ta = this.la; this.cra = v & 0xef; break;
        case 15: if (v & 0x10) this.tb = this.lb; this.crb = v & 0xef; break;
      }
    }
  }

  // ------------------------------------------------------------ keyboard -----
  // [column (PA bit), row (PB bit)]
  const KEYS = {
    DEL: [0, 0], RETURN: [0, 1], CRSR_RIGHT: [0, 2], F7: [0, 3], F1: [0, 4], F3: [0, 5], F5: [0, 6], CRSR_DOWN: [0, 7],
    '3': [1, 0], W: [1, 1], A: [1, 2], '4': [1, 3], Z: [1, 4], S: [1, 5], E: [1, 6], LSHIFT: [1, 7],
    '5': [2, 0], R: [2, 1], D: [2, 2], '6': [2, 3], C: [2, 4], F: [2, 5], T: [2, 6], X: [2, 7],
    '7': [3, 0], Y: [3, 1], G: [3, 2], '8': [3, 3], B: [3, 4], H: [3, 5], U: [3, 6], V: [3, 7],
    '9': [4, 0], I: [4, 1], J: [4, 2], '0': [4, 3], M: [4, 4], K: [4, 5], O: [4, 6], N: [4, 7],
    '+': [5, 0], P: [5, 1], L: [5, 2], '-': [5, 3], '.': [5, 4], ':': [5, 5], '@': [5, 6], ',': [5, 7],
    '£': [6, 0], '*': [6, 1], ';': [6, 2], HOME: [6, 3], RSHIFT: [6, 4], '=': [6, 5], '↑': [6, 6], '/': [6, 7],
    '1': [7, 0], '←': [7, 1], CTRL: [7, 2], '2': [7, 3], ' ': [7, 4], CBM: [7, 5], Q: [7, 6], STOP: [7, 7]
  };
  const SHIFTED = {
    '!': '1', '"': '2', '#': '3', '$': '4', '%': '5', '&': '6', "'": '7', '(': '8', ')': '9',
    '[': ':', ']': ';', '<': ',', '>': '.', '?': '/'
  };
  // Character (or named key) -> list of matrix keys to hold.
  function keysFor(ch) {
    if (ch === '\n' || ch === '\r') return ['RETURN'];
    if (ch === '^') return ['↑'];
    if (ch === '_') return ['←'];
    if (ch === '\\') return ['£'];
    const up = ch.length === 1 ? ch.toUpperCase() : ch;
    if (KEYS[up]) return [up];
    if (SHIFTED[ch]) return ['LSHIFT', SHIFTED[ch]];
    const named = {
      CRSR_LEFT: ['LSHIFT', 'CRSR_RIGHT'], CRSR_UP: ['LSHIFT', 'CRSR_DOWN'], CLR: ['LSHIFT', 'HOME'],
      INST: ['LSHIFT', 'DEL'], F2: ['LSHIFT', 'F1'], F4: ['LSHIFT', 'F3'], F6: ['LSHIFT', 'F5'], F8: ['LSHIFT', 'F7']
    };
    return named[ch] || null;
  }

  // ------------------------------------------------------------- machine -----
  class C64 {
    constructor(opts) {
      opts = opts || {};
      this.ram = new Uint8Array(65536);
      this.color = new Uint8Array(1024);
      this.basicRom = null; this.kernalRom = null; this.charRom = null;
      this.frame = new Uint32Array(W * H);
      this.sid = new root.C64.SID(opts.sampleRate || 44100);
      this.cia1 = new CIA('cia1', on => this.setIrq(1, on));
      this.cia2 = new CIA('cia2', on => { if (on) this.cpu.nmi(); });
      this.cpu = new root.C64.cpu.CPU(a => this.read(a), (a, v) => this.write(a, v));
      this.matrix = new Uint8Array(8);       // pressed rows per column
      this.joy = [0, 0];                     // bits: 0 up 1 down 2 left 3 right 4 fire (1 = pressed)
      this.keyQueue = [];
      this.heldKeys = null; this.holdFrames = 0;
      this.frames = 0;
      this.onFrame = null;
      this.trap = -1; this.trapHit = false;
      this.vicReset();
    }

    loadRoms(basic, kernal, chars) {
      if (!basic || basic.length !== 8192) throw new Error('BASIC ROM must be 8192 bytes');
      if (!kernal || kernal.length !== 8192) throw new Error('KERNAL ROM must be 8192 bytes');
      if (!chars || chars.length !== 4096) throw new Error('character ROM must be 4096 bytes');
      this.basicRom = basic; this.kernalRom = kernal; this.charRom = chars;
    }

    setIrq(bit, on) { if (on) this.cpu.irqLine |= bit; else this.cpu.irqLine &= ~bit; }

    vicReset() {
      this.vic = new Uint8Array(64);
      this.raster = 0; this.rasterCycle = 0;
      this.vicIrq = 0; this.vicIrqMask = 0;
      this.lineFg = new Uint8Array(W);       // 1 where foreground graphics drawn on current line
      this.lineSpr = new Int8Array(W);
    }

    hardReset() {
      this.ram.fill(0);
      for (let i = 0; i < 65536; i += 128) this.ram.fill(0xff, i + 64, i + 128);   // power-on pattern
      this.ram[0] = 0x2f; this.ram[1] = 0x37;
      this.color.fill(14);
      this.cia1.reset(); this.cia2.reset(); this.sid.reset(); this.vicReset();
      this.matrix.fill(0); this.keyQueue = []; this.heldKeys = null;
      this.cpu.irqLine = 0;
      this.cpu.reset();
      this.frames = 0;
    }

    // ---- memory ------------------------------------------------------------
    port() { return (this.ram[1] | ~this.ram[0]) & 7; }   // undriven pins read as pulled up

    read(a) {
      if (a < 0xa000) {
        if (a > 1) return this.ram[a];
        if (a === 0) return this.ram[0];
        return (this.ram[1] & this.ram[0]) | (~this.ram[0] & 0x17);
      }
      const p = this.port();
      if (a < 0xc000) return ((p & 3) === 3) ? this.basicRom[a - 0xa000] : this.ram[a];
      if (a < 0xd000) return this.ram[a];
      if (a < 0xe000) {
        if ((p & 3) === 0) return this.ram[a];
        if (p & 4) return this.ioRead(a);
        return this.charRom[a - 0xd000];
      }
      return (p & 2) ? this.kernalRom[a - 0xe000] : this.ram[a];
    }

    write(a, v) {
      if (a >= 0xd000 && a < 0xe000) {
        const p = this.port();
        if ((p & 3) !== 0 && (p & 4)) { this.ioWrite(a, v); return; }
      }
      this.ram[a] = v;
    }

    ioRead(a) {
      if (a < 0xd400) return this.vicRead(a & 0x3f);
      if (a < 0xd800) return this.sid.read(a & 0x1f);
      if (a < 0xdc00) return (this.color[a & 0x3ff] & 15) | 0xf0;
      if (a < 0xdd00) {
        // CIA1: keyboard + joysticks
        const r = a & 15;
        if (r === 0 || r === 1) {
          const paOut = this.cia1.pra | ~this.cia1.ddra;
          const pbOut = this.cia1.prb | ~this.cia1.ddrb;
          let pa = paOut & ~this.joyBits(1) & 0xff;
          let pb = pbOut & ~this.joyBits(0) & 0xff;
          // Keyboard: active-low column select on PA, rows read on PB (and the reverse).
          for (let col = 0; col < 8; col++) {
            if (!(pa & (1 << col))) pb &= ~this.matrix[col];
          }
          for (let col = 0; col < 8; col++) {
            if (this.matrix[col] & ~pb & 0xff) pa &= ~(1 << col);
          }
          return this.cia1.read(r, pa & 0xff, pb & 0xff);
        }
        return this.cia1.read(r, 0xff, 0xff);
      }
      if (a < 0xde00) {
        const r = a & 15;
        if (r === 0) {
          const out = this.cia2.pra | ~this.cia2.ddra;
          // Serial bus: inputs (bits 6,7) mirror our own outputs (bits 4,5), nothing attached.
          let v = (out & 0x3f) | (out & 0x10 ? 0 : 0x40) | (out & 0x20 ? 0 : 0x80);
          return this.cia2.read(r, v & 0xff, 0xff);
        }
        return this.cia2.read(r, 0xff, this.cia2.prb | ~this.cia2.ddrb & 0xff);
      }
      return 0xff;   // open I/O areas
    }

    ioWrite(a, v) {
      if (a < 0xd400) this.vicWrite(a & 0x3f, v);
      else if (a < 0xd800) this.sid.write(a & 0x1f, v);
      else if (a < 0xdc00) this.color[a & 0x3ff] = v & 15;
      else if (a < 0xdd00) this.cia1.write(a & 15, v);
      else if (a < 0xde00) this.cia2.write(a & 15, v);
    }

    joyBits(port) { return this.joy[port] & 0x1f; }   // port 0 = joystick 1 (PB), 1 = joystick 2 (PA)

    // ---- VIC-II registers ----------------------------------------------------
    vicRead(r) {
      const v = this.vic;
      switch (r) {
        case 0x11: return (v[0x11] & 0x7f) | ((this.raster & 0x100) >> 1);
        case 0x12: return this.raster & 0xff;
        case 0x16: return v[0x16] | 0xc0;
        case 0x18: return v[0x18] | 0x01;
        case 0x19: return this.vicIrq | ((this.vicIrq & this.vicIrqMask) ? 0x80 : 0) | 0x70;
        case 0x1a: return this.vicIrqMask | 0xf0;
        case 0x1e: { const x = v[0x1e]; v[0x1e] = 0; return x; }
        case 0x1f: { const x = v[0x1f]; v[0x1f] = 0; return x; }
      }
      if (r >= 0x20 && r <= 0x2e) return v[r] | 0xf0;
      if (r > 0x2e) return 0xff;
      return v[r];
    }

    vicWrite(r, val) {
      switch (r) {
        case 0x19: this.vicIrq &= ~val & 0x0f; this.updateVicIrq(); return;
        case 0x1a: this.vicIrqMask = val & 0x0f; this.updateVicIrq(); return;
        case 0x1e: case 0x1f: return;
      }
      if (r < 0x2f) this.vic[r] = val;
    }

    updateVicIrq() { this.setIrq(2, (this.vicIrq & this.vicIrqMask) !== 0); }

    rasterCompare() { return this.vic[0x12] | ((this.vic[0x11] & 0x80) << 1); }

    // VIC memory read (14-bit address within the bank selected by CIA2).
    vicMem(addr) {
      const pa = this.cia2.pra | ~this.cia2.ddra;
      const bank = (3 - (pa & 3)) & 3;
      if ((bank === 0 || bank === 2) && (addr & 0x3000) === 0x1000) return this.charRom[addr & 0x0fff];
      return this.ram[(bank << 14) | (addr & 0x3fff)];
    }

    // ---- rendering one raster line ------------------------------------------
    renderLine(line) {
      const y = line - FIRST_LINE;
      if (y < 0 || y >= H) return;
      const v = this.vic;
      const out = this.frame;
      const rowBase = y * W;
      const border = PAL32[v[0x20] & 15];
      const ctrl1 = v[0x11], ctrl2 = v[0x16];
      const den = ctrl1 & 0x10;
      const rsel = ctrl1 & 8, csel = ctrl2 & 8;
      const top = rsel ? 51 : 55, bottom = rsel ? 251 : 247;
      const fg = this.lineFg; fg.fill(0);
      if (!den || line < top || line >= bottom) {
        for (let x = 0; x < W; x++) out[rowBase + x] = border;
        this.drawSprites(line, rowBase, true);
        return;
      }
      const yscroll = ctrl1 & 7, xscroll = ctrl2 & 7;
      const bmm = ctrl1 & 0x20, ecm = ctrl1 & 0x40, mcm = ctrl2 & 0x10;
      const d018 = v[0x18];
      const screenBase = ((d018 >> 4) & 15) << 10;
      const charBase = ((d018 >> 1) & 7) << 11;
      const bitmapBase = (d018 & 8) << 10;
      const bg0 = v[0x21] & 15, bg1 = v[0x22] & 15, bg2 = v[0x23] & 15, bg3 = v[0x24] & 15;
      const gy = line - (0x30 + yscroll);
      const left = 32 + xscroll;
      // Background first.
      const bgc = PAL32[bmm && !mcm ? 0 : bg0];
      for (let x = 0; x < W; x++) out[rowBase + x] = bgc;
      if (gy >= 0 && gy < 200) {
        const row = gy >> 3, pix = gy & 7;
        for (let col = 0; col < 40; col++) {
          const scr = this.vicMem(screenBase + row * 40 + col);
          const colr = this.color[row * 40 + col] & 15;
          const x0 = left + col * 8;
          let bits, c = [0, 0, 0, 0], multi = false;
          if (bmm) {
            bits = this.vicMem(bitmapBase + row * 320 + col * 8 + pix);
            if (mcm) { multi = true; c = [bg0, scr >> 4, scr & 15, colr]; }
            else { c[0] = scr & 15; c[1] = scr >> 4; }
            if (ecm) { bits = 0; c = [0, 0, 0, 0]; }
          } else {
            const code = ecm ? scr & 0x3f : scr;
            bits = this.vicMem(charBase + code * 8 + pix);
            if (ecm) { c[0] = [bg0, bg1, bg2, bg3][scr >> 6]; c[1] = colr; if (mcm) { bits = 0; c[0] = 0; } }
            else if (mcm && (colr & 8)) { multi = true; c = [bg0, bg1, bg2, colr & 7]; }
            else { c[0] = bg0; c[1] = mcm ? colr & 7 : colr; }
          }
          if (multi) {
            for (let k = 0; k < 4; k++) {
              const pair = (bits >> (6 - 2 * k)) & 3;
              const px = PAL32[c[pair]];
              const xa = x0 + k * 2;
              if (xa >= 0 && xa < W) { out[rowBase + xa] = px; if (pair & 2) fg[xa] = 1; }
              if (xa + 1 < W) { out[rowBase + xa + 1] = px; if (pair & 2) fg[xa + 1] = 1; }
            }
          } else {
            const p0 = PAL32[c[0]], p1 = PAL32[c[1]];
            for (let k = 0; k < 8; k++) {
              const xa = x0 + k;
              if (xa >= W) break;
              if (bits & (0x80 >> k)) { out[rowBase + xa] = p1; fg[xa] = 1; } else out[rowBase + xa] = p0;
            }
          }
        }
      }
      this.drawSprites(line, rowBase, false);
      // Side borders (drawn last so they cover sprites and scrolled graphics).
      const l = csel ? 32 : 39, r = csel ? 352 : 343;
      for (let x = 0; x < l; x++) out[rowBase + x] = border;
      for (let x = r; x < W; x++) out[rowBase + x] = border;
    }

    drawSprites(line, rowBase, inBorder) {
      const v = this.vic;
      const enable = v[0x15];
      if (!enable) return;
      const out = this.frame;
      const pa = this.cia2.pra | ~this.cia2.ddra;
      const screenBase = ((v[0x18] >> 4) & 15) << 10;
      const spr = this.lineSpr; spr.fill(-1);
      let sprColl = 0, bgColl = 0;
      for (let n = 7; n >= 0; n--) {
        if (!(enable & (1 << n))) continue;
        const sy = v[1 + n * 2];
        const yexp = (v[0x17] >> n) & 1;
        const dy = line - 1 - sy;
        if (dy < 0 || dy >= (yexp ? 42 : 21)) continue;
        const srow = yexp ? dy >> 1 : dy;
        const ptr = this.vicMem(screenBase + 0x3f8 + n);
        const base = ptr * 64 + srow * 3;
        const data = (this.vicMem(base) << 16) | (this.vicMem(base + 1) << 8) | this.vicMem(base + 2);
        if (!data) continue;
        let sx = v[n * 2] | (((v[0x10] >> n) & 1) << 8);
        if (sx >= 0x1f8) sx -= 0x1f8;        // wrap
        const xexp = (v[0x1d] >> n) & 1;
        const mc = (v[0x1c] >> n) & 1;
        const behind = (v[0x1b] >> n) & 1;
        const colors = [0, v[0x25] & 15, v[0x27 + n] & 15, v[0x26] & 15];
        const x0 = sx + 8;                    // sprite X 24 == canvas X 32
        const width = xexp ? 48 : 24;
        for (let px = 0; px < width; px++) {
          const bit = xexp ? px >> 1 : px;
          let ci;
          if (mc) ci = (data >> (22 - (bit & ~1))) & 3;
          else ci = ((data >> (23 - bit)) & 1) ? 2 : 0;
          if (!ci) continue;
          const x = x0 + px;
          if (x < 0 || x >= W) continue;
          if (spr[x] >= 0) sprColl |= (1 << n) | (1 << spr[x]);
          spr[x] = n;
          if (this.lineFg[x]) bgColl |= 1 << n;
          if (behind && this.lineFg[x]) continue;
          out[rowBase + x] = PAL32[colors[ci]];
        }
      }
      if (sprColl) { if (!v[0x1e]) { this.vicIrq |= 4; this.updateVicIrq(); } v[0x1e] |= sprColl; }
      if (bgColl && !inBorder) { if (!v[0x1f]) { this.vicIrq |= 2; this.updateVicIrq(); } v[0x1f] |= bgColl; }
    }

    // ---- main loop ------------------------------------------------------------
    runCycles(n) {
      const cpu = this.cpu;
      let done = 0;
      while (done < n) {
        const c = cpu.step();
        done += c;
        if (cpu.pc === this.trap) this.trapHit = true;
        this.cia1.clock(c); this.cia2.clock(c);
        this.sid.clock(c);
        this.rasterCycle += c;
        if (this.rasterCycle >= CYCLES_PER_LINE) {
          this.rasterCycle -= CYCLES_PER_LINE;
          this.renderLine(this.raster);
          this.raster++;
          if (this.raster >= LINES) { this.raster = 0; this.endFrame(); }
          if (this.raster === this.rasterCompare()) { this.vicIrq |= 1; this.updateVicIrq(); }
        }
        if (this.trapHit) break;
      }
      return done;
    }

    endFrame() {
      this.frames++;
      if (this.frames % 5 === 0) { this.cia1.tickTod(); this.cia2.tickTod(); }
      this.processKeys();
      if (this.onFrame) this.onFrame(this.frame);
    }

    runFrame() { return this.runCycles((LINES - this.raster) * CYCLES_PER_LINE - this.rasterCycle); }

    // ---- input ------------------------------------------------------------------
    keyDown(name) { const k = KEYS[name]; if (k) this.matrix[k[0]] |= 1 << k[1]; if (name === 'RESTORE') this.cpu.nmi(); }
    keyUp(name) { const k = KEYS[name]; if (k) this.matrix[k[0]] &= ~(1 << k[1]); }

    // Queue characters / named keys to be "typed" through the keyboard matrix.
    type(items) {
      for (const it of items) { const ks = keysFor(it); if (ks) this.keyQueue.push(ks); }
    }

    processKeys() {
      if (this.heldKeys) {
        if (--this.holdFrames > 0) return;
        this.heldKeys.forEach(k => this.keyUp(k));
        this.heldKeys = null;
        this.holdFrames = -1;             // one released frame between keys
        return;
      }
      if (this.holdFrames < 0) { this.holdFrames = 0; return; }
      if (this.keyQueue.length) {
        this.heldKeys = this.keyQueue.shift();
        this.heldKeys.forEach(k => this.keyDown(k));
        this.holdFrames = 2;
      }
    }

    // Put text straight into the KERNAL keyboard buffer (max 10 chars at a time).
    feedKeyboardBuffer(text) {
      const bytes = [...text].map(ch => (ch === '\n' || ch === '\r') ? 13 : root.C64.basic.asciiToPetscii(ch)).slice(0, 10);
      bytes.forEach((b, i) => { this.ram[0x277 + i] = b; });
      this.ram[0xc6] = bytes.length;
    }

    // ---- screen helpers -----------------------------------------------------------
    screenBase() {
      const pa = this.cia2.pra | ~this.cia2.ddra;
      const bank = (3 - (pa & 3)) & 3;
      return (bank << 14) | (((this.vic[0x18] >> 4) & 15) << 10);
    }

    // Current text screen as ASCII (25 lines of 40 chars).
    screenText() {
      const base = this.screenBase();
      const lines = [];
      for (let r = 0; r < 25; r++) {
        let s = '';
        for (let c = 0; c < 40; c++) {
          const code = this.ram[(base + r * 40 + c) & 0xffff] & 0x7f;
          if (code === 0) s += '@';
          else if (code < 27) s += String.fromCharCode(64 + code);
          else if (code < 32) s += '[£]↑←'[code - 27];
          else if (code < 64) s += String.fromCharCode(code);
          else s += code === 0x40 ? '-' : '#';
        }
        lines.push(s.replace(/\s+$/, ''));
      }
      return lines.join('\n').replace(/\n+$/, '');
    }

    // Boot until BASIC prints READY. (fast, no rendering of intermediate frames needed)
    boot(maxFrames) {
      this.hardReset();
      maxFrames = maxFrames || 250;
      for (let f = 0; f < maxFrames; f++) {
        this.runFrame();
        if (f > 10 && /READY\./.test(this.screenText())) {
          for (let k = 0; k < 3; k++) this.runFrame();
          return true;
        }
      }
      return false;
    }

    // Load a .prg into memory. Returns {load, end}.
    loadPrg(prg) {
      const load = prg[0] | (prg[1] << 8);
      const data = prg.subarray(2);
      const end = load + data.length;
      if (end > 0x10000) throw new Error('program does not fit in memory');
      this.ram.set(data, load);
      if (load === 0x0801) {
        // Set BASIC's end-of-program pointers like LOAD would.
        const ptrs = [0x2d, 0x2f, 0x31, 0xae];
        ptrs.forEach(p => { this.ram[p] = end & 0xff; this.ram[p + 1] = end >> 8; });
      }
      return { load, end };
    }

    // Boot (if needed), load and start a program.
    runProgram(prg, startAddr) {
      this.boot();
      const { load } = this.loadPrg(prg);
      this.sid.reset();
      if (load === 0x0801 && !startAddr) this.feedKeyboardBuffer('RUN\r');
      else this.feedKeyboardBuffer(`SYS${startAddr || load}\r`);
    }
  }

  const api = { C64, KEYS, keysFor, W, H, PALETTE, CYCLES_PER_FRAME, CLOCK_HZ: 985248, FPS: 985248 / CYCLES_PER_FRAME };
  root.C64 = root.C64 || {};
  root.C64.machine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
