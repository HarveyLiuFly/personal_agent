// CORE.2 closing acceptance, one phase per app launch (driven by scripts/acceptance-core2.mjs).
// Real sandboxed window, real pinned Codex and real model turns:
//   first   – records written by the previous version are readable after migration; a new
//             conversation answers, and a follow-up cites the previous answer.
//   restart – after a cold restart the same conversation continues; then a long turn starts and
//             the launcher kills the app while it runs.
//   recover – after the next start the Host reconciles that turn by itself and never resends it.
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { App, BrowserWindow } from 'electron';

export const CORE2_CODENAME = 'BLUE-HERON-42';
const QUESTION_1 =
  'Read README.md in this project. In one short sentence, state the codename written there. ' +
  'Then choose any two-digit number of your own and end your reply with exactly NUMBER=<that number>.';
const QUESTION_2 =
  'Without reading any file again: which number did you choose in your previous reply? ' +
  'Reply with only the digits.';
const QUESTION_3 =
  'Which codename did you mention earlier in this conversation? Reply with only the codename.';
const QUESTION_4 = 'Count from 1 to 300, one number per line, then write DONE.';

const helpers = `
  const wait = async (check, label, ms = 20000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(label);
      await new Promise((r) => setTimeout(r, 250));
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
  const rows = () => [...document.querySelectorAll('.thread-list [data-conversation-id]')];
  const ended = (turn) => ['completed', 'failed', 'cancelled'].includes(turn.dataset.runStatus);
  // A turn may hold several assistant messages (e.g. "reading README.md…" then the answer).
  const answer = (turn) =>
    [...turn.querySelectorAll('.message.assistant')].map((m) => m.textContent).join('\\n');
  const send = async (text, label) => {
    type(text);
    await wait(() => !document.querySelector('[data-action="send"]').disabled, label);
    click('[data-action="send"]');
  };
  const connected = async () => {
    await wait(async () => (await window.personalAgent.inspect()).status === 'connected',
      'CODEX_NOT_CONNECTED', 300000);
  };
`;

/** The Renderer script of one phase (exported so a test can check it parses). */
export function script(phase: string, state: Record<string, unknown>): string {
  const s = JSON.stringify(state);
  if (phase === 'first')
    return `(async () => {${helpers}
      const state = ${s};
      await connected();
      await wait(() => rows().some((r) => r.textContent.includes('OLD_TASK_REQUEST')),
        'OLD_CONVERSATION_NOT_LISTED', 30000);
      rows().find((r) => r.textContent.includes('OLD_TASK_REQUEST')).click();
      await wait(() => turns().length === 1, 'OLD_TURN_NOT_SHOWN');
      const oldText = turns()[0].textContent;
      click('[data-action="open-main-chat"]');
      await wait(() => document.querySelector('[data-main-chat]')?.textContent.includes('OLD_DOT_ANSWER_MARKER'),
        'OLD_DOT_NOT_SHOWN');
      const dotText = document.querySelector('[data-main-chat]').textContent;
      click('[data-action="project-tasks"]');
      await wait(() => panel() && panel().dataset.conversationId === '', 'NEW_CONVERSATION_NOT_SHOWN');
      await send(${JSON.stringify(QUESTION_1)}, 'FIRST_SEND_DISABLED');
      await wait(() => panel().dataset.conversationId, 'CONVERSATION_NOT_OPENED');
      const conversationId = panel().dataset.conversationId;
      await wait(() => turns().length === 1 && ended(turns()[0]), 'FIRST_TURN_NOT_ENDED', 300000);
      const first = { status: turns()[0].dataset.runStatus, answer: answer(turns()[0]) };
      await send(${JSON.stringify(QUESTION_2)}, 'SECOND_SEND_DISABLED');
      await wait(() => turns().length === 2 && ended(turns()[1]), 'SECOND_TURN_NOT_ENDED', 300000);
      const second = { status: turns()[1].dataset.runStatus, answer: answer(turns()[1]) };
      return {
        oldTurnReadable: oldText.includes('OLD_TASK_ANSWER_MARKER') && oldText.includes('OLD_TASK_REQUEST') && !oldText.includes('"format":1'),
        oldDotReadable: dotText.includes('OLD_DOT_NOTE_MARKER') && dotText.includes('OLD_DOT_ANSWER_MARKER'),
        conversationId, runIds: turns().map((t) => t.dataset.turnRun), first, second,
        sandboxed: window.personalAgent.security.sandboxed, isolated: window.personalAgent.security.isolated,
      };
    })()`;
  if (phase === 'restart')
    return `(async () => {${helpers}
      const state = ${s};
      await connected();
      await wait(() => rows().some((r) => r.dataset.conversationId === state.conversationId),
        'CONVERSATION_NOT_LISTED_AFTER_RESTART', 30000);
      rows().find((r) => r.dataset.conversationId === state.conversationId).click();
      await wait(() => turns().length === 2, 'TURNS_NOT_RESTORED');
      const restoredTurns = turns().length;
      await send(${JSON.stringify(QUESTION_3)}, 'THIRD_SEND_DISABLED');
      await wait(() => turns().length === 3 && ended(turns()[2]), 'THIRD_TURN_NOT_ENDED', 300000);
      const third = { status: turns()[2].dataset.runStatus, answer: answer(turns()[2]) };
      await send(${JSON.stringify(QUESTION_4)}, 'FOURTH_SEND_DISABLED');
      await wait(() => turns().length === 4, 'FOURTH_TURN_NOT_SHOWN', 60000);
      const killRunId = turns()[3].dataset.turnRun;
      const projectId = (await window.personalAgent.workspaceState()).value.projects[0].id;
      // Kill only once the turn was accepted and the answer is streaming.
      await wait(async () => {
        const run = await window.personalAgent.getRun({ projectId, runId: killRunId });
        return run.ok && run.value.turnId && run.value.status === 'running' &&
          (run.value.snapshot?.items ?? []).some((i) => i.role === 'assistant' && i.text.length > 20);
      }, 'FOURTH_TURN_NOT_STREAMING', 180000);
      return { restoredTurns, third, killRunId };
    })()`;
  return `(async () => {${helpers}
      const state = ${s};
      await connected();
      const projectId = (await window.personalAgent.workspaceState()).value.projects[0].id;
      const begun = Date.now();
      let run;
      await wait(async () => {
        run = (await window.personalAgent.getRun({ projectId, runId: state.killRunId })).value;
        return run && run.status !== 'outcome_unknown';
      }, 'NOT_RECONCILED', 600000);
      const page = (await window.personalAgent.listConversationTurns({ projectId, conversationId: state.conversationId })).value;
      return { status: run.status, taskStatus: run.taskStatus, blocked: run.blocked,
        reconciledAfterMs: Date.now() - begun, turns: page.items.length };
    })()`;
}

