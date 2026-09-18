import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cairnExtension, { recoverExitCode } from "../extensions/cairn.ts";

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
	const customMessages: { customType: string; content: string; display?: boolean }[] = [];
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
		sendMessage(message: { customType: string; content: string; display?: boolean }) {
			customMessages.push(message);
		},
	};

	const ctx = {
		cwd: "/tmp/project",
		sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => "/tmp/sess.jsonl" },
	};

	return { pi, ctx, handlers, tools, followUps, customMessages, execCalls };
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

	it("registers its handlers and the query tool when enabled", () => {
		const h = harness(() => "");
		cairnExtension(h.pi as never);
		expect(Object.keys(h.handlers).sort()).toEqual(["agent_end", "before_agent_start", "tool_result"]);
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

	it("injects standing context once per session, not on every prompt", async () => {
		// Mirrors Claude Code's is_first_prompt gate. The bridge facade is ungated,
		// so a bug here would re-inject the same standing context every turn.
		const h = harness((sub) => (sub === "bootstrap" ? "<cairn_context layer=\"project-bootstrap\"/>" : ""));
		cairnExtension(h.pi as never);
		for (const prompt of ["one", "two", "three"]) {
			await h.handlers.before_agent_start?.({ type: "before_agent_start", prompt, systemPrompt: "BASE" }, h.ctx);
		}
		expect(h.execCalls.filter((args) => args[1] === "bootstrap")).toHaveLength(1);
	});

	it("leads the injected message with bootstrap and follows with retrieval", async () => {
		const h = harness((sub) => (sub === "bootstrap" ? "BOOT" : sub === "retrieve" ? "RECALL" : ""));
		cairnExtension(h.pi as never);
		const result = (await h.handlers.before_agent_start?.(
			{ type: "before_agent_start", prompt: "one", systemPrompt: "BASE" },
			h.ctx,
		)) as { message?: { content: string } };
		expect(result.message?.content).toBe("BOOT\n\nRECALL");
	});

	it("keeps standing context out of the system prompt so the cache prefix holds", async () => {
		const h = harness((sub) => (sub === "bootstrap" ? "BOOT" : sub === "spec" ? "SPEC" : ""));
		cairnExtension(h.pi as never);
		const first = (await h.handlers.before_agent_start?.(
			{ type: "before_agent_start", prompt: "one", systemPrompt: "BASE" },
			h.ctx,
		)) as { systemPrompt?: string };
		const second = (await h.handlers.before_agent_start?.(
			{ type: "before_agent_start", prompt: "two", systemPrompt: "BASE" },
			h.ctx,
		)) as { systemPrompt?: string };
		expect(first.systemPrompt).not.toContain("BOOT");
		expect(second.systemPrompt).toBe(first.systemPrompt);
	});

	it("uses layer 1 on the first prompt and layer 1.5 thereafter", async () => {
		const h = harness(() => "");
		cairnExtension(h.pi as never);
		for (const prompt of ["one", "two"]) {
			await h.handlers.before_agent_start?.({ type: "before_agent_start", prompt, systemPrompt: "B" }, h.ctx);
		}
		const retrieves = h.execCalls.filter((args) => args[1] === "retrieve");
		expect(retrieves).toHaveLength(2);
		expect(retrieves[0]).toContain("--first");
		expect(retrieves[1]).not.toContain("--first");
	});

	it("drains deferred reminders on every prompt and injects them last", async () => {
		const h = harness((sub) =>
			sub === "staged" ? "REMINDER" : sub === "retrieve" ? "RECALL" : sub === "bootstrap" ? "BOOT" : "",
		);
		cairnExtension(h.pi as never);
		const result = (await h.handlers.before_agent_start?.(
			{ type: "before_agent_start", prompt: "one", systemPrompt: "B" },
			h.ctx,
		)) as { message?: { content: string } };
		expect(result.message?.content).toBe("BOOT\n\nRECALL\n\nREMINDER");

		await h.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "two", systemPrompt: "B" }, h.ctx);
		expect(h.execCalls.filter((args) => args[1] === "staged")).toHaveLength(2);
	});

	it("marks an enforced retry as a continuation so it does not re-stage", async () => {
		const h = harness((sub) => (sub === "enforce" ? "Missing." : ""));
		cairnExtension(h.pi as never);
		await h.handlers.agent_end?.(assistantReply("x"), h.ctx);
		await h.handlers.agent_end?.(assistantReply("x"), h.ctx);
		const captures = h.execCalls.filter((args) => args[1] === "capture");
		expect(captures[0][captures[0].indexOf("--continuation") + 1]).toBe("0");
		expect(captures[1][captures[1].indexOf("--continuation") + 1]).toBe("1");
	});

	it("appends a checkpoint nudge to a notable tool result, preserving the original content", async () => {
		const h = harness((sub) => (sub === "checkpoint" ? "CAIRN CHECKPOINT: ..." : ""));
		cairnExtension(h.pi as never);
		const result = (await h.handlers.tool_result?.(
			{ type: "tool_result", toolName: "bash", input: { command: "pytest" }, content: [{ type: "text", text: "FAILED" }], isError: true },
			h.ctx,
		)) as { content: { type: string; text: string }[] } | undefined;
		expect(result?.content).toHaveLength(2);
		expect(result?.content[0].text).toBe("FAILED");
		expect(result?.content[1].text).toContain("CAIRN CHECKPOINT");
	});

	it("leaves an unremarkable tool result untouched", async () => {
		// The bridge decides what is notable; an empty reply must mean "no change",
		// not an empty content array that would erase the tool's output.
		const h = harness(() => "");
		cairnExtension(h.pi as never);
		const result = await h.handlers.tool_result?.(
			{ type: "tool_result", toolName: "bash", input: { command: "echo hi" }, content: [{ type: "text", text: "hi" }], isError: false },
			h.ctx,
		);
		expect(result).toBeUndefined();
	});

	it("recovers an exit status the CCM wrapper reported in-band", () => {
		// cache-wrap.py exits 0 itself and prints the real status, so isError is
		// false however badly the command failed.
		expect(recoverExitCode("boom\n[exit 2]", false)).toBe(2);
		expect(recoverExitCode("lines: 5000\nexit: 127\ncheck: c227", false)).toBe(127);
		expect(recoverExitCode("all fine", false)).toBe(0);
		expect(recoverExitCode("no marker here", true)).toBe(1);
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

	it("delivers retrieved memory as a hidden custom message, not a visible user message", async () => {
		const h = harness((sub) => (sub === "enforce" ? "CAIRN CONTEXT:\n<cairn_context/>" : ""));
		cairnExtension(h.pi as never);
		await h.handlers.agent_end?.(assistantReply("a reply"), h.ctx);
		// The [cm] nudge stays visible; retrieved context must not be painted in.
		expect(h.followUps).toHaveLength(0);
		expect(h.customMessages).toEqual([
			{ customType: "cairn-context", content: "CAIRN CONTEXT:\n<cairn_context/>", display: false },
		]);
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

	it("fetches the spec once and keeps the system prompt byte-identical across prompts", async () => {
		// The system prompt heads the provider's cache prefix. Any change invalidates
		// the whole cached context -- 50x the token price on deepseek-v4.1-flash -- so
		// a constant must never flap in and out.
		const h = harness((sub) => (sub === "spec" ? "SPEC-TEXT" : ""));
		cairnExtension(h.pi as never);
		const first = (await h.handlers.before_agent_start?.(
			{ type: "before_agent_start", prompt: "one", systemPrompt: "BASE" },
			h.ctx,
		)) as { systemPrompt?: string };
		const second = (await h.handlers.before_agent_start?.(
			{ type: "before_agent_start", prompt: "two", systemPrompt: "BASE" },
			h.ctx,
		)) as { systemPrompt?: string };

		expect(second.systemPrompt).toBe(first.systemPrompt);
		expect(h.execCalls.filter((args) => args[1] === "spec")).toHaveLength(1);
	});

	it("does not flap the system prompt when a later spec fetch would fail", async () => {
		let calls = 0;
		const h = harness((sub) => {
			if (sub !== "spec") return "";
			calls += 1;
			return calls === 1 ? "SPEC-TEXT" : ""; // a transient failure on any later call
		});
		cairnExtension(h.pi as never);
		const first = (await h.handlers.before_agent_start?.(
			{ type: "before_agent_start", prompt: "one", systemPrompt: "BASE" },
			h.ctx,
		)) as { systemPrompt?: string };
		const second = (await h.handlers.before_agent_start?.(
			{ type: "before_agent_start", prompt: "two", systemPrompt: "BASE" },
			h.ctx,
		)) as { systemPrompt?: string };
		expect(second.systemPrompt).toBe(first.systemPrompt);
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
