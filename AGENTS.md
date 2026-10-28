# Project agent rules

## Communication and code quality

- Always communicate with the user in Russian.
- Keep this file and every future update to it in English. It is loaded in
  every session, so concise English instructions reduce token usage.
- Read the applicable files in `docs/` before making changes. The normative
  behavior catalogue is `docs/SYNC_USER_SCENARIOS.md`.
- Do not use emoji.
- Always use braces for control-flow bodies, including single-line `if`/`else`.
- Use ESLint for code rules and Prettier for formatting. Run `npm run lint:fix`
  and `npm run format` after edits; never disable the pre-commit hook.
- Write concise, useful English JSDoc for non-trivial functions and classes.
- Do not add comments that merely restate code. Avoid deeply nested control flow.
- Reuse existing coordinator, store, transaction, and utility modules first.
  A new abstraction must have at least two independent call sites and must not
  duplicate an existing domain model.

## Project and tooling

- This is an Obsidian Community Plugin. TypeScript in `src/` is bundled by
  esbuild into `build/main.js`.
- `src/main.ts` is the composition root and owns lifecycle/UI wrappers. Do not
  add new domain logic there. Move touched sync, index transaction, watcher,
  backup, and encryption workflows into their focused modules while preserving
  existing contracts.
- Use npm only.
- Main commands:

  ```bash
  npm install
  npm test
  npm run lint
  npm run format:check
  npm run build
  ```

- `npm run build` writes release artifacts to `build/` and loads the optional
  test-vault destination from the ignored root `.env`. Do not use a shell
  `YANDEX_PLUGIN_PATH`; copy `.env.example` to `.env` instead.
- Never commit `build/`, `main.js`, `node_modules/`, or other generated files.
  Release assets are `main.js`, `manifest.json`, and `styles.css`.
- After code changes, run `npm test`, `npm run lint`, `npm run build`, and
  `npm run format:check`, then `git diff --check`.
- `npm install` installs Husky hooks through `prepare`. The pre-commit hook
  runs lint-staged: ESLint fixes code before Prettier formats staged files;
  unstaged hunks are preserved. Non-fixable lint errors block the commit.

## Synchronization architecture

- The remote source of truth is one canonical `.obsidian-sync-index.json` with
  `format: "sync-index"`, `epoch`, `revision`, file states, folder tombstones,
  pending moves, and `appliedMutationSeq`.
- Ordinary canonical commits use an exclusive move to a unique lock and back.
  Confirmed direct Force is the explicit exception: IndexManager validates,
  deletes/recreates and verifies the final canonical path without any temporary
  file, lease or MOVE. Never publish canonical outside IndexManager.
- A `CanonicalCommitProof` is ephemeral and may skip an index download only
  after a stable hash-matching root listing. It never authorizes a physical
  write; re-read canonical and revalidate encryption before corrective upload.
- Device-local baseline and durable queues live in plugin `data.json`:
  `LocalSyncState`, pending mutations, physical actions, and watcher events.
  Persist them as one coherent snapshot through the existing persistence flow.
- One `SyncCoordinator` serializes full, realtime, Force, and encryption
  maintenance sessions. Do not add another coordinator or bypass guards.
- Detect local changes by plaintext SHA-256. Detect remote drift by server
  fingerprint, then by server mtime relative to baseline when no fingerprint
  exists. Client clocks never decide a causal winner.
- Ordinary sync commits a tombstone before physical deletion. Confirmed Force
  publishes its own durable intent before replacing the syncable destination.
  Ordinary destructive remote actions require fresh canonical/operation authority
  and a matching expected physical fingerprint. Direct Force deliberately ignores
  destination authority and fingerprints, replaces the selected destination and
  copies its readable source directly while preserving excluded/protected paths. See docs/FORCE_SYNC.md.
  A failed mandatory backup blocks ordinary-sync local overwrite or deletion. Confirmed Force uses its explicit per-run backup policy.
- Exact delete beats a concurrent stale put. A new or modified descendant
  survives folder delete. Initial device connection receives canonical versions with protective copies;
  after connection, a file without baseline is new.
- Ordinary sync does not synchronize empty folders separately. Direct Force copies them.

## Fingerprints and paths

- For service files, use the strict stable content identity from
  `utils/resource-fingerprint.ts`: `sha256 -> md5 -> modified+size`.
  `resource_id` does not prove unchanged service content.
- For physical user resources, use the shared physical fingerprint helpers.
  The matcher must accept persisted SHA-256, MD5, resource ID, and modified
  values without queue migration.
- Service paths, `.backup`, and this plugin's own directory are protected by
  `path-utils`. Do not add local variants of path filtering.
- Use the shared `path-utils` helper for ancestor directories and deepest-first
  cleanup.
- Treat the remote-folder cache as an observation only. Invalidate it after
  delete/move and token, remote-path, or encryption-codec changes; recover a
  missing cached parent only from 404, never from an exclusive 409.

## Encryption

- The current remote manifest has `format: "encryption-manifest"`; the current
  canonical has `format: "sync-index"`. Numeric current format versions are
  forbidden.
- Canonical, lock, and manifest names are raw. Canonical content and user paths
  use the active codec; the manifest is always raw.
- Enable, disable, rotate, and post-commit recovery use the existing
  `EncryptionTransitionController` over `SyncEngine` and `IndexManager`.
- Before canonical commit, source mode is authoritative. After commit, rollback
  is forbidden; target mode is authoritative and cleanup is repeatable.
