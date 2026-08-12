/**
 * dcus/workers-llm.ts — LLM-backed stage workers (the act step only).
 *
 * The boundary (v0's lesson, kept structural): the DCU loop, folds, claims,
 * and evidence shapes are deterministic code. The LLM is invoked here, inside
 * act, to produce *content* — and even then the deterministic side coerces
 * every field, so a malformed completion degrades to a valid fallback instead
 * of a rejected artifact. The LLM has no input into coordination.
 *
 * Enable with ANT_WORKER=llm (requires DEEPSEEK_API_KEY).
 */

import { llmJson, asString, asStringArray } from "../llm.js";
import type { ReqChainView } from "../folds/devchain.js";
import type { Worker } from "./devchain-dcus.js";
import { writePlanDoc } from "./devchain-dcus.js";

const asNumber = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const SYSTEM = "你是软件交付流水线里的一个工作单元。回答精炼、专业、中文。";

const reqLine = (req: ReqChainView) => `需求「${req.name}」（slug: ${req.slug}）`;

export const llmPlanWorker: Worker = async (req, ctx, workspaceRoot) => {
  let j: Record<string, unknown> = {};
  try {
    j = await llmJson(SYSTEM,
      `为${reqLine(req)}拟一份最小方案，JSON 字段：` +
      `{"scope":"一句话说明做什么","out_of_scope":["2-3条不做什么"],"acceptance":["2-3条验收口径"]}`);
  } catch (err) {
    ctx.log(`llm plan fallback (${err instanceof Error ? err.message : String(err)})`);
  }
  const payload = {
    reqSlug: req.slug,
    doc: "docs/方案.md",
    scope: asString(j.scope, `实现「${req.name}」：按需求拆解出的最小闭环`),
    out_of_scope: asStringArray(j.out_of_scope, ["不改动存量计算口径", "不引入新的外部依赖"]),
    acceptance: asStringArray(j.acceptance, ["单测通过且报告列明未覆盖项", "E2E 报告含偏差/缺陷/缺口三段"]),
    generator: "llm",
  };
  await writePlanDoc(req, ctx, workspaceRoot, payload, "LLM worker (deepseek)");
  return payload;
};

export const llmDevWorker: Worker = async (req, ctx) => {
  let j: Record<string, unknown> = {};
  try {
    j = await llmJson(SYSTEM,
      `${reqLine(req)}进入开发。给出 JSON：{"branch":"feature/开头的分支名",` +
      `"changed_files":["2-3个合理的改动文件路径"],"consumers_checked":["1-2条消费方核查结论"]}`);
  } catch (err) {
    ctx.log(`llm dev fallback (${err instanceof Error ? err.message : String(err)})`);
  }
  return {
    reqSlug: req.slug,
    branch: asString(j.branch, `feature/${req.slug}`),
    changed_files: asStringArray(j.changed_files, [`src/${req.slug}/index.ts`]),
    consumers_checked: asStringArray(j.consumers_checked, ["grep 全部消费方：无既有调用点受影响"]),
    generator: "llm",
  };
};

export const llmUnittestWorker: Worker = async (req, ctx) => {
  let j: Record<string, unknown> = {};
  try {
    j = await llmJson(SYSTEM,
      `${reqLine(req)}开发完成，出单测报告。JSON：{"passed":通过数(整数),` +
      `"failed":0,"not_covered":["2条真实感的未覆盖场景"]}`);
  } catch (err) {
    ctx.log(`llm unittest fallback (${err instanceof Error ? err.message : String(err)})`);
  }
  return {
    reqSlug: req.slug,
    passed: asNumber(j.passed, 12),
    failed: asNumber(j.failed, 0),
    not_covered: asStringArray(j.not_covered, ["并发重入场景未覆盖"]),
    generator: "llm",
  };
};

export const llmE2eWorker: Worker = async (req, ctx) => {
  let j: Record<string, unknown> = {};
  try {
    j = await llmJson(SYSTEM,
      `${reqLine(req)}单测通过，出 E2E 报告。JSON：{"api_assertions":断言数(整数),` +
      `"deviations":[],"defects":[],"gaps":["1条留给人工验证的缺口"]}`);
  } catch (err) {
    ctx.log(`llm e2e fallback (${err instanceof Error ? err.message : String(err)})`);
  }
  return {
    reqSlug: req.slug,
    api_assertions: asNumber(j.api_assertions, 27),
    page_checked: true, // 页面验证是流程承诺，不由 LLM 声明
    deviations: asStringArray(j.deviations, []).slice(),
    defects: asStringArray(j.defects, []).slice(),
    gaps: asStringArray(j.gaps, ["未在真实数据环境验证（留给人工）"]),
    generator: "llm",
  };
};
