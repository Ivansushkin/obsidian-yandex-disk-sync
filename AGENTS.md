# Project agent rules

## Communication and code quality

- Always communicate with the user in Russian.
- Keep this file and every future update to it in English. It is loaded in
  every session, so concise English instructions reduce token usage.
- Read the applicable files in `docs/` before making changes. The normative
  behavior catalogue is `docs/SYNC_USER_SCENARIOS.md`.
- Do not use emoji.
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
  npm run build
  ```

- `npm run build` writes release artifacts to `build/` and, when
  `YANDEX_PLUGIN_PATH` is set, copies them to the test vault.
- Never commit `build/`, `main.js`, `node_modules/`, or other generated files.
  Release assets are `main.js`, `manifest.json`, and `styles.css`.
- After code changes, run `npm test`, `npm run lint`, `npm run build`, and
  `git diff --check`.

## Synchronization architecture

- The remote source of truth is one canonical `.obsidian-sync-index.json` v3
  containing `epoch`, `revision`, file states, folder tombstones, pending moves,
  and `appliedMutationSeq`.
- Canonical commits use an exclusive move to a unique lock and back. Never
  bypass `IndexManager` transaction/recovery rules with direct writes.
- Device-local baseline and durable queues live in plugin `data.json`:
  `LocalSyncState`, pending mutations, physical actions, and watcher events.
  Persist them as one coherent snapshot through the existing persistence flow.
- One `SyncCoordinator` serializes full, realtime, Force, and encryption
  maintenance sessions. Do not add another coordinator or bypass guards.
- Detect local changes by plaintext SHA-256. Detect remote drift by server
  fingerprint, then by server mtime relative to baseline when no fingerprint
  exists. Client clocks never decide a causal winner.
- Commit a tombstone before physical deletion. A destructive remote action
  requires a fresh canonical read and a matching expected physical fingerprint.
  A failed mandatory backup blocks local overwrite or deletion.
- Exact delete beats a concurrent stale put. A new or modified descendant
  survives folder delete. A file without baseline on first sync is new.
- Empty folders are not synchronized separately.

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

## Encryption

- The remote manifest remains v2; the canonical index remains v3.
- Canonical, lock, and manifest names are raw. Canonical content and user paths
  use the active codec; the manifest is always raw.
- Enable, disable, rotate, and post-commit recovery use the existing
  `EncryptionTransitionController` over `SyncEngine` and `IndexManager`.
- Before canonical commit, source mode is authoritative. After commit, rollback
  is forbidden; target mode is authoritative and cleanup is repeatable and
  fingerprint-guarded.
- `clearIndexTransitionServices()` must run through `finally` around physical
  re-encoding.
- Passwords and OAuth tokens stay only in local plugin data. Never put them in
  logs, the canonical index, the manifest, or synchronized user files.

## Compatibility and versioning

- Concurrent use of 1.1/1.2 and 2.0 is unsupported. Legacy index v1/v2 blocks
  normal sync until explicit Force sync with backup.
- Do not change index v3, manifest v2, epoch/revision, mutation FIFO, or the
  persisted physical-action schema without a separate migration design,
  scenarios, and tests.
- On version bump, update `manifest.json`, `package.json`, `package-lock.json`,
  `versions.json`, `CHANGELOG.md`, README, README_RU, architecture docs,
  translations, and migration messages.
- Never rewrite previous beta history in `CHANGELOG.md` or `versions.json`.

## Documentation and testing

- Any synchronization algorithm change must update
  `docs/SYNC_USER_SCENARIOS.md` with a stable ID, expected canonical/local/
  physical result, and an automated or manual test reference.
- `docs/ARCHITECTURE.md` defines module boundaries and invariants.
  `docs/E2E_ENCRYPTION.md`, `docs/BACKUP.md`, `docs/CONFLICTS.md`, and
  `docs/PARALLELIZATION.md` must not contradict it.
- Network and crash tests must cover ambiguous responses, restart, idempotent
  replay, and absence of false-success logs.
- Multi-device changes must cover at least two independent local states,
  offline return, reordered events, and plaintext/encrypted modes.
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
