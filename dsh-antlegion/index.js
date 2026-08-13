/**
 * @antlegion/dsh — turn a DeepSeek Harness process into an AntLegion DCU.
 *
 * Two halves, one plugin:
 *
 *   tools    the seven bus ops handed to the model (publish/query/claim/
 *            resolve/state/observe/causation) — how the agent ACTS.
 *   resident a long-lived Agent plus a plain-Node patrol over the fact bus —
 *            how the agent gets WOKEN, with no human in the loop.
 *
 * The split is the point: perception is deterministic Node code (poll, fold,
 * select), and only the act of deciding what to do about a fact costs an LLM
 * turn. Facts, not commands — the patrol never tells the agent what to do, it
 * hands it what happened.
 */

import { ClientV2, httpTransport } from '@antlegion/bus/client'
import z from '@deepseek-ai/schemastery'
import { createPatrol } from './patrol.js'
import { probeBus, renderProbe } from './preflight.js'
import { ResidentDCU } from './resident.js'
import { registerBusTools } from './tools.js'

/** Stable Cordis plugin name. */
export const name = 'antlegion-dcu'

/**
 * `tools` carries the bus surface; the rest back the resident session. They are
 * all core dsh-base services, so requiring them costs nothing and fails loudly
 * rather than half-mounting a DCU that can never wake.
 */
export const inject = ['tools', 'agents', 'agentDefaultModel', 'sessions']

export const Config = z.object({
  /** Bus base URL. Defaults to the loopback bus, matching `alctl`'s default. */
  busUrl: z.string().default(process.env.ANTLEGION_BUS_URL || 'http://127.0.0.1:28090'),
  /** Fact author for everything this DCU publishes — its colony identity. */
  author: z.string().default(process.env.ANTLEGION_AUTHOR || 'dsh-dcu'),
  /** Run the resident session + patrol. Set false for a tools-only mount. */
  resident: z.boolean().default(true),
  /** Fact-type globs that wake the session, e.g. `['task.*', 'req.ready']`. */
  interests: z.array(z.string()).default([]),
  /** Fact types this DCU emits, declared to the §7 colony roster. */
  publishes: z.array(z.string()).default([]),
  /** Patrol poll interval in ms. */
  pollMs: z.number().default(1000),
  /**
   * How long one registration stays valid. The liveness slot is refreshed at
   * half this, and only when the DCU has not already published something —
   * work is its own proof of life. 0 registers once and never refreshes.
   */
  livenessTtlSec: z.number().default(300),
  /**
   * Legacy fixed-rate `sys.heartbeat`, off by default. Nothing supersedes a
   * heartbeat, so every one is a permanent log entry that is meaningless
   * seconds later; turn it on only for a reader that folds heartbeats
   * specifically (ant's identity-conflict watchdog).
   */
  heartbeatSec: z.number().default(0),
  /** Claim-expiry Δ in seconds for this DCU's folds; 0 uses the §8 default. */
  claimTimeoutSec: z.number().default(0),
  /** Most facts briefed into one turn; the rest wait for the next. */
  maxFactsPerTurn: z.number().default(5),
  /** Pin the resident session id. Empty mints a fresh one per boot. */
  sessionId: z.string().default(''),
  /** Working directory for the resident session. Empty uses the process cwd. */
  cwd: z.string().default(''),
})

/**
 * Mount the DCU.
 * @param ctx - plugin context carrying tools and the agent registry.
 * @param config - validated plugin config.
 */
export function apply(ctx, config) {
  // A DCU profile mounts no UI and, unless the profile wires a logger exporter,
  // `ctx.logger` buffers into nothing — a background daemon whose only record of
  // itself is invisible. So stderr is the primary sink and ctx.logger is
  // additive, for profiles that do collect it.
  const log = (message) => {
    console.error(`[antlegion-dcu] ${new Date().toISOString()} ${message}`)
    try {
      ctx.logger?.info?.(`antlegion-dcu: ${message}`)
    } catch {
      // A logger that is not wired up must never take the DCU down with it.
    }
  }

  const claimTimeout = config.claimTimeoutSec > 0 ? config.claimTimeoutSec : undefined
  // One client for the whole plugin: the tools the model calls and the patrol
  // that wakes it read the same stream through the same mirror.
  const client = new ClientV2(
    httpTransport(config.busUrl),
    config.author,
    claimTimeout === undefined ? {} : { claimTimeout },
  )

  ctx.effect(() => {
    const disposeTools = registerBusTools(ctx, client, config.busUrl)

    // Say once, out loud, whether this address is a bus. A DCU pointed at the
    // wrong port is otherwise indistinguishable from a quiet colony. This never
    // blocks or fails the mount: the patrol reconnects on its own, so a bus
    // started five minutes from now still works.
    void probeBus(config.busUrl).then(
      (verdict) => {
        log(renderProbe(verdict))
        if (!verdict.ok) log(`run \`node check.js ${config.busUrl}\` for what to do about it`)
      },
      () => {},
    )

    if (!config.resident) {
      log(`tools-only mount — bus ${config.busUrl}, author ${config.author}`)
      return disposeTools
    }

    if (config.interests.length === 0) {
      log('WARNING: `interests` is empty — the resident session will never be woken by a fact. Set interests, e.g. ["task.*"].')
    }

    const resident = new ResidentDCU(ctx, {
      author: config.author,
      busUrl: config.busUrl,
      sessionId: config.sessionId,
      cwd: config.cwd,
      maxFactsPerTurn: config.maxFactsPerTurn,
      log,
    })

    const patrol = createPatrol({
      client,
      busUrl: config.busUrl,
      author: config.author,
      interests: config.interests,
      publishes: config.publishes,
      pollMs: config.pollMs,
      livenessTtlSec: config.livenessTtlSec,
      heartbeatSec: config.heartbeatSec,
      claimTimeout,
      log,
      onWork: (facts) => { resident.enqueue(facts) },
    })

    // Start the session first: the patrol may select work on its very first
    // tick, and `enqueue` before the agent exists only parks it.
    const started = resident.start().then(
      () => { patrol.start() },
      (error) => { log(`resident session failed to start: ${error instanceof Error ? error.message : String(error)}`) },
    )

    return async () => {
      disposeTools()
      await started.catch(() => {})
      await patrol.stop()
      await resident.dispose()
      log('stopped')
    }
  }, 'antlegion-dcu()')
}
