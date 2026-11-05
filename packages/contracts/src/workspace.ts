/** Bounded display data. IDs are short-lived Host grants, never filesystem paths or execution permissions. */
export interface WorkspaceQuery {
  projectId: string;
}
export interface WorkspaceEntryQuery extends WorkspaceQuery {
  entryId: string;
}
export interface WorkspaceDiffQuery extends WorkspaceQuery {
  changeId: string;
  part: 'staged' | 'unstaged';
}
export interface WorkspaceEntry {
  id: string | null;
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'blocked';
  size: number;
  reason?: string;
}
export interface WorkspaceDirectory {
  version: 1;
  projectId: string;
  path: string;
  breadcrumbs: Array<{ id: string; name: string }>;
  entries: WorkspaceEntry[];
  truncated: boolean;
}
export interface WorkspaceChange {
  id: string | null;
  path: string;
  previousPath?: string;
  staged: string;
  unstaged: string;
  untracked: boolean;
  conflict: boolean;
  reason?: string;
}
export interface WorkspaceGit {
  available: boolean;
  branch: string | null;
  head: string | null;
  changes: WorkspaceChange[];
  reason?: string;
}
export interface WorkspaceOverview {
  version: 1;
  projectId: string;
  directory: WorkspaceDirectory;
  git: WorkspaceGit;
  observedAt: string;
}
export interface WorkspacePreview {
  version: 1;
  projectId: string;
  path: string;
  kind: 'text' | 'binary' | 'tooLarge';
  text: string;
  bytes: number;
  contentHash: string | null;
}
export interface WorkspaceDiff {
  version: 1;
  projectId: string;
  path: string;
  part: 'staged' | 'unstaged';
  text: string;
  empty: boolean;
}
