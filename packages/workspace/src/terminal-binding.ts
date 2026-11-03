import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {LedgerError} from '../../store/src/ledger.ts';
/** Official npm 1.1.0 bytes, independently verified against registry SHA-512. */
export const terminalBindingBaseline={version:'1.1.0',platform:'darwin',arch:'arm64',helperSha256:'21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26',bindingSha256:'e6457d66f45af3facd02920a5b212164e80fe0bb758afe6e6eab1eceeba3fc9a'} as const;
export function terminalBinding():string {
 if(process.platform!==terminalBindingBaseline.platform||process.arch!==terminalBindingBaseline.arch)throw new LedgerError('TERMINAL_PLATFORM_NOT_VERIFIED');
 const require=createRequire(import.meta.url),packageFile=require.resolve('node-pty/package.json'),root=dirname(packageFile);if(JSON.parse(readFileSync(packageFile,'utf8')).version!==terminalBindingBaseline.version)throw new LedgerError('TERMINAL_BINDING_VERSION_MISMATCH');
 for(const [name,expected]of [['spawn-helper',terminalBindingBaseline.helperSha256],['pty.node',terminalBindingBaseline.bindingSha256]]){const path=join(root,'prebuilds/darwin-arm64',name!),s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||createHash('sha256').update(readFileSync(path)).digest('hex')!==expected)throw new LedgerError('TERMINAL_BINDING_CHANGED');if(name==='spawn-helper'&&!(s.mode&0o111))throw new LedgerError('TERMINAL_HELPER_SETUP_REQUIRED');}
 return realpathSync(require.resolve('node-pty'));
}
