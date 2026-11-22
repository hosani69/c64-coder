// Loads the browser modules into Node for tests.
const fs = require('fs'), path = require('path');
const W = path.join(__dirname, '../app/src/main/assets/www/');
for (const f of ['basic', 'asm', 'd64', 'cpu6502', 'sid', 'machine', 'basic-interp']) require(W + 'c64/' + f + '.js');
const rom = n => new Uint8Array(fs.readFileSync(W + 'roms/' + n));
function newMachine() {
  const m = new globalThis.C64.machine.C64();
  m.loadRoms(rom('basic_generic.rom'), rom('kernal_generic.rom'), rom('chargen_openroms.rom'));
  return m;
}
module.exports = { C64: globalThis.C64, newMachine };
