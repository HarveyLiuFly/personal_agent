import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import electron from 'electron';
const require=createRequire(import.meta.url);
if(typeof electron!=='string')throw new Error('ELECTRON_EXECUTABLE_UNAVAILABLE');
const source=`import {calendarBaseline,nextCron,previousCron} from './packages/runtime/src/calendar.ts';
const checks={nyGap:nextCron({expression:'30 2 * * *',timezone:'America/New_York'},Date.parse('2026-03-08T05:00:00Z'))===Date.parse('2026-03-09T06:30:00Z'),nyRepeat:previousCron({expression:'* * * * *',timezone:'America/New_York'},Date.parse('2026-11-01T06:20:00Z'))===Date.parse('2026-11-01T05:59:00Z'),halfHourGap:previousCron({expression:'15 2 * * *',timezone:'Australia/Lord_Howe'},Date.parse('2026-10-03T17:00:00Z'))===Date.parse('2026-10-02T15:45:00Z')};
console.log(JSON.stringify({baseline:calendarBaseline(),checks}));if(Object.values(checks).some(v=>!v))process.exitCode=1;`;
const runtimes=[['cli_node',process.execPath],['electron_embedded_node',electron]] as const;
const results=runtimes.map(([kind,executable])=>{
 const result=spawnSync(executable,['--disable-warning=ExperimentalWarning','--input-type=module','-e',source],{encoding:'utf8',timeout:15000,maxBuffer:20000,env:{PATH:process.env.PATH,ELECTRON_RUN_AS_NODE:'1'}});
 if(result.status!==0)return{kind,status:'failed',exitCode:result.status};
 try{return{kind,status:'passed',...JSON.parse(result.stdout)};}catch{return{kind,status:'failed',code:'INVALID_PROBE_OUTPUT'};}
});
const files=['packages/runtime/src/calendar.ts','tests/calendar.test.ts','pnpm-lock.yaml',require.resolve('cron-parser')];
const hashes=Object.fromEntries(files.map((file,index)=>[index===3?'installed_cron_parser_entry':file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const evidence={status:results.every(r=>r.status==='passed')?'passed':'blocked',observedAt:new Date().toISOString(),kind:'real_cli_node_and_electron_node_calendar',modelTurns:0,guiOrDaemonClaimed:false,cronParser:JSON.parse(readFileSync(new URL('../node_modules/cron-parser/package.json',import.meta.url),'utf8')).version,luxonLocked:'3.7.2',results,hashes};
writeFileSync('docs/progress/evidence/M2.3a-calendar.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));if(evidence.status!=='passed')process.exitCode=1;
