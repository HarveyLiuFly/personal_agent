// Dedicated verified Node runtime hosts node-pty; Electron never loads the native binding.
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {lstatSync,realpathSync} from 'node:fs';
let configured=false,started=false,stopping=false,pty,terminal,nonce,timer,closed=false;
process.stdout.on('error',()=>{});
const send=value=>{if(!process.stdout.destroyed)return process.stdout.write(JSON.stringify(value)+'\n');return false;};
function stop(){if(stopping)return;stopping=true;if(!terminal){process.exit(0);return;}try{terminal.kill('SIGHUP');}catch{}timer=setTimeout(()=>{try{terminal.kill('SIGKILL');}catch{}},200);setTimeout(()=>process.exit(91),4000).unref();}
process.stdin.on('end',stop);process.stdin.on('error',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
const lines=createInterface({input:process.stdin});let config;
lines.on('line',line=>{
 try{
  if(Buffer.byteLength(line)>65536)throw Error();const q=JSON.parse(line);
  if(!configured){if(q.kind!=='configure')throw Error();config=q;nonce=q.nonce;pty=createRequire(import.meta.url)(q.module);configured=true;send({kind:'ready',nonce,pid:process.pid});return;}
  if(q.nonce!==nonce)throw Error();
  if(q.kind==='go'&&!started){started=true;const s=lstatSync(config.cwd,{bigint:true});if(realpathSync(config.cwd)!==config.cwd||!s.isDirectory()||s.isSymbolicLink()||String(s.dev)!==config.identity.device||String(s.ino)!==config.identity.inode)throw Error();
   if(typeof config.shell!=='string'||!config.shell.startsWith('/')||!Array.isArray(config.shellArgs)||config.shellArgs.some(a=>typeof a!=='string'))throw Error();
   terminal=pty.spawn(config.shell,config.shellArgs,{name:'xterm-256color',cols:config.cols,rows:config.rows,cwd:config.cwd,env:config.env});send({kind:'started',pid:terminal.pid});
   terminal.onData(data=>{const bytes=Buffer.from(data);let writable=true;for(let offset=0;offset<bytes.length;offset+=16384)writable=send({kind:'data',data:bytes.subarray(offset,offset+16384).toString('base64')})&&writable;if(!writable){terminal.pause();process.stdout.once('drain',()=>{if(!stopping&&!closed)terminal.resume();});}});
   terminal.onExit(event=>{closed=true;clearTimeout(timer);if(process.stdout.destroyed)process.exit(0);process.stdout.write(JSON.stringify({kind:'exit',code:event.exitCode,signal:event.signal})+'\n',()=>process.exit(0));setTimeout(()=>process.exit(0),1000).unref();});return;
  }
  if(q.kind==='stop'){stop();return;}if(!terminal||stopping||closed)throw Error();
  if(q.kind==='input'){if(typeof q.text!=='string'||Buffer.byteLength(q.text)>16384||!Number.isSafeInteger(q.sequence))throw Error();terminal.write(q.text);send({kind:'input',sequence:q.sequence});}
  else if(q.kind==='resize'){terminal.resize(q.cols,q.rows);send({kind:'resize',cols:q.cols,rows:q.rows});}else throw Error();
 }catch{send({kind:'error',code:'TERMINAL_WORKER_FAILED'});stop();}
});
