/**
 * Cairn memory for pi.
 *
 * Gives pi the same persistent memory Claude Code has, by shelling out to the very
 * same engine: cairn/hooks/pi_bridge.py, which fronts the identical parser, storage,
 * retrieval and enforcement code the Claude Code hooks use. Nothing about the memory
 * format or database is reimplemented here, so the two hosts cannot drift apart.
 *
 *   before_agent_start  ->  retrieve relevant memories + inject the [cm] spec
 *   agent_end           ->  capture memories, then enforce the block's presence
 *   cairn_query         ->  let the model search memory on demand
 *
 * Off unless PI_CAIRN is set.
 *
 * Try it without installing:  pi -p -e ./extensions/cairn.ts "hello"
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEndEvent, BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { run, runText } from "../lib/bridge.ts";

/** Retrieval loads sentence-transformers, so it is far slower than the other calls. */
const RETRIEVE_TIMEOUT_MS = 30_000;
const CAPTURE_TIMEOUT_MS = 20_000;
const QUERY_TIMEOUT_MS = 45_000;

/**
 * How many times a single user prompt may be bounced back to the model for a
 * missing or malformed [cm] block.
 *
 * This cap is the whole safety story for the gate. agent_end fires again on the
 * continuation we queue, so without a hard ceiling a model that never emits a valid
 * block would be re-prompted forever. Two is enough to recover a forgotten block
 * while bounding the worst case at two extra turns per prompt.
 */
const MAX_ENFORCEMENTS_PER_PROMPT = 2;

function cairnHome(): string {
	return process.env.CAIRN_HOME ?? join(homedir(), "Projects", "cairn");
}

function enabled(): boolean {
	const flag = process.env.PI_CAIRN;
	return flag === "1" || flag === "true";
}

/**
 * Pull the assistant's prose out of a finished run.
 *
 * Deliberately tolerant: message shapes vary across providers and pi versions, and
 * a wrong guess here must degrade to "no text" rather than throw inside agent_end.
 */
function assistantText(messages: unknown[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message as { role?: unknown; content?: unknown };
		if (record.role !== "assistant") continue;
		if (typeof record.content === "string") {
			parts.push(record.content);
		} else if (Array.isArray(record.content)) {
			for (const block of record.content) {
				if (block && typeof block === "object") {
					const typed = block as { type?: unknown; text?: unknown };
					if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
				}
			}
		}
	}
	return parts.join("\n").trim();
}

