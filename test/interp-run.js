// Usage: node test/interp-run.js file.bas [frames] [typed keys]
const { C64, newMachine } = require('./load.js');
function runBasic(src, frames, typed) {
  const m = newMachine();
  m.boot();
  m.loadPrg(C64.basic.tokenize(src));
  const it = new C64.interp.BasicInterpreter(m);
  it.start();
  if (typed) m.type([...typed]);
  for (let i = 0; i < (frames || 100) && it.running; i++) it.frame();
  return { m, it, screen: m.screenText().split('\n').slice(10).join('\n') };
}
module.exports = { runBasic };
if (require.main === module) {
  const src = require('fs').readFileSync(process.argv[2], 'utf8');
  const r = runBasic(src, +process.argv[3] || 300, process.argv[4]);
  console.log(r.screen);
}
