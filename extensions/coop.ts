/**
 * Cross-session cooperation for pi — a per-session control socket + live registry.
 *
 * pi sessions are separate processes with no channel. This gives them one that
 * actually cooperates, modelled on Claude Code's agent manager (a live registry
 * plus dispatch/attach/logs/lifecycle) but with no daemon: each session binds a
 * unix socket and writes a registry sidecar. Sending connects and the receiver
 * injects immediately — push, not a poll — optionally waking a turn.
 *
 * Layout (root from PI_COOP_DIR, else $XDG_RUNTIME_DIR/pi-coop, else ~/.pi/agent/coop):
 *   run/<sid>.sock        unix socket; presence = the session is live
 *   peers/<sid>.json      {sessionId, pid, cwd, sessionFile, startedAt, status}
 *   inbox/<sid>/*.json    offline queue when the target socket is unreachable
 *
 * Protocol: newline-delimited JSON over the socket.
 *   -> {"op":"status"}                         <- {"ok":true, peer}
 *   -> {"op":"send","from","text","wake":bool}  <- {"ok":true,"delivered":"turn"|"context"}
 *   -> {"op":"log","n":20}                      <- {"ok":true,"log": "..."}
 *
 * Enabled unless PI_COOP=0. Overhead: one listening fd + one sidecar file.
 *
 * Tools:    coop_peers(), coop_send(target, text, wake?), coop_logs(target, n?)
 * Commands: /coop  |  /coop <session-id> <text>  |  /coop log <session-id>
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Peer {
	sessionId: string;
	pid: number;
	cwd: string;
	sessionFile: string;
	startedAt: string;
	status: string;
}

interface Msg {
	from: string;
	cwd?: string;
	text: string;
	ts: string;
}

const PASSIVE_STATUS = "idle";

function root(): string {
	return (
		process.env.PI_COOP_DIR ??
		(process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "pi-coop") : join(homedir(), ".pi", "agent", "coop"))
	);
}
function enabled(): boolean {
	const v = process.env.PI_COOP;
	return v !== "0" && v !== "false";
}
function ball(dir: string): void {
	mkdirSync(dir, { recursive: true });
}
const runDir = () => join(root(), "run");
const peersDir = () => join(root(), "peers");
const inboxDir = (sid: string) => join(root(), "inbox", sid);
const sockPath = (sid: string) => join(runDir(), `${sid}.sock`);
const peerPath = (sid: string) => join(peersDir(), `${sid}.json`);

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function listPeers(excludeSid?: string): Peer[] {
	const dir = peersDir();
	if (!existsSync(dir)) return [];
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const out: Peer[] = [];
	for (const name of names) {
		try {
			const peer = JSON.parse(readFileSync(join(dir, name), "utf8")) as Peer;
			if (excludeSid && peer.sessionId === excludeSid) continue;
			if (!alive(peer.pid)) {
				rmSync(join(dir, name), { force: true });
				rmSync(sockPath(peer.sessionId), { force: true });
				continue;
			}
			peer.status = existsSync(sockPath(peer.sessionId)) ? peer.status || PASSIVE_STATUS : "no-socket";
			out.push(peer);
		} catch {
			/* skip malformed */
		}
	}
	return out;
}

function resolveTarget(target: string, selfSid: string): Peer | undefined {
	const peers = listPeers(selfSid);
	return peers.find((p) => p.sessionId === target || p.sessionId.startsWith(target));
}

function writePeer(peer: Peer): void {
	try {
		ball(peersDir());
		writeFileSync(peerPath(peer.sessionId), JSON.stringify(peer));
	} catch {
		/* cooperation is never load-bearing */
	}
}

function queueOffline(target: string, msg: Msg): void {
	ball(inboxDir(target));
	writeFileSync(join(inboxDir(target), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`), JSON.stringify(msg));
}

function drainOffline(sid: string): Msg[] {
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
			ball(readDir);
			renameSync(join(dir, name), join(readDir, name));
		} catch {
			/* skip malformed */
		}
	}
	return msgs;
}

/** Request/reply against a peer's socket. Resolves null on any failure. */
function rpc(target: Peer, payload: unknown, timeoutMs = 1500): Promise<string | null> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (v: string | null) => {
			if (!done) {
				done = true;
				sock.destroy();
				resolve(v);
			}
		};
		const sock = netConnect(sockPath(target.sessionId));
		let buf = "";
		sock.setTimeout(timeoutMs);
		sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
		sock.on("data", (d: Buffer) => {
			buf += d.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) finish(buf.slice(0, nl));
		});
		sock.on("timeout", () => finish(null));
		sock.on("error", () => finish(null));
	});
}

function tailLog(sessionFile: string, n: number): string {
	try {
		const raw = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
		const lines = raw.slice(Math.max(0, raw.length - n));
		const out: string[] = [];
		for (const line of lines) {
			try {
				const e = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
				const role = e?.message?.role ?? e?.type ?? "?";
				let text = "";
				const c = e?.message?.content;
				if (typeof c === "string") text = c;
				else if (Array.isArray(c)) {
					text = c
						.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text?: unknown }).text ?? "") : ""))
						.join(" ");
				}
				out.push(`${role}: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
			} catch {
				/* skip non-JSON */
			}
		}
		return out.join("\n") || "(no readable turns)";
	} catch (e) {
		return `(log unavailable: ${String(e)})`;
	}
}