/** Run a bridge subcommand against a temp file holding the assistant's text. */
async function withTextFile<T>(text: string, fn: (path: string) => Promise<T>): Promise<T | undefined> {
	let dir: string | undefined;
	try {
		dir = await mkdtemp(join(tmpdir(), "pi-cairn-"));
		const file = join(dir, "response.txt");
		await writeFile(file, text, "utf8");
		return await fn(file);
	} catch {
		return undefined;
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

export default function (pi: ExtensionAPI) {
	if (!enabled()) return;

	const bridge = join(cairnHome(), "hooks", "pi_bridge.py");
	const queryScript = join(cairnHome(), "cairn", "query.py");

	/** Enforcement budget for the current user prompt. Reset on every new prompt. */
	let enforcements = 0;

	/** Whether this session has already received its standing context. */
	let bootstrapped = false;

	/**
	 * The [cm] spec is a constant, so fetch it once and reuse it for the session.
	 *
	 * This is cache economics, not a micro-optimisation. The system prompt is the
	 * head of the provider's cache prefix, and any change to it invalidates the
	 * entire cached context. On deepseek-v4.1-flash a cached input token costs
	 * $0.006/M against $0.30/M fresh, so one needless prefix change re-ingests the
	 * whole conversation at fifty times the price -- on a long session that is the
	 * single most expensive mistake this extension could make.
	 *
	 * Fetching per prompt invited exactly that: one transient failure would drop the
	 * spec for a turn and restore it the next, flapping the prompt back and forth.
	 * Memoised, it can only ever change once.
	 */
	let cachedSpec: string | undefined;
	const specOnce = async (): Promise<string> => {
		if (cachedSpec === undefined) {
			const fetched = await runText(pi, "python3", [bridge, "spec"]);
			if (fetched) cachedSpec = fetched;
		}
		return cachedSpec ?? "";
	};

	/** Identifiers every bridge call needs. Omitting --cwd silently degrades
	 *  retrieval to a global-only search, so it is always passed. */
	const identity = (ctx: ExtensionContext): string[] => [
		"--session",
		ctx.sessionManager.getSessionId() ?? "",
		"--transcript",
		ctx.sessionManager.getSessionFile() ?? "",
		"--cwd",
		ctx.cwd,
	];

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		// A fresh user prompt restores the gate's budget.
		enforcements = 0;

		// Standing context is a once-per-session injection, mirroring the
		// `if is_first_prompt(...)` block Claude Code runs it inside. The bridge
		// facade is deliberately ungated, so the gate lives here. Claimed before
		// the await so a concurrent prompt cannot double-inject.
		const wantBootstrap = !bootstrapped;
		bootstrapped = true;

		const [spec, context, bootstrap, staged] = await Promise.all([
			specOnce(),
			// --first selects layer 1 (threshold 0.30) over layer 1.5 (0.55, enriched
			// with the last assistant excerpt), matching how the other host layers
			// the first prompt against the ones after it.
			runText(
				pi,
				"python3",
				[bridge, "retrieve", ...(wantBootstrap ? ["--first"] : []), "--query", event.prompt, ...identity(ctx)],
				{ timeoutMs: RETRIEVE_TIMEOUT_MS },
			),
			wantBootstrap
				? runText(pi, "python3", [bridge, "bootstrap", "--query", event.prompt, ...identity(ctx)], {
						timeoutMs: RETRIEVE_TIMEOUT_MS,
					})
				: Promise.resolve(""),
			// Reminders the previous turn deferred to this one. Cheap: no embedding.
			runText(pi, "python3", [bridge, "staged", ...identity(ctx)], { timeoutMs: CAPTURE_TIMEOUT_MS }),
		]);

		// The spec is an instruction, so it belongs in the system prompt. Retrieved
		// memories are data about this conversation, so they ride alongside the user
		// message instead -- and stay out of the UI, since the user did not ask for them.
		const result: BeforeAgentStartEventResult = {};
		if (spec) result.systemPrompt = `${event.systemPrompt}\n\n${spec}`;

		// Bootstrap leads (it orients the whole session), retrieval follows (it
		// answers this prompt). Both ride as a trailing message rather than in the
		// system prompt: bootstrap appears on one turn only, so putting it in the
		// prompt would flap the cache prefix, and as a message it simply stays in
		// the conversation from then on -- which is what standing context wants.
		// Same order the other host assembles: standing context orients the session,
		// retrieval answers this prompt, deferred reminders land last.
		const injected = [bootstrap, context, staged].filter((part) => part.length > 0).join("\n\n");
		if (injected) {
			result.message = {
				customType: "cairn-context",
				content: injected,
				display: false,
			};
		}
		return result;
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		const text = assistantText(event.messages);
		if (!text) return;

		await withTextFile(text, async (file) => {
			const args = ["--text-file", file, ...identity(ctx), "--continuation", String(enforcements)];

			// Capture first: even a response that fails the gate may carry entries
			// worth keeping, and the re-prompt should not cost us them.
			await run(pi, "python3", [bridge, "capture", ...args], { timeoutMs: CAPTURE_TIMEOUT_MS });

			if (enforcements >= MAX_ENFORCEMENTS_PER_PROMPT) return;

			// enforce prints a re-prompt reason, or nothing at all to allow the stop.
			// Empty stdout is the ALLOW signal -- and is also what a crashed bridge
			// produces, since every subcommand exits 0 regardless. Both mean "let the
			// turn end", which is the safe direction to fail in.
			const reason = await runText(
				pi,
				"python3",
				// On a retry, skip the strict well-formedness pass so a second
				// imperfect-but-present block is accepted rather than looping.
				[bridge, "enforce", ...args, "--continuation", String(enforcements)],
				{ timeoutMs: CAPTURE_TIMEOUT_MS },
			);
			if (!reason) return;

			enforcements += 1;
			// Queued from agent_end specifically: the agent loop checks for queued
			// messages after emitting this event and continues instead of stopping.
			// The same call from turn_end would be absorbed as an ordinary continuation.
			pi.sendUserMessage(reason, { deliverAs: "followUp" });
		});
	});

	pi.registerTool({
		name: "cairn_query",
		label: "cairn",
		description:
			"Search persistent memory from previous sessions: past decisions and their rejected " +
			"alternatives, corrections, user preferences, and project facts. Use it before " +
			"answering any question about prior work, past decisions, or the user themselves, " +
			"and whenever the conversation alone does not tell you why something is the way it is.",
		// Without promptSnippet the tool never appears in the system prompt's list of
		// available tools, so the model simply never learns it exists. The previous
		// port's passive-only integration is believed to have failed for this reason.
		promptSnippet: "cairn_query - search persistent memory from previous sessions",
		promptGuidelines: [
			"Query cairn_query before reconstructing past work from logs, transcripts or git history.",
			"Use mode 'semantic' for a paraphrase of an idea, 'keyword' for an exact term.",
			"Use mode 'context' with a memory id to see the full reasoning behind a one-line result.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search terms, a paraphrase, or a memory id for mode=context" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("keyword"), Type.Literal("semantic"), Type.Literal("context"), Type.Literal("recent")], {
					description: "Search mode (default: semantic)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const mode = params.mode ?? "semantic";
			const flag = mode === "semantic" ? ["--semantic"] : mode === "context" ? ["--context"] : mode === "recent" ? ["--recent"] : [];
			const result = await run(pi, "python3", [queryScript, ...flag, params.query], {
				cwd: ctx.cwd,
				timeoutMs: QUERY_TIMEOUT_MS,
				signal,
			});
			const output = result.ok ? result.stdout.trim() : "No matching memories.";
			return { content: [{ type: "text", text: output }], details: { mode } };
		},
	});
}
