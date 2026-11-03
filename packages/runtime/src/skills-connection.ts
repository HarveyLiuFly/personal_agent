import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {StdioRpcClient,RpcFailure} from '../../codex-adapter/src/rpc.ts';
import {executionArguments} from './execution.ts';
import type {ReadPort} from '../../codex-adapter/src/history.ts';
/** Private metadata config only: never copy auth, load account connectors, or expose this factory over IPC. */
export function projectSkillConnection(executable:string,stateDirectory:string,options:{/** Trusted public native fixtures only. */prepare?:(paths:{home:string;userHome:string;root:string})=>void;onMethod?:(method:string)=>void}={}){
  mkdirSync(stateDirectory,{recursive:true,mode:0o700});
  return async<T>(read:(port:ReadPort)=>Promise<T>,signal?:AbortSignal):Promise<T>=>{
    const root=realpathSync(mkdtempSync(join(resolve(stateDirectory),'query-'))),home=join(root,'config'),userHome=join(root,'user-home');
    let rpc:StdioRpcClient|undefined;
    try{
      mkdirSync(home,{mode:0o700});mkdirSync(userHome,{mode:0o700});
      options.prepare?.({home,userHome,root});
      rpc=new StdioRpcClient({executable,args:executionArguments(join(root,'state')),env:{PATH:process.env.PATH,HOME:userHome,CODEX_HOME:home,LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8',TMPDIR:root},signal,requestTimeoutMs:10000,maximumFrameBytes:2*1024*1024});
      options.onMethod?.('initialize');await rpc.request('initialize',{clientInfo:{name:'personal_agent_project_skills',version:'0.1.0'},capabilities:{experimentalApi:false}});await rpc.notify('initialized');
      return await read({request:async<R>(method:string,params:unknown)=>{if(method!=='skills/list')throw new RpcFailure('SKILL_METHOD_NOT_ALLOWED');options.onMethod?.(method);return rpc!.request<R>(method,params);}});
    }finally{try{await rpc?.close();}finally{rmSync(root,{recursive:true,force:true});}}
  };
}
