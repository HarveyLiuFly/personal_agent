/**
 * Default token budget with one Run at a time. Suites written for single-Run admission use it to
 * keep checking that Unknown and in-flight Runs hold capacity (now one slot of max_active_runs).
 */
export const SINGLE_RUN_POLICY = {
  dailyTokens: 1_000_000,
  reservationTokens: 32_000,
  maxActiveRuns: 1,
};
