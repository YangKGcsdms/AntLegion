/**
 * swarm-v2 — validate the founding premise: agents collaborate through FACTS,
 * not COMMANDS. ~20 autonomous agents, one bus, zero orchestrator, zero
 * agent-to-agent messages. Coordination must EMERGE from the fact stream.
 *
 * Choreography:
 *   seeder    → publishes  job.requested {count:N}
 *   splitter  → claims it, resolves into N  item.todo {i}   (1 agent)
 *   workers   → each watches item.todo, races to claim, resolves item.done {i,by}  (18 agents)
 *   aggregator→ watches item.done; when N distinct, publishes job.completed       (1 agent)
 *
 * No agent ever addresses another. `claim`/`resolve` reference FACT ids, never
 * agent ids. Run:  npx tsx examples/swarm-v2.ts
 */

import { serve } from "@hono/node-server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerV2 } from "../src/server.js";
import { ClientV2, httpTransport } from "../src/client.js";

const TOTAL = 50;
const WORKERS = 18; // + splitter + aggregator ≈ 20 agents
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-swarm-"));
  const { app } = createServerV2({ secret: "swarm", dataDir: dir, fsync: "no" });
  let server: { close: () => void };
  const port = await new Promise<number>((res) => {
    const s = serve({ fetch: app.fetch, port: 0 }, (i) => res(i.port));
    server = s as unknown as { close: () => void };
  });
  const base = `http://localhost:${port}`;
  const client = (name: string) => new ClientV2(httpTransport(base), name);

  let stop = false;
  const workerDid = new Map<string, number>();

  // ── splitter (1) ──────────────────────────────────────────────────────────
  const splitter = (async () => {
    const c = client("splitter");
    const seen = new Set<string>();
    while (!stop) {
      for (const f of await c.query({ type: "job.requested" })) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        const r = await c.claim(f.id);
        if (r.won) {
          const count = Number((f.payload as { count: number }).count);
          const children = Array.from({ length: count }, (_, i) => ({ type: "item.todo", payload: { i } }));
          await c.resolve(f.id, children);
        }
      }
      await sleep(20);
    }
  })();

  // ── workers (18) ────────────────────────────────────────────────────────────
  const workers = Array.from({ length: WORKERS }, (_, k) =>
    (async () => {
      const name = `worker-${k}`;
      const c = client(name);
      const attempted = new Set<string>();
      while (!stop) {
        for (const f of await c.query({ type: "item.todo", limit: 200 })) {
          if (attempted.has(f.id)) continue;
          const st = await c.state(f.id);
          if (st.state !== "open") { attempted.add(f.id); continue; }
          attempted.add(f.id);
          const r = await c.claim(f.id);
          if (r.won) {
            await c.resolve(f.id, [{ type: "item.done", payload: { i: (f.payload as { i: number }).i, by: name } }]);
            workerDid.set(name, (workerDid.get(name) ?? 0) + 1);
          }
        }
        await sleep(12);
      }
    })(),
  );

  // ── aggregator (1) ──────────────────────────────────────────────────────────
  const aggregator = (async () => {
    const c = client("aggregator");
    let emitted = false;
    while (!stop) {
      const dones = await c.query({ type: "item.done", limit: 1000 });
      const distinct = new Set(dones.map((d) => (d.payload as { i: number }).i));
      if (!emitted && distinct.size >= TOTAL) {
        emitted = true;
        await c.publish("job.completed", { items: distinct.size });
      }
      await sleep(20);
    }
  })();

  // ── seed the job (a fact, not a command) ──────────────────────────────────
  const seeder = client("seeder");
  await seeder.publish("job.requested", { count: TOTAL });

  // ── wait for the emergent completion ──────────────────────────────────────
  const t0 = Date.now();
  let completed = false;
  while (Date.now() - t0 < 25000) {
    if ((await seeder.query({ type: "job.completed" })).length > 0) { completed = true; break; }
    await sleep(50);
  }
  const elapsed = Date.now() - t0;
  stop = true;
  await Promise.allSettled([splitter, ...workers, aggregator]);

  // ── VALIDATE from the fact log alone ──────────────────────────────────────
  const all = await seeder.query({ since: 0, limit: 100000 });
  const byType = (t: string) => all.filter((f) => f.type === t);
  const todos = byType("item.todo");
  const dones = byType("item.done");
  const claims = byType("_.claim");
  const doneIdx = dones.map((d) => (d.payload as { i: number }).i);
  const distinctIdx = new Set(doneIdx);
  const dupes = doneIdx.length - distinctIdx.size;
  const missing = [...Array(TOTAL).keys()].filter((i) => !distinctIdx.has(i));
  const contributors = new Set(dones.map((d) => (d.payload as { by: string }).by));

  // exactly-once: every todo resolved by exactly one worker
  const perItemDone = new Map<number, number>();
  for (const i of doneIdx) perItemDone.set(i, (perItemDone.get(i) ?? 0) + 1);
  const overDone = [...perItemDone.entries()].filter(([, n]) => n > 1);

  // causation: a done traces done → todo → job.requested
  const sampleDone = dones[0];
  const chain = sampleDone ? await seeder.causation(sampleDone.id) : [];

  // "fact not command": no fact carries a recipient/target-agent field
  const refKeys = new Set<string>();
  for (const f of all) for (const k of Object.keys(f.refs)) refKeys.add(k);
  const hasRecipientField = all.some((f) =>
    ["to", "target", "recipient", "assignee", "addressed_to"].some((k) => k in (f.payload ?? {}) || k in f.refs),
  );

  console.log("\n══════════ swarm-v2 validation (fact not command) ══════════");
  console.log(`agents               : 1 seeder + 1 splitter + ${WORKERS} workers + 1 aggregator = ${WORKERS + 3}`);
  console.log(`job completed         : ${completed ? "YES (emergent)" : "NO (timeout)"} in ${elapsed} ms`);
  console.log(`total facts on bus    : ${all.length}`);
  console.log(`item.todo produced    : ${todos.length} / ${TOTAL}`);
  console.log(`item.done produced    : ${dones.length}  (distinct ${distinctIdx.size}/${TOTAL})`);
  console.log(`exactly-once          : dupes=${dupes}  missing=${missing.length}  over-done items=${overDone.length}`);
  console.log(`claim facts (races)   : ${claims.length}  → contention beyond ${TOTAL} winners means workers genuinely competed`);
  console.log(`work distribution     : ${contributors.size} distinct workers did the ${dones.length} items`);
  console.log(`  per-worker           : ${[...workerDid.entries()].map(([n, c]) => `${n.replace("worker-", "w")}:${c}`).join(" ")}`);
  console.log(`causation of a done    : ${chain.map((f) => f.type).join(" → ")}  (len ${chain.length})`);
  console.log(`refs keys ever used    : { ${[...refKeys].join(", ")} }  (all reference FACT ids, never agent ids)`);
  console.log(`recipient/target field : ${hasRecipientField ? "PRESENT (would violate premise!)" : "ABSENT — no agent ever addressed another"}`);

  const PASS =
    completed &&
    todos.length === TOTAL &&
    distinctIdx.size === TOTAL &&
    dupes === 0 &&
    overDone.length === 0 &&
    missing.length === 0 &&
    contributors.size > 1 &&
    chain.length === 3 &&
    !hasRecipientField;
  console.log(`\nVERDICT: ${PASS ? "✅ PREMISE VALIDATED — emergent collaboration via facts, no commands" : "❌ premise not satisfied"}`);
  console.log("════════════════════════════════════════════════════════════\n");

  server!.close();
  process.exit(PASS ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
