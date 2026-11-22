// Run with: node test/interp.test.js
// Boots the emulator with the bundled Open ROMs and runs BASIC programs
// through the built-in interpreter, checking what appears on the C64 screen.
const assert = require('assert');
const { runBasic } = require('./interp-run.js');
const { C64, newMachine } = require('./load.js');

function out(src, frames, typed) {
  const r = runBasic(src, frames || 300, typed);
  return r.screen.split('\n').slice(1).join('\n');   // drop the first READY.
}

assert.strictEqual(out('10 PRINT "HELLO";1+2;7/2'), 'HELLO 3  3.5\nREADY.');
assert.strictEqual(out('10 FOR I=1 TO 3:PRINT I;:NEXT'), ' 1  2  3\nREADY.');
assert.strictEqual(out('10 A$="AB"+CHR$(67):PRINT A$;LEN(A$);ASC("A");MID$(A$,2,1)'), 'ABC 3  65 B\nREADY.');
assert.strictEqual(out('10 PRINT INT(-2.5);2^10;SQR(16);1E10;.001;-.5'), '-3  1024  4  1E+10  1E-03 -.5\nREADY.');
assert.strictEqual(out('10 DIM A(5,2):A(3,1)=9:PRINT A(3,1);A(0,0)'), ' 9  0\nREADY.');
assert.strictEqual(out('10 GOSUB 30:PRINT "B":END\n30 PRINT "A":RETURN'), 'A\nB\nREADY.');
assert.strictEqual(out('10 READ X,Y$:PRINT X;Y$\n20 DATA 7,"HI, THERE"'), ' 7 HI, THERE\nREADY.');
assert.strictEqual(out('10 IF 2>1 THEN PRINT "Y":GOTO 30\n20 PRINT "N"\n30 PRINT "END"'), 'Y\nEND\nREADY.');
assert.strictEqual(out('10 DEF FN F(Q)=Q*2+1:PRINT FN F(20);NOT 0;5 AND 3;5 OR 3'), ' 41 -1  1  7\nREADY.');
assert.strictEqual(out('10 ON 2 GOTO 20,30\n20 PRINT "TWO?":END\n30 PRINT "THREE"'), 'THREE\nREADY.');
assert.strictEqual(out('10 PRINT 1/0'), '\n?DIVISION BY ZERO  ERROR IN 10\nREADY.');
assert.strictEqual(out('10 PRINT "A" "B"\n20 X = 1 +'), 'AB\n\n?SYNTAX  ERROR IN 20\nREADY.');
assert.strictEqual(out('10 NEXT'), '\n?NEXT WITHOUT FOR  ERROR IN 10\nREADY.');
assert.strictEqual(out('10 POKE 49152,96:SYS 49152:PRINT PEEK(49152)'), ' 96\nREADY.');
assert.strictEqual(out('10 INPUT "NAME";N$:INPUT A,B:PRINT "HI ";N$;A+B', 400, 'BOB\n3,4\n'), 'NAME? BOB\n? 3,4\nHI BOB 7\nREADY.');
assert.strictEqual(out('10 GET K$:IF K$="" THEN 10\n20 PRINT "KEY ";K$', 200, 'Q'), 'KEY Q\nREADY.');
// Timing: a 1000-iteration empty FOR loop takes roughly a second like on real hardware.
const r = runBasic('10 T=TI:FOR I=1 TO 1000:NEXT:PRINT TI-T', 400);
const jiffies = parseInt(r.screen.split('\n')[1], 10);
assert.ok(jiffies > 30 && jiffies < 90, 'loop took ' + jiffies + ' jiffies');
// The screen shows color: POKE to border, PRINT color codes.
const r2 = runBasic('10 POKE 53280,2:PRINT "{RED}X"', 100);
assert.strictEqual(r2.m.vic[0x20] & 15, 2);

// Assembly program started with RUN through its BASIC stub (Open ROMs BASIC can do SYS).
const m = newMachine();
const prog = C64.asm.assemble('ldx #0\nloop: lda msg,x\n beq done\n jsr $ffd2\n inx\n bne loop\ndone: rts\nmsg: .null "ASM OK"');
m.runProgram(prog.prg);
for (let i = 0; i < 100; i++) m.runFrame();
assert.ok(/RUN\nASM OK\nREADY\./.test(m.screenText()), m.screenText());
console.log('interpreter tests passed');

// Direct mode after the program ends: immediate commands, typing in lines, LIST and RUN.
{
  const r = runBasic('10 PRINT "FIRST"', 900, 'PRINT 2+2\n20 PRINT "SECOND"\nLIST\nRUN\n');
  const lines = r.screen.split('\n');
  assert.deepStrictEqual(lines.slice(-13), ['PRINT 2+2', ' 4', 'READY.', '20 PRINT "SECOND"', 'LIST', '',
    '10 PRINT "FIRST"', '20 PRINT "SECOND"', 'READY.', 'RUN', 'FIRST', 'SECOND', 'READY.'], r.screen);
}
console.log('direct mode tests passed');
