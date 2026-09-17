import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import goalExtension, { buildEvalPrompt, countToolCalls, parseVerdict, transcriptTail } from "../extensions/goal.ts";

describe("parseVerdict", () => {
	it("reads each of the three verdicts with its reason", () => {
		expect(parseVerdict("MET\nall tests green")).toEqual({ verdict: "met", reason: "all tests green" });
		expect(parseVerdict("NOT_YET: two suites still failing").verdict).toBe("not_yet");
		expect(parseVerdict("IMPOSSIBLE - the file was deleted upstream").verdict).toBe("impossible");
	});

	it("falls back to not_yet on anything unreadable", () => {
		// Never clear a goal because a verdict could not be parsed: an extra turn is
		// cheap, silently abandoning the user's work is not.
		expect(parseVerdict("").verdict).toBe("not_yet");
		expect(parseVerdict("I think it's probably fine?").verdict).toBe("not_yet");
		expect(parseVerdict("<<garbage>>").verdict).toBe("not_yet");
	});
});

describe("transcriptTail", () => {
	it("flattens roles and keeps the newest content when truncating", () => {
		const msgs = [
			{ role: "user", content: "start" },
			{ role: "assistant", content: [{ type: "text", text: "middle" }] },
			{ role: "assistant", content: [{ type: "text", text: "newest" }] },
		];
		const out = transcriptTail(msgs, 20);
		expect(out).toContain("newest");
		expect(out.length).toBeLessThanOrEqual(20);
	});
	it("skips non-text blocks without crashing", () => {
		expect(transcriptTail([{ role: "assistant", content: [{ type: "toolCall" }] }])).toBe("");
	});
});

describe("countToolCalls", () => {
	it("counts toolCall blocks across messages", () => {
		expect(countToolCalls([{ content: [{ type: "toolCall" }, { type: "text" }] }, { content: [{ type: "toolCall" }] }])).toBe(2);
		expect(countToolCalls([{ content: [{ type: "text" }] }])).toBe(0);
	});
});

describe("buildEvalPrompt", () => {
	it("tells the evaluator it cannot run anything and must judge from the transcript", () => {
		const p = buildEvalPrompt("tests pass", "assistant: ran npm test");
		expect(p).toContain("tests pass");
		expect(p).toContain("cannot run commands");
		expect(p).toMatch(/MET, NOT_YET, or IMPOSSIBLE/);
	});
});

function harness(evalReply: string) {
	const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
	const commands: Record<string, (a: string, c: unknown) => Promise<void>> = {};
	const followUps: string[] = [];
	const notices: string[] = [];
	const transcript: string[] = [];
	const execCalls: string[][] = [];
	const pi = {
		on: (e: string, h: (ev: unknown, c: unknown) => Promise<unknown>) => { handlers[e] = h; },
		registerCommand: (n: string, o: { handler: (a: string, c: unknown) => Promise<void> }) => { commands[n] = o.handler; },
		registerTool: () => {},
		async exec(_c: string, args: string[]) {
			execCalls.push(args);
			return { stdout: evalReply, stderr: "", code: 0, killed: false };
		},
		sendUserMessage: (t: string) => { followUps.push(t); },
		sendMessage: (m: { content: string }) => { transcript.push(m.content); },
	};
	const ctx = {
		cwd: "/tmp",
		ui: { notify: (m: string) => notices.push(m) },
		sessionManager: { getSessionId: () => "s" },
	};
	return { pi, ctx, handlers, commands, followUps, notices, transcript, execCalls };
}

const work = (text: string) => ({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "toolCall" }, { type: "text", text }] }] });
const idle = (text: string) => ({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] });

