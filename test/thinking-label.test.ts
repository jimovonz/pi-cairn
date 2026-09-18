import { afterEach, describe, expect, it } from "vitest";
import labelExtension, { buildLabel, formatCount } from "../extensions/thinking-label.ts";

describe("formatCount", () => {
	it("switches to k notation only above 10k", () => {
		expect(formatCount(950)).toBe("950");
		expect(formatCount(9999)).toBe("9,999");
		expect(formatCount(12_400)).toBe("12.4k");
	});
});

describe("buildLabel", () => {
	it("marks a streaming estimate with a tilde", () => {
		expect(buildLabel(400, undefined, true)).toBe("Thinking… ~100 tokens");
	});

	it("drops the tilde only for a real provider count", () => {
		// The tilde is the only signal separating an estimate from a measured count;
		// showing a guess as exact would undermine reconciling against spend.
		expect(buildLabel(400, 137, false)).toMatch(/^Thinking 137 tokens/);
		expect(buildLabel(400, undefined, false)).toBe("Thinking ~100 tokens");
	});

	it("appends cost when the output rate is known", () => {
		expect(buildLabel(0, 1000, false, 1.2)).toBe("Thinking 1,000 tokens · $0.0012");
	});

	it("omits cost when the rate is unknown", () => {
		expect(buildLabel(0, 1000, false)).toBe("Thinking 1,000 tokens");
	});

	it("says nothing quantitative when there is nothing to count", () => {
		expect(buildLabel(0, undefined, true)).toBe("Thinking…");
	});
});

function harness() {
	const handlers: Record<string, (e: unknown, c: unknown) => void> = {};
	const labels: string[] = [];
	const pi = { on: (e: string, h: (ev: unknown, c: unknown) => void) => { handlers[e] = h; }, registerCommand: () => {}, registerTool: () => {} };
	const ctx = { ui: { setHiddenThinkingLabel: (l: string) => labels.push(l) }, model: { cost: { output: 1.2 } } };
	return { pi, ctx, handlers, labels };
}

const msg = (thinking: string, reasoning?: number) => ({
	role: "assistant",
	content: [{ type: "thinking", thinking }, { type: "text", text: "answer" }],
	...(reasoning === undefined ? {} : { usage: { reasoning } }),
});

describe("thinking-label extension", () => {
	afterEach(() => { delete process.env.PI_THINKING_LABEL; });

	it("can be switched off", () => {
		process.env.PI_THINKING_LABEL = "0";
		const h = harness();
		labelExtension(h.pi as never);
		expect(Object.keys(h.handlers)).toHaveLength(0);
	});

	it("labels a streaming block, then a settled one with the real count", () => {
		const h = harness();
		labelExtension(h.pi as never);
		h.handlers.message_update?.({ message: msg("x".repeat(400)) }, h.ctx);
		h.handlers.message_end?.({ message: msg("x".repeat(400), 137) }, h.ctx);
		expect(h.labels[0]).toBe("Thinking… ~100 tokens");
		expect(h.labels[1]).toBe("Thinking 137 tokens · $0.0002");
	});

	it("writes only when the label changes, to avoid needless repaints", () => {
		const h = harness();
		labelExtension(h.pi as never);
		for (let i = 0; i < 5; i++) h.handlers.message_update?.({ message: msg("x".repeat(400)) }, h.ctx);
		expect(h.labels).toHaveLength(1);
	});

	it("ignores messages with no thinking, and non-assistant roles", () => {
		const h = harness();
		labelExtension(h.pi as never);
		h.handlers.message_update?.({ message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }, h.ctx);
		h.handlers.message_update?.({ message: { role: "user", content: [{ type: "thinking", thinking: "x" }] } }, h.ctx);
		expect(h.labels).toHaveLength(0);
	});

	it("survives a context with no model cost information", () => {
		const h = harness();
		(h.ctx as { model?: unknown }).model = undefined;
		labelExtension(h.pi as never);
		h.handlers.message_end?.({ message: msg("x".repeat(40), 55) }, h.ctx);
		expect(h.labels[0]).toBe("Thinking 55 tokens");
	});
});
