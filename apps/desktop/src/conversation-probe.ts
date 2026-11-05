// CORE.2d window acceptance with the synthetic stdio backend (no model request): a new
// conversation, a follow-up in the same conversation, the sidebar list, pinning and the Dot entry.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { App, BrowserWindow } from 'electron';
import type { ForegroundExecution } from '../../../packages/runtime/src/execution.ts';
import { evidenceDir } from './evidence.ts';

export const CONVERSATION_EVIDENCE = 'CORE.2d-conversation-desktop';

const script = `(async () => {
  const wait = async (check, label, ms = 20000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(label);
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  const type = (text) => {
    const input = document.querySelector('[data-task-draft]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const click = (selector) => document.querySelector(selector).click();
  const turns = () => [...document.querySelectorAll('[data-turn-run]')];
  const panel = () => document.querySelector('[data-conversation-panel]');
  const rows = () => [...document.querySelectorAll('.thread-list [data-conversation-id]')];
  const sendWhenReady = async (label) => {
    await wait(() => !document.querySelector('[data-action="send"]').disabled, label);
    click('[data-action="send"]');
  };
  click('[data-action="choose-project"]');
  await wait(() => {
    const button = document.querySelector('[data-action="project-tasks"]');
    return button && !button.disabled;
  }, 'PROJECT_NOT_OPENED');
  click('[data-action="project-tasks"]');
  await wait(() => panel() && panel().dataset.conversationId === '', 'NEW_CONVERSATION_NOT_SHOWN');
  type('First synthetic question <b>bold</b>');
  await sendWhenReady('FIRST_SEND_DISABLED');
  await wait(() => panel().dataset.conversationId, 'CONVERSATION_NOT_OPENED');
  const conversationId = panel().dataset.conversationId;
  await wait(
    () => turns().length === 1 && turns()[0].dataset.runStatus === 'completed',
    'FIRST_TURN_NOT_COMPLETED',
  );
  await wait(() => rows().length === 1, 'SIDEBAR_NOT_UPDATED');
  const composerOpenAfterTurn = !document.querySelector('[data-task-draft]').disabled;
  type('Follow-up synthetic question');
  await sendWhenReady('FOLLOW_UP_DISABLED');
  await wait(
    () => turns().length === 2 && turns().every((t) => t.dataset.runStatus === 'completed'),
    'SECOND_TURN_NOT_COMPLETED',
  );
  const userTexts = turns().map((t) => t.querySelector('.message.user')?.textContent ?? '');
  const answerTexts = turns().map((t) => t.querySelector('.message.assistant')?.textContent ?? '');
  const sameConversation = panel().dataset.conversationId === conversationId;
  const sidebarRows = rows().length;
  click('[data-action="pin-conversation"]');
  await wait(
    () => document.querySelector('.thread-list [data-conversation-id="' + conversationId + '"] .pin-mark'),
    'NOT_PINNED',
  );
  click('[data-action="open-main-chat"]');
  await wait(() => document.querySelector('[data-main-chat]'), 'DOT_NOT_SHOWN');
  const dotLabel = document.querySelector('[data-main-chat]').getAttribute('aria-label');
  click('.thread-list [data-conversation-id="' + conversationId + '"]');
  await wait(() => turns().length === 2, 'CONVERSATION_NOT_REOPENED');
  const state = await window.personalAgent.workspaceState();
  const projectId = state.value.projects[0].id;
  const summary = (await window.personalAgent.getConversation({ projectId, conversationId })).value;
  const page = (await window.personalAgent.listConversations({ projectId })).value;
  const runs = (await window.personalAgent.listRuns({ projectId })).value;
  return {
    conversationId,
    composerOpenAfterTurn,
    sidebarRows,
    userTexts,
    answerTexts,
    sameConversation,
    turns: summary.turns,
    pinned: summary.pinned,
    unread: summary.unread,
    status: summary.status,
    pinnedListed: page.pinned.length,
    otherListed: page.items.length,
    runsInOneConversation: runs.every((run) => run.taskId === conversationId) && runs.length === 2,
    dotLabel,
    markupShownAsText: document.body.textContent.includes('<b>bold</b>'),
    noInjectedMarkup: !document.querySelector('[data-execution-items] b'),
    sandboxed: window.personalAgent.security.sandboxed,
    isolated: window.personalAgent.security.isolated,
    noRequire: typeof require === 'undefined',
  };
})()`;

/** Drives the conversation flow in the real window, saves a screenshot and the evidence, quits. */
export async function runConversationProbe(
  root: string,
  app: App,
  window: BrowserWindow,
  execution: ForegroundExecution,
): Promise<void> {
  let result: Record<string, unknown> = {},
    code = '';
  try {
    result = (await window.webContents.executeJavaScript(script)) as Record<string, unknown>;
  } catch (error) {
    code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'UI_FAILED';
  }
  const directory = evidenceDir(root);
  try {
    writeFileSync(
      resolve(directory, 'screenshots/CORE.2d-conversation.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
  } catch {
    // The screenshot is optional evidence.
  }
  const texts = (result.userTexts as string[] | undefined) ?? [];
  const passed =
    !code &&
    result.composerOpenAfterTurn === true &&
    result.sidebarRows === 1 &&
    texts[0]?.includes('First synthetic question') === true &&
    texts[1]?.includes('Follow-up synthetic question') === true &&
    (result.answerTexts as string[]).every((text) => text.includes('aab')) &&
    result.sameConversation === true &&
    result.turns === 2 &&
    result.pinned === true &&
    result.unread === false &&
    result.pinnedListed === 1 &&
    result.otherListed === 0 &&
    result.runsInOneConversation === true &&
    result.dotLabel === 'Dot' &&
    result.markupShownAsText === true &&
    result.noInjectedMarkup === true &&
    result.sandboxed === true &&
    result.isolated === true &&
    result.noRequire === true &&
    execution.diagnostics.clientThreadStarts === 1 &&
    execution.diagnostics.clientThreadResumes === 1;
  writeFileSync(
    resolve(directory, CONVERSATION_EVIDENCE + '.json'),
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        status: passed ? 'passed' : 'failed',
        kind: 'real_electron_window_with_synthetic_stdio_backend',
        modelRequests: 0,
        ...(code ? { code } : {}),
        result,
        threadStarts: execution.diagnostics.clientThreadStarts,
        threadResumes: execution.diagnostics.clientThreadResumes,
      },
      null,
      2,
    ) + '\n',
  );
  // Graceful quit closes the ledger and backend; the launcher reads the evidence status.
  app.quit();
}
