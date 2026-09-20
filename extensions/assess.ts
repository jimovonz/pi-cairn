/**
 * Tier-sized completion assessment for pi.
 *
 * Sizes how much verification a diff deserves (lib/assess.ts) from the diff itself
 * and the code graph (lib/signals.ts). This file is only the surface: a `/assess`
 * command for you and a `completion_assess` tool for the model.
 *
 * Deliberately absent for now:
 *   - no `agent_end` hook, so no collision with goal.ts or cairn.ts
 *   - no requirement verifier and no gate enforcement; those come after the
 *     false-negative rate is measured
 *
 * Off unless PI_ASSESS is set.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sizeAssessment, type Assessment, type AssessmentInput } from "../lib/assess.ts";
import { gatherSignals } from "../lib/signals.ts";

const TIER_LABEL: Record<number, string> = {
	0: "0 - no behaviour change; nothing to verify",
	1: "1 - test-covered; run the declared tests",
	2: "2 - multi-file or untested; tests + traceability verifier vs spec",
	3: "3 - risk path or high blast radius; verifier vs spec + cairn constraints",
};

export function renderReport(assessment: Assessment, signals: AssessmentInput): string {
	return [
		`Assessment tier ${TIER_LABEL[assessment.tier]}`,
		`  files: ${signals.filesChanged}  max dependents: ${signals.maxDependents}  ` +
			`tests: ${signals.hasTests ? "yes" : "no"}  risk path: ${signals.touchesRiskPath ? "yes" : "no"}`,
		`  why: ${assessment.reasons.join("; ")}`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const flag = process.env.PI_ASSESS;
	if (flag !== "1" && flag !== "true") return;

	async function assess(cwd: string, signal?: AbortSignal): Promise<{ assessment: Assessment; signals: AssessmentInput }> {
		const signals = await gatherSignals(pi, { cwd, signal });
		return { assessment: sizeAssessment(signals), signals };
	}

	pi.registerCommand("assess", {
		description: "Size the completion assessment for the current diff",
		async handler(_args, ctx) {
			const { assessment, signals } = await assess(ctx.cwd);
			const text = renderReport(assessment, signals);
			ctx.ui.notify(text, "info");
			pi.sendMessage({ customType: "assess", content: text, display: true }, { triggerTurn: false });
		},
	});

	pi.registerTool({
		name: "completion_assess",
		label: "assess",
		description:
			"Size how much verification the current diff deserves before declaring the work done. " +
			"Returns an assessment tier from the produced diff and the code graph. Call it before " +
			"claiming completion; it does not verify the work itself yet, only says how much check is warranted.",
		promptSnippet: "completion_assess - check how much verification the current diff needs",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const { assessment, signals } = await assess(ctx.cwd, signal);
			return {
				content: [{ type: "text", text: renderReport(assessment, signals) }],
				details: { tier: assessment.tier, reasons: assessment.reasons, signals },
			};
		},
	});
}
