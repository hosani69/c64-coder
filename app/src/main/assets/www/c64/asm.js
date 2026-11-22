// Small two-pass 6502 assembler that outputs a C64 .prg.
// Syntax: labels ("loop:" or "loop" in column 1), constants ("SCREEN = $0400"),
// "*= $c000" / ".org", .byte .word .text .null .fill .basic, ";" comments,
// $hex %binary 'c' decimal, + - * / & | ^ << >> and < > (lo/hi byte).
(function (root) {
  'use strict';

  const OPS = {
    ADC: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6d, abx: 0x7d, aby: 0x79, izx: 0x61, izy: 0x71 },
    AND: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2d, abx: 0x3d, aby: 0x39, izx: 0x21, izy: 0x31 },
    ASL: { acc: 0x0a, zp: 0x06, zpx: 0x16, abs: 0x0e, abx: 0x1e },
    BCC: { rel: 0x90 }, BCS: { rel: 0xb0 }, BEQ: { rel: 0xf0 }, BMI: { rel: 0x30 },
    BNE: { rel: 0xd0 }, BPL: { rel: 0x10 }, BVC: { rel: 0x50 }, BVS: { rel: 0x70 },
    BIT: { zp: 0x24, abs: 0x2c },
    BRK: { imp: 0x00 }, CLC: { imp: 0x18 }, CLD: { imp: 0xd8 }, CLI: { imp: 0x58 }, CLV: { imp: 0xb8 },
    CMP: { imm: 0xc9, zp: 0xc5, zpx: 0xd5, abs: 0xcd, abx: 0xdd, aby: 0xd9, izx: 0xc1, izy: 0xd1 },
    CPX: { imm: 0xe0, zp: 0xe4, abs: 0xec }, CPY: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
    DEC: { zp: 0xc6, zpx: 0xd6, abs: 0xce, abx: 0xde }, DEX: { imp: 0xca }, DEY: { imp: 0x88 },
    EOR: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4d, abx: 0x5d, aby: 0x59, izx: 0x41, izy: 0x51 },
    INC: { zp: 0xe6, zpx: 0xf6, abs: 0xee, abx: 0xfe }, INX: { imp: 0xe8 }, INY: { imp: 0xc8 },
    JMP: { abs: 0x4c, ind: 0x6c }, JSR: { abs: 0x20 },
    LDA: { imm: 0xa9, zp: 0xa5, zpx: 0xb5, abs: 0xad, abx: 0xbd, aby: 0xb9, izx: 0xa1, izy: 0xb1 },
    LDX: { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, aby: 0xbe },
    LDY: { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, abx: 0xbc },
    LSR: { acc: 0x4a, zp: 0x46, zpx: 0x56, abs: 0x4e, abx: 0x5e },
    NOP: { imp: 0xea },
    ORA: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0d, abx: 0x1d, aby: 0x19, izx: 0x01, izy: 0x11 },
    PHA: { imp: 0x48 }, PHP: { imp: 0x08 }, PLA: { imp: 0x68 }, PLP: { imp: 0x28 },
    ROL: { acc: 0x2a, zp: 0x26, zpx: 0x36, abs: 0x2e, abx: 0x3e },
    ROR: { acc: 0x6a, zp: 0x66, zpx: 0x76, abs: 0x6e, abx: 0x7e },
    RTI: { imp: 0x40 }, RTS: { imp: 0x60 },
    SBC: { imm: 0xe9, zp: 0xe5, zpx: 0xf5, abs: 0xed, abx: 0xfd, aby: 0xf9, izx: 0xe1, izy: 0xf1 },
    SEC: { imp: 0x38 }, SED: { imp: 0xf8 }, SEI: { imp: 0x78 },
    STA: { zp: 0x85, zpx: 0x95, abs: 0x8d, abx: 0x9d, aby: 0x99, izx: 0x81, izy: 0x91 },
    STX: { zp: 0x86, zpy: 0x96, abs: 0x8e }, STY: { zp: 0x84, zpx: 0x94, abs: 0x8c },
    TAX: { imp: 0xaa }, TAY: { imp: 0xa8 }, TSX: { imp: 0xba }, TXA: { imp: 0x8a },
    TXS: { imp: 0x9a }, TYA: { imp: 0x98 }
  };
  const SIZE = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, abs: 3, abx: 3, aby: 3, ind: 3, izx: 2, izy: 2, rel: 2 };

  class AsmError extends Error {
    constructor(msg, line) { super(`Line ${line}: ${msg}`); this.line = line; }
  }

  // ---- expression evaluator -------------------------------------------------
  // Returns a number, or undefined when it references a not-yet-defined symbol.
  function evaluate(expr, symbols, pc, lineNo) {
    const s = expr.trim();
    let i = 0;
    let unknown = false;
    const peek = () => s[i];
    const skip = () => { while (s[i] === ' ' || s[i] === '\t') i++; };
    function primary() {
      skip();
      const c = s[i];
      if (c === '(') { i++; const v = binary(0); skip(); if (s[i] !== ')') throw new AsmError('missing )', lineNo); i++; return v; }
      if (c === '-') { i++; return -primary(); }
      if (c === '~') { i++; return ~primary(); }
      if (c === '<') { i++; return primary() & 0xff; }
      if (c === '>') { i++; return (primary() >> 8) & 0xff; }
      if (c === '*') { i++; return pc; }
      if (c === '$') { const m = s.slice(i + 1).match(/^[0-9a-fA-F]+/); if (!m) throw new AsmError('bad hex number', lineNo); i += 1 + m[0].length; return parseInt(m[0], 16); }
      if (c === '%') { const m = s.slice(i + 1).match(/^[01]+/); if (!m) throw new AsmError('bad binary number', lineNo); i += 1 + m[0].length; return parseInt(m[0], 2); }
      if (c === "'" || c === '"') {
        const ch = s[i + 1]; i += 2; if (s[i] === c) i++;
        return root.C64.basic ? root.C64.basic.asciiToPetscii(ch) : ch.charCodeAt(0);
      }
      let m = s.slice(i).match(/^[0-9]+/);
      if (m) { i += m[0].length; return parseInt(m[0], 10); }
      m = s.slice(i).match(/^[A-Za-z_.@][A-Za-z0-9_.@]*/);
      if (m) {
        i += m[0].length;
        const key = m[0].toUpperCase();
        if (key in symbols) return symbols[key];
        unknown = true;
        return 0;
      }
      throw new AsmError(`cannot read expression "${s}"`, lineNo);
    }
    const PREC = { '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
    function op() {
      skip();
      const two = s.substr(i, 2);
      if (two === '<<' || two === '>>') return two;
      const c = s[i];
      return c in PREC ? c : null;
    }
    function binary(minPrec) {
      let left = primary();
      for (;;) {
        const o = op();
        if (!o || PREC[o] <= minPrec) break;
        i += o.length;
        const right = binary(PREC[o]);
        switch (o) {
          case '+': left = left + right; break;
          case '-': left = left - right; break;
          case '*': left = left * right; break;
          case '/': left = right ? Math.floor(left / right) : 0; break;
          case '%': left = right ? left % right : 0; break;
          case '&': left = left & right; break;
          case '|': left = left | right; break;
          case '^': left = left ^ right; break;
          case '<<': left = left << right; break;
          case '>>': left = left >> right; break;
        }
      }
      return left;
    }
    const v = binary(0);
    skip();
    if (i < s.length) throw new AsmError(`unexpected "${s.slice(i)}" in expression`, lineNo);
    return unknown ? undefined : v;
  }

  // Split on commas that are not inside quotes or parentheses.
  function splitArgs(str) {
    const out = []; let cur = ''; let q = null; let depth = 0;
    for (const ch of str) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function stripComment(line) {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"') { q = ch; continue; }
      if (ch === "'" && line[i + 2] === "'") { i += 2; continue; }
      if (ch === ';') return line.slice(0, i);
    }
    return line;
  }

  function textBytes(arg, lineNo, symbols, pc) {
    const a = arg.trim();
    if (a.startsWith('"')) {
      if (!a.endsWith('"') || a.length < 2) throw new AsmError('unterminated string', lineNo);
      return [...a.slice(1, -1)].map(ch => root.C64.basic.asciiToPetscii(ch));
    }
    const v = evaluate(a, symbols, pc, lineNo);
    return [v];
  }

  const BASIC_STUB_LEN = 12; // 10 SYS 2061

  function basicStub(target) {
    const digits = String(target).split('').map(c => c.charCodeAt(0));
    const next = 0x0801 + 2 + 2 + 1 + digits.length + 1;
    return [next & 0xff, next >> 8, 0x0a, 0x00, 0x9e, ...digits, 0x00, 0x00, 0x00];
  }

  function parseLine(raw, lineNo) {
    let line = stripComment(raw).replace(/\s+$/, '');
    if (!line.trim()) return { label: null, rest: '' };
    let label = null;
    let m = line.match(/^\s*([A-Za-z_.@][A-Za-z0-9_.@]*):\s*(.*)$/);
    if (m) { label = m[1]; line = m[2]; }
    else if (/^[A-Za-z_.@]/.test(line)) {
      // Column-1 word: label unless it is a mnemonic or directive.
      m = line.match(/^([A-Za-z_.@][A-Za-z0-9_.@]*)\s*(.*)$/);
      const w = m[1].toUpperCase();
      if (!(w in OPS) && !w.startsWith('.') && !/^=/.test(m[2])) { label = m[1]; line = m[2]; }
    }
    return { label, rest: line.trim() };
  }

  function assemble(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const symbols = {};
    const decided = {};           // lineNo -> addressing mode chosen in pass 1
    let output, minAddr, maxAddr, pc, start, stubWanted;

    for (let pass = 1; pass <= 2; pass++) {
      output = new Map();
      pc = null;
      minAddr = Infinity; maxAddr = -1;
      stubWanted = false;
      const emit = (bytes, lineNo) => {
        if (pc === null) { pc = 0x0801; stubWanted = true; emitStubPlaceholder(); }
        for (const b of bytes) {
          if (b === undefined) { if (pass === 2) throw new AsmError('undefined symbol', lineNo); }
          if (pc > 0xffff) throw new AsmError('code runs past $FFFF', lineNo);
          output.set(pc, (b || 0) & 0xff);
          minAddr = Math.min(minAddr, pc); maxAddr = Math.max(maxAddr, pc);
          pc++;
        }
      };
      function emitStubPlaceholder() {
        // Reserve room for "10 SYS 2061"; filled in after the pass.
        for (let k = 0; k < BASIC_STUB_LEN; k++) { output.set(pc, 0); minAddr = Math.min(minAddr, pc); maxAddr = Math.max(maxAddr, pc); pc++; }
      }

      for (let n = 0; n < lines.length; n++) {
        const lineNo = n + 1;
        const { label, rest } = parseLine(lines[n], lineNo);
        // Constant assignment: NAME = expr  (or NAME .equ expr)
        let m = rest.match(/^([A-Za-z_.@][A-Za-z0-9_.@]*)\s*(=|\.equ\b|equ\b)\s*(.+)$/i);
        if (!label && m && !(m[1].toUpperCase() in OPS)) {
          const v = evaluate(m[3], symbols, pc === null ? 0x0801 : pc, lineNo);
          if (v !== undefined) symbols[m[1].toUpperCase()] = v;
          else if (pass === 2) throw new AsmError(`cannot resolve value of ${m[1]}`, lineNo);
          continue;
        }
        if (label && /^(=|\.equ\b|equ\b)/i.test(rest)) {
          const v = evaluate(rest.replace(/^(=|\.equ|equ)/i, ''), symbols, pc === null ? 0x0801 : pc, lineNo);
          if (v !== undefined) symbols[label.toUpperCase()] = v;
          else if (pass === 2) throw new AsmError(`cannot resolve value of ${label}`, lineNo);
          continue;
        }
        // Origin
        m = rest.match(/^(\*\s*=|\.org\b|org\b|\.pc\s*=?)\s*(.+)$/i);
        if (m) {
          const v = evaluate(m[2], symbols, pc || 0, lineNo);
          if (v === undefined) throw new AsmError('origin must be a known value', lineNo);
          pc = v;
          if (label) symbols[label.toUpperCase()] = pc;
          continue;
        }
        if (label) {
          if (pc === null) { pc = 0x0801; stubWanted = true; emitStubPlaceholder(); }
          const key = label.toUpperCase();
          if (pass === 1 && key in symbols) throw new AsmError(`label ${label} defined twice`, lineNo);
          symbols[key] = pc;
        }
        if (!rest) continue;
        m = rest.match(/^([.!]?[A-Za-z]+)\s*(.*)$/);
        if (!m) throw new AsmError(`cannot understand "${rest}"`, lineNo);
        const word = m[1].toUpperCase().replace(/^!/, '.');
        const args = m[2].trim();

        if (word.startsWith('.')) {
          switch (word) {
            case '.BASIC': {
              // Explicit BASIC stub: "10 SYS <address of next byte after stub>"
              if (pc === null) pc = 0x0801;
              if (pc !== 0x0801) throw new AsmError('.basic must be at $0801', lineNo);
              const target = 0x0801 + BASIC_STUB_LEN;
              emit(basicStub(target), lineNo);
              break;
            }
            case '.BYTE': case '.BYT': case '.DB': case '.BYTES':
              for (const a of splitArgs(args)) emit(textBytes(a, lineNo, symbols, pc), lineNo);
              break;
            case '.WORD': case '.DW': case '.ADDR':
              for (const a of splitArgs(args)) { const v = evaluate(a, symbols, pc, lineNo); emit(v === undefined ? [undefined, undefined] : [v & 0xff, (v >> 8) & 0xff], lineNo); }
              break;
            case '.TEXT': case '.ASCII': case '.PET': case '.STR':
              for (const a of splitArgs(args)) emit(textBytes(a, lineNo, symbols, pc), lineNo);
              break;
            case '.NULL': case '.ASCIIZ': case '.ASCIZ':
              for (const a of splitArgs(args)) emit(textBytes(a, lineNo, symbols, pc), lineNo);
              emit([0], lineNo);
              break;
            case '.FILL': case '.RES': case '.DS': {
              const [cnt, val] = splitArgs(args);
              const c = evaluate(cnt, symbols, pc, lineNo);
              if (c === undefined) throw new AsmError('.fill count must be known', lineNo);
              const v = val ? evaluate(val, symbols, pc, lineNo) : 0;
              emit(new Array(c).fill(v), lineNo);
              break;
            }
            case '.ALIGN': {
              const a = evaluate(args, symbols, pc, lineNo) || 1;
              if (pc === null) { pc = 0x0801; stubWanted = true; emitStubPlaceholder(); }
              while (pc % a) emit([0], lineNo);
              break;
            }
            case '.END': n = lines.length; break;
            case '.TO': case '.CPU': case '.ENC': case '.SETCPU': break;
            default: throw new AsmError(`unknown directive ${m[1]}`, lineNo);
          }
          continue;
        }

        const mn = word;
        const modes = OPS[mn];
        if (!modes) throw new AsmError(`unknown instruction "${m[1]}"`, lineNo);
        if (pc === null) { pc = 0x0801; stubWanted = true; emitStubPlaceholder(); }
        const opText = args.replace(/\s+/g, ' ').trim();
        let mode, expr;
        let mm;
        if (!opText) mode = modes.imp !== undefined ? 'imp' : 'acc';
        else if (/^a$/i.test(opText) && modes.acc !== undefined) mode = 'acc';
        else if (opText[0] === '#') { mode = 'imm'; expr = opText.slice(1); }
        else if ((mm = opText.match(/^\((.+)\)\s*,\s*y$/i))) { mode = 'izy'; expr = mm[1]; }
        else if ((mm = opText.match(/^\((.+)\s*,\s*x\s*\)$/i))) { mode = 'izx'; expr = mm[1]; }
        else if ((mm = opText.match(/^\((.+)\)$/)) && mn === 'JMP') { mode = 'ind'; expr = mm[1]; }
        else if ((mm = opText.match(/^(.+?)\s*,\s*x$/i))) { mode = 'x'; expr = mm[1]; }
        else if ((mm = opText.match(/^(.+?)\s*,\s*y$/i))) { mode = 'y'; expr = mm[1]; }
        else { mode = 'a'; expr = opText; }

        if (modes.rel !== undefined) {
          const target = evaluate(expr, symbols, pc, lineNo);
          let rel = 0;
          if (target !== undefined) {
            rel = target - (pc + 2);
            if (pass === 2 && (rel < -128 || rel > 127)) throw new AsmError(`branch out of range (${rel} bytes); use JMP`, lineNo);
          } else if (pass === 2) throw new AsmError(`undefined label in "${opText}"`, lineNo);
          emit([modes.rel, rel & 0xff], lineNo);
          continue;
        }

        let value = expr !== undefined ? evaluate(expr, symbols, pc, lineNo) : 0;
        if (mode === 'a' || mode === 'x' || mode === 'y') {
          const zpMode = mode === 'a' ? 'zp' : 'zp' + mode;
          const absMode = mode === 'a' ? 'abs' : 'ab' + mode;
          let chosen = decided[lineNo];
          if (pass === 1) {
            const canZp = modes[zpMode] !== undefined && value !== undefined && value >= 0 && value < 256;
            chosen = canZp ? zpMode : absMode;
            if (modes[chosen] === undefined) chosen = modes[zpMode] !== undefined ? zpMode : absMode;
            decided[lineNo] = chosen;
          }
          mode = chosen;
        }
        if (modes[mode] === undefined) throw new AsmError(`${mn} does not support that addressing mode`, lineNo);
        const size = SIZE[mode];
        if (pass === 2 && value === undefined) throw new AsmError(`undefined symbol in "${opText}"`, lineNo);
        if (pass === 2 && size === 2 && mode !== 'imm' && (value < 0 || value > 255)) throw new AsmError(`value $${value.toString(16)} does not fit in zero page`, lineNo);
        if (pass === 2 && mode === 'imm' && (value < -128 || value > 255)) throw new AsmError(`immediate value ${value} is bigger than a byte`, lineNo);
        if (value === undefined) value = 0;
        if (size === 1) emit([modes[mode]], lineNo);
        else if (size === 2) emit([modes[mode], value & 0xff], lineNo);
        else emit([modes[mode], value & 0xff, (value >> 8) & 0xff], lineNo);
      }
    }

    if (maxAddr < 0) throw new AsmError('no code was produced', 1);
    if (stubWanted) {
      const stub = basicStub(0x0801 + BASIC_STUB_LEN);
      stub.forEach((b, k) => output.set(0x0801 + k, b));
    }
    start = stubWanted ? 0x0801 + BASIC_STUB_LEN : minAddr;
    // If code starts at $0801 with an explicit .basic stub, entry is right after it.
    if (!stubWanted && minAddr === 0x0801 && output.get(0x0805) === 0x9e) start = 0x0801 + BASIC_STUB_LEN;
    const prg = new Uint8Array(maxAddr - minAddr + 1 + 2);
    prg[0] = minAddr & 0xff; prg[1] = minAddr >> 8;
    for (const [a, b] of output) prg[a - minAddr + 2] = b;
    const hasBasicStub = minAddr === 0x0801 && prg[2 + 4] === 0x9e;
    return { prg, start, load: minAddr, end: maxAddr + 1, symbols, hasBasicStub };
  }

  const api = { assemble, evaluate, OPS, AsmError };
  root.C64 = root.C64 || {};
  root.C64.asm = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
