import type { App, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { evidenceDir } from './evidence.ts';
export function createProjectSkillsFixture(cwd: string) {
  mkdirSync(join(cwd, '.agents/skills/public-project-skill'), { recursive: true });
  mkdirSync(join(cwd, '.agents/skills/broken'), { recursive: true });
  writeFileSync(
    join(cwd, '.agents/skills/public-project-skill/SKILL.md'),
    '---\nname: public-project-skill\ndescription: Public preview <img src=x onerror=alert(1)>\n---\nSKILL_BODY_MUST_STAY_LOCAL\n',
  );
  writeFileSync(
    join(cwd, '.agents/skills/broken/SKILL.md'),
    '---\nname: broken\n---\nInvalid metadata fixture\n',
  );
}
/** Real locked CLI discovery; only the history navigation metadata is a synthetic fixture. */
export async function runSkillsProbe(
  root: string,
  app: App,
  window: BrowserWindow,
  database: string,
  source: string,
  methods: string[],
) {
  const result = await window.webContents.executeJavaScript(`(async()=>{
    const call=async p=>{const r=await p;if(!r.ok)throw Error(r.errorCode);return r.value;},wait=async f=>{const until=Date.now()+20000;while(!f()){if(Date.now()>until)throw Error('SKILLS_UI_TIMEOUT');await new Promise(r=>setTimeout(r,30));}},click=async s=>{await wait(()=>document.querySelector(s)&&!document.querySelector(s).disabled);document.querySelector(s).click();};
    await click('[data-action="choose-project"]');await wait(()=>document.querySelector('[data-task-draft]'));const draft=document.querySelector('[data-task-draft]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(draft,'PUBLIC_UNSENT_DRAFT_KEPT');draft.dispatchEvent(new Event('input',{bubbles:true}));await click('[data-action="open-project-skills"]');await wait(()=>document.querySelector('[data-skill-name="public-project-skill"]'));await wait(()=>!document.querySelector('[data-action="refresh-project-skills"]').disabled);
    const scope=await call(window.personalAgent.workspaceState()),projectId=scope.projects[0].id;
    const initial={modalOpen:document.querySelector('.skills-dialog').open,onePublicSkill:document.querySelectorAll('[data-skill-id]').length===1,plainText:!document.querySelector('[data-skills-panel] img')&&document.querySelector('[data-skill-description]').textContent.includes('<img src=x onerror=alert(1)>'),bodyNotShown:!document.querySelector('[data-skills-panel]').textContent.includes('SKILL_BODY_MUST_STAY_LOCAL'),scanErrorsShown:Boolean(document.querySelector('[data-skills-partial]')),policyOnly:document.querySelector('[data-skill-capabilities]').textContent.includes('暂未启用')};
    const filter=document.querySelector('[data-skill-filter]'),fill=v=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(filter,v);filter.dispatchEvent(new Event('input',{bubbles:true}));};fill('does-not-exist');await wait(()=>document.querySelector('[data-skills-empty]'));const emptyFilter=document.querySelectorAll('[data-skill-id]').length===0;fill('public-project-skill');await wait(()=>document.querySelector('[data-skill-id]'));
    const id=document.querySelector('[data-skill-id]').dataset.skillId,observed=document.querySelector('[data-skills-panel]').dataset.skillsObservedAt;await click('[data-action="refresh-project-skills"]');await wait(()=>!document.querySelector('[data-action="refresh-project-skills"]').disabled&&document.querySelector('[data-skills-panel]').dataset.skillsObservedAt!==observed);const sameOpaqueId=document.querySelector('[data-skill-id]').dataset.skillId===id;
    const extra=await window.personalAgent.listProjectSkills({projectId,cwd:'/etc'}),foreign=await window.personalAgent.listProjectSkills({projectId:'foreign'});
    document.querySelector('[data-skills-panel]').scrollIntoView({block:'start'});return{...initial,emptyFilter,sameOpaqueId,extraRejected:!extra.ok&&extra.errorCode==='INVALID_SKILL_QUERY',foreignRejected:!foreign.ok&&foreign.errorCode==='UNKNOWN_PROJECT',sandboxed:window.personalAgent.security.sandboxed,isolated:window.personalAgent.security.isolated,noRequire:typeof require==='undefined',apiCount:Object.keys(window.personalAgent).length===63};
  })()`);
  renameSync(source, source + '-moved');
  const stale = await window.webContents.executeJavaScript(
    `(async()=>{const wait=async f=>{const until=Date.now()+10000;while(!f()){if(Date.now()>until)throw Error('SKILLS_STALE_TIMEOUT');await new Promise(r=>setTimeout(r,30));}};document.querySelector('[data-action="refresh-project-skills"]').click();await wait(()=>document.querySelector('[data-skills-stale]'));return{failedRefreshMarked:true,oldViewRetained:Boolean(document.querySelector('[data-skill-name="public-project-skill"]'))};})()`,
  );
  writeFileSync(
    join(evidenceDir(root), 'screenshots/M2.8a-project-skills.png'),
    (await window.webContents.capturePage()).toPNG(),
  );
  const draft = await window.webContents.executeJavaScript(
    `(()=>{document.querySelector('[data-action="close-project-skills"]').click();return{unsentDraftKept:document.querySelector('[data-task-draft]').value==='PUBLIC_UNSENT_DRAFT_KEPT'};})()`,
  );
  const db = new DatabaseSync(database, { readOnly: true });
  let noRuns, noIntents;
  try {
    noRuns = db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n === 0;
    noIntents = db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n === 0;
  } finally {
    db.close();
  }
  const checks = {
    ...result,
    ...stale,
    ...draft,
    noRuns,
    noIntents,
    onlyMetadataMethods:
      JSON.stringify(methods) ===
      JSON.stringify(['initialize', 'skills/list', 'initialize', 'skills/list']),
    sourceBodyPreserved: readFileSync(
      join(source + '-moved', '.agents/skills/public-project-skill/SKILL.md'),
      'utf8',
    ).includes('SKILL_BODY_MUST_STAY_LOCAL'),
  };
  writeFileSync(
    join(evidenceDir(root), 'M2.8a-desktop.json'),
    JSON.stringify(
      {
        status: Object.values(checks).every(Boolean) ? 'passed' : 'blocked',
        observedAt: new Date().toISOString(),
        kind: 'real_electron_locked_cli_isolated_project_skill_discovery',
        history: 'synthetic_metadata',
        inferenceRequested: false,
        modelTurns: 0,
        metadataMethods: methods,
        result: checks,
      },
      null,
      2,
    ) + '\n',
  );
  app.quit();
}
