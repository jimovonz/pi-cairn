# pi-cairn

Cairn memory, CCH/CCM context compression, the code-graph footer and RTK command
rewriting, for the [pi](https://github.com/earendil-works/pi) coding agent.

Every layer is off until you set its gate, and `install.sh` registers these files
with pi by absolute path — nothing is copied or symlinked into the pi checkout, so
upgrading or reinstalling pi costs nothing.

## Design

The heavy lifting stays in Python and is **shared with Claude Code** — the same
engine, the same policy, the same database — so the two hosts cannot drift. The
TypeScript here is thin glue that shells out:

| Layer | Shells out to | Gate |
|---|---|---|
| Memory | `cairn/hooks/pi_bridge.py` (`bootstrap`/`retrieve`/`capture`/`enforce`/`spec`) | `PI_CAIRN` |
| Routing | `guards.block()` via CCH | `PI_ROUTING` |
| Caching + graph footer + rules | `cache-wrap.py -- <cmd>` | `PI_CCM` |
| Token proxy | `rtk rewrite <cmd>` | `PI_RTK` |
| Code-graph lookup | `cairn-graph` | `PI_GRAPH` |
| Goal continuation | `/goal`, evaluated by the session model | on by default (`PI_GOAL=0` disables) |

Wrapping bash in `cache-wrap.py` is what delivers the `[CCM_CACHED]` stub, the
symbol menu, the `[cairn-graph: …]` footer and `.cch/rules` all at once — none of
that is reimplemented here.

**No patch to pi's core is required.** A post-turn gate does not need one: a
handler on `agent_end` that calls
`pi.sendUserMessage(text, { deliverAs: "followUp" })` makes the agent loop continue
instead of stop. It has to be `agent_end` — `turn_end` messages are consumed as an
ordinary continuation, and `agent_settled` runs after the loop has exited.

## Prerequisites

pi-cairn is an integration layer: each gate shells out to a tool that lives in
its own repo. You only need the tools for the gates you turn on.

| Gate | Needs | Default location | Override |
|------|-------|------------------|----------|
| `PI_CAIRN` | [cairn](https://github.com/jimovonz/cairn) — `hooks/pi_bridge.py`, `cairn/query.py` | `~/Projects/cairn` | `CAIRN_HOME` |
| `PI_GRAPH` | `cairn-graph` on `PATH` (ships with cairn) | — | — |
| `PI_ROUTING`, `PI_CCM` | [claude-context-hooks](https://github.com/jimovonz/claude-context-hooks) | `~/Projects/claude-context-hooks` | `CCH_HOME` |
| `PI_RTK` | `rtk` on `PATH` | — | — |
| `PI_GOAL` | nothing | — | — |

Plus [pi](https://github.com/earendil-works/pi) itself and `python3`.

`./install.sh` prints a dependency table before doing anything. Missing `pi`,
`python3`, cairn or `typebox` is fatal — nothing is installed. Everything else
reports `warn` and the corresponding layer degrades to a no-op, so you can run
memory without the routing stack, or vice versa.

Retrieval is roughly 10x slower without cairn's embedding daemon (~8s per
prompt versus ~0.7s), so `install.sh` checks for it and tells you how to start
it if it is down.

## Install

```bash
git clone https://github.com/jimovonz/pi-cairn.git
cd pi-cairn
npm install           # typebox + dev tooling
./install.sh          # registers absolute paths in ~/.pi/agent/settings.json
export PI_CAIRN=1
```

Keep the clone where you want it to stay: `install.sh` registers these files
with pi by absolute path, so moving the directory afterwards means re-running it.

`./install.sh --uninstall` reverses it. Both are idempotent.

Everything is additive and off by default. To try a layer without installing:

```bash
pi -p -e ./extensions/cairn.ts "hello"
```

## Layout

```
extensions/cairn.ts     memory: before_agent_start + agent_end + cairn_query
extensions/routing.ts   one ordered tool_call pipeline
extensions/graph.ts     code_graph lookup tool (the graph pull half)
extensions/goal.ts      /goal: keep working until a condition holds
extensions/thinking-label.ts  fills pi's collapsed-thinking header with token count + cost
lib/bridge.ts           the only subprocess helper
install.sh              registers extensions by path; --uninstall reverses it
upgrade-pi.sh           rebase pi's local-cairn branch, build, verify
patches/                optional local fixes to pi, applied by upgrade-pi.sh
```

## Performance

Per call, measured on one Linux workstation — read these as orders of
magnitude rather than guarantees:

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

## Tuning for deepseek-v4.1-flash

From pi's own catalog (`packages/ai/src/providers/data/openrouter.json`):

```
input $0.30/M · output $1.20/M · cacheRead $0.006/M · cacheWrite $0
contextWindow 1,048,576 · maxTokens 384,000
thinkingLevelMap: off→none, high→high, xhigh→xhigh; minimal/low/medium/max → null
```

Three consequences drive the design here:

1. **A cached input token costs 1/50th of a fresh one, and cache writes are free.**
   Prefix stability is therefore the dominant cost lever — far more than prompt
   size. This is why the `[cm]` spec is fetched once per session and appended
   unconditionally: letting it flap in and out would invalidate the whole cached
   context, and on a long conversation that is a 50x re-ingestion.
2. **Output costs 200x a cached input token.** Injecting context is cheap;
   generating is expensive. Prefer telling the model something up front over
   letting it discover it by trial — every denial it has to reason about is a
   round trip paid in output tokens.
3. **Volatile content goes late.** Retrieved memories change every prompt, so they
   ride as a trailing custom message rather than in the system prompt.

Note `minimal`, `low`, `medium` and `max` map to `null` — only `off`, `high` and
`xhigh` reach this model. Its default is thinking-on, which is also its most
verbose configuration.

## Backend pinning (required for caching)

`~/.pi/agent/models.json` pins the OpenRouter backend. This is not a
micro-optimisation — **most backends serving this model do not cache at all**,
and the advertised `cacheRead` price is meaningless on a backend that never
returns a hit. Measured by sending an identical 3.4k-token prefix twice:

| Backend | 2nd-call cost | Caches? |
|---|---|---|
| **Together** | $0.0000494 | yes — 21.6x cheaper than the cold call |
| Wafer | $0.0001022 | yes |
| GMICloud | $0.0001434 | yes |
| Novita, Parasail, SiliconFlow | ~$0.00105 | **no — `cached_tokens` stays 0** |

All six advertise the same $0.006/M cacheRead. Alibaba, Modal and BaseTen list
5x that and are excluded; Relace is fp4 and excluded on quality grounds.

DeepSeek's own first-party endpoint may be refused depending on your OpenRouter
privacy settings: pinning it can return `404 Paid model training violation
(account settings)`. That is the data-training guardrail rejecting the request,
not an invalid slug. Allowing it means relaxing that setting, so the pin above
targets third parties that cache.

Two turns of one session, through pi:

```
turn 1  input 3214  cacheRead 0     $0.0011226
turn 2  input 1128  cacheRead 3200  $0.0003984
```

## Development

```bash
npm install
npm run check    # tsgo --noEmit
npm test         # vitest, 112 tests
```

Types resolve through `tsconfig.json` `paths`, which lists two locations in
order: a sibling pi source checkout (`../pi`) if you have one, otherwise the
published `@earendil-works/*` packages from `devDependencies`. A fresh clone
therefore typechecks with nothing but `npm install`, while a pi contributor
working against unreleased API still gets their local build.

Either way pi is type-only: the extensions import it with `import type`, which
erases at compile time, so jiti never resolves pi at runtime and pi-cairn never
pins a pi version.

## Three contracts worth knowing before editing

1. **Success is stdout, not exit status.** `pi_bridge.py` wraps everything in bare
   `except Exception` and exits 0 regardless; `cch-batch.py` is exit-0 by design.
   Branch on output, never on the exit code. `lib/bridge.ts` encodes this as `ok`.
2. **Handlers must not throw.** A throw in a `tool_call` handler becomes
   "Extension failed, blocking execution" and denies the tool. Every failure is
   captured and returned as data so that a broken layer degrades to stock pi.
3. **CCH judges the command before RTK rewrites it.** RTK turns `cat foo.ts` into
   `rtk read foo.ts`, which matches none of the bulk-read patterns `guards.block`
   looks for, so running RTK first disables the guards entirely — silently. The
   order matters here because this is a pipeline: each stage sees the previous
   stage's output, not the original command.

## Upgrading pi

`./upgrade-pi.sh` (env `PI_DIR`, default `~/Projects/pi`) keeps a local pi
checkout upgradable while retaining any local fixes:

- `main` stays a pristine mirror of `origin/main` (fast-forward only).
- Local changes to pi live as commits on a `local-cairn` branch, rebased onto
  `main` on every upgrade. `git rebase` re-merges them with three-way conflict
  handling and **drops any commit upstream has since taken** (patch-id match),
  so the branch self-heals. Keeping local changes as commits rather than
  working-tree edits is what keeps `git pull` unblocked.
- It then runs `npm install`, `npm run build`, and finally `npm run check` here
  to verify the extensions still typecheck against the new pi.

`--dry-run` prints the plan without touching anything.

### patches/

Create a `patches/` directory and drop `*.patch` files in it when pi needs a
local fix to build or run. `upgrade-pi.sh` applies each one with
`git apply --3way` if the checkout lands on a branch without it, then commits it
to `local-cairn`; a missing directory is skipped, so none is required.

Once upstream adopts an equivalent fix, the next rebase drops the local commit
by patch-id match and the patch file can be deleted.
