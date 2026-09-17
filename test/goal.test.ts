import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import goalExtension, { claimsComplete, parseGoalArgs } from "../extensions/goal.ts";

describe("parseGoalArgs", () => {
	it("splits a quoted --until check from the objective", () => {
		expect(parseGoalArgs("--until 'npm test' make the suite pass")).toEqual({
			until: "npm test",
			objective: "make the suite pass",
		});
	});
	it("accepts an unquoted single-token check", () => {
		expect(parseGoalArgs("--until ./verify.sh finish it")).toEqual({ until: "./verify.sh", objective: "finish it" });
	});
	it("treats input without --until as a bare objective", () => {
		expect(parseGoalArgs("refactor the parser")).toEqual({ objective: "refactor the parser" });
	});
});

describe("claimsComplete", () => {
	it("requires the marker to lead a line, so a mention does not count", () => {
		expect(claimsComplete("GOAL MET")).toBe(true);
		expect(claimsComplete("work done\nGOAL MET")).toBe(true);
		expect(claimsComplete("I will tell you GOAL MET when finished")).toBe(false);
		expect(claimsComplete("still working")).toBe(false);
	});
});

function harness(exitCode: number) {
	const handlers: Record<string, (e: unknown, c: unknown) => Promise<unknown>> = {};
	const commands: Record<string, (a: string, c: unknown) => Promise<void>> = {};
	const followUps: string[] = [];
	const pi = {
		on: (e: string, h: (ev: unknown, c: unknown) => Promise<unknown>) => { handlers[e] = h; },
		registerCommand: (n: string, o: { handler: (a: string, c: unknown) => Promise<void> }) => { commands[n] = o.handler; },
		registerTool: () => {},
		async exec() { return { stdout: "", stderr: "nope", code: exitCode, killed: false }; },
		sendUserMessage: (t: string) => { followUps.push(t); },
	};
	const ctx = { cwd: "/tmp", ui: { notify: () => {} }, sessionManager: { getSessionId: () => "s" } };
	return { pi, ctx, handlers, commands, followUps };
}

const reply = (text: string) => ({ type: "agent_end", messages: [{ role: "assistant", content: text }] });

describe("goal extension", () => {
	let dir: string;
	beforeEach(() => {
		process.env.PI_GOAL = "1";
		// Never touch the real ~/.pi state from a test run.
		dir = mkdtempSync(join(tmpdir(), "goal-test-"));
		process.env.PI_GOAL_STATE_DIR = dir;
	});
	afterEach(() => {
		delete process.env.PI_GOAL;
		delete process.env.PI_GOAL_STATE_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	it("stays inert unless PI_GOAL is set", () => {
		delete process.env.PI_GOAL;
		const h = harness(0);
		goalExtension(h.pi as never);
		expect(Object.keys(h.handlers)).toHaveLength(0);
	});

	it("does nothing at agent_end when no goal is set", async () => {
		const h = harness(1);
		goalExtension(h.pi as never);
		await h.handlers.agent_end?.(reply("anything"), h.ctx);
		expect(h.followUps).toHaveLength(0);
	});

	it("forces continuation while the shell check keeps failing", async () => {
		const h = harness(1);
		goalExtension(h.pi as never);
		await h.commands.goal?.("--until 'npm test' green suite", h.ctx);
		await h.handlers.agent_end?.(reply("done I think"), h.ctx);
		expect(h.followUps).toHaveLength(1);
		expect(h.followUps[0]).toMatch(/not yet met \(attempt 1\/25\)/);
	});

	it("auto-clears the moment the shell check passes", async () => {
		const h = harness(0);
		goalExtension(h.pi as never);
		await h.commands.goal?.("--until 'npm test' green suite", h.ctx);
		await h.handlers.agent_end?.(reply("done"), h.ctx);
		expect(h.followUps[0]).toMatch(/^Goal met/);
		await h.handlers.agent_end?.(reply("more"), h.ctx);
		expect(h.followUps).toHaveLength(1); // cleared, so no second fire
	});

	it("ignores the agent claiming done when a shell check governs", async () => {
		// Evidence beats say-so: exit 1 must outrank a GOAL MET in the reply.
		const h = harness(1);
		goalExtension(h.pi as never);
		await h.commands.goal?.("--until 'npm test' green suite", h.ctx);
		await h.handlers.agent_end?.(reply("GOAL MET"), h.ctx);
		expect(h.followUps[0]).toMatch(/not yet met/);
	});

	it("abandons with an explanation rather than spinning forever", async () => {
		const h = harness(1);
		goalExtension(h.pi as never);
		await h.commands.goal?.("--until 'false' impossible", h.ctx);
		for (let i = 0; i < 30; i++) await h.handlers.agent_end?.(reply("trying"), h.ctx);
		expect(h.followUps).toHaveLength(25);
		expect(h.followUps[24]).toMatch(/abandoned after 25 attempts/);
	});

	it("survives a reload, so a set goal is not silently lost", async () => {
		// State lives on disk keyed by session id. A fresh extension instance with the
		// same session must still see the goal -- closure state would drop it here.
		const first = harness(1);
		goalExtension(first.pi as never);
		await first.commands.goal?.("--until 'false' keep going", first.ctx);

		const reloaded = harness(1);
		goalExtension(reloaded.pi as never);
		await reloaded.handlers.agent_end?.(reply("still working"), reloaded.ctx);
		expect(reloaded.followUps[0]).toMatch(/not yet met/);
		expect(reloaded.followUps[0]).toMatch(/keep going/);
	});

	it("counts iterations across reloads rather than restarting the budget", async () => {
		const a = harness(1);
		goalExtension(a.pi as never);
		await a.commands.goal?.("--until 'false' x", a.ctx);
		await a.handlers.agent_end?.(reply("t"), a.ctx);
		const b = harness(1);
		goalExtension(b.pi as never);
		await b.handlers.agent_end?.(reply("t"), b.ctx);
		expect(b.followUps[0]).toMatch(/attempt 2\/25/);
	});

	it("clears on request and stops firing", async () => {
		const h = harness(1);
		goalExtension(h.pi as never);
		await h.commands.goal?.("--until 'false' x", h.ctx);
		await h.commands.goal?.("clear", h.ctx);
		await h.handlers.agent_end?.(reply("x"), h.ctx);
		expect(h.followUps).toHaveLength(0);
	});
});
