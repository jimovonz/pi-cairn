/**
 * Code-graph lookup for pi.
 *
 * The graph already PUSHES into pi: cache-wrap.py appends a `[cairn-graph: ...]`
 * footer to bash output, and that arrives for free once routing.ts is enabled. This
 * file adds the PULL half -- a tool the model can reach for deliberately.
 *
 * It exists mainly for discoverability. The model can already run `cairn-graph` in
 * bash, but in testing it only did so after a denial told it to; a registered tool
 * with a promptSnippet is advertised in the system prompt, so the graph becomes the
 * first move rather than the consolation prize.
 *
 * Off unless PI_GRAPH is set.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { run } from "../lib/bridge.ts";

const GRAPH_TIMEOUT_MS = 20_000;

/** Queries taking a symbol, a file, or nothing -- the CLI is positional and rigid. */
const SYMBOL_MODES = ["location", "callers", "callees", "tests", "knowledge", "context-pack", "impact"] as const;
const FILE_MODES = ["file-context"] as const;
const BARE_MODES = ["summary", "orientation"] as const;

export default function (pi: ExtensionAPI) {
	const flag = process.env.PI_GRAPH;
	if (flag !== "1" && flag !== "true") return;

	pi.registerTool({
		name: "code_graph",
		label: "graph",
		description:
			"Look up code structure from the repository's symbol graph: where a symbol is defined, " +
			"what calls it, what it calls, which tests cover it, and its blast radius. Prefer this " +
			"over grepping for a definition, and use it before reading a file so you can read only " +
			"the relevant line range rather than the whole file.",
		// Without promptSnippet the tool is absent from the system prompt's tool list
		// and the model never learns it exists.
		promptSnippet: "code_graph - look up symbol locations, callers, callees and tests",
		promptGuidelines: [
			"Use mode 'location' to find a symbol before reading a file, then read only that line range.",
			"Use 'context-pack' when you need the body, its callers and its tests together.",
			"Use 'impact' before editing a symbol to see how far the change reaches.",
			"Use 'summary' or 'orientation' with no target to get oriented in an unfamiliar repo.",
		],
		parameters: Type.Object({
			mode: Type.Union(
				[...SYMBOL_MODES, ...FILE_MODES, ...BARE_MODES].map((m) => Type.Literal(m)),
				{ description: "Which graph query to run" },
			),
			target: Type.Optional(
				Type.String({ description: "Symbol name, or a file path for mode 'file-context'. Omit for summary/orientation." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const needsTarget = !(BARE_MODES as readonly string[]).includes(params.mode);
			const target = params.target?.trim();
			if (needsTarget && !target) {
				return {
					content: [{ type: "text", text: `Mode '${params.mode}' requires a target.` }],
					details: { mode: params.mode },
					isError: true,
				};
			}

			// The CLI is hand-rolled and positional: one flag, then the rest of argv is
			// joined into the symbol. It exits 1 on bad usage or a missing graph.db, so
			// unlike the cairn bridge this one's exit code is meaningful.
			const args = [`--${params.mode}`, ...(needsTarget && target ? [target] : [])];
			const result = await run(pi, "cairn-graph", args, { cwd: ctx.cwd, timeoutMs: GRAPH_TIMEOUT_MS, signal });

			if (result.ok) {
				return { content: [{ type: "text", text: result.stdout.trim() }], details: { mode: params.mode } };
			}
			// A silent success means the symbol simply is not in the graph -- worth saying
			// plainly, because the model should then fall back to grep rather than retry.
			const message = result.stderr.trim() || `No graph result for '${target ?? params.mode}'. The symbol may not be indexed; try grep, or run 'crg build' if this repo has no graph yet.`;
			return { content: [{ type: "text", text: message }], details: { mode: params.mode }, isError: false };
		},
	});
}
