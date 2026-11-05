/** Rebuildable operator projection. Does not participate in protocol decisions. */
import { colony, SYS_REGISTRY } from "./fold.js";
import type { Fact } from "./types.js";

export const ACTIVITY_WINDOW_SEC = 120;

export class BusObservations {
  private offset = 0;
  private readonly registrations = new Map<string, Fact>();
  private readonly authors = new Map<string, { count: number; first: Fact; last: Fact; heartbeat?: Fact }>();

  snapshot(stream: readonly Fact[], now = Date.now() / 1000) {
    // This instance belongs to one BusV2 lifetime. The full journal, including
    // registrations outside a console's visible window, is indexed once.
    for (; this.offset < stream.length; this.offset++) {
      const fact = stream[this.offset];
      const row = this.authors.get(fact.author) ?? { count: 0, first: fact, last: fact };
      row.count++;
      row.last = fact;
      if (fact.type === "sys.heartbeat") row.heartbeat = fact;
      this.authors.set(fact.author, row);
      if (fact.type === SYS_REGISTRY) this.registrations.set(fact.author, fact);
    }
    // Retain references to the journal objects: payload compaction must also
    // be reflected here. Capability parsing stays identical to the reader fold.
    const registered = new Map(colony([...this.registrations.values()]).map((r) => [r.author, r]));
    const agents = [...this.authors].map(([author, row]) => {
      const registration = registered.get(author);
      const age = Math.max(0, now - row.last.recv);
      return {
        author,
        registered: !!registration,
        interests: registration?.interests ?? [],
        publishes: registration?.publishes ?? [],
        registration_id: registration?.fact.id ?? null,
        first_seen: row.first.recv,
        last_seen: row.last.recv,
        last_heartbeat: row.heartbeat?.recv ?? null,
        last_fact_id: row.last.id,
        last_type: row.last.type,
        fact_count: row.count,
        activity: age <= ACTIVITY_WINDOW_SEC ? "recent" : "quiet",
      };
    }).sort((a, b) => b.last_seen - a.last_seen || a.author.localeCompare(b.author));
    return {
      observed_at: now,
      activity_window_sec: ACTIVITY_WINDOW_SEC,
      counts: {
        authors: agents.length,
        registered: registered.size,
        recently_active: agents.filter((a) => a.activity === "recent").length,
      },
      agents,
    };
  }
}
