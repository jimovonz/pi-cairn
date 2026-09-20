import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import coopExtension from "../extensions/coop.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
interface Injected {
	kind: "message" | "user";
	text: string;
}

function harness() {
	const handlers: Record<string, Handler> = {};
	const tools: Record<string, { execute: (...args: any[]) => Promise<any> }> = {};
	const injected: Injected[] = [];
	const pi = {
		on(name: string, h: Handler) {
			handlers[name] = h;
		},
		registerTool(t: { name: string; execute: (...args: any[]) => Promise<any> }) {
			tools[t.name] = t;
		},
		registerCommand() {},
		sendMessage(m: { content?: unknown }, _o?: unknown) {
			injected.push({ kind: "message", text: String(m?.content ?? "") });
		},
		sendUserMessage(c: unknown, _o?: unknown) {
			injected.push({ kind: "user", text: String(c) });
		},
	};
	return { pi, handlers, tools, injected };
}

const ctx = (id: string, cwd: string, sessionFile = "") => ({
	cwd,
	sessionManager: { getSessionId: () => id, getSessionFile: () => sessionFile },
	ui: { notify: () => {} },
});

const waitFor = async (pred: () => boolean, ms = 2000): Promise<boolean> => {
	const t = Date.now();
	while (Date.now() - t < ms) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 15));
	}
	return pred();
};

describe("coop extension — socket + registry (pi↔pi)", () => {
	let dir: string;
	const live: { handlers: Record<string, Handler> }[] = [];

	const start = async (id: string, cwd: string, sessionFile = "") => {
		const h = harness();
		coopExtension(h.pi as never);
		await h.handlers.session_start({ type: "session_start", reason: "startup" }, ctx(id, cwd, sessionFile));
		live.push({ handlers: h.handlers });
		return h;
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "coop-"));
		process.env.PI_COOP_DIR = dir;
		delete process.env.PI_COOP;
	});
	afterEach(async () => {
		for (const h of live.splice(0)) {
			try {
				await h.handlers.session_shutdown?.({ type: "session_shutdown" }, ctx("x", dir));
			} catch {
				/* ignore */
			}
		}
		delete process.env.PI_COOP_DIR;
		delete process.env.PI_COOP;
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists a live peer and pushes a message to its socket (context)", async () => {
		const a = await start("AAAA", "/tmp/a");
		const b = await start("BBBB", "/tmp/b");
		expect(await waitFor(() => existsSync(join(dir, "run", "BBBB.sock")))).toBe(true);

		const peers = await a.tools.coop_peers.execute("tc", {}, undefined, undefined, ctx("AAAA", "/tmp/a"));
		expect(peers.content[0].text).toContain("BBBB");
		expect(peers.content[0].text).not.toContain("AAAA");

		const out = await a.tools.coop_send.execute(
			"tc",
			{ target: "BBBB", text: "hello from A", wake: false },
			undefined,
			undefined,
			ctx("AAAA", "/tmp/a"),
		);
		expect(out.content[0].text).toContain("Delivered");
		expect(await waitFor(() => b.injected.length > 0)).toBe(true);
		expect(b.injected[0].kind).toBe("message");
		expect(b.injected[0].text).toContain("hello from A");
	});

	it("wakes the peer with a user message when wake=true", async () => {
		const a = await start("AAAA", "/tmp/a");
		const b = await start("BBBB", "/tmp/b");
		await waitFor(() => existsSync(join(dir, "run", "BBBB.sock")));
		await a.tools.coop_send.execute("tc", { target: "BBBB", text: "act now", wake: true }, undefined, undefined, ctx("AAAA", "/tmp/a"));
		expect(await waitFor(() => b.injected.length > 0)).toBe(true);
		expect(b.injected[0].kind).toBe("user");
	});

	it("queues offline to a non-live target and delivers on its next prompt", async () => {
		const a = await start("AAAA", "/tmp/a");
		const out = await a.tools.coop_send.execute("tc", { target: "GHOST", text: "later", wake: false }, undefined, undefined, ctx("AAAA", "/tmp/a"));
		expect(out.content[0].text).toContain("Queued offline");

		// the ghost session starts and drains the durable inbox at its next prompt
		const g = await start("GHOST", "/tmp/g");
		const res = (await g.handlers.before_agent_start({ type: "before_agent_start" }, ctx("GHOST", "/tmp/g"))) as
			| { message?: { content: string } }
			| undefined;
		expect(res?.message?.content).toContain("later");
	});

	it("reads a peer's recent turns via coop_logs", async () => {
		const sf = join(dir, "peer-session.jsonl");
		writeFileSync(
			sf,
			[
				JSON.stringify({ type: "message", message: { role: "user", content: "do the thing" } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: "did the thing" } }),
			].join("\n"),
		);
		const a = await start("AAAA", "/tmp/a");
		await start("BBBB", "/tmp/b", sf);
		await waitFor(() => existsSync(join(dir, "run", "BBBB.sock")));
		const out = await a.tools.coop_logs.execute("tc", { target: "BBBB", n: 10 }, undefined, undefined, ctx("AAAA", "/tmp/a"));
		expect(out.content[0].text).toContain("did the thing");
	});

	it("is inert when PI_COOP=0", () => {
		process.env.PI_COOP = "0";
		const a = harness();
		coopExtension(a.pi as never);
		expect(Object.keys(a.handlers)).toHaveLength(0);
		expect(Object.keys(a.tools)).toHaveLength(0);
	});
});
