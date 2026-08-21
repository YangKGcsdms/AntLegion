/**
 * dcus/worker-spawn.ts — the headless-agent act (计划 13 §二).
 *
 * The DCU stays a deterministic loop; this module is what happens after a
 * stage DCU WINS a claim in spawn mode: write the trigger + causation summary
 * to a prompt file, wake a real agent (claude -p / pi / codex exec …) inside
 * the colony folder, and hold the claim alive while it works.
 *
 * Contract (bus contract untouched — worker body only):
 *   exit 0 + artifact file present + shape valid  → resolve (artifact = child fact)
 *   anything else                                 → release + act.failed fact
 *
 * Claim renewal is the OVERLAPPING RE-CLAIM (no release): every Δ/3 the ant
 * re-claims the same input with a fresh nonce. Under §3.1 the earlier claim
 * expires at recv+Δ and the same author's later claim is then the lowest live
 * seq — ownership continues seamlessly, zero race, zero protocol change.
 * Child dies → renewal stops → the last claim expires naturally.
 */

import { spawn } from "node:child_process";
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import type { Fact } from "@antlegion/bus/types";
import { causationChain, isGap } from "@antlegion/bus/fold";
import type { SpawnConfig } from "../config.js";
import type { DCUContext } from "../runtime.js";
import type { StageSpec } from "../folds/devchain.js";

/** Failure fact published when a spawn act cannot resolve (refs.subject → trigger). */
export const ACT_FAILED = "act.failed";

/** Env vars every child gets (the boring runtime basics). */
const DEFAULT_ENV_PASS = ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "USER", "TERM"];

/** Never passed to a child, even when explicitly listed (计划 13 §二.6). */
const ENV_BLOCKLIST = /^(ANTLEGION_BUS_SECRET|LARK_.*)$/;

export function expandTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

