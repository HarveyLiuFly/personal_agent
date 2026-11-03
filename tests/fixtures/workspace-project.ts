import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
export function createWorkspaceFixture(cwd:string,git:string):void{
 mkdirSync(join(cwd,'src'),{recursive:true});writeFileSync(join(cwd,'README.md'),'# Controlled workspace\nPublic fixture only.\n');writeFileSync(join(cwd,'src/math.txt'),'baseline\n');writeFileSync(join(cwd,'src/html.txt'),'<img src=x onerror="window.__workspaceInjected=true">\n');
 const run=(args:string[])=>execFileSync(git,['-c','core.hooksPath=/dev/null','-C',cwd,...args],{stdio:'ignore'});
 run(['init','--quiet']);run(['add','.']);run(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','--no-gpg-sign','-m','controlled workspace baseline']);
 writeFileSync(join(cwd,'src/math.txt'),'staged fixture\n');run(['add','src/math.txt']);writeFileSync(join(cwd,'src/math.txt'),'unstaged fixture\n');writeFileSync(join(cwd,'new file.txt'),'untracked public fixture\n');writeFileSync(join(cwd,'.env'),'SYNTHETIC_PRIVATE_FIXTURE=not-real\n');
}
