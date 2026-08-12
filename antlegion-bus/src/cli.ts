/**
 * alctl — the AntLegion CLI (the redis-cli analog).
 *
 * `runCli` is the testable core: it takes parsed argv, a ClientV2, and writers.
 * The thin executable (bin.ts) wires a real httpTransport and process.argv to it.
 *
 * Output contract: machine-readable JSON on stdout (one value or JSONL stream),
 * human-grade errors on stderr, non-zero exit on failure.
 *
 *   alctl publish <type> [json-payload]   [--author a]
 *   alctl read   [--since N] [--type glob] [--author a] [--limit n]
 *   alctl tail   [--type glob] [--since N] [--follow]
 *   alctl claim  <id>                     [--author a]
 *   alctl resolve <id>                    [--author a]
 *   alctl release <id>                    [--author a]
 *   alctl state  <id>
 *   alctl trust  <id>
 *   alctl causation <id>
 *   alctl info
 *
 * `--author` is the global identity flag: it sets who you are for every command
 * that writes facts (on `read`/`tail`, which append nothing, it stays an author
 * filter). Identity defaults to ANTLEGION_AUTHOR, then `<user>@<hostname>`.
 */

import type { ClientV2 } from "./client.js";
import type { ReadQuery } from "./bus.js";

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
  "alctl — AntLegion CLI",
  "  publish <type> [json]   append a fact                     [--author a]",
  "  read [--since N --type glob --author a --limit n]",
  "  tail [--type glob --since N --follow]  print facts (--follow keeps polling)",
  "  claim <id>              claim an exclusive fact           [--author a]",
  "  resolve <id>            resolve a claimed fact (winner only) [--author a]",
  "  release <id>            abandon your claim                [--author a]",
  "  state <id>              lifecycle state of a fact",
  "  trust <id>              trust state of a fact",
  "  causation <id>          causation chain root→fact",
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
        const r = await client.publish(type, payload);
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
        write(JSON.stringify({ chain: chain.map((f) => f.id) }));
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
