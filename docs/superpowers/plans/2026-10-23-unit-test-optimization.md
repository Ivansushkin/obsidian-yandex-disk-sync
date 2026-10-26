# Unit Test Optimization Implementation Plan

> Execute scoped test-only tasks in parallel, then review the combined result.

**Goal:** Reduce the default unit suite from 519 to at most 363 executable cases (at least 30%), with less fixture/setup duplication and retained safety boundaries.

**Architecture:** Remove trivial or demonstrably redundant checks; use small input/output tables for equivalent algorithm variants. Keep independent race, crash/restart, multi-device, and plaintext/encrypted workflow coverage. Production algorithms and the test runner remain unchanged.

**Tech Stack:** TypeScript, node:test, node:assert, esbuild, ESLint, Prettier.

**Spec:** User request and AGENTS.md testing policy; docs/SYNC_USER_SCENARIOS.md and docs/ARCHITECTURE.md define the protected behavior.

## Constraints

- Preserve the existing staged/unstaged work and do not commit.
- Do not reduce counts through skips, runner exclusions, or opaque test concatenation.
- Retain useful assertion messages for table rows.
- Every removed catalog reference must resolve to a retained equivalent check or explicit manual evidence.
- Initial passing baseline: 519/519; 48 default test files. Baseline sources and metrics: /private/tmp/obsidian-unit-optimization-20261023.

## Tasks

- [x] Consolidate pure conflict/causality/physical/realtime rule tests; record removed-to-retained evidence.
- [x] Consolidate canonical schema and transaction tests, preserving ambiguous transport/recovery boundaries.
- [x] Consolidate backup/encryption/transport tests, preserving cryptographic vectors and security rejection behavior.
- [x] Review controller, lifecycle and utility checks; remove trivial/duplicated checks and compact repeated fixtures.
- [x] Update scenario test references, review the full task-only diff, and measure cases plus source size.
- [x] Run npm run lint:fix, npm run format, npm test, npm run lint, npm run build, npm run format:check, and git diff --check. Suppress build output before capture because its trusted script reads ignored local configuration.

## Review focus

Retain destructive authority revocation, wrong-key/ciphertext failures, coherent FIFO persistence, late writes after unload, and independent-device/offline recovery. Tables must not combine state across rows. Passing unit checks do not establish real Obsidian/Yandex validation.

## Completion evidence

- Default suite: 519 -> 361 cases (-30.44%); 361/361 pass, zero skips.
- Files: 48 -> 48; test bytes: 569809 -> 538544 (-5.49%).
- Required lint/fix, format, TypeScript/build and diff checks passed. Build required the approved execution path after sandbox failure.
- Independent review corrected lost distinct-SHA pending puts, missing-source receipt replay, persisted rename handoff and wrong-current-password backup authentication checks.
- No production algorithm or runner change; no commits/staging. Existing concurrent initial-receive work remains outside the optimization.
- See ../../TEST_OPTIMIZATION.md for metrics and evidence limits.
