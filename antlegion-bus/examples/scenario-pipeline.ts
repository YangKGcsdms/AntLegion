/**
 * Scenario ③ — PIPELINE + SUPERSESSION (causal stages + latest-wins freshness).
 *
 * Real angle: a CI/CD-style choreography where work flows through causal stages,
 * AND a shared "current status" keeps changing — agents must always act on the
 * freshest fact, never a stale one. No orchestrator sequences the stages; each
 * stage agent just reacts to the previous stage's fact (§3.4 causation), and the
 * deploy status is a subject_key the fold keeps latest-wins (§3.3).
 *
 *   releaser     → publishes RELEASES × build.requested {release}
 *   builders (4) → claim build.requested → resolve build.done   (parent linked)
 *   testers  (4) → claim build.done      → resolve test.passed  (parent linked)
 *   deployers(4) → claim test.passed     → resolve deploy.status (parent + subject="prod")
 *   monitors (4) → read the CURRENT (non-superseded) deploy.status; must all agree
 *
 * Run: npx tsx examples/scenario-pipeline.ts
 */

import { serve } from "@hono/node-server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerV2 } from "../src/v2/server.js";
import { ClientV2, httpTransport } from "../src/v2/client.js";
import { isSuperseded } from "../src/v2/fold.js";

const RELEASES = 5, POOL = 4, MONITORS = 4, SUBJECT = "prod";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "antlegion-pipe-"));
  const { app } = createServerV2({ secret: "pipe", dataDir: dir, fsync: "no" });
  let server: { close: () => void };
  const port = await new Promise<number>((res) => {
    const s = serve({ fetch: app.fetch, port: 0 }, (i) => res(i.port));
    server = s as unknown as { close: () => void };
  });
  const base = `http://localhost:${port}`;
  const client = (n: string) => new ClientV2(httpTransport(base), n);
  let stop = false;

  // a generic stage worker: claim facts of `inType`, resolve into one `outType` child
  const stage = (role: string, n: number, inType: string, out: (rel: number, parentPayload: any) => { type: string; payload?: any; refs?: any }) =>
    Array.from({ length: n }, (_, k) =>
      (async () => {
        const c = client(`${role}-${k}`);
        const attempted = new Set<string>();
        while (!stop) {
          for (const f of await c.query({ type: inType, limit: 200 })) {
            if (attempted.has(f.id)) continue;
            if ((await c.state(f.id)).state !== "open") { attempted.add(f.id); continue; }
            attempted.add(f.id);
            const r = await c.claim(f.id);
            if (r.won) await c.resolve(f.id, [out((f.payload as { release: number }).release, f.payload)]);
          }
          await sleep(12);
        }
      })());

  const builders = stage("builder", POOL, "build.requested", (rel) => ({ type: "build.done", payload: { release: rel } }));
  const testers = stage("tester", POOL, "build.done", (rel) => ({ type: "test.passed", payload: { release: rel } }));
  const deployers = stage("deployer", POOL, "test.passed", (rel) => ({
    type: "deploy.status", payload: { release: rel, version: `v${rel}` }, refs: { subject: SUBJECT },
  }));

  // monitors read the CURRENT (non-superseded) deploy.status and record it
  const monitorReading = new Map<string, string>();
  const monitors = Array.from({ length: MONITORS }, (_, k) =>
    (async () => {
      const c = client(`monitor-${k}`);
      while (!stop) {
        const all = await c.query({ since: 0, limit: 100000 });
        const current = all.filter((f) => f.type === "deploy.status" && !isSuperseded(all, f.id));
        if (current.length === 1) monitorReading.set(c.author, current[0].id);
        await sleep(25);
      }
    })());

  // releaser seeds the pipeline (facts, not commands)
  const releaser = client("releaser");
  for (let r = 1; r <= RELEASES; r++) { await releaser.publish("build.requested", { release: r }); await sleep(30); }

  // wait until all releases reach deploy.status
  const t0 = Date.now();
  let completed = false;
  while (Date.now() - t0 < 25000) {
    if ((await releaser.query({ type: "deploy.status", limit: 200 })).length >= RELEASES) { completed = true; break; }
    await sleep(60);
  }
  await sleep(300); // let monitors observe the final current
  const elapsed = Date.now() - t0;
  stop = true;
  await Promise.allSettled([...builders, ...testers, ...deployers, ...monitors]);

  // ── validate ──
  const all = await releaser.query({ since: 0, limit: 100000 });
  const count = (t: string) => all.filter((f) => f.type === t).length;
  const deploys = all.filter((f) => f.type === "deploy.status");
  const current = deploys.filter((f) => !isSuperseded(all, f.id));
  const maxSeqDeploy = deploys.reduce((m, f) => (f.seq > m.seq ? f : m), deploys[0]);

  // causal chain of the current status: deploy.status → test.passed → build.done → build.requested
  const chain = current.length === 1 ? await releaser.causation(current[0].id) : [];

  const monitorVals = new Set(monitorReading.values());
  const monitorsAgree = monitorReading.size === MONITORS && monitorVals.size === 1;
  const monitorMatchesCurrent = current.length === 1 && monitorVals.has(current[0].id);

  console.log("\n══════════ Scenario ③ PIPELINE + SUPERSESSION (causal + freshness) ══════════");
  console.log(`agents               : 1 releaser + ${POOL} builders + ${POOL} testers + ${POOL} deployers + ${MONITORS} monitors`);
  console.log(`completed (emergent) : ${completed ? "YES" : "NO (timeout)"} in ${elapsed} ms`);
  console.log(`stage counts         : build.requested=${count("build.requested")} build.done=${count("build.done")} test.passed=${count("test.passed")} deploy.status=${deploys.length}`);
  console.log(`current (non-superseded) deploy.status : ${current.length}  (expect exactly 1)`);
  console.log(`current == highest-seq deploy          : ${current.length === 1 && current[0].id === maxSeqDeploy.id}`);
  console.log(`current version       : ${current.length === 1 ? (current[0].payload as { version: string }).version : "?"}`);
  console.log(`causal chain of current: ${chain.map((f) => f.type).join(" → ")}  (len ${chain.length})`);
  console.log(`monitors agree on current: ${monitorsAgree} (${monitorReading.size}/${MONITORS} read, ${monitorVals.size} distinct value)`);

  const PASS =
    completed &&
    count("build.done") === RELEASES &&
    count("test.passed") === RELEASES &&
    deploys.length === RELEASES &&
    current.length === 1 &&
    current[0].id === maxSeqDeploy.id &&
    chain.length === 4 &&
    monitorsAgree &&
    monitorMatchesCurrent;
  console.log(`\nVERDICT: ${PASS ? "✅ causal stages chained, exactly one fresh status, all monitors agree" : "❌ pipeline or freshness invariant violated"}`);
  console.log("════════════════════════════════════════════════════════════════════════════\n");

  server!.close();
  process.exit(PASS ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
