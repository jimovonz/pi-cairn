import { afterEach, beforeEach, describe, expect, it } from "vitest";
import routingExtension, { parseVerdict, routingGuide } from "../extensions/routing.ts";

const FLAGS = ["PI_ROUTING", "PI_CCM", "PI_RTK"];

describe("parseVerdict", () => {
	it("treats an empty response as allow", () => {
		expect(parseVerdict("")).toEqual({});
		expect(parseVerdict("   \n ")).toEqual({});
	});

	it("treats the explicit empty object as allow", () => {
		expect(parseVerdict("{}\n")).toEqual({});
	});

	it("extracts a deny reason", () => {
		const out = JSON.stringify({
			hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "BLOCKED: use sed" },
		});
		expect(parseVerdict(out)).toEqual({ deny: "BLOCKED: use sed" });
	});

	it("supplies a fallback reason when a deny carries none", () => {
		const out = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } });
		expect(parseVerdict(out).deny).toBeTruthy();
	});

	it("extracts a rewritten command", () => {
		const out = JSON.stringify({
			hookSpecificOutput: { updatedInput: { command: "cache-wrap.py -- 'ls'" } },
		});
		expect(parseVerdict(out)).toEqual({ command: "cache-wrap.py -- 'ls'" });
	});

	it("fails open on malformed output rather than blocking the tool", () => {
		// A broken or half-installed CCH must degrade to stock pi. Blocking here
		// would make every tool call fail with an unexplained denial.
		expect(parseVerdict("not json at all")).toEqual({});
		expect(parseVerdict('{"hookSpecificOutput":')).toEqual({});
		expect(parseVerdict("null")).toEqual({});
		expect(parseVerdict("[1,2,3]")).toEqual({});
	});

	it("ignores an empty rewritten command", () => {
		const out = JSON.stringify({ hookSpecificOutput: { updatedInput: { command: "" } } });
		expect(parseVerdict(out)).toEqual({});
	});
});

describe("routing extension", () => {
	beforeEach(() => {
		for (const f of FLAGS) delete process.env[f];
	});
	afterEach(() => {
		for (const f of FLAGS) delete process.env[f];
	});

	function stub() {
		const handlers: Record<string, unknown> = {};
		return {
			pi: { on: (event: string, handler: unknown) => { handlers[event] = handler; } },
			handlers,
		};
	}

	it("registers nothing when every gate is off", () => {
		const s = stub();
		routingExtension(s.pi as never);
		expect(Object.keys(s.handlers)).toHaveLength(0);
	});

	it("registers a tool_call handler when any gate is on", () => {
		for (const flag of FLAGS) {
			for (const f of FLAGS) delete process.env[f];
			process.env[flag] = "1";
			const s = stub();
			routingExtension(s.pi as never);
			expect(Object.keys(s.handlers).sort(), `gate ${flag}`).toEqual(["before_agent_start", "tool_call"]);
		}
	});

	it("contributes a byte-identical system prompt on every turn", () => {
		// It heads the cache prefix; any variation invalidates the whole cached
		// context at 50x the token price.
		process.env.PI_ROUTING = "1";
		process.env.PI_CCM = "1";
		const s = stub();
		routingExtension(s.pi as never);
		const handler = s.handlers.before_agent_start as (e: unknown) => { systemPrompt: string };
		const a = handler({ systemPrompt: "BASE" });
		const b = handler({ systemPrompt: "BASE" });
		expect(b.systemPrompt).toBe(a.systemPrompt);
		expect(a.systemPrompt.startsWith("BASE")).toBe(true);
	});

	it("describes only the layers that are switched on", () => {
		expect(routingGuide(true, false, false)).toMatch(/cairn-graph --location/);
		expect(routingGuide(true, false, false)).not.toMatch(/CCM_CACHED/);
		expect(routingGuide(false, true, false)).toMatch(/ccm-get\.py/);
		expect(routingGuide(false, true, false)).not.toMatch(/cch-edit/);
		expect(routingGuide(false, false, true)).toMatch(/rewritten/);
	});

	it("leaves native tools alone when only the bash gates are on", async () => {
		process.env.PI_CCM = "1";
		const s = stub();
		routingExtension(s.pi as never);
		const handler = s.handlers.tool_call as (e: unknown, c: unknown) => Promise<unknown>;
		const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "s" } };
		const result = await handler({ type: "tool_call", toolName: "read", input: { path: "/tmp/x.ts" } }, ctx);
		expect(result).toBeUndefined();
	});

	it("ignores a bash call with no command", async () => {
		process.env.PI_CCM = "1";
		const s = stub();
		routingExtension(s.pi as never);
		const handler = s.handlers.tool_call as (e: unknown, c: unknown) => Promise<unknown>;
		const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "s" } };
		expect(await handler({ type: "tool_call", toolName: "bash", input: {} }, ctx)).toBeUndefined();
	});
});
