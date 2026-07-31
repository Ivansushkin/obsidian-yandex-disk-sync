import assert from "node:assert/strict";
import test from "node:test";
import type { YandexResource } from "../src/types";
import {
	getPhysicalResourceFingerprint,
	getStableContentFingerprint,
	matchesPhysicalResourceFingerprint,
} from "../src/utils/resource-fingerprint";

function createResource(
	overrides: Partial<YandexResource> = {},
): YandexResource {
	return {
		path: "disk:/vault/note.md",
		name: "note.md",
		type: "file",
		created: "2026-07-31T00:00:00Z",
		modified: "2026-07-31T00:00:01Z",
		size: 10,
		...overrides,
	};
}

test("physical fingerprints accept every beta.7 server identity", () => {
	const resource = createResource({
		sha256: "sha-value",
		md5: "md5-value",
		resource_id: "resource-value",
	});
	assert.equal(getPhysicalResourceFingerprint(resource), "sha-value");
	for (const expected of [
		"sha-value",
		"md5-value",
		"resource-value",
		resource.modified,
	]) {
		assert.equal(
			matchesPhysicalResourceFingerprint(expected, resource),
			true,
		);
	}
	assert.equal(
		matchesPhysicalResourceFingerprint("changed", resource),
		false,
	);
});

test("service fingerprint never accepts resource id as content identity", () => {
	const resource = createResource({
		modified: "",
		resource_id: "stable-path-id",
	});
	assert.equal(getStableContentFingerprint(resource), null);
});
