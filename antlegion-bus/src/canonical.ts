/**
 * Self-contained primitives for the fact bus: RFC 8785 canonical JSON (JCS)
 * and a glob matcher.
 *
 * PROTOCOL.md §4.1 fixes the content address at `sha256(JCS(record))`. v2.0
 * hand-rolled canonicalization and got it wrong in every direction that
 * matters — a Python-compatible float rule applied to exactly one key, every
 * other number left to the host formatter, and neither key ordering nor string
 * escaping specified at all. JCS specifies all of it, and JavaScript happens to
 * be the language it is specified *in*: `JSON.stringify` already emits ES
 * `Number::toString` for numbers and JCS's exact escaping for strings, and
 * `Array.prototype.sort` already compares by UTF-16 code unit. So JCS here is
 * "sort every object's keys, then stringify with no whitespace" — the work is
 * in the two things JSON.stringify would otherwise do silently and wrongly
 * (see the throws below).
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
 * RFC 8785 (JSON Canonicalization Scheme) serialization.
 *
 * Object keys are sorted by **UTF-16 code unit**, which is what `.sort()` does
 * and what JCS requires — note this differs from code-point order for non-BMP
 * keys, so a Python implementation MUST NOT use bare `sorted()` (§4.1).
 */
export function jcsStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Rebuild `value` with every object's keys in UTF-16 code-unit order, so that a
 * plain `JSON.stringify` of the result is canonical.
 *
 * Two things JSON.stringify does silently that JCS cannot tolerate are rejected
 * here instead: a non-finite number would become `null` (§1.1 rejects those at
 * append, so reaching this is a bug, not user input), and an `undefined` value
 * would make its key vanish — changing the record's shape without changing its
 * source. Both would produce an id that no second implementation could predict.
 */
function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) {
    throw new TypeError("JCS: undefined is not representable");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`JCS: non-finite number (${value}) is not representable`);
    }
    return value;
  }
  if (typeof value === "bigint") {
    throw new TypeError("JCS: bigint is not representable");
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value; // string | boolean
}
