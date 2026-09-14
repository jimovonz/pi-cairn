# pi-cairn

Cairn memory, CCH/CCM context compression, the code-graph footer and RTK command
rewriting, for the [pi](https://github.com/earendil-works/pi) coding agent.

## Why this repo exists

An earlier version of this integration lived as uncommitted edits inside a pi
checkout — including a six-file patch to pi's core. When that checkout was deleted,
all of it went with it. The only piece that survived was the half that happened to
live in another repo.

So: **nothing here lives in the pi checkout.** `install.sh` registers these files
with pi by absolute path, and this repo stays the source of truth. A pi reinstall
costs nothing.

Registration is by path and **not** by symlinking into `~/.pi/agent/extensions`,
even though pi discovers symlinks there. jiti resolves an extension's imports
relative to the path it was loaded from, without dereferencing symlinks — so a
symlinked extension resolves `typebox` and `../lib/bridge.ts` against the symlink's
directory, where neither exists. Verified: loading via a symlink fails with
`Cannot find module 'typebox'` while the same file loaded by its real path works.

## Design

The heavy lifting stays in Python and is **shared with Claude Code** — the same
engine, the same policy, the same database — so the two hosts cannot drift. The
TypeScript here is thin glue that shells out:

| Layer | Shells out to | Gate |
|---|---|---|
| Memory | `cairn/hooks/pi_bridge.py` (`retrieve`/`capture`/`enforce`/`spec`) | `PI_CAIRN` |
| Routing | `guards.block()` via CCH | `PI_ROUTING` |
| Caching + graph footer + rules | `cache-wrap.py -- <cmd>` | `PI_CCM` |
| Token proxy | `rtk rewrite <cmd>` | `PI_RTK` |
| Code-graph lookup | `cairn-graph` | `PI_GRAPH` |

Wrapping bash in `cache-wrap.py` is what delivers the `[CCM_CACHED]` stub, the
symbol menu, the `[cairn-graph: …]` footer and `.cch/rules` all at once — none of
that is reimplemented here.

**No patch to pi's core is required.** The earlier port patched core to add a
post-turn gate, believing pi could not re-prompt after a turn. It can, and could
already: a handler on `agent_end` that calls
`pi.sendUserMessage(text, { deliverAs: "followUp" })` makes the agent loop continue
instead of stop. It has to be `agent_end` — `turn_end` messages are consumed as an
ordinary continuation, and `agent_settled` runs after the loop has exited.

## Three contracts worth knowing before editing

1. **Success is stdout, not exit status.** `pi_bridge.py` wraps everything in bare
   `except Exception` and exits 0 regardless; `cch-batch.py` is exit-0 by design.
   Branch on output, never on the exit code. `lib/bridge.ts` encodes this as `ok`.
2. **Handlers must not throw.** A throw in a `tool_call` handler becomes
   "Extension failed, blocking execution" and denies the tool. Every failure is
   captured and returned as data so that a broken layer degrades to stock pi.
3. **CCH judges the command before RTK rewrites it.** RTK turns `cat foo.ts` into
   `rtk read foo.ts`, which matches none of the bulk-read patterns `guards.block`
   looks for, so running RTK first disables the guards entirely — silently. Note
   this deliberately differs from CCH's own installer, which orders RTK before CCH:
   Claude Code hands every hook the original input, so ordering there does not chain
   the way a pipeline does.

## Performance

Measured on this machine, per call:

| Call | Cost | When |
|---|---|---|
| `pi_bridge spec` | 41 ms | once per user prompt |
| `pi_bridge retrieve` | **0.7 s with the daemon, 8.0 s without** | once per user prompt |
| `pi_bridge capture` | 241 ms | once per agent run |
| `pi_bridge enforce` | 48 ms | once per agent run |
| `intercept-bash.py` | 23 ms | per bash call |
| `rtk rewrite` | 15 ms | per bash call |

**Run the cairn embedding daemon.** It is the single biggest lever here: retrieval
spawns a fresh Python that loads sentence-transformers (3.3 s for the import alone)
unless the resident socket is up, which turns every prompt into an 8-second wait.

```bash
python3 ~/Projects/cairn/cairn/daemon.py start
```

`install.sh` checks for it and warns if it is down.

## Layout

```
extensions/cairn.ts     memory: before_agent_start + agent_end + cairn_query
extensions/routing.ts   one ordered tool_call pipeline
extensions/graph.ts     code_graph lookup tool (the graph pull half)
lib/bridge.ts           the only subprocess helper
patches/                pi's own build fix, so a fresh pi clone compiles
install.sh              registers extensions by path; --uninstall reverses it
```

## Install

```bash
./install.sh          # registers absolute paths in ~/.pi/agent/settings.json
export PI_CAIRN=1
```

`./install.sh --uninstall` reverses it. Both are idempotent.

Everything is additive and off by default. To try a layer without installing:

```bash
pi -p -e ./extensions/cairn.ts "hello"
```

## Development

Types resolve against a sibling pi checkout via `tsconfig.json` `paths` — no npm
dependency on pi, and `import type` erases at runtime, so jiti never resolves it.

```bash
npm install      # vitest + typescript only
npm run check    # tsgo --noEmit
npm test
```

## patches/

`0001-restore-genai-finishreason.patch` restores a `FinishReason` case that upstream
pi deleted in `71dca871b`; without it `npm run build` fails in `packages/ai` against
the pinned `@google/genai`. Apply to a fresh pi clone with `git apply`.
