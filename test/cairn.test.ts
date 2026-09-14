import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cairnExtension from "../extensions/cairn.ts";

interface Handlers {
	[event: string]: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
}

/**
 * Stub pi. `execHandler` receives the pi_bridge subcommand (argv[1]) so a test can
 * decide what each of spec/retrieve/capture/enforce returns.
 */
function harness(execHandler: (subcommand: string) => string) {
	const handlers: Handlers = {};
	const tools: { name: string; promptSnippet?: string }[] = [];
	const followUps: string[] = [];
	const execCalls: string[][] = [];

	const pi = {
		on(event: string, handler: Handlers[string]) {
			handlers[event] = handler;
		},
		registerTool(tool: { name: string; promptSnippet?: string }) {
			tools.push(tool);
		},
		async exec(_command: string, args: string[]) {
			execCalls.push(args);
			return { stdout: execHandler(args[1] ?? ""), stderr: "", code: 0, killed: false };
		},
		sendUserMessage(text: string) {
			followUps.push(text);
		},
	};

	const ctx = {
		cwd: "/tmp/project",
		sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => "/tmp/sess.jsonl" },
	};

	return { pi, ctx, handlers, tools, followUps, execCalls };
}

const assistantReply = (text: string) => ({ type: "agent_end", messages: [{ role: "assistant", content: text }] });

describe("cairn extension", () => {
	beforeEach(() => {
		process.env.PI_CAIRN = "1";
	});
	afterEach(() => {
		delete process.env.PI_CAIRN;
	});

	it("stays completely inert unless PI_CAIRN is set", () => {
		delete process.env.PI_CAIRN;
		const h = harness(() => "");
		cairnExtension(h.pi as never);
		expect(Object.keys(h.handlers)).toHaveLength(0);
		expect(h.tools).toHaveLength(0);
	});

	it("registers the two handlers and the query tool when enabled", () => {
		const h = harness(() => "");
		cairnExtension(h.pi as never);
		expect(Object.keys(h.handlers).sort()).toEqual(["agent_end", "before_agent_start"]);
		expect(h.tools.map((t) => t.name)).toEqual(["cairn_query"]);
	});

	it("gives cairn_query a promptSnippet so the model is told it exists", () => {
		// Without this the tool is invisible in the system prompt's tool list.
		const h = harness(() => "");
		cairnExtension(h.pi as never);
		expect(h.tools[0]?.promptSnippet).toBeTruthy();
	});

	it("always passes --cwd, without which retrieval silently goes global-only", async () => {
		const h = harness(() => "out");
		cairnExtension(h.pi as never);
		await h.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "hi", systemPrompt: "BASE" }, h.ctx);
		const retrieve = h.execCalls.find((args) => args[1] === "retrieve");
		expect(retrieve).toBeDefined();
		expect(retrieve).toContain("--cwd");
		expect(retrieve?.[retrieve.indexOf("--cwd") + 1]).toBe("/tmp/project");
	});

	it("appends the spec to the system prompt rather than replacing it", async () => {
		const h = harness((sub) => (sub === "spec" ? "SPEC-TEXT" : ""));
		cairnExtension(h.pi as never);
		const result = (await h.handlers.before_agent_start?.(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "BASE" },
			h.ctx,
		)) as { systemPrompt?: string };
		expect(result.systemPrompt).toContain("BASE");
		expect(result.systemPrompt).toContain("SPEC-TEXT");
	});

	it("allows the turn to end when enforce says nothing", async () => {
		const h = harness(() => "");
		cairnExtension(h.pi as never);
		await h.handlers.agent_end?.(assistantReply("a reply"), h.ctx);
		expect(h.followUps).toHaveLength(0);
	});

	it("re-prompts once when enforce returns a reason", async () => {
		const h = harness((sub) => (sub === "enforce" ? "Missing [cm] block." : ""));
		cairnExtension(h.pi as never);
		await h.handlers.agent_end?.(assistantReply("a reply"), h.ctx);
		expect(h.followUps).toEqual(["Missing [cm] block."]);
	});

	it("caps enforcement so a model that never complies cannot loop forever", async () => {
		// The top risk in this design: agent_end fires again on the continuation we
		// queue. Without the cap this is an infinite re-prompt loop.
		const h = harness((sub) => (sub === "enforce" ? "Still missing." : ""));
		cairnExtension(h.pi as never);
		for (let i = 0; i < 10; i++) {
			await h.handlers.agent_end?.(assistantReply("still no block"), h.ctx);
		}
		expect(h.followUps).toHaveLength(2);
	});

	it("restores the enforcement budget on a new user prompt", async () => {
		const h = harness((sub) => (sub === "enforce" ? "Missing." : ""));
		cairnExtension(h.pi as never);
		await h.handlers.agent_end?.(assistantReply("x"), h.ctx);
		await h.handlers.agent_end?.(assistantReply("x"), h.ctx);
		expect(h.followUps).toHaveLength(2);

		await h.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "new", systemPrompt: "B" }, h.ctx);
		await h.handlers.agent_end?.(assistantReply("x"), h.ctx);
		expect(h.followUps).toHaveLength(3);
	});

	it("captures before enforcing, so a rejected reply still banks its memories", async () => {
		const h = harness((sub) => (sub === "enforce" ? "Missing." : ""));
		cairnExtension(h.pi as never);
		await h.handlers.agent_end?.(assistantReply("a reply"), h.ctx);
		const order = h.execCalls.map((args) => args[1]);
		expect(order.indexOf("capture")).toBeLessThan(order.indexOf("enforce"));
	});

	it("does nothing when the run produced no assistant text", async () => {
		const h = harness(() => "should not be called");
		cairnExtension(h.pi as never);
		await h.handlers.agent_end?.({ type: "agent_end", messages: [{ role: "user", content: "hi" }] }, h.ctx);
		expect(h.execCalls).toHaveLength(0);
	});
});
