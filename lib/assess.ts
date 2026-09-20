/**
 * Size the completion assessment to the diff that was actually produced.
 *
 * Tiers, cheapest first:
 *   0  no behaviour change (docs/comments/formatting) -- nothing to verify
 *   1  behaviour change with test coverage -- run the declared tests
 *   2  multi-file, or no test coverage -- tests + traceability verifier vs the spec
 *   3  risk path, or a shared symbol with high blast radius -- verifier vs spec + cairn constraints
 *
 * Two asymmetry rules, both of which only ever RAISE the tier:
 *   - a missing test is never cheaper than a present one (no oracle -> verifier)
 *   - blast radius is measured from the produced diff; a small request that lands
 *     on a widely-called symbol is tier 3, not tier 1
 *
 * This module is pure: it takes signals the caller has already measured (git diff,
 * `code_graph --impact`, risk-path match) and returns a tier plus the reasons, so
 * the choice can be logged and audited rather than assumed.
 */
export type Tier = 0 | 1 | 2 | 3;

/** Transitive dependents at or above this counts as a widely-reached symbol. */
export const HIGH_BLAST_DEPENDENTS = 5;

export interface AssessmentInput {
	/** Files touched by the produced diff. */
	filesChanged: number;
	/** Largest transitive dependents across the changed symbols; 0 if none/unknown. */
	maxDependents: number;
	/** Whether any changed path has test coverage. */
	hasTests: boolean;
	/** Whether any changed path matches a project risk path (config, security, generated). */
	touchesRiskPath: boolean;
	/** Non-superseded cairn constraints bound to the changed symbols. */
	constraintCount: number;
	/** The diff changes no behaviour: docs, comments, formatting only. */
	docsOnly: boolean;
}

export interface Assessment {
	tier: Tier;
	reasons: string[];
}

export interface DiffSummary {
	filesChanged: number;
	files: string[];
	/** Every changed file is documentation, so the diff changes no behaviour. */
	docsOnly: boolean;
}

// ponytail: extension-based docs detection, not comment-aware. A code file whose
// only change is a comment still counts as behaviour; upgrade to parsing the diff
// body if that produces false tier-1s.
const DOCS_FILE = /(^|\/)(readme|changelog|license|contributing)\.md$|\.md$|\.txt$|(^|\/)docs\//i;

/**
 * Read `git diff --numstat` output into the signals tier sizing needs.
 *
 * numstat rows are `added<TAB>deleted<TAB>path`; binary files show `-` for the
 * counts but keep the path, so the path is always the last tab-separated field.
 */
export function summarizeNumstat(stdout: string): DiffSummary {
	const files: string[] = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split("\t");
		if (parts.length < 3) continue;
		files.push(parts[parts.length - 1]);
	}
	return {
		filesChanged: files.length,
		files,
		docsOnly: files.length > 0 && files.every((file) => DOCS_FILE.test(file)),
	};
}

export function sizeAssessment(input: AssessmentInput): Assessment {
	if (input.docsOnly) {
		return { tier: 0, reasons: ["docs/comment-only change"] };
	}

	// Start from what the test coverage allows, then only raise.
	let tier: Tier = input.hasTests ? 1 : 2;
	const reasons: string[] = [
		input.hasTests ? "test coverage present" : "no test coverage -> verifier substitutes for the oracle",
	];

	if (input.filesChanged >= 2 && tier < 2) {
		tier = 2;
		reasons.push(`${input.filesChanged} files changed`);
	}
	if (input.touchesRiskPath) {
		tier = 3;
		reasons.push("touches a risk path");
	}
	if (input.maxDependents >= HIGH_BLAST_DEPENDENTS) {
		tier = 3;
		reasons.push(`${input.maxDependents} transitive dependents`);
	}
	if (input.constraintCount > 0 && tier >= 2) {
		reasons.push(`${input.constraintCount} bound cairn constraints join the verifier`);
	}
	return { tier, reasons };
}
