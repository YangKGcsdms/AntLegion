# @antlegion/ecu — DCU runtime (Step 0–1)

Domain Control Units on top of the AntLegion fact bus (`antlegion-bus`).
Step 0 brings the bus up with a stable secret and a repo-local data dir;
Step 1 is the first DCU: `ingestor-req`, which reflects the OA requirement
workspace onto the bus, plus a live board to watch the chain.

## Layout

```
src/runtime.ts          DCU loop: poll(since cursor) → rebuild fold → evaluate → act → advance
src/folds/chain.ts      shared "requirement chain" fold (pure, unit-tested)
src/dcus/ingestor-req.ts the ingestor DCU (READ-ONLY on the OA tree)
src/board.ts            zero-dep static server for board.html
src/main.ts             CLI: tsx src/main.ts ingestor|board
board.html              live dashboard (polls the bus, folds locally)
scripts/up.sh|down.sh   Step 0: bus + ingestor lifecycle (idempotent, no orphans)
```

## Facts

| type | payload | nonce | refs |
|---|---|---|---|
| `req.registered` | `{slug,name,created,slot,branch,baseBranch,projects,ports{backend,workflow,ui,llm,debug}}` | `req:<dirname>` | `subject: <slug>` |
| `doc.updated` | `{reqSlug,doc,status,mtime,path}` (`status` = parsed `状态：` header or `null`) | `doc:<relpath>:<mtimeMs>` | `subject: <slug>/<doc>` |

All facts are authored as `ingestor-req@ecu`. Published `ts` values are
derived from the filesystem (CREATED / dirname stamp / mtime), never the wall
clock — the bus content-addresses facts including `ts`, so re-ingesting an
unchanged workspace yields `deduped:true` and no new facts; editing a doc
changes its mtime → new id → republish.

## Run

```bash
ecu/scripts/up.sh        # build bus if needed → bus on :28090 (secret ecu-dev-stable,
                         # data ecu/.data) → ingestor-req. Idempotent; prints PIDs.
cd ecu && npx tsx src/main.ts board   # board on :28091
# open http://localhost:28091/board.html?bus=http://localhost:28090

ecu/scripts/down.sh      # stop both, no orphans
```

Config: `ecu.config.json` (`busUrl`, `oaRoot`, `reqWorkspace`). The ingestor
watches `<oaRoot>/<reqWorkspace>` **read-only** via `fs.watch` + a 5s rescan
fallback (macOS `fs.watch` misses new dirs); it never crashes on unreadable
files — errors go to stderr and the scan continues.

## Test

```bash
cd ecu
npm install
npx tsc --noEmit
npx vitest run       # folds, oaws.env parser, status-header parser, backfill (fixtures only)
```

Unit tests use `test/fixtures/req-workspace/` — they never touch the real OA
directory.
