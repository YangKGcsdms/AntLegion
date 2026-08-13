#!/usr/bin/env node
/**
 * verify-cli-eventflow.mjs — end-to-end proof that agents drive the bus through
 * the `alctl` CLI alone (the MCP adapter's replacement). Every step shells out
 * to `dist/bin.js` over HTTP against a REAL running bus — the full wire path
 * (server validation, HMAC, AOF), not an in-process shortcut.
 *
 * Two ways to run:
 *   node deploy/verify-cli-eventflow.mjs
 *       → boots its own bus (dist/index.js) on an ephemeral port, verifies, stops it.
 *   ANTLEGION_BUS_URL=http://localhost:28090 node deploy/verify-cli-eventflow.mjs
 *       → runs against an already-running bus (e.g. the Docker container).
 *
 * Exit 0 = every assertion passed. Non-zero = a step failed (printed).
 */
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUS_PKG = path.resolve(HERE, "..", "antlegion-bus");
const BIN = path.join(BUS_PKG, "dist", "bin.js");
const INDEX = path.join(BUS_PKG, "dist", "index.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

/** Run alctl as `author`, return { code, out, err } with out parsed if JSON. */
function alctl(url, author, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      env: { ...process.env, ANTLEGION_BUS_URL: url, ANTLEGION_AUTHOR: author },
    }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      let json = null;
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      try { json = line ? JSON.parse(line) : null; } catch { /* not json */ }
      resolve({ code, out: stdout.trim(), json, err: stderr.trim(), lines: stdout.trim().split("\n").filter(Boolean) });
    });
  });
}

async function bootBus() {
  // ephemeral port via PORT=0? the server binds a fixed port; pick a high one.
  const port = 28090 + Math.floor(Date.now() % 1000) + 100;
  const dataDir = path.join(HERE, `.verify-data-${port}`);
  const child = spawn(process.execPath, [INDEX], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ANTLEGION_BUS_SECRET: "verify", ANTLEGION_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  // wait for health
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url + "/health"); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { child, url, dataDir };
}

async function main() {
  const external = process.env.ANTLEGION_BUS_URL;
  let bus = null, url = external;
  if (!external) { bus = await bootBus(); url = bus.url; }
  console.log(`\n▶ CLI event-flow verification against ${url}${external ? " (external)" : " (self-booted)"}\n`);

  // ── agents declare their interests/publishes (§7 closed loop) ──
  await alctl(url, "planner", ["publish", "sys.registry", JSON.stringify({ interests: ["task.*"], publishes: ["task.done"] })]);
  await alctl(url, "auditor", ["publish", "sys.registry", JSON.stringify({ interests: ["task.done"], publishes: ["audit.ok"] })]);
  let r = await alctl(url, "obs", ["colony"]);
  ok("colony lists both registered agents", Array.isArray(r.json) && r.json.length === 2, JSON.stringify(r.json));

  // ── publish a unit of work, claim it exactly-once ──
  r = await alctl(url, "carter", ["publish", "task.build", JSON.stringify({ title: "compile" })]);
  const taskId = r.json?.id;
  ok("publish returns a content id", /^[0-9a-f]{64}$/.test(taskId || ""), taskId);

  const claimA = await alctl(url, "worker-a", ["claim", taskId]);
  ok("worker-a wins the claim (exit 0)", claimA.code === 0 && claimA.json?.won === true, JSON.stringify(claimA.json));
  const claimB = await alctl(url, "worker-b", ["claim", taskId]);
  ok("worker-b loses the claim (exit 1, winner=worker-a)", claimB.code === 1 && claimB.json?.won === false && claimB.json?.winner === "worker-a", JSON.stringify(claimB.json));

  let st = await alctl(url, "obs", ["state", taskId]);
  ok("state = claimed by worker-a", st.json?.state === "claimed" && st.json?.owner === "worker-a", JSON.stringify(st.json));

  // ── resolve + emit a child fact (causation) ──
  await alctl(url, "worker-a", ["resolve", taskId]);
  st = await alctl(url, "obs", ["state", taskId]);
  ok("state = resolved after worker-a resolves", st.json?.state === "resolved", JSON.stringify(st.json));
  r = await alctl(url, "worker-a", ["publish", "task.done", JSON.stringify({ result: "ok" }), "--parent", taskId]);
  const doneId = r.json?.id;
  const chain = await alctl(url, "obs", ["causation", doneId]);
  ok("causation chain is [task.build, task.done]", Array.isArray(chain.json?.chain) && chain.json.chain.length === 2 && chain.json.chain[0] === taskId, JSON.stringify(chain.json));

  // ── two observers corroborate → trust consensus ──
  await alctl(url, "r1", ["observe", doneId, "corroborate"]);
  await alctl(url, "r2", ["observe", doneId, "corroborate"]);
  const tr = await alctl(url, "obs", ["trust", doneId]);
  ok("trust = consensus after two corroborations", tr.json?.trust === "consensus", JSON.stringify(tr.json));

  // ── orphan detection: a type nobody declared interest in ──
  await alctl(url, "sensor", ["publish", "weird.telemetry", JSON.stringify({ v: 1 })]);
  const orph = await alctl(url, "obs", ["orphans"]);
  const orphanTypes = (orph.json?.orphanTypes || []).map((o) => o.type);
  ok("orphans flags weird.telemetry (no interested agent)", orphanTypes.includes("weird.telemetry"), JSON.stringify(orphanTypes));
  ok("orphans does NOT flag task.build (planner is interested)", !orphanTypes.includes("task.build"), JSON.stringify(orphanTypes));

  // ── context-sufficiency loop (§8) ──
  r = await alctl(url, "ci", ["publish", "build.failed", JSON.stringify({ note: "it broke" })]);
  const thinId = r.json?.id;
  r = await alctl(url, "dev", ["ask-context", thinId, "which target and what error?"]);
  const reqId = r.json?.id;
  let gaps = await alctl(url, "obs", ["context-gaps"]);
  ok("an open context request appears", Array.isArray(gaps.json) && gaps.json.some((g) => g.request === reqId && !g.answered), JSON.stringify(gaps.json));
  await alctl(url, "ci", ["provide-context", reqId, JSON.stringify({ answer: "arm64 target, linker error" })]);
  gaps = await alctl(url, "obs", ["context-gaps"]);
  ok("the context request closes after an answer", Array.isArray(gaps.json) && !gaps.json.some((g) => g.request === reqId), JSON.stringify(gaps.json));

  // ── server input validation reachable over the wire (review M2) ──
  const badLimit = await new Promise((res) => {
    fetch(`${url}/facts?limit=abc`).then((x) => res(x.status)).catch(() => res(0));
  });
  ok("GET /facts?limit=abc → 400 (M2 validation)", badLimit === 400, String(badLimit));

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
  if (bus) { bus.child.kill("SIGTERM"); await once(bus.child, "exit").catch(() => {}); }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
