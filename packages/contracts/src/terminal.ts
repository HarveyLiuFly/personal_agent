export type TerminalState =
  'prepared' | 'starting' | 'running' | 'stopping' | 'exited' | 'outcome_unknown';
export interface TerminalSession {
  sessionId: string;
  projectId: string;
  state: TerminalState;
  cols: number;
  rows: number;
  lastInputSequence: number;
  lastInputState: 'accepted' | 'sending' | 'outcome_unknown' | null;
  exitCode: number | null;
  errorCode: string | null;
  createdAt: number;
}
export interface TerminalChunk {
  sequence: number;
  data: string;
}
export interface TerminalView {
  session: TerminalSession | null;
  chunks: TerminalChunk[];
  nextSequence: number;
  reset: boolean;
  outputAvailable: boolean;
}
export interface OpenTerminal {
  projectId: string;
  commandKey: string;
  cols: number;
  rows: number;
}
export interface WriteTerminal {
  projectId: string;
  sessionId: string;
  sequence: number;
  text: string;
}
export interface TerminalInputReceipt {
  sequence: number;
  state: 'accepted' | 'sending' | 'outcome_unknown';
}
export interface TerminalHostSession extends TerminalSession {
  operationId: string;
  epoch: number;
  fence: number;
  supervisorPid: number | null;
  ptyPid: number | null;
  rootIdentity: { device: string; inode: string };
  directory: string;
}
