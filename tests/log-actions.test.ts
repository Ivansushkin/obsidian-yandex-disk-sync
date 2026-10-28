import assert from "node:assert/strict";
import test from "node:test";
import { copyLogTail } from "../src/ui/log-actions";
import { deferred } from "./helpers/deferred";

class DeferredClipboardItem {
	constructor(readonly data: Record<string, Promise<Blob>>) {}
}

test("log copy preserves tap activation and the exact tail across native fallback", async () => {
	for (const rejectNative of [false, true]) {
		const source = deferred<string>();
		let clipboard = "retained clipboard";
		let nativeStarted = false;
		const win = {
			ClipboardItem: DeferredClipboardItem,
			navigator: {
				clipboard: {
					async write(items: DeferredClipboardItem[]) {
						nativeStarted = true;
						if (rejectNative) {
							throw new Error("Native clipboard unavailable");
						}
						clipboard = await (
							await items[0]!.data["text/plain"]!
						).text();
					},
					async writeText(text: string) {
						clipboard = text;
					},
				},
			},
		} as unknown as Window;
		const copying = copyLogTail(win, () => source.promise);
		assert.equal(nativeStarted, true);
		assert.equal(clipboard, "retained clipboard");
		source.resolve("discarded prefix" + "я".repeat(3996) + "end\n");
		assert.equal(await copying, 4000);
		assert.equal(clipboard, "я".repeat(3996) + "end\n");
	}
});

test("empty or retired log reads never replace the clipboard", async () => {
	for (const native of [false, true]) {
		for (const close of [false, true]) {
			const source = deferred<string>();
			let current = true;
			let clipboard = "retained clipboard";
			const win = {
				ClipboardItem: native ? DeferredClipboardItem : undefined,
				navigator: {
					clipboard: {
						async write(items: DeferredClipboardItem[]) {
							clipboard = await (
								await items[0]!.data["text/plain"]!
							).text();
						},
						async writeText(text: string) {
							clipboard = text;
						},
					},
				},
			} as unknown as Window;
			const copying = copyLogTail(
				win,
				() => source.promise,
				() => current,
			);
			current = !close;
			source.resolve(close ? "late entries" : " \n");
			assert.equal(await copying, close ? null : 0);
			assert.equal(clipboard, "retained clipboard");
		}
	}
});
