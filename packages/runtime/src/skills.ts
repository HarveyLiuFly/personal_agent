import {createHmac,randomBytes} from 'node:crypto';
import {LedgerError} from '../../store/src/ledger.ts';
import {projectSkillViews} from '../../codex-adapter/src/skills.ts';
import type {ReadPort} from '../../codex-adapter/src/history.ts';
import type {ProjectView} from '../../contracts/src/views.ts';
import type {ProjectSkillsView} from '../../contracts/src/skills.ts';
export interface ProjectSkillOptions {workspace:(id:string)=>ProjectView;read:<T>(read:(port:ReadPort)=>Promise<T>,signal?:AbortSignal)=>Promise<T>}
/** Project-only metadata discovery. Opaque IDs do not grant file access or enable skills/tools. */
export class ProjectSkillCatalog {
  private options:ProjectSkillOptions;private key=randomBytes(32);
  constructor(options:ProjectSkillOptions){this.options=options;}
  async list(input:unknown,signal?:AbortSignal):Promise<ProjectSkillsView>{
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'projectId')||!('projectId' in input)||typeof input.projectId!=='string'||!input.projectId||input.projectId.length>200||/[\x00-\x1f]/.test(input.projectId))throw new LedgerError('INVALID_SKILL_QUERY');
    const projectId=input.projectId,before=this.options.workspace(projectId);if(before.id!==projectId)throw new LedgerError('SKILL_PROJECT_SCOPE_MISMATCH');
    const raw=await this.options.read(port=>port.request<unknown>('skills/list',{cwds:[before.directory],forceReload:true}),signal),after=this.options.workspace(projectId);
    if(after.id!==projectId||after.directory!==before.directory)throw new LedgerError('PROJECT_IDENTITY_CHANGED');
    const projected=projectSkillViews(before.directory,raw,identity=>createHmac('sha256',this.key).update(JSON.stringify([projectId,identity])).digest('hex'));
    return{projectId,observedAt:Date.now(),...projected,source:'locked_cli_isolated_project_discovery',executionCapabilities:{mcp:'not_enabled',plugins:'not_enabled',subAgents:'not_enabled',basis:'application_execution_profile'}};
  }
}
