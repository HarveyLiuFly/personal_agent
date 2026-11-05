/** Project discovery only; never an effective authorization or tool execution receipt. */
export interface ProjectSkillView {
  id: string;
  name: string;
  displayName: string | null;
  description: string;
  truncated: boolean;
}
export interface ProjectSkillsView {
  projectId: string;
  observedAt: number;
  skills: ProjectSkillView[];
  scanErrors: number;
  invalidEntries: number;
  truncated: boolean;
  source: 'locked_cli_isolated_project_discovery';
  executionCapabilities: {
    mcp: 'not_enabled';
    plugins: 'not_enabled';
    subAgents: 'not_enabled';
    basis: 'application_execution_profile';
  };
}
