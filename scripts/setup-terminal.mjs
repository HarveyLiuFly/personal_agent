import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,chmodSync} from 'node:fs';
import {dirname,join} from 'node:path';
if(process.platform!=='darwin'||process.arch!=='arm64'){console.log('User PTY platform is not verified; setup not applicable.');process.exit(0);}
const root=dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));if(JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version!=='1.1.0')throw Error('TERMINAL_BINDING_VERSION_MISMATCH');
const helper=join(root,'prebuilds/darwin-arm64/spawn-helper'),s=lstatSync(helper);if(!s.isFile()||s.isSymbolicLink()||createHash('sha256').update(readFileSync(helper)).digest('hex')!=='21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26')throw Error('TERMINAL_HELPER_CHANGED');
// The published 1.1.0 tarball contains this executable as mode 0644. Preserve its verified bytes.
chmodSync(helper,0o755);console.log('Verified node-pty 1.1.0 darwin-arm64 helper bytes; executable mode set to 0755.');
