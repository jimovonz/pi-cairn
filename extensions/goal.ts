/**
 * /goal for pi — duplicates Claude Code's goal loop.
 *
 * Set a natural-language completion condition and pi keeps working until a
 * separate evaluator says it holds. Upstream is a session-scoped prompt-based Stop
 * hook; the equivalent seam here is `agent_end`, where queueing a follow-up makes
 * the agent loop continue instead of stopping.
 *
 *   /goal all tests in test/auth pass and the lint step is clean
 *   /goal            status
 *   /goal clear      abandon early
 *
 * The evaluator is a SEPARATE cheap model, not the one doing the work, and it
 * judges the condition against what the agent surfaced in the conversation. It does
 * not run commands or read files -- so write conditions the agent's own output can
 * demonstrate ("npm test exits 0" works because the run appears in the transcript).
 *
 * Bound a goal by writing the bound into the condition ("...or stop after 20
 * turns"); there is no separate iteration cap. The safety net is stall detection:
 * several turns with no tool use returns control to you with the goal still set.
 *
 * Off unless PI_GOAL is set.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { run } from "../lib/bridge.ts";

/** Upstream caps the condition at 4000 characters. */
const MAX_CONDITION_CHARS = 4000;
/** Transcript tail handed to the evaluator. Enough to show a test run, not the world. */
const TRANSCRIPT_CHARS = 12_000;
const EVAL_TIMEOUT_MS = 120_000;
/** Consecutive turns with no tool use before we stop and hand back control. */
const STALL_LIMIT = 3;

export type Verdict = "met" | "not_yet" | "impossible";

interface Goal {
	condition: string;
	turns: number;
	lastReason: string;
	setAt: number;
	idleTurns: number;
}

/**
 * Parse the evaluator's reply.
 *
 * Deliberately conservative: anything unrecognised is "not_yet". A goal must never
 * be cleared because a verdict could not be read -- the cost of an extra turn is
 * far lower than silently abandoning work the user asked to continue.
 */
export function parseVerdict(raw: string): { verdict: Verdict; reason: string } {
	const text = raw.trim();
	const m = text.match(/\b(MET|NOT_YET|IMPOSSIBLE)\b/i);
	const verdict = (m?.[1]?.toLowerCase() ?? "not_yet") as Verdict;
	const reason = text
		.replace(/\b(MET|NOT_YET|IMPOSSIBLE)\b/i, "")
		.replace(/^[\s:|.-]+/, "")
		.trim()
		.slice(0, 400);
	return { verdict: verdict === "met" || verdict === "impossible" ? verdict : "not_yet", reason };
}

/** Flatten the run into the text the evaluator reads, newest last. */
export function transcriptTail(messages: unknown[], limit = TRANSCRIPT_CHARS): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message as { role?: unknown; content?: unknown };
		const role = typeof record.role === "string" ? record.role : "?";
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
		const content = record.content;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content))
			text = content
				.map((b) => {
					const t = b as { type?: unknown; text?: unknown };
					return t?.type === "text" && typeof t.text === "string" ? t.text : "";
				})
				.filter(Boolean)
				.join("\n");
		if (text.trim()) lines.push(`${role}: ${text.trim()}`);
	}
	const joined = lines.join("\n\n");
	return joined.length > limit ? joined.slice(-limit) : joined;
}

export function countToolCalls(messages: unknown[]): number {
	let n = 0;
	for (const message of messages) {
		const content = (message as { content?: unknown })?.content;
		if (Array.isArray(content))
			for (const b of content) if ((b as { type?: unknown })?.type === "toolCall") n += 1;
	}
	return n;
}

