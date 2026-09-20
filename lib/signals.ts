/**
 * Gather the signals tier sizing needs, from the produced diff and the code graph.
 *
 * Everything here is best-effort and never throws: a failed gather must RAISE the
 * tier, never lower it, so an unreadable graph is treated as "high blast radius"
 * rather than "safe". That is the safe direction to fail in, matching the
 * fail-closed stance in goal.ts and the cairn gate.
 *
 * Call budget: one `--file-context` plus one `--impact` per changed file, capped at
 * `maxFiles`. This runs in the turn hot path, so it stays bounded by file count, not
 * symbol count.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HIGH_BLAST_DEPENDENTS, summarizeNumstat, type AssessmentInput } from "./assess.ts";
import { run } from "./bridge.ts";

const GRAPH_DB = join(".code-review-graph", "graph.db");

/**
 * Refresh the graph in place before reading it.
 *
 * The graph lags the working tree: it is only refreshed out-of-band (hourly sweep,
 * HEAD change). The assessment asks about the diff just produced, so it must close
 * that window. Measured ~0.25s on an 18k-node repo with --skip-postprocess; the
 * default postprocess is ~0.95s and dominated by an FTS rebuild these node queries
 * do not use. Newly-created files are NOT added by `update` (they need a full
 * `build`), so they still fall through to the unknown-signal path.
 *
 * ponytail: --skip-postprocess suffices for nodes/edges; switch to --skip-flows if a
 * future query (e.g. the deferred --knowledge join) needs the FTS index.
 */
async function freshenGraph(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<void> {
	if (!existsSync(join(cwd, GRAPH_DB))) return;
	await run(pi, "crg", ["update", "--repo", cwd, "--skip-postprocess"], { cwd, signal, timeoutMs: 20_000 });
}

/** Config, security, generated or lock files: a change here is never tier 1. */
const RISK_PATH =
	/(^|\/)(models\.generated\.ts|.*\.generated\.ts|package-lock\.json|npm-shrinkwrap\.json|.*\.lock)$|(^|\/)(config|security|auth)(\/|\.)/i;

export interface SignalOptions {
	cwd: string;
	signal?: AbortSignal;
	/** Changed files to inspect. Bounds the subprocess count. */
	maxFiles?: number;
}

export interface FileSymbol {
	name: string;
	callers: number;
}

/**
 * Symbols from `cairn-graph --file-context`. The header line (`path — N symbol(s)`)
 * and any prose are skipped; only indented `name()` rows count.
 */
export function parseFileContext(stdout: string): FileSymbol[] {
	const symbols: FileSymbol[] = [];
	for (const line of stdout.split("\n")) {
		const name = line.match(/^\s+([\w.$]+)\s*\(\s*\)/);
		if (!name) continue;
		const callers = line.match(/callers:(\d+)/);
		symbols.push({ name: name[1], callers: callers ? Number(callers[1]) : 0 });
	}
	return symbols;
}

/** One-line `callers:191 tests:118 files:13` from `cairn-graph --impact`. */
export function parseImpact(stdout: string): { callers: number; tests: number; files: number } {
	const field = (re: RegExp): number => {
		const m = stdout.match(re);
		return m ? Number(m[1]) : 0;
	};
	return {
		callers: field(/callers:(\d+)/),
		tests: field(/tests:(\d+)/),
		files: field(/files:(\d+)/),
	};
}

export async function gatherSignals(pi: ExtensionAPI, opts: SignalOptions): Promise<AssessmentInput> {
	const cwd = opts.cwd;
	const maxFiles = opts.maxFiles ?? 8;

	const diff = await run(pi, "git", ["diff", "--numstat"], { cwd, signal: opts.signal });
	const summary = summarizeNumstat(diff.ok ? diff.stdout : "");
	const files = summary.files.slice(0, maxFiles);

	// An empty diff changes nothing: tier 0, regardless of what the graph says.
	if (files.length === 0) {
		return {
			filesChanged: 0,
			maxDependents: 0,
			hasTests: true,
			touchesRiskPath: false,
			constraintCount: 0,
			docsOnly: true,
		};
	}

	await freshenGraph(pi, cwd, opts.signal);

	let maxDependents = 0;
	let resolvedSymbols = 0;
	let hasTests = false;

	for (const file of files) {
		const context = await run(pi, "cairn-graph", ["--file-context", file], { cwd, signal: opts.signal });
		const symbols = parseFileContext(context.stdout);
		resolvedSymbols += symbols.length;

		let top: FileSymbol | undefined;
		for (const symbol of symbols) {
			if (symbol.callers > maxDependents) maxDependents = symbol.callers;
			if (!top || symbol.callers > top.callers) top = symbol;
		}

		// --file-context has no test counts, so probe the widest symbol for them.
		// Tests run through a file's most-depended-on symbol is a good enough proxy.
		if (top) {
			const impact = await run(pi, "cairn-graph", ["--impact", top.name], { cwd, signal: opts.signal });
			if (parseImpact(impact.stdout).tests > 0) hasTests = true;
		}
	}

	return {
		filesChanged: summary.filesChanged,
		// No symbol resolved means the blast radius is unknown: fail toward "high".
		maxDependents: resolvedSymbols > 0 ? maxDependents : HIGH_BLAST_DEPENDENTS,
		hasTests,
		touchesRiskPath: files.some((file) => RISK_PATH.test(file)),
		// ponytail: constraint join (cairn-graph --knowledge) deferred; 0 here means
		// the verifier gets no binding constraints yet, which only under-checks.
		constraintCount: 0,
		docsOnly: summary.docsOnly,
	};
}
