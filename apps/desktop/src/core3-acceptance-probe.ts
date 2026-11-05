// CORE.3 closing acceptance (driven by scripts/acceptance-core3.mjs): a real code task in a small
// Python project, in a real sandboxed window with the pinned Codex and REAL MODEL TURNS.
//   1. "Auto" conversation fixes calc.py; the project check (python3 -m unittest) runs after it.
//   2. A command that must leave the sandbox asks for approval; allowed -> it ran.
//   3. The same kind of command, declined -> no side effect.
//   4. A long turn gets extra words while it runs (turn/steer).
//   5. Another long turn is stopped; its Codex process actually exits.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { App, BrowserWindow } from 'electron';
import { processGone } from '../../../packages/runtime/src/process-liveness.ts';

const FIX =
  'The unit test in test_calc.py fails. Fix calc.py so that `python3 -m unittest -v` passes. ' +
  'Do not modify test_calc.py. Run the tests once to confirm, then reply briefly.';
const allow = (file: string) =>
  `Run exactly this shell command and nothing else: touch ${file} . ` +
  'It writes outside the workspace, so request escalated permission for it. Then reply DONE.';
const COUNT = 'Count from 1 to 500, one number per line, then write DONE.';
const STEER = 'Stop counting now and reply only with STEERED.';

/** The Renderer script (exported so a test can check it parses). */
export function script(files: { allow: string; deny: string }): string {
  return `(async () => {
  const wait = async (check, label, ms = 30000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(label);
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  const type = (text) => {
    const input = document.querySelector('[data-task-draft]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const click = (selector) => document.querySelector(selector).click();
  const panel = () => document.querySelector('[data-conversation-panel]');
  const turns = () => [...document.querySelectorAll('[data-turn-run]')];
  const ended = (turn) => turn && ['completed', 'failed', 'cancelled'].includes(turn.dataset.runStatus);
  const send = async (text, label) => {
    type(text);
    await wait(() => !document.querySelector('[data-action="send"]').disabled, label);
    click('[data-action="send"]');
  };
  /** Waits for turn n to end; answers approval cards with \`decide\` (or none expected). */
  const finish = async (n, decide, label) => {
    const seen = [];
    await wait(async () => {
      const card = document.querySelector('[data-interaction-id]');
      if (card && decide) {
        const id = card.dataset.interactionId;
        if (!seen.some((s) => s.id === id)) {
          seen.push({ id, text: card.textContent.slice(0, 300) });
          card.querySelector(decide === 'accept' ? '[data-action="accept-request"]' : '[data-action="decline-request"]').click();
        }
      }
      return turns().length === n && ended(turns()[n - 1]);
    }, label, 600000);
    return { status: turns()[n - 1].dataset.runStatus, runId: turns()[n - 1].dataset.turnRun, approvals: seen };
  };
  await wait(async () => (await window.personalAgent.inspect()).status === 'connected', 'CODEX_NOT_CONNECTED', 300000);
  click('[data-action="choose-project"]');
  await wait(() => {
    const b = document.querySelector('[data-action="project-tasks"]');
    return b && !b.disabled;
  }, 'PROJECT_NOT_OPENED');
  const projectId = (await window.personalAgent.workspaceState()).value.projects[0].id;
  const set = await window.personalAgent.setProjectCheck({ projectId, command: 'python3 -m unittest -v', autoRun: true });
  if (!set.ok) throw new Error('CHECK_SETTING_' + set.errorCode);
  click('[data-action="project-tasks"]');
  await wait(() => panel() && panel().dataset.conversationId === '', 'NEW_CONVERSATION_NOT_SHOWN');
  await wait(() => document.querySelector('[data-choice="permission"]')?.value === 'auto', 'DEFAULT_NOT_AUTO');
  await send(${JSON.stringify(FIX)}, 'FIX_SEND_DISABLED');
  await wait(() => panel().dataset.conversationId, 'CONVERSATION_NOT_OPENED');
  const conversationId = panel().dataset.conversationId;
  const fix = await finish(1, 'accept', 'FIX_TURN_NOT_ENDED');
  await wait(() => turns()[0].querySelector('[data-check-status]'), 'AUTO_CHECK_NOT_SHOWN', 300000);
  const autoCheck = turns()[0].querySelector('[data-check-status]').dataset.checkStatus;
  await send(${JSON.stringify(allow(files.allow))}, 'ALLOW_SEND_DISABLED');
  const allowed = await finish(2, 'accept', 'ALLOW_TURN_NOT_ENDED');
  await send(${JSON.stringify(allow(files.deny))}, 'DENY_SEND_DISABLED');
  const declined = await finish(3, 'decline', 'DENY_TURN_NOT_ENDED');
  const streaming = async (runId, label) =>
    wait(async () => {
      const run = (await window.personalAgent.getRun({ projectId, runId })).value;
      return run && run.turnId && (run.snapshot?.items ?? []).some((i) => i.role === 'assistant' && i.text.length > 30);
    }, label, 180000);
  // Turn 4: words added while it runs.
  await send(${JSON.stringify(COUNT)}, 'STEER_TURN_SEND_DISABLED');
  await wait(() => turns().length === 4, 'STEER_TURN_NOT_SHOWN');
  const steerRun = turns()[3].dataset.turnRun;
  await streaming(steerRun, 'STEER_TURN_NOT_STREAMING');
  const composerSaidAdd = document.querySelector('[data-action="send"]').textContent.includes('追加');
  type(${JSON.stringify(STEER)});
  await wait(() => !document.querySelector('[data-action="send"]').disabled, 'STEER_DISABLED');
  click('[data-action="send"]');
  await wait(() => document.querySelector('[data-task-draft]').value === '' || document.querySelector('.notice.error'), 'STEER_NOT_SENT', 60000);
  const steerError = document.querySelector('.notice.error')?.textContent ?? '';
  const steered = await finish(4, 'decline', 'STEER_TURN_NOT_ENDED');
  const steeredAnswer = [...turns()[3].querySelectorAll('.message.assistant')].map((m) => m.textContent).join('\\n').slice(-200);
  const steerShown = turns()[3].textContent.includes('STEERED');
  // Turn 5: stopped while it runs.
  await send(${JSON.stringify(COUNT)}, 'STOP_TURN_SEND_DISABLED');
  await wait(() => turns().length === 5, 'STOP_TURN_NOT_SHOWN');
  const countRun = turns()[4].dataset.turnRun;
  await streaming(countRun, 'STOP_TURN_NOT_STREAMING');
  const stopShown = Boolean(document.querySelector('[data-action="composer-stop"]'));
  if (stopShown) click('[data-action="composer-stop"]');
  const stopped = await finish(5, null, 'STOP_NOT_ENDED');
  const checks = (await window.personalAgent.listProjectChecks({ projectId, conversationId })).value;
  return {
    projectId, conversationId, fix, autoCheck, allowed, declined, steered, steerRun, steeredAnswer, steerShown,
    stopped, countRun, composerSaidAdd, steerError, stopShown,
    lastCheck: checks[0]?.status ?? null,
    sandboxed: window.personalAgent.security.sandboxed, isolated: window.personalAgent.security.isolated,
  };
})()`;
}

