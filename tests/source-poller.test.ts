import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createHash,createHmac} from 'node:crypto';
import {mkdtempSync,realpathSync,readFileSync,readdirSync,rmSync,writeFileSync,statSync,symlinkSync,mkdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AuthenticatedSourcePoller,SourcePollerError} from '../packages/runtime/src/source-poller.ts';

// An actual self-owned loopback HTTP Provider with public test-only token.
// These tests do not authenticate a third-party service or run a model.
const token='PUBLIC_TEST_ONLY_BEARER_TOKEN_32',sourceId='public-source',bindingRef='public-binding',actorRef='public-actor';
const hash=(s:string)=>createHash('sha256').update(Buffer.from(s,'utf8')).digest('hex');
const event=(id='event-1',payload='Public 中文🙂 body')=>({id,threadRef:'public-thread',eventType:'issue.changed',occurredAtMs:Date.now(),payload});
const body=(events:unknown[]=[event()])=>({sourceId,bindingRef,actorRef,events,cursor:{after:'event-1'}});
const code=(expected:string)=>(error:unknown)=>error instanceof SourcePollerError&&error.code===expected&&error.message===expected&&!JSON.stringify(error).includes(token);
type RequestBody={sourceId:string;bindingRef:string;cursor:unknown;nonce:string};
type Handler=(request:IncomingMessage,response:ServerResponse,input:RequestBody)=>void;
async function fixture(t:{after(fn:()=>void|Promise<void>):void},options:{timeout?:number}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-source-poller-'))),directory=join(root,'payloads'),requests:Array<{method:string;authorization:string;nonce:string;input:RequestBody}>=[];
 const signed=(response:ServerResponse,input:RequestBody,value:unknown)=>{const raw=Buffer.from(JSON.stringify(value),'utf8');response.writeHead(200,{'content-type':'application/json','x-source-signature':createHmac('sha256',token).update(input.nonce+'\n').update(raw).digest('hex')});response.end(raw);};
 let handler:Handler=(_request,response,input)=>signed(response,input,body());
 const server=createServer((request,response)=>{const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(Buffer.from(chunk)));request.on('end',()=>{const input=JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody;requests.push({method:request.method!,authorization:String(request.headers.authorization),nonce:String(request.headers['x-source-nonce']),input});if(request.headers.authorization!=='Bearer '+token){response.writeHead(401);response.end();return;}handler(request,response,input);});});
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(root,{recursive:true,force:true});});
 await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});const address=server.address();assert.ok(address&&typeof address==='object');const url='http://127.0.0.1:'+address.port+'/public-poll';
 const config={connections:[{sourceId,bindingRef,url,token}],directory,allowLoopbackHttpForTests:true,...(options.timeout?{timeoutMsForTests:options.timeout}:{})},poller=new AuthenticatedSourcePoller(config);
 return{root,directory,url,config,poller,requests,signed,setHandler(next:Handler){handler=next;}};
}
test('real authenticated HTTP polling signs each request nonce and returns frozen identity-certified metadata plus exact UTF8 payloads',async t=>{
 const f=await fixture(t),payload='Public 中文🙂 body',envelope=await f.poller.poll(sourceId,{after:'public-before'}),sha=hash(payload);
 assert.equal(f.requests[0]!.method,'POST');assert.equal(f.requests[0]!.authorization,'Bearer '+token);assert.equal(f.requests[0]!.input.sourceId,sourceId);assert.equal(f.requests[0]!.input.bindingRef,bindingRef);assert.deepEqual(f.requests[0]!.input.cursor,{after:'public-before'});assert.match(f.requests[0]!.nonce,/^[a-f0-9]{64}$/);assert.equal(f.requests[0]!.nonce,f.requests[0]!.input.nonce);
 assert.equal(envelope.bindingRef,bindingRef);assert.equal(envelope.actorRef,actorRef);assert.equal(envelope.events[0]!.payloadRef,'payload:'+sha);assert.equal(envelope.events[0]!.payloadSha256,sha);assert.equal(f.poller.getPayload('payload:'+sha),payload);assert.equal(statSync(join(f.directory,sha+'.payload')).mode&0o777,0o600);assert.equal(statSync(f.directory).mode&0o777,0o700);
 assert.equal(f.poller.verified(sourceId,envelope),true);assert.equal(f.poller.verified('other',envelope),false);assert.equal(f.poller.verified(sourceId,{...envelope}),false);assert.equal(f.poller.verified(sourceId,JSON.parse(JSON.stringify(envelope))),false);assert.equal(new AuthenticatedSourcePoller(f.config).verified(sourceId,envelope),false);assert.ok(Object.isFrozen(envelope)&&Object.isFrozen(envelope.events)&&Object.isFrozen(envelope.events[0])&&Object.isFrozen(envelope.cursor));assert.throws(()=>{envelope.events[0]!.id='forged';},TypeError);
 assert.equal(JSON.stringify(envelope).includes(token),false);assert.equal(JSON.stringify(envelope).includes(payload),false);assert.equal(JSON.stringify(f.poller).includes(token),false);assert.equal(JSON.stringify(envelope).includes(f.root),false);
});
test('wrong MAC and self-declared verification are rejected before any payload is saved',async t=>{
 const f=await fixture(t),wrongToken=new AuthenticatedSourcePoller({...f.config,connections:[{sourceId,bindingRef,url:f.url,token:'PUBLIC_WRONG_TEST_ONLY_BEARER_TOKEN'}]});await assert.rejects(wrongToken.poll(sourceId,null),code('SOURCE_HTTP_REJECTED'));assert.deepEqual(readdirSync(f.directory),[]);
 f.setHandler((_q,r)=>{r.writeHead(200,{'x-source-signature':'0'.repeat(64)});r.end(JSON.stringify({...body(),verified:true}));});await assert.rejects(f.poller.poll(sourceId,null),code('SOURCE_SIGNATURE_INVALID'));assert.deepEqual(readdirSync(f.directory),[]);
 f.setHandler((_q,r,input)=>f.signed(r,input,{...body(),verified:true}));await assert.rejects(f.poller.poll(sourceId,null),code('SOURCE_RESPONSE_INVALID'));assert.deepEqual(readdirSync(f.directory),[]);
});
test('a captured valid response cannot be replayed for a new random nonce',async t=>{
 const f=await fixture(t);let captured:Buffer|undefined,signature:string|undefined;
 f.setHandler((_q,r,input)=>{captured??=Buffer.from(JSON.stringify(body()),'utf8');signature??=createHmac('sha256',token).update(input.nonce+'\n').update(captured).digest('hex');r.writeHead(200,{'x-source-signature':signature});r.end(captured);});
 const first=await f.poller.poll(sourceId,null);await assert.rejects(f.poller.poll(sourceId,first.cursor),code('SOURCE_SIGNATURE_INVALID'));assert.notEqual(f.requests[0]!.nonce,f.requests[1]!.nonce);assert.equal(readdirSync(f.directory).length,1);
});
test('signed source/binding mismatches, malformed actors and unknown response fields never receive identity certification',async t=>{
 const f=await fixture(t);for(const value of [{...body(),sourceId:'foreign'},{...body(),bindingRef:'foreign'},{...body(),actorRef:3},{...body(),url:'http://foreign'},null,[],{...body(),cursor:undefined}]){f.setHandler((_q,r,input)=>f.signed(r,input,value));await assert.rejects(f.poller.poll(sourceId,{}),code('SOURCE_RESPONSE_INVALID'));}assert.deepEqual(readdirSync(f.directory),[]);
});
test('redirects are rejected without a second request or leaking authorization to a new target',async t=>{
 const f=await fixture(t);f.setHandler((_q,r)=>{r.writeHead(302,{location:f.url+'/redirected'});r.end();});await assert.rejects(f.poller.poll(sourceId,null),code('SOURCE_REDIRECT_REJECTED'));assert.equal(f.requests.length,1);assert.deepEqual(readdirSync(f.directory),[]);
});
test('advertised and chunked oversized responses are stopped with fixed errors and no partial payload files',async t=>{
 const f=await fixture(t);f.setHandler((_q,r)=>{r.writeHead(200,{'content-length':3*1024*1024,'x-source-signature':'0'.repeat(64)});r.end();});await assert.rejects(f.poller.poll(sourceId,null),code('SOURCE_RESPONSE_TOO_LARGE'));
 f.setHandler((_q,r)=>{r.writeHead(200,{'x-source-signature':'0'.repeat(64)});for(let i=0;i<35;i++)r.write(Buffer.alloc(65536,97));r.end();});await assert.rejects(f.poller.poll(sourceId,null),code('SOURCE_RESPONSE_TOO_LARGE'));assert.deepEqual(readdirSync(f.directory),[]);
});
test('a stalled real Provider times out without retaining half files or returning private transport diagnostics',async t=>{
 const f=await fixture(t,{timeout:50});f.setHandler(()=>{});await assert.rejects(f.poller.poll(sourceId,null),code('SOURCE_POLL_TIMEOUT'));assert.deepEqual(readdirSync(f.directory),[]);
});
test('duplicate IDs, event-count and per-payload limits reject the entire signed batch before filesystem writes',async t=>{
 const f=await fixture(t);for(const [events,error]of [[[event('same'),event('same')],'SOURCE_DUPLICATE_EVENT'],[Array.from({length:101},(_,i)=>event('public-'+i,'')),'SOURCE_RESPONSE_INVALID'],[[event('okay'),event('large','x'.repeat(65537))],'SOURCE_RESPONSE_INVALID'],[[event('wrong','\ud800')],'SOURCE_RESPONSE_INVALID'],[[{...event(),body:'unexpected'}],'SOURCE_RESPONSE_INVALID']] as const){f.setHandler((_q,r,input)=>f.signed(r,input,body([...events])));await assert.rejects(f.poller.poll(sourceId,null),code(error));assert.deepEqual(readdirSync(f.directory),[]);}
});
test('immutable payload files are reused by hash, revalidated, and never overwritten after tampering',async t=>{
 const f=await fixture(t),first=await f.poller.poll(sourceId,null),ref=first.events[0]!.payloadRef,sha=first.events[0]!.payloadSha256,file=join(f.directory,sha+'.payload'),before=statSync(file).ino;await f.poller.poll(sourceId,null);assert.equal(statSync(file).ino,before);assert.equal(readdirSync(f.directory).length,1);
 writeFileSync(file,'PUBLIC_TAMPER');assert.throws(()=>f.poller.getPayload(ref),code('SOURCE_PAYLOAD_INVALID'));await assert.rejects(f.poller.poll(sourceId,null),code('SOURCE_PAYLOAD_INVALID'));assert.equal(readFileSync(file,'utf8'),'PUBLIC_TAMPER');assert.equal(readdirSync(f.directory).some(name=>name.startsWith('.staging-')),false);
});
test('payload reads and deletion are confined to regular controlled hash files',async t=>{
 const f=await fixture(t),envelope=await f.poller.poll(sourceId,null),ref=envelope.events[0]!.payloadRef,sha=envelope.events[0]!.payloadSha256,outside=join(f.root,'public-outside.txt');writeFileSync(outside,'PUBLIC_OUTSIDE_UNCHANGED');
 for(const invalid of ['../public-outside.txt','payload:../public-outside.txt','payload:'+sha.toUpperCase(),'payload:'+'a'.repeat(63)]){assert.throws(()=>f.poller.getPayload(invalid),code('SOURCE_PAYLOAD_REF_INVALID'));assert.throws(()=>f.poller.purgePayloads([ref,invalid]),code('SOURCE_PAYLOAD_REF_INVALID'));}assert.equal(f.poller.getPayload(ref),'Public 中文🙂 body');
 assert.equal(f.poller.purgePayloads([ref,ref]),1);assert.equal(f.poller.purgePayloads([ref]),0);symlinkSync(outside,join(f.directory,sha+'.payload'));assert.throws(()=>f.poller.getPayload(ref),code('SOURCE_PAYLOAD_INVALID'));assert.throws(()=>f.poller.purgePayloads([ref]),code('SOURCE_PAYLOAD_INVALID'));assert.equal(readFileSync(outside,'utf8'),'PUBLIC_OUTSIDE_UNCHANGED');
});
test('source registration, secure URL policy, test controls and cursor bounds are checked before network access',async t=>{
 const f=await fixture(t);await assert.rejects(f.poller.poll('unknown',null),code('SOURCE_NOT_REGISTERED'));
 for(const cursor of [undefined,'x'.repeat(8193),{after:undefined},new Date(),Array.from({length:101},()=>1)])await assert.rejects(f.poller.poll(sourceId,cursor),code('SOURCE_CURSOR_INVALID'));const circular:Record<string,unknown>={};circular.self=circular;await assert.rejects(f.poller.poll(sourceId,circular),code('SOURCE_CURSOR_INVALID'));assert.equal(f.requests.length,0);
 for(const url of ['http://example.com/poll','http://localhost:1234/poll','file:///private/path','https://user:secret@example.com/poll','https://example.com/poll#fragment'])assert.throws(()=>new AuthenticatedSourcePoller({...f.config,connections:[{sourceId,bindingRef,url,token}]}),code('SOURCE_URL_REJECTED'));
 assert.throws(()=>new AuthenticatedSourcePoller({...f.config,allowLoopbackHttpForTests:false}),code('SOURCE_URL_REJECTED'));assert.throws(()=>new AuthenticatedSourcePoller({...f.config,connections:[...f.config.connections,...f.config.connections]}),code('SOURCE_CONFIGURATION_INVALID'));
});
test('a changed payload directory and token-bearing response cannot produce a trusted envelope',async t=>{
 const f=await fixture(t);f.setHandler((_q,r,input)=>f.signed(r,input,body([event('leak',token)])));await assert.rejects(f.poller.poll(sourceId,null),code('SOURCE_RESPONSE_INVALID'));assert.deepEqual(readdirSync(f.directory),[]);
 f.setHandler((_q,r,input)=>f.signed(r,input,body()));renameSync(f.directory,f.directory+'-old');mkdirSync(f.directory,{mode:0o700});await assert.rejects(f.poller.poll(sourceId,null),code('SOURCE_DIRECTORY_CHANGED'));assert.deepEqual(readdirSync(f.directory),[]);
});
