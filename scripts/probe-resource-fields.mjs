/** Compare response size and read latency without exposing resource metadata. */
const token = process.env.YANDEX_DISK_TOKEN;
const remotePath = process.env.YANDEX_DISK_PROBE_PATH || "disk:/";
const fields = [
	"path",
	"type",
	"name",
	"created",
	"modified",
	"resource_id",
	"_embedded.total",
	"_embedded.limit",
	"_embedded.offset",
	"_embedded.items.path",
	"_embedded.items.type",
	"_embedded.items.name",
	"_embedded.items.created",
	"_embedded.items.modified",
	"_embedded.items.size",
	"_embedded.items.md5",
	"_embedded.items.sha256",
	"_embedded.items.resource_id",
].join(",");

if (!token) {
	process.stderr.write("YANDEX_DISK_TOKEN is required in the environment\n");
	process.exitCode = 2;
} else {
	const samples = { full: [], projected: [] };
	try {
		for (let i = 0; i < 5; i++) {
			for (const mode of i % 2 === 0
				? ["full", "projected"]
				: ["projected", "full"]) {
				const url = new URL(
					"https://cloud-api.yandex.net/v1/disk/resources",
				);
				url.searchParams.set("path", remotePath);
				url.searchParams.set("limit", "1000");
				url.searchParams.set("offset", "0");
				if (mode === "projected") {
					url.searchParams.set("fields", fields);
				}
				const startedAt = performance.now();
				const response = await fetch(url, {
					headers: { Authorization: `OAuth ${token}` },
					signal: AbortSignal.timeout(15_000),
				});
				if (!response.ok) {
					process.stdout.write(
						JSON.stringify({ mode, status: response.status }) +
							"\n",
					);
					process.exitCode = 1;
					break;
				}
				const bytes = (await response.arrayBuffer()).byteLength;
				samples[mode].push({
					bytes,
					durationMs: Math.round(performance.now() - startedAt),
				});
			}
			if (process.exitCode) {
				break;
			}
		}
		if (!process.exitCode) {
			process.stdout.write(JSON.stringify(samples) + "\n");
		}
	} catch {
		process.stderr.write(
			"Resource fields probe failed before a valid response\n",
		);
		process.exitCode = 1;
	}
}
