/**
 * Self-contained primitives for the v2 fact bus: canonical JSON serialization
 * (Python-`json.dumps(sort_keys=True)` compatible) and a glob matcher.
 *
 * These were the only two things v2 borrowed from the v1 engine; vendored here
 * so v2 stands alone as the single architecture.
 */

/** Simple glob matcher: `*` = any substring, `?` = one character. */
export function globMatch(pattern: string, text: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return regex.test(text);
}

/**
 * JSON.stringify with recursively sorted keys, matching Python's
 * json.dumps(sort_keys=True, ensure_ascii=False). `floatKeys` names top-level
 * fields that must render with a trailing `.0` when whole (Python float vs int).
 */
export function stableJsonStringify(obj: unknown, floatKeys?: ReadonlySet<string>): string {
  return jsonSerialize(sortKeys(obj), floatKeys);
}

function jsonSerialize(value: unknown, floatKeys?: ReadonlySet<string>): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => jsonSerialize(v, floatKeys)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const serialized =
        floatKeys?.has(k) && typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)
          ? v.toFixed(1)
          : jsonSerialize(v, floatKeys);
      entries.push(`${JSON.stringify(k)}: ${serialized}`);
    }
    return `{${entries.join(", ")}}`;
  }
  return String(value);
}

function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
