/**
 * /goal for pi — keep working until a condition holds.
 *
 * Mirrors Claude Code's /goal, which is a Stop hook that blocks stopping until
 * the condition holds, auto-clears the moment it is met, and otherwise bumps an
 * iteration count and records why it was not met. The same shape rides `agent_end`
 * here, which is the seam cairn.ts already uses to re-prompt: queue a follow-up
 * and the agent loop continues instead of stopping.
 *
 * Commands:
 *   /goal --until <shell cmd> <objective>   met when the command exits 0
 *   /goal <objective>                       met when the agent says GOAL MET
 *   /goal status
 *   /goal clear
 *
 * Prefer --until. A shell check is evidence; the agent's own say-so is not, and
 * self-assessed completion is a known failure mode -- an agent will declare a goal
 * done with work still outstanding. --until costs nothing per turn and cannot be
 * talked into a false positive.
 *
 * Off unless PI_GOAL is set.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { run } from "../lib/bridge.ts";

const CHECK_TIMEOUT_MS = 120_000;

/**
 * Ceiling on continuations for one goal. Claude Code's implementation pauses and
 * says why rather than stalling silently; the same applies here -- an unreachable
 * goal must announce itself, not spin.
 */
const MAX_ITERATIONS = 25;

interface Goal {
	objective: string;
	until?: string;
	iterations: number;
	lastReason: string;
	setAt: number;
}

export function parseGoalArgs(args: string): { until?: string; objective: string } {
	const trimmed = args.trim();
	const m = trimmed.match(/^--until\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*([\s\S]*)$/);
	if (!m) return { objective: trimmed };
	return { until: m[1] ?? m[2] ?? m[3], objective: (m[4] ?? "").trim() };
}

/** The agent declaring completion. Deliberately strict: a bare mention must not count. */
export function claimsComplete(text: string): boolean {
	return /(^|\n)\s*GOAL MET\b/i.test(text);
}

function assistantText(messages: unknown[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message as { role?: unknown; content?: unknown };
		if (record.role !== "assistant") continue;
		if (typeof record.content === "string") parts.push(record.content);
		else if (Array.isArray(record.content))
			for (const block of record.content) {
				const typed = block as { type?: unknown; text?: unknown };
				if (typed?.type === "text" && typeof typed.text === "string") parts.push(typed.text);
			}
	}
	return parts.join("\n");
}

export default function (pi: ExtensionAPI) {
	const flag = process.env.PI_GOAL;
	if (flag !== "1" && flag !== "true") return;

	// Persisted per session rather than held in a closure: a goal that vanishes on
	// /reload or on resuming a session is a silent loss of something the user
	// explicitly set. Keyed by session id, cleared by deleting the file.
	const stateFile = (ctx: { sessionManager: { getSessionId(): string | undefined } }) =>
		join(
			process.env.PI_GOAL_STATE_DIR ?? join(homedir(), ".pi", "agent", "goal-state"),
			`${ctx.sessionManager.getSessionId() ?? "none"}.json`,
		);

	function load(ctx: Parameters<typeof stateFile>[0]): Goal | null {
		try {
			return JSON.parse(readFileSync(stateFile(ctx), "utf8")) as Goal;
		} catch {
			return null;
		}
	}

	function save(ctx: Parameters<typeof stateFile>[0], goal: Goal | null): void {
		const path = stateFile(ctx);
		try {
			if (!goal) {
				rmSync(path, { force: true });
				return;
			}
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(goal), "utf8");
		} catch {
			// A goal that cannot be persisted still works for this process; losing it
			// on reload is better than breaking the turn.
		}
	}

	pi.registerCommand("goal", {
		description: "Keep working until a condition is met. /goal --until <cmd> <objective> | /goal status | /goal clear",
		async handler(args, ctx) {
			const raw = args.trim();
			const current = load(ctx);
			if (raw === "clear") {
				save(ctx, null);
				ctx.ui.notify(current ? `Goal cleared: ${current.objective}` : "No goal set.");
				return;
			}
			if (raw === "status" || raw === "") {
				ctx.ui.notify(
					current
						? `Goal: ${current.objective}\n  check: ${current.until ?? "agent reports GOAL MET"}\n  iterations: ${current.iterations}${current.lastReason ? `\n  last: ${current.lastReason}` : ""}`
						: "No goal set.",
				);
				return;
			}
			const { until, objective } = parseGoalArgs(raw);
			const next: Goal = { objective: objective || raw, until, iterations: 0, lastReason: "", setAt: Date.now() };
			save(ctx, next);
			ctx.ui.notify(`Goal set: ${next.objective}\n  check: ${until ?? "agent reports GOAL MET"}`);
		},
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		const goal = load(ctx);
		if (!goal) return;

		// A shell check is evidence. Exit 0 means met; anything else, including the
		// command failing to run, means not yet -- never clear a goal on a broken check.
		let met: boolean;
		let reason: string;
		if (goal.until) {
			const result = await run(pi, "bash", ["-lc", goal.until], { cwd: ctx.cwd, timeoutMs: CHECK_TIMEOUT_MS });
			met = !result.errored && !result.killed && result.code === 0;
			reason = met ? "" : `check failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`;
		} else {
			met = claimsComplete(assistantText(event.messages));
			reason = met ? "" : "objective not yet reported as met";
		}

		if (met) {
			const done = goal.objective;
			save(ctx, null); // auto-clear, matching /goal: clear is only for abandoning early
			pi.sendUserMessage(`Goal met: ${done}. It has been cleared; continue normally.`, { deliverAs: "followUp" });
			return;
		}

		goal.iterations += 1;
		goal.lastReason = reason;
		save(ctx, goal);
		if (goal.iterations >= MAX_ITERATIONS) {
			const stuck = goal.objective;
			save(ctx, null);
			pi.sendUserMessage(
				`Goal abandoned after ${MAX_ITERATIONS} attempts: ${stuck}\nLast check: ${reason}\nTell the user it could not be reached and why. Do not retry.`,
				{ deliverAs: "followUp" },
			);
			return;
		}

		pi.sendUserMessage(
			`Goal not yet met (attempt ${goal.iterations}/${MAX_ITERATIONS}): ${goal.objective}\n${reason}\nContinue working toward it.`,
			{ deliverAs: "followUp" },
		);
	});
}
