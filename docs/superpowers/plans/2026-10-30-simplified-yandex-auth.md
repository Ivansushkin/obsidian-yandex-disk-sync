# Simplified Yandex authorization implementation plan

## Goal and decisions

Implement the approved chat plan: OAuth is the fresh-install default, existing manual credentials remain working, manual setup stays optional, and migration preserves storage identity, local history, queues, encryption and user settings. An explicit sign-in-and-sync action continues through the existing manual full sync. Use external-browser PKCE S256 with a protocol callback and a manual-code fallback. Pending authorization is memory-only and must restart after process termination.

The implementation branch starts at freshly fetched origin/master d6ebcd99666cc379e612c5027206381497fa6e94. Do not change release versions, canonical formats, physical-action formats, credentials storage policy, or the remote root. No server and no embedded client secret.

## Provider gate

The owner must supply the public Client ID of an application suitable for third-party users and confirm callback/code routes and read/write Disk scopes. Never use another project's application. Initial exchange must work without a secret. Enable callback only on verified platforms; otherwise use the verification-code route. Implement refresh only after public-client refresh is verified; otherwise require interactive reauthentication and do not persist an unusable refresh token. Until the application is available, do not falsely advertise a functioning shared login or claim provider/device acceptance. Continue independent implementation and report the external release gate.

## Task 1: Authentication state and coherent persistence

- Add compatible local auth method and OAuth metadata while retaining yandexTokenSecret as the only access-token field. Existing token/client-ID data infer manual; fresh state infers OAuth. Invalid explicit metadata fails closed.
- Add a narrow authenticated-credentials persistence operation with generation guards. Keep the single snapshot queue. After a successful credentials save, subsequent internal/unload snapshots retain the latest committed authentication tuple even when runtime publication was revoked by unload; retain newest watcher/causal state.
- Manual token changes clear OAuth metadata atomically. Activation remains owned by completeManualSync. Failed saves block publication and automation without claiming the disk was unchanged.
- RED/GREEN: loader compatibility and actual persistence interaction, including unload before publication and an internal save queued beside auth-save. Existing tests cover ordinary settings failures; do not duplicate those wholesale.

## Task 2: OAuth state machine and candidate adoption

- Focused controller outside main.ts: begin, accept callback, submit code, cancel/dispose, observable state. Injectable transport/time/host ports; no second coordinator or generic HTTP layer.
- One attempt; 10-minute lifetime; state/verifier in memory. Reserve exchange synchronously, reject replay, ignore foreign state without cancelling the valid attempt. Fallback starts a new attempt. Timeout 30 seconds; no automatic one-time-code POST retries; retain native in-flight ownership until real settlement.
- Candidate stays separate from live credentials. Freeze new automatic sends while observing/persisting local events, without occupying a sync coordinator. Wait for active/queued work, foreground operations and unresolved native Disk writes.
- A dedicated adoption workflow owns the existing configuration lock itself, drains watcher persistence before entering the snapshot queue, validates current context and candidate root metadata, then saves/publishes. Same path plus resource_id is mandatory for seamless migration; missing/wrong/unavailable roots do not create a new destination. History without root identity requires normal explicit binding, never silent reset.
- Before accepted save, cancellation preserves old authorization and restores its admission. After accepted save, cancellation is disabled; pause cancels full continuation but not accepted credentials, unload forbids runtime publication. Success starts one manual full outside the configuration lock. Failed full keeps the new login pending manual activation.
- Stable OAuth device_id derives from the existing installation actor, without changing that actor. Never log codes, state URLs, verifiers, bundles or raw OAuth errors. Host logging is outside plugin guarantees.
- RED/GREEN: attempt isolation, late/unresolved transports, candidate root rejection, reservation/admission, and safe error outcomes.

## Task 3: Lifecycle and settings integration

- main.ts only composes the controller and workflow. Lifecycle registers protocol handlers and cleans timers/listeners. Combine authorization admission with mobile admission on desktop/mobile rather than overwriting either callback.
- New first setup shows sign-in-and-sync; existing manual users stay manual and get an optional migration action. UI method choice is a draft, never an implicit credential change. Manual draft over active OAuth must not display its access token next to a legacy Client ID.
- Existing explicit/manual, scheduler, watcher, Force, backup and encryption entrypoints respect pending adoption. Cancellation and fallback controls remain usable while authorization is pending. Closing Settings does not lose the attempt; unknown cold callbacks prompt a fresh login.
- Existing authorization metadata after restart shows continue-sync rather than forcing another login. Preserve all existing startup/persistence/legacy/encryption blocks.
- If provider refresh is verified, coalesce it between operations, persist before publication, retain pause/manual-admission state, invalidate observations and run one ordinary automatic full before realtime resumes. Never replay an old write/Force transparently.
- RED/GREEN: successful connection/migration delegates once to real full activation; failures do not enable automation; two-state offline scenario in plaintext/encrypted modes. Avoid UI mocks.

## Task 4: Documentation, verification and review

- Add stable AUTH-001 through AUTH-016 scenarios, expected local/canonical/physical effects, and exact automated/manual references. Update architecture, smoke instructions, stable README setup and all supported translations. No release version bump.
- Keep tests grouped around distinct protocol/concurrency/persistence/data-preservation failures. Reuse existing lifecycle, MemoryDisk and sync fixtures. No unit tests for wording, trivial wrappers or source text.
- Run npm run lint:fix, npm run format, npm test, npm run lint, npm run build, npm run format:check and git diff --check. Build may use the existing ignored .env internally; never read its contents and suppress unsafe output before capture.
- Whole-branch independent review after implementation; correct meaningful findings and run appropriate checks. Do not push, merge or publish without a user request.
- Real acceptance remains required: owned OAuth app and a second account; desktop/Android/iOS callback and fallback, process kill, cancellation and same-name vault routing; two profiles, mixed auth methods, offline return and plaintext/encrypted storage. Never replace that evidence with unit results.
