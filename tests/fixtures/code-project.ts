import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
/** Controlled, public test data only. Never initializes or modifies a supplied user's repository. */
export function createCodeFixture(cwd:string):void{
 mkdirSync(join(cwd,'src'),{recursive:true});mkdirSync(join(cwd,'test'),{recursive:true});
 writeFileSync(join(cwd,'package.json'),'{"type":"module"}\n');
 writeFileSync(join(cwd,'src/math.mjs'),'export const sum = (a, b) => a - b;\n');
 writeFileSync(join(cwd,'test/math.test.mjs'),`import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import {sum} from '../src/math.mjs';
test('adds positive integers',()=>assert.equal(sum(2,3),5));
test('adds negative integers',()=>assert.equal(sum(-2,-3),-5));
test('adds zero and mixed signs',()=>{assert.equal(sum(0,0),0);assert.equal(sum(-4,9),5);});
test('adds fresh integer pairs',()=>{for(let i=0;i<20;i++){const a=randomInt(-10000,10000),b=randomInt(1,10000);assert.equal(sum(a,b),a+b);}});
`);
 const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-C',cwd,...args],{stdio:'ignore'});
 git(['init','--quiet']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','--no-gpg-sign','-m','controlled bug fixture']);
}
