export const obsidianStubPlugin = {
	name: "obsidian-test-stub",
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({
			path: "obsidian-test-stub",
			namespace: "test",
		}));
		build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
			contents: `
					export class App {}
					export class Vault {}
					export class Plugin {}
					export class Component {}
					export class ItemView {}
					export const Platform = { isMobile: false };
					export class Modal { open() {} close() {} }
					export class PluginSettingTab {}
					export class Setting {}
					export class Notice {
						constructor(message) { this.message = message; this.noticeEl = { isConnected: true }; this.messageEl = this.noticeEl; }
						setMessage(message) { this.message = message; }
						hide() { this.noticeEl.isConnected = false; }
					}
					export class ButtonComponent {}
					export class TextAreaComponent {}
					export class TextComponent {}
					export class ToggleComponent {}
					export async function requestUrl(params) {
						if (globalThis.__obsidianRequestUrl) {
							return await globalThis.__obsidianRequestUrl(params);
						}
						throw new Error("Unexpected Obsidian requestUrl call in unit test");
					}
					export function normalizePath(path) {
						return path
							.split("\\\\")
							.join("/")
							.split("/")
							.filter(Boolean)
							.join("/");
					}
					export class TFile {}
				export class TFolder {}
					export function setIcon() {}
					export function setTooltip() {}
				`,
			loader: "js",
		}));
	},
};