/** Runs the flow, then checks side effects and processes from the Host side. */
export async function runCore3AcceptanceProbe(
  app: App,
  window: BrowserWindow,
  database: string,
  project: string,
  stateFile: string,
): Promise<void> {
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
    allowFile: string;
    denyFile: string;
  };
  const record = (patch: Record<string, unknown>) =>
    writeFileSync(
      stateFile,
      JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), ...patch }, null, 2) + '\n',
    );
  try {
    const result = (await window.webContents.executeJavaScript(
      script({ allow: state.allowFile, deny: state.denyFile }),
    )) as Record<string, unknown>;
    // The stopped turn's executor process must actually end.
    const db = new DatabaseSync(database, { readOnly: true });
    let executor: { pid: number; marker: string | null } | null = null,
      steers: Array<{ state: string }> = [];
    try {
      const row = db
        .prepare(
          "SELECT payload_json FROM task_events WHERE run_id=? AND event_type='executor_started' ORDER BY sequence DESC LIMIT 1",
        )
        .get(String(result.countRun)) as { payload_json: string } | undefined;
      if (row) executor = JSON.parse(row.payload_json);
      steers = db
        .prepare("SELECT state FROM execution_intents WHERE run_id=? AND kind='turn_steer'")
        .all(String(result.steerRun)) as Array<{ state: string }>;
    } finally {
      db.close();
    }
    let gone = false;
    for (let i = 0; i < 40 && executor && !gone; i++) {
      gone = processGone(executor.pid, executor.marker);
      if (!gone) await new Promise((done) => setTimeout(done, 250));
    }
    record({
      result,
      allowFileExists: existsSync(state.allowFile),
      denyFileExists: existsSync(state.denyFile),
      calcPy: readFileSync(`${project}/calc.py`, 'utf8'),
      stoppedExecutorExited: gone,
      steerIntents: steers.map((s) => s.state),
    });
  } catch (error) {
    record({
      error:
        error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PROBE_FAILED',
    });
  }
  app.quit();
}
