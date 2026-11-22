// Built-in Commodore BASIC V2 interpreter.
//
// The free Open ROMs that ship with the app have a KERNAL that works, but
// their BASIC can't do arithmetic yet. So when no original Commodore BASIC ROM
// is installed, this interpreter runs the tokenized program that sits in the
// emulated RAM. Everything else is still the emulator: PRINT goes through the
// KERNAL's CHROUT, INPUT through CHRIN, GET through GETIN, PEEK/POKE/SYS touch
// the emulated memory, VIC-II, SID and CIAs. Statement speed is throttled to
// roughly real C64 speed.
(function (root) {
  'use strict';

  const KW = root.C64.basic.KEYWORDS;
  const T = {};
  KW.forEach((k, i) => { T[k] = 0x80 + i; });
  const PI_TOKEN = 0xff;
  const IDLE = 0x02a7;          // CLI ; JMP $02A8 (free RAM in page 2)
  const CHROUT = 0xffd2, CHRIN = 0xffcf, GETIN = 0xffe4;

  const ERR = {
    SYNTAX: 'SYNTAX', NEXT: 'NEXT WITHOUT FOR', RETURN: 'RETURN WITHOUT GOSUB', DATA: 'OUT OF DATA',
    QTY: 'ILLEGAL QUANTITY', OVERFLOW: 'OVERFLOW', MEM: 'OUT OF MEMORY', UNDEF: "UNDEF'D STATEMENT",
    SUB: 'BAD SUBSCRIPT', REDIM: "REDIM'D ARRAY", DIV0: 'DIVISION BY ZERO', DIRECT: 'ILLEGAL DIRECT',
    TYPE: 'TYPE MISMATCH', LONG: 'STRING TOO LONG', COMPLEX: 'FORMULA TOO COMPLEX', CONT: "CAN'T CONTINUE",
    FN: "UNDEF'D FUNCTION", NOFILE: 'FILE NOT OPEN', OPEN: 'FILE OPEN', DEVICE: 'DEVICE NOT PRESENT',
    NOTINPUT: 'NOT INPUT FILE', NOTOUTPUT: 'NOT OUTPUT FILE'
  };
  class BErr extends Error { constructor(m) { super(m); this.basic = true; } }
  const fail = m => { throw new BErr(m); };

  const isDigit = c => c >= 0x30 && c <= 0x39;
  const isAlpha = c => c >= 0x41 && c <= 0x5a;

  // C64-style number formatting (9 significant digits).
  function fmtNum(x) {
    if (!isFinite(x)) fail(ERR.OVERFLOW);
    if (x === 0) return '0';
    const neg = x < 0;
    let a = Math.abs(x);
    a = Number(a.toPrecision(9));
    let s;
    if (a >= 1e9 || a < 0.01) {
      let [m, e] = a.toExponential(8).split('e');
      m = m.replace(/\.?0+$/, '');
      const en = parseInt(e, 10);
      s = m + 'E' + (en < 0 ? '-' : '+') + String(Math.abs(en)).padStart(2, '0');
    } else {
      s = a.toPrecision(9);
      if (s.includes('e')) s = a.toFixed(10);
      if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
      if (s.startsWith('0.')) s = s.slice(1);
    }
    return (neg ? '-' : '') + s;
  }

  function strToNum(s) {
    // VAL(): leading spaces ignored, parse as far as possible.
    const t = s.replace(/^\s+/, '').replace(/ /g, '');
    const m = t.match(/^[+-]?(\d+\.?\d*|\.\d+)(E[+-]?\d+)?/i);
    return m ? parseFloat(m[0]) : 0;
  }

  class BasicInterpreter {
    constructor(machine) {
      this.m = machine;
      this.cpu = machine.cpu;
      this.state = 'idle';
      this.turbo = 1;
      this.onEnd = null;
      this.onError = null;
      this.lastError = null;
      this.onProgramChanged = null;   // called with the new listing after lines are typed in
      this.lines = []; this.index = new Map();
      this.direct = null;
      this.li = 0; this.p = 0;
      this.clearVars();
    }

    // ---------------------------------------------------------- program -----
    loadFromRam() {
      const ram = this.m.ram;
      this.lines = [];
      this.index = new Map();
      let p = 0x0801, guard = 0;
      while (guard++ < 10000) {
        const next = ram[p] | (ram[p + 1] << 8);
        if (!next) break;
        const num = ram[p + 2] | (ram[p + 3] << 8);
        let e = p + 4;
        while (ram[e] !== 0 && e < 0xa000) e++;
        this.index.set(num, this.lines.length);
        this.lines.push({ num, b: ram.slice(p + 4, e) });
        if (next <= p) break;
        p = next;
      }
    }

    clearVars() {
      this.vars = new Map();
      this.arrays = new Map();
      this.fns = new Map();
      this.stack = [];
      this.dataLi = 0; this.dataP = 0; this.dataInLine = false;
      this.files = new Map();
      this.rndSeed = 0x12345678 ^ (Date.now() & 0xffff);
    }

    // Write this.lines back to RAM at $0801 (after lines were typed in).
    writeProgramToRam() {
      const ram = this.m.ram;
      let p = 0x0801;
      for (const l of this.lines) {
        const next = p + 4 + l.b.length + 1;
        if (next > 0x9fff) fail(ERR.MEM);
        ram[p] = next & 0xff; ram[p + 1] = next >> 8; ram[p + 2] = l.num & 0xff; ram[p + 3] = l.num >> 8;
        ram.set(l.b, p + 4); ram[next - 1] = 0;
        p = next;
      }
      ram[p] = 0; ram[p + 1] = 0; p += 2;
      [0x2d, 0x2f, 0x31, 0xae].forEach(z => { ram[z] = p & 0xff; ram[z + 1] = p >> 8; });
      this.index = new Map(this.lines.map((l, i) => [l.num, i]));
    }

    listing() {
      const parts = [];
      for (const l of this.lines) {
        let s = l.num + ' ', q = false;
        for (const c of l.b) {
          if (c === 0x22) q = !q;
          if (!q && c >= 0x80 && c <= 0xcb) s += KW[c - 0x80];
          else if (c === 0xff) s += 'π';
          else if (c >= 0x20 && c <= 0x5f && c !== 0x5c) s += String.fromCharCode(c);
          else s += '{' + c + '}';
        }
        parts.push(s);
      }
      return parts.join('\n') + (parts.length ? '\n' : '');
    }

    // Take over the CPU: it spins in a tiny idle loop (with interrupts on)
    // whenever JavaScript is executing BASIC.
    attach() {
      this.call = null;
      this.lastError = null;
      const ram = this.m.ram;
      // Idle loop for the CPU while JavaScript runs BASIC statements.
      ram[IDLE] = 0x58; ram[IDLE + 1] = 0x4c; ram[IDLE + 2] = (IDLE + 1) & 0xff; ram[IDLE + 3] = (IDLE + 1) >> 8;
      ram[0xc6] = 0;          // empty keyboard buffer
      ram[0xcc] = 1;          // cursor off
      this.cpu.sp = 0xf6;
      this.cpu.p &= ~4;
      this.cpu.pc = IDLE;
      this.cpu.jammed = false;
    }

    // Start running the BASIC program currently in RAM.
    start() {
      this.loadFromRam();
      this.clearVars();
      this.attach();
      this.li = 0; this.p = 0;
      if (this.lines.length) this.state = 'running';
      else this.enterDirect();
    }

    // Just show the blinking cursor and accept BASIC commands (after a reset).
    startDirect() {
      this.loadFromRam();
      this.clearVars();
      this.attach();
      this.enterDirect();
    }

    // ------------------------------------------------------ direct mode -----
    enterDirect() {
      this.state = 'direct';
      this.li = -1; this.p = 0;
      this.direct = { num: null, b: new Uint8Array(0) };
      this.readDirect();
    }

    readDirect() {
      this.directBuf = '';
      const more = () => this.callAsync(CHRIN, 0, 0, 0, a => {
        if (a !== 13) { this.directBuf += String.fromCharCode(a); more(); return; }
        this.print('\r');
        this.directLine(this.directBuf);
      });
      more();
    }

    directLine(text) {
      const t = text.replace(/^\s+/, '').replace(/\s+$/, '');
      if (!t) { this.readDirect(); return; }
      const B = root.C64.basic;
      if (/^\d/.test(t)) {
        // Program line: add, replace or delete it.
        let parsed;
        try { parsed = B.parseListing(t)[0]; } catch (e) { fail(ERR.SYNTAX); }
        const at = this.lines.findIndex(l => l.num >= parsed.num);
        const exists = at >= 0 && this.lines[at].num === parsed.num;
        const entry = { num: parsed.num, b: Uint8Array.from(parsed.bytes) };
        if (!parsed.bytes.length) { if (exists) this.lines.splice(at, 1); }
        else if (exists) this.lines[at] = entry;
        else if (at < 0) this.lines.push(entry);
        else this.lines.splice(at, 0, entry);
        this.writeProgramToRam();
        this.clearVars();
        if (this.onProgramChanged) this.onProgramChanged(this.listing());
        this.readDirect();
        return;
      }
      let bytes;
      try { bytes = B.parseListing('0 ' + t)[0].bytes; } catch (e) { fail(ERR.SYNTAX); }
      this.direct = { num: null, b: Uint8Array.from(bytes) };
      this.li = -1; this.p = 0;
      this.m.ram[0xcc] = 1;
      this.state = 'running';
    }

    stop() { this.state = 'idle'; this.call = null; this.m.trap = -1; }

    get running() { return this.state !== 'idle'; }

    // ---------------------------------------------------- CPU calls --------
    // Let the CPU finish any interrupt handler and get back to the idle loop
    // before we borrow it for a KERNAL call.
    waitIdle() {
      const cpu = this.cpu;
      let spent = 0;
      while (cpu.pc !== IDLE + 1 && cpu.pc !== IDLE && spent < 200000) spent += this.m.runCycles(1);
    }

    setupCall(addr, a, x, y) {
      const cpu = this.cpu;
      this.waitIdle();
      const ret = IDLE - 1;
      cpu.write(0x100 | cpu.sp, ret >> 8); cpu.sp = (cpu.sp - 1) & 0xff;
      cpu.write(0x100 | cpu.sp, ret & 0xff); cpu.sp = (cpu.sp - 1) & 0xff;
      cpu.a = a & 0xff; cpu.x = x & 0xff; cpu.y = y & 0xff;
      cpu.pc = addr;
      this.m.trap = IDLE;
      this.m.trapHit = false;
    }

    callSync(addr, a, x, y) {
      this.setupCall(addr, a || 0, x || 0, y || 0);
      let spent = 0;
      while (!this.m.trapHit) {
        spent += this.m.runCycles(500);
        if (spent > 2000000) { this.m.trap = -1; fail(ERR.DEVICE); }
      }
      this.m.trap = -1;
      return this.cpu.a;
    }

    callAsync(addr, a, x, y, done) {
      this.setupCall(addr, a || 0, x || 0, y || 0);
      this.call = done;
      this.state = 'call';
    }

    chrout(c) { this.callSync(CHROUT, c); }
    print(s) { for (let i = 0; i < s.length; i++) this.chrout(s.charCodeAt(i)); }
    printAscii(s) { for (const ch of s) this.chrout(ch === '\n' ? 13 : root.C64.basic.asciiToPetscii(ch)); }

    // ------------------------------------------------------ frame loop ------
    // Run one video frame's worth of time.
    frame() {
      const m = this.m;
      const target = this.cpu.cycles + Math.round(root.C64.machine.CYCLES_PER_FRAME * this.turbo);
      while (this.cpu.cycles < target) {
        const left = target - this.cpu.cycles;
        if (this.state === 'call') {
          m.runCycles(Math.min(left, 2000));
          if (m.trapHit) {
            m.trap = -1; m.trapHit = false;
            const cb = this.call; this.call = null; this.state = 'running';
            try { cb(this.cpu.a); } catch (e) { this.handleError(e); }
          }
          continue;
        }
        if (this.state === 'running') {
          if ((m.matrix[7] & 0x80) && !this.inputMode) { this.brk(); continue; }
          let cost;
          try { cost = this.step(); } catch (e) { this.handleError(e); continue; }
          if (cost) m.runCycles(cost);
          continue;
        }
        m.runCycles(left);
      }
    }

    handleError(e) {
      if (!e || !e.basic) {
        console.error(e);
        e = new BErr(ERR.SYNTAX);
      }
      const line = this.curLineNum();
      this.lastError = { message: e.message, line };
      try {
        this.print('\r?' + e.message + '  ERROR' + (line !== null ? ' IN ' + line : ''));
      } catch (_) { /* ignore */ }
      const err = this.lastError;
      this.finish('\r');
      if (this.onError && line !== null) this.onError(err);
    }

    brk() {
      this.m.matrix[7] &= ~0x80;
      const line = this.curLineNum();
      this.print('\r\rBREAK' + (line !== null ? ' IN ' + line : ''));
      this.finish('\r');
    }

    curLineNum() { return this.li >= 0 && this.lines[this.li] ? this.lines[this.li].num : null; }

    // End of program or direct command: print READY. and wait for commands.
    finish(prefix) {
      try {
        if (prefix === '\r' && this.m.ram[0xd3] === 0) prefix = '';
        this.print((prefix || '') + 'READY.\r');
      } catch (_) { /* ignore */ }
      this.inputMode = false;
      const err = this.lastError;
      this.enterDirect();
      if (this.onEnd) this.onEnd(err);
    }

    // --------------------------------------------------------- scanner ------
    cur() { return this.li === -1 ? this.direct : this.lines[this.li]; }
    get b() { return this.cur().b; }
    ch() {
      const b = this.cur().b;
      while (this.p < b.length && b[this.p] === 0x20) this.p++;
      return this.p < b.length ? b[this.p] : 0;
    }
    take() { const c = this.ch(); if (c) this.p++; return c; }
    expect(c) { if (this.ch() !== c) fail(ERR.SYNTAX); this.p++; }
    accept(c) { if (this.ch() === c) { this.p++; return true; } return false; }
    endOfStmt() { const c = this.ch(); return c === 0 || c === 0x3a; }
    skipStatement() {
      const b = this.b;
      let q = false;
      while (this.p < b.length) {
        const c = b[this.p];
        if (c === 0x22) q = !q;
        if (!q && c === 0x3a) return;
        this.p++;
      }
    }
    skipLine() { this.p = this.b.length; }

    gotoLine(num) {
      const idx = this.index.get(num);
      if (idx === undefined) fail(ERR.UNDEF);
      this.li = idx; this.p = 0;
      this.jumped = true;
    }

    lineNumber() {
      let c = this.ch(), n = 0, any = false;
      while (isDigit(c)) { n = n * 10 + (c - 0x30); this.p++; any = true; c = this.b[this.p]; }
      if (!any) fail(ERR.SYNTAX);
      if (n > 63999) fail(ERR.SYNTAX);
      return n;
    }

    // ------------------------------------------------------ statements ------
    step() {
      if (this.li !== -1 && this.li >= this.lines.length) { this.finish('\r'); return 0; }
      const start = this.p;
      const startLi = this.li;
      let c = this.ch();
      if (c === 0) {
        if (this.li === -1) { this.finish(''); return 60; }
        this.li++; this.p = 0;
        if (this.li >= this.lines.length) this.finish('\r');
        return 60;
      }
      if (c === 0x3a) { this.p++; return 10; }
      this.jumped = false;
      this.statement();
      if (this.state === 'running' && !this.jumped && startLi === this.li) {
        const n = this.ch();
        if (n !== 0 && n !== 0x3a) fail(ERR.SYNTAX);
      }
      const used = startLi === this.li ? Math.max(this.p - start, 1) : 4;
      return 700 + used * 60;
    }

    statement() {
      const c = this.ch();
      if (c >= 0x80 && c <= 0xcb) {
        this.p++;
        if (this.li === -1 && (c === T.INPUT || c === T.GET || c === T.DEF || c === T['INPUT#'])) fail(ERR.DIRECT);
        switch (c) {
          case T.END: this.finish('\r'); return;
          case T.STOP: { const line = this.curLineNum(); this.print('\r\rBREAK IN ' + line); this.finish('\r'); return; }
          case T.REM: this.skipLine(); return;
          case T.DATA: this.skipStatement(); return;
          case T.LET: return this.let();
          case T.PRINT: return this.printStmt(null);
          case T['PRINT#']: return this.printFile();
          case T.GOTO: return this.gotoLine(this.lineNumber());
          case T.GO: this.expect(T.TO); return this.gotoLine(this.lineNumber());
          case T.GOSUB: {
            const n = this.lineNumber();
            this.stack.push({ t: 'gosub', li: this.li, p: this.p });
            if (this.stack.length > 200) fail(ERR.MEM);
            return this.gotoLine(n);
          }
          case T.RETURN: {
            while (this.stack.length && this.stack[this.stack.length - 1].t !== 'gosub') this.stack.pop();
            const f = this.stack.pop();
            if (!f) fail(ERR.RETURN);
            this.li = f.li; this.p = f.p; this.jumped = true;
            return;
          }
          case T.IF: return this.ifStmt();
          case T.FOR: return this.forStmt();
          case T.NEXT: return this.nextStmt();
          case T.ON: return this.onStmt();
          case T.DIM: return this.dimStmt();
          case T.READ: return this.readStmt();
          case T.RESTORE: this.dataLi = 0; this.dataP = 0; this.dataInLine = false; return;
          case T.INPUT: return this.inputStmt();
          case T['INPUT#']: return this.inputFile();
          case T.GET: return this.getStmt();
          case T.POKE: {
            const a = this.uint16(this.numExpr()); this.expect(0x2c);
            const v = this.byteVal(this.numExpr());
            this.m.write(a, v);
            return;
          }
          case T.SYS: {
            const a = this.uint16(this.numExpr());
            const ram = this.m.ram;
            const after = () => { ram[0x30c] = this.cpu.a; ram[0x30d] = this.cpu.x; ram[0x30e] = this.cpu.y; ram[0x30f] = this.cpu.p; };
            this.callAsync(a, ram[0x30c], ram[0x30d], ram[0x30e], after);
            return;
          }
          case T.WAIT: {
            const a = this.uint16(this.numExpr()); this.expect(0x2c);
            const mask = this.byteVal(this.numExpr());
            let x = 0;
            if (this.accept(0x2c)) x = this.byteVal(this.numExpr());
            if (((this.m.read(a) ^ x) & mask) === 0) { this.p = this.stmtStart(); this.jumped = true; }
            return;
          }
          case T.DEF: return this.defStmt();
          case T.CLR: this.clearVars(); return;
          case T.NEW:
            this.lines = []; this.writeProgramToRam(); this.clearVars();
            if (this.onProgramChanged) this.onProgramChanged('');
            this.finish('\r'); return;
          case T.RUN: {
            this.clearVars();
            if (isDigit(this.ch())) return this.gotoLine(this.lineNumber());
            this.li = 0; this.p = 0; this.jumped = true;
            return;
          }
          case T.CONT: fail(ERR.CONT); return;
          case T.LIST: return this.listStmt();
          case T.OPEN: return this.openStmt();
          case T.CLOSE: { const n = this.byteVal(this.numExpr()); this.files.delete(n); return; }
          case T.CMD: { this.numExpr(); while (!this.endOfStmt()) this.p++; return; }
          case T.LOAD: case T.SAVE: case T.VERIFY: fail(ERR.DEVICE); return;
          default: fail(ERR.SYNTAX);
        }
      }
      if (isAlpha(c)) return this.let();
      fail(ERR.SYNTAX);
    }

    // Statement start offset (for WAIT to re-run itself): scan back to ':'
    stmtStart() {
      const b = this.b;
      let q = false, last = 0;
      for (let i = 0; i < b.length; i++) {
        if (b[i] === 0x22) q = !q;
        if (!q && b[i] === 0x3a) { if (i >= this.p) break; last = i + 1; }
        if (i >= this.p) break;
      }
      return last;
    }

    let() {
      const ref = this.varRef();
      this.expect(T['=']);
      const v = this.expr();
      this.assign(ref, v);
    }

    assign(ref, v) {
      if (ref.type === '$') { if (typeof v !== 'string') fail(ERR.TYPE); }
      else {
        if (typeof v === 'string') fail(ERR.TYPE);
        if (ref.type === '%') { v = Math.floor(v); if (v < -32768 || v > 32767) fail(ERR.QTY); }
        if (!isFinite(v)) fail(ERR.OVERFLOW);
      }
      if (ref.arr) ref.arr.data[ref.idx] = v;
      else if (ref.name === 'TI$') this.setTi(v);
      else if (ref.name === 'TI' || ref.name === 'ST') fail(ERR.SYNTAX);
      else this.vars.set(ref.name, v);
    }

    // Parse a variable name. Returns {base, type}
    varName() {
      let c = this.ch();
      if (!isAlpha(c)) fail(ERR.SYNTAX);
      let name = String.fromCharCode(c); this.p++;
      const b = this.b;
      while (this.p < b.length && (isAlpha(b[this.p]) || isDigit(b[this.p]))) {
        if (name.length < 2) name += String.fromCharCode(b[this.p]);
        this.p++;
      }
      let type = '';
      if (b[this.p] === 0x24) { type = '$'; this.p++; }
      else if (b[this.p] === 0x25) { type = '%'; this.p++; }
      return { base: name, type };
    }

    varRef() {
      const { base, type } = this.varName();
      const name = base + type;
      if (this.b[this.p] === 0x28) {
        this.p++;
        const subs = [];
        do { subs.push(this.subscript(this.numExpr())); } while (this.accept(0x2c));
        this.expect(0x29);
        const arr = this.getArray(name, subs.length, true);
        return { name, type, arr, idx: this.arrIndex(arr, subs) };
      }
      return { name, type };
    }

    subscript(v) { v = Math.floor(v); if (v < 0 || v > 32767) fail(ERR.SUB); return v; }

    getArray(name, ndims, autoDim) {
      let a = this.arrays.get(name);
      if (!a) {
        if (!autoDim) return null;
        a = this.makeArray(name, new Array(ndims).fill(10));
      }
      if (a.dims.length !== ndims) fail(ERR.SUB);
      return a;
    }

    makeArray(name, dims) {
      const size = dims.reduce((s, d) => s * (d + 1), 1);
      if (size > 200000) fail(ERR.MEM);
      const fill = name.endsWith('$') ? '' : 0;
      const a = { dims, data: new Array(size).fill(fill) };
      this.arrays.set(name, a);
      return a;
    }

    arrIndex(a, subs) {
      let idx = 0;
      for (let i = subs.length - 1; i >= 0; i--) {
        if (subs[i] > a.dims[i]) fail(ERR.SUB);
        idx = idx * (a.dims[i] + 1) + subs[i];
      }
      return idx;
    }

    getVar(name, type) {
      if (name === 'TI') return this.jiffies();
      if (name === 'TI$') return this.tiString();
      if (name === 'ST') return this.m.ram[0x90];
      const v = this.vars.get(name);
      if (v === undefined) return type === '$' ? '' : 0;
      return v;
    }

    jiffies() { const r = this.m.ram; return (r[0xa0] << 16) | (r[0xa1] << 8) | r[0xa2]; }
    tiString() {
      let j = Math.floor(this.jiffies() / 60);
      const h = Math.floor(j / 3600) % 24, mi = Math.floor(j / 60) % 60, s = j % 60;
      return [h, mi, s].map(n => String(n).padStart(2, '0')).join('');
    }
    setTi(v) {
      if (!/^\d{6}$/.test(v)) fail(ERR.QTY);
      const h = +v.slice(0, 2), mi = +v.slice(2, 4), s = +v.slice(4, 6);
      if (h > 23 || mi > 59 || s > 59) fail(ERR.QTY);
      const j = ((h * 60 + mi) * 60 + s) * 60;
      const r = this.m.ram; r[0xa0] = (j >> 16) & 0xff; r[0xa1] = (j >> 8) & 0xff; r[0xa2] = j & 0xff;
    }

    // ---------------------------------------------------------- PRINT -------
    printStmt(fileDev) {
      const toScreen = fileDev === null || fileDev === 3;
      let newline = true;
      const out = s => { if (toScreen) this.print(s); };
      while (!this.endOfStmt()) {
        const c = this.ch();
        newline = true;
        if (c === 0x3b) { this.p++; newline = false; continue; }
        if (c === 0x2c) {
          this.p++; newline = false;
          if (toScreen) { const pos = this.m.ram[0xd3] % 40; const n = 10 - (pos % 10); for (let i = 0; i < n; i++) this.chrout(29); }
          continue;
        }
        if (c === T['TAB('] || c === T['SPC(']) {
          this.p++;
          const n = this.byteVal(this.numExpr()); this.expect(0x29);
          newline = false;
          if (toScreen) {
            if (c === T['SPC(']) for (let i = 0; i < n; i++) this.chrout(29);
            else { const pos = this.m.ram[0xd3]; for (let i = pos; i < n; i++) this.chrout(29); }
          }
          if (this.endOfStmt()) newline = false;
          continue;
        }
        const v = this.expr();
        if (typeof v === 'string') out(v);
        else out((v < 0 ? '' : ' ') + fmtNum(v) + ' ');
      }
      if (newline) out('\r');
    }

    fileNum() {
      const n = this.byteVal(this.numExpr());
      const f = this.files.get(n);
      if (!f) fail(ERR.NOFILE);
      return f;
    }

    printFile() {
      const f = this.fileNum();
      if (!this.endOfStmt()) this.expect(0x2c);
      this.printStmt(f.dev);
    }

    inputFile() {
      const f = this.fileNum();
      this.expect(0x2c);
      if (f.dev !== 0 && f.dev !== 3) fail(ERR.NOTINPUT);
      this.inputStmt(true);
    }

    openStmt() {
      const lfn = this.byteVal(this.numExpr());
      let dev = 1;
      if (this.accept(0x2c)) dev = this.byteVal(this.numExpr());
      if (this.accept(0x2c)) this.numExpr();
      if (this.accept(0x2c)) this.strExpr();
      if (this.files.has(lfn)) fail(ERR.OPEN);
      if (dev === 1 || dev >= 8) fail(ERR.DEVICE);
      this.files.set(lfn, { dev });
    }

    // ------------------------------------------------------------- IF -------
    ifStmt() {
      const v = this.expr();
      const truth = typeof v === 'string' ? v.length > 0 : v !== 0;
      const c = this.ch();
      if (c === T.THEN) {
        this.p++;
        if (!truth) { this.skipLine(); return; }
        if (isDigit(this.ch())) return this.gotoLine(this.lineNumber());
        this.jumped = true;   // continue with the statements after THEN
        return;
      }
      if (c === T.GOTO) {
        this.p++;
        if (!truth) { this.skipLine(); return; }
        return this.gotoLine(this.lineNumber());
      }
      fail(ERR.SYNTAX);
    }

    // --------------------------------------------------------- FOR/NEXT -----
    forStmt() {
      const ref = this.varRef();
      if (ref.arr || ref.type) fail(ERR.SYNTAX);
      this.expect(T['=']);
      const start = this.numExpr();
      this.expect(T.TO);
      const end = this.numExpr();
      let stepV = 1;
      if (this.accept(T.STEP)) stepV = this.numExpr();
      this.assign(ref, start);
      // Remove an existing loop on the same variable (and everything above it).
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const f = this.stack[i];
        if (f.t === 'gosub') break;
        if (f.v === ref.name) { this.stack.length = i; break; }
      }
      this.stack.push({ t: 'for', v: ref.name, end, step: stepV, li: this.li, p: this.p });
      if (this.stack.length > 200) fail(ERR.MEM);
    }

    nextStmt() {
      do {
        let name = null;
        if (isAlpha(this.ch())) { const r = this.varRef(); name = r.name; }
        let i = this.stack.length - 1;
        for (; i >= 0; i--) {
          const f = this.stack[i];
          if (f.t === 'gosub') { i = -1; break; }
          if (name === null || f.v === name) break;
        }
        if (i < 0) fail(ERR.NEXT);
        this.stack.length = i + 1;
        const f = this.stack[i];
        const v = this.vars.get(f.v) + f.step;
        this.vars.set(f.v, v);
        if (f.step >= 0 ? v <= f.end : v >= f.end) {
          this.li = f.li; this.p = f.p; this.jumped = true;
          return;
        }
        this.stack.length = i;
      } while (this.accept(0x2c));
    }

    onStmt() {
      const n = Math.floor(this.numExpr());
      if (n < 0 || n > 255) fail(ERR.QTY);
      const kind = this.take();
      if (kind !== T.GOTO && kind !== T.GOSUB) fail(ERR.SYNTAX);
      const targets = [];
      do { targets.push(this.lineNumber()); } while (this.accept(0x2c));
      if (n < 1 || n > targets.length) return;
      if (kind === T.GOSUB) this.stack.push({ t: 'gosub', li: this.li, p: this.p });
      this.gotoLine(targets[n - 1]);
    }

    dimStmt() {
      do {
        const { base, type } = this.varName();
        const name = base + type;
        this.expect(0x28);
        const dims = [];
        do { dims.push(this.subscript(this.numExpr())); } while (this.accept(0x2c));
        this.expect(0x29);
        if (this.arrays.has(name)) fail(ERR.REDIM);
        this.makeArray(name, dims);
      } while (this.accept(0x2c));
    }

    defStmt() {
      this.expect(T.FN);
      const { base, type } = this.varName();
      if (type) fail(ERR.SYNTAX);
      this.expect(0x28);
      const param = this.varName();
      if (param.type) fail(ERR.SYNTAX);
      this.expect(0x29);
      this.expect(T['=']);
      this.fns.set(base, { param: param.base, li: this.li, p: this.p });
      this.skipStatement();
    }

    // ------------------------------------------------------- READ/DATA -----
    nextDatum() {
      for (;;) {
        if (this.dataLi >= this.lines.length) fail(ERR.DATA);
        const b = this.lines[this.dataLi].b;
        if (this.dataInLine) {
          while (this.dataP < b.length && b[this.dataP] === 0x20) this.dataP++;
          if (this.dataP < b.length && b[this.dataP] !== 0x3a) {
            let s = '';
            if (b[this.dataP] === 0x22) {
              this.dataP++;
              while (this.dataP < b.length && b[this.dataP] !== 0x22) s += String.fromCharCode(b[this.dataP++]);
              this.dataP++;
              while (this.dataP < b.length && b[this.dataP] !== 0x2c && b[this.dataP] !== 0x3a) this.dataP++;
            } else {
              while (this.dataP < b.length && b[this.dataP] !== 0x2c && b[this.dataP] !== 0x3a) {
                const c = b[this.dataP++];
                s += c >= 0x80 && c <= 0xcb ? KW[c - 0x80] : String.fromCharCode(c);
              }
              s = s.replace(/\s+$/, '');
            }
            if (b[this.dataP] === 0x2c) this.dataP++;
            else this.dataInLine = false;
            return s;
          }
          this.dataInLine = false;
        }
        // Find the next DATA token from (dataLi, dataP).
        let q = false, found = false;
        while (this.dataP < b.length) {
          const c = b[this.dataP++];
          if (c === 0x22) q = !q;
          if (!q && c === T.REM) { this.dataP = b.length; break; }
          if (!q && c === T.DATA) { found = true; break; }
        }
        if (found) { this.dataInLine = true; continue; }
        this.dataLi++; this.dataP = 0;
      }
    }

    readStmt() {
      do {
        const ref = this.varRef();
        const s = this.nextDatum();
        if (ref.type === '$') this.assign(ref, s);
        else {
          if (!/^\s*[+-]?(\d+\.?\d*|\.\d+)?(E[+-]?\d+)?\s*$/i.test(s)) fail(ERR.SYNTAX);
          this.assign(ref, strToNum(s));
        }
      } while (this.accept(0x2c));
    }

    // ------------------------------------------------------ INPUT / GET -----
    inputStmt(fromFile) {
      if (!fromFile && this.ch() === 0x22) {
        const prompt = this.primary();
        this.expect(0x3b);
        this.print(prompt);
      }
      const refs = [];
      do { refs.push(this.varRef()); } while (this.accept(0x2c));
      this.inputRefs = refs;
      this.inputMode = true;
      this.inputPrompt('? ');
    }

    inputPrompt(prompt) {
      this.print(prompt);
      this.inputBuf = '';
      this.inputRead();
    }

    inputRead() {
      this.callAsync(CHRIN, 0, 0, 0, a => {
        if (a !== 13) { this.inputBuf += String.fromCharCode(a); this.inputRead(); return; }
        this.print('\r');
        this.inputLine(this.inputBuf);
      });
    }

    inputLine(line) {
      // Split by commas (quotes protect commas).
      const items = [];
      let cur = '', q = false;
      for (const ch of line) {
        if (ch === '"') { q = !q; continue; }
        if (ch === ',' && !q) { items.push(cur); cur = ''; continue; }
        cur += ch;
      }
      items.push(cur);
      if (line.trim() === '' && this.inputRefs.length) { this.inputMode = false; return; }
      while (this.inputRefs.length && items.length) {
        const ref = this.inputRefs[0];
        let s = items.shift();
        if (ref.type === '$') this.assign(ref, s.replace(/^\s+/, ''));
        else {
          if (!/^\s*[+-]?(\d+\.?\d*|\.\d+)?(E[+-]?\d+)?\s*$/i.test(s)) { this.print('?REDO FROM START\r'); this.inputPrompt('? '); return; }
          this.assign(ref, strToNum(s));
        }
        this.inputRefs.shift();
      }
      if (this.inputRefs.length) { this.inputPrompt('?? '); return; }
      if (items.length && items.some(x => x.trim() !== '')) this.print('?EXTRA IGNORED\r');
      this.inputMode = false;
    }

    getStmt() {
      if (this.accept(0x23)) { this.fileNum(); this.expect(0x2c); }
      do {
        const ref = this.varRef();
        const a = this.callSync(GETIN);
        if (ref.type === '$') this.assign(ref, a ? String.fromCharCode(a) : '');
        else {
          if (a && !(a >= 0x30 && a <= 0x39)) fail(ERR.SYNTAX);
          this.assign(ref, a ? a - 0x30 : 0);
        }
      } while (this.accept(0x2c));
    }

    listStmt() {
      let from = 0, to = 63999;
      if (isDigit(this.ch())) from = to = this.lineNumber();
      if (this.accept(T['-'])) to = isDigit(this.ch()) ? this.lineNumber() : 63999;
      this.print('\r');
      for (const l of this.lines) {
        if (l.num < from || l.num > to) continue;
        let s = l.num + ' ';
        let q = false;
        for (const c of l.b) {
          if (c === 0x22) q = !q;
          s += (!q && c >= 0x80 && c <= 0xcb) ? KW[c - 0x80] : String.fromCharCode(c);
        }
        this.print(s + '\r');
      }
    }

    // ------------------------------------------------------ expressions -----
    numExpr() { const v = this.expr(); if (typeof v === 'string') fail(ERR.TYPE); return v; }
    strExpr() { const v = this.expr(); if (typeof v !== 'string') fail(ERR.TYPE); return v; }
    uint16(v) { v = Math.floor(v); if (v < 0 || v > 65535) fail(ERR.QTY); return v; }
    byteVal(v) { v = Math.floor(v); if (v < 0 || v > 255) fail(ERR.QTY); return v; }
    int16(v) { v = Math.floor(v); if (v < -32768 || v > 32767) fail(ERR.QTY); return v; }

    expr() { this.depth = 0; return this.orExpr(); }

    orExpr() {
      let l = this.andExpr();
      while (this.accept(T.OR)) { const r = this.andExpr(); this.num2(l, r); l = this.int16(l) | this.int16(r); }
      return l;
    }
    andExpr() {
      let l = this.notExpr();
      while (this.accept(T.AND)) { const r = this.notExpr(); this.num2(l, r); l = this.int16(l) & this.int16(r); }
      return l;
    }
    notExpr() {
      if (this.accept(T.NOT)) { const v = this.notExpr(); if (typeof v === 'string') fail(ERR.TYPE); return ~this.int16(v); }
      return this.relExpr();
    }
    num2(a, b) { if (typeof a === 'string' || typeof b === 'string') fail(ERR.TYPE); }
    relExpr() {
      let l = this.addExpr();
      for (;;) {
        let rel = 0;
        for (;;) {
          const c = this.ch();
          if (c === T['<']) { rel |= 1; this.p++; }
          else if (c === T['=']) { rel |= 2; this.p++; }
          else if (c === T['>']) { rel |= 4; this.p++; }
          else break;
        }
        if (!rel) return l;
        const r = this.addExpr();
        if ((typeof l === 'string') !== (typeof r === 'string')) fail(ERR.TYPE);
        const cmp = l < r ? 1 : l === r ? 2 : 4;
        l = (rel & cmp) ? -1 : 0;
      }
    }
    addExpr() {
      let l = this.mulExpr();
      for (;;) {
        if (this.accept(T['+'])) {
          const r = this.mulExpr();
          if (typeof l === 'string' && typeof r === 'string') { l = l + r; if (l.length > 255) fail(ERR.LONG); }
          else { this.num2(l, r); l = l + r; }
        } else if (this.accept(T['-'])) { const r = this.mulExpr(); this.num2(l, r); l = l - r; }
        else return l;
        if (typeof l === 'number' && !isFinite(l)) fail(ERR.OVERFLOW);
      }
    }
    mulExpr() {
      let l = this.unary();
      for (;;) {
        if (this.accept(T['*'])) { const r = this.unary(); this.num2(l, r); l = l * r; }
        else if (this.accept(T['/'])) { const r = this.unary(); this.num2(l, r); if (r === 0) fail(ERR.DIV0); l = l / r; }
        else return l;
        if (!isFinite(l)) fail(ERR.OVERFLOW);
      }
    }
    unary() {
      if (this.accept(T['-'])) { const v = this.unary(); if (typeof v === 'string') fail(ERR.TYPE); return -v; }
      if (this.accept(T['+'])) return this.unary();
      return this.power();
    }
    power() {
      let l = this.primary();
      while (this.accept(T['^'])) {
        const r = this.accept(T['-']) ? -this.primaryNum() : this.primaryNum();
        if (typeof l === 'string') fail(ERR.TYPE);
        if (l < 0 && r !== Math.floor(r)) fail(ERR.QTY);
        l = Math.pow(l, r);
        if (!isFinite(l)) fail(ERR.OVERFLOW);
      }
      return l;
    }
    primaryNum() { const v = this.primary(); if (typeof v === 'string') fail(ERR.TYPE); return v; }

    parenNum() { this.expect(0x28); const v = this.numExpr(); this.expect(0x29); return v; }
    parenStr() { this.expect(0x28); const v = this.strExpr(); this.expect(0x29); return v; }

    primary() {
      if (++this.depth > 100) fail(ERR.COMPLEX);
      try { return this.primary2(); } finally { this.depth--; }
    }

    primary2() {
      const c = this.ch();
      if (isDigit(c) || c === 0x2e) return this.number();
      if (c === 0x22) {
        this.p++;
        const b = this.b;
        let s = '';
        while (this.p < b.length && b[this.p] !== 0x22) s += String.fromCharCode(b[this.p++]);
        if (b[this.p] === 0x22) this.p++;
        return s;
      }
      if (c === 0x28) { this.p++; const v = this.orExpr(); this.expect(0x29); return v; }
      if (c === PI_TOKEN) { this.p++; return Math.PI; }
      if (isAlpha(c)) {
        const save = this.p;
        const { base, type } = this.varName();
        const name = base + type;
        if (this.b[this.p] === 0x28) {
          this.p = save;
          const ref = this.varRef();
          return ref.arr.data[ref.idx];
        }
        if (name === 'TI' && type === '') return this.jiffies();
        if (name === 'TI$') return this.tiString();
        if (name === 'ST') return this.m.ram[0x90];
        return this.getVar(name, type);
      }
      if (c >= 0xb4 && c <= 0xca) { this.p++; return this.func(c); }
      if (c === T.FN) {
        this.p++;
        const { base } = this.varName();
        const f = this.fns.get(base);
        if (!f) fail(ERR.FN);
        const arg = this.parenNum();
        const saved = { li: this.li, p: this.p };
        const old = this.vars.get(f.param);
        this.vars.set(f.param, arg);
        this.li = f.li; this.p = f.p;
        let v;
        try { v = this.numExpr(); } finally {
          this.li = saved.li; this.p = saved.p;
          if (old === undefined) this.vars.delete(f.param); else this.vars.set(f.param, old);
        }
        return v;
      }
      fail(ERR.SYNTAX);
    }

    number() {
      const b = this.b;
      let s = '';
      while (this.p < b.length && (isDigit(b[this.p]) || b[this.p] === 0x2e || b[this.p] === 0x20)) { if (b[this.p] !== 0x20) s += String.fromCharCode(b[this.p]); this.p++; }
      if (b[this.p] === 0x45) {           // E
        const save = this.p;
        this.p++;
        let e = 'E';
        if (b[this.p] === T['-'] || b[this.p] === 0x2d) { e += '-'; this.p++; }
        else if (b[this.p] === T['+'] || b[this.p] === 0x2b) this.p++;
        let digits = '';
        while (this.p < b.length && isDigit(b[this.p])) digits += String.fromCharCode(b[this.p++]);
        if (digits) s += e + digits; else this.p = save;
      }
      if (s === '.') return 0;
      const v = parseFloat(s);
      if (!isFinite(v)) fail(ERR.OVERFLOW);
      return v;
    }

    rnd(x) {
      // xorshift32 PRNG, seeded like the C64 for negative arguments.
      if (x < 0) { this.rndSeed = (Math.floor(Math.abs(x) * 1e6) | 1) >>> 0; }
      else if (x === 0) { this.rndSeed ^= (this.m.cia1.ta << 16) ^ this.m.cia1.tb ^ this.cpu.cycles; }
      let s = this.rndSeed >>> 0 || 1;
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      this.rndSeed = s;
      return s / 4294967296;
    }

    func(tok) {
      switch (tok) {
        case T.SGN: { const v = this.parenNum(); return v > 0 ? 1 : v < 0 ? -1 : 0; }
        case T.INT: return Math.floor(this.parenNum());
        case T.ABS: return Math.abs(this.parenNum());
        case T.USR: this.parenNum(); fail(ERR.QTY); break;
        case T.FRE: this.expect(0x28); this.expr(); this.expect(0x29); return Math.max(0, 38911 - (this.lines.reduce((s, l) => s + l.b.length + 5, 2)) - this.vars.size * 7);
        case T.POS: this.expect(0x28); this.expr(); this.expect(0x29); return this.m.ram[0xd3];
        case T.SQR: { const v = this.parenNum(); if (v < 0) fail(ERR.QTY); return Math.sqrt(v); }
        case T.RND: return this.rnd(this.parenNum());
        case T.LOG: { const v = this.parenNum(); if (v <= 0) fail(ERR.QTY); return Math.log(v); }
        case T.EXP: { const v = Math.exp(this.parenNum()); if (!isFinite(v)) fail(ERR.OVERFLOW); return v; }
        case T.COS: return Math.cos(this.parenNum());
        case T.SIN: return Math.sin(this.parenNum());
        case T.TAN: { const v = this.parenNum(); return Math.tan(v); }
        case T.ATN: return Math.atan(this.parenNum());
        case T.PEEK: return this.m.read(this.uint16(this.parenNum()));
        case T.LEN: return this.parenStr().length;
        case T['STR$']: { const v = this.parenNum(); return (v < 0 ? '' : ' ') + fmtNum(v); }
        case T.VAL: return strToNum(this.parenStr());
        case T.ASC: { const s = this.parenStr(); if (!s.length) fail(ERR.QTY); return s.charCodeAt(0); }
        case T['CHR$']: return String.fromCharCode(this.byteVal(this.parenNum()));
        case T['LEFT$']: case T['RIGHT$']: {
          this.expect(0x28); const s = this.strExpr(); this.expect(0x2c);
          const n = this.byteVal(this.numExpr()); this.expect(0x29);
          return tok === T['LEFT$'] ? s.slice(0, n) : (n === 0 ? '' : s.slice(-n));
        }
        case T['MID$']: {
          this.expect(0x28); const s = this.strExpr(); this.expect(0x2c);
          const st = this.byteVal(this.numExpr());
          if (st < 1) fail(ERR.QTY);
          let n = 255;
          if (this.accept(0x2c)) n = this.byteVal(this.numExpr());
          this.expect(0x29);
          return s.substr(st - 1, n);
        }
      }
      fail(ERR.SYNTAX);
    }
  }

  const api = { BasicInterpreter, fmtNum, IDLE };
  root.C64 = root.C64 || {};
  root.C64.interp = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
