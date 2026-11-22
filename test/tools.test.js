// Run with: node test/tools.test.js
const assert = require('assert');
const path = require('path');
const W = path.join(__dirname, '../app/src/main/assets/www/c64/');
const basic = require(W + 'basic.js');
const asm = require(W + 'asm.js');
const d64 = require(W + 'd64.js');
const hex = a => [...a].map(b => b.toString(16).padStart(2, '0')).join(' ');

// BASIC: 10 PRINT "HELLO" / 20 GOTO 10
let prg = basic.tokenize('10 PRINT "HELLO"\n20 GOTO 10\n');
assert.strictEqual(hex(prg), '01 08 0f 08 0a 00 99 20 22 48 45 4c 4c 4f 22 00 18 08 14 00 89 20 31 30 00 00 00');
assert.strictEqual(basic.detokenize(prg), '10 PRINT "HELLO"\n20 GOTO 10');
// control codes, lowercase, DATA/REM not crunched, ? shorthand
prg = basic.tokenize('10 ?"{clr}{5 down}hi":rem print me\n20 data print,to\n');
const list = basic.detokenize(prg);
assert.strictEqual(list, '10 PRINT"{CLR}{DOWN}{DOWN}{DOWN}{DOWN}{DOWN}HI":REM PRINT ME\n20 DATA PRINT,TO');
assert.ok(basic.looksLikeBasic('10 PRINT 1\n20 END'));
assert.ok(!basic.looksLikeBasic('  lda #1\n  rts'));

// Assembler
let r = asm.assemble(`
SCREEN = $0400
start:  lda #$01      ; white
        sta $d020
        ldx #0
loop:   lda msg,x
        beq done
        sta SCREEN,x
        inx
        bne loop
done:   rts
msg:    .text "HI"
        .byte 0
`);
assert.strictEqual(r.load, 0x0801);
assert.strictEqual(r.start, 2061);
assert.strictEqual(hex(r.prg.subarray(2, 15)), '0b 08 0a 00 9e 32 30 36 31 00 00 00 a9');
const code = r.prg.subarray(2 + 12);
assert.strictEqual(hex(code.subarray(0, 8)), 'a9 01 8d 20 d0 a2 00 bd');
r = asm.assemble(`*=$c000\n lda ($fb),y\n jmp ($fffc)\n lda $10,x\n ldx $1000,y\n asl\n ror a\n .word $1234, label\nlabel: rts`);
assert.strictEqual(r.load, 0xc000);
assert.strictEqual(hex(r.prg.subarray(2)), 'b1 fb 6c fc ff b5 10 be 00 10 0a 6a 34 12 10 c0 60');
assert.throws(() => asm.assemble(' lda nowhere'), /undefined/);

// D64
const img = d64.makeDisk('TEST DISK', [{ name: 'HELLO', data: basic.tokenize('10 PRINT "HI"') }, { name: 'BIG', data: new Uint8Array(1000).map((_, i) => i & 255) }]);
assert.strictEqual(img.length, 174848);
const rd = d64.readD64(img);
assert.strictEqual(rd.name, 'TEST DISK');
assert.deepStrictEqual(rd.files.map(f => [f.name, f.type, f.blocks]), [['HELLO', 'PRG', 1], ['BIG', 'PRG', 4]]);
assert.strictEqual(rd.files[1].data.length, 1000);
assert.strictEqual(rd.files[1].data[999], 999 & 255);
// BAM free count: 664 - 5
let free = 0; for (let t = 1; t <= 35; t++) if (t !== 18) free += img[0x16500 + 4 * t];
assert.strictEqual(free, 659);
console.log('tools tests passed');
