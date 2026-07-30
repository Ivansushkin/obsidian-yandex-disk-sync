import assert from "node:assert/strict";
import test from "node:test";
import { decideEncryptionRecovery } from "../src/crypto/encryption-transition";

test("pre-commit transition rolls back only when source is authoritative", () => {
	assert.equal(
		decideEncryptionRecovery("prepared", false, true),
		"rollback-source",
	);
	assert.equal(
		decideEncryptionRecovery("files-copied", false, true),
		"rollback-source",
	);
});

test("target-readable canonical index completes a transition around commit", () => {
	assert.equal(
		decideEncryptionRecovery("files-copied", true, false),
		"finish-target",
	);
});

test("post-commit phases never roll back", () => {
	for (const phase of ["index-committed", "stable", "cleanup"] as const) {
		assert.equal(
			decideEncryptionRecovery(phase, false, true),
			"finish-target",
		);
	}
});

test("unreadable canonical state blocks automatic recovery", () => {
	assert.equal(
		decideEncryptionRecovery("prepared", false, false),
		"blocked",
	);
});
