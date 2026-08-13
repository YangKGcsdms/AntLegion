/**
 * patrol.js — the DCU patrol loop. Plain Node, zero harness imports.
 *
 * One loop, forever:
 *
 *   head-check → page facts since cursor → mirror → register/heartbeat → select work → hand off
 *
 * This is the AntLegion `runDCU` primitive (ant/src/runtime.ts) rebuilt as a
 * library: the bus is the only source of truth, the mirror is rebuilt from it,
 * and a bus restart (head < cursor) resets the cursor and re-announces us.
 *
 * The patrol NEVER blocks on the agent. `onWork` must enqueue and return —
 * if it awaited a whole LLM turn the loop would stall, the cursor would freeze,
 * and heartbeats would stop, which readers correctly fold as "this DCU died".
 */

import { lifecycle } from '@antlegion/bus/fold'

/** Heartbeat fact type — instance liveness, the identity-conflict fold's input. */
export const SYS_HEARTBEAT = 'sys.heartbeat'
/** Capability-declaration fact type — the §7 colony roster (`alctl registry`). */
export const SYS_REGISTRY = 'sys.registry'

/**
 * The keyed slot this DCU's liveness lives in.
 *
 * Liveness is a TTL, not a stream. Every registration carries `refs.subject`,
 * and §3.3 supersession is latest-wins WITHIN a subject group — so each refresh
 * supersedes the last one, and `POST /admin/rewrite` reclaims the old ones.
 * A fixed periodic heartbeat instead appends a fact that is meaningless 40
 * seconds later and can never be collected, because nothing supersedes it.
 */
const livenessSubject = (author) => `liveness:${author}`

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Same glob semantics as the bus's read filter (`canonical.ts:globMatch`). */
export function globMatch(pattern, text) {
  const regex = new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') + '$',
  )
  return regex.test(text)
}

/**
 * Protocol mechanics and infrastructure — never domain work. `_.claim`,
 * `_.resolve`, `sys.heartbeat` and friends must never wake an agent, or the
 * DCU's own bookkeeping would trigger itself in a loop.
 */
function isMechanical(type) {
  return type.startsWith('_.') || type.startsWith('sys.')
}

/**
 * Pick the facts from one batch that this DCU should actually wake up for.
 * @param batch - facts newly appended since the last poll.
 * @param mirror - the full mirrored stream (already includes `batch`).
 * @param options - author identity, interest globs, and the fold's claim window.
 * @returns the subset worth one agent turn.
 */
export function selectWork(batch, mirror, { author, interests, foldOpts }) {
  const work = []
  for (const fact of batch) {
    // Never wake on our own output: the agent's publishes land in the very
    // stream we are tailing, so self-facts are an infinite loop by construction.
    if (fact.author === author) continue
    if (isMechanical(fact.type)) continue
    if (!interests.some((pattern) => globMatch(pattern, fact.type))) continue
    // Someone already owns or finished it — exactly-once is decided by the
    // fold, so losing here costs nothing, but not bothering the LLM is free.
    if (lifecycle(mirror, fact.id, foldOpts).state !== 'open') continue
    work.push(fact)
  }
  return work
}

/**
 * Create an unstarted patrol over one bus.
 * @param options.client - the bound ClientV2 shared with this DCU's tools, so
 *   the agent and the patrol read one stream through one mirror.
 * @param options.busUrl - bus base URL.
 * @param options.author - fact author for everything this DCU publishes.
 * @param options.interests - fact-type globs that wake the agent.
 * @param options.publishes - fact types this DCU emits, declared to the roster.
 * @param options.pollMs - poll interval (default 1000).
 * @param options.pageSize - read page size (default 500).
 * @param options.livenessTtlSec - how long one registration stays valid (default
 *   300). The slot is refreshed at half that, and only when nothing else has
 *   already proved this DCU alive. 0 registers once and never refreshes.
 * @param options.heartbeatSec - legacy `sys.heartbeat` interval, off by default.
 *   Turn it on only for a reader that folds heartbeats specifically (ant's
 *   identity-conflict watchdog); the TTL slot covers ordinary liveness.
 * @param options.claimTimeout - claim-expiry Δ in seconds for this DCU's folds.
 * @param options.log - diagnostic sink.
 * @param options.onWork - called with selected facts; MUST return promptly.
 * @returns the patrol handle.
 */
