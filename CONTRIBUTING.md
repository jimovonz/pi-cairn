# Contributing

## Getting set up

```bash
git clone <this repo>
cd pi-cairn
npm install
npm run check
npm test
```

No sibling checkouts are needed for that. See **Prerequisites** in the README
for the tools each runtime gate shells out to; you only need them for the gates
you actually exercise.

## Ground rules

**Every layer stays off by default.** A gate reads its env var and returns early
when unset. A missing external tool degrades that layer to a no-op — it must
never fail the session or block `install.sh` for the layers someone else wants.

**Nothing lives in the pi checkout.** `install.sh` registers files here by
absolute path, so a pi reinstall costs nothing. Do not add anything that has to
be copied into `~/.pi`.

Registration is by real path and **not** by symlinking into
`~/.pi/agent/extensions`, even though pi discovers symlinks there. jiti resolves
an extension's imports relative to the path it was loaded from, without
dereferencing symlinks, so a symlinked extension looks for `typebox` and
`../lib/bridge.ts` beside the symlink, where neither exists. Loading via a
symlink fails with `Cannot find module 'typebox'`; the same file loaded by its
real path works.

**pi is a type-only dependency.** Import it with `import type`. A value import
would make jiti resolve pi at runtime and pin a version.

**Policy lives in the tool, not here.** The extensions are plumbing: they shell
out and relay. When behaviour needs to change, change it in cairn or
claude-context-hooks so the Claude Code and pi paths cannot drift.

## Before opening a PR

```bash
npm run check    # tsgo --noEmit, must be clean
npm test         # vitest, all green
bash -n install.sh
```

Add tests next to the code they cover in `test/`. The suite uses a fake
`ExtensionAPI` rather than launching pi, so tests stay fast and hermetic.
