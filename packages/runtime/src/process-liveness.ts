import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Identifies one process instance: a PID can be reused, so the start time (and on Linux the boot
 * ID) must match too. Returns null when the platform gives no reliable marker.
 */
export function processMarker(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 22 (starttime) follows the parenthesized command, which may contain spaces.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return fields[19] ? `linux:${boot}:${fields[19]}` : null;
    }
    if (process.platform === 'darwin') {
      const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
      return started ? `darwin:${started}` : null;
    }
  } catch {
    // Gone or unreadable: no marker.
  }
  return null;
}

/**
 * True only when the recorded process instance has certainly ended: its PID no longer exists, or
 * the PID now belongs to a process with a different start marker. Unknown stays false.
 */
export function processGone(pid: number, marker: string | null): boolean {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  if (!marker) return false;
  const current = processMarker(pid);
  return current !== null && current !== marker;
}
