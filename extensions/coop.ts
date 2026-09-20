/**
 * Cross-session cooperation for pi — a pull mailbox.
 *
 * pi sessions are separate processes that share a filesystem but no channel.
 * This adds the lowest-overhead one: sending writes a JSON file into the target
 * session's inbox; receiving drains it at before_agent_start and injects the
 * messages as a hidden custom message. The runner collects messages from every
 * extension, so this rides alongside cairn's injection rather than replacing it.
 *
 * No daemon, no socket, no watcher: one readdir on a hook that already fires,
 * and zero context cost when the inbox is empty.
 *
 * Layout (root from PI_COOP_DIR, else ~/.pi/agent/coop):
 *   peers/<session_id>.json      live-session registry (written on start)
 *   inbox/<session_id>/*.json    queued messages, delivered oldest-first
 *   inbox/<session_id>/read/     consumed messages (kept for audit)
 *
 * Enabled unless PI_COOP=0.
 *
 * Tools:    coop_send(target, text), coop_peers()
 * Commands: /coop                       — list peers
 *           /coop <session-id> <text>   — send
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Peer {
	session_id: string;
	pid: number;
	cwd: string;
	started: string;
}

interface Msg {
	from: string;
	cwd?: string;
	text: string;
	ts: string;
}

function root(): string {
	return process.env.PI_COOP_DIR ?? join(homedir(), ".pi", "agent", "coop");
}

function enabled(): boolean {
	const v = process.env.PI_COOP;
	return v !== "0" && v !== "false";
}

function ensure(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

function peerFile(sid: string): string {
	return join(root(), "peers", `${sid}.json`);
}

function inboxDir(sid: string): string {
	return join(root(), "inbox", sid);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function writePeer(sid: string, cwd: string): void {
	if (!sid) return;
	try {
		ensure(join(root(), "peers"));
		const peer: Peer = { session_id: sid, pid: process.pid, cwd, started: new Date().toISOString() };
		writeFileSync(peerFile(sid), JSON.stringify(peer));
	} catch {
		/* fail open: cooperation is never load-bearing */
	}
}

function removePeer(sid: string): void {
	if (!sid) return;
	try {
		rmSync(peerFile(sid), { force: true });
	} catch {
		/* ignore */
	}
}

/** Live peers. `excludeSid` drops the caller; dead registry entries are pruned. */
function listPeers(excludeSid?: string): Peer[] {
	const dir = join(root(), "peers");
	if (!existsSync(dir)) return [];
	const out: Peer[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	for (const name of names) {
		try {
			const peer = JSON.parse(readFileSync(join(dir, name), "utf8")) as Peer;
			if (excludeSid && peer.session_id === excludeSid) continue;
			if (!alive(peer.pid)) {
				rmSync(join(dir, name), { force: true });
				continue;
			}
			out.push(peer);
		} catch {
			/* skip malformed */
		}
	}
	return out;
}

function resolveTarget(target: string, selfSid: string): { id: string; live: boolean } {
	const peers = listPeers(selfSid);
	const hit = peers.find((p) => p.session_id === target || p.session_id.startsWith(target));
	return { id: hit?.session_id ?? target, live: Boolean(hit) };
}

function send(target: string, text: string, from: string, cwd?: string): void {
	ensure(inboxDir(target));
	const msg: Msg = { from, cwd, text, ts: new Date().toISOString() };
	const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
	writeFileSync(join(inboxDir(target), name), JSON.stringify(msg));
}

function drain(sid: string): Msg[] {
	const dir = inboxDir(sid);
	if (!existsSync(dir)) return [];
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const msgs: Msg[] = [];
	for (const name of files) {
		try {
			msgs.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as Msg);
			const readDir = join(dir, "read");
			ensure(readDir);
			renameSync(join(dir, name), join(readDir, name));
		} catch {
			/* skip malformed; leave the file for inspection */
		}
	}
	return msgs;
}

function render(msgs: Msg[]): string {
	const lines = msgs.map(
		(m) => `- from ${m.from}${m.cwd ? ` (${m.cwd})` : ""} at ${m.ts}: ${m.text}`,
	);
	const senders = [...new Set(msgs.map((m) => m.from))].join(", ");
	return (
		"COOP MESSAGES from other pi sessions (reply with the coop_send tool to a sender id below):\n" +
		lines.join("\n") +
		`\nSenders: ${senders}`
	);
}

export default function (pi: ExtensionAPI) {
	if (!enabled()) return;

	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
		writePeer(ctx.sessionManager.getSessionId() ?? "", ctx.cwd);
	});

	pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
		removePeer(ctx.sessionManager.getSessionId() ?? "");
	});

	pi.on("before_agent_start", async (_event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		const id = ctx.sessionManager.getSessionId() ?? "";
		if (!id) return undefined;
		writePeer(id, ctx.cwd); // refresh cwd/pid in case of a resumed session
		const msgs = drain(id);
		if (msgs.length === 0) return undefined;
		const result: BeforeAgentStartEventResult = {
			message: { customType: "coop", content: render(msgs), display: false },
		};
		return result;
	});

	pi.registerTool({
		name: "coop_send",
		label: "Coop Send",
		description:
			"Send a message to another live pi session (session id or unique prefix). " +
			"Use coop_peers to list targets. Delivered on the target's next prompt.",
		parameters: Type.Object({
			target: Type.String({ description: "target session id, or a unique prefix" }),
			text: Type.String({ description: "message text" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const from = ctx.sessionManager.getSessionId() ?? "";
			const { id, live } = resolveTarget(params.target, from);
			send(id, params.text, from, ctx.cwd);
			return {
				content: [
					{
						type: "text" as const,
						text: `Queued coop message for ${id}${live ? "" : " (no live peer matched; it will be delivered if that session runs)"}.`,
					},
				],
				details: { target: id, live },
			};
		},
	});

	pi.registerTool({
		name: "coop_peers",
		label: "Coop Peers",
		description: "List other live pi sessions on this machine (session id, cwd, pid).",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const peers = listPeers(ctx.sessionManager.getSessionId() ?? "");
			const text = peers.length
				? peers.map((p) => `${p.session_id}  pid=${p.pid}  ${p.cwd}  since ${p.started}`).join("\n")
				: "No live peer pi sessions.";
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});

	pi.registerCommand("coop", {
		description: "coop — list peer sessions; coop <session-id> <text> — send a message",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const selfSid = ctx.sessionManager.getSessionId() ?? "";
			if (parts.length === 0 || parts[0] === "peers") {
				const peers = listPeers(selfSid);
				ctx.ui.notify(
					peers.length
						? peers.map((p) => `${p.session_id.slice(0, 8)}  ${p.cwd}`).join("\n")
						: "No live peer pi sessions.",
					"info",
				);
				return;
			}
			const target = parts[0];
			const text = parts.slice(1).join(" ");
			if (!text) {
				ctx.ui.notify("usage: /coop <session-id> <text>", "warning");
				return;
			}
			const { id, live } = resolveTarget(target, selfSid);
			send(id, text, selfSid, ctx.cwd);
			ctx.ui.notify(`Queued coop message for ${id}${live ? "" : " (no live peer matched)"}`, "info");
		},
	});
}
