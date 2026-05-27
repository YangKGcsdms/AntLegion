/**
 * alctl — the AntLegion CLI (the redis-cli analog).
 *
 * `runCli` is the testable core: it takes parsed argv, a ClientV2, and a writer.
 * The thin executable (bin.ts) wires a real httpTransport and process.argv to it.
 *
 *   alctl publish <type> [json-payload]
 *   alctl read   [--since N] [--type glob] [--author a] [--limit n]
 *   alctl tail   [--type glob]          # like `read`, meant to be looped by the shell
 *   alctl claim  <id>
 *   alctl resolve <id>
 *   alctl state  <id>
 *   alctl trust  <id>
 *   alctl causation <id>
 *   alctl info
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

function fmtFact(f: { seq: number; type: string; author: string; id: string }): string {
  return `#${f.seq}\t${f.type}\t${f.author}\t${f.id}`;
}

const USAGE = [
  "alctl — AntLegion CLI",
  "  publish <type> [json]   append a fact",
  "  read [--since N --type glob --author a --limit n]",
  "  tail [--type glob]      print facts (loop in your shell for live tail)",
  "  claim <id>              claim an exclusive fact",
  "  resolve <id>            resolve a claimed fact",
  "  state <id>              lifecycle state of a fact",
  "  trust <id>              trust state of a fact",
  "  causation <id>          causation chain root→fact",
  "  info                    bus summary (INFO)",
].join("\n");

export async function runCli(argv: string[], client: ClientV2, write: Writer): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const [cmd, ...rest] = positionals;

  try {
    switch (cmd) {
      case undefined:
      case "help":
        write(USAGE);
        return 0;

      case "publish": {
        const type = rest[0];
        if (!type) { write("error: publish needs a <type>"); return 1; }
        const payload = rest[1] ? JSON.parse(rest[1]) : {};
        const r = await client.publish(type, payload);
        write(`published ${r.id}  seq=${r.seq}${r.deduped ? "  (deduped)" : ""}`);
        return 0;
      }

      case "read":
      case "tail": {
        const q: ReadQuery = {};
        if (flags.since) q.since = parseInt(flags.since, 10);
        if (flags.limit) q.limit = parseInt(flags.limit, 10);
        if (flags.type) q.type = flags.type;
        if (flags.author) q.author = flags.author;
        const facts = await client.query(q);
        for (const f of facts) write(fmtFact(f));
        write(`(${facts.length} facts)`);
        return 0;
      }

      case "claim": {
        if (!rest[0]) { write("error: claim needs an <id>"); return 1; }
        const r = await client.claim(rest[0]);
        write(r.won ? `won ${rest[0]}` : `lost ${rest[0]} (winner: ${r.winner})`);
        return r.won ? 0 : 1;
      }

      case "resolve": {
        if (!rest[0]) { write("error: resolve needs an <id>"); return 1; }
        await client.resolve(rest[0]);
        write(`resolved ${rest[0]}`);
        return 0;
      }

      case "state": {
        if (!rest[0]) { write("error: state needs an <id>"); return 1; }
        const s = await client.state(rest[0]);
        write(`${s.state}${s.owner ? `  owner=${s.owner}` : ""}`);
        return 0;
      }

      case "trust": {
        if (!rest[0]) { write("error: trust needs an <id>"); return 1; }
        write(await client.trustOf(rest[0]));
        return 0;
      }

      case "causation": {
        if (!rest[0]) { write("error: causation needs an <id>"); return 1; }
        const chain = await client.causation(rest[0]);
        write(chain.map((f) => f.id).join(" → ") || "(empty)");
        return 0;
      }

      case "info": {
        const s = await client.snapshot();
        write(`facts=${s.facts}  head_seq=${s.head_seq}`);
        return 0;
      }

      default:
        write(`unknown command: ${cmd}\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    write(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
