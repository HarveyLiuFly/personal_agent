import { closeSync, constants, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Linux: inside `codex sandbox` with network disabled, the seccomp filter breaks Node stdio that is
 * a Unix socket, which is exactly what Node's own `spawn(..., { stdio: 'pipe' })` hands the child.
 * Reads and writes are silently lost and the process still exits 0. Regular files work, so on Linux
 * the sandboxed process gets a private stdin file and stdout file, and the Host reads the output
 * after the process has exited. macOS (Seatbelt) keeps ordinary pipes.
 */
export const sandboxStdioUsesFiles = process.platform === 'linux';

export interface SandboxStdioFiles {
  stdio: ['ignore' | number, number, 'ignore'];
  /** Output written by the child, or null when it exceeds `limit` bytes. Call after the child exited; works after close(). */
  output(limit: number): Buffer | null;
  close(): void;
}

/** `directory` must be private to this invocation (it is created by the caller with mode 0700). */
export function sandboxStdioFiles(directory: string, input?: string): SandboxStdioFiles {
  const exclusive = constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let stdin: 'ignore' | number = 'ignore';
  if (input !== undefined) {
    const inputPath = join(directory, 'stdin');
    writeFileSync(inputPath, input, { mode: 0o600, flag: 'wx' });
    stdin = openSync(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  const outputPath = join(directory, 'stdout');
  const stdout = openSync(outputPath, constants.O_WRONLY | exclusive, 0o600);
  return {
    stdio: [stdin, stdout, 'ignore'],
    output(limit) {
      return lstatSync(outputPath).size > limit ? null : readFileSync(outputPath);
    },
    close() {
      for (const fd of [stdin, stdout])
        if (typeof fd === 'number') {
          try {
            closeSync(fd);
          } catch {}
        }
    },
  };
}
