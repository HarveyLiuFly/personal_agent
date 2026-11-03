import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import type {ClientRequest,IncomingMessage} from 'node:http';
import {closeSync,constants,existsSync,fstatSync,fsyncSync,linkSync,lstatSync,mkdirSync,openSync,readSync,readdirSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {TrustedSourceEnvelope} from '../../contracts/src/goals.ts';

export interface AuthenticatedSourceConnection {sourceId:string;bindingRef:string;url:string;token:string}
export interface AuthenticatedSourcePollerOptions {
 connections:AuthenticatedSourceConnection[];directory:string;
 /** Host-controlled public Provider tests only, never accepted over IPC. */
 allowLoopbackHttpForTests?:boolean;
 /** Shorten only explicitly enabled loopback Provider tests. */
 timeoutMsForTests?:number;
}
export class SourcePollerError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
const fail=(code:string):never=>{throw new SourcePollerError(code);};
const RESPONSE_BYTES=2*1024*1024,PAYLOAD_BYTES=65536,EVENTS=100,CURSOR_BYTES=8192;
const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const control=/[\x00-\x1f\x7f]/;
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&!control.test(v);
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const frozen=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const nested of Object.values(value))frozen(nested);Object.freeze(value);}return value;};
function cursorJson(value:unknown):string {
 let nodes=0;
 const check=(v:unknown,depth:number):void=>{if(++nodes>1000||depth>10)fail('SOURCE_CURSOR_INVALID');if(v===null||typeof v==='boolean'||typeof v==='string')return;if(typeof v==='number'&&Number.isFinite(v))return;if(Array.isArray(v)){if(v.length>100)fail('SOURCE_CURSOR_INVALID');for(const child of v)check(child,depth+1);return;}if(plain(v)&&Object.getPrototypeOf(v)===Object.prototype){const entries=Object.entries(v);if(entries.length>100)fail('SOURCE_CURSOR_INVALID');for(const [key,child]of entries){if(key.length>200)fail('SOURCE_CURSOR_INVALID');check(child,depth+1);}return;}fail('SOURCE_CURSOR_INVALID');};
 check(value,0);const json=JSON.stringify(value);if(Buffer.byteLength(json)>CURSOR_BYTES)fail('SOURCE_CURSOR_INVALID');return json;
}
/** Fixed Host connections only. A MAC proves the configured Provider possessed
 * its token; it does not prove a third-party account or grant action authority.
 */
