# @antlegion/ecu — DCU runtime (Step 0–2)

Domain Control Units on top of the AntLegion fact bus (`antlegion-bus`).
Step 0 brings the bus up with a stable secret and a repo-local data dir;
Step 1 is the first DCU: `ingestor-req`, which reflects requirement
workspaces onto the bus, plus a live board to watch the chain.
Step 2 makes the DCU system self-hosting: our own native requirement
workspace (`dcu-workspace/`, repo top level) where requirements are created
by the DCU itself via `req new` — the OA mirror was validation-only and is
now OFF by default.

## Layout

```
dcu-workspace/          native requirement workspace (origin "dcu"; docs/ tracked, logs/ gitignored)
src/runtime.ts          DCU loop: poll(since cursor) → rebuild fold → evaluate → act → advance
src/folds/chain.ts      shared "requirement chain" fold (pure, unit-tested; origin-agnostic)
src/dcus/ingestor-req.ts the ingestor DCU (READ-ONLY on every watched root)
src/req-new.ts          native requirement creation (dir + dcu.env + req.registered fact)
src/config.ts           ecu.config.json loader (watchRoots with origins)
src/board.ts            zero-dep static server for board.html
src/main.ts             CLI: tsx src/main.ts ingestor|board|req new "<名称>" [-s slug]
board.html              live dashboard (polls the bus, folds locally, origin badge)
scripts/up.sh|down.sh   Step 0: bus + ingestor lifecycle (idempotent, no orphans)
```

## Facts

| type | payload | nonce | refs |
|---|---|---|---|
| `req.registered` | `{slug,name,created,origin,slot,branch,baseBranch,projects,ports{backend,workflow,ui,llm,debug}}` | `req:<origin>:<dirname>` | `subject: <slug>` |
| `doc.updated` | `{reqSlug,doc,status,mtime,path,origin}` (`status` = parsed `状态：` header or `null`) | `doc:<relpath>:<mtimeMs>` | `subject: <slug>/<doc>` |

All mirrored facts are authored as `ingestor-req@ecu` — including the one
published by `req new`, so the command and the ingestor's backfill plan
byte-identical facts for the same dir and the bus dedups them against each
other (no double-publish, verified by test). Published `ts` values are
derived from the filesystem (CREATED / dirname stamp / mtime), never the
wall clock — the bus content-addresses facts including `ts`, so re-ingesting
an unchanged workspace yields `deduped:true` and no new facts; editing a doc
changes its mtime → new id → republish.

## Native requirements (`req new`)

```bash
cd ecu
npx tsx src/main.ts req new "adjudicator证据校验上线" -s adjudicator-evidence-fold
```

Creates `dcu-workspace/<yyyymmddHHMM>-<slug>/` with:

- `dcu.env` — minimal manifest: `REQ_NAME` / `CREATED` / `SLUG` / `ORIGIN=dcu`
  (no port-slot fields; our workspace runs no services)
- `docs/` — requirement docs, git-tracked; a `状态：<...>` header line in the
  first 30 lines of any `docs/*.md` is mirrored as the doc status
- `logs/` — runtime noise, gitignored

Then publishes `req.registered` (nonce `req:dcu:<dirname>`, origin `dcu`) and
prints the created path. Re-running with the same slug reuses the existing
dir and the second publish dedups on the bus. ASCII names get an automatic
slug; non-ASCII names require `-s <slug>`.

## Watch roots (config)

`ecu.config.json`:

```json
{
  "busUrl": "http://localhost:28090",
  "watchRoots": [{ "root": "dcu-workspace", "origin": "dcu" }]
}
```

Each entry is `{root, origin}`; relative `root` resolves against the repo
root. The default — and the only committed entry — is our native
`dcu-workspace` (origin `dcu`, manifest file `dcu.env`).

**Re-adding the OA mirror (optional, OFF by default):** the OA requirements
were a validation mirror only and are not part of this project's production
area. To mirror them again, add an entry — the ingestor code for it stays,
and `oa` roots read `oaws.env`:

```json
{ "root": "/Users/carter/projects/OA系统/需求工作区", "origin": "oa" }
```

The ingestor watches every configured root **read-only** via `fs.watch` + a
5s rescan fallback (macOS `fs.watch` misses new dirs); it never crashes on
unreadable files — errors go to stderr and the scan continues.

## Run

```bash
ecu/scripts/up.sh        # build bus if needed → bus on :28090 (secret ecu-dev-stable,
                         # data ecu/.data) → ingestor-req. Idempotent; prints PIDs.
cd ecu && npx tsx src/main.ts board   # board on :28091
# open http://localhost:28091/board.html?bus=http://localhost:28090

ecu/scripts/down.sh      # stop both, no orphans
```

## Test

```bash
cd ecu
npm install
npx tsc --noEmit
npx vitest run       # folds, env parser, status-header parser, backfill (fixtures only),
                     # req-new manifest/nonce/cross-dedup, config watchRoots
```

Unit tests use `test/fixtures/req-workspace/` and tmpdirs — they never touch
the real OA directory or the live dcu-workspace.
