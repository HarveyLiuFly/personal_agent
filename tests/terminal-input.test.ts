import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TerminalInputQueue} from '../apps/desktop/renderer/terminal-input.ts';
import type {TerminalInputReceipt,WriteTerminal} from '../packages/contracts/src/terminal.ts';
const accepted=(q:WriteTerminal):TerminalInputReceipt=>({sequence:q.sequence,state:'accepted'});
test('queued terminal paste never crosses a session change, including its unsent remaining chunks',async()=>{
 const calls:WriteTerminal[]=[];let release!:(r:TerminalInputReceipt)=>void,unknown=0;const queue=new TerminalInputQueue(async q=>{calls.push(q);if(q.sessionId==='old')return new Promise(resolve=>{release=resolve;});return accepted(q);},()=>unknown++,()=>{});queue.bind('project','old',0,true);const first=queue.submit('old','x'.repeat(9000));await new Promise(done=>setTimeout(done,0));assert.equal(calls.length,1);queue.bind('project','new',7,true);await queue.submit('old','stale keyboard event');await queue.submit('new','new command');release(accepted(calls[0]!));await first;assert.deepEqual(calls.map(q=>({session:q.sessionId,sequence:q.sequence,length:q.text.length})),[{session:'old',sequence:1,length:4096},{session:'new',sequence:8,length:11}]);assert.equal(unknown,0);
});
test('a late failure from an old session does not block the new session; a current unknown never retries',async()=>{
 let rejectOld!:(e:Error)=>void,unknown=0;const calls:WriteTerminal[]=[];const queue=new TerminalInputQueue(async q=>{calls.push(q);if(q.sessionId==='old')return new Promise((_,reject)=>{rejectOld=reject;});return{sequence:q.sequence,state:'outcome_unknown'};},()=>unknown++,()=>{});queue.bind('p','old',0,true);const old=queue.submit('old','old');await new Promise(done=>setTimeout(done,0));queue.bind('p','new',0,true);rejectOld(Error('lost old response'));await old;assert.equal(queue.writable('new'),true);assert.equal(unknown,0);await queue.submit('new','once');await queue.submit('new','not resent');assert.equal(unknown,1);assert.equal(queue.writable('new'),false);assert.deepEqual(calls.map(q=>q.text),['old','once']);
});
test('terminal queue rejects oversized paste, preserves Unicode chunks and saved sequence high water',async()=>{
 let tooLarge=0;const calls:WriteTerminal[]=[];const queue=new TerminalInputQueue(async q=>{calls.push(q);return accepted(q);},()=>{},()=>tooLarge++);queue.bind('p','s',20,true);await queue.submit('s','x'.repeat(65537));assert.equal(tooLarge,1);assert.equal(calls.length,0);const text='中😸'.repeat(3000);await queue.submit('s',text);assert.equal(calls.map(c=>c.text).join(''),text);assert.ok(calls.every(c=>Buffer.byteLength(c.text)<=16384));queue.bind('p','s',1,true);await queue.submit('s','next');assert.equal(calls.at(-1)!.sequence,20+calls.length);
});
test('disposing the view drops unsent keyboard events without forwarding them after recreation',async()=>{
 const calls:WriteTerminal[]=[];const queue=new TerminalInputQueue(async q=>{calls.push(q);return accepted(q);},()=>{},()=>{});queue.bind('p','old',0,true);const pending=queue.submit('old','never sent');queue.dispose();queue.bind('p','new',0,true);await pending;assert.equal(calls.length,0);
});