/** Whitelist projection of `base`: defaults + explicit names, blocklist wins. */
export function buildSpawnEnv(
  base: NodeJS.ProcessEnv, envPass: string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...DEFAULT_ENV_PASS, ...envPass]) {
    if (ENV_BLOCKLIST.test(name)) continue;
    const v = base[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** The spawn artifact's mandatory shape — "没做什么"是必填（证据形状纪律）. */
export function validateSpawnArtifact(p: unknown): string[] {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return ["(not a JSON object)"];
  const o = p as Record<string, unknown>;
  const bad: string[] = [];
  if (typeof o.summary !== "string" || o.summary.trim() === "") bad.push("summary");
  if (!Array.isArray(o.changes)) bad.push("changes");
  if (typeof o.test_status !== "string" || o.test_status.trim() === "") bad.push("test_status");
  if (!Array.isArray(o.not_done) || o.not_done.length === 0) bad.push("not_done");
  return bad;
}

/** Last `max` bytes of accumulated stderr — the act.failed evidence. */
export function tail(buf: string, max = 2000): string {
  return buf.length <= max ? buf : buf.slice(buf.length - max);
}

export interface SpawnActArgs {
  stage: string;
  spec: Pick<StageSpec, "listens" | "produces" | "evidence">;
  req: { slug: string; name: string };
  /** The trigger fact this act resolves (the won claim's subject). */
  inputFact: Fact;
  ctx: DCUContext;
  /** Colony root — the agent's working site; .ant/ lives here. */
  colonyRoot: string;
  cfg: SpawnConfig;
  /** Fold Δ in seconds — renewal beats at Δ/3 (never bet the act on Δ itself). */
  claimDeltaSec: number;
}

export function buildPromptFile(a: SpawnActArgs, artifactFile: string): string {
  // §8.2: an ancestor that is not in the mirror comes back as an explicit gap,
  // and it has to reach the prompt as one. Silently dropping it would tell the
  // agent that the next line is where this began — "I could not see the origin"
  // rendered as "this is the origin" — which is exactly the wrong thing to hand
  // something that is about to act on the trail.
  const chain = causationChain(a.ctx.mirror, a.inputFact.id);
  const chainLines = chain.map((n) => (isGap(n)
    ? `- ⋯ 上游有一条本地未见的事实（${n.missing.slice(0, 12)}…）——这条链在此处不完整，不要当作起点`
    : `- seq ${n.seq} · ${n.type} · by ${n.author}`));
  const evidence = Object.entries(a.spec.evidence.required)
    .map(([k, desc]) => `- \`${k}\` — ${desc}`);
  return [
    `# 任务：${a.stage} — ${a.req.name}（${a.req.slug}）`,
    "",
    "你是这个文件夹（colony）里被唤醒的执行 agent。在本文件夹内自主完成任务",
    "（读码/改文件/跑测试），完成后把产物 JSON 写到指定路径，然后退出（exit 0）。",
    "",
    "## 触发事实",
    "```json",
    JSON.stringify({ type: a.inputFact.type, payload: a.inputFact.payload }, null, 2),
    "```",
    "",
    "## 因果链（这条工作是怎么走到你这里的）",
    ...chainLines,
    "",
    "## 产物契约（必须全部满足，否则视为失败）",
    `写到：\`${artifactFile}\``,
    "",
    "基础形状（必填）：`{\"summary\": \"...\", \"changes\": [...], \"test_status\": \"...\", \"not_done\": [\"至少一条——没做什么必须写明\"]}`",
    "",
    `本阶段（${a.stage}）证据字段（同一 JSON 里一并给出）：`,
    ...evidence,
    "",
    "## 约束",
    "- 工作记忆可读写：`.ant/memory/`（跨次唤醒延续上下文）",
    "- 禁止 git push（遵守文件夹内 AGENTS.md/CLAUDE.md 的纪律）",
    "",
  ].join("\n");
}

/**
 * Run one spawn act to completion. Never throws — every failure path ends in
 * release + ACT_FAILED. The caller only supplies the won claim.
 */
export async function runSpawnAct(a: SpawnActArgs): Promise<void> {
  const { ctx } = a;
  const vars = {
    cwd: path.resolve(a.colonyRoot, a.cfg.cwd ?? "."),
    req: a.req.slug,
    stage: a.stage,
    promptFile: path.join(a.colonyRoot, ".ant", "prompts", `${a.req.slug}.${a.stage}.md`),
    artifactFile: path.resolve(a.colonyRoot, expandTemplate(a.cfg.artifact, { req: a.req.slug, stage: a.stage })),
  };

  const fail = async (reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
    ctx.log(`act FAILED (${a.req.slug}/${a.stage}): ${reason}`);
    try {
      await ctx.client.release(a.inputFact.id);
    } catch (err) {
      // claim already expired / lost — expected when we died slowly; fold moves on
      ctx.log(`release skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await ctx.client.publish(ACT_FAILED,
        { stage: a.stage, reqSlug: a.req.slug, reason, ...extra },
        { refs: { subject: a.inputFact.id } });
    } catch (err) {
      ctx.log(`act.failed publish failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 1 | prompt file (trigger payload + causation summary + artifact contract)
  try {
    await fs.mkdir(path.dirname(vars.promptFile), { recursive: true });
    await fs.mkdir(path.join(a.colonyRoot, ".ant", "memory"), { recursive: true });
    await fs.mkdir(path.dirname(vars.artifactFile), { recursive: true });
    await fs.rm(vars.artifactFile, { force: true }); // a stale artifact must not pass as fresh
    await fs.writeFile(vars.promptFile, buildPromptFile(a, vars.artifactFile), "utf-8");
  } catch (err) {
    await fail(`prompt setup failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 2 | spawn the agent in the colony folder — whitelisted env only
  const cmd = expandTemplate(a.cfg.cmd, vars);
  const timeoutMs = (a.cfg.timeoutSec ?? 1800) * 1000;
  ctx.log(`spawn act (${a.req.slug}/${a.stage}): ${cmd} [timeout ${timeoutMs / 1000}s]`);

  const logPath = path.join(a.colonyRoot, ".ant", "logs", `${a.req.slug}.${a.stage}.log`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: "a" });
  logStream.write(`\n──── act ${new Date().toISOString()} · ${cmd}\n`);

  const child = spawn(cmd, {
    shell: true,
    cwd: vars.cwd,
    env: buildSpawnEnv(process.env, a.cfg.envPass),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  child.stdout?.on("data", (d: Buffer) => logStream.write(d));
  child.stderr?.on("data", (d: Buffer) => { stderrBuf = tail(stderrBuf + d.toString(), 8192); logStream.write(d); });

  // 3 | claim renewal: overlapping re-claim every Δ/3 while the child lives.
  //     Renewal stopping (child exit/kill) is what hands the work to others.
  const renewMs = Math.max(500, (a.claimDeltaSec * 1000) / 3);
  let lostClaim = false;
  const renewTimer = setInterval(() => {
    void ctx.client.claim(a.inputFact.id).then((c) => {
      if (!c.won) {
        // Should be impossible while we renew on time — treat as fatal.
        lostClaim = true;
        ctx.log(`claim LOST mid-act (${a.req.slug}/${a.stage}) to ${c.winner} — killing agent`);
        child.kill("SIGTERM");
      }
    }).catch((err) => ctx.log(`claim renew error: ${err instanceof Error ? err.message : String(err)}`));
  }, renewMs);
  renewTimer.unref?.();

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref?.();
  }, timeoutMs);
  killTimer.unref?.();

  const exitCode: number | null = await new Promise((res) => {
    child.on("error", (err) => { stderrBuf = tail(stderrBuf + `\nspawn error: ${err.message}`); res(null); });
    child.on("exit", (code) => res(code));
  });
  clearInterval(renewTimer);
  clearTimeout(killTimer);
  logStream.end(`──── exit ${exitCode} · ${new Date().toISOString()}\n`);

  // 4 | adjudicate the outcome
  if (lostClaim) return; // someone else owns it now — no resolve, no release
  if (timedOut) {
    await fail(`timeout after ${timeoutMs / 1000}s`, { exit_code: exitCode, stderr_tail: tail(stderrBuf) });
    return;
  }
  if (exitCode !== 0) {
    await fail(`agent exited ${exitCode}`, { exit_code: exitCode, stderr_tail: tail(stderrBuf) });
    return;
  }

  let artifact: Record<string, unknown>;
  try {
    artifact = JSON.parse(await fs.readFile(vars.artifactFile, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    await fail(`artifact missing/unreadable at ${vars.artifactFile}: ${err instanceof Error ? err.message : String(err)}`,
      { stderr_tail: tail(stderrBuf) });
    return;
  }
  const bad = validateSpawnArtifact(artifact);
  if (bad.length > 0) {
    await fail(`artifact shape invalid — missing ${bad.join(", ")}`, { missing: bad, stderr_tail: tail(stderrBuf) });
    return;
  }

  try {
    await ctx.client.resolve(a.inputFact.id, [
      { type: a.spec.produces, payload: { reqSlug: a.req.slug, generator: "spawn", ...artifact }, refs: { subject: a.req.slug } },
    ]);
    ctx.log(`resolved ${a.req.slug}/${a.stage} → ${a.spec.produces} (spawn act)`);
  } catch (err) {
    // claim expired in a renewal gap or a race — a survivor redoes it
    ctx.log(`resolve failed (${a.req.slug}/${a.stage}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
