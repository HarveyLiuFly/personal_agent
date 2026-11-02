import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {test} from 'node:test';
test('the real Node reporter distinguishes zero-test file wrappers from named cases, including line one',t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-reporter-'))),target=join(root,'case.mjs');t.after(()=>rmSync(root,{recursive:true,force:true}));
 const reporter=resolve('packages/verification/src/reporter.mjs');
 const report=(source:string,relative=false)=>{writeFileSync(target,source);return execFileSync(process.execPath,['--test',`--test-reporter=${reporter}`,'--',relative?basename(target):target],{encoding:'utf8',cwd:root,env:{PATH:process.env.PATH}}).trim();};
 for(const relative of [false,true]){assert.equal(report('// zero tests\n',relative),'');assert.equal(report('process.exit(0);\n',relative),'');}
 const actual=JSON.parse(report("import {test} from 'node:test';test('real named case',()=>{});"));
 assert.equal(actual.name,'real named case');assert.equal(actual.line,1);assert.equal(actual.skipped,false);
 const skipped=JSON.parse(report("import {test} from 'node:test';test.skip('not executed',()=>{});"));assert.equal(skipped.skipped,true);
});