export function createPatrol(options) {
  const {
    client,
    busUrl,
    author,
    interests = [],
    publishes = [],
    pollMs = 1000,
    pageSize = 500,
    livenessTtlSec = 300,
    heartbeatSec = 0,
    claimTimeout,
    log = () => {},
    onWork = () => {},
  } = options

  const foldOpts = typeof claimTimeout === 'number' && claimTimeout > 0
    ? { claimTimeout }
    : undefined

  // Boot token: minted per start, never part of the author. It rides in the
  // registration payload so readers can FOLD OUT a double-started identity
  // (two live tokens under one author) instead of the bus having to forbid it.
  const instance = randomInstance()
  const heartbeatMs = heartbeatSec * 1000
  const subject = livenessSubject(author)
  // Refresh at half the TTL so one lost refresh is not a false death.
  const refreshMs = livenessTtlSec > 0 ? (livenessTtlSec * 1000) / 2 : 0

  let cursor = 0
  let mirror = []
  let stopping = false
  let down = false
  let announced = false
  let lastBeat = 0
  let beatN = 0
  // Anything this DCU appends is proof it is alive, so ordinary work resets the
  // refresh clock: a busy DCU writes NO liveness facts at all, and an idle one
  // writes one per half-TTL.
  let lastProofAt = 0
  let running

  /**
   * Write this DCU's registration into its liveness slot: capabilities for the
   * §7 roster, plus the TTL that makes the entry expire instead of accumulate.
   * `refs.subject` puts it in a keyed group, so this write supersedes the
   * previous one and `POST /admin/rewrite` can reclaim it (§3.3).
   * @param reason - `register` on cold start, `refresh` when the TTL is halfway.
   */
  async function announce(reason) {
    await client.publish(
      SYS_REGISTRY,
      { interests, publishes, runtime: 'deepseek-harness', instance, ttl_sec: livenessTtlSec },
      { refs: { subject } },
    )
    lastProofAt = Date.now()
    if (reason === 'register') log(`registered — interests [${interests.join(', ')}], publishes [${publishes.join(', ')}], ttl ${livenessTtlSec}s`)
    else log(`liveness refreshed — ttl ${livenessTtlSec}s (previous registration superseded)`)
  }

  async function tick() {
    // Bus restart detection: head fell behind our cursor → the journal was
    // reset, so the mirror is fiction. Drop it and re-announce.
    const headRes = await fetch(`${busUrl.replace(/\/$/, '')}/facts/head`)
    if (!headRes.ok) throw new Error(`head → ${headRes.status}`)
    const { head_seq: headSeq } = await headRes.json()
    if (headSeq < cursor) {
      log(`bus restarted (head ${headSeq} < cursor ${cursor}) — resetting mirror`)
      cursor = 0
      mirror = []
      announced = false
    }

    const batch = []
    for (;;) {
      const page = await client.query({ since: cursor, limit: pageSize })
      if (page.length === 0) break
      for (const fact of page) {
        batch.push(fact)
        mirror.push(fact)
        if (fact.seq > cursor) cursor = fact.seq
      }
      if (page.length < pageSize) break
    }

    if (down) {
      log(`reconnected — cursor ${cursor}, mirror ${mirror.length} facts`)
      down = false
    }

    if (!announced) {
      announced = true
      await announce('register')
    }

    // Our own facts landing in the batch are proof of life — no separate
    // liveness write is owed while this DCU is visibly working.
    if (batch.some((fact) => fact.author === author)) lastProofAt = Date.now()

    // Renew the slot only when nothing else has vouched for us this half-TTL.
    // Riding the poll beat (rather than a timer) means a wedged loop correctly
    // stops renewing, and the slot expires on its own.
    if (refreshMs > 0 && Date.now() - lastProofAt >= refreshMs) {
      await announce('refresh')
    }

    // Legacy fixed-rate heartbeat, off unless a heartbeat-folding reader needs
    // it: nothing supersedes these, so every one of them is permanent.
    if (heartbeatMs > 0 && Date.now() - lastBeat >= heartbeatMs) {
      lastBeat = Date.now()
      await client.publish(SYS_HEARTBEAT, { instance, n: ++beatN })
    }

    if (batch.length === 0) return
    const work = selectWork(batch, mirror, { author, interests, foldOpts })
    if (work.length > 0) {
      log(`${work.length} fact(s) in scope: ${work.map((f) => f.type).join(', ')}`)
      onWork(work, { client, mirror })
    }
  }

  async function loop() {
    log(`patrol starting — bus ${busUrl}, author ${author}, poll ${pollMs}ms`)
    while (!stopping) {
      try {
        await tick()
      } catch (error) {
        if (stopping) break
        if (!down) {
          down = true
          log(`bus unreachable (${error instanceof Error ? error.message : String(error)}) — retrying every ${pollMs}ms`)
        }
      }
      if (stopping) break
      await sleep(pollMs)
    }
    log(`patrol stopped — cursor ${cursor}, mirror ${mirror.length} facts`)
  }

  return {
    client,
    /** Start the loop; idempotent. */
    start() {
      running ??= loop()
      return running
    },
    /** Stop after the in-flight tick and await the loop's exit. */
    async stop() {
      stopping = true
      await running?.catch(() => {})
    },
    /** Diagnostics only. */
    state() {
      return {
        cursor,
        mirrored: mirror.length,
        down,
        instance,
        beats: beatN,
        livenessAgeSec: lastProofAt === 0 ? null : Math.round((Date.now() - lastProofAt) / 1000),
      }
    },
  }
}

/** A boot token that does not require importing node:crypto types into config. */
function randomInstance() {
  return globalThis.crypto?.randomUUID?.() ?? `boot-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}
