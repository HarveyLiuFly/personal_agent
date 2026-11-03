/** Local admission estimates and upstream reported usage; not subscription billing. */
export interface ResourceBudget {
 periodStart:number;periodEnd:number;limitTokens:number;reservationPerRun:number;
 reservedTokens:number;reportedTokens:number;availableTokens:number;unknownHeldTokens:number;
 activeRuns:number;maxConcurrentRuns:1;estimatedUsd:null;coverage:'runs_admitted_since_budget_enabled';
}
