import type {
  TerminalInputReceipt,
  WriteTerminal,
} from '../../../packages/contracts/src/terminal.ts';
interface Generation {
  projectId: string;
  sessionId: string;
  sequence: number;
  active: boolean;
  blocked: boolean;
  chars: number;
  events: number;
  pending: Promise<void>;
}
/** Each queued keystroke belongs to the session visible when it was typed. */
export class TerminalInputQueue {
  private current: Generation | undefined;
  private send: (q: WriteTerminal) => Promise<TerminalInputReceipt>;
  private unknown: (sessionId: string) => void;
  private tooLarge: () => void;
  constructor(
    send: (q: WriteTerminal) => Promise<TerminalInputReceipt>,
    unknown: (sessionId: string) => void,
    tooLarge: () => void,
  ) {
    this.send = send;
    this.unknown = unknown;
    this.tooLarge = tooLarge;
  }
  bind(projectId: string, sessionId: string, sequence: number, active: boolean) {
    const old = this.current;
    if (old?.sessionId === sessionId && old.projectId === projectId) {
      old.sequence = Math.max(old.sequence, sequence);
      old.active = active;
      return;
    }
    this.current = {
      projectId,
      sessionId,
      sequence,
      active,
      blocked: false,
      chars: 0,
      events: 0,
      pending: Promise.resolve(),
    };
  }
  writable(sessionId: string): boolean {
    return this.current?.sessionId === sessionId && this.current.active && !this.current.blocked;
  }
  submit(sessionId: string, text: string): Promise<void> {
    const g = this.current;
    if (!g || g.sessionId !== sessionId || !g.active || g.blocked) return Promise.resolve();
    if (text.length > 65536 || g.chars + text.length > 65536 || g.events >= 256) {
      this.tooLarge();
      return Promise.resolve();
    }
    g.chars += text.length;
    g.events++;
    g.pending = g.pending
      .then(async () => {
        if (this.current !== g || !g.active || g.blocked) return;
        const chunks: string[] = [];
        let part = '';
        for (const char of text) {
          if (part.length + char.length > 4096) {
            chunks.push(part);
            part = '';
          }
          part += char;
        }
        if (part) chunks.push(part);
        for (const input of chunks) {
          if (this.current !== g || !g.active || g.blocked) return;
          try {
            const receipt = await this.send({
              projectId: g.projectId,
              sessionId: g.sessionId,
              sequence: ++g.sequence,
              text: input,
            });
            if (receipt.state !== 'accepted') throw Error('TERMINAL_INPUT_UNKNOWN');
          } catch {
            if (this.current === g) {
              g.blocked = true;
              this.unknown(g.sessionId);
            }
            return;
          }
        }
      })
      .finally(() => {
        g.chars -= text.length;
        g.events--;
      });
    return g.pending;
  }
  dispose() {
    this.current = undefined;
  }
}
