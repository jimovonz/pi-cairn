import { describe, expect, it } from "vitest";
import { run, runText } from "../lib/bridge.ts";

/** Minimal stand-in for the slice of ExtensionAPI that bridge.ts touches. */
function stubPi(exec: (command: string, args: string[], options?: unknown) => Promise<unknown>) {
	return { exec } as never;
}

describe("bridge.run", () => {
	it("reports not-ok for empty stdout even when the process exits 0", async () => {
		// This is the pi_bridge.py failure mode: every subcommand swallows its
		// exceptions and exits 0, so exit status carries no information at all.
		const pi = stubPi(async () => ({ stdout: "", stderr: "boom", code: 0, killed: false }));
		const result = await run(pi, "python3", ["whatever"]);
		expect(result.code).toBe(0);
		expect(result.ok).toBe(false);
	});

	it("reports ok when stdout has content", async () => {
		const pi = stubPi(async () => ({ stdout: "some output\n", stderr: "", code: 0, killed: false }));
		const result = await run(pi, "python3", ["whatever"]);
		expect(result.ok).toBe(true);
	});

	it("treats whitespace-only stdout as not-ok", async () => {
		const pi = stubPi(async () => ({ stdout: "  \n\t\n", stderr: "", code: 0, killed: false }));
		expect((await run(pi, "python3", [])).ok).toBe(false);
	});

	it("never throws when exec rejects", async () => {
		// A throw here would reach a tool_call handler and deny the tool outright.
		const pi = stubPi(async () => {
			throw new Error("ENOENT");
		});
		const result = await run(pi, "nope", []);
		expect(result.errored).toBe(true);
		expect(result.ok).toBe(false);
		expect(result.stderr).toContain("ENOENT");
	});

	it("passes a timeout so a hung bridge cannot stall the turn", async () => {
		let seen: { timeout?: number } | undefined;
		const pi = stubPi(async (_c, _a, options) => {
			seen = options as { timeout?: number };
			return { stdout: "x", stderr: "", code: 0, killed: false };
		});
		await run(pi, "python3", [], { timeoutMs: 1234 });
		expect(seen?.timeout).toBe(1234);
	});
});

describe("bridge.runText", () => {
	it("returns trimmed stdout on success and empty string on failure", async () => {
		const good = stubPi(async () => ({ stdout: "  hello  \n", stderr: "", code: 0, killed: false }));
		expect(await runText(good, "x", [])).toBe("hello");

		const bad = stubPi(async () => {
			throw new Error("nope");
		});
		expect(await runText(bad, "x", [])).toBe("");
	});
});
