// Report-only dependency baseline (CORE.0): cycles and layer direction from the review (A2/A3).
// Target direction: contracts <- store <- runtime <- apps; production code never imports tests or docs.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'warn', from: {}, to: { circular: true } },
    {
      name: 'production-imports-tests',
      severity: 'warn',
      from: { path: '^(apps|packages)/' },
      to: { path: '^tests/' },
    },
    {
      name: 'code-imports-docs',
      severity: 'warn',
      from: { path: '^(apps|packages)/' },
      to: { path: '^docs/' },
    },
    {
      name: 'contracts-depends-on-implementation',
      severity: 'warn',
      from: { path: '^packages/contracts/' },
      to: { path: '^packages/(store|runtime|workspace|verification|backup)/' },
    },
    {
      name: 'store-depends-on-runtime',
      severity: 'warn',
      from: { path: '^packages/store/' },
      to: { path: '^packages/runtime/' },
    },
    {
      name: 'packages-depend-on-apps',
      severity: 'warn',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(^|/)(node_modules|build|\\.local|refs)/|packages/codex-adapter/src/generated/',
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
