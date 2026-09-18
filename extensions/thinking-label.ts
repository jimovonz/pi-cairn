/**
 * Token counts in pi's collapsed-thinking header.
 *
 * With `hideThinkingBlock: true`, pi already collapses each thinking block to a
 * one-line label (assistant-message.ts:145) and exposes setHiddenThinkingLabel to
 * change its text. This fills that label with the size of the reasoning you are no
 * longer looking at -- which is the number worth surfacing, given reasoning bills as
 * output and has measured around half of all output tokens here.
 *
 * Display only. It never returns a result from any handler, so it cannot alter the
 * transcript, and every failure is swallowed: a label is never worth a broken turn.
 *
 * Needs no patching of pi. Off if PI_THINKING_LABEL=0.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Rough while streaming, since usage only lands when the message completes. */
const CHARS_PER_TOKEN = 4;

function thinkingChars(message: unknown): number {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const block of content) {
		const b = block as { type?: unknown; thinking?: unknown };
		if (b?.type === "thinking" && typeof b.thinking === "string") n += b.thinking.length;
	}
	return n;
}

/** Real reasoning tokens, once the provider has reported them. */
function reasoningTokens(message: unknown): number | undefined {
	const usage = (message as { usage?: { reasoning?: unknown } })?.usage;
	return typeof usage?.reasoning === "number" && usage.reasoning > 0 ? usage.reasoning : undefined;
}

export function formatCount(n: number): string {
	return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString("en-US");
}

/**
 * Build the label.
 *
 * Streaming shows an estimate and says so with a tilde; the settled label drops the
 * tilde only when the count is the provider's own, so the two are never confused.
 */
export function buildLabel(
	chars: number,
	tokens: number | undefined,
	streaming: boolean,
	outputRatePerM?: number,
): string {
	if (streaming) {
		const est = Math.ceil(chars / CHARS_PER_TOKEN);
		return est > 0 ? `Thinking… ~${formatCount(est)} tokens` : "Thinking…";
	}
	if (tokens === undefined) {
		const est = Math.ceil(chars / CHARS_PER_TOKEN);
		return est > 0 ? `Thinking ~${formatCount(est)} tokens` : "Thinking";
	}
	const cost = outputRatePerM ? ` · $${((tokens * outputRatePerM) / 1e6).toFixed(4)}` : "";
	return `Thinking ${formatCount(tokens)} tokens${cost}`;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_THINKING_LABEL === "0" || process.env.PI_THINKING_LABEL === "false") return;

	// pi repaints contiguous whole-line ranges, so pushing an unchanged label would
	// make it redraw neighbouring lines for nothing. Only write on change.
	let last = "";

	const update = (message: unknown, ctx: ExtensionContext, streaming: boolean) => {
		try {
			if ((message as { role?: unknown })?.role !== "assistant") return;
			const chars = thinkingChars(message);
			if (chars === 0) return;
			const label = buildLabel(chars, reasoningTokens(message), streaming, ctx.model?.cost?.output);
			if (label === last) return;
			last = label;
			ctx.ui.setHiddenThinkingLabel(label);
		} catch {
			// Display only: never break a turn over a label.
		}
	};

	pi.on("message_update", (event: { message?: unknown }, ctx: ExtensionContext) => update(event?.message, ctx, true));
	pi.on("message_end", (event: { message?: unknown }, ctx: ExtensionContext) => update(event?.message, ctx, false));
}
