// Simple 6581 SID approximation: three voices (triangle, sawtooth, pulse,
// noise), ADSR envelopes, ring mod / sync, a basic state-variable filter and
// master volume. Samples are produced while the CPU runs so note timing is right.
(function (root) {
  'use strict';

  const CLOCK = 985248;                        // PAL phi2
  // Envelope rates in ms (attack) from the datasheet; decay/release are 3x.
  const ATTACK_MS = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];

  class Voice {
    constructor() {
      this.freq = 0; this.pw = 0; this.ctrl = 0; this.ad = 0; this.sr = 0;
      this.acc = 0; this.noise = 0x7ffff8; this.env = 0; this.state = 'release';
      this.prevMsb = 0;
    }
  }

  class SID {
    constructor(sampleRate) {
      this.sampleRate = sampleRate || 44100;
      this.cyclesPerSample = CLOCK / this.sampleRate;
      this.reset();
      this.buffer = new Float32Array(16384);
      this.writePos = 0; this.readPos = 0;
      this.enabled = true;
    }

    setSampleRate(rate) { this.sampleRate = rate; this.cyclesPerSample = CLOCK / rate; }

    reset() {
      this.v = [new Voice(), new Voice(), new Voice()];
      this.regs = new Uint8Array(32);
      this.fc = 0; this.res = 0; this.filt = 0; this.mode = 0; this.vol = 0;
      this.bp = 0; this.lp = 0;
      this.cycleAcc = 0;
    }

    write(reg, val) {
      reg &= 0x1f;
      this.regs[reg] = val;
      if (reg < 21) {
        const v = this.v[Math.floor(reg / 7)];
        switch (reg % 7) {
          case 0: v.freq = (v.freq & 0xff00) | val; break;
          case 1: v.freq = (v.freq & 0xff) | (val << 8); break;
          case 2: v.pw = (v.pw & 0xf00) | val; break;
          case 3: v.pw = (v.pw & 0xff) | ((val & 15) << 8); break;
          case 4: {
            const gateOn = (val & 1) && !(v.ctrl & 1);
            const gateOff = !(val & 1) && (v.ctrl & 1);
            if (gateOn) v.state = 'attack';
            if (gateOff) v.state = 'release';
            if (val & 8) { v.acc = 0; v.noise = 0x7ffff8; }
            v.ctrl = val;
            break;
          }
          case 5: v.ad = val; break;
          case 6: v.sr = val; break;
        }
      } else if (reg === 21) this.fc = (this.fc & 0x7f8) | (val & 7);
      else if (reg === 22) this.fc = (this.fc & 7) | (val << 3);
      else if (reg === 23) { this.res = val >> 4; this.filt = val & 15; }
      else if (reg === 24) { this.mode = val >> 4; this.vol = val & 15; }
    }

    read(reg) {
      reg &= 0x1f;
      if (reg === 27) return (this.v[2].lastOut >> 4) & 0xff || 0;   // OSC3
      if (reg === 28) return Math.round(this.v[2].env) & 0xff;        // ENV3
      if (reg === 25 || reg === 26) return 0xff;                        // paddles
      return 0;
    }

    envStep(v, dtMs) {
      switch (v.state) {
        case 'attack': {
          v.env += 255 * dtMs / ATTACK_MS[v.ad >> 4];
          if (v.env >= 255) { v.env = 255; v.state = 'decay'; }
          break;
        }
        case 'decay': {
          const sustain = (v.sr >> 4) * 17;
          if (v.env > sustain) {
            v.env -= 255 * dtMs / (ATTACK_MS[v.ad & 15] * 3);
            if (v.env < sustain) v.env = sustain;
          }
          break;
        }
        case 'release': {
          if (v.env > 0) {
            v.env -= 255 * dtMs / (ATTACK_MS[v.sr & 15] * 3);
            if (v.env < 0) v.env = 0;
          }
          break;
        }
      }
    }

    // Produce one output sample in -1..1.
    sample() {
      const dtMs = 1000 / this.sampleRate;
      let direct = 0, filtered = 0;
      const step = this.cyclesPerSample;
      for (let i = 0; i < 3; i++) {
        const v = this.v[i];
        const src = this.v[(i + 2) % 3];
        const oldAcc = v.acc;
        if (!(v.ctrl & 8)) v.acc = (v.acc + v.freq * step) % 16777216;
        const msb = v.acc >= 8388608 ? 1 : 0;
        // Hard sync: reset when the source voice's MSB rises.
        if ((v.ctrl & 2) && src.syncPulse) v.acc = 0;
        v.syncPulse = msb && !v.prevMsb;
        v.prevMsb = msb;
        // Clock the noise LFSR on accumulator bit 19 transitions.
        const clocks = Math.floor(v.acc / 524288) - Math.floor(oldAcc / 524288);
        if (clocks) {
          for (let k = 0; k < Math.min(Math.abs(clocks), 4); k++) {
            const bit = ((v.noise >> 22) ^ (v.noise >> 17)) & 1;
            v.noise = ((v.noise << 1) | bit) & 0x7fffff;
          }
        }
        const acc12 = Math.floor(v.acc / 4096);           // 12-bit phase
        let out = 0, n = 0;
        if (v.ctrl & 0x10) {                             // triangle
          let t = acc12 << 1;
          let invert = acc12 & 0x800;
          if (v.ctrl & 4) invert ^= (Math.floor(src.acc / 4096) & 0x800);  // ring mod
          if (invert) t = 0x1fff - t;
          out += (t >> 1) & 0xfff; n++;
        }
        if (v.ctrl & 0x20) { out += acc12; n++; }                         // sawtooth
        if (v.ctrl & 0x40) { out += acc12 >= v.pw ? 0xfff : 0; n++; }      // pulse
        if (v.ctrl & 0x80) {                                              // noise
          const nz = v.noise;
          out += (((nz >> 20) & 1) << 11) | (((nz >> 18) & 1) << 10) | (((nz >> 14) & 1) << 9) |
            (((nz >> 11) & 1) << 8) | (((nz >> 9) & 1) << 7) | (((nz >> 5) & 1) << 6) |
            (((nz >> 2) & 1) << 5) | ((nz & 1) << 4);
          n++;
        }
        if (n > 1) out = out / n;                          // crude combined waveform
        v.lastOut = out;
        this.envStep(v, dtMs);
        const s = n ? ((out - 2048) / 2048) * (v.env / 255) : 0;
        if (i === 2 && (this.mode & 8) && !(this.filt & 4)) continue;     // voice 3 off
        if (this.filt & (1 << i)) filtered += s; else direct += s;
      }
      // State-variable filter (Chamberlin).
      if (this.filt & 7) {
        const cutoff = 30 + this.fc * 5.8;                         // ~30Hz..12kHz
        const f = 2 * Math.sin(Math.PI * Math.min(cutoff, this.sampleRate / 4) / this.sampleRate);
        const q = 1.4 - this.res / 15;
        const hp = filtered - this.lp - q * this.bp;
        this.bp += f * hp;
        this.lp += f * this.bp;
        let fo = 0;
        if (this.mode & 1) fo += this.lp;
        if (this.mode & 2) fo += this.bp;
        if (this.mode & 4) fo += hp;
        direct += fo;
      }
      return direct * (this.vol / 15) * 0.25;
    }

    // Advance by CPU cycles, producing samples into the ring buffer.
    clock(cycles) {
      if (!this.enabled) return;
      this.cycleAcc += cycles;
      const buf = this.buffer, mask = buf.length - 1;
      while (this.cycleAcc >= this.cyclesPerSample) {
        this.cycleAcc -= this.cyclesPerSample;
        const next = (this.writePos + 1) & mask;
        if (next === this.readPos) { this.sample(); continue; }   // buffer full: drop
        buf[this.writePos] = this.sample();
        this.writePos = next;
      }
    }

    // Pull samples for the audio callback.
    pull(out) {
      const buf = this.buffer, mask = buf.length - 1;
      let last = 0;
      for (let i = 0; i < out.length; i++) {
        if (this.readPos !== this.writePos) { last = buf[this.readPos]; this.readPos = (this.readPos + 1) & mask; }
        out[i] = last;
      }
    }

    buffered() { return (this.writePos - this.readPos) & (this.buffer.length - 1); }
  }

  root.C64 = root.C64 || {};
  root.C64.SID = SID;
  if (typeof module !== 'undefined' && module.exports) module.exports = { SID };
})(typeof globalThis !== 'undefined' ? globalThis : this);
