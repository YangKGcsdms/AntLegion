/**
 * tools.js — the bus surface handed to the model.
 *
 * Seven tools, one per protocol op. They are deliberately thin: every rule that
 * matters (exactly-once, claim expiry, causation depth) is a fold or a bus
 * invariant, not something a tool wrapper should re-implement.
 *
 * Schema note: dsh validates every returned value against `output.schema`, and
 * its object schemas require an explicit `additionalProperties` — openness is
 * never inferred. Facts carry author-shaped payloads, so their slots are
 * declared `type: 'json'` (the unconstrained lossless-JSON node) rather than a
 * fake object shape.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { probeBus, renderProbe } from './preflight.js'

/** A fact id, as it appears everywhere in the protocol. */
const ID_PARAM = { type: 'string', required: true, description: '事实 id（内容哈希）' }

const text = (value) => [{ type: 'text', text: value }]

/**
 * Register the bus tools on a context.
 * @param ctx - the context that owns the registrations (root, or agent-scoped).
 * @param client - a bound ClientV2.
 * @param busUrl - the node those tools talk to, for the connectivity probe.
 * @returns a disposer for all of them.
 */
export function registerBusTools(ctx, client, busUrl) {
  const disposers = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'antlegion_ping',
    description: '检查事实总线是否可达，并报告协议版本、当前 head seq 和事实总数。发布/读取报错时先用它分清是"总线不通"还是"你用错了"。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.summary),
    },
    async execute() {
      const verdict = await probeBus(busUrl)
      return { ok: verdict.ok, url: verdict.url, summary: renderProbe(verdict) }
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', kind: 'read', title: `ping ${busUrl}` }),
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'antlegion_publish',
    description: '向 AntLegion 事实总线追加一条不可变事实（facts, not commands）。agent 之间通过发布/认领/解决事实协作，从不互相发指令。',
    parameters: {
      type: { type: 'string', required: true, description: '事实类型，点分命名如 task.todo、plan.ready' },
      payload: { type: 'json', description: '任意 JSON 载荷' },
      refs: { type: 'json', description: '关系引用，如 { parent: "<fact-id>" }；引用的永远是事实 id，不是 agent' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          seq: { type: 'integer', required: true },
          deduped: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => text(`published ${value.id} (seq ${value.seq}${value.deduped ? ', deduped' : ''})`),
    },
    async execute(args) {
      return client.publish(args.type, args.payload ?? {}, args.refs ? { refs: args.refs } : {})
    },
    presentCall: (args) => ({ card: 'generic', kind: 'other', title: `publish ${args?.type ?? 'fact'}`, rawInput: args?.payload }),
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'antlegion_query',
    description: '从事实总线读取事实（游标 since + 类型/作者过滤）。用于感知其他 agent 已经发布/认领/解决了什么。',
    parameters: {
      since: { type: 'integer', description: '只读 seq > since 的事实（游标）' },
      type: { type: 'string', description: 'glob 类型过滤，如 task.*' },
      author: { type: 'string', description: '按作者过滤' },
      limit: { type: 'integer', description: '最多返回条数（服务端有上限）' },
    },
    output: {
      schema: { type: 'array' },
      render: (_args, value) => text(
        value.length === 0
          ? 'no facts'
          : value.map((f) => `#${f.seq} ${f.type} @${f.author} ${f.id}`).join('\n'),
      ),
    },
    async execute(args) {
      const query = {}
      if (args.since !== undefined) query.since = args.since
      if (args.type !== undefined) query.type = args.type
      if (args.author !== undefined) query.author = args.author
      if (args.limit !== undefined) query.limit = args.limit
      return client.query(query)
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', kind: 'search', title: 'query facts', rawInput: args }),
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'antlegion_claim',
    description: '认领一条事实以独占处理。exactly-once 是全序的定理而非锁：seq 最小的活跃 claim 赢，输了就换一件事做。',
    parameters: { id: ID_PARAM },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          won: { type: 'boolean', required: true },
          winner: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => text(value.won ? `won claim (winner: ${value.winner})` : `lost — winner is ${value.winner}; move on`),
    },
    async execute(args) {
      return client.claim(args.id)
    },
    presentCall: (args) => ({ card: 'generic', kind: 'other', title: `claim ${shortId(args?.id)}` }),
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'antlegion_resolve',
    description: '解决一条事实（只有当前 claim 赢家能解决，SDK 会先读回确认，不是赢家会直接报错）。children 里的产出事实会挂在原事实下形成因果链。',
    parameters: {
      id: ID_PARAM,
      children: { type: 'json', description: '子事实数组 [{ type, payload }]' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childIds: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => text(`resolved; ${value.childIds.length} child fact(s)`),
    },
    async execute(args) {
      return client.resolve(args.id, Array.isArray(args.children) ? args.children : [])
    },
    presentCall: (args) => ({ card: 'generic', kind: 'other', title: `resolve ${shortId(args?.id)}` }),
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'antlegion_state',
    description: '折叠一条事实的生命周期（open / claimed / resolved / dead）及其 owner。状态是读端折叠出来的，总线自己不存状态。',
    parameters: { id: ID_PARAM },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', required: true },
          owner: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => text(`${value.state}${value.owner ? ` by ${value.owner}` : ''}`),
    },
    async execute(args) {
      return client.state(args.id)
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', kind: 'read', title: `state ${shortId(args?.id)}` }),
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'antlegion_observe',
    description: '对一条事实投票 corroborate（佐证）或 contradict（反驳），参与信任折叠。用于对别人的事实表态，而不是改写它。',
    parameters: {
      id: ID_PARAM,
      verdict: { type: 'string', required: true, enum: ['corroborate', 'contradict'], description: 'corroborate | contradict' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: (args, _value) => text(`voted ${args?.verdict} on ${shortId(args?.id)}`),
    },
    async execute(args) {
      await client.observe(args.id, args.verdict)
      return { ok: true }
    },
    presentCall: (args) => ({ card: 'generic', kind: 'other', title: `observe ${shortId(args?.id)}` }),
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'antlegion_causation',
    description: '追溯一条事实的因果链（root → leaf），用于回答"这件事是怎么来的"。',
    parameters: { id: ID_PARAM },
    output: {
      schema: { type: 'array' },
      render: (_args, value) => text(
        value.length === 0
          ? 'no chain'
          : value.map((f) => `#${f.seq} ${f.type} @${f.author}`).join(' → '),
      ),
    },
    async execute(args) {
      return client.causation(args.id)
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', kind: 'read', title: `causation ${shortId(args?.id)}` }),
  })))

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

/** Fact ids are 64 hex chars; UIs only need the head. */
function shortId(id) {
  return typeof id === 'string' && id.length > 12 ? `${id.slice(0, 12)}…` : String(id ?? '')
}
