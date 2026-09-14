/**
 * One audited subprocess helper, shared by every handler in this repo.
 *
 * Two hard-won contracts are encoded here; read them before using `run()`.
 *
 * 1. SUCCESS IS STDOUT, NOT EXIT STATUS. `cairn/hooks/pi_bridge.py` wraps every
 *    import and body in a bare `except Exception` and returns None from every
 *    subcommand, so the process exits 0 even when nothing worked. `cch-batch.py`
 *    is exit-0 by design too. Callers must therefore branch on `result.ok`
 *    (non-empty trimmed stdout), never on `result.code`.
 *
 * 2. HANDLERS MUST NOT THROW. A throw inside a `tool_call` handler is converted
 *    by pi into "Extension failed, blocking execution" and denies the tool; a
 *    throw elsewhere surfaces as an extension error to the user. Every failure
 *    here is captured and returned as data, so callers can degrade silently and
 *    leave pi behaving exactly as it would without this extension installed.
 *
 * Note `pi.exec` is argv-only (no shell, no stdin) and `ExecOptions` carries only
 * `signal`/`timeout`/`cwd` -- there is no `env`. Anything needing an environment
 * variable must carry it inside the command string, the way CCH prefixes
 * `CCH_SESSION_ID=... cache-wrap.py -- <cmd>`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Default ceiling for a bridge call. Kept short: this runs in the turn hot path. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface BridgeOptions {
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface BridgeResult {
	stdout: string;
	stderr: string;
	code: number;
	/** Process was killed, usually by the timeout. */
	killed: boolean;
	/** The subprocess never ran, or threw. Distinct from "ran and said nothing". */
	errored: boolean;
	/**
	 * The only success signal worth trusting: the command produced output.
	 * See contract 1 above.
	 */
	ok: boolean;
}

/**
 * Run a command, capturing every failure mode as data.
 *
 * Never throws, never rejects.
 */
export async function run(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	options: BridgeOptions = {},
): Promise<BridgeResult> {
	try {
		const result = await pi.exec(command, args, {
			cwd: options.cwd,
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			signal: options.signal,
		});
		const stdout = result.stdout ?? "";
		return {
			stdout,
			stderr: result.stderr ?? "",
			code: result.code,
			killed: result.killed,
			errored: false,
			ok: stdout.trim().length > 0,
		};
	} catch (error) {
		return {
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			code: -1,
			killed: false,
			errored: true,
			ok: false,
		};
	}
}

/**
 * Convenience wrapper for the common case: trimmed stdout, or "" on any failure.
 */
export async function runText(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	options: BridgeOptions = {},
): Promise<string> {
	const result = await run(pi, command, args, options);
	return result.ok ? result.stdout.trim() : "";
}

/**
 * Run a command that needs data on stdin.
 *
 * `pi.exec` cannot do this -- it spawns with `stdio: ["ignore", "pipe", "pipe"]`,
 * so there is no stdin to write to. The CCH interceptors and `rtk hook` are all
 * stdin-driven JSON filters, hence this second path via node:child_process.
 *
 * Same contract as `run()`: never throws, never rejects.
 */
export async function runWithInput(
	command: string,
	args: string[],
	input: string,
	options: BridgeOptions = {},
): Promise<BridgeResult> {
	const { spawn } = await import("node:child_process");
	return new Promise<BridgeResult>((resolve) => {
		let settled = false;
		const finish = (result: BridgeResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		const failure = (message: string): BridgeResult => ({
			stdout: "",
			stderr: message,
			code: -1,
			killed: false,
			errored: true,
			ok: false,
		});

		try {
			const child = spawn(command, args, {
				cwd: options.cwd,
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				finish({ stdout, stderr, code: -1, killed: true, errored: false, ok: false });
			}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				finish(failure(error.message));
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				finish({
					stdout,
					stderr,
					code: code ?? -1,
					killed: false,
					errored: false,
					ok: stdout.trim().length > 0,
				});
			});
			// The child may exit before reading all of stdin; EPIPE is expected, not an error.
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		} catch (error) {
			finish(failure(error instanceof Error ? error.message : String(error)));
		}
	});
}
