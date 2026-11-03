import { computeSha256 } from "../../utils/hash-utils";
import { joinPath } from "../../utils/path-utils";
import {
	getPhysicalResourceFingerprint,
	matchesPhysicalResourceFingerprint,
} from "../../utils/resource-fingerprint";
import { canApplyDestructiveFolderMutation } from "../canonical/mutation-rules";
import { sameIndexValue } from "../canonical/transaction-rules";
import type { Dependencies } from "./operations";
import {
	applyUploadedFileMetadata,
	materializeUploadedFile,
} from "./operations";

/** Finish a move's put predecessors at their original FIFO positions using surviving local paths. */
export async function settleMovePredecessors(
	deps: Dependencies,
	from: string,
	to: string,
	folder: boolean,
	persist?: (() => void | Promise<void>) | null,
): Promise<void> {
	const index = deps.indexManager;
	const pending = index.getPendingMutations();
	const boundary = pending.findIndex((item) => item.type === "move");
	const prefix = boundary < 0 ? pending : pending.slice(0, boundary);
	if (!prefix.some((item) => item.type === "put")) {
		return;
	}
	await index.refreshCanonicalForMutation();
	let staged = false;
	for (const mutation of prefix) {
		if (mutation.type === "noop") {
			index.stageMutation(mutation);
			staged = true;
			continue;
		}
		if (
			mutation.type !== "put" ||
			mutation.epoch !== index.getRemoteIndex().epoch
		) {
			break;
		}
		const localPath =
			mutation.path === from ||
			(folder && mutation.path.startsWith(`${from}/`))
				? to + mutation.path.slice(from.length)
				: mutation.path;
		if (!deps.vaultAdapter.fileExists(localPath)) {
			break;
		}
		const source = index.getRemoteIndex().files[mutation.path];
		if (
			source &&
			!canApplyDestructiveFolderMutation(
				source,
				mutation.baseRevision ?? 0,
				deps.settings.deviceId,
				mutation.seq,
			)
		) {
			break;
		}
		const content = await deps.vaultAdapter.readFile(localPath);
		const sha256 = await computeSha256(content);
		const retained = index.retargetPendingPut(
			mutation.path,
			mutation.path,
			sha256,
			mutation.baselineSha256,
		);
		if (retained?.id !== mutation.id) {
			break;
		}
		await persist?.();
		const remotePath = joinPath(deps.settings.remotePath, mutation.path);
		const physical = await deps.yandexClient.getLogicalResource(remotePath);
		const fingerprint = physical
			? getPhysicalResourceFingerprint(physical)
			: null;
		const assertAuthority = async () => {
			const guard = await deps.getSyncGuardResult(deps.validationToken);
			const current = await index.readCanonicalIndex();
			if (
				guard.blockReason ||
				current.epoch !== mutation.epoch ||
				current.maintenance ||
				!sameIndexValue(current.files[mutation.path], source)
			) {
				throw new Error("Move predecessor authority changed");
			}
			const actual =
				await deps.yandexClient.getLogicalResource(remotePath);
			if (
				physical
					? !matchesPhysicalResourceFingerprint(
							fingerprint ?? undefined,
							actual,
						)
					: actual !== null
			) {
				throw new Error("Move predecessor physical source changed");
			}
		};
		if (
			physical &&
			!matchesPhysicalResourceFingerprint(
				source?.remoteFingerprint,
				physical,
			) &&
			physical.sha256 !== sha256
		) {
			break;
		}
		const metadata =
			physical?.sha256 === sha256
				? {
						path: mutation.path,
						sha256,
						size: content.byteLength,
						mtime:
							deps.vaultAdapter.getFileMtime(localPath) ||
							Date.now(),
						syncedAt: Date.now(),
						remoteFingerprint: fingerprint ?? undefined,
						remoteMtime: Date.parse(physical.modified),
					}
				: await materializeUploadedFile(
						deps,
						mutation.path,
						{ content, sha256 },
						false,
						true,
						assertAuthority,
					);
		applyUploadedFileMetadata(deps, mutation.path, metadata, retained);
		index.stageMutation(retained);
		staged = true;
	}
	if (staged) {
		await index.saveRemoteIndex();
		index.confirmAppliedMutations();
		await persist?.();
	}
}
