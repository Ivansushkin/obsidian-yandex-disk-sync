# Local replacement reception recovery

`LocalSyncState.replacementReceive` is optional device-local state. It changes no
canonical, manifest, plugin-data marker, FIFO, or physical-action schema. Older
builds reject this field; downgrade during unfinished reception is unsupported.

The receipt records operation ID, epoch, frozen scope, initial plaintext hashes,
applied target hashes, and watcher ID/signature boundary. It contains no bytes or
credentials. Coherent saves precede destructive reception and follow each applied
target; failed reception retains the receipt and previous causal baseline.

Recovery keeps the scope and original watcher boundary. A newer operation inherits
original and applied hashes without recapturing late local bytes. Only unchanged
originals may be removed or overwritten; changed, moved, and new paths survive.
Applied targets are not rewritten over later edits. Canonical targets become the
baseline; survivors are ordinary local work. Final save retires the receipt and
acknowledges only unchanged covered signatures; failed save retains it.

Changed structural blockers use the existing conflict-copy reservation outside the
blocking root. Before native deletion, each attempt rechecks source/copy hashes,
descendants, and scoped raw-event generation. New descendants defer deletion;
excluded descendants block it. Retry rechecks the copy before removing the last
original. Ordinary full publishes retained copies after adoption.
