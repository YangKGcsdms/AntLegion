/**
 * Scenario ① — RESILIENCE / fault tolerance.
 *
 * Real angle: some agents are flaky — they grab work and crash before finishing.
 * The premise under test: with NO orchestrator, does work still get done
 * exactly once? The recovery path is claim-timeout re-dispatch (§3.1): a claim
 * whose bus-stamped recv has aged past Δ stops being live, the item re-opens,
 * and a healthy agent finishes it. No one "reassigns" anything — it emerges.
 *
 *   dispatcher → publishes TOTAL item.todo {i}
 *   faulty (4) → claim one open item, WIN, then die without resolving
 *   healthy(12)→ claim open items, resolve item.done; retry items that re-open
 *   aggregator → counts items whose lifecycle == resolved; emits job.completed
 *
 * Run: npx tsx examples/scenario-resilience.ts
 */

import { serve } from "@hono/node-server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerV2 } from "../src/v2/server.js";
import { ClientV2, httpTransport } from "../src/v2/client.js";
import { lifecycle } from "../src/v2/fold.js";

const TOTAL = 24, HEALTHY = 12, FAULTY = 4, CLAIM_TIMEOUT = 1.0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-resil-"));
  const { app } = createServerV2({ secret: "resil", dataDir: dir, fsync: "no" });
  let server: { close: () => void };
  const port = await new Promise<number>((res) => {
    const s = serve({ fetch: app.fetch, port: 0 }, (i) => res(i.port));
    server = s as unknown as { close: () => void };
  });
  const base = `http://localhost:${port}`;
  const client = (n: string) => new ClientV2(httpTransport(base), n, { claimTimeout: CLAIM_TIMEOUT });

  let stop = false;
  const foulById = new Set<string>(); // item ids a faulty worker stranded

  // dispatcher: publish the work as facts
  const dispatcher = client("dispatcher");
  for (let i = 0; i < TOTAL; i++) await dispatcher.publish("item.todo", { i });

  // faulty workers: grab one and "crash" (never resolve)
  const faulty = Array.from({ length: FAULTY }, (_, k) =>
    (async () => {
      const c = client(`faulty-${k}`);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        for (const f of await c.query({ type: "item.todo", limit: 200 })) {
          if ((await c.state(f.id)).state !== "open") continue;
          const r = await c.claim(f.id);
          if (r.won) { foulById.add(f.id); return; } // claimed, now crash
        }
        await sleep(8);
      }
    })());

  // healthy workers: do work, retry whatever is open (incl. re-opened after timeout)
  const healthy = Array.from({ length: HEALTHY }, (_, k) =>
    (async () => {
      const c = client(`healthy-${k}`);
      while (!stop) {
        for (const f of await c.query({ type: "item.todo", limit: 200 })) {
          if ((await c.state(f.id)).state !== "open") continue;
          const r = await c.claim(f.id);
          if (r.won) await c.resolve(f.id, [{ type: "item.done", payload: { i: (f.payload as { i: number }).i, by: c.author } }]);
        }
        await sleep(15);
      }
    })());

  // aggregator: completion measured by LIFECYCLE resolved (the correct semantic)
  const aggregator = (async () => {
    const c = client("aggregator");
    let emitted = false;
    while (!stop) {
      const todos = await c.query({ type: "item.todo", limit: 200 });
      await c.sync();
      let resolved = 0;
      for (const t of todos) if ((await c.state(t.id)).state === "resolved") resolved++;
      if (!emitted && todos.length === TOTAL && resolved === TOTAL) {
        emitted = true;
        await c.publish("job.completed", { resolved });
      }
      await sleep(40);
    }
  })();

  // wait for emergent completion
  const t0 = Date.now();
  let completed = false;
  while (Date.now() - t0 < 25000) {
    if ((await dispatcher.query({ type: "job.completed" })).length > 0) { completed = true; break; }
    await sleep(60);
  }
  const elapsed = Date.now() - t0;
  stop = true;
  await Promise.allSettled([...faulty, ...healthy, aggregator]);

  // ── validate from the fact log ──
  const all = await dispatcher.query({ since: 0, limit: 100000 });
  const todos = all.filter((f) => f.type === "item.todo");
  const dones = all.filter((f) => f.type === "item.done");
  const claims = all.filter((f) => f.type === "_.claim");
  const doneIdx = dones.map((d) => (d.payload as { i: number }).i);
  const dupes = doneIdx.length - new Set(doneIdx).size;
  const resolvedCount = todos.filter((t) => lifecycle(all, t.id, { claimTimeout: CLAIM_TIMEOUT }).state === "resolved").length;

  // re-dispatch evidence: items first-claimed by a faulty worker, finished by a healthy one
  const faultyClaimedItems = todos.filter((t) => {
    const cs = claims.filter((c) => c.refs.claim_of === t.id).sort((a, b) => a.seq - b.seq);
    return cs.length > 0 && cs[0].author.startsWith("faulty-");
  });
  const recovered = faultyClaimedItems.filter((t) => {
    const d = dones.find((x) => (x.payload as { i: number }).i === (t.payload as { i: number }).i);
    return d && (d.payload as { by: string }).by.startsWith("healthy-");
  });

  console.log("\n══════════ Scenario ① RESILIENCE (crash → timeout re-dispatch) ══════════");
  console.log(`agents              : 1 dispatcher + ${FAULTY} faulty + ${HEALTHY} healthy + 1 aggregator`);
  console.log(`completed (emergent): ${completed ? "YES" : "NO (timeout)"} in ${elapsed} ms`);
  console.log(`items resolved      : ${resolvedCount}/${TOTAL}  (lifecycle == resolved)`);
  console.log(`item.done facts     : ${dones.length}  dupes=${dupes}`);
  console.log(`claim facts         : ${claims.length}`);
  console.log(`stranded by faulty  : ${faultyClaimedItems.length}  → recovered by healthy: ${recovered.length}`);

  const PASS =
    completed &&
    resolvedCount === TOTAL &&
    dupes === 0 &&
    new Set(doneIdx).size === TOTAL &&
    faultyClaimedItems.length > 0 &&            // crashes actually happened
    recovered.length === faultyClaimedItems.length; // every stranded item recovered
  console.log(`\nVERDICT: ${PASS ? "✅ exactly-once survives agent crashes via emergent re-dispatch" : "❌ work lost or stuck after crashes"}`);
  console.log("════════════════════════════════════════════════════════════════════════\n");

  server!.close();
  process.exit(PASS ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
