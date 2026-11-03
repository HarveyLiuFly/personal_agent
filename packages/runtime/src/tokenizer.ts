import {createHash} from 'node:crypto';
import {Tiktoken} from 'js-tiktoken/lite';
import type {TiktokenBPE} from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import type {ContextCounter} from './context.ts';
export const O200K_RANKS_SHA256='de7eb511338b0e23589a3cae2dceb8dd66c2a9fd70dbf7ea778fd9df9f175d45';
export const O200K_COUNTER_FINGERPRINT='js-tiktoken@1.0.21:o200k_base:'+O200K_RANKS_SHA256;
export class TokenizerError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
function fail(code:string):never{throw new TokenizerError(code);}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Offline text BPE baseline, not a claim about a provider's current model or hidden framing tokens. */
export function verifiedO200kTokenizer(/** Trusted corruption tests only; never forwarded from IPC. */ranks:TiktokenBPE=o200kBase):{counter:ContextCounter;encode:(text:string)=>number[];decode:(tokens:number[])=>string;metadata:{implementation:string;encoding:string;ranksSha256:string;modelTokenizerVerified:false;hiddenProtocolOverheadIncluded:false}}{
 if(!ranks||typeof ranks!=='object'||typeof ranks.pat_str!=='string'||typeof ranks.bpe_ranks!=='string'||!ranks.special_tokens||typeof ranks.special_tokens!=='object'||digest(JSON.stringify(ranks))!==O200K_RANKS_SHA256)fail('TOKENIZER_RANKS_CHANGED');
 const encoder=new Tiktoken(ranks),specials=new Set(Object.values(ranks.special_tokens));
 const encode=(text:string)=>{if(typeof text!=='string'||text.length>2*1024*1024)fail('TOKENIZER_INPUT_INVALID');const result=encoder.encode(text,[],[]);if(result.some(t=>specials.has(t)))fail('TOKENIZER_SPECIAL_TOKEN_UNEXPECTED');return result;};
 const decode=(tokens:number[])=>{if(!Array.isArray(tokens)||tokens.length>2*1024*1024||tokens.some(t=>!Number.isSafeInteger(t)||t<0||t>=200000||specials.has(t)))fail('TOKENIZER_TOKEN_INVALID');return encoder.decode(tokens);};
 return{counter:{basis:'tokens',fingerprint:O200K_COUNTER_FINGERPRINT,count:text=>encode(text).length},encode,decode,metadata:{implementation:'js-tiktoken@1.0.21',encoding:'o200k_base',ranksSha256:O200K_RANKS_SHA256,modelTokenizerVerified:false,hiddenProtocolOverheadIncluded:false}};
}
