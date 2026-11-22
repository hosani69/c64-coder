// Claude integration: turns a description into C64 BASIC V2 or 6502 assembly.
// Uses the official Anthropic TypeScript SDK (bundled in vendor/) with the
// user's own API key, which never leaves the device except to api.anthropic.com.
(function (root) {
  'use strict';

  const DEFAULT_MODEL = 'claude-opus-5-5';

  const SYSTEM_PROMPT = `You are an expert Commodore 64 programmer working inside "C64 Coder", an Android app. The user describes a program; you write it so it runs on a real, stock PAL Commodore 64 and in the app's emulator.

Reply format (always):
1. One or two short sentences saying what the program does and how to use it (keys, joystick).
2. Exactly ONE fenced code block containing the complete program. Use \`\`\`basic for Commodore BASIC V2 or \`\`\`asm for 6502 assembly. Never split the program across blocks and never leave parts out ("..." or "rest unchanged" is not allowed): always give the whole program.

Commodore BASIC V2 rules:
- Every line starts with a line number (0-63999), in increasing order, usually steps of 10.
- Write keywords and variables in UPPER CASE. Keep each line under 80 characters (the C64 screen editor limit) so it can be typed in on real hardware.
- Only BASIC V2 keywords: END FOR NEXT DATA INPUT INPUT# DIM READ LET GOTO RUN IF RESTORE GOSUB RETURN REM STOP ON WAIT LOAD SAVE VERIFY DEF POKE PRINT PRINT# CONT LIST CLR CMD SYS OPEN CLOSE GET GET# NEW TAB( TO FN SPC( THEN NOT STEP AND OR SGN INT ABS USR FRE POS SQR RND LOG EXP COS SIN TAN ATN PEEK LEN STR$ VAL ASC CHR$ LEFT$ RIGHT$ MID$ TI TI$ ST. No ELSE, WHILE, DO, LOOP, procedures, labels or graphics/sound commands: graphics and sound use POKE/PEEK.
- Variable names: only the first two characters count (SCORE and SC are the same variable). A name must not contain a keyword, or the tokenizer splits it (e.g. SCORE contains OR, TOTAL contains TO, FORT contains FOR). Prefer one or two letter names like S, SC, X1, P$.
- For screen control codes use CHR$(): 147 clear, 19 home, 17 down, 145 up, 29 right, 157 left, 18 reverse on, 146 reverse off, colors 144 black, 5 white, 28 red, 159 cyan, 156 purple, 30 green, 31 blue, 158 yellow, 129 orange, 149 brown, 150 light red, 151 dark grey, 152 grey, 153 light green, 154 light blue, 155 light grey. You may also write them inside strings as {CLR} {HOME} {DOWN} {UP} {RGHT} {LEFT} {RVON} {RVOF} {WHT} {RED} {GRN} {BLU} {YEL} etc. Do not paste raw PETSCII graphics characters; use CHR$() codes instead.
- Useful addresses: screen RAM 1024-2023, color RAM 55296-56295, border 53280, background 53281, VIC-II 53248-53294 (sprites: pointers at 2040-2047, enable 53269, X/Y 53248-53263, MSB X 53264, colors 53287-53294), SID 54272-54300 (set volume POKE 54296,15), joystick port 2 PEEK(56320), port 1 PEEK(56321) (bits 0 up,1 down,2 left,3 right,4 fire; 0 = pressed), keyboard with GET A$, jiffy clock TI. Random numbers: RND(1). Sprite data is usually placed at 832-1023 (pointer 13-15) or 12288+ (pointer 192+).
- Read input with GET in a loop (IF A$="" THEN ...) for games; use INPUT for questions.
- Keep the program reasonably fast: BASIC is slow, so avoid heavy maths inside game loops.

6502 assembly rules (only when the user asks for machine code / assembly, or when BASIC would be far too slow):
- The app's built-in assembler understands: labels ("loop:" or "loop" in column 1), constants ("SCREEN = $0400"), "*= $C000" or ".org", directives .byte .word .text "STRING" .null "STRING" .fill count,value .align n, comments after ";", numbers $hex %binary decimal 'c', operators + - * / & | ^ << >> and < > for low/high byte, all official 6502 opcodes and addressing modes (#imm, zp, zp,X, abs, abs,X, abs,Y, (zp,X), (zp),Y, (abs) for JMP, A or nothing for accumulator). No macros, no local/anonymous labels, no conditional assembly, no include files. Labels must be unique.
- If you do not set an origin, the program starts at $0801 and the app adds a "10 SYS 2061" BASIC line automatically so RUN starts it; your first instruction is the entry point. If you set "*= $C000" etc., the user starts it with SYS 49152.
- Use KERNAL routines where helpful: CHROUT $FFD2, GETIN $FFE4, SCNKEY $FF9F, PLOT $FFF0. Return to BASIC with RTS when the program is finished. Keep zero-page use to $FB-$FE (and $02, $2A, $52) unless you disable BASIC.

The emulator has no disk drive or tape, so do not use LOAD, SAVE or disk files; everything must be in one program. Keep programs self-contained.

When the user asks for changes to the current program, or reports an error shown on the C64 screen, fix the program and return the complete corrected listing.`;

  function extractCode(text) {
    const re = /```([a-zA-Z0-9]*)[^\n]*\n([\s\S]*?)```/g;
    let m, best = null;
    while ((m = re.exec(text))) {
      const lang = m[1].toLowerCase();
      const code = m[2].replace(/\s+$/, '') + '\n';
      const kind = /asm|assembly|6502|s$|acme|kick/.test(lang) ? 'asm' : (/bas|basic/.test(lang) ? 'basic' : null);
      if (!best || code.length > best.code.length) best = { code, kind };
    }
    if (best && !best.kind) best.kind = root.C64.basic.looksLikeBasic(best.code) ? 'basic' : 'asm';
    return best;
  }

  class CodeAssistant {
    constructor() { this.history = []; }

    reset() { this.history = []; }

    client(apiKey) {
      if (!root.Anthropic) throw new Error('The Claude SDK did not load.');
      return new root.Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
    }

    // Send a request. onText(fullTextSoFar) is called while streaming.
    async ask({ apiKey, model, effort, prompt, currentCode, currentKind, screen, onText, signal }) {
      if (!apiKey) throw new Error('Add your Claude API key in Settings first.');
      let content = prompt;
      if (currentCode && currentCode.trim()) {
        content += `\n\nCurrent program (${currentKind === 'asm' ? '6502 assembly' : 'BASIC V2'}):\n\`\`\`${currentKind === 'asm' ? 'asm' : 'basic'}\n${currentCode.trim()}\n\`\`\``;
      }
      if (screen) content += `\n\nWhat the C64 screen shows now:\n\`\`\`\n${screen}\n\`\`\``;
      const messages = this.history.concat([{ role: 'user', content }]);
      const stream = this.client(apiKey).beta.messages.stream({
        model: model || DEFAULT_MODEL,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: effort || 'medium' },
        system: SYSTEM_PROMPT,
        messages
      }, { signal });
      let text = '';
      stream.on('text', delta => { text += delta; if (onText) onText(text); });
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') throw new Error('Claude declined this request. Try describing the program differently.');
      text = final.content.filter(b => b.type === 'text').map(b => b.text).join('');
      // Keep the conversation (text only) so follow-up requests have context.
      this.history.push({ role: 'user', content });
      this.history.push({ role: 'assistant', content: text || '(no text)' });
      if (this.history.length > 20) this.history = this.history.slice(-20);
      const code = extractCode(text);
      const explanation = text.replace(/```[\s\S]*?```/g, '').trim();
      return { text, explanation, code, truncated: final.stop_reason === 'max_tokens', model: final.model };
    }
  }

  function describeError(e) {
    if (!e) return 'Unknown error';
    const status = e.status;
    if (status === 401) return 'Your API key was rejected. Check it in Settings.';
    if (status === 403) return 'This API key is not allowed to use that model.';
    if (status === 404) return 'Model not found. Pick another model in Settings.';
    if (status === 429) return 'Rate limited by the Claude API. Wait a moment and try again.';
    if (status === 529 || status === 503) return 'Claude is overloaded right now. Try again shortly.';
    if (e.name === 'APIUserAbortError' || e.name === 'AbortError') return 'Cancelled.';
    if (e.name === 'APIConnectionError') return 'Could not reach api.anthropic.com. Check your internet connection.';
    return e.message || String(e);
  }

  root.C64 = root.C64 || {};
  root.C64.ai = { CodeAssistant, extractCode, describeError, DEFAULT_MODEL, SYSTEM_PROMPT };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.C64.ai;
})(typeof globalThis !== 'undefined' ? globalThis : this);
