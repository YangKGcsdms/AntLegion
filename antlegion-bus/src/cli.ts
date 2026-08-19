/**
 * alctl — the AntLegion CLI (the redis-cli analog).
 *
 * `runCli` is the testable core: it takes parsed argv, a ClientV2, and writers.
 * The thin executable (bin.ts) wires a real httpTransport and process.argv to it.
 *
 * Output contract: machine-readable JSON on stdout (one value or JSONL stream),
 * human-grade errors on stderr, non-zero exit on failure.
 *
 *   # write what happened
 *   alctl publish <type> [json-payload]   [--author a] [--parent id] [--subject key] [--ref k=v]
 *   alctl supersede <id> <type> [json]    [--author a] [--subject key]   replace a fact (register moves)
 *   alctl tombstone <id>                  [--author a]                   retract a fact (§5.2)
 *   # read the world
 *   alctl read   [--since N] [--type glob] [--author a] [--limit n]
 *   alctl tail   [--type glob] [--since N] [--follow]
 *   alctl current <subject>               what is X right now (§3.3 register)
 *   alctl history <subject>               everything ever said about X
 *   alctl causation <id>                  how this came to be (root→fact)
 *   alctl descendants <id>                what this led to
 *   alctl trust  <id>
 *   # ownership is world state too (§3.1)
 *   alctl claim  <id>                     [--author a]
 *   alctl resolve <id>                    [--author a]
 *   alctl release <id>                    [--author a]
 *   alctl observe <id> <corroborate|contradict>  [--author a]
 *   alctl state  <id>
 *   # who is on the board (§3.5–§3.6)
 *   alctl colony | registry | orphans | ask-context | provide-context | context-gaps
 *   alctl info
 *
 * This CLI is the sanctioned agent↔bus interface (it replaced the removed MCP
 * adapter): a PI/headless agent shells out to `alctl` — every op below maps to
 * one ClientV2 fold call, so every reader — this CLI, the SDK, a DCU on another
 * machine — folds the same stream into the same world. See docs/AGENT-CLI.md.
 *
 * `--author` is the global identity flag: it sets who you are for every command
 * that writes facts (on `read`/`tail`, which append nothing, it stays an author
 * filter). Identity defaults to ANTLEGION_AUTHOR, then `<user>@<hostname>`.
 */

import type { ClientV2 } from "./client.js";
import type { ReadQuery } from "./bus.js";
import { CONTEXT_REQUESTED, CONTEXT_PROVIDED } from "./fold.js";

type Writer = (line: string) => void;

/** Minimal flag parser: returns { positionals, flags }. */
function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = "true";
    } else positionals.push(a);
  }
  return { positionals, flags };
}