/** Runs one phase; `stateFile` carries what later phases need (IDs, the number). */
export async function runCore2AcceptanceProbe(
  app: App,
  window: BrowserWindow,
  database: string,
  phase: string,
  stateFile: string,
): Promise<void> {
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    // First phase: nothing yet.
  }
  const record = (patch: Record<string, unknown>) => {
    state = { ...state, ...patch };
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  };
  try {
    const result = (await window.webContents.executeJavaScript(script(phase, state))) as Record<
      string,
      unknown
    >;
    if (phase === 'first') {
      const first = result.first as { status: string; answer: string },
        second = result.second as { status: string; answer: string },
        number = /NUMBER\s*=\s*(\d{2})/.exec(first.answer)?.[1] ?? null;
      record({
        conversationId: result.conversationId,
        first: {
          oldTurnReadable: result.oldTurnReadable,
          oldDotReadable: result.oldDotReadable,
          turn1Status: first.status,
          codenameInAnswer1: first.answer.includes(CORE2_CODENAME),
          number,
          turn2Status: second.status,
          followUpCitesPreviousAnswer: number !== null && second.answer.trim().includes(number),
          answer2: second.answer.slice(0, 80),
          sandboxed: result.sandboxed,
          isolated: result.isolated,
        },
      });
      app.quit();
    } else if (phase === 'restart') {
      const third = result.third as { status: string; answer: string };
      record({
        killRunId: result.killRunId,
        restart: {
          restoredTurns: result.restoredTurns,
          turn3Status: third.status,
          coldRestartContinues: third.answer.toUpperCase().includes(CORE2_CODENAME),
          answer3: third.answer.slice(0, 80),
          killRequestedAt: new Date().toISOString(),
        },
        killReady: true,
      });
      // Wait here: the launcher kills this process while the fourth turn runs.
    } else {
      const db = new DatabaseSync(database, { readOnly: true });
      let intents, events;
      try {
        intents = db
          .prepare(
            "SELECT kind,state FROM execution_intents WHERE run_id=? AND kind IN ('thread_resume','turn_start')",
          )
          .all(String(state.killRunId));
        events = db
          .prepare(
            "SELECT event_type,json_extract(payload_json,'$.basis') AS basis FROM task_events WHERE run_id=? AND event_type IN ('executor_started','executor_closed','owner_recovery_unknown','history_reconciled')",
          )
          .all(String(state.killRunId));
      } finally {
        db.close();
      }
      record({
        recover: {
          ...result,
          turnStartIntents: intents.filter((i) => i.kind === 'turn_start').length,
          intents,
          events,
        },
      });
      app.quit();
    }
  } catch (error) {
    record({
      [phase + 'Error']:
        error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PROBE_FAILED',
    });
    app.quit();
  }
}
