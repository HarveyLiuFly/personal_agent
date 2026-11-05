import type { HostEvent } from '../src/bridge.ts';

type Topic = HostEvent['topic'];
interface Subscriber {
  topics: readonly Topic[];
  projectId?: string;
  run: () => void;
}

const subscribers = new Set<Subscriber>();
let lastSeq = 0;
let listening = false;

/** One Host listener for the whole Renderer; a gap in `seq` refreshes every subscriber. */
function ensureListening(): void {
  if (listening || typeof window === 'undefined' || !window.personalAgent?.onEvent) return;
  listening = true;
  window.personalAgent.onEvent((event) => {
    const gap = lastSeq !== 0 && event.seq !== lastSeq + 1;
    lastSeq = event.seq;
    for (const subscriber of subscribers)
      if (
        gap ||
        (subscriber.topics.includes(event.topic) &&
          (!subscriber.projectId || !event.projectId || subscriber.projectId === event.projectId))
      )
        subscriber.run();
  });
}

/**
 * Runs `refresh` now and again after each Host change notice for `topics` (default `store`).
 * Refreshes never overlap: notices that arrive meanwhile collapse into one follow-up refresh.
 * Returns the unsubscribe function for a React effect cleanup.
 */
export function subscribeRefresh(
  refresh: () => Promise<void> | void,
  options: { topics?: readonly Topic[]; projectId?: string } = {},
): () => void {
  let running = false,
    again = false,
    stopped = false;
  const run = (): void => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void Promise.resolve()
      .then(refresh)
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (again && !stopped) {
          again = false;
          run();
        }
      });
  };
  const subscriber: Subscriber = {
    topics: options.topics ?? ['store'],
    ...(options.projectId ? { projectId: options.projectId } : {}),
    run,
  };
  subscribers.add(subscriber);
  ensureListening();
  run();
  return () => {
    stopped = true;
    subscribers.delete(subscriber);
  };
}

/** Resolves on the next Host notice for `topic`, or after `timeoutMs` as a safety net. */
export function nextHostEvent(topic: Topic = 'store', timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const subscriber: Subscriber = { topics: [topic], run: () => finish() };
    const timer = setTimeout(() => finish(), timeoutMs);
    function finish(): void {
      clearTimeout(timer);
      subscribers.delete(subscriber);
      resolve();
    }
    subscribers.add(subscriber);
    ensureListening();
  });
}
