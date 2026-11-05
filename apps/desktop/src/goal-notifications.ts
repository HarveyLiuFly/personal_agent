import { Notification } from 'electron';
import type { GoalNotificationClaim } from '../../../packages/contracts/src/goals.ts';
import type { GoalNotificationReceipt } from '../../../packages/runtime/src/goal-service.ts';
/** Only OS acknowledgement is a delivered receipt. A missing acknowledgement remains Unknown. */
export function showGoalNotification(
  claim: GoalNotificationClaim,
  signal: AbortSignal,
): Promise<GoalNotificationReceipt> {
  if (!Notification.isSupported()) return Promise.resolve({ state: 'failed', providerRef: null });
  return new Promise((resolve) => {
    let settled = false;
    const notice = new Notification({ title: 'Personal Agent · 目标进展', body: claim.summary });
    const finish = (state: GoalNotificationReceipt['state']) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      notice.removeAllListeners();
      resolve({
        state,
        providerRef: state === 'delivered' ? 'desktop:' + claim.operationId : null,
      });
    };
    const abort = () => {
      notice.close();
      finish('unknown');
    };
    notice.once('show', () => finish('delivered'));
    notice.once('failed', () => finish('failed'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      notice.show();
    } catch {
      finish('unknown');
    }
  });
}
