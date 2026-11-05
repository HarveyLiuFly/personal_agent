export interface MountEntry {
  device: string;
  mountPoint: string;
  type: string;
  options: string[];
}
export interface SandboxStatus {
  ok: boolean;
  mode: 'user-namespaces' | 'setuid-helper' | 'unavailable';
  sandbox: string;
  profile?: string | null;
  nosuid?: boolean;
  mountPoint?: string | null;
  reason?: string;
  remedies?: string[];
}
export function mountFor(path: string, mounts?: string): MountEntry | null;
export function electronSandboxStatus(
  electronBinary: string,
  proc?: (path: string) => string | null,
): SandboxStatus;
export function displayStatus(env?: NodeJS.ProcessEnv): {
  ok: boolean;
  kind: 'wayland' | 'x11' | 'none';
  value?: string;
};
export function projectFilesystemStatus(root: string): {
  ok: boolean;
  warn: boolean;
  type: string;
  mountPoint: string | null;
  options: string[];
};
export function printLinuxPreflight(electronBinary: string, root: string): void;
