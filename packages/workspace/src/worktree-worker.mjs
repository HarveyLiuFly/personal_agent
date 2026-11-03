// Owned supervisor: no Git starts until the Host has durably registered this process group.
import {spawn} from 'node:child_process';
import {lstatSync,realpathSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
let child,started=false,configured=false,waiting=false,config,timer;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const present=path=>{try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const identity=(path,expected)=>{const s=lstatSync(path,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(path)!==path||String(s.dev)!==expected.device||String(s.ino)!==expected.inode)throw Error();};
const stop=()=>{try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(90);}};
const finish=value=>{clearTimeout(timer);process.stdout.write(JSON.stringify(value)+'\n',()=>process.exit(value.code===0?0:1));setTimeout(()=>process.exit(91),1000).unref();};
function runGit(){
 if(child)throw Error();
 if(config.missing){identity(config.missing.recovery,config.missing.identity);if(present(config.missing.path))throw Error();}
 child=spawn(config.git,config.args,{cwd:config.cwd,env:config.env,stdio:['ignore','pipe','pipe'],detached:false});
 let bytes=0;const digest=createHash('sha256');for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{bytes+=data.length;if(bytes>1048576)stop();digest.update(data);});
 child.once('error',()=>finish({kind:'result',code:null,error:'SPAWN_FAILED'}));
 child.once('close',(code,signal)=>finish({kind:'result',code,signal,bytes,outputHash:digest.digest('hex')}));
}
process.stdin.on('end',stop);process.stdin.on('error',stop);process.stdout.on('error',stop);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
 try{
  if(Buffer.byteLength(line)>65536)throw Error();const q=JSON.parse(line);
  if(!configured){if(q.kind!=='configure'||typeof q.nonce!=='string'||typeof q.git!=='string'||!Array.isArray(q.args)||!q.args.every(a=>typeof a==='string'))throw Error();config=q;configured=true;timer=setTimeout(stop,30000);send({kind:'ready',pid:process.pid,nonce:q.nonce});return;}
  if(q.nonce!==config.nonce)throw Error();
  if(q.kind==='continue'&&waiting){waiting=false;runGit();return;}
  if(q.kind!=='go'||started)throw Error();started=true;
  if(config.archive){const a=config.archive;identity(a.source,a.identity);if(present(a.target))throw Error();renameSync(a.source,a.target);waiting=true;send({kind:'archived'});return;}
  runGit();
 }catch{stop();}
});
