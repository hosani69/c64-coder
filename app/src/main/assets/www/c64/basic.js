// Commodore BASIC V2 tokenizer / detokenizer.
// Turns a plain-text listing into a C64 .prg (load address $0801) and back.
(function (root) {
  'use strict';

  // Token table in ROM order ($80..$CB). Order matters: the C64 "crunch"
  // routine takes the first keyword that matches, so PRINT# comes before PRINT.
  const KEYWORDS = [
    'END', 'FOR', 'NEXT', 'DATA', 'INPUT#', 'INPUT', 'DIM', 'READ', 'LET', 'GOTO',
    'RUN', 'IF', 'RESTORE', 'GOSUB', 'RETURN', 'REM', 'STOP', 'ON', 'WAIT', 'LOAD',
    'SAVE', 'VERIFY', 'DEF', 'POKE', 'PRINT#', 'PRINT', 'CONT', 'LIST', 'CLR', 'CMD',
    'SYS', 'OPEN', 'CLOSE', 'GET', 'NEW', 'TAB(', 'TO', 'FN', 'SPC(', 'THEN',
    'NOT', 'STEP', '+', '-', '*', '/', '^', 'AND', 'OR', '>',
    '=', '<', 'SGN', 'INT', 'ABS', 'USR', 'FRE', 'POS', 'SQR', 'RND',
    'LOG', 'EXP', 'COS', 'SIN', 'TAN', 'ATN', 'PEEK', 'LEN', 'STR$', 'VAL',
    'ASC', 'CHR$', 'LEFT$', 'RIGHT$', 'MID$', 'GO'
  ];
  const TOK = {};
  KEYWORDS.forEach((k, i) => { TOK[k] = 0x80 + i; });

  // Control-code names (petcat / magazine style) for use inside strings: {CLR}
  const CTRL = {
    'clr': 147, 'clear': 147, 'home': 19, 'down': 17, 'up': 145, 'left': 157,
    'rght': 29, 'right': 29, 'rvon': 18, 'rvs on': 18, 'rvof': 146, 'rvs off': 146,
    'blk': 144, 'black': 144, 'wht': 5, 'white': 5, 'red': 28, 'cyn': 159, 'cyan': 159,
    'pur': 156, 'purple': 156, 'grn': 30, 'green': 30, 'blu': 31, 'blue': 31,
    'yel': 158, 'yellow': 158, 'orng': 129, 'orange': 129, 'brn': 149, 'brown': 149,
    'lred': 150, 'light red': 150, 'gry1': 151, 'dark gray': 151, 'grey1': 151,
    'gry2': 152, 'gray': 152, 'grey2': 152, 'lgrn': 153, 'light green': 153,
    'lblu': 154, 'light blue': 154, 'gry3': 155, 'light gray': 155, 'grey3': 155,
    'del': 20, 'inst': 148, 'ins': 148, 'f1': 133, 'f3': 134, 'f5': 135, 'f7': 136,
    'f2': 137, 'f4': 138, 'f6': 139, 'f8': 140, 'return': 13, 'ret': 13,
    'lower': 14, 'upper': 142, 'swlc': 14, 'swuc': 142, 'stop': 3, 'pi': 255,
    'space': 32, 'shift space': 160, 'cbm-+': 166, 'pound': 92
  };
  const CTRL_REV = {};
  // Prefer short canonical names when listing.
  ['clr', 'home', 'down', 'up', 'left', 'rght', 'rvon', 'rvof', 'blk', 'wht', 'red',
    'cyn', 'pur', 'grn', 'blu', 'yel', 'orng', 'brn', 'lred', 'gry1', 'gry2', 'lgrn',
    'lblu', 'gry3', 'del', 'inst', 'f1', 'f3', 'f5', 'f7', 'f2', 'f4', 'f6', 'f8',
    'lower', 'upper', 'stop', 'pi'].forEach(n => { CTRL_REV[CTRL[n]] = n.toUpperCase(); });

  // ASCII character -> PETSCII (upper case / graphics character set).
  function asciiToPetscii(ch) {
    const c = ch.charCodeAt(0);
    if (c >= 0x61 && c <= 0x7a) return c - 0x20;          // a-z -> A-Z
    if (c === 0x5c || ch === '£') return 0x5c;              // pound sign
    if (ch === '↑' || c === 0x5e) return 0x5e;              // up arrow
    if (ch === '←' || c === 0x5f) return 0x5f;              // left arrow
    if (ch === 'π') return 0xff;
    if (c === 0x60) return 0x27;                            // backtick -> apostrophe
    if (c === 0x7b || c === 0x7d || c === 0x7c || c === 0x7e) return c + 0x60; // graphics
    if (c >= 0x20 && c <= 0x5d) return c;
    return 0x3f;                                            // '?' for anything else
  }

  function petsciiToAscii(b) {
    if (b >= 0x20 && b <= 0x5b) return String.fromCharCode(b);
    if (b === 0x5d) return ']';
    if (b === 0x5c) return '£';
    if (b === 0x5e) return '↑';
    if (b === 0x5f) return '←';
    if (b === 0xff) return 'π';
    return null;
  }

  // Parse "{...}" escapes. Returns array of byte values or null if unknown.
  function parseBrace(body) {
    let s = body.trim().toLowerCase();
    let count = 1;
    let m = s.match(/^(\d+)\s+(.+)$/);              // {5 down}
    if (m) { count = parseInt(m[1], 10); s = m[2]; }
    m = s.match(/^(.+?)\s*\*\s*(\d+)$/);            // {down*5}
    if (m) { s = m[1]; count = parseInt(m[2], 10); }
    let code;
    if (/^\$[0-9a-f]{1,2}$/.test(s)) code = parseInt(s.slice(1), 16);
    else if (/^\d{1,3}$/.test(s)) code = parseInt(s, 10);
    else if (s in CTRL) code = CTRL[s];
    if (code === undefined || code > 255 || count > 255) return null;
    return new Array(count).fill(code);
  }

  class BasicError extends Error {
    constructor(msg, line) { super(line ? `Line ${line}: ${msg}` : msg); this.line = line; }
  }

  // Tokenize one line body (without the line number). Returns array of bytes.
  function crunch(text, lineNo) {
    const out = [];
    let i = 0;
    let inQuote = false, inRem = false, inData = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '{' && (inQuote || inRem)) {
        const end = text.indexOf('}', i);
        if (end > i) {
          const bytes = parseBrace(text.slice(i + 1, end));
          if (bytes) { out.push(...bytes); i = end + 1; continue; }
        }
      }
      if (ch === '"') { inQuote = !inQuote; out.push(0x22); i++; continue; }
      if (inQuote || inRem) { out.push(asciiToPetscii(ch)); i++; continue; }
      if (inData) {
        if (ch === ':') inData = false;
        out.push(asciiToPetscii(ch)); i++; continue;
      }
      if (ch === '?') { out.push(TOK.PRINT); i++; continue; }
      if (ch === ' ') { out.push(0x20); i++; continue; }
      // Numbers and dots are copied straight through.
      const upper = text.slice(i).toUpperCase();
      let matched = false;
      for (let k = 0; k < KEYWORDS.length; k++) {
        const kw = KEYWORDS[k];
        if (upper.startsWith(kw)) {
          const t = 0x80 + k;
          out.push(t);
          i += kw.length;
          if (t === TOK.REM) inRem = true;
          if (t === TOK.DATA) inData = true;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      out.push(asciiToPetscii(ch));
      i++;
    }
    if (out.length > 250) throw new BasicError('line is too long (over 250 bytes once tokenized)', lineNo);
    return out;
  }

  // Parse a listing into [{num, bytes}] sorted by line number.
  function parseListing(src) {
    const lines = [];
    const seen = new Map();
    src.replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) return;
      const m = line.match(/^\s*(\d+)\s?(.*)$/);
      if (!m) throw new BasicError(`text line ${idx + 1} has no line number: "${line.trim().slice(0, 40)}"`);
      const num = parseInt(m[1], 10);
      if (num > 63999) throw new BasicError('line numbers must be 0-63999', num);
      const bytes = crunch(m[2], num);
      seen.set(num, bytes);   // later duplicates replace earlier ones, like on a C64
    });
    [...seen.keys()].sort((a, b) => a - b).forEach(n => lines.push({ num: n, bytes: seen.get(n) }));
    return lines;
  }

  // Listing text -> PRG bytes (Uint8Array incl. 2-byte load address).
  function tokenize(src, loadAddr) {
    loadAddr = loadAddr || 0x0801;
    const lines = parseListing(src);
    if (!lines.length) throw new BasicError('the program has no numbered lines');
    const body = [];
    let addr = loadAddr;
    for (const l of lines) {
      const len = 2 + 2 + l.bytes.length + 1;
      const next = addr + len;
      body.push(next & 0xff, next >> 8, l.num & 0xff, l.num >> 8, ...l.bytes, 0);
      addr = next;
    }
    body.push(0, 0);
    if (loadAddr + body.length > 0xa000) throw new BasicError('program is too big for BASIC memory');
    const prg = new Uint8Array(body.length + 2);
    prg[0] = loadAddr & 0xff; prg[1] = loadAddr >> 8;
    prg.set(body, 2);
    return prg;
  }

  // PRG bytes -> listing text.
  function detokenize(prg) {
    const load = prg[0] | (prg[1] << 8);
    const mem = prg.subarray(2);
    let p = 0;
    const out = [];
    let guard = 0;
    while (p + 4 <= mem.length && guard++ < 10000) {
      const next = mem[p] | (mem[p + 1] << 8);
      if (next === 0) break;
      const num = mem[p + 2] | (mem[p + 3] << 8);
      p += 4;
      let s = '';
      let inQuote = false;
      while (p < mem.length && mem[p] !== 0) {
        const b = mem[p++];
        if (b === 0x22) { inQuote = !inQuote; s += '"'; continue; }
        if (!inQuote && b >= 0x80 && b <= 0xcb) { s += KEYWORDS[b - 0x80]; continue; }
        if (!inQuote && b === 0xff) { s += 'π'; continue; }
        const a = petsciiToAscii(b);
        if (a !== null) s += a;
        else s += '{' + (CTRL_REV[b] || b) + '}';
      }
      p++;
      out.push(num + ' ' + s);
      const nextOff = next - load;
      if (nextOff > 0 && nextOff < mem.length) p = nextOff;
    }
    return out.join('\n');
  }

  // Does this text look like a BASIC listing (vs. assembly)?
  function looksLikeBasic(src) {
    const lines = src.split(/\r?\n/).filter(l => l.trim() && !/^\s*;/.test(l));
    if (!lines.length) return false;
    const numbered = lines.filter(l => /^\s*\d+\s*\S/.test(l)).length;
    return numbered / lines.length > 0.8;
  }

  const api = { tokenize, detokenize, parseListing, looksLikeBasic, asciiToPetscii, KEYWORDS, BasicError };
  root.C64 = root.C64 || {};
  root.C64.basic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
