/** Read-only compatibility probe for the optional account-wide Disk revision. */
const token = process.env.YANDEX_DISK_TOKEN;

if (!token) {
	process.stderr.write("YANDEX_DISK_TOKEN is required in the environment\n");
	process.exitCode = 2;
} else {
	const startedAt = performance.now();
	try {
		const response = await fetch(
			"https://cloud-api.yandex.net/v1/disk?fields=revision",
			{
				headers: { Authorization: `OAuth ${token}` },
				signal: AbortSignal.timeout(15_000),
			},
		);
		let revision = null;
		let revisionType = "unavailable";
		if (response.ok) {
			const body = await response.json();
			const value = body?.revision;
			revisionType = value === null ? "null" : typeof value;
			if (Number.isSafeInteger(value) && value >= 0) {
				revision = value;
			} else {
				process.exitCode = 1;
			}
		} else {
			process.exitCode = 1;
		}
		process.stdout.write(
			JSON.stringify({
				status: response.status,
				durationMs: Math.round(performance.now() - startedAt),
				revisionType,
				revision,
			}) + "\n",
		);
	} catch {
		process.stderr.write(
			"Disk revision probe failed before a valid response\n",
		);
		process.exitCode = 1;
	}
}