const USAGE = [
  "alctl — AntLegion CLI (a shared world-state log for agents)",
  "write what happened:",
  "  publish <type> [json]   append a fact   [--author a --parent id --subject key --ref k=v]",
  "  supersede <id> <type> [json]  replace a fact; its subject register moves [--author a --subject key]",
  "  tombstone <id>          retract a fact (deleted ≠ superseded, §5.2) [--author a]",
  "read the world:",
  "  read [--since N --type glob --author a --limit n]",
  "  tail [--type glob --since N --follow]  print facts (--follow keeps polling)",
  "  current <subject>       what is X right now — the §3.3 register, same on every reader",
  "  history <subject>       everything ever said about X, oldest first",
  "  causation <id>          how this came to be (chain root→fact)",
  "  descendants <id>        what this led to (transitive children)",
  "  trust <id>              trust state of a fact",
  "ownership is world state too:",
  "  claim <id>              claim an exclusive fact           [--author a]",
  "  resolve <id>            resolve a claimed fact (winner only) [--author a]",
  "  release <id>            abandon your claim                [--author a]",
  "  observe <id> <corroborate|contradict>  vote on a fact     [--author a]",
  "  state <id>              lifecycle state of a fact",
  "who is on the board:",
  "  colony                  registered agents (interests/publishes)",
  "  registry                full colony directory — 板上有谁、谁听什么、谁产什么",
  "  orphans                 fact types nobody is interested in + declaration gaps",
  "  ask-context <id> <q>    request more context on a too-thin fact   [--author a]",
  "  provide-context <req-id> [json]  answer a context request         [--author a]",
  "  context-gaps [--all]    open (unanswered) context requests",
  "  info                    bus summary (INFO)",
].join("\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runCli(
  argv: string[],
  client: ClientV2,
  write: Writer,
  writeErr: Writer = write,
): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const [cmd, ...rest] = positionals;

  // --author is the global identity flag for every command that writes facts.
  // read/tail append nothing, so there it remains an author filter.
  if (flags.author && cmd !== "read" && cmd !== "tail") client = client.as(flags.author);

  try {
    switch (cmd) {
      case undefined:
      case "help":
        write(USAGE);
        return 0;

      case "publish": {
        const type = rest[0];
        if (!type) { writeErr("error: publish needs a <type>"); return 1; }
        let payload: Record<string, unknown> = {};
        if (rest[1]) {
          try {
            payload = JSON.parse(rest[1]) as Record<string, unknown>;
          } catch (err) {
            writeErr(`error: invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`);
            return 1;
          }
        }
        // refs: --parent / --subject shortcuts + generic --ref key=value
        // (parity with the removed MCP adapter's parent_fact_id/subject_key,
        // plus arbitrary relational keys for context/vote conventions).
        const refs: Record<string, string> = {};
        if (flags.parent) refs.parent = flags.parent;
        if (flags.subject) refs.subject = flags.subject;
        if (flags.ref) {
          const eq = flags.ref.indexOf("=");
          if (eq < 1) { writeErr("error: --ref must be key=value"); return 1; }
          refs[flags.ref.slice(0, eq)] = flags.ref.slice(eq + 1);
        }
        const r = await client.publish(type, payload, Object.keys(refs).length ? { refs } : {});
        write(JSON.stringify({ id: r.id, seq: r.seq, deduped: r.deduped }));
        return 0;
      }

      case "read":
      case "tail": {
        const q: ReadQuery = {};
        if (flags.since) q.since = parseInt(flags.since, 10);
        if (flags.limit) q.limit = parseInt(flags.limit, 10);
        if (flags.type) q.type = flags.type;
        if (flags.author) q.author = flags.author;
        if (cmd === "tail" && flags.follow) {
          // Live tail: poll `?since=` from the current head (or --since) forever.
          let since = q.since ?? (await client.snapshot()).head_seq;
          for (;;) {
            const facts = await client.query({ ...q, since, limit: q.limit ?? 500 });
            for (const f of facts) {
              write(JSON.stringify(f));
              if (f.seq > since) since = f.seq;
            }
            await sleep(1000);
          }
        }
        const facts = await client.query(q);
        for (const f of facts) write(JSON.stringify(f));
        return 0;
      }

      case "claim": {
        if (!rest[0]) { writeErr("error: claim needs an <id>"); return 1; }
        const r = await client.claim(rest[0]);
        write(JSON.stringify({ won: r.won, winner: r.winner }));
        return r.won ? 0 : 1;
      }

      case "resolve": {
        if (!rest[0]) { writeErr("error: resolve needs an <id>"); return 1; }
        await client.resolve(rest[0]);
        write(JSON.stringify(await client.state(rest[0])));
        return 0;
      }

      case "release": {
        if (!rest[0]) { writeErr("error: release needs an <id>"); return 1; }
        await client.release(rest[0]);
        write(JSON.stringify(await client.state(rest[0])));
        return 0;
      }

      case "observe": {
        if (!rest[0]) { writeErr("error: observe needs an <id>"); return 1; }
        const verdict = rest[1];
        if (verdict !== "corroborate" && verdict !== "contradict") {
          writeErr("error: observe needs a verdict: corroborate | contradict");
          return 1;
        }
        await client.observe(rest[0], verdict);
        write(JSON.stringify({ ok: true, verdict }));
        return 0;
      }

      case "state": {
        if (!rest[0]) { writeErr("error: state needs an <id>"); return 1; }
        write(JSON.stringify(await client.state(rest[0])));
        return 0;
      }

      case "trust": {
        if (!rest[0]) { writeErr("error: trust needs an <id>"); return 1; }
        write(JSON.stringify({ trust: await client.trustOf(rest[0]) }));
        return 0;
      }

      case "causation": {
        if (!rest[0]) { writeErr("error: causation needs an <id>"); return 1; }
        const chain = await client.causation(rest[0]);
        // `chain` (ids) is the stable shape scripts key on; `facts` carries the
        // full skeleton+payload so a reader can see WHAT happened along the way,
        // not just that something did.
        write(JSON.stringify({ chain: chain.map((f) => f.id), facts: chain }));
        return 0;
      }

      case "descendants": {
        if (!rest[0]) { writeErr("error: descendants needs an <id>"); return 1; }
        const kids = await client.descendants(rest[0]);
        write(JSON.stringify({ descendants: kids.map((f) => f.id), facts: kids }));
        return 0;
      }

      case "current": {
        if (!rest[0]) { writeErr("error: current needs a <subject>"); return 1; }
        const cur = await client.currentOf(rest[0]);
        write(JSON.stringify({ subject: rest[0], current: cur }));
        return cur ? 0 : 1; // exit 1: nothing (or no longer anything) known about X
      }

      case "history": {
        if (!rest[0]) { writeErr("error: history needs a <subject>"); return 1; }
        for (const f of await client.historyOf(rest[0])) write(JSON.stringify(f));
        return 0;
      }

      case "supersede": {
        if (!rest[0] || !rest[1]) { writeErr("error: supersede needs <id> <type> [json]"); return 1; }
        let payload: Record<string, unknown> = {};
        if (rest[2]) {
          try { payload = JSON.parse(rest[2]) as Record<string, unknown>; }
          catch (err) { writeErr(`error: invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`); return 1; }
        }
        const r = await client.supersede(rest[0], rest[1], payload, flags.subject ? { subject: flags.subject } : {});
        write(JSON.stringify({ id: r.id, seq: r.seq, supersedes: rest[0] }));
        return 0;
      }

      case "tombstone": {
        if (!rest[0]) { writeErr("error: tombstone needs an <id>"); return 1; }
        const r = await client.tombstone(rest[0]);
        write(JSON.stringify({ id: r.id, seq: r.seq, tombstones: rest[0] }));
        return 0;
      }

      case "colony": {
        write(JSON.stringify((await client.colony()).map((r) => ({
          author: r.author, interests: r.interests, publishes: r.publishes,
        }))));
        return 0;
      }

      case "orphans": {
        write(JSON.stringify(await client.orphans()));
        return 0;
      }

      // The governance directory (multi-colony 计划 13): fold every
      // sys.registry into who is on the board, under which colony, listening
      // for what, producing what, scoped how. Pure reader-side — the bus has
      // no registrar to ask.
      case "registry": {
        write(JSON.stringify((await client.colony()).map((r) => {
          const p = r.fact.payload as Record<string, unknown>;
          return {
            author: r.author,
            ...(typeof p.colony === "string" ? { colony: p.colony } : {}),
            ...(typeof p.role === "string" ? { role: p.role } : {}),
            listens: r.interests,
            produces: r.publishes,
            ...(Array.isArray(p.origins) ? { origins: p.origins } : {}),
            ...(p.filter !== undefined ? { filter: p.filter } : {}),
            ...(typeof p.engine === "string" ? { engine: p.engine } : {}),
            ...(typeof p.workspace === "string" ? { workspace: p.workspace } : {}),
            ...(typeof p.worker === "string" ? { worker: p.worker } : {}),
            seq: r.seq,
          };
        })));
        return 0;
      }

      case "ask-context": {
        if (!rest[0]) { writeErr("error: ask-context needs the <fact-id> to ask about"); return 1; }
        const question = rest.slice(1).join(" ");
        if (!question) { writeErr("error: ask-context needs a <question>"); return 1; }
        const r = await client.publish(CONTEXT_REQUESTED, { question }, { refs: { about: rest[0] } });
        write(JSON.stringify({ id: r.id, seq: r.seq, about: rest[0] }));
        return 0;
      }

      case "provide-context": {
        if (!rest[0]) { writeErr("error: provide-context needs the <request-id> it answers"); return 1; }
        let payload: Record<string, unknown> = {};
        if (rest[1]) {
          try { payload = JSON.parse(rest[1]) as Record<string, unknown>; }
          catch (err) { writeErr(`error: invalid JSON: ${err instanceof Error ? err.message : String(err)}`); return 1; }
        }
        const r = await client.publish(CONTEXT_PROVIDED, payload, { refs: { parent: rest[0], answers: rest[0] } });
        write(JSON.stringify({ id: r.id, seq: r.seq, answers: rest[0] }));
        return 0;
      }

      case "context-gaps": {
        write(JSON.stringify((await client.contextGaps(!!flags.all)).map((g) => ({
          request: g.request.id, about: g.about, question: g.question,
          answered: g.answered, author: g.request.author,
        }))));
        return 0;
      }

      case "info": {
        write(JSON.stringify(await client.info()));
        return 0;
      }

      default:
        writeErr(`unknown command: ${cmd}\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    writeErr(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
