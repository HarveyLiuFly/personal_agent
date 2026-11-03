import {existsSync,lstatSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {LedgerError} from '../../store/src/ledger.ts';
/** Only app-owned, fixed Host roots. User source trees, credentials and external snapshots are excluded. */
export class LocalPrivacyCleanup {
 private root:string;private identity:string;private device:number;private inode:number;private database:string;private verification:string;
 constructor(input:{storageRoot:string;database:string;verification:string}){this.root=resolve(input.storageRoot);this.identity=realpathSync(this.root);const info=lstatSync(this.root);this.device=info.dev;this.inode=info.ino;this.database=resolve(input.database);this.verification=resolve(input.verification);if(info.isSymbolicLink()||!info.isDirectory()||this.identity!==this.root||!this.database.startsWith(this.root+'/')||!(this.verification===join(this.root,'verification')||new RegExp('^'+this.root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/runtimes/[a-f0-9]{64}$').test(this.verification)))this.fail();}
 private fail():never{throw new LedgerError('PRIVACY_CLEANUP_SCOPE_CHANGED');}
 private anchor(){const info=lstatSync(this.root);if(info.isSymbolicLink()||!info.isDirectory()||info.dev!==this.device||info.ino!==this.inode||realpathSync(this.root)!==this.identity)this.fail();}
 private check(path:string,depth=0):void{if(depth>12)this.fail();const info=lstatSync(path);if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())this.fail();if(realpathSync(path)!==path)this.fail();if(info.isDirectory()){const names=readdirSync(path);if(names.length>20000)this.fail();for(const name of names)this.check(join(path,name),depth+1);}}
 private remove(path:string){if(!existsSync(path))return;this.check(path);rmSync(path,{recursive:true,force:false});}
 purgeArtifacts(keys:string[]):{purgedKeys:string[]}{
  this.anchor();
  if(!Array.isArray(keys)||keys.some(k=>!/^[a-f0-9-]{36}\.json$/.test(k)))this.fail();const artifacts=join(this.verification,'artifacts');
  if(existsSync(artifacts)&&realpathSync(artifacts)!==artifacts)this.fail();for(const key of new Set(keys))this.remove(join(artifacts,key));return{purgedKeys:[...new Set(keys)]};
 }
 /** Conservatively discard app-owned historical copies before claiming physical cleanup. */
 purgeSnapshots():void{
  this.anchor();
  for(const name of ['backups','rehearsals']){
   const dir=join(this.root,name);if(!existsSync(dir))continue;if(realpathSync(dir)!==dir)this.fail();const names=readdirSync(dir);if(names.length>200)this.fail();
   if(names.some(n=>!/^[a-f0-9]{64}(\.pending)?$/.test(n)))this.fail();for(const child of names)this.remove(join(dir,child));
  }
  const runtimes=join(this.root,'runtimes');if(existsSync(runtimes)){
   if(realpathSync(runtimes)!==runtimes)this.fail();for(const child of readdirSync(runtimes)){
    if(!/^[a-f0-9]{64}(\.pending)?$/.test(child))continue;const path=join(runtimes,child);
    if(join(path,'ledger.db')===this.database){for(const suffix of ['','-wal','-shm'])this.remove(join(path,'current.db'+suffix));}
    else this.remove(path);
   }
  }
  const legacy=join(this.root,'execution/ledger.db');if(legacy!==this.database)for(const suffix of ['','-wal','-shm'])this.remove(legacy+suffix);
  this.remove(join(this.root,'codex-state'));
 }
}
