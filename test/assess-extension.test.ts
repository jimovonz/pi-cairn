import { afterEach, describe, expect, it, vi } from "vitest";
import assessExtension, { renderReport } from "../extensions/assess.ts";
import type { Assessment, AssessmentInput } from "../lib/assess.ts";

const signals: AssessmentInput = {
	filesChanged: 3,
	maxDependents: 40,
	hasTests: false,
	touchesRiskPath: true,
	constraintCount: 0,
	docsOnly: false,
};

const assessment: Assessment = { tier: 3, reasons: ["no test coverage -> verifier substitutes for the oracle", "touches a risk path"] };

describe("renderReport", () => {
	it("names the tier and the triaged signals", () => {
		const text = renderReport(assessment, signals);
		expect(text).toContain("tier 3");
		expect(text).toContain("max dependents: 40");
		expect(text).toContain("touches a risk path");
	});
});

describe("assessExtension registration", () => {
	afterEach(() => vi.unstubAllEnvs());

	function fakePi() {
		const calls: string[] = [];
		const pi = {
			registerCommand: (name: string) => calls.push(`command:${name}`),
			registerTool: (tool: { name: string }) => calls.push(`tool:${tool.name}`),
		};
		return { pi, calls };
	}

	it("registers nothing when PI_ASSESS is unset", () => {
		vi.stubEnv("PI_ASSESS", "");
		const { pi, calls } = fakePi();
		assessExtension(pi as never);
		expect(calls).toEqual([]);
	});

	it("registers the command and tool when PI_ASSESS=1", () => {
		vi.stubEnv("PI_ASSESS", "1");
		const { pi, calls } = fakePi();
		assessExtension(pi as never);
		expect(calls).toEqual(["command:assess", "tool:completion_assess"]);
	});
});
