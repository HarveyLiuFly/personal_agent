// Prepares the user terminal's node-pty binding after `pnpm install`.
// - macOS arm64: verify the official prebuilt helper bytes and set its executable bit.
// - Linux x64/arm64: node-pty 1.1.0 ships no Linux prebuild, so pnpm compiles
//   build/Release/pty.node. Record its bytes (trust on first use) in .local/ so the
//   Host can detect a later rebuild or swap before loading it.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,lstatSync,chmodSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const platform=`${process.platform}-${process.arch}`;
const sha256=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
let root;
try{root=dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));}
catch{console.log('node-pty is not installed; terminal setup skipped.');process.exit(0);}
if(JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version!=='1.1.0')throw Error('TERMINAL_BINDING_VERSION_MISMATCH');

if(platform==='darwin-arm64'){
 const helper=join(root,'prebuilds/darwin-arm64/spawn-helper'),s=lstatSync(helper);
 if(!s.isFile()||s.isSymbolicLink()||sha256(helper)!=='21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26')throw Error('TERMINAL_HELPER_CHANGED');
 // The published 1.1.0 tarball contains this executable as mode 0644. Preserve its verified bytes.
 chmodSync(helper,0o755);console.log('Verified node-pty 1.1.0 darwin-arm64 helper bytes; executable mode set to 0755.');
 process.exit(0);
}

if(platform==='linux-x64'||platform==='linux-arm64'){
 const candidates=[join(root,'build/Release/pty.node'),join(root,'build/Debug/pty.node'),join(root,`prebuilds/${platform}/pty.node`)];
 const binding=candidates.find(path=>existsSync(path));
 if(!binding){
  console.warn('node-pty native binding was not built. Install build tools (python3, make, g++) and run: pnpm rebuild node-pty && pnpm setup:terminal');
  console.warn('The terminal panel stays disabled until then; everything else works.');
  process.exit(0);
 }
 const s=lstatSync(binding);if(!s.isFile()||s.isSymbolicLink())throw Error('TERMINAL_BINDING_CHANGED');
 const record={version:'1.1.0',platform:process.platform,arch:process.arch,binding:realpathSync(binding),bindingSha256:sha256(binding),nodeModulesAbi:process.versions.modules,recordedAt:new Date().toISOString()};
 mkdirSync(join(projectRoot,'.local'),{recursive:true,mode:0o700});
 writeFileSync(join(projectRoot,'.local/terminal-binding.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});
 console.log(`Recorded locally built node-pty 1.1.0 ${platform} binding (Node ABI ${record.nodeModulesAbi}).`);
 process.exit(0);
}

console.log(`User PTY platform ${platform} is not verified; setup not applicable.`);
