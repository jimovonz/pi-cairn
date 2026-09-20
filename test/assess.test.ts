import { describe, expect, it } from "vitest";
import { HIGH_BLAST_DEPENDENTS, sizeAssessment, summarizeNumstat, type AssessmentInput } from "../lib/assess.ts";

const base: AssessmentInput = {
	filesChanged: 1,
	maxDependents: 0,
	hasTests: true,
	touchesRiskPath: false,
	constraintCount: 0,
	docsOnly: false,
};

describe("sizeAssessment", () => {
	it("tier 0 when the diff changes no behaviour", () => {
		expect(sizeAssessment({ ...base, docsOnly: true }).tier).toBe(0);
	});

	it("tier 1 for a tested single-file change", () => {
		expect(sizeAssessment(base).tier).toBe(1);
	});

	it("a missing test raises to tier 2", () => {
		expect(sizeAssessment({ ...base, hasTests: false }).tier).toBe(2);
	});

	it("multi-file raises to tier 2 even with tests", () => {
		expect(sizeAssessment({ ...base, filesChanged: 3 }).tier).toBe(2);
	});

	it("a risk path raises to tier 3", () => {
		expect(sizeAssessment({ ...base, touchesRiskPath: true }).tier).toBe(3);
	});

	it("high blast radius raises to tier 3", () => {
		expect(sizeAssessment({ ...base, maxDependents: HIGH_BLAST_DEPENDENTS }).tier).toBe(3);
	});

	// Asymmetry: blast radius is measured from the artifact, so a small tested
	// change to a widely-called symbol is still tier 3.
	it("a tested single-file change to a shared symbol is tier 3", () => {
		expect(sizeAssessment({ ...base, filesChanged: 1, maxDependents: 40 }).tier).toBe(3);
	});

	// Asymmetry: no signal ever lowers a tier below what a missing test implies.
	it("missing test plus risk path stays at tier 3", () => {
		expect(sizeAssessment({ ...base, hasTests: false, touchesRiskPath: true }).tier).toBe(3);
	});

	it("docs-only stays tier 0 even on a risk path", () => {
		expect(sizeAssessment({ ...base, docsOnly: true, touchesRiskPath: true }).tier).toBe(0);
	});

	it("records constraints only at tier 2 and above", () => {
		expect(sizeAssessment({ ...base, constraintCount: 3 }).reasons.join()).not.toContain("cairn constraints");
		expect(sizeAssessment({ ...base, hasTests: false, constraintCount: 3 }).reasons.join()).toContain("cairn constraints");
	});
});

describe("summarizeNumstat", () => {
	it("counts files and keeps paths", () => {
		const out = "10\t2\tsrc/a.ts\n0\t5\tsrc/b.ts\n";
		expect(summarizeNumstat(out)).toMatchObject({ filesChanged: 2, docsOnly: false });
		expect(summarizeNumstat(out).files).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("is docs-only when every changed file is documentation", () => {
		expect(summarizeNumstat("3\t0\tREADME.md\n").docsOnly).toBe(true);
		expect(summarizeNumstat("3\t0\tdocs/x.txt\n").docsOnly).toBe(true);
	});

	it("is not docs-only when code is mixed in", () => {
		expect(summarizeNumstat("1\t1\tREADME.md\n1\t1\tsrc/a.ts\n").docsOnly).toBe(false);
	});

	it("treats an empty diff as not docs-only", () => {
		expect(summarizeNumstat("")).toMatchObject({ filesChanged: 0, docsOnly: false });
	});

	it("ignores malformed and binary rows without crashing", () => {
		expect(summarizeNumstat("nonsense\n-\t-\tbin.dat\n").files).toEqual(["bin.dat"]);
	});
});
