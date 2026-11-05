// Trusted, fixed-purpose process. Never import or execute project JavaScript or Git helpers.
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,readFileSync,readdirSync,realpathSync,existsSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve,relative,sep} from 'node:path';
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity=info=>[String(info.dev),String(info.ino),String(info.mode),String(info.size),String(info.mtimeNs)].join(':');
const fail=code=>{throw new Error(code);};
const protectedNames=new Set(['.git','.codex','.agents','.aws','.ssh','.kube','.local','.npmrc','.netrc','.pypirc','credentials.json','auth.json']);
const protectedName=value=>{const name=value.toLowerCase();return protectedNames.has(name)||name==='.env'||name.startsWith('.env.')||/\.(pem|key|p12|pfx)$/.test(name);};
const safePath=value=>typeof value==='string'&&value.length<=1000&&!/[\x00-\x1f\\]/.test(value)&&value!==''&&value.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!protectedName(p))&&!value.startsWith('/');
const utf8=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
let input;
function checkedPath(path,expected,directory=false){
 if(path!==''&&!safePath(path))fail('WORKSPACE_PATH_BLOCKED');
 const full=path?join(input.directory,...path.split('/')):input.directory;
 let current=input.directory;
 for(const part of path.split('/').filter(Boolean)){current=join(current,part);const info=lstatSync(current,{bigint:true});if(info.isSymbolicLink())fail('WORKSPACE_SYMLINK_BLOCKED');}
 if(realpathSync(full)!==full||relative(input.directory,full).startsWith('..'+sep))fail('WORKSPACE_PATH_BLOCKED');
 const info=lstatSync(full,{bigint:true});if(expected&&identity(info)!==expected)fail('WORKSPACE_ENTRY_CHANGED');
 if(directory&&!info.isDirectory())fail('WORKSPACE_DIRECTORY_REQUIRED');return{full,info};
}
function rootIdentity(){if(realpathSync(process.cwd())!==input.directory||identity(lstatSync(input.directory,{bigint:true}))!==input.rootIdentity)fail('WORKSPACE_IDENTITY_CHANGED');}
function list(){
 const {full,info}=checkedPath(input.path,input.identity,true),names=readdirSync(full,{encoding:'buffer'});if(names.length>10000)fail('WORKSPACE_DIRECTORY_TOO_LARGE');
 const entries=[];let unsupported=0;
 for(const raw of names){let name;try{name=utf8(raw);}catch{unsupported++;continue;}
  if(/[\x00-\x1f\\]/.test(name)){unsupported++;continue;}
  const path=input.path?input.path+'/'+name:name;
  if(protectedName(name)){entries.push({name,path,kind:'blocked',size:0,identity:'',reason:'PROTECTED_OR_SPECIAL'});continue;}
  const stat=lstatSync(join(full,name),{bigint:true}),blocked=stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile());
  entries.push({name,path,kind:blocked?'blocked':stat.isDirectory()?'directory':'file',size:Number(stat.size),identity:identity(stat),...(blocked?{reason:stat.isSymbolicLink()?'SYMLINK':'PROTECTED_OR_SPECIAL'}:{})});
 }
 entries.sort((a,b)=>Number(b.kind==='directory')-Number(a.kind==='directory')||a.name.localeCompare(b.name));
 if(identity(lstatSync(full,{bigint:true}))!==identity(info))fail('WORKSPACE_ENTRY_CHANGED');
 return{entries:entries.slice(0,200),truncated:entries.length>200||unsupported>0};
}
function preview(){
 const {full,info}=checkedPath(input.path,input.identity);if(!info.isFile())fail('WORKSPACE_FILE_REQUIRED');
 if(info.size>131072n)return{kind:'tooLarge',text:'',bytes:Number(info.size),contentHash:null};
 const fd=openSync(full,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  if(identity(fstatSync(fd,{bigint:true}))!==input.identity)fail('WORKSPACE_ENTRY_CHANGED');
  const buffer=Buffer.alloc(131073);let count=0;
  while(count<buffer.length){const size=readSync(fd,buffer,count,buffer.length-count,null);if(!size)break;count+=size;}
  if(count>131072||identity(fstatSync(fd,{bigint:true}))!==input.identity)fail('WORKSPACE_ENTRY_CHANGED');
  const bytes=buffer.subarray(0,count);
  checkedPath(input.path,input.identity);let text;
  try{if(bytes.includes(0))throw new Error();text=utf8(bytes);if(/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw new Error();}catch{return{kind:'binary',text:'',bytes:bytes.length,contentHash:null};}
  return{kind:'text',text,bytes:bytes.length,contentHash:hash(bytes)};
 }finally{closeSync(fd);}
}
const gitBase=['--no-pager','--no-optional-locks','--no-replace-objects','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','core.untrackedCache=false','-c','maintenance.auto=false','-c','gc.auto=0','-c','color.ui=false','-C'];
// Linux: Codex's no-network seccomp filter rejects the socketpair Node uses for piped child stdio,
// so git output goes through a private file in the sandbox scratch directory instead.
let captures=0;
function runGit(args){
 const argv=[...gitBase,input.directory,...args],options={env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_ATTR_NOSYSTEM:'1'},timeout:5000,maxBuffer:262144};
 if(process.platform!=='linux')return execFileSync(input.git,argv,{...options,stdio:['ignore','pipe','ignore']});
 const file=join(process.env.TMPDIR,`git-output-${process.pid}-${captures++}`);
 const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{
  execFileSync(input.git,argv,{...options,stdio:['ignore',fd,'ignore']});
  if(fstatSync(fd).size>options.maxBuffer)throw Object.assign(new Error('ENOBUFS'),{code:'ENOBUFS'});
  return readFileSync(file);
 }finally{closeSync(fd);rmSync(file,{force:true});}
}
function git(args,optional=false){
 try{return runGit(args);}
 catch(error){if(optional&&error.status===1)return Buffer.alloc(0);if(error.code==='ENOBUFS')fail('WORKSPACE_DIFF_TOO_LARGE');fail('WORKSPACE_GIT_UNAVAILABLE');}
}
function repository(){
 const metadata=join(input.directory,'.git');if(!existsSync(metadata))fail('LOCAL_GIT_DIRECTORY_REQUIRED');
 const info=lstatSync(metadata);if(info.isSymbolicLink())fail('LINKED_GIT_DIRECTORY_UNSUPPORTED');
 if(!info.isDirectory()){
  const m=input.managedGit;if(!m||!info.isFile()||info.size>4096||readFileSync(metadata,'utf8')!==`gitdir: ${m.gitDir}\n`)fail('LINKED_GIT_DIRECTORY_UNSUPPORTED');
  for(const [path,expected] of [[m.gitDir,m.gitIdentity],[m.commonDir,m.commonIdentity]]){const s=lstatSync(path,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(path)!==path||String(s.dev)!==expected.device||String(s.ino)!==expected.inode)fail('WORKSPACE_GIT_CHANGED');}
  if(realpathSync(resolve(m.gitDir,readFileSync(join(m.gitDir,'commondir'),'utf8').trim()))!==m.commonDir)fail('WORKSPACE_GIT_CHANGED');
 }
 indexInfo();
 if(existsSync(join(input.directory,'.gitmodules')))fail('SUBMODULES_UNSUPPORTED');
 const filters=git(['config','--includes','--name-only','--get-regexp','^filter\\.'],true);if(filters.length)fail('GIT_FILTERS_UNSUPPORTED');
 if(utf8(git(['rev-parse','--show-toplevel'])).trim()!==input.directory)fail('GIT_ROOT_MISMATCH');
 if(/(?:^|\0)160000 /.test(utf8(git(['ls-files','--stage','-z']))))fail('SUBMODULES_UNSUPPORTED');
}
function indexInfo(){
 const path=input.managedGit?join(input.managedGit.gitDir,'index'):join(input.directory,'.git/index');if(!existsSync(path))return null;
 const info=lstatSync(path,{bigint:true});if(!info.isFile()||info.isSymbolicLink())fail('GIT_INDEX_UNSUPPORTED');
 if(info.size>16777216n)fail('WORKSPACE_GIT_TOO_LARGE');return{path,info};
}
function indexHash(){
 const index=indexInfo();if(!index)return null;
 const fd=openSync(index.path,constants.O_RDONLY|constants.O_NOFOLLOW),digest=createHash('sha256'),buffer=Buffer.alloc(65536);let count=0;
 try{
  if(identity(fstatSync(fd,{bigint:true}))!==identity(index.info))fail('WORKSPACE_GIT_CHANGED');
  while(true){const size=readSync(fd,buffer,0,buffer.length,null);if(!size)break;count+=size;if(count>16777216)fail('WORKSPACE_GIT_TOO_LARGE');digest.update(buffer.subarray(0,size));}
  if(identity(fstatSync(fd,{bigint:true}))!==identity(index.info)||identity(lstatSync(index.path,{bigint:true}))!==identity(index.info))fail('WORKSPACE_GIT_CHANGED');return digest.digest('hex');
 }finally{closeSync(fd);}
}
function gitState(){
 repository();const buffer=git(['status','--porcelain=v2','--branch','-z','--untracked-files=all','--ignore-submodules=all']);
 const records=utf8(buffer).split('\0');let branch=null,head=null;const changes=[];
 for(let n=0;n<records.length;n++){
  const record=records[n];if(!record)continue;
  if(record.startsWith('# branch.head ')){branch=record.slice(14);continue;}
  if(record.startsWith('# branch.oid ')){const value=record.slice(13);head=/^[a-f0-9]{40,64}$/.test(value)?value:null;continue;}
  if(record.startsWith('# '))continue;
  const type=record[0];let path,previousPath,xy;
  if(type==='?'){path=record.slice(2);xy='??';}
  else if(type==='1'||type==='2'||type==='u'){
   const count=type==='1'?8:type==='2'?9:10,fields=record.split(' ');if(fields.length<=count)fail('INVALID_GIT_STATUS');xy=fields[1];path=fields.slice(count).join(' ');if(type==='2')previousPath=records[++n];
  }else fail('INVALID_GIT_STATUS');
  if(typeof xy!=='string'||xy.length!==2||!path||path.length>1000||/[\x00-\x1f\\]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||path.startsWith('/'))fail('UNSUPPORTED_GIT_PATH');
  if(previousPath&&(!safePath(previousPath)||previousPath.length>1000))fail('UNSUPPORTED_GIT_PATH');
  let blocked=!safePath(path),fileIdentity=null;
  if(!blocked){try{fileIdentity=identity(checkedPath(path).info);}catch(error){if(error.code!=='ENOENT')blocked=true;}}
  changes.push({path,...(previousPath?{previousPath}:{}),staged:xy[0],unstaged:xy[1],untracked:type==='?',conflict:type==='u',fileIdentity,...(blocked?{reason:'PROTECTED_OR_SPECIAL'}:{})});
  if(changes.length>500)fail('WORKSPACE_GIT_TOO_LARGE');
 }
 return{branch,head,changes,token:hash(JSON.stringify([hash(buffer),indexHash(),head]))};
}
function diff(){
 if(!safePath(input.path)||!['staged','unstaged'].includes(input.part))fail('WORKSPACE_PATH_BLOCKED');
 const before=gitState();if(before.token!==input.gitToken)fail('WORKSPACE_GIT_CHANGED');
 const change=before.changes.find(c=>c.path===input.path);if(!change||change.reason||change.untracked)fail('WORKSPACE_DIFF_UNAVAILABLE');
 if(change.fileIdentity!==input.identity)fail('WORKSPACE_ENTRY_CHANGED');
 const paths=[input.path,...(change.previousPath?[change.previousPath]:[])];
 const text=utf8(git(['diff',...(input.part==='staged'?['--cached']:[]),'--no-ext-diff','--no-textconv','--no-color','--no-renames','--unified=3','--',...paths]));
 const after=gitState();if(before.token!==after.token||after.changes.find(c=>c.path===input.path)?.fileIdentity!==input.identity)fail('WORKSPACE_GIT_CHANGED');return{text};
}
try{
 const raw=readFileSync(0);if(raw.length>10000)fail('INVALID_WORKSPACE_READ');input=JSON.parse(utf8(raw));rootIdentity();
 let data;
 if(input.operation==='overview'){data={directory:list()};try{data.git={available:true,...gitState()};}catch(error){data.git={available:false,reason:/^[A-Z_]+$/.test(error.message)?error.message:'WORKSPACE_GIT_UNAVAILABLE',branch:null,head:null,changes:[]};}}
 else if(input.operation==='list')data=list();else if(input.operation==='preview')data=preview();else if(input.operation==='diff')data=diff();else fail('INVALID_WORKSPACE_READ');
 rootIdentity();process.stdout.write(JSON.stringify({ok:true,data})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.message)?error.message:'WORKSPACE_READ_FAILED'})+'\n');process.exitCode=1;}
