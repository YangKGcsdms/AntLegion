/**
 * A mock colony: one real bus process and twelve isolated agent processes.
 *
 *   npx tsx examples/mock-colony/colony.ts
 *
 * Why another scenario. The existing `scenario-*.ts` runs several clients over
 * real HTTP but inside ONE Node process — one event loop, one clock, one fetch
 * stack, one crash domain. The protocol's central claim is about agents that
 * share none of that, so this harness spawns each agent as its own OS process
 * and gives it exactly two facts about the world: a bus URL and its own name.
 *
 * No agent is handed a task list, a peer list, a phase schedule or a shutdown
 * signal. The run's phase is itself a subject register on the log, which every
 * agent folds — so the harness coordinates the way the protocol says to, and if
 * that did not work the harness could not run at all.
 *
 * What it is trying to break, by section:
 *
 *   §9.1  exclusivity — 4 workers + 1 crasher race for 24 tasks. Two agents
 *         concluding they won the same task is the failure.
 *   §9.3  monotonicity — the crasher dies holding claims. They must lapse and
 *         be re-dispatched, and a real resolve must never be undone.
 *   §9.4  idempotence — every worker resubmits its own claim byte-for-byte.
 *   §10.1 gates — an adversary tries a stranger's tombstone, a stranger's
 *         supersede, a resolve on something it never claimed, and a release it
 *         never held. The bus accepts all four (it does not judge meaning); the
 *         readers must refuse to honour any.
 *   §5    domains — the same adversary submits a non-finite ts, a malformed
 *         type, an empty refs value, two lifecycle refs, an array payload.
 *   §8.1  registers — sensors revise theirs; a retractor takes its head back.
 *   §8.2  trails — a chain plus one leaf whose parent never arrives.
 *   §9.2  determinism — cold auditors fold the world into a hash. Then the bus
 *         is SIGKILLed, restarted from its journal, and two FRESH auditors fold
 *         again. Same hash or the claim is false.
 *
 * Exit code 0 only if every check passes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ClientV2, httpTransport } from "../../src/client.js";
import { current, lifecycle, causationChain, isGap, supersededBy, trust } from "../../src/fold.js";
import type { Fact } from "../../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUS_ENTRY = join(HERE, "..", "..", "src", "index.ts");
const AGENT = join(HERE, "agent.ts");

// A per-run port, and a boot that refuses to talk to a bus it did not start.
// A fixed port gets inherited by the NEXT run whenever a previous bus outlives
// its orchestrator — `npx tsx` puts a shell and two nodes between us and the
// server, so killing the child we spawned does not always kill the listener.
// The first version of this harness had exactly that bug and reported fact
// counts that doubled on every invocation. It is the same question dsh's
// preflight asks: is the thing answering the thing you meant to talk to?
const PORT = 28200 + Math.floor(Math.random() * 300);
const BUS = `http://127.0.0.1:${PORT}`;
const DELTA = 4;                      // seconds — short enough to watch a claim lapse
const TASKS = 24;
const SECRET = "mock-colony-secret";

const PHASE = "run:phase";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const c = { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", off: "\x1b[0m" };

// ────────────────────────────── process control ─────────────────────────────

const dataDir = mkdtempSync(join(tmpdir(), "mock-colony-"));
let bus: ChildProcess | null = null;

async function bootBus(label: string, expectEmpty = false): Promise<void> {
  if (expectEmpty) {
    try {
      const squatter = await fetch(`${BUS}/health`, { signal: AbortSignal.timeout(500) });
      if (squatter.ok) throw new Error(`port ${PORT} already serves a bus — refusing to measure someone else's log`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("already serves")) throw err;
      /* nothing listening: good */
    }
  }
  bus = spawn("npx", ["tsx", BUS_ENTRY], {
    detached: true,                    // its own process group, so killBus reaches the listener
    env: {
      ...process.env, PORT: String(PORT), HOST: "127.0.0.1",
      ANTLEGION_DATA_DIR: dataDir, ANTLEGION_BUS_SECRET: SECRET,
      ANTLEGION_CLAIM_TIMEOUT: String(DELTA), ANTLEGION_FSYNC: "always",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${BUS}/health`)).ok) {
        const head = ((await (await fetch(`${BUS}/info`)).json()) as { head_seq: number }).head_seq;
        if (expectEmpty && head !== 0) throw new Error(`bus on ${PORT} came up holding ${head} facts — not a fresh log`);
        console.log(`${c.dim}bus ${label} (pid ${bus.pid}, port ${PORT}, Δ=${DELTA}s, fsync=always, head ${head})${c.off}`);
        return;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("not a fresh log")) throw err;
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("bus did not start");
}

/**
 * Kill the bus *tree*. `npx tsx` is a shell that spawns node that spawns node,
 * so signalling the handle we hold reaches the shell and leaves the listener
 * running. Detached + negative pid signals the whole group.
 */
const killBus = (signal: NodeJS.Signals = "SIGKILL") => {
  if (bus?.pid) { try { process.kill(-bus.pid, signal); } catch { bus.kill(signal); } }
  bus = null;
};

interface AgentResult { role: string; name: string; [k: string]: unknown }

/** Spawn one agent process and collect its RESULT lines. */
function spawnAgent(role: string, name: string, verbose: boolean, head?: number): Promise<AgentResult[]> {
  return new Promise((resolve) => {
    const argv = [AGENT, role, name, BUS];
    if (head !== undefined) argv.push(String(head));
    const child = spawn("npx", ["tsx", ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    const results: AgentResult[] = [];
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
      const lines = out.split("\n");
      out = lines.pop() ?? "";
      for (const l of lines) if (l.startsWith("RESULT ")) results.push(JSON.parse(l.slice(7)));
    });
    child.stderr.on("data", (b) => { if (verbose) process.stderr.write(`${c.dim}${b}${c.off}`); });
    child.on("exit", () => resolve(results));
  });
}

// ──────────────────────────────── the run ───────────────────────────────────

const failures: string[] = [];
const notes: string[] = [];
function check(ok: boolean, label: string, detail = ""): void {
  if (ok) console.log(`  ${c.green}✓${c.off} ${label}${detail ? ` ${c.dim}${detail}${c.off}` : ""}`);
  else { console.log(`  ${c.red}✗${c.off} ${label} ${c.red}${detail}${c.off}`); failures.push(`${label} ${detail}`); }
}

async function main(): Promise<void> {
  console.log(`${c.bold}═══ mock colony — 1 bus + 12 isolated agent processes ═══${c.off}\n`);
  await bootBus("up", true);

  const ctl = new ClientV2(httpTransport(BUS), "orchestrator@harness");
  let phaseFact: string | null = null;
  const setPhase = async (phase: string): Promise<void> => {
    phaseFact = phaseFact
      ? (await ctl.supersede(phaseFact, "ctl.phase", { phase })).id
      : (await ctl.publish("ctl.phase", { phase }, { refs: { subject: PHASE } })).id;
    console.log(`${c.dim}── phase: ${phase}${c.off}`);
  };
  const stream = (): Promise<Fact[]> => ctl.query({ since: 0, limit: 20000 });

  // Seed the world. `announce.open` exists so the adversary has something that
  // was never claimed to try to resolve.
  const taskIds: string[] = [];
  for (let i = 0; i < TASKS; i++) taskIds.push((await ctl.publish("task.open", { i })).id);
  const announce = await ctl.publish("announce.open", { note: "nobody claims this" });
  await setPhase("boot");

  const roles: Array<[string, string]> = [
    ["worker", "worker-0"], ["worker", "worker-1"], ["worker", "worker-2"], ["worker", "worker-3"],
    ["sensor", "sensor-0"], ["sensor", "sensor-1"],
    ["auditor", "auditor-0"], ["auditor", "auditor-1"],
    ["crasher", "crasher-0"], ["mallory", "mallory-0"],
    ["retractor", "retractor-0"], ["chainer", "chainer-0"],
  ];
  const verbose = process.argv.includes("--verbose");
  console.log(`${c.dim}spawning ${roles.length} agent processes…${c.off}`);
  const pending = roles.map(([r, n]) => spawnAgent(r, n, verbose));

  await sleep(2500);                 // let every process reach its `until()`
  await setPhase("work");
  await sleep(15_000);               // > 3Δ: the crasher's claims must lapse and be retaken
  await setPhase("observe");
  await sleep(5_000);
  await setPhase("attack");
  await sleep(4_000);
  await setPhase("settle");
  await sleep(3_000);
  await setPhase("done");

  const settled = await Promise.all(pending);
  const results = settled.flat();
  const byRole = (r: string) => results.filter((x) => x.role === r);

  // ── the world as it stands, folded by the orchestrator ──
  const all = await stream();
  console.log(`\n${c.bold}facts on the log: ${all.length}${c.off}\n`);

  // §9.1 exclusivity ---------------------------------------------------------
  console.log(`${c.bold}§9.1 exclusivity${c.off}`);
  const workers = byRole("worker");
  const claimedTwice: string[] = [];
  const seen = new Map<string, string>();
  for (const w of workers) for (const id of (w.won as string[])) {
    if (seen.has(id)) claimedTwice.push(id); else seen.set(id, w.name);
  }
  check(claimedTwice.length === 0, "no task was won by two agents",
    claimedTwice.length ? `dupes=${claimedTwice.length}` : `${seen.size} tasks won across ${workers.length} workers`);

  // Appended vs honoured. A losing author is not prevented from appending —
  // §9.1 is explicit that it guarantees agreement, not mutual exclusion in the
  // OS sense. What must never happen is two HONOURED completions of one task.
  const doneFacts = all.filter((f) => f.type === "task.done");
  const doneByTask = new Map<string, string[]>();
  for (const d of doneFacts) {
    const parent = d.refs.parent;
    if (parent) doneByTask.set(parent, [...(doneByTask.get(parent) ?? []), d.author]);
  }
  const appendedTwice = [...doneByTask.entries()].filter(([, a]) => a.length > 1);
  const resolveFacts = all.filter((f) => f.refs.resolves);
  const honouredResolvers = new Map<string, string>();
  for (const id of taskIds) {
    const st = lifecycle(all, id, { claimTimeout: DELTA });
    if (st.state === "resolved" && st.owner) honouredResolvers.set(id, st.owner);
  }
  check(honouredResolvers.size === taskIds.filter((id) =>
    lifecycle(all, id, { claimTimeout: DELTA }).state === "resolved").length,
    "every resolved task names exactly one resolver", `${honouredResolvers.size} resolvers`);
  check([...doneByTask.values()].every((a) => new Set(a).size === a.length),
    "no author completed the same task twice");
  // Per-task breakdown, printed when anything looks off.
  const perTask = taskIds.map((id) => ({
    id: id.slice(0, 8),
    resolves: all.filter((f) => f.refs.resolves === id).map((f) => `${f.author}@${f.seq}`),
    dones: (doneByTask.get(id) ?? []).length,
  })).filter((t) => t.resolves.length > 1 || t.dones > 1);
  if (perTask.length) {
    console.log(`${c.yellow}  repeat-resolve breakdown (first 5):${c.off}`);
    for (const t of perTask.slice(0, 5)) console.log(`    ${t.id} dones=${t.dones} resolves=[${t.resolves.join(", ")}]`);
  }
  notes.push(`${resolveFacts.length} resolve facts appended for ${taskIds.length} tasks; ` +
    `${doneFacts.length} task.done facts; ${appendedTwice.length} tasks had a completion appended by ` +
    `more than one author` +
    (appendedTwice.length
      ? ` — losing authors DID append work products the fold does not sanction (§9.1: exclusivity is ` +
        `agreement, not prevention). Every such task still folds to ONE resolver.`
      : "."));

  const resolvedTasks = taskIds.filter((id) => lifecycle(all, id, { claimTimeout: DELTA }).state === "resolved");
  check(resolvedTasks.length > 0, "work actually got done", `${resolvedTasks.length}/${TASKS} resolved`);

  // §9.3 crash re-dispatch ---------------------------------------------------
  console.log(`\n${c.bold}§8.4/§9.3 crash re-dispatch and absorbing states${c.off}`);
  const crasher = byRole("crasher")[0];
  const taken = (crasher?.taken as string[]) ?? [];
  const retaken = taken.filter((id) => {
    const st = lifecycle(all, id, { claimTimeout: DELTA });
    return st.state === "resolved" && st.owner !== crasher.name;
  });
  check(taken.length > 0, "the crasher really held claims before dying", `held=${taken.length}`);
  check(retaken.length === taken.length,
    "every claim the crasher died holding was re-dispatched and completed by someone else",
    `${retaken.length}/${taken.length}`);

  // §9.4 idempotence ---------------------------------------------------------
  console.log(`\n${c.bold}§9.4 idempotence${c.off}`);
  const dedupSeen = workers.filter((w) => w.dedupObserved === true).length;
  check(dedupSeen > 0, "a byte-identical resubmit came back deduped at the same seq",
    `${dedupSeen}/${workers.length} workers observed it`);

  // §5 domains ---------------------------------------------------------------
  console.log(`\n${c.bold}§5 field domains — the bus refuses malformed facts${c.off}`);
  const m = byRole("mallory")[0];
  const atk = (m?.attacks ?? {}) as Record<string, number>;
  check(atk.nonFiniteTs === 400, "non-finite ts rejected", `HTTP ${atk.nonFiniteTs}`);
  check(atk.badType === 400, "malformed type rejected", `HTTP ${atk.badType}`);
  check(atk.emptyRefValue === 400, "empty refs value rejected, not dropped", `HTTP ${atk.emptyRefValue}`);
  check(atk.twoLifecycleRefs === 400, "two lifecycle refs rejected", `HTTP ${atk.twoLifecycleRefs}`);
  check(atk.arrayPayload === 400, "array payload rejected", `HTTP ${atk.arrayPayload}`);

  // §10.1 gates --------------------------------------------------------------
  console.log(`\n${c.bold}§10.1 fold gates — the bus stores them, the readers refuse them${c.off}`);
  const victimId = m?.victim as string | null;
  if (victimId) {
    check(atk.strangerTombstoneAccepted === 201, "the bus accepted a stranger's tombstone (it does not judge meaning)");
    const victim = all.find((f) => f.id === victimId)!;
    const subj = victim.refs.subject!;
    const stillCurrent = current(all, subj);
    check(stillCurrent !== null, "…and the register did NOT fold to null because of it",
      `current(${subj})=${stillCurrent?.id.slice(0, 8) ?? "null"}`);
    check(lifecycle(all, victimId, { claimTimeout: DELTA }).state !== "dead",
      "…and the victim is not dead");
    check(atk.strangerSupersedeBareAccepted === 201, "the bus accepted a stranger's bare supersede");
    const bare = all.find((f) => f.author === m.name && f.refs.supersedes === victimId && !f.refs.subject);
    check(!!bare && current(all, subj)?.id !== bare.id,
      "…and a supersede that does not carry the subject did NOT become current (§8.1 rule 1)");
  }

  // The gate's real scope, measured rather than assumed.
  const loneId = atk.loneTarget as unknown as string | undefined;
  if (loneId) {
    const before = all.find((f) => f.id === loneId)!;
    check(supersededBy(all, loneId) === null,
      "a stranger's supersede on a SUBJECT-LESS fact is ignored — this is what the gate buys",
      `target ${before.type} by ${before.author}`);
    check(trust(all, loneId, 2) !== "superseded",
      "…so its trust state was not silenced", `trust=${trust(all, loneId, 2)}`);
  }
  if (victimId) {
    // §8.1 rule 4 names "write to the register" as the sanctioned third-party
    // move. Measure what that does to the victim, because rule 4 also claims
    // the gate closes the trust-hijack — and these two cannot both be true.
    check(atk.strangerRegisterWriteAccepted === 201, "the bus accepted a stranger's plain register write");
    const victimTrust = trust(all, victimId, 2);
    const hijackedByRegisterWrite = victimTrust === "superseded";
    notes.push(hijackedByRegisterWrite
      ? `FINDING: a stranger silenced another author's trust state to \`superseded\` with one ordinary ` +
        `register write (no \`supersedes\` ref at all). §8.1 rule 4 claims the author gate "closes a hijack: ` +
        `an ungated supersedes let any author silence any fact's trust state with one append" — but it only ` +
        `closes it for SUBJECT-LESS facts. Any fact carrying a subject is still one append away, via the very ` +
        `path rule 4 sanctions two sentences earlier.`
      : `a stranger's register write left the victim's trust at ${victimTrust}`);
  }
  const announceState = lifecycle(all, announce.id, { claimTimeout: DELTA });
  check(atk.resolveNeverClaimedAccepted === 201, "the bus accepted a resolve on a never-claimed fact");
  check(announceState.state === "open",
    "…and the fold ignored it — a passer-by cannot close work (§8.4)", `state=${announceState.state}`);
  check(atk.releaseNotHeldAccepted === 201, "the bus accepted a release from a non-holder");

  // §8.1 registers -----------------------------------------------------------
  console.log(`\n${c.bold}§8.1 registers and retraction${c.off}`);
  const ret = byRole("retractor")[0];
  if (ret) {
    const retSubject = ret.subject as string;
    check(current(all, retSubject) === null,
      "a retracted register head folds to null — never back to the previous value",
      `current(${retSubject})=${current(all, retSubject)?.id.slice(0, 8) ?? "null"}`);
  }
  const sensorSubjects = [...new Set(all.filter((f) => f.type === "sensor.reading").map((f) => f.refs.subject!))];
  const sensorsCurrent = sensorSubjects.filter((s) => current(all, s) !== null);
  check(sensorSubjects.length > 0 && sensorsCurrent.length === sensorSubjects.length,
    "every sensor register still folds to a value", `${sensorsCurrent.length}/${sensorSubjects.length}`);

  // §8.2 trails --------------------------------------------------------------
  console.log(`\n${c.bold}§8.2 trails and explicit gaps${c.off}`);
  const ch = byRole("chainer")[0];
  if (ch) {
    const deep = causationChain(all, (ch.chain as string[])[4]);
    check(deep.length === 5 && !deep.some(isGap), "a fully resolvable chain has no gap", `len=${deep.length}`);
    const orphanChain = causationChain(all, ch.orphan as string);
    check(orphanChain.some(isGap), "an unresolved ancestor surfaces as an explicit gap marker",
      orphanChain.map((n) => (isGap(n) ? "GAP" : "fact")).join("→"));
  }

  // §9.2 determinism ---------------------------------------------------------
  console.log(`\n${c.bold}§9.2 determinism across isolated readers${c.off}`);
  const auditors = byRole("auditor");
  const hashes = [...new Set(auditors.map((a) => a.worldHash as string))];
  check(auditors.length >= 2, "cold auditors reported", `${auditors.length}`);
  check(hashes.length === 1, "auditors in separate processes folded ONE world",
    hashes.length === 1 ? `sha256 ${hashes[0].slice(0, 16)}…` : `${hashes.length} distinct hashes`);

  const advisoryDivergence = auditors.length >= 2
    && JSON.stringify(auditors[0].advisory) !== JSON.stringify(auditors[1].advisory);
  notes.push(advisoryDivergence
    ? "auditors DID differ on trailing (advisory) claim states — §9.3 says they may; those are excluded from the hash"
    : "auditors happened to agree on the advisory states too (they are not required to)");

  // ── kill the bus, replay the journal, fold the SAME prefix again ──
  //
  // The head is pinned here on purpose. §9.2's boundary is explicit that two
  // readers at different N may differ and that this is latency, not
  // disagreement — so comparing two folds taken at different heads would test
  // nothing. Pinning is how the same question gets asked twice.
  console.log(`\n${c.bold}§9.2/§11.1 SIGKILL the bus, replay the journal, re-fold the SAME prefix${c.off}`);
  const headBefore = all.reduce((mx, f) => Math.max(mx, f.seq), 0);
  const pinnedPre = (await Promise.all([
    spawnAgent("auditor", "pinned-pre-0", verbose, headBefore),
    spawnAgent("auditor", "pinned-pre-1", verbose, headBefore),
  ])).flat();
  const preHashes = [...new Set(pinnedPre.map((a) => a.worldHash as string))];
  check(preHashes.length === 1, `two fresh readers pinned at head ${headBefore} agree`,
    preHashes[0] ? `sha256 ${preHashes[0].slice(0, 16)}…` : "none");
  // Measured AFTER the pinned-pre probes, because those probes are agents too:
  // each announces itself, and those appends are part of the world.
  const headAtKill = ((await new ClientV2(httpTransport(BUS), "probe@harness").info()) as { head_seq: number }).head_seq;
  killBus("SIGKILL");
  await sleep(600);
  await bootBus("restarted from journal");

  const info = (await new ClientV2(httpTransport(BUS), "probe2@harness").info()) as Record<string, unknown>;
  check(info.head_seq === headAtKill, "the journal replayed to the head it was killed at",
    `head ${info.head_seq} (killed at ${headAtKill})`);
  check(info.id_failures === 0, "every content address re-verified on recovery", `id_failures=${info.id_failures}`);
  check(info.sig_failures === 0, "every signature re-verified", `sig_failures=${info.sig_failures}`);
  check(info.truncated_at === null, "no torn tail to truncate", `truncated_at=${info.truncated_at}`);

  const after = await Promise.all([
    spawnAgent("auditor", "pinned-post-0", verbose, headBefore),
    spawnAgent("auditor", "pinned-post-1", verbose, headBefore),
  ]);
  const coldHashes = [...new Set(after.flat().map((a) => a.worldHash as string))];
  check(coldHashes.length === 1, "the two post-crash readers agree with each other",
    coldHashes[0] ? `sha256 ${coldHashes[0].slice(0, 16)}…` : "none");
  check(coldHashes[0] === preHashes[0],
    "…and with the pre-crash world at the same head, byte for byte",
    coldHashes[0] === preHashes[0] ? "identical" : `${coldHashes[0]?.slice(0, 16)} vs ${preHashes[0]?.slice(0, 16)}`);

  // ── report ──
  console.log(`\n${c.bold}notes${c.off}`);
  for (const n of notes) console.log(`  ${c.yellow}·${c.off} ${n}`);

  console.log(`\n${c.bold}${failures.length === 0 ? `${c.green}VERDICT: ✅ the protocol held under 12 isolated processes` : `${c.red}VERDICT: ❌ ${failures.length} check(s) failed`}${c.off}`);
  for (const f of failures) console.log(`  ${c.red}${f}${c.off}`);

  killBus("SIGTERM");
  await sleep(300);
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  killBus("SIGKILL");
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
});
