// ─────────────────────────────────────────────────────────────────────────────
// Two lanes, split by whether a test needs a REAL EXTERNAL DEPENDENCY —
// something the merge gate cannot hand it. Today that means a browser
// (`chromium.launch()`, 12 files) or a real Redis (1 file, itself opt-in).
//
// Why: those files are slow, they contend for CPU with everything else, and
// under load they fail as *timeouts* that look exactly like real hangs — a
// parallel run once produced 37 backend failures, 15 of which were pure CPU
// starvation and passed cleanly when run alone. A merge gate that includes
// them is a gate people learn to re-run rather than trust.
//
//   unit         → everything else. Deterministic, self-contained. This is
//                  `npm test` and the CI gate.
//   integration  → the ones needing real infrastructure.
//                  `npm run test:integration`, run deliberately, NOT in the gate.
//
// The lane is chosen by FILENAME — `*.integration.test.ts` — so there is no
// hand-maintained path list to go stale. Same shape as qait-mobile-runner,
// where the suffix means "needs a real device" and CI skips it with
// `--exclude='*.integration*'`.
//
// The rule cuts both ways, and the second half is the one that gets forgotten:
// a test that needs NOTHING external must NOT carry the suffix, however
// "integration-ish" it feels. Two were misnamed and were renamed when this
// split landed (`allure-pipeline`, `apply.service.db`) — one mocks only the
// OpenAI client and runs the real parser, the other drives an in-memory
// Supabase fake. Both are deterministic and belong in the gate; leaving them
// named `.integration` would have quietly dropped them out of it.
// ─────────────────────────────────────────────────────────────────────────────

/** Everything both lanes share. Only lane selection differs. */
const common = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/jest.setup.ts'],
};

/** Matches any test needing real infrastructure, by the naming rule above. */
const INTEGRATION_LANE_PATTERN = '\\.integration\\.test\\.ts$';

module.exports = {
  projects: [
    {
      ...common,
      displayName: 'unit',
      testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
      // The testMatch above would otherwise sweep the integration files back
      // in — several live inside `__tests__/` folders.
      testPathIgnorePatterns: ['/node_modules/', INTEGRATION_LANE_PATTERN],
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['**/*.integration.test.ts'],
    },
  ],

  // Jest 29 does NOT accept `testTimeout` inside a project — it warns
  // "Unknown option" and ignores it — so this is the default for BOTH lanes and
  // the browser lane raises it from the command line instead
  // (`npm run test:integration` passes --testTimeout). Keep the low value here:
  // it is the unit lane's guard against a test that quietly starts waiting on
  // something real.
  testTimeout: 10000,

  // Coverage is configured once, at the root — per-project coverage config is
  // ignored by Jest.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/index.ts',
    '!src/worker/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: [
    'text',
    'lcov',
    'html'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  verbose: true,
};