export class AuthenticatedSourcePoller {
 #connections=new Map<string,{sourceId:string;bindingRef:string;url:URL;token:string}>();
 #verified=new WeakSet<TrustedSourceEnvelope>();#sources=new WeakMap<TrustedSourceEnvelope,string>();
 #directory!:string;#directoryDevice!:number;#directoryInode!:number;#timeout:number;
 constructor(options:AuthenticatedSourcePollerOptions){
  if(!options||!Array.isArray(options.connections)||options.connections.length>100||typeof options.directory!=='string'||!options.directory||control.test(options.directory)||(options.allowLoopbackHttpForTests!==undefined&&typeof options.allowLoopbackHttpForTests!=='boolean')||(options.timeoutMsForTests!==undefined&&(!options.allowLoopbackHttpForTests||!Number.isSafeInteger(options.timeoutMsForTests)||options.timeoutMsForTests<20||options.timeoutMsForTests>5000)))fail('SOURCE_CONFIGURATION_INVALID');
  this.#timeout=options.timeoutMsForTests??5000;
  for(const connection of options.connections){
   if(!connection||!id(connection.sourceId)||!id(connection.bindingRef)||typeof connection.url!=='string'||connection.url.length>8192||control.test(connection.url)||typeof connection.token!=='string'||!/^[\x21-\x7e]{16,4096}$/.test(connection.token)||this.#connections.has(connection.sourceId))fail('SOURCE_CONFIGURATION_INVALID');
   let url:URL;try{url=new URL(connection.url);}catch{return fail('SOURCE_CONFIGURATION_INVALID');}
   if(url.username||url.password||url.hash||(url.protocol!=='https:'&&!(options.allowLoopbackHttpForTests===true&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname))))fail('SOURCE_URL_REJECTED');
   this.#connections.set(connection.sourceId,{sourceId:connection.sourceId,bindingRef:connection.bindingRef,url,token:connection.token});
  }
  try{mkdirSync(resolve(options.directory),{recursive:true,mode:0o700});const info=lstatSync(resolve(options.directory));if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))fail('SOURCE_DIRECTORY_INVALID');this.#directory=realpathSync(resolve(options.directory));this.#directoryDevice=info.dev;this.#directoryInode=info.ino;}catch(error){if(error instanceof SourcePollerError)throw error;return fail('SOURCE_DIRECTORY_INVALID');}
 }
 private directory(){try{const info=lstatSync(this.#directory);if(!info.isDirectory()||info.isSymbolicLink()||info.dev!==this.#directoryDevice||info.ino!==this.#directoryInode||(info.mode&0o077)!==0)fail('SOURCE_DIRECTORY_CHANGED');}catch(error){if(error instanceof SourcePollerError)throw error;fail('SOURCE_DIRECTORY_CHANGED');}}
 private ref(ref:unknown):string {if(typeof ref!=='string'||!/^payload:[a-f0-9]{64}$/.test(ref))return fail('SOURCE_PAYLOAD_REF_INVALID');return ref.slice('payload:'.length);}
 private read(hash:string):Buffer {
  this.directory();let fd:number|undefined;
  try{fd=openSync(join(this.#directory,hash+'.payload'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||(info.mode&0o077)!==0||info.size>PAYLOAD_BYTES)fail('SOURCE_PAYLOAD_INVALID');const bytes=Buffer.alloc(info.size);let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(count===0)fail('SOURCE_PAYLOAD_INVALID');offset+=count;}const after=fstatSync(fd);if(after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs||digest(bytes)!==hash)fail('SOURCE_PAYLOAD_INVALID');new TextDecoder('utf-8',{fatal:true}).decode(bytes);return bytes;}catch(error){if(error instanceof SourcePollerError)throw error;return fail('SOURCE_PAYLOAD_INVALID');}finally{if(fd!==undefined)closeSync(fd);}
 }
 private save(bytes:Buffer,hash:string):void {
  this.directory();const target=join(this.#directory,hash+'.payload');if(existsSync(target)){this.read(hash);return;}
  let staging:string|undefined,fd:number|undefined;
  try{
   if(readdirSync(this.#directory).length>=10000)fail('SOURCE_PAYLOAD_LIMIT');staging=join(this.#directory,'.staging-'+randomBytes(24).toString('hex'));
   fd=openSync(staging,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;
   try{linkSync(staging,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;this.read(hash);}
   unlinkSync(staging);staging=undefined;const directoryFd=openSync(this.#directory,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}
  }catch(error){if(error instanceof SourcePollerError)throw error;fail('SOURCE_PAYLOAD_WRITE_FAILED');}finally{if(fd!==undefined)closeSync(fd);if(staging!==undefined)try{unlinkSync(staging);}catch{}}
 }
 private response(connection:{url:URL;token:string},nonce:string,body:Buffer):Promise<{bytes:Buffer;signature:string}> {
  return new Promise((resolveResponse,reject)=>{
   let settled=false,request:ClientRequest|undefined,response:IncomingMessage|undefined;
   const finish=(code:string)=>{if(settled)return;settled=true;clearTimeout(timer);response?.destroy();request?.destroy();reject(new SourcePollerError(code));};
   const timer=setTimeout(()=>finish('SOURCE_POLL_TIMEOUT'),this.#timeout);
   try{const send=connection.url.protocol==='https:'?httpsRequest:httpRequest;request=send(connection.url,{method:'POST',agent:false,rejectUnauthorized:true,maxHeaderSize:8192,headers:{authorization:'Bearer '+connection.token,'content-type':'application/json','content-length':body.length,'x-source-nonce':nonce,'accept-encoding':'identity'}},incoming=>{
    response=incoming;if(incoming.statusCode!==200){finish(incoming.statusCode&&incoming.statusCode>=300&&incoming.statusCode<400?'SOURCE_REDIRECT_REJECTED':'SOURCE_HTTP_REJECTED');return;}
    const length=incoming.headers['content-length'],encoding=incoming.headers['content-encoding'];if((length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>RESPONSE_BYTES))||(encoding!==undefined&&encoding!=='identity')){finish('SOURCE_RESPONSE_TOO_LARGE');return;}
    const signature=incoming.headers['x-source-signature'];if(typeof signature!=='string'||!/^[a-f0-9]{64}$/i.test(signature)){finish('SOURCE_SIGNATURE_INVALID');return;}
    const chunks:Buffer[]=[];let size=0;incoming.on('data',(chunk:Buffer)=>{if(settled)return;size+=chunk.length;if(size>RESPONSE_BYTES){finish('SOURCE_RESPONSE_TOO_LARGE');return;}chunks.push(chunk);});incoming.on('aborted',()=>finish('SOURCE_CONNECTION_FAILED'));incoming.on('error',()=>finish('SOURCE_CONNECTION_FAILED'));incoming.on('end',()=>{if(settled)return;settled=true;clearTimeout(timer);resolveResponse({bytes:Buffer.concat(chunks,size),signature});});
   });request.on('error',()=>finish('SOURCE_CONNECTION_FAILED'));request.end(body);}catch{finish('SOURCE_CONNECTION_FAILED');}
  });
 }
 async poll(sourceId:string,cursor:unknown):Promise<TrustedSourceEnvelope> {
  const connection=this.#connections.get(sourceId);if(!connection)return fail('SOURCE_NOT_REGISTERED');
  try{
   const cursorValue=JSON.parse(cursorJson(cursor)),nonce=randomBytes(32).toString('hex'),body=Buffer.from(JSON.stringify({sourceId,bindingRef:connection.bindingRef,cursor:cursorValue,nonce}),'utf8'),response=await this.response(connection,nonce,body),expected=createHmac('sha256',connection.token).update(nonce+'\n').update(response.bytes).digest(),observed=Buffer.from(response.signature,'hex');
   if(observed.length!==expected.length||!timingSafeEqual(observed,expected))return fail('SOURCE_SIGNATURE_INVALID');
   let parsed:unknown;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.bytes));}catch{return fail('SOURCE_RESPONSE_INVALID');}
   if(!plain(parsed)||!exact(parsed,['sourceId','bindingRef','actorRef','events','cursor'])||parsed.sourceId!==sourceId||parsed.bindingRef!==connection.bindingRef||!id(parsed.actorRef)||!Array.isArray(parsed.events)||parsed.events.length>EVENTS)return fail('SOURCE_RESPONSE_INVALID');
   const outputCursor=JSON.parse(cursorJson(parsed.cursor)),events:TrustedSourceEnvelope['events']=[],payloads=new Map<string,Buffer>(),ids=new Set<string>();
   for(const event of parsed.events){
    if(!plain(event)||!exact(event,['id','threadRef','eventType','occurredAtMs','payload'])||!id(event.id)||!id(event.threadRef)||!id(event.eventType)||!Number.isSafeInteger(event.occurredAtMs)||Number(event.occurredAtMs)<0||typeof event.payload!=='string'||Buffer.byteLength(event.payload)>PAYLOAD_BYTES||Buffer.from(event.payload,'utf8').toString('utf8')!==event.payload||event.payload.includes(connection.token))return fail('SOURCE_RESPONSE_INVALID');
    if(ids.has(event.id))return fail('SOURCE_DUPLICATE_EVENT');ids.add(event.id);const payload=Buffer.from(event.payload,'utf8'),payloadSha256=digest(payload);payloads.set(payloadSha256,payload);events.push({id:event.id,threadRef:event.threadRef,eventType:event.eventType,occurredAtMs:Number(event.occurredAtMs),payloadRef:'payload:'+payloadSha256,payloadSha256});
   }
   const envelope:TrustedSourceEnvelope={bindingRef:connection.bindingRef,verificationRef:'source-http:'+digest(Buffer.concat([Buffer.from(sourceId+'\n'+nonce+'\n'),response.bytes])),actorRef:parsed.actorRef,events,cursor:outputCursor};
   if(JSON.stringify(envelope).includes(connection.token))return fail('SOURCE_RESPONSE_INVALID');
   // Validate the complete signed batch before creating any payload files.
   for(const [sha,bytes]of payloads)this.save(bytes,sha);
   frozen(envelope);this.#verified.add(envelope);this.#sources.set(envelope,sourceId);return envelope;
  }catch(error){if(error instanceof SourcePollerError)throw error;return fail('SOURCE_POLL_FAILED');}
 }
 verified(sourceId:string,envelope:TrustedSourceEnvelope):boolean {return Boolean(envelope&&typeof envelope==='object'&&this.#verified.has(envelope)&&this.#sources.get(envelope)===sourceId&&this.#connections.has(sourceId));}
 getPayload(ref:string):string {return this.read(this.ref(ref)).toString('utf8');}
 purgeAllPayloads():number {
  this.directory();const names=readdirSync(this.#directory);if(names.length>10000||names.some(name=>!/^[a-f0-9]{64}\.payload$/.test(name)))return fail('SOURCE_PAYLOAD_REF_INVALID');return this.purgePayloads(names.map(name=>'payload:'+name.slice(0,64)));
 }
 purgePayloads(refs:string[]):number {
  if(!Array.isArray(refs)||refs.length>10000)return fail('SOURCE_PAYLOAD_REF_INVALID');const hashes=[...new Set(refs.map(ref=>this.ref(ref)))];let removed=0;
  for(const sha of hashes){this.directory();const path=join(this.#directory,sha+'.payload');if(!existsSync(path))continue;this.read(sha);try{unlinkSync(path);removed++;}catch{return fail('SOURCE_PAYLOAD_PURGE_FAILED');}}
  if(removed){const fd=openSync(this.#directory,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}}return removed;
 }
}
