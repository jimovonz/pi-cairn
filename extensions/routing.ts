/**
 * Tool routing for pi: CCH deny+suggest, CCM output caching, the code-graph
 * footer, and RTK command rewriting.
 *
 * None of the policy lives here. The CCH interceptors and `rtk hook claude` are
 * already stdin-driven JSON filters speaking Claude Code's PreToolUse shape, and
 * they are the same ones enforcing this policy for Claude Code today. So this file
 * is an adapter, not a port: it translates a pi tool_call into that payload, runs
 * the existing script, and maps the verdict back onto pi's ToolCallEventResult.
 *
 * Reusing intercept-bash.py in particular buys four things in one call --
 * guards.block, the non-blocking warnings, the CCH_SESSION_ID prefix, and the
 * cache-wrap.py wrap that produces the [CCM_CACHED] stub, the symbol menu, the
 * [cairn-graph: ...] footer and .cch/rules auto-attach.
 *
 * Order matters and mirrors what CCH's own installer enforces for PreToolUse:Bash:
 * RTK rewrites first, then CCH guards and wraps the rewritten command.
 *
 * Gates (all default off):
 *   PI_ROUTING  deny read/grep/find/ls so work goes down the bash path
 *   PI_CCM      route bash through intercept-bash.py (guards + cache-wrap wrap)
 *   PI_RTK      rewrite bash commands through rtk first
 *
 * PI_CCM carries the bash guards with it: intercept-bash.py applies guards.block
 * and the cache-wrap wrap in a single pass and they are not separable from outside.
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { runWithInput } from "../lib/bridge.ts";

/** Interceptors are fast local scripts; a slow one must not stall a tool call. */
const INTERCEPT_TIMEOUT_MS = 5_000;

function flag(name: string): boolean {
	const value = process.env[name];
	return value === "1" || value === "true";
}

function cchHome(): string {
	return process.env.CCH_HOME ?? join(homedir(), "Projects", "claude-context-hooks");
}

/**
 * pi tool name -> CCH interceptor. pi's `find` is Claude Code's Glob.
 *
 * These scripts are invoked by absolute path: only some of the CCH tools are
 * symlinked onto PATH, and cache-wrap.py notably is not.
 */
function nativeInterceptor(toolName: string): string | undefined {
	const script = { read: "intercept-read.py", grep: "intercept-grep.py", find: "intercept-glob.py", ls: "intercept-glob.py" }[
		toolName
	];
	return script ? join(cchHome(), "hooks", script) : undefined;
}

export interface Verdict {
	deny?: string;
	command?: string;
}

/**
 * Parse a Claude Code PreToolUse hook response.
 *
 * Every one of these scripts exits 0 and prints `{}` to mean "allow", including
 * when it has failed internally. Anything unparseable is therefore treated as
 * allow: a broken or missing CCH must degrade to stock pi, never to a blocked tool.
 */
export function parseVerdict(stdout: string): Verdict {
	const text = stdout.trim();
	if (!text) return {};
	try {
		const parsed = JSON.parse(text) as {
			hookSpecificOutput?: {
				permissionDecision?: string;
				permissionDecisionReason?: string;
				updatedInput?: { command?: string };
			};
		};
		const output = parsed.hookSpecificOutput;
		if (!output) return {};
		if (output.permissionDecision === "deny") {
			return { deny: output.permissionDecisionReason || "Blocked by routing policy." };
		}
		const command = output.updatedInput?.command;
		return typeof command === "string" && command.length > 0 ? { command } : {};
	} catch {
		return {};
	}
}

/** Build the Claude Code PreToolUse payload these scripts expect. */
function payload(toolName: string, toolInput: Record<string, unknown>, ctx: ExtensionContext): string {
	return JSON.stringify({
		hook_event_name: "PreToolUse",
		tool_name: toolName,
		tool_input: toolInput,
		session_id: ctx.sessionManager.getSessionId() ?? "",
		cwd: ctx.cwd,
	});
}

async function callScript(
	script: string,
	toolName: string,
	toolInput: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<Verdict> {
	const result = await runWithInput("python3", [script], payload(toolName, toolInput, ctx), {
		cwd: ctx.cwd,
		timeoutMs: INTERCEPT_TIMEOUT_MS,
	});
	if (result.errored || result.killed) return {};
	return parseVerdict(result.stdout);
}

async function rtkRewrite(command: string, ctx: ExtensionContext): Promise<string | undefined> {
	// `rtk hook claude` prints nothing at all when it has no rewrite to offer.
	const result = await runWithInput("rtk", ["hook", "claude"], payload("Bash", { command }, ctx), {
		cwd: ctx.cwd,
		timeoutMs: INTERCEPT_TIMEOUT_MS,
	});
	if (result.errored || result.killed) return undefined;
	return parseVerdict(result.stdout).command;
}

export default function (pi: ExtensionAPI) {
	const routing = flag("PI_ROUTING");
	const ccm = flag("PI_CCM");
	const rtk = flag("PI_RTK");
	if (!routing && !ccm && !rtk) return;

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		const toolName = event.toolName;

		if (toolName === "bash" || toolName === "powershell") {
			// `input` is mutated in place -- the documented way to rewrite a tool's
			// arguments. Returning a modified copy would be silently ignored.
			const input = event.input as unknown as { command?: string };
			const original = input.command;
			if (typeof original !== "string" || !original) return undefined;

			const interceptor = join(cchHome(), "hooks", "intercept-bash.py");

			// CCH must judge the ORIGINAL command, before RTK has touched it. RTK
			// rewrites `cat foo.ts` into `rtk read foo.ts`, and `rtk read ...` matches
			// none of the bulk-read patterns guards.block looks for (cat/head/tail/sed),
			// so putting RTK first silently disables the guards altogether. Verified the
			// hard way: a live `cat` of a 169-line source file sailed through, and the
			// CCH event log showed it had been handed "rtk read ..." instead.
			//
			// This is the one place pi's pipeline must NOT mirror CCH's installer, which
			// orders RTK before CCH -- Claude Code hands each hook the original input,
			// so ordering there does not chain the way it does here.
			let guarded: Verdict | undefined;
			if (routing || ccm) {
				guarded = await callScript(interceptor, "Bash", { command: original }, ctx);
				if (guarded.deny) return { block: true, reason: guarded.deny };
			}

			let command = original;
			if (rtk) command = (await rtkRewrite(command, ctx)) ?? command;

			if (ccm) {
				// Reuse the verdict above unless RTK actually changed the command, so the
				// common case costs one subprocess call rather than two.
				const wrap = command === original ? guarded : await callScript(interceptor, "Bash", { command }, ctx);
				if (wrap?.deny) return { block: true, reason: wrap.deny };
				if (wrap?.command) command = wrap.command;
			}

			if (command !== original) input.command = command;
			return undefined;
		}

		if (!routing) return undefined;
		const script = nativeInterceptor(toolName);
		if (!script) return undefined;

		// CCH keys on Claude Code's field names: its Read hook reads `file_path`
		// where pi's read tool calls the same thing `path`. grep and glob happen to
		// agree on `pattern`/`path` already.
		const input = event.input as unknown as Record<string, unknown>;
		const toolInput = toolName === "read" ? { ...input, file_path: input.path } : input;

		const verdict = await callScript(script, toolName, toolInput, ctx);
		return verdict.deny ? { block: true, reason: verdict.deny } : undefined;
	});
}
