import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,existsSync,rmSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifiedCodex} from '../packages/codex-adapter/src/binary.ts';
import {resolveVerifierNode} from '../packages/codex-adapter/src/launch.ts';
import {projectSkillConnection} from '../packages/runtime/src/skills-connection.ts';
import {ProjectSkillCatalog} from '../packages/runtime/src/skills.ts';
const root=resolve('.'),fixture=realpathSync(mkdtempSync('/private/tmp/personal-agent-project-skills-')),cwd=join(fixture,'project'),methods:string[]=[],effect=join(fixture,'MCP_OR_SKILL_EXECUTED');let connections=0;
const server=createServer((_req,res)=>{res.writeHead(405);res.end();});server.on('connection',()=>{connections++;});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as {port:number}).port;
let evidence:Record<string,unknown>;
try{
  mkdirSync(cwd,{mode:0o700});mkdirSync(join(cwd,'.agents/skills/public-project-skill'),{recursive:true});mkdirSync(join(cwd,'.agents/skills/broken-project-skill'),{recursive:true});
  writeFileSync(join(cwd,'.agents/skills/public-project-skill/SKILL.md'),'---\nname: public-project-skill\ndescription: Public discovery <img src=x onerror=alert(1)>\n---\nPRIVATE_BODY_MUST_NOT_APPEAR\nNever execute this public fixture body.\n');writeFileSync(join(cwd,'.agents/skills/broken-project-skill/SKILL.md'),'---\nname: broken\n---\nInvalid metadata fixture\n');
  execFileSync('git',['-c','core.hooksPath=/dev/null','-C',cwd,'init','--quiet'],{stdio:'ignore',env:{PATH:process.env.PATH,HOME:'/var/empty',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  const helper=join(fixture,'must-not-run.mjs');writeFileSync(helper,"import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],'unexpected execution');\n");
  const read=projectSkillConnection(verifiedCodex(root).executable,join(fixture,'queries'),{onMethod:method=>methods.push(method),prepare:({home})=>{
    writeFileSync(join(home,'config.toml'),`[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n[mcp_servers.public_fixture_process]\ncommand=${JSON.stringify(resolveVerifierNode(root))}\nargs=${JSON.stringify([helper,effect])}\n[mcp_servers.public_fixture_http]\nurl="http://127.0.0.1:${port}/mcp"\n`,{mode:0o600});
  }});
  const catalog=new ProjectSkillCatalog({workspace:id=>({id,name:'public project',directory:cwd}),read}),view=await catalog.list({projectId:'public-fixture'});
  const serialized=JSON.stringify(view),checks={expectedProjectSkill:view.skills.some(s=>s.name==='public-project-skill'),projectOnly:view.skills.every(s=>s.name==='public-project-skill'),bodyNotExported:!serialized.includes('PRIVATE_BODY_MUST_NOT_APPEAR'),pathsNotExported:!serialized.includes(fixture),scanErrorCount:view.scanErrors>=1,mcpHelperNotStarted:!existsSync(effect),configuredHttpMcpNoConnections:connections===0,onlyMetadataMethods:JSON.stringify(methods)===JSON.stringify(['initialize','skills/list']),privateQueryDirectoryCleaned:readdirSync(join(fixture,'queries')).length===0,sourceSkillPreserved:readFileSync(join(cwd,'.agents/skills/public-project-skill/SKILL.md'),'utf8')==='---\nname: public-project-skill\ndescription: Public discovery <img src=x onerror=alert(1)>\n---\nPRIVATE_BODY_MUST_NOT_APPEAR\nNever execute this public fixture body.\n'};
  evidence={status:Object.values(checks).every(Boolean)?'passed':'blocked',observedAt:new Date().toISOString(),kind:'locked_cli_isolated_project_skill_discovery',platform:process.platform+'-'+process.arch,cliVersion:verifiedCodex(root).lock.cliVersion,inferenceRequested:false,modelTurns:0,metadataMethods:methods,projectSkillCount:view.skills.length,scanErrors:view.scanErrors,configuredMcpConnections:connections,result:checks};
}catch(error){evidence={status:'blocked',observedAt:new Date().toISOString(),code:error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'SKILL_PROBE_FAILED',inferenceRequested:false,modelTurns:0};}
finally{await new Promise<void>(done=>server.close(()=>done()));rmSync(fixture,{recursive:true,force:true});}
const file=resolve(root,'docs/progress/evidence/M2.8a-native-skills.json');writeFileSync(file,JSON.stringify(evidence,null,2)+'\n');writeFileSync(file.replace('.json','-'+String(evidence.observedAt).replaceAll(':','-').replaceAll('.','-')+'.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));if(evidence.status!=='passed')process.exitCode=1;
