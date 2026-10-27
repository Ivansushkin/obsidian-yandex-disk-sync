import type { TestContext } from "node:test";

type Cleanup = () => void | Promise<void>;

/** Use native teardown with the project's older Node declaration package. */
export function afterTest(context: TestContext, cleanup: Cleanup) {
	(context as TestContext & { after(cleanup: Cleanup): void }).after(cleanup);
}
