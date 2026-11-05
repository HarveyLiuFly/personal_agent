/** Local admission estimates and upstream reported usage; not subscription billing. */
export interface ResourceOccupancy {
  modelActive: number;
  modelUnknown: number;
  terminalActive: number;
  terminalUnknown: number;
  worktreeActive: number;
  worktreeUnknown: number;
  writeLeases: number;
  queuedTasks: number;
}
export interface MainResourceSample {
  observedAt: number;
  rssBytes: number;
  cpuPercent: number | null;
  scope: 'main_process';
  basis: 'one_core_100_percent';
}
export interface ResourceBudget {
  periodStart: number;
  periodEnd: number;
  limitTokens: number;
  reservationPerRun: number;
  reservedTokens: number;
  reportedTokens: number;
  availableTokens: number;
  unknownHeldTokens: number;
  activeRuns: number;
  maxConcurrentRuns: 1;
  estimatedUsd: null;
  coverage: 'runs_admitted_since_budget_enabled';
  occupancy?: ResourceOccupancy;
  mainProcess?: MainResourceSample;
}