- New enable/disable/rotate runs explicitly replace the initiating local snapshot
  within frozen sync filters. Their durable replacement descriptor and fresh epoch
  authorize recursive cleanup; stale devices receive that reference before merge.
  Preserve protected/excluded raw resources and verified target bytes. Legacy
  checkpoints without the descriptor retain fingerprint guards and their epoch.
- Every cleanup attempt revalidates authority and lifetime; rejected guards never
  acknowledge absence. Join admitted writes before recovery. Revocation cannot
  start automatic recovery under a new configuration. See docs/E2E_ENCRYPTION.md.
- `clearIndexTransitionServices()` must run through `finally` around physical
  re-encoding.
- Passwords and OAuth tokens stay only in local plugin data. Never put them in
  logs, the canonical index, the manifest, or synchronized user files.

## Compatibility and versioning

- Concurrent use of older builds and 2.0.0 is unsupported. Only plaintext
  stable 1.0/1.1 local data and their numeric canonical formats are migratable;
  encrypted legacy data and every other historical format fail closed.
- Stable plaintext 1.0/1.1 local migration is irreversible. Persist one coherent
  current snapshot after installation identity initialization and before automation.
  A failed initial save blocks sync and unload must not retry it.
- Direct Force honors shared protected paths, user include/exclude filters and the
  configuration sync switch in both source reads and destination cleanup. Preserve
  .backup and the local running sync plugin/state;
  never upload its credentials. Rebuild canonical; authenticate encrypted destination names before scoped cleanup.
  Reuse its codec when encryption remains enabled so excluded ciphertext stays
  readable; reject codec removal that would strand it. Preserve or rebuild the
  encryption manifest only to match authenticated source/output parameters.
- Force offers one confirmation with an archive toggle off by default. A selected
  archive must succeed before purge; errors stay in that dialog. Force never
  creates staging, locks, trash or protective/conflict copies.
- Force continues independent actions after individual errors and persists a
  direct-v1 remainder. Ordinary manual/startup/scheduled full resumes it before
  normal merge, without repeating a completed broad purge. Legacy checkpoints
  must never be silently widened; a new full Force requires confirmation.
- Force does not require stopping other devices and provides no server fencing.
  Source read/decryption failure is never an empty source. Connection changes and
  unload stop further writes. Success requires verified output and persistence.
- Encryption transitions retain their independent per-run archive choice.
- Startup blocks are non-persisted and typed. Confirmed Force validates its
  selected readable source independently of normal startup admission. Destination
  encryption, historical metadata, baseline, tombstones and queues cannot choose
  the winner. Source authentication/decryption/read failures must never imply empty.
  Load local state and register lifecycle callbacks before token/remote checks.
- Do not change the `sync-index`, `encryption-manifest`, or `plugin-data`
  markers, profile `hardened`, epoch/revision, mutation FIFO, or the persisted
  physical-action schema without a separate migration design, scenarios, and
  appropriate automated or manual verification. Force recovery is an explicit
  local checkpoint and a separate canonical maintenance kind; never impersonate
  an encryption transition. Preserve its operation ID and epoch across recovery.
- On version bump, update `manifest.json`, `package.json`, `package-lock.json`,
  `versions.json`, `CHANGELOG.md`, README, README_RU, architecture docs,
  translations, and migration messages.
- Release metadata retains stable 1.1.0 compatibility and published 2.0.0
  history, plus the current 2.1.0 entry. Do not add development entries or
  remove historical stable releases.

## Documentation and testing

- Bulk generation of unit tests is prohibited. Do not add a test for every
  function, branch, or change, or increase test counts to chase coverage.
- Unit tests are allowed only for complex algorithms in functions or their
  interactions: causality, concurrency, transactions, recovery, data
  transformation, and data preservation.
- Before adding a test, identify the concrete failure it detects and confirm
  that existing tests do not cover the same failure at the same boundary.
- Keep only the minimum distinct scenarios, small fixtures, and outcome
  assertions. Combine equivalent variants in readable tables. Compact means
  less setup and duplication, not compressed lines or hidden test logic.
- Do not unit-test trivial wrappers, formatting, UI wording, obvious
  assignments, or implementation details. Do not build large UI mocks.
- Execute real project algorithms. Mock call counts alone are not evidence;
  assert call order only when it is necessary for correctness.
- A bug fix does not automatically require a new unit test. Validate user
  behavior with an appropriate functional check instead.
- Passing unit tests do not prove that the plugin works in Obsidian.

- Any synchronization algorithm change must update
  `docs/SYNC_USER_SCENARIOS.md` with a stable ID, expected canonical/local/
  physical result, and an automated or manual test reference.
- `docs/ARCHITECTURE.md` defines module boundaries and invariants.
  `docs/E2E_ENCRYPTION.md`, `docs/BACKUP.md`, `docs/CONFLICTS.md`, and
  `docs/PARALLELIZATION.md` must not contradict it.
- Network and crash tests must cover ambiguous responses, restart, idempotent
  replay, and absence of false-success logs.
- Validate multi-device changes with at least two independent local states,
  offline return, reordered events, and plaintext/encrypted modes. Use focused
  algorithm tests or functional checks; do not generate a unit-test matrix
  for every change.
- A release requires a manual run with two Obsidian profiles against real
  Yandex Disk. Automated tests do not replace it.

## Obsidian and security

- Use browser-compatible Obsidian APIs. Do not add Node/Electron runtime APIs
  without changing `isDesktopOnly` and documenting the reason.
- Register and clean up listeners and intervals through the Obsidian plugin
  lifecycle.
- Do not execute remote code or add telemetry.
- Never log tokens, passwords, keys, ciphertext, file contents, or the full
  canonical index. Use safe IDs, sizes, and short SHA-256 values.
- `manifest.json.id` is a stable API and must not change.
