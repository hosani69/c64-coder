# C64 Coder

An Android app that writes Commodore 64 programs with Claude, runs them in a
built-in C64 emulator, and exports them for real hardware.

1. **Describe** a program ("a bouncing ball that changes the border color").
2. **Claude writes it** in Commodore BASIC V2 (or 6502 assembly if you ask).
3. **It runs right away** in the emulator inside the app. If it stops with an
   error, tap **Fix with Claude**.
4. **Export** it as a `.txt` listing, a `.prg` program file, or a `.d64` disk
   image for a real C64 (SD2IEC, Kung Fu Flash, 1541 Ultimate, Pi1541, a
   transfer cable) or for VICE.

## Install

Download `c64-coder.apk` from the
[latest release](../../releases/tag/latest) on your phone and open it.
Android asks you to allow installing apps from your browser or file manager
the first time. Every push to `main` builds a new APK with GitHub Actions.

Then open **Settings** and paste your Claude API key (create one at
[console.anthropic.com](https://console.anthropic.com)). The key is stored only
on your phone and is sent only to `api.anthropic.com`.

## What's inside

| Part | File | Notes |
|---|---|---|
| Claude integration | `www/c64/ai.js` | Official Anthropic SDK, `claude-opus-5-5` by default (Sonnet, Haiku and Fable selectable), streaming, adaptive thinking, server-side fallbacks. |
| BASIC V2 tokenizer | `www/c64/basic.js` | Text listing to `.prg` and back. Understands `{CLR}`, `{RED}`, `{5 DOWN}` style control codes in strings. |
| 6502 assembler | `www/c64/asm.js` | Two-pass, labels, expressions, `.byte .word .text .null .fill`, automatic `10 SYS 2061` BASIC starter. |
| .d64 writer/reader | `www/c64/d64.js` | Standard 35-track 1541 images with BAM and directory. |
| 6510 CPU | `www/c64/cpu6502.js` | All official opcodes plus the stable undocumented ones; passes Klaus Dormann's 6502 functional test. |
| C64 machine | `www/c64/machine.js` | PAL timing, memory banking, VIC-II (text, multicolor, extended color, bitmap modes, sprites, raster IRQ, collisions), CIA timers/TOD/keyboard/joysticks. |
| SID | `www/c64/sid.js` | Three voices, all waveforms, ADSR, ring mod, sync, filter (approximate). |
| BASIC interpreter | `www/c64/basic-interp.js` | Runs BASIC V2 on top of the emulated machine when no original BASIC ROM is installed (see below). |
| App UI | `www/index.html`, `app.js`, `app.css` | Claude chat, code editor, emulator screen with on-screen keys and joystick, export/import, saved programs. |
| Android shell | `app/src/main/java/.../MainActivity.kt` | WebView with `WebViewAssetLoader`, Save-as dialog for exports, file picker for imports. |

### About the ROMs

Commodore's original ROMs are copyrighted, so the app ships with the free
[MEGA65 Open ROMs](https://github.com/MEGA65/open-roms) (LGPL-3.0). Their
KERNAL works, but their BASIC can't do arithmetic yet. So when you run a BASIC
program with the Open ROMs, the app's own BASIC V2 interpreter executes it
while everything else stays emulated: `PRINT` goes through the KERNAL screen
editor, `POKE`/`PEEK` reach the real VIC-II, SID and CIAs, `SYS` runs machine
code on the 6510. After the program ends you get a working `READY.` prompt
where you can type commands and new lines.

For the most faithful results, load your own ROM files in **Settings >
Emulator ROMs** (for example from a VICE installation or C64 Forever). With an
original BASIC ROM installed, BASIC programs run natively on the emulated C64.

### Known limits

- No disk drive or tape emulation: `LOAD`/`SAVE` inside the emulator report
  `?DEVICE NOT PRESENT`. Exported `.d64`/`.prg` files work on real drives.
- The VIC-II renders per raster line (good for raster bars and split screens),
  but not cycle-exact; bad-line timing is not emulated.
- The SID is an approximation of the 6581, not a cycle-accurate model.

## Build it yourself

```sh
node test/tools.test.js      # tokenizer, assembler, .d64
node test/interp.test.js     # emulator + BASIC interpreter
./gradlew assembleDebug      # needs JDK 17 and the Android SDK
```

You can also try the app in a desktop browser:
`cd app/src/main/assets/www && python3 -m http.server`, then open
`http://localhost:8000`.

The APK is signed with the committed `app/debug.keystore` (a public debug
key, password `android`) so that each CI build installs over the previous one.
Use your own private key if you publish the app in a store.

## License

App code: MIT. Bundled Open ROMs: LGPL-3.0-or-later. Anthropic SDK:
Apache-2.0. See [LICENSE](LICENSE). Commodore 64 is a trademark of its
respective owner; this project is not affiliated with it.
