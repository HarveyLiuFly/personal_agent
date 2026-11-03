// Owned supervisor: no Git starts until the Host has durably registered this process group.
import {spawn} from 'node:child_process';
import {lstatSync,existsSync,realpathSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
let child,started=false,configured=false,config,timer;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const stop=()=>{try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(90);}};
process.stdin.on('end',stop);process.stdin.on('error',stop);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
 try{
  const q=JSON.parse(line);
  if(!configured){if(q.kind!=='configure'||typeof q.nonce!=='string'||typeof q.git!=='string'||!Array.isArray(q.args)||!q.args.every(a=>typeof a==='string'))throw Error();config=q;configured=true;timer=setTimeout(stop,30000);send({kind:'ready',pid:process.pid,nonce:q.nonce});return;}
  if(q.kind!=='go'||q.nonce!==config.nonce||started)throw Error();started=true;
  if(config.archive){const a=config.archive,s=lstatSync(a.source,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(a.source)!==a.source||String(s.dev)!==a.identity.device||String(s.ino)!==a.identity.inode||existsSync(a.target))throw Error();renameSync(a.source,a.target);}
  child=spawn(config.git,config.args,{cwd:config.cwd,env:config.env,stdio:['ignore','pipe','pipe'],detached:false});
  let bytes=0;const digest=createHash('sha256');for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{bytes+=data.length;if(bytes>1048576)stop();digest.update(data);});
  child.once('error',()=>{send({kind:'result',code:null,error:'SPAWN_FAILED'});clearTimeout(timer);process.exit(1);});
  child.once('close',(code,signal)=>{send({kind:'result',code,signal,bytes,outputHash:digest.digest('hex')});clearTimeout(timer);process.exit(code===0?0:1);});
 }catch{stop();}
});
