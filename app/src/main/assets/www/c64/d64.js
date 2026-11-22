// 1541 .d64 disk image writer and reader (35 tracks, 174,848 bytes).
(function (root) {
  'use strict';

  const TRACKS = 35;
  const spt = t => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
  const offsets = [0, 0];
  for (let t = 1; t <= TRACKS; t++) offsets[t + 1] = offsets[t] + spt(t) * 256;
  const IMAGE_SIZE = offsets[TRACKS + 1];                    // 174848
  const off = (t, s) => offsets[t] + s * 256;

  // Name -> 16 PETSCII bytes padded with $A0.
  function petName(name, len) {
    len = len || 16;
    const b = [];
    for (const ch of String(name).toUpperCase()) {
      if (b.length >= len) break;
      const c = ch.charCodeAt(0);
      b.push(c >= 0x20 && c <= 0x5f ? c : 0x2e);
    }
    while (b.length < len) b.push(0xa0);
    return b;
  }

  class D64 {
    constructor(diskName, diskId) {
      this.img = new Uint8Array(IMAGE_SIZE);
      this.free = [];                      // free[t][s] = true when free
      for (let t = 1; t <= TRACKS; t++) this.free[t] = new Array(spt(t)).fill(true);
      this.free[18][0] = false;            // BAM
      this.free[18][1] = false;            // first directory sector
      this.dirSectors = [1];
      this.dirEntries = 0;
      const bam = off(18, 0);
      this.img[bam] = 18; this.img[bam + 1] = 1;
      this.img[bam + 2] = 0x41;
      this.img.set(petName(diskName || 'C64 CODER'), bam + 0x90);
      this.img[bam + 0xa0] = 0xa0; this.img[bam + 0xa1] = 0xa0;
      const id = petName(diskId || '64', 2);
      this.img[bam + 0xa2] = id[0]; this.img[bam + 0xa3] = id[1];
      this.img[bam + 0xa4] = 0xa0;
      this.img[bam + 0xa5] = 0x32; this.img[bam + 0xa6] = 0x41;   // "2A"
      for (let i = 0xa7; i <= 0xaa; i++) this.img[bam + i] = 0xa0;
      const dir = off(18, 1);
      this.img[dir] = 0; this.img[dir + 1] = 0xff;
    }

    // Find the next free data sector, 1541 style: tracks nearest the directory first.
    allocate(lastT, lastS) {
      const order = [];
      for (let t = 17; t >= 1; t--) order.push(t);
      for (let t = 19; t <= TRACKS; t++) order.push(t);
      let start = lastT ? order.indexOf(lastT) : 0;
      for (let k = 0; k < order.length; k++) {
        const t = order[(start + k) % order.length];
        const n = spt(t);
        const first = (t === lastT) ? (lastS + 10) % n : 0;
        for (let j = 0; j < n; j++) {
          const s = (first + j) % n;
          if (this.free[t][s]) { this.free[t][s] = false; return [t, s]; }
        }
      }
      throw new Error('disk full');
    }

    freeBlocks() {
      let n = 0;
      for (let t = 1; t <= TRACKS; t++) if (t !== 18) n += this.free[t].filter(Boolean).length;
      return n;
    }

    newDirEntrySlot() {
      const idx = this.dirEntries++;
      const sectorIdx = Math.floor(idx / 8);
      if (sectorIdx >= this.dirSectors.length) {
        const prev = this.dirSectors[this.dirSectors.length - 1];
        let s = -1;
        for (let j = 1; j <= 18; j++) { const c = (prev + 3 * j) % 19; if (this.free[18][c]) { s = c; break; } }
        if (s < 0) throw new Error('directory full');
        this.free[18][s] = false;
        const prevOff = off(18, prev);
        this.img[prevOff] = 18; this.img[prevOff + 1] = s;
        const o = off(18, s);
        this.img[o] = 0; this.img[o + 1] = 0xff;
        this.dirSectors.push(s);
      }
      return off(18, this.dirSectors[sectorIdx]) + (idx % 8) * 32;
    }

    // Add a file. data is the full file content (for PRG: including load address).
    addFile(name, data, type) {
      type = type === undefined ? 0x82 : type;             // 0x82 = closed PRG
      data = data instanceof Uint8Array ? data : new Uint8Array(data);
      const blocks = Math.max(1, Math.ceil(data.length / 254));
      if (blocks > this.freeBlocks()) throw new Error('not enough free blocks on disk');
      const chain = [];
      let t = 0, s = 0;
      for (let b = 0; b < blocks; b++) { [t, s] = this.allocate(t, s); chain.push([t, s]); }
      for (let b = 0; b < blocks; b++) {
        const o = off(chain[b][0], chain[b][1]);
        const part = data.subarray(b * 254, b * 254 + 254);
        if (b < blocks - 1) { this.img[o] = chain[b + 1][0]; this.img[o + 1] = chain[b + 1][1]; }
        else { this.img[o] = 0; this.img[o + 1] = part.length + 1; }
        this.img.set(part, o + 2);
      }
      const e = this.newDirEntrySlot();
      this.img[e + 2] = type;
      this.img[e + 3] = chain[0][0]; this.img[e + 4] = chain[0][1];
      this.img.set(petName(name), e + 5);
      this.img[e + 0x1e] = blocks & 0xff; this.img[e + 0x1f] = blocks >> 8;
      return this;
    }

    build() {
      const bam = off(18, 0);
      for (let t = 1; t <= TRACKS; t++) {
        const o = bam + 4 * t;
        let bits = 0, count = 0;
        this.free[t].forEach((f, s) => { if (f) { bits |= 1 << s; count++; } });
        this.img[o] = count;
        this.img[o + 1] = bits & 0xff; this.img[o + 2] = (bits >> 8) & 0xff; this.img[o + 3] = (bits >> 16) & 0xff;
      }
      return this.img;
    }
  }

  // Read a .d64: returns {name, files:[{name,type,blocks,data}]}
  function readD64(img) {
    if (img.length < IMAGE_SIZE) throw new Error('not a 35-track .d64 image');
    const bam = off(18, 0);
    const txt = bytes => String.fromCharCode(...[...bytes].filter(b => b !== 0xa0).map(b => (b >= 0x20 && b < 0x7f ? b : 0x3f)));
    const name = txt(img.subarray(bam + 0x90, bam + 0xa0));
    const files = [];
    let t = img[bam], s = img[bam + 1], guard = 0;
    while (t && guard++ < 40) {
      const o = off(t, s);
      for (let i = 0; i < 8; i++) {
        const e = o + i * 32;
        const type = img[e + 2];
        if (!(type & 0x80)) continue;
        const f = { name: txt(img.subarray(e + 5, e + 21)), type: ['DEL', 'SEQ', 'PRG', 'USR', 'REL'][type & 7] || '?', blocks: img[e + 0x1e] | (img[e + 0x1f] << 8) };
        const parts = [];
        let ft = img[e + 3], fs = img[e + 4], g = 0;
        while (ft && g++ < 700) {
          const so = off(ft, fs);
          const nt = img[so], ns = img[so + 1];
          parts.push(img.subarray(so + 2, nt ? so + 256 : so + ns + 1));
          ft = nt; fs = ns;
        }
        const len = parts.reduce((a, p) => a + p.length, 0);
        f.data = new Uint8Array(len);
        let p = 0; parts.forEach(x => { f.data.set(x, p); p += x.length; });
        files.push(f);
      }
      t = img[o]; s = img[o + 1];
    }
    return { name, files };
  }

  // Convenience: one PRG (plus optional source as a SEQ file) on a fresh disk.
  function makeDisk(diskName, files) {
    const d = new D64(diskName, '64');
    files.forEach(f => d.addFile(f.name, f.data, f.type));
    return d.build();
  }

  const api = { D64, readD64, makeDisk, IMAGE_SIZE, petName };
  root.C64 = root.C64 || {};
  root.C64.d64 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