export function buildEvalPrompt(condition: string, transcript: string): string {
	return [
		"You are evaluating whether a session goal has been met. You are NOT doing the work.",
		"Judge ONLY from the conversation below. You cannot run commands or read files;",
		"if the conversation does not demonstrate the condition, it is not yet met.",
		"",
		`CONDITION: ${condition}`,
		"",
		"CONVERSATION:",
		transcript || "(nothing yet)",
		"",
		"Reply with exactly one word on the first line -- MET, NOT_YET, or IMPOSSIBLE --",
		"then one short sentence giving the reason. IMPOSSIBLE means the condition can",
		"never be satisfied, not merely that it is unfinished.",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const flag = process.env.PI_GOAL;
	if (flag !== "1" && flag !== "true") return;

	/**
	 * Which model judges the verdict.
	 *
	 * Defaults to the session's own model rather than a nominally "small fast" one.
	 * Upstream can assume its small model is the cheap one; here that is not true --
	 * Haiku 4.5 on OpenRouter runs $1.00/M in and $5.00/M out against
	 * deepseek-v4.1-flash at $0.30 and $1.20, so defaulting to it would make the
	 * evaluator four times pricier than the work it is checking, once per turn.
	 * Using the session model also means no second provider to configure or pin.
	 */
	const evalModelFor = (ctx: { model?: { id?: string } }) =>
		process.env.PI_GOAL_MODEL ?? ctx.model?.id ?? "deepseek/deepseek-v4.1-flash";

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
			// Losing persistence is survivable; breaking the turn is not.
		}
	}

	pi.registerCommand("goal", {
		description: "Keep working until a condition is met. /goal <condition> | /goal | /goal clear",
		async handler(args, ctx) {
			const raw = args.trim();
			const current = load(ctx);

			if (raw === "clear") {
				save(ctx, null);
				ctx.ui.notify(current ? `Goal cleared: ${current.condition}` : "No goal set.");
				return;
			}
			if (raw === "") {
				if (!current) {
					ctx.ui.notify("No goal set.");
					return;
				}
				const mins = Math.round((Date.now() - current.setAt) / 60_000);
				ctx.ui.notify(
					`Goal: ${current.condition}\n  running: ${mins}m\n  turns evaluated: ${current.turns}` +
						(current.lastReason ? `\n  last verdict: ${current.lastReason}` : ""),
				);
				return;
			}
			if (raw.length > MAX_CONDITION_CHARS) {
				ctx.ui.notify(`Condition exceeds ${MAX_CONDITION_CHARS} characters.`, "error");
				return;
			}

			save(ctx, { condition: raw, turns: 0, lastReason: "", setAt: Date.now(), idleTurns: 0 });
			ctx.ui.notify(`Goal set: ${raw}\n  evaluator: ${evalModelFor(ctx)}`);
			// Setting a goal starts a turn immediately, with the condition as the directive.
			pi.sendUserMessage(raw);
		},
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		const goal = load(ctx);
		if (!goal) return;

		// Stall guard: an agent answering the evaluator without touching anything is
		// not making progress. Hand control back, but leave the goal set so the next
		// prompt resumes it.
		goal.idleTurns = countToolCalls(event.messages) === 0 ? goal.idleTurns + 1 : 0;
		if (goal.idleTurns >= STALL_LIMIT) {
			goal.idleTurns = 0;
			save(ctx, goal);
			ctx.ui.notify(
				`Goal paused after ${STALL_LIMIT} turns with no tool use: ${goal.condition}\nIt is still set; send a message to resume.`,
				"warning",
			);
			return;
		}

		const prompt = buildEvalPrompt(goal.condition, transcriptTail(event.messages));
		// --thinking off: a three-way classification needs no reasoning trace, and
		// reasoning tokens bill as output, the most expensive class.
		const result = await run(pi, "pi", ["-p", "--no-session", "--thinking", "off", "--model", evalModelFor(ctx), prompt], {
			cwd: ctx.cwd,
			timeoutMs: EVAL_TIMEOUT_MS,
		});
		// An evaluator that failed to answer is not a verdict. Keep working.
		const { verdict, reason } = result.ok
			? parseVerdict(result.stdout)
			: { verdict: "not_yet" as Verdict, reason: "evaluator unavailable this turn" };

		goal.turns += 1;
		goal.lastReason = `${verdict}: ${reason}`;

		if (verdict === "met") {
			save(ctx, null);
			ctx.ui.notify(`Goal achieved after ${goal.turns} turns: ${goal.condition}\n${reason}`);
			return;
		}
		if (verdict === "impossible") {
			save(ctx, null);
			ctx.ui.notify(`Goal failed — judged impossible: ${goal.condition}\n${reason}`, "warning");
			pi.sendUserMessage(
				`The goal evaluator judged this condition impossible: ${goal.condition}\nReason: ${reason}\nExplain the situation to the user. Do not retry.`,
				{ deliverAs: "followUp" },
			);
			return;
		}

		save(ctx, goal);
		// The reason is guidance, not just a status line -- it tells the next turn
		// what is still outstanding.
		pi.sendUserMessage(
			`Goal not yet met (turn ${goal.turns}): ${goal.condition}\nEvaluator: ${reason}\nKeep working toward it.`,
			{ deliverAs: "followUp" },
		);
	});
}