describe("goal extension", () => {
	let dir: string;
	beforeEach(() => {
		process.env.PI_GOAL = "1";
		dir = mkdtempSync(join(tmpdir(), "goal-test-"));
		process.env.PI_GOAL_STATE_DIR = dir;
	});
	afterEach(() => {
		delete process.env.PI_GOAL;
		delete process.env.PI_GOAL_STATE_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	it("registers /goal by default, so the command is never silently missing", () => {
		delete process.env.PI_GOAL;
		const h = harness("MET fine");
		goalExtension(h.pi as never);
		expect(Object.keys(h.commands)).toEqual(["goal"]);
	});

	it("can still be switched off explicitly", () => {
		process.env.PI_GOAL = "0";
		const h = harness("MET fine");
		goalExtension(h.pi as never);
		expect(Object.keys(h.commands)).toHaveLength(0);
		expect(Object.keys(h.handlers)).toHaveLength(0);
	});

	it("starts a turn immediately when a goal is set", async () => {
		const h = harness("NOT_YET still going");
		goalExtension(h.pi as never);
		await h.commands.goal?.("all tests pass", h.ctx);
		expect(h.followUps).toEqual(["all tests pass"]);
	});

	it("rejects a condition over the 4000 character limit", async () => {
		const h = harness("NOT_YET x");
		goalExtension(h.pi as never);
		await h.commands.goal?.("x".repeat(4001), h.ctx);
		expect(h.notices[0]).toMatch(/exceeds 4000/);
		expect(h.followUps).toHaveLength(0);
	});

	it("continues on not_yet and feeds the reason forward as guidance", async () => {
		const h = harness("NOT_YET two suites still failing");
		goalExtension(h.pi as never);
		await h.commands.goal?.("all tests pass", h.ctx);
		await h.handlers.agent_end?.(work("ran tests"), h.ctx);
		expect(h.followUps[1]).toMatch(/not yet met \(turn 1\)/);
		expect(h.followUps[1]).toMatch(/two suites still failing/);
	});

	it("clears on met and stops firing", async () => {
		const h = harness("MET everything green");
		goalExtension(h.pi as never);
		await h.commands.goal?.("all tests pass", h.ctx);
		await h.handlers.agent_end?.(work("ran tests"), h.ctx);
		expect(h.notices.some((n) => /Goal achieved/.test(n))).toBe(true);
		const before = h.followUps.length;
		await h.handlers.agent_end?.(work("more"), h.ctx);
		expect(h.followUps).toHaveLength(before);
	});

	it("clears on impossible and tells the agent not to retry", async () => {
		const h = harness("IMPOSSIBLE the target module no longer exists");
		goalExtension(h.pi as never);
		await h.commands.goal?.("port the old module", h.ctx);
		await h.handlers.agent_end?.(work("looked"), h.ctx);
		expect(h.notices.some((n) => /judged impossible/.test(n))).toBe(true);
		expect(h.followUps[1]).toMatch(/Do not retry/);
	});

	it("evaluates in a separate one-shot run with thinking off", async () => {
		// Reasoning tokens bill as output, the most expensive class, and a three-way
		// classification needs none.
		const h = harness("NOT_YET x");
		goalExtension(h.pi as never);
		await h.commands.goal?.("cond", h.ctx);
		await h.handlers.agent_end?.(work("did work"), h.ctx);
		const call = h.execCalls[0];
		expect(call).toContain("-p");
		expect(call).toContain("--no-session");
		expect(call.slice(call.indexOf("--thinking"), call.indexOf("--thinking") + 2)).toEqual(["--thinking", "off"]);
	});

	it("defaults the evaluator to the session model, not a pricier one", async () => {
		// Haiku 4.5 costs 3.3x input and 4.2x output against deepseek-v4.1-flash on
		// OpenRouter, so a "small fast model" default would cost more than the work.
		const h = harness("NOT_YET x");
		(h.ctx as { model?: { id: string } }).model = { id: "deepseek/deepseek-v4.1-flash" };
		goalExtension(h.pi as never);
		await h.commands.goal?.("cond", h.ctx);
		await h.handlers.agent_end?.(work("did work"), h.ctx);
		const call = h.execCalls[0];
		expect(call[call.indexOf("--model") + 1]).toBe("deepseek/deepseek-v4.1-flash");
	});

	it("honours PI_GOAL_MODEL when set", async () => {
		process.env.PI_GOAL_MODEL = "some/cheap-model";
		const h = harness("NOT_YET x");
		goalExtension(h.pi as never);
		await h.commands.goal?.("cond", h.ctx);
		await h.handlers.agent_end?.(work("did work"), h.ctx);
		expect(h.execCalls[0][h.execCalls[0].indexOf("--model") + 1]).toBe("some/cheap-model");
		delete process.env.PI_GOAL_MODEL;
	});

	it("pauses after consecutive turns with no tool use, keeping the goal set", async () => {
		const h = harness("NOT_YET x");
		goalExtension(h.pi as never);
		await h.commands.goal?.("cond", h.ctx);
		for (let i = 0; i < 3; i++) await h.handlers.agent_end?.(idle("just talking"), h.ctx);
		expect(h.notices.some((n) => /no tool use/.test(n))).toBe(true);
		// still set: a later productive turn resumes evaluation
		await h.handlers.agent_end?.(work("actually did something"), h.ctx);
		expect(h.followUps.some((f) => /not yet met/.test(f))).toBe(true);
	});

	it("keeps working when the evaluator itself fails", async () => {
		const h = harness("MET yes");
		goalExtension(h.pi as never);
		await h.commands.goal?.("cond", h.ctx);
		h.pi.exec = async () => ({ stdout: "", stderr: "boom", code: 1, killed: false });
		await h.handlers.agent_end?.(work("did work"), h.ctx);
		expect(h.followUps[1]).toMatch(/evaluator unavailable/);
	});

	it("survives a reload with its turn count intact", async () => {
		const a = harness("NOT_YET x");
		goalExtension(a.pi as never);
		await a.commands.goal?.("cond", a.ctx);
		await a.handlers.agent_end?.(work("t"), a.ctx);
		const b = harness("NOT_YET x");
		goalExtension(b.pi as never);
		await b.handlers.agent_end?.(work("t"), b.ctx);
		expect(b.followUps[0]).toMatch(/turn 2/);
	});

	it("makes status visible in the transcript, not only as a TUI toast", async () => {
		// ctx.ui.notify never reaches the transcript, so in -p mode a status command
		// that only notified was indistinguishable from one that did not exist.
		const h = harness("NOT_YET x");
		goalExtension(h.pi as never);
		await h.commands.goal?.("", h.ctx);
		expect(h.notices).toContain("No goal set.");
		expect(h.transcript).toContain("No goal set.");
	});

	it("makes clear visible in the transcript too", async () => {
		const h = harness("NOT_YET x");
		goalExtension(h.pi as never);
		await h.commands.goal?.("some condition", h.ctx);
		await h.commands.goal?.("clear", h.ctx);
		expect(h.transcript.some((t) => /Goal cleared: some condition/.test(t))).toBe(true);
	});

	it("clears on request", async () => {
		const h = harness("NOT_YET x");
		goalExtension(h.pi as never);
		await h.commands.goal?.("cond", h.ctx);
		await h.commands.goal?.("clear", h.ctx);
		const before = h.followUps.length;
		await h.handlers.agent_end?.(work("x"), h.ctx);
		expect(h.followUps).toHaveLength(before);
	});
});
