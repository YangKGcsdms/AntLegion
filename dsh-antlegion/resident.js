/**
 * resident.js — the resident DCU session.
 *
 * One long-lived Agent, created at plugin mount and kept alive for the process.
 * It is never driven by a human: the patrol hands it facts, and this runtime
 * turns each hand-off into exactly one waking turn, serialized on the agent's
 * own idle boundary (the same discipline `dsh-schedule`'s ScheduleRuntime uses
 * to fire reminders into a live session).
 *
 * Back-pressure lives here, not in the patrol: facts queue while a turn runs
 * and are drained in batches afterwards, so a slow model never stalls the bus
 * tail or the heartbeat.
 */

import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** How much of a fact payload is worth showing the model verbatim. */
const PAYLOAD_BUDGET = 800

/** Render one fact as a compact, self-contained briefing line. */
function renderFact(fact, index) {
  let payload = ''
  try {
    payload = JSON.stringify(fact.payload ?? {})
  } catch {
    payload = '<unserializable>'
  }
  if (payload.length > PAYLOAD_BUDGET) payload = `${payload.slice(0, PAYLOAD_BUDGET)}… (truncated)`
  const refs = fact.refs && Object.keys(fact.refs).length > 0 ? `\n   refs: ${JSON.stringify(fact.refs)}` : ''
  return `${index + 1}. id=${fact.id}\n   type=${fact.type}  author=${fact.author}  seq=${fact.seq}\n   payload: ${payload}${refs}`
}

/**
 * Build the turn text for one batch of facts. Self-contained on purpose: the
 * session may have compacted away everything before it, so each briefing
 * restates the protocol instead of relying on conversational memory.
 */
export function brief(facts, { author, busUrl }) {
  const head = facts.length === 1
    ? '1 条新事实进入你的关注范围'
    : `${facts.length} 条新事实进入你的关注范围`
  return [
    `[AntLegion] ${head}（bus ${busUrl}，你的身份是 ${author}）：`,
    '',
    facts.map(renderFact).join('\n\n'),
    '',
    '按事实总线协议处理，逐条来：',
    '1. antlegion_claim(id) 先认领。won=false 说明别人赢了这一条 —— 直接跳过，不要重做。',
    '2. won=true 才动手。做完用 antlegion_resolve(id, children) 收尾，把你的产出放进 children（[{type, payload}]），它们会挂在原事实下形成因果链。',
    '3. 做不了或缺信息：antlegion_publish 一条 context.request 说明缺什么，然后继续下一条，不要卡住。',
    '',
    '规则：只发布事实，绝不给别的 agent 发指令；不确定就少做，别编。全部处理完就停下等下一批。',
  ].join('\n')
}

/** One process-local resident agent driven exclusively by bus facts. */
export class ResidentDCU {
  #ctx
  #options
  #agent
  #queue = []
  #stop = Promise.withResolvers()
  #stopping = false
  #run
  #disposal

  /**
   * @param ctx - the plugin's root context (carries agents/sessions/logger).
   * @param options - author, busUrl, sessionId, cwd, maxFactsPerTurn, log.
   */
  constructor(ctx, options) {
    this.#ctx = ctx
    this.#options = options
  }

  /** The live agent, once {@link start} has resolved. */
  get agent() {
    return this.#agent
  }

  /**
   * Create the resident agent. Awaits full application composition first so the
   * agent is born with every scoped tool — including this plugin's — in place.
   */
  async start() {
    await this.#ctx.get('loader')?.await()
    if (this.#stopping) return
    const agents = this.#ctx.get('agents')
    const defaultModel = this.#ctx.get('agentDefaultModel')
    if (agents === undefined || defaultModel === undefined) {
      throw new Error('antlegion-dcu: resident mode needs the `agents` and `agentDefaultModel` services')
    }

    const selection = defaultModel.currentSelection()
    const sessionId = this.#options.sessionId || `session-antlegion-dcu-${randomUUID()}`
    // This bundle composes no preset roster, so the model-facing rows sit in
    // the host plane and the agent reads them from the global layer — the same
    // arrangement dsh-headless documents for a directly created agent.
    const { agent } = await agents.create({
      sessionId,
      meta: { cwd: this.#options.cwd || process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      },
    })
    this.#agent = agent
    this.#options.log(`resident session ${sessionId} up on ${selection.provider}/${selection.model}`)
    // Facts may have arrived while the model was being resolved.
    if (this.#queue.length > 0) this.#kick()
  }

  /**
   * Hand facts to the resident session. Returns immediately — this is the
   * patrol's trigger edge and must never block the bus tail.
   * @param facts - selected work facts, in bus order.
   */
  enqueue(facts) {
    if (this.#stopping || facts.length === 0) return
    this.#queue.push(...facts)
    if (this.#agent !== undefined) this.#kick()
  }

  /** Start the drain if one is not already running. */
  #kick() {
    if (this.#run !== undefined || this.#stopping) return
    const run = this.#drain()
    this.#run = run
    void run.then(
      () => { this.#retire(run) },
      (error) => {
        this.#options.log(`turn failed: ${error instanceof Error ? error.message : String(error)}`)
        this.#retire(run)
      },
    )
  }

  /** Release the finished drain and honor anything queued in its final tick. */
  #retire(run) {
    if (this.#run !== run) return
    this.#run = undefined
    if (this.#queue.length > 0 && !this.#stopping) this.#kick()
  }

  /** Drive queued facts into turns, one turn at a time. */
  async #drain() {
    const { maxFactsPerTurn, author, busUrl } = this.#options
    while (this.#queue.length > 0 && !this.#stopping) {
      // Wait for a real idle boundary before injecting: a followup landing
      // mid-turn would be a second ordinary message on someone else's turn.
      await Promise.race([this.#agent.whenIdle(), this.#stop.promise])
      if (this.#stopping) return
      const facts = this.#queue.splice(0, maxFactsPerTurn)
      const message = createUserMessage({
        content: [{ type: 'text', text: brief(facts, { author, busUrl }) }],
        source: { kind: 'plugin', plugin: 'antlegion-dcu' },
      })
      // Background work has no human initiator; attributing it to one would
      // misreport who asked for the turn.
      const agents = this.#ctx.get('agents')
      if (agents?.withoutInitiator !== undefined) {
        agents.withoutInitiator(() => { this.#agent.followup(message) })
      } else {
        this.#agent.followup(message)
      }
      this.#options.log(`woke session with ${facts.length} fact(s)`)
      await Promise.race([this.#agent.whenIdle(), this.#stop.promise])
      if (this.#stopping) return
      await this.#ctx.get('sessions')?.flush(this.#agent.session)
    }
  }

  /** Stop future turns and await the in-flight drain. */
  dispose() {
    return (this.#disposal ??= (async () => {
      this.#stopping = true
      this.#queue.length = 0
      this.#stop.resolve()
      await Promise.allSettled([this.#run].filter((value) => value !== undefined))
    })())
  }
}