function renderOffline(msgs: Msg[]): string {
	const lines = msgs.map((m) => `- from ${m.from}${m.cwd ? ` (${m.cwd})` : ""} at ${m.ts}: ${m.text}`);
	const senders = [...new Set(msgs.map((m) => m.from))].join(", ");
	return (
		"COOP MESSAGES from other pi sessions (reply with the coop_send tool):\n" +
		lines.join("\n") +
		`\nSenders: ${senders}`
	);
}

export default function (pi: ExtensionAPI) {
	if (!enabled()) return;

	const sid = { current: "" };
	let server: Server | undefined;
	let startedAt = new Date().toISOString();

	const inject = (from: string, text: string, wake: boolean): "turn" | "context" | "failed" => {
		const body = `COOP MESSAGE from session ${from}:\n${text}`;
		if (wake) {
			// Always triggers a turn. deliverAs is only valid while streaming; try
			// idle first, then streaming. On any failure fall back to context.
			try {
				pi.sendUserMessage(body);
				return "turn";
			} catch {
				try {
					pi.sendUserMessage(body, { deliverAs: "followUp" });
					return "turn";
				} catch {
					/* fall through */
				}
			}
		}
		try {
			pi.sendMessage({ customType: "coop", content: body, display: false }, { deliverAs: "nextTurn" });
			return "context";
		} catch {
			return "failed";
		}
	};

	const handle = (raw: unknown): unknown => {
		const req = raw as { op?: string; from?: string; text?: string; wake?: boolean; n?: number };
		if (req.op === "status") {
			return { ok: true, peer: readPeer(sid.current) };
		}
		if (req.op === "send") {
			if (!req.text) return { ok: false, error: "empty text" };
			const delivered = inject(req.from ?? "unknown", String(req.text), Boolean(req.wake));
			return { ok: delivered !== "failed", delivered };
		}
		if (req.op === "log") {
			const p = readPeer(sid.current);
			return { ok: true, log: p ? tailLog(p.sessionFile, Math.max(1, Math.min(100, req.n ?? 20))) : "(no session file)" };
		}
		return { ok: false, error: `unknown op ${req.op}` };
	};

	const startServer = (id: string) => {
		ball(runDir());
		try {
			rmSync(sockPath(id), { force: true }); // stale socket from a crashed run
		} catch {
			/* ignore */
		}
		server = createServer((sock: Socket) => {
			let buf = "";
			sock.on("data", (d: Buffer) => {
				buf += d.toString("utf8");
				let nl = buf.indexOf("\n");
				while (nl >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					nl = buf.indexOf("\n");
					try {
						sock.write(JSON.stringify(handle(JSON.parse(line))) + "\n");
					} catch (e) {
						sock.write(JSON.stringify({ ok: false, error: String(e) }) + "\n");
					}
				}
			});
			sock.on("error", () => {
				/* peer vanished mid-write; ignore */
			});
		});
		server.on("error", () => {
			/* another session already owns the socket; cooperation is best-effort */
		});
		try {
			server.listen(sockPath(id));
		} catch {
			/* ignore */
		}
	};

	const stopServer = () => {
		try {
			server?.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(sockPath(sid.current), { force: true });
		} catch {
			/* ignore */
		}
	};

	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
		sid.current = ctx.sessionManager.getSessionId() ?? "";
		if (!sid.current) return;
		startedAt = new Date().toISOString();
		writePeer({
			sessionId: sid.current,
			pid: process.pid,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile() ?? "",
			startedAt,
			status: PASSIVE_STATUS,
		});
		startServer(sid.current);
	});

	pi.on("session_shutdown", async (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
		stopServer();
		try {
			rmSync(peerPath(sid.current), { force: true });
		} catch {
			/* ignore */
		}
	});

	pi.on("before_agent_start", async (_event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		if (!sid.current) sid.current = ctx.sessionManager.getSessionId() ?? "";
		if (!sid.current) return undefined;
		writePeer({
			sessionId: sid.current,
			pid: process.pid,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile() ?? "",
			startedAt,
			status: "prompting",
		});
		const offline = drainOffline(sid.current);
		if (offline.length === 0) return undefined;
		return {
			message: { customType: "coop", content: renderOffline(offline), display: false },
		} satisfies BeforeAgentStartEventResult;
	});

	pi.on("agent_end", async (_event: AgentEndEvent, ctx: ExtensionContext) => {
		if (!sid.current) return;
		// status is only trustworthy if it reflects the current turn state: set to
		// "prompting" at before_agent_start, back to "idle" here. Socket presence
		// remains the real liveness signal; this is the busy/idle hint.
		writePeer({
			sessionId: sid.current,
			pid: process.pid,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile() ?? "",
			startedAt,
			status: PASSIVE_STATUS,
		});
	});

	pi.registerTool({
		name: "coop_peers",
		label: "Coop Peers",
		description: "List other live pi sessions (session id, cwd, pid, status).",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const peers = listPeers(ctx.sessionManager.getSessionId() ?? sid.current);
			const text = peers.length
				? peers.map((p) => `${p.sessionId}  pid=${p.pid}  status=${p.status}  ${p.cwd}`).join("\n")
				: "No live peer pi sessions.";
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});

	pi.registerTool({
		name: "coop_send",
		label: "Coop Send",
		description:
			"Send a message to another live pi session (id or unique prefix). Delivered to its socket " +
			"immediately; set wake=true to make it act on the message now, else it arrives as context " +
			"on its next turn. Falls back to a durable inbox if the target is not running.",
		parameters: Type.Object({
			target: Type.String({ description: "target session id, or a unique prefix" }),
			text: Type.String({ description: "message text" }),
			wake: Type.Optional(Type.Boolean({ description: "trigger a turn in the target (default false)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const from = ctx.sessionManager.getSessionId() ?? sid.current;
			const self = from;
			const peer = resolveTarget(params.target, self);
			const msg: Msg = { from, cwd: ctx.cwd, text: params.text, ts: new Date().toISOString() };
			if (peer) {
				const reply = await rpc(peer, { op: "send", from, text: params.text, wake: Boolean(params.wake) });
				if (reply) {
					try {
						const r = JSON.parse(reply) as { delivered?: string; ok?: boolean };
						if (r.ok) {
							return {
								content: [{ type: "text" as const, text: `Delivered to ${peer.sessionId} (${r.delivered ?? "ok"}).` }],
								details: { target: peer.sessionId, delivered: r.delivered },
							};
						}
					} catch {
						/* fall through to offline */
					}
				}
			}
			queueOffline(peer?.sessionId ?? params.target, msg);
			return {
				content: [
					{
						type: "text" as const,
						text: `Queued offline for ${peer?.sessionId ?? params.target} (no live socket; delivered when that session next runs).`,
					},
				],
				details: { target: peer?.sessionId ?? params.target, offline: true },
			};
		},
	});

	pi.registerTool({
		name: "coop_logs",
		label: "Coop Logs",
		description: "Read the recent turns of another live pi session.",
		parameters: Type.Object({
			target: Type.String({ description: "target session id, or a unique prefix" }),
			n: Type.Optional(Type.Number({ description: "how many recent entries (default 20)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const self = ctx.sessionManager.getSessionId() ?? sid.current;
			const peer = resolveTarget(params.target, self);
			if (!peer) {
				return { content: [{ type: "text" as const, text: `No live peer matching ${params.target}.` }], details: {} };
			}
			const reply = await rpc(peer, { op: "log", n: params.n ?? 20 });
			let log = "(unavailable)";
			if (reply) {
				try {
					log = (JSON.parse(reply) as { log?: string }).log ?? log;
				} catch {
					/* ignore */
				}
			}
			return { content: [{ type: "text" as const, text: log }], details: { target: peer.sessionId } };
		},
	});

	pi.registerCommand("coop", {
		description: "coop — peers | coop <session-id> <text> | coop log <session-id>",
		handler: async (args, ctx) => {
			const self = ctx.sessionManager.getSessionId() ?? sid.current;
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				const peers = listPeers(self);
				ctx.ui.notify(
					peers.length
						? peers.map((p) => `${p.sessionId.slice(0, 8)}  ${p.status}  ${p.cwd}`).join("\n")
						: "No live peer pi sessions.",
					"info",
				);
				return;
			}
			if (parts[0] === "log" && parts[1]) {
				const peer = resolveTarget(parts[1], self);
				ctx.ui.notify(peer ? tailLog(peer.sessionFile, 12) : `No live peer matching ${parts[1]}`, "info");
				return;
			}
			const target = parts[0];
			const text = parts.slice(1).join(" ");
			if (!text) {
				ctx.ui.notify("usage: /coop <session-id> <text> | /coop log <session-id>", "warning");
				return;
			}
			const peer = resolveTarget(target, self);
			const reply = peer ? await rpc(peer, { op: "send", from: self, text, wake: false }) : null;
			if (reply) {
				ctx.ui.notify(`Delivered to ${peer?.sessionId}.`, "info");
			} else {
				queueOffline(peer?.sessionId ?? target, { from: self, cwd: ctx.cwd, text, ts: new Date().toISOString() });
				ctx.ui.notify(`Queued offline for ${peer?.sessionId ?? target}.`, "info");
			}
		},
	});
}

function readPeer(sid: string): Peer | undefined {
	try {
		return JSON.parse(readFileSync(peerPath(sid), "utf8")) as Peer;
	} catch {
		return undefined;
	}
}
