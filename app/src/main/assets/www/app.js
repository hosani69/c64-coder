// C64 Coder app: UI glue between Claude, the code editor, the emulator and export.
(function () {
  'use strict';

  const C64 = window.C64;
  const $ = id => document.getElementById(id);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('c64coder.' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('c64coder.' + k, JSON.stringify(v)); } catch (_) { /* storage full or blocked */ } }
  };

  // ------------------------------------------------------------ status ----
  let statusTimer = null;
  function status(msg, sticky) {
    $('status').textContent = msg || '';
    clearTimeout(statusTimer);
    if (msg && !sticky) statusTimer = setTimeout(() => { $('status').textContent = ''; }, 5000);
  }
  window.addEventListener('error', e => status('Error: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', e => status('Error: ' + ((e.reason && e.reason.message) || e.reason)));

  // -------------------------------------------------------------- tabs -----
  let currentTab = 'ai';
  function showTab(name) {
    currentTab = name;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'run') { emu.resume(); fitScreen(); } else emu.suspend();
    if (name === 'export') updateExportInfo();
  }
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  // Android back button (called from MainActivity): go back to the Claude tab first.
  window.onBackPressed = function () {
    if (currentTab !== 'ai') { showTab('ai'); return true; }
    return false;
  };

  // ---------------------------------------------------------- settings -----
  const settings = Object.assign({ apiKey: '', model: C64.ai.DEFAULT_MODEL, effort: 'medium', displayFps: 50, sound: true, turbo: false, forceInterp: false }, LS.get('settings', {}));
  function saveSettings() { LS.set('settings', settings); }
  $('api-key').value = settings.apiKey;
  $('model').value = settings.model;
  if (!$('model').value) $('model').value = C64.ai.DEFAULT_MODEL;
  $('effort').value = settings.effort;
  $('sound').checked = settings.sound;
  $('display-fps').value = String(settings.displayFps);
  $('display-fps').addEventListener('change', e => { settings.displayFps = +e.target.value; saveSettings(); });
  $('turbo').checked = settings.turbo;
  $('force-interp').checked = settings.forceInterp;
  $('api-key').addEventListener('change', e => { settings.apiKey = e.target.value.trim(); saveSettings(); status('API key saved on this device'); });
  $('model').addEventListener('change', e => { settings.model = e.target.value; saveSettings(); });
  $('effort').addEventListener('change', e => { settings.effort = e.target.value; saveSettings(); });
  $('sound').addEventListener('change', e => { settings.sound = e.target.checked; saveSettings(); emu.applySettings(); });
  $('turbo').addEventListener('change', e => { settings.turbo = e.target.checked; saveSettings(); emu.applySettings(); });
  $('force-interp').addEventListener('change', e => { settings.forceInterp = e.target.checked; saveSettings(); emu.reset(); });

  // -------------------------------------------------------------- ROMs -----
  const b64 = {
    enc(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); },
    dec(str) { const s = atob(str); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  };
  const roms = { builtin: null, custom: null };

  async function loadBuiltinRoms() {
    const get = async n => new Uint8Array(await (await fetch('roms/' + n)).arrayBuffer());
    roms.builtin = { basic: await get('basic_generic.rom'), kernal: await get('kernal_generic.rom'), chars: await get('chargen_openroms.rom') };
  }
  function loadCustomRoms() {
    const c = LS.get('roms', null);
    roms.custom = null;
    if (c && c.basic && c.kernal && c.chars) {
      try { roms.custom = { basic: b64.dec(c.basic), kernal: b64.dec(c.kernal), chars: b64.dec(c.chars) }; } catch (_) { roms.custom = null; }
    }
  }
  function activeRoms() { return roms.custom || roms.builtin; }
  function useInterpreter() { return settings.forceInterp || !hasOriginalBasic(); }
  function hasOriginalBasic() {
    const r = activeRoms();
    // Commodore BASIC V2 has "CBMBASIC" at $A004.
    return !!r && String.fromCharCode(...r.basic.subarray(4, 12)) === 'CBMBASIC';
  }
  function updateRomStatus() {
    $('rom-status').textContent = roms.custom
      ? (hasOriginalBasic() ? 'Using your own ROMs (original Commodore BASIC detected: BASIC runs natively).' : 'Using your own ROMs.')
      : 'Using the built-in Open ROMs. BASIC programs run in the built-in interpreter.';
  }

  $('rom-files').addEventListener('change', async e => {
    const found = Object.assign({}, LS.get('roms', {}) || {});
    for (const f of e.target.files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes.length === 4096) found.chars = b64.enc(bytes);
      else if (bytes.length === 8192) {
        if (String.fromCharCode(...bytes.subarray(4, 12)) === 'CBMBASIC' || /basic/i.test(f.name)) found.basic = b64.enc(bytes);
        else found.kernal = b64.enc(bytes);
      } else if (bytes.length === 16384) {        // combined BASIC+KERNAL
        found.basic = b64.enc(bytes.subarray(0, 8192)); found.kernal = b64.enc(bytes.subarray(8192));
      } else { status(`${f.name}: unexpected size ${bytes.length} bytes`); }
    }
    LS.set('roms', found);
    loadCustomRoms();
    const missing = ['basic', 'kernal', 'chars'].filter(k => !found[k]);
    if (missing.length) status('Still missing: ' + missing.map(m => m === 'chars' ? 'chargen' : m).join(', '), true);
    else { status('ROMs installed'); emu.installRoms(); }
    updateRomStatus();
    e.target.value = '';
  });
  $('rom-reset').addEventListener('click', () => { LS.set('roms', null); loadCustomRoms(); emu.installRoms(); updateRomStatus(); status('Using the built-in Open ROMs'); });

  // ---------------------------------------------------------- emulator -----
  const emu = {
    machine: null, interp: null, ctx: null, image: null,
    running: false, visible: false, paused: false, raf: 0, last: 0, acc: 0,
    audio: null, frameCount: 0, drawCount: 0, lastDraw: 0, fpsTime: 0,

    init() {
      const canvas = $('screen');
      this.ctx = canvas.getContext('2d');
      this.machine = new C64.machine.C64();
      this.interp = new C64.interp.BasicInterpreter(this.machine);
      this.interp.onError = err => showRunError(err);
      // Lines typed into the emulator (e.g. 30 PRINT "HI") update the editor too.
      this.interp.onProgramChanged = listing => setProgram(listing, 'basic');
      this.image = new ImageData(new Uint8ClampedArray(this.machine.frame.buffer), C64.machine.W, C64.machine.H);
      this.installRoms();
    },

    installRoms() {
      const r = activeRoms();
      if (!r) return;
      this.machine.loadRoms(r.basic, r.kernal, r.chars);
      this.bootToReady();
      this.draw();
      this.updateMode();
    },

    // Power on. With the Open ROMs, the built-in interpreter takes over the
    // READY prompt so you can type BASIC commands directly.
    bootToReady() {
      this.interp.stop();
      this.machine.boot();
      if (useInterpreter()) this.interp.startDirect();
    },

    applySettings() {
      this.interp.turbo = settings.turbo ? 4 : 1;
      this.machine.sid.enabled = settings.sound;
      if (this.audio) { if (settings.sound && this.visible) this.audio.resume(); else this.audio.suspend(); }
    },

    ensureAudio() {
      if (this.audio || !settings.sound) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        const node = ctx.createScriptProcessor(2048, 0, 1);
        const sid = this.machine.sid;
        sid.setSampleRate(ctx.sampleRate);
        node.onaudioprocess = ev => sid.pull(ev.outputBuffer.getChannelData(0));
        node.connect(ctx.destination);
        this.audio = ctx;
      } catch (e) { console.warn('audio unavailable', e); }
    },

    updateMode() {
      const mode = this.interp.running ? 'Built-in BASIC interpreter' : (hasOriginalBasic() ? 'Original ROMs' : 'Open ROMs');
      $('run-mode').textContent = (this.paused ? 'Paused · ' : '') + mode;
    },

    resume() {
      this.visible = true;
      this.applySettings();
      if (!this.raf) { this.last = performance.now(); this.acc = 0; this.raf = requestAnimationFrame(t => this.tick(t)); }
    },
    suspend() {
      this.visible = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (this.audio) this.audio.suspend();
    },

    // The emulated C64 runs at exactly PAL speed (50.12 frames per second,
    // 985,248 CPU cycles per second) no matter what refresh rate the phone's
    // display has. Emulation is driven by the clock, not by screen refreshes:
    // if the phone draws slower, frames are still emulated on time and only the
    // drawing is skipped, so programs, music and games keep real-hardware speed.
    tick(t) {
      this.raf = requestAnimationFrame(tt => this.tick(tt));
      const dt = Math.min(250, t - this.last);
      this.last = t;
      pollGamepads();
      if (this.paused) return;
      this.acc += dt;
      const frameMs = 1000 / C64.machine.FPS;
      const started = performance.now();
      let n = 0;
      while (this.acc >= frameMs && n < 12) {
        if (this.interp.running) this.interp.frame();
        else this.machine.runCycles(C64.machine.CYCLES_PER_FRAME * (settings.turbo ? 4 : 1));
        this.acc -= frameMs; n++;
        if (performance.now() - started > 60) break;      // never freeze the UI
      }
      if (this.acc > frameMs * 12) this.acc = frameMs * 12;  // phone far too slow: catch up gradually
      this.frameCount += n;
      // Redraw at the chosen screen rate (8, 16 or 50 fps); emulation speed is unaffected.
      const drawEvery = 1000 / (settings.displayFps || 50);
      if (n && (settings.displayFps >= 50 || t - this.lastDraw >= drawEvery - 4)) {
        this.draw(); this.drawCount++;
        this.lastDraw = settings.displayFps >= 50 ? t : Math.max(this.lastDraw + drawEvery, t - drawEvery);
      }
      if (t - this.fpsTime > 1000) {
        const sec = (t - this.fpsTime) / 1000;
        const emuFps = Math.round(this.frameCount / sec), shown = Math.round(this.drawCount / sec);
        $('fps').textContent = shown < emuFps - 1 ? `C64 ${emuFps} fps · screen ${shown} fps` : `${emuFps} fps`;
        this.fpsTime = t; this.frameCount = 0; this.drawCount = 0;
        this.updateMode();
      }
    },

    draw() { this.ctx.putImageData(this.image, 0, 0); },

    run(build) {
      this.ensureAudio();
      hideRunError();
      this.interp.stop();
      this.machine.boot();
      this.machine.loadPrg(build.prg);
      this.machine.sid.reset();
      const useInterp = build.kind === 'basic' && useInterpreter();
      if (useInterp) {
        this.interp.turbo = settings.turbo ? 4 : 1;
        this.interp.start();
        try { this.interp.printAscii('RUN\n'); } catch (_) { /* ignore */ }
      } else if (build.prg[0] === 0x01 && build.prg[1] === 0x08 && (build.kind === 'basic' || build.hasBasicStub)) {
        this.machine.feedKeyboardBuffer('RUN\r');
      } else {
        this.machine.feedKeyboardBuffer('SYS' + build.start + '\r');
      }
      this.paused = false;
      $('pause-btn').textContent = 'Pause';
      this.updateMode();
      showTab('run');
    },

    reset() {
      this.bootToReady();
      this.draw();
      hideRunError();
      this.updateMode();
    }
  };

  // --------------------------------------------------------- program -------
  const prog = Object.assign({ name: 'MY PROGRAM', kind: 'basic', code: '10 PRINT "HELLO FROM C64 CODER!"\n20 GOTO 10\n' }, LS.get('program', {}));
  $('prog-name').value = prog.name;
  $('code-kind').value = prog.kind;
  $('code').value = prog.code;
  function saveProgram() {
    prog.name = ($('prog-name').value || 'PROGRAM').toUpperCase().slice(0, 16);
    prog.kind = $('code-kind').value;
    prog.code = $('code').value;
    LS.set('program', prog);
  }
  ['prog-name', 'code-kind', 'code'].forEach(id => $(id).addEventListener('input', saveProgram));
  $('code-kind').addEventListener('change', saveProgram);

  function setProgram(code, kind, name) {
    $('code').value = code;
    if (kind) $('code-kind').value = kind;
    if (name) $('prog-name').value = name.toUpperCase().slice(0, 16);
    saveProgram();
  }

  // Build the current program into a .prg. Throws with a readable message.
  function build() {
    saveProgram();
    const src = prog.code;
    if (!src.trim()) throw new Error('There is no program yet.');
    if (prog.kind === 'basic') {
      const prg = C64.basic.tokenize(src);
      return { kind: 'basic', prg, start: 0x0801, hasBasicStub: false };
    }
    const r = C64.asm.assemble(src);
    return { kind: 'asm', prg: r.prg, start: r.start, hasBasicStub: r.hasBasicStub, end: r.end, load: r.load };
  }

  function codeMessage(msg, isErr, withFix) {
    const el = $('code-msg');
    el.textContent = msg || '';
    el.classList.toggle('err', !!isErr);
    if (withFix) {
      const b = document.createElement('button');
      b.className = 'primary small'; b.textContent = 'Fix with Claude'; b.style.marginLeft = '8px';
      b.addEventListener('click', () => askClaude(`Building the program fails with this error: "${msg}". Please fix it.`, { includeCode: true }));
      el.appendChild(b);
    }
  }

  function runCurrent() {
    let b;
    try { b = build(); } catch (e) { codeMessage(e.message, true, true); showTab('code'); return; }
    codeMessage(`${b.kind === 'basic' ? 'BASIC' : 'Assembly'} OK: ${b.prg.length - 2} bytes at $${((b.prg[1] << 8) | b.prg[0]).toString(16).toUpperCase()}` + (b.kind === 'asm' ? `, start ${b.start}` : ''));
    emu.run(b);
  }
  $('run-btn').addEventListener('click', runCurrent);

  // --------------------------------------------------------- run panel -----
  let lastRunError = null;
  function showRunError(err) {
    lastRunError = err;
    $('run-error-text').textContent = `?${err.message} ERROR${err.line !== null ? ' IN ' + err.line : ''}`;
    $('run-error').classList.remove('hidden');
  }
  function hideRunError() { lastRunError = null; $('run-error').classList.add('hidden'); }
  $('fix-btn').addEventListener('click', () => {
    if (!lastRunError) return;
    const e = lastRunError;
    askClaude(`When I run the program the C64 stops with "?${e.message} ERROR${e.line !== null ? ' IN ' + e.line : ''}". Please fix it.`, { includeCode: true, includeScreen: true });
  });
  $('ask-screen').addEventListener('click', () => {
    showTab('ai');
    attachScreenNext = true;
    $('prompt').placeholder = 'Ask about what is on the C64 screen…';
    $('prompt').focus();
    status('The current C64 screen will be sent with your next message');
  });
  $('reset-btn').addEventListener('click', () => emu.reset());
  $('pause-btn').addEventListener('click', () => {
    emu.paused = !emu.paused;
    $('pause-btn').textContent = emu.paused ? 'Resume' : 'Pause';
    emu.updateMode();
  });

  // Keyboard capture: a transparent textarea over the screen.
  const kbd = $('kbd');
  const SENT = ' ';
  kbd.value = SENT;
  function typeKeys(list) { emu.machine.type(list); }
  kbd.addEventListener('input', () => {
    const v = kbd.value;
    if (v.length < SENT.length) typeKeys(['DEL']);
    else if (v.length > SENT.length) typeKeys([...v.slice(SENT.length)].map(ch => ch === '\n' ? '\n' : ch));
    kbd.value = SENT;
  });
  const KEYMAP = { Enter: 'RETURN', Backspace: 'DEL', Escape: 'STOP', Home: 'HOME', ArrowUp: 'CRSR_UP', ArrowDown: 'CRSR_DOWN', ArrowLeft: 'CRSR_LEFT', ArrowRight: 'CRSR_RIGHT', F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', Insert: 'INST', PageUp: 'RESTORE' };
  const JOYKEYS = { ArrowUp: 0, ArrowDown: 1, ArrowLeft: 2, ArrowRight: 3, Control: 4, Alt: 4 };
  function joyPort() { return +$('joy-port').value; }
  // Joystick state from every input source; the selected port gets the OR.
  const joy = { touch: 0, keys: 0, native: 0, pad: 0 };
  function applyJoy() {
    const p = joyPort();
    emu.machine.joy[p] = joy.touch | joy.keys | joy.native | joy.pad;
    emu.machine.joy[1 - p] = 0;
  }
  $('joy-port').addEventListener('change', applyJoy);
  // Controller Start/Select act as C64 keys while held.
  const padKeys = { start: false, select: false };
  function setPadKey(which, down) {
    if (padKeys[which] === down) return;
    padKeys[which] = down;
    const k = which === 'start' ? 'RETURN' : 'STOP';
    if (down) emu.machine.keyDown(k); else setTimeout(() => emu.machine.keyUp(k), 60);
  }
  function showPad() { $('pad-status').classList.remove('hidden'); }

  // Called by the Android app for Bluetooth/USB controllers (see MainActivity).
  window.nativeGamepad = function (bits, start, select) {
    joy.native = bits & 0x1f;
    applyJoy();
    setPadKey('start', !!start);
    setPadKey('select', !!select);
    showPad();
  };

  // Browser Gamepad API (desktop browsers and WebViews that expose it).
  function pollGamepads() {
    if (!navigator.getGamepads) return;
    let bits = 0, start = false, select = false, any = false;
    let pads;
    try { pads = navigator.getGamepads(); } catch (_) { return; }
    for (const gp of pads || []) {
      if (!gp || !gp.connected) continue;
      any = true;
      const b = i => !!(gp.buttons[i] && gp.buttons[i].pressed);
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (b(12) || ay < -0.5) bits |= 1;
      if (b(13) || ay > 0.5) bits |= 2;
      if (b(14) || ax < -0.5) bits |= 4;
      if (b(15) || ax > 0.5) bits |= 8;
      if ([0, 1, 2, 3, 4, 5, 6, 7].some(b)) bits |= 16;
      if (b(9)) start = true;
      if (b(8)) select = true;
    }
    if (!any) { if (joy.pad) { joy.pad = 0; applyJoy(); } return; }
    showPad();
    if (bits !== joy.pad) { joy.pad = bits; applyJoy(); }
    setPadKey('start', start);
    setPadKey('select', select);
  }
  window.addEventListener('gamepadconnected', () => { showPad(); status('Game controller connected'); });

  kbd.addEventListener('keydown', e => {
    if (!$('joystick').classList.contains('hidden') && e.key in JOYKEYS) {
      joy.keys |= 1 << JOYKEYS[e.key]; applyJoy(); e.preventDefault(); return;
    }
    const k = KEYMAP[e.key];
    if (!k) return;
    e.preventDefault();
    if (k === 'RESTORE') emu.machine.cpu.nmi();
    else typeKeys([k === 'RETURN' ? '\n' : k]);
  });
  kbd.addEventListener('keyup', e => {
    if (e.key in JOYKEYS) { joy.keys &= ~(1 << JOYKEYS[e.key]); applyJoy(); }
  });

  // On-screen keys hold the key in the matrix while pressed (games can see it).
  document.querySelectorAll('#keys button').forEach(btn => {
    const name = btn.dataset.key;
    let downAt = 0, keys = null;
    const press = e => {
      e.preventDefault();
      if (name === 'KBD') { kbd.focus(); return; }
      if (name === 'RESTORE') { emu.machine.cpu.nmi(); return; }
      keys = C64.machine.keysFor(name) || [name];
      keys.forEach(k => emu.machine.keyDown(k));
      downAt = performance.now();
      btn.classList.add('held');
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    };
    const release = () => {
      if (!keys) return;
      const ks = keys; keys = null;
      btn.classList.remove('held');
      setTimeout(() => ks.forEach(k => emu.machine.keyUp(k)), Math.max(0, 70 - (performance.now() - downAt)));
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
  });

  $('joy-toggle').addEventListener('click', () => { $('joystick').classList.toggle('hidden'); fitScreen(); });

  // Size the C64 screen to the largest 384x272 rectangle that fits completely,
  // in portrait (screen on top) and landscape (screen left, controls right).
  function fitScreen() {
    if (currentTab !== 'run') return;
    const tab = $('tab-run'), area = $('screen-area'), wrap = $('screen-wrap');
    const landscape = window.matchMedia('(orientation: landscape)').matches;
    const cs = getComputedStyle(tab);
    const innerW = tab.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const innerH = tab.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    let areaW, areaH;
    if (landscape) {
      area.style.height = '';
      areaW = area.clientWidth; areaH = innerH;
    } else {
      areaW = innerW;
      areaH = Math.min(innerW * 272 / 384, innerH * 0.62);
      area.style.height = Math.floor(areaH) + 'px';
    }
    let w = Math.min(areaW, areaH * 384 / 272);
    w = Math.max(96, Math.floor(w));
    wrap.style.width = w + 'px';
    wrap.style.height = Math.floor(w * 272 / 384) + 'px';
  }
  window.addEventListener('resize', fitScreen);
  window.addEventListener('orientationchange', () => setTimeout(fitScreen, 200));
  if (window.ResizeObserver) new ResizeObserver(fitScreen).observe($('tab-run'));
  const JOYBITS = { up: 0, down: 1, left: 2, right: 3, fire: 4 };
  document.querySelectorAll('[data-joy]').forEach(btn => {
    const bit = 1 << JOYBITS[btn.dataset.joy];
    const on = e => { e.preventDefault(); joy.touch |= bit; applyJoy(); btn.classList.add('held'); try { btn.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } };
    const off = () => { joy.touch &= ~bit; applyJoy(); btn.classList.remove('held'); };
    btn.addEventListener('pointerdown', on);
    btn.addEventListener('pointerup', off);
    btn.addEventListener('pointercancel', off);
  });

  // --------------------------------------------------------------- AI ------
  const assistant = new C64.ai.CodeAssistant();
  let busy = null;            // AbortController while a request runs
  let attachScreenNext = false;

  function addMsg(cls, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    if (text) d.textContent = text;
    $('chat').appendChild(d);
    d.scrollIntoView({ block: 'end' });
    return d;
  }

  function nameFromPrompt(p) {
    const words = p.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !['A', 'AN', 'THE', 'IN', 'OF', 'THAT', 'WITH', 'AND', 'MAKE', 'WRITE', 'CREATE', 'PROGRAM', 'ME', 'I'].includes(w));
    return (words.slice(0, 3).join(' ') || 'PROGRAM').slice(0, 16);
  }

  async function askClaude(text, opts) {
    opts = opts || {};
    if (busy) { status('Claude is still working on the last request'); return; }
    if (!settings.apiKey) {
      showTab('settings');
      status('Add your Claude API key first', true);
      $('api-key').focus();
      return;
    }
    showTab('ai');
    const pref = $('lang-pref').value;
    let prompt = text;
    if (pref === 'basic') prompt += '\n\n(Write it in Commodore BASIC V2.)';
    if (pref === 'asm') prompt += '\n\n(Write it in 6502 assembly for the built-in assembler.)';
    const includeCode = opts.includeCode || $('use-current').checked && assistant.history.length > 0;
    const includeScreen = opts.includeScreen || attachScreenNext;
    attachScreenNext = false;
    $('prompt').placeholder = 'Describe your program…';
    const screen = includeScreen ? emu.machine.screenText() : null;
    addMsg('user', text + (includeScreen ? '\n📺 (C64 screen attached)' : ''));
    const out = addMsg('assistant');
    const spin = document.createElement('span'); spin.className = 'spinner';
    out.appendChild(spin); out.appendChild(document.createTextNode('Claude is writing…'));
    busy = new AbortController();
    $('send').textContent = 'Stop';
    status('Asking ' + settings.model + '…', true);
    try {
      const res = await assistant.ask({
        apiKey: settings.apiKey, model: settings.model, effort: settings.effort,
        prompt, currentCode: includeCode ? $('code').value : '', currentKind: $('code-kind').value,
        screen, signal: busy.signal,
        onText: t => { out.textContent = t; out.scrollIntoView({ block: 'end' }); }
      });
      out.textContent = '';
      const p = document.createElement('div'); p.textContent = res.explanation || '(no explanation)';
      out.appendChild(p);
      if (res.code) {
        const pre = document.createElement('pre'); pre.textContent = res.code.code; out.appendChild(pre);
        const actions = document.createElement('div'); actions.className = 'actions';
        const runB = document.createElement('button'); runB.className = 'primary small'; runB.textContent = '▶ Run this version';
        runB.addEventListener('click', () => { setProgram(res.code.code, res.code.kind); runCurrent(); });
        const editB = document.createElement('button'); editB.className = 'small'; editB.textContent = 'Open in editor';
        editB.addEventListener('click', () => { setProgram(res.code.code, res.code.kind); showTab('code'); });
        actions.append(runB, editB);
        out.appendChild(actions);
        const isNew = !includeCode;
        setProgram(res.code.code, res.code.kind, isNew ? nameFromPrompt(text) : null);
        if (res.truncated) status('The answer was cut off; ask Claude to continue or simplify.', true);
        else status('Program ready, running it now');
        runCurrent();
      } else {
        status('Claude answered without code');
      }
    } catch (e) {
      out.remove();
      addMsg('error', C64.ai.describeError(e));
      status('');
    } finally {
      busy = null;
      $('send').textContent = 'Write';
    }
  }

  $('prompt-form').addEventListener('submit', e => {
    e.preventDefault();
    if (busy) { busy.abort(); return; }
    const t = $('prompt').value.trim();
    if (!t) return;
    $('prompt').value = '';
    askClaude(t);
  });
  $('prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('prompt-form').requestSubmit(); }
  });
  document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { $('prompt').value = c.dataset.prompt; $('prompt').focus(); }));
  $('new-chat').addEventListener('click', () => {
    assistant.reset();
    document.querySelectorAll('#chat .msg:not(.system)').forEach(m => m.remove());
    status('New conversation started');
  });

  // ------------------------------------------------------------ export -----
  function fileBase() { return (prog.name || 'program').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'program'; }

  function saveFile(name, mime, bytes) {
    if (window.AndroidBridge && window.AndroidBridge.saveFile) {
      window.AndroidBridge.saveFile(name, mime, b64.enc(bytes));
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    status('Saved ' + name);
  }
  window.onNativeSaveResult = (ok, msg) => status(ok ? 'Saved ' + msg : 'Not saved: ' + msg);

  function sourcePetscii() {
    const lines = prog.code.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
    const out = [];
    lines.forEach(l => { for (const ch of l) out.push(C64.basic.asciiToPetscii(ch)); out.push(13); });
    return new Uint8Array(out);
  }

  function updateExportInfo() {
    try {
      const b = build();
      $('exp-info').textContent = `${prog.name}: ${b.kind === 'basic' ? 'BASIC' : 'machine code'} program, ${b.prg.length} bytes (${Math.ceil(b.prg.length / 254)} blocks). Load on a C64 with LOAD"${prog.name}",8${b.prg[0] === 1 && b.prg[1] === 8 ? '' : ',1'} then ${b.kind === 'basic' || b.hasBasicStub ? 'RUN' : 'SYS ' + b.start}.`;
    } catch (e) { $('exp-info').textContent = 'The current program does not build yet: ' + e.message; }
  }

  $('exp-txt').addEventListener('click', () => {
    saveProgram();
    const text = prog.code.replace(/\r\n?/g, '\n');
    saveFile(fileBase() + (prog.kind === 'basic' ? '.bas.txt' : '.asm.txt'), 'text/plain', new TextEncoder().encode(text));
  });
  $('exp-prg').addEventListener('click', () => {
    try { saveFile(fileBase() + '.prg', 'application/octet-stream', build().prg); }
    catch (e) { status('Cannot build: ' + e.message, true); }
  });
  $('exp-d64').addEventListener('click', () => {
    try {
      const b = build();
      const files = [{ name: prog.name, data: b.prg }];
      if ($('d64-source').checked) files.push({ name: (prog.name.slice(0, 12) + '.SRC'), data: sourcePetscii(), type: 0x81 });
      saveFile(fileBase() + '.d64', 'application/octet-stream', C64.d64.makeDisk(prog.name, files));
    } catch (e) { status('Cannot build: ' + e.message, true); }
  });

  // ------------------------------------------------------------ import -----
  function openPrg(bytes, name) {
    const load = bytes[0] | (bytes[1] << 8);
    let listing = null;
    if (load === 0x0801) { try { listing = C64.basic.detokenize(bytes); } catch (_) { listing = null; } }
    if (listing && listing.trim() && /^\d+ /.test(listing) && !/^\d+ SYS\s*\d+$/.test(listing.trim())) {
      setProgram(listing + '\n', 'basic', name);
      status('Opened ' + name + ' as BASIC');
      showTab('code');
    } else {
      // Machine code: run it directly.
      const start = listing && /SYS\s*(\d+)/.test(listing) ? +listing.match(/SYS\s*(\d+)/)[1] : load;
      emu.run({ kind: 'bin', prg: bytes, start, hasBasicStub: load === 0x0801 && !!listing });
      status('Running ' + name + ' (machine code, not editable)');
    }
  }

  $('import-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const base = f.name.replace(/\.[^.]*$/, '').replace(/\.(bas|asm)$/i, '');
    const list = $('d64-files'); list.innerHTML = '';
    if (/\.d64$/i.test(f.name) || bytes.length === 174848 || bytes.length === 175531) {
      try {
        const disk = C64.d64.readD64(bytes);
        disk.files.forEach(df => {
          const it = document.createElement('div'); it.className = 'item';
          const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = `${df.blocks} "${df.name}" ${df.type}`;
          it.appendChild(nm);
          if (df.type === 'PRG') {
            const b = document.createElement('button'); b.className = 'small'; b.textContent = 'Open';
            b.addEventListener('click', () => openPrg(df.data, df.name));
            it.appendChild(b);
          }
          list.appendChild(it);
        });
        status(`Disk "${disk.name}": ${disk.files.length} files`);
      } catch (err) { status('Could not read disk: ' + err.message); }
    } else if (/\.prg$/i.test(f.name)) {
      openPrg(bytes, base);
    } else {
      const text = new TextDecoder().decode(bytes);
      setProgram(text, C64.basic.looksLikeBasic(text) ? 'basic' : 'asm', base);
      status('Opened ' + f.name);
      showTab('code');
    }
    e.target.value = '';
  });

  // ----------------------------------------------------- saved programs ----
  function renderSaved() {
    const list = $('saved-list'); list.innerHTML = '';
    const saved = LS.get('saved', []);
    if (!saved.length) { list.innerHTML = '<p class="hint">Nothing saved yet.</p>'; return; }
    saved.forEach((s, i) => {
      const it = document.createElement('div'); it.className = 'item';
      const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = `${s.name} · ${s.kind === 'asm' ? 'ASM' : 'BASIC'}`;
      const open = document.createElement('button'); open.className = 'small'; open.textContent = 'Open';
      open.addEventListener('click', () => { setProgram(s.code, s.kind, s.name); showTab('code'); });
      const del = document.createElement('button'); del.className = 'small ghost'; del.textContent = 'Delete';
      del.addEventListener('click', () => { const a = LS.get('saved', []); a.splice(i, 1); LS.set('saved', a); renderSaved(); });
      it.append(nm, open, del);
      list.appendChild(it);
    });
  }
  $('save-prog').addEventListener('click', () => {
    saveProgram();
    const saved = LS.get('saved', []).filter(s => s.name !== prog.name);
    saved.unshift({ name: prog.name, kind: prog.kind, code: prog.code, date: Date.now() });
    LS.set('saved', saved.slice(0, 100));
    renderSaved();
    status('Saved ' + prog.name);
  });

  // -------------------------------------------------------------- start ----
  (async function start() {
    emu.ctx = $('screen').getContext('2d');
    try {
      await loadBuiltinRoms();
    } catch (e) {
      status('Could not load the built-in ROMs: ' + e.message, true);
    }
    loadCustomRoms();
    updateRomStatus();
    emu.init();
    renderSaved();
    if (!settings.apiKey) status('Welcome! Add your Claude API key in Settings to start.', true);
  })();
})();
