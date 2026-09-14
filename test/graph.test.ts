import { afterEach, beforeEach, describe, expect, it } from "vitest";
import graphExtension from "../extensions/graph.ts";

interface Tool {
	name: string;
	promptSnippet?: string;
	execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{
		content: { type: string; text: string }[];
		isError?: boolean;
	}>;
}

function harness(stdout: string, stderr = "") {
	const tools: Tool[] = [];
	const calls: string[][] = [];
	const pi = {
		on: () => {},
		registerTool: (tool: Tool) => tools.push(tool),
		async exec(_command: string, args: string[]) {
			calls.push(args);
			return { stdout, stderr, code: stdout ? 0 : 1, killed: false };
		},
	};
	return { pi, tools, calls, ctx: { cwd: "/tmp" } };
}

describe("graph extension", () => {
	beforeEach(() => {
		process.env.PI_GRAPH = "1";
	});
	afterEach(() => {
		delete process.env.PI_GRAPH;
	});

	it("stays inert unless PI_GRAPH is set", () => {
		delete process.env.PI_GRAPH;
		const h = harness("");
		graphExtension(h.pi as never);
		expect(h.tools).toHaveLength(0);
	});

	it("registers code_graph with a promptSnippet so the model is told it exists", () => {
		const h = harness("");
		graphExtension(h.pi as never);
		expect(h.tools.map((t) => t.name)).toEqual(["code_graph"]);
		expect(h.tools[0].promptSnippet).toBeTruthy();
	});

	it("passes the mode as a flag and the target positionally", async () => {
		const h = harness("lib/bridge.ts:54-85");
		graphExtension(h.pi as never);
		await h.tools[0].execute("t", { mode: "location", target: "run" }, undefined, undefined, h.ctx);
		expect(h.calls[0]).toEqual(["--location", "run"]);
	});

	it("omits the target for repo-level modes", async () => {
		const h = harness("Nodes: 10");
		graphExtension(h.pi as never);
		await h.tools[0].execute("t", { mode: "summary" }, undefined, undefined, h.ctx);
		expect(h.calls[0]).toEqual(["--summary"]);
	});

	it("rejects a symbol mode with no target instead of shelling out", async () => {
		const h = harness("");
		graphExtension(h.pi as never);
		const result = await h.tools[0].execute("t", { mode: "location" }, undefined, undefined, h.ctx);
		expect(result.isError).toBe(true);
		expect(h.calls).toHaveLength(0);
	});

	it("suggests a fallback rather than erroring when a symbol is not indexed", async () => {
		// A graph miss should send the model to grep, not make it retry the graph.
		const h = harness("");
		graphExtension(h.pi as never);
		const result = await h.tools[0].execute("t", { mode: "location", target: "nope" }, undefined, undefined, h.ctx);
		expect(result.isError).toBe(false);
		expect(result.content[0].text).toMatch(/grep/);
	});
});
