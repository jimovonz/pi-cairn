import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HIGH_BLAST_DEPENDENTS } from "../lib/assess.ts";
import { gatherSignals, parseFileContext, parseImpact } from "../lib/signals.ts";

/** Minimal fake ExtensionAPI: exec() answers from a fixed command->stdout map. */
function fakePi(responses: Record<string, string>) {
	return {
		exec: async (command: string, args: string[]) => {
			const key = [command, ...args].join(" ");
			const stdout = responses[key] ?? responses[`${command} *`] ?? "";
			return { stdout, stderr: "", code: stdout ? 0 : 1, killed: false };
		},
	} as unknown as Parameters<typeof gatherSignals>[0];
}

describe("parseFileContext", () => {
	it("extracts indented symbol rows with caller counts", () => {
		const out = [
			"src/a.ts — 2 symbol(s)",
			"  createFixture()  src/a.ts:10-16  [callers:0 callees:2]",
			"  NOW()  src/a.ts:11  [callers:3]",
		].join("\n");
		expect(parseFileContext(out)).toEqual([
			{ name: "createFixture", callers: 0 },
			{ name: "NOW", callers: 3 },
		]);
	});

	it("ignores headers and prose", () => {
		expect(parseFileContext("No graph data for file: x.ts")).toEqual([]);
	});
});

describe("parseImpact", () => {
	it("reads the three counts", () => {
		expect(parseImpact("callers:191 tests:118 files:13")).toEqual({ callers: 191, tests: 118, files: 13 });
	});
	it("defaults to zero on a miss", () => {
		expect(parseImpact("No graph result")).toEqual({ callers: 0, tests: 0, files: 0 });
	});
});

describe("gatherSignals", () => {
	it("returns tier-0-shaped signals for an empty diff", async () => {
		const pi = fakePi({ "git diff --numstat": "" });
		expect(await gatherSignals(pi, { cwd: "/x" })).toMatchObject({ filesChanged: 0, docsOnly: true });
	});

	it("measures max dependents and tests from the graph", async () => {
		const pi = fakePi({
			"git diff --numstat": "5\t1\tsrc/a.ts\n",
			"cairn-graph --file-context src/a.ts": "src/a.ts — 2 symbol(s)\n  hot()  src/a.ts:1-2  [callers:40]\n  cold()  src/a.ts:3  [callers:1]\n",
			"cairn-graph --impact hot": "callers:40 tests:2 files:3",
		});
		const out = await gatherSignals(pi, { cwd: "/x" });
		expect(out.maxDependents).toBe(40);
		expect(out.hasTests).toBe(true);
		expect(out.filesChanged).toBe(1);
	});

	it("raises to high blast radius when no symbol resolves", async () => {
		const pi = fakePi({
			"git diff --numstat": "5\t1\tsrc/a.ts\n",
			"cairn-graph --file-context src/a.ts": "No graph data for file: src/a.ts",
		});
		const out = await gatherSignals(pi, { cwd: "/x" });
		expect(out.maxDependents).toBe(HIGH_BLAST_DEPENDENTS);
	});

	it("freshens the graph in place when one exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "assess-"));
		mkdirSync(join(dir, ".code-review-graph"));
		writeFileSync(join(dir, ".code-review-graph", "graph.db"), "");
		const calls: string[] = [];
		const pi = {
			exec: async (command: string, args: string[]) => {
				calls.push([command, ...args].join(" "));
				const stdout = command === "git" ? "5\t1\tsrc/a.ts\n" : "";
				return { stdout, stderr: "", code: stdout ? 0 : 1, killed: false };
			},
		} as unknown as Parameters<typeof gatherSignals>[0];
		await gatherSignals(pi, { cwd: dir });
		expect(calls.some((c) => c === `crg update --repo ${dir} --skip-postprocess`)).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	it("does not freshen when no graph exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "assess-"));
		const calls: string[] = [];
		const pi = {
			exec: async (command: string, args: string[]) => {
				calls.push([command, ...args].join(" "));
				const stdout = command === "git" ? "5\t1\tsrc/a.ts\n" : "";
				return { stdout, stderr: "", code: stdout ? 0 : 1, killed: false };
			},
		} as unknown as Parameters<typeof gatherSignals>[0];
		await gatherSignals(pi, { cwd: dir });
		expect(calls.some((c) => c.startsWith("crg "))).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags a generated or lock file as a risk path", async () => {
		const pi = fakePi({
			"git diff --numstat": "1\t1\tpackages/ai/src/models.generated.ts\n",
			"cairn-graph --file-context packages/ai/src/models.generated.ts": "",
		});
		expect((await gatherSignals(pi, { cwd: "/x" })).touchesRiskPath).toBe(true);
	});
});
