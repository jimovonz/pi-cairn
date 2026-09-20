import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import coopExtension from "../extensions/coop.ts";

interface Ctx {
	cwd: string;
	sessionManager: { getSessionId: () => string; getSessionFile: () => string };
	ui: { notify: () => void };
}

function harness() {
	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown> = {};
	const tools: Record<string, { execute: (...args: unknown[]) => Promise<any> }> = {};
	const commands: string[] = [];
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) {
			handlers[name] = handler;
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<any> }) {
			tools[tool.name] = tool;
		},
		registerCommand(name: string) {
			commands.push(name);
		},
	};
	return { pi, handlers, tools, commands };
}

const ctx = (id: string, cwd = "/tmp/project"): Ctx => ({
	cwd,
	sessionManager: { getSessionId: () => id, getSessionFile: () => "" },
	ui: { notify: () => {} },
});

const start = (event = { type: "session_start", reason: "startup" }) => event;

describe("coop extension — cross-session mailbox", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "coop-"));
		process.env.PI_COOP_DIR = dir;
		delete process.env.PI_COOP;
	});
	afterEach(() => {
		delete process.env.PI_COOP_DIR;
		delete process.env.PI_COOP;
		rmSync(dir, { recursive: true, force: true });
	});

	it("delivers a message from one session to another on the next prompt, once", async () => {
		const a = harness();
		coopExtension(a.pi as never);
		await a.handlers.session_start(start(), ctx("A"));

		const b = harness();
		coopExtension(b.pi as never);
		await b.handlers.session_start(start(), ctx("B"));

		await a.tools.coop_send.execute("tc", { target: "B", text: "hello from A" }, undefined, undefined, ctx("A"));

		const res = (await b.handlers.before_agent_start({ type: "before_agent_start" }, ctx("B"))) as
			| { message?: { content: string; display?: boolean } }
			| undefined;
		expect(res?.message?.content).toContain("hello from A");
		expect(res?.message?.display).toBe(false);

		// consume-once: a second prompt injects nothing
		const res2 = await b.handlers.before_agent_start({ type: "before_agent_start" }, ctx("B"));
		expect(res2).toBeUndefined();
	});

	it("lists peers but not self", async () => {
		const a = harness();
		coopExtension(a.pi as never);
		await a.handlers.session_start(start(), ctx("AAA"));

		const b = harness();
		coopExtension(b.pi as never);
		await b.handlers.session_start(start(), ctx("BBB"));

		const peers = await a.tools.coop_peers.execute("tc", {}, undefined, undefined, ctx("AAA"));
		const text = peers.content[0].text as string;
		expect(text).toContain("BBB");
		expect(text).not.toContain("AAA");
	});

	it("queues to a non-live target id without throwing", async () => {
		const a = harness();
		coopExtension(a.pi as never);
		await a.handlers.session_start(start(), ctx("A"));
		const out = await a.tools.coop_send.execute("tc", { target: "ghost", text: "hi" }, undefined, undefined, ctx("A"));
		expect(out.content[0].text).toContain("ghost");
	});

	it("is inert when PI_COOP=0", () => {
		process.env.PI_COOP = "0";
		const a = harness();
		coopExtension(a.pi as never);
		expect(Object.keys(a.handlers)).toHaveLength(0);
		expect(Object.keys(a.tools)).toHaveLength(0);
	});
});
