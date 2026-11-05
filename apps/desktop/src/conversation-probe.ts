// CORE.2d/2g window acceptance with the synthetic stdio backend (no model request): a new
// conversation, a follow-up in the same conversation, the sidebar list, pinning, the Dot entry,
// starting a new conversation from a turn, and archiving.
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
  const projectId = (await window.personalAgent.workspaceState()).value.projects[0].id;
  click('[data-action="project-tasks"]');
  await wait(() => panel() && panel().dataset.conversationId === '', 'NEW_CONVERSATION_NOT_SHOWN');
  // Choices: a new conversation starts in "auto"; full access needs an explicit confirmation.
  const permission = () => document.querySelector('[data-choice="permission"]');
  await wait(() => permission() && permission().value === 'auto', 'DEFAULT_NOT_AUTO');
  permission().value = 'fullAccess';
  permission().dispatchEvent(new Event('change', { bubbles: true }));
  await wait(() => document.querySelector('[data-action="confirm-full-access"]'), 'FULL_ACCESS_NOT_CONFIRMED');
  const confirmShown = permission().value === 'auto';
  [...document.querySelectorAll('.full-access-confirm button')].find((b) => b.textContent === '取消').click();
  await wait(() => !document.querySelector('[data-action="confirm-full-access"]'), 'CONFIRM_NOT_CLOSED');
  const stillAuto = permission().value === 'auto';
  type('First synthetic question <b>bold</b>');
  await sendWhenReady('FIRST_SEND_DISABLED');
  await wait(() => panel().dataset.conversationId, 'CONVERSATION_NOT_OPENED');
  const conversationId = panel().dataset.conversationId;
  await wait(
    () => turns().length === 1 && turns()[0].dataset.runStatus === 'completed',
    'FIRST_TURN_NOT_COMPLETED',
  );
  await wait(() => rows().length === 1, 'SIDEBAR_NOT_UPDATED');
  const markupShownAsText = document.body.textContent.includes('<b>bold</b>');
  const noInjectedMarkup = !document.querySelector('[data-execution-items] b');
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
  // Project check command: set a custom command, run it, see the step after the last turn.
  click('[data-action="edit-check"]');
  await wait(() => document.querySelector('[data-check-form]'), 'CHECK_FORM_NOT_SHOWN');
  const presetSelect = document.querySelector('[data-check-form] select');
  presetSelect.value = 'custom';
  presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(() => document.querySelector('[data-check-command]'), 'CHECK_COMMAND_INPUT');
  const commandInput = document.querySelector('[data-check-command]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(commandInput, 'sh -c "echo CHECK_OK; touch check-ran.txt"');
  commandInput.dispatchEvent(new Event('input', { bubbles: true }));
  click('[data-action="save-check"]');
  await wait(() => document.querySelector('[data-action="run-check"]'), 'CHECK_NOT_SAVED');
  click('[data-action="run-check"]');
  await wait(() => document.querySelector('[data-check-status]'), 'CHECK_NOT_SHOWN', 60000);
  const checkStatus = document.querySelector('[data-check-status]').dataset.checkStatus;
  const checkAfterLastTurn = Boolean(turns()[1].querySelector('[data-check-status]'));
  click('[data-action="open-main-chat"]');
  await wait(() => document.querySelector('[data-main-chat]'), 'DOT_NOT_SHOWN');
  const dotLabel = document.querySelector('[data-main-chat]').getAttribute('aria-label');
  click('.thread-list [data-conversation-id="' + conversationId + '"]');
  await wait(() => turns().length === 2, 'CONVERSATION_NOT_REOPENED');
  // Start a new conversation from the first turn ("从这里新开").
  document.querySelectorAll('[data-action="fork-from-turn"]')[0].click();
  await wait(
    () => panel().dataset.conversationId === '' && document.querySelector('[data-fork-source]'),
    'FORK_NOT_SHOWN',
  );
  type('Forked synthetic question');
  await sendWhenReady('FORK_SEND_DISABLED');
  await wait(
    () => panel().dataset.conversationId && panel().dataset.conversationId !== conversationId,
    'FORK_NOT_OPENED',
  );
  const forkId = panel().dataset.conversationId;
  await wait(
    () => turns().length === 1 && turns()[0].dataset.runStatus === 'completed',
    'FORK_TURN_NOT_COMPLETED',
  );
  await wait(() => rows().length === 2, 'FORK_NOT_LISTED');
  // Archive the fork: it leaves the list, its composer locks, and the archived list shows it.
  click('[data-action="archive-conversation"]');
  await wait(() => rows().length === 1, 'ARCHIVE_NOT_APPLIED');
  type('Must not send while archived');
  const sendLockedWhenArchived = document.querySelector('[data-action="send"]').disabled;
  click('[data-action="toggle-archived"]');
  await wait(
    () => rows().length === 1 && rows()[0].dataset.conversationId === forkId,
    'ARCHIVED_LIST_NOT_SHOWN',
  );
  click('[data-action="toggle-archived"]');
  await wait(() => rows().length === 1 && rows()[0].dataset.conversationId === conversationId, 'LIST_NOT_RESTORED');
  const summary = (await window.personalAgent.getConversation({ projectId, conversationId })).value;
  const page = (await window.personalAgent.listConversations({ projectId })).value;
  const runs = (await window.personalAgent.listRuns({ projectId })).value;
  const catalog = await window.personalAgent.listModels();
  const fork = (await window.personalAgent.getConversation({ projectId, conversationId: forkId })).value;
  // A new conversation in a new worktree: the window switches to that workspace.
  click('[data-action="project-tasks"]');
  await wait(() => document.querySelector('[data-environment]'), 'ENVIRONMENT_CHOICE_NOT_SHOWN');
  const environment = document.querySelector('[data-environment]');
  environment.value = 'worktree';
  environment.dispatchEvent(new Event('change', { bubbles: true }));
  type('Worktree synthetic question');
  await sendWhenReady('WORKTREE_SEND_DISABLED');
  await wait(
    () => document.querySelector('.project-crumb')?.textContent !== 'workspace' && panel()?.dataset.conversationId,
    'WORKTREE_NOT_OPENED',
    60000,
  );
  await wait(() => turns().length === 1 && turns()[0].dataset.runStatus === 'completed', 'WORKTREE_TURN_NOT_COMPLETED');
  const worktreeCrumb = document.querySelector('.project-crumb').textContent;
  const worktrees = (await window.personalAgent.listWorktrees({ projectId })).value.worktrees;
  const worktreeConversation = (
    await window.personalAgent.getConversation({
      projectId: worktrees[0]?.id ?? '',
      conversationId: panel().dataset.conversationId,
    })
  ).value;
  return {
    worktreeCrumb,
    worktreeCount: worktrees.length,
    worktreeConversationTurns: worktreeConversation?.turns ?? 0,
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
    originalTurns: runs.filter((run) => run.taskId === conversationId).length,
    forkTurns: runs.filter((run) => run.taskId === forkId).length,
    forkedFrom: fork.forkedFrom === conversationId,
    forkArchived: fork.archived,
    sendLockedWhenArchived,
    dotLabel,
    fullAccessNeedsConfirmation: confirmShown && stillAuto,
    checkStatus,
    checkAfterLastTurn,
    modelCatalog: catalog.ok ? catalog.value.length : catalog.errorCode,
    markupShownAsText,
    noInjectedMarkup,
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
    result.originalTurns === 2 &&
    result.forkTurns === 1 &&
    result.forkedFrom === true &&
    result.forkArchived === true &&
    result.sendLockedWhenArchived === true &&
    result.dotLabel === 'Dot' &&
    result.fullAccessNeedsConfirmation === true &&
    result.checkStatus === 'passed' &&
    result.worktreeCount === 1 &&
    result.worktreeConversationTurns === 1 &&
    typeof result.worktreeCrumb === 'string' &&
    result.worktreeCrumb !== 'workspace' &&
    result.checkAfterLastTurn === true &&
    typeof result.modelCatalog === 'number' &&
    result.modelCatalog > 0 &&
    result.markupShownAsText === true &&
    result.noInjectedMarkup === true &&
    result.sandboxed === true &&
    result.isolated === true &&
    result.noRequire === true &&
    execution.diagnostics.clientThreadStarts === 2 &&
    execution.diagnostics.clientThreadResumes === 1 &&
    execution.diagnostics.clientThreadForks === 1;
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
        threadForks: execution.diagnostics.clientThreadForks,
      },
      null,
      2,
    ) + '\n',
  );
  // Graceful quit closes the ledger and backend; the launcher reads the evidence status.
  app.quit();
}
