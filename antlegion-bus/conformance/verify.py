#!/usr/bin/env python3
"""Cross-language conformance check (PROTOCOL.md §9).

An INDEPENDENT Python reimplementation of the parts of the protocol a second
implementation has to get right, run against the committed vectors.json. It
shares no code with the TypeScript reference implementation — its only contract
is PROTOCOL.md. If it reproduces every committed value byte-for-byte, the vector
set is a real cross-language interop contract rather than prose.

    python3 conformance/verify.py        # exit 0 = everything reproduced

Two layers, and §9.1 requires both:

  §4  canonicalization (RFC 8785 JCS) and the content address. The hazards here
      are ECMAScript number formatting and UTF-16 key ordering, neither of which
      Python does natively — see js_number() and sort_key() below.

  §3  the normative reader folds. "A verifier that reproduces every id while
      checking no fold result gives no evidence about §3, which is where all the
      meaning is." Every fold below is written from the spec text, not ported
      from the TypeScript.
"""
import hashlib
import json
import math
import os
import sys

# ─────────────────────────── §4.1  RFC 8785 (JCS) ────────────────────────────


def js_number(x):
    """A number rendered as ECMAScript `Number::toString` renders it (§4.1).

    Python's repr already gives the shortest round-tripping digits, but it
    switches to exponential notation at different thresholds than ECMAScript
    (< 1e-4 / >= 1e16 rather than < 1e-6 / >= 1e21), so the digits have to be
    re-laid-out by hand. The spec's own formulation is used directly: find the
    integers s (digits), k (how many) and n (where the decimal point goes) with
    s x 10^(n-k) == m, then pick a layout from n and k.
    """
    if isinstance(x, bool):
        raise TypeError("bool is not a number")
    f = float(x)
    if math.isnan(f) or math.isinf(f):
        raise ValueError("non-finite numbers are not JCS-representable (§1.1 rejects them)")
    if f == 0:
        return "0"                       # covers -0.0, which JCS renders as 0
    sign = "-" if f < 0 else ""
    r = repr(abs(f))

    if "e" in r:
        mant, _, exp_s = r.partition("e")
        exp = int(exp_s)
    else:
        mant, exp = r, 0
    int_part, _, frac_part = mant.partition(".")

    all_digits = int_part + frac_part
    lead = len(all_digits) - len(all_digits.lstrip("0"))
    s = all_digits[lead:].rstrip("0") or "0"
    n = len(int_part) + exp - lead
    k = len(s)

    if k <= n <= 21:
        return sign + s + "0" * (n - k)
    if 0 < n <= 21:
        return sign + s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + s
    e = n - 1
    esign = "+" if e >= 0 else "-"
    head = s if k == 1 else s[0] + "." + s[1:]
    return sign + head + "e" + esign + str(abs(e))


_SHORT_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f",
                  "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def js_string(s):
    """A JSON string escaped the way JCS requires.

    json.dumps(ensure_ascii=False) is close but emits a lone surrogate as a raw
    character, which is then not encodable as UTF-8 at all. JCS (and ECMAScript's
    well-formed JSON.stringify) escapes it as \\udXXX instead.
    """
    out = ['"']
    for ch in s:
        cp = ord(ch)
        if ch in _SHORT_ESCAPES:
            out.append(_SHORT_ESCAPES[ch])
        elif cp < 0x20 or 0xD800 <= cp <= 0xDFFF:
            out.append("\\u%04x" % cp)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def sort_key(k):
    """Order object keys by UTF-16 code unit, as JCS requires.

    Bare sorted() orders by code point and gives a different answer for non-BMP
    keys: U+1F600 is one code point above U+FF3A, but its UTF-16 high surrogate
    (0xD83D) is below it. Comparing big-endian UTF-16 bytes reproduces the
    code-unit order exactly.
    """
    return k.encode("utf-16-be", "surrogatepass")


def jcs(value):
    """Serialize `value` per RFC 8785: sorted keys, no whitespace."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return js_string(value)
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, list):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            js_string(k) + ":" + jcs(value[k])
            for k in sorted(value.keys(), key=sort_key)
        ) + "}"
    raise TypeError("unserializable: %r" % (value,))


def canonical_record(inp):
    """The hashed record (§4.1): author-supplied fields only, no normalization."""
    rec = {"type": inp["type"], "author": inp["author"], "ts": inp["ts"],
           "payload": inp.get("payload") or {}}
    refs = inp.get("refs") or {}
    if refs:
        rec["refs"] = dict(refs)
    if inp.get("nonce") is not None:
        rec["nonce"] = inp["nonce"]
    return rec


def compute_id(inp):
    return hashlib.sha256(jcs(canonical_record(inp)).encode("utf-8")).hexdigest()


# ────────────────────────────── §3  reader folds ─────────────────────────────

TOMBSTONE = "_.tombstone"
VOTE = "_.vote"
RESERVED_NAMESPACES = ("_.", "sys.", "context.")
VERDICTS = ("corroborate", "contradict")


def is_reserved(t):
    return any(t.startswith(p) for p in RESERVED_NAMESPACES)


def refs_of(f):
    return f.get("refs") or {}


def retracted(stream, x):
    """§5.3 retraction: a tombstone naming x, from x's OWN author."""
    return any(t["type"] == TOMBSTONE
               and refs_of(t).get("tombstones") == x["id"]
               and t["author"] == x["author"]
               for t in stream)


def find(stream, fid):
    for f in stream:
        if f["id"] == fid:
            return f
    return None


def history(stream, subject):
    """§3.1 the register: subject members, reserved namespaces excluded."""
    return sorted((f for f in stream
                   if refs_of(f).get("subject") == subject and not is_reserved(f["type"])),
                  key=lambda f: f["seq"])


def current(stream, subject):
    """§3.1: the highest-seq member, or None if its author retracted it."""
    group = history(stream, subject)
    if not group:
        return None
    head = group[-1]
    return None if retracted(stream, head) else head


def superseded_by(stream, fid):
    """§3.1: the IMMEDIATE successor — lowest seq of the authorized candidates."""
    target = find(stream, fid)
    if target is None or retracted(stream, target):
        return None
    explicit = [x for x in stream
                if refs_of(x).get("supersedes") == fid
                and x["author"] == target["author"]
                and not retracted(stream, x)]
    subject = refs_of(target).get("subject")
    nxt = [x for x in history(stream, subject)
           if x["seq"] > target["seq"] and not retracted(stream, x)] if subject else []
    candidates = {x["id"]: x for x in explicit + nxt}
    if not candidates:
        return None
    return min(candidates.values(), key=lambda f: f["seq"])["id"]


def chain(stream, fid):
    """§3.2: root->F, with an explicit gap marker for an unresolved ancestor."""
    by_id = {f["id"]: f for f in stream}
    out, seen = [], set()
    cur = by_id.get(fid)
    while cur is not None and cur["id"] not in seen:
        out.append(cur["id"])
        seen.add(cur["id"])
        parent_id = refs_of(cur).get("parent")
        if not parent_id:
            break
        parent = by_id.get(parent_id)
        if parent is None:
            out.append({"gap": True, "missing": parent_id})
            break
        cur = parent
    out.reverse()
    return out


def descendants(stream, fid):
    """§3.2 forward: every fact whose parent chain reaches F, F excluded."""
    children = {}
    for x in stream:
        p = refs_of(x).get("parent")
        if p:
            children.setdefault(p, []).append(x)
    out, seen, queue = [], {fid}, [fid]
    while queue:
        cur = queue.pop(0)
        for c in children.get(cur, []):
            if c["id"] in seen:
                continue
            seen.add(c["id"])
            out.append(c)
            queue.append(c["id"])
    return [f["id"] for f in sorted(out, key=lambda f: f["seq"])]


def trust(stream, fid, quorum):
    """§3.3: retracted > superseded > votes; latest vote per author; junk excluded."""
    if not isinstance(quorum, int) or quorum < 1:
        raise ValueError("quorum MUST be an integer >= 1")
    target = find(stream, fid)
    if target is None:
        raise ValueError("target not in prefix; a trust result MUST NOT be returned")
    if retracted(stream, target):
        return "retracted"
    if superseded_by(stream, fid) is not None:
        return "superseded"

    latest = {}
    for v in sorted((x for x in stream
                     if x["type"] == VOTE and refs_of(x).get("vote") == fid),
                    key=lambda f: f["seq"]):
        if v["author"] == target["author"]:
            continue
        if (v.get("payload") or {}).get("verdict") not in VERDICTS:
            continue
        if retracted(stream, v):
            continue
        latest[v["author"]] = v

    c = sum(1 for v in latest.values() if v["payload"]["verdict"] == "corroborate")
    x = len(latest) - c
    if x >= quorum:
        return "refuted"
    if x > 0:
        return "contested"
    if c >= quorum:
        return "consensus"
    if c > 0:
        return "corroborated"
    return "asserted"


def ownership(stream, fid, now, delta):
    """§3.4: recv-anchored deterministic expiry; resolved/dead terminal."""
    target = find(stream, fid)
    relevant = sorted(
        (f for f in stream
         if refs_of(f).get("claim_of") == fid
         or refs_of(f).get("resolves") == fid
         or refs_of(f).get("release_of") == fid
         or (f["type"] == TOMBSTONE and refs_of(f).get("tombstones") == fid)),
        key=lambda f: f["seq"])

    active = []
    for fact in relevant:
        if fact["type"] == TOMBSTONE:
            if target is not None and fact["author"] == target["author"]:
                return {"state": "dead", "owner": None}
            continue
        active = [c for c in active if fact["recv"] <= c["recv"] + delta]
        r = refs_of(fact)
        if r.get("claim_of") == fid:
            active.append({"author": fact["author"], "seq": fact["seq"], "recv": fact["recv"]})
        elif r.get("release_of") == fid:
            if any(c["author"] == fact["author"] for c in active):
                active = [c for c in active if c["author"] != fact["author"]]
        elif r.get("resolves") == fid:
            owner = min(active, key=lambda c: c["seq"]) if active else None
            if owner is not None and fact["author"] == owner["author"]:
                return {"state": "resolved", "owner": owner["author"]}

    active = [c for c in active if now <= c["recv"] + delta]
    if not active:
        return {"state": "open", "owner": None}
    return {"state": "claimed", "owner": min(active, key=lambda c: c["seq"])["author"]}


def claim_winner(stream, fid, now, delta):
    o = ownership(stream, fid, now, delta)
    return o["owner"] if o["state"] in ("claimed", "resolved") else None


# ───────────────────────────────── the runner ────────────────────────────────


class Checker:
    def __init__(self):
        self.checked = 0
        self.failures = 0

    def eq(self, label, got, want):
        self.checked += 1
        if got != want:
            self.failures += 1
            print("FAIL %s\n  py : %r\n  ref: %r" % (label, got, want))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "vectors.json"), encoding="utf-8") as fh:
        vectors = json.load(fh)

    if vectors.get("version") != "3.0":
        print("FAIL vector set is version %r, this verifier implements 3.0" % vectors.get("version"))
        sys.exit(1)

    ck = Checker()
    delta = vectors["defaults"]["claimTimeout"]

    # ── §4: canonical string + content address ──
    for v in vectors["hash"]:
        canon = jcs(canonical_record(v["input"]))
        ck.eq("canonical [%s]" % v["name"], canon, v["canonical"])
        ck.eq("id [%s]" % v["name"], hashlib.sha256(canon.encode("utf-8")).hexdigest(), v["id"])

    # ── every fact in every fold stream must hash portably too ──
    for group in vectors["folds"].values():
        for vec in group:
            for f in vec["stream"]:
                ck.eq("stream-id [%s] %s" % (vec["name"], f["type"]), compute_id(f), f["id"])

    # ── §3.4 ownership ──
    for vec in vectors["folds"]["lifecycle"]:
        opts = vec["opts"]
        d = opts.get("claimTimeout", delta)
        now = opts["now"]
        ck.eq("lifecycle [%s]" % vec["name"], ownership(vec["stream"], vec["target"], now, d), vec["expect"])
        ck.eq("claimWinner [%s]" % vec["name"], claim_winner(vec["stream"], vec["target"], now, d), vec["claimWinner"])

    # ── §3.3 trust ──
    for vec in vectors["folds"]["trust"]:
        ck.eq("trust [%s]" % vec["name"], trust(vec["stream"], vec["target"], vec["quorum"]), vec["expect"])

    # ── §3.1 the register ──
    for vec in vectors["folds"]["register"]:
        s, subj, tgt = vec["stream"], vec["subject"], vec["target"]
        ck.eq("history [%s]" % vec["name"], [f["id"] for f in history(s, subj)], vec["history"])
        cur = current(s, subj)
        ck.eq("current [%s]" % vec["name"], cur["id"] if cur else None, vec["current"])
        ck.eq("supersededBy [%s]" % vec["name"], superseded_by(s, tgt), vec["supersededBy"])
        ck.eq("isSuperseded [%s]" % vec["name"], superseded_by(s, tgt) is not None, vec["isSuperseded"])

    # ── §3.2 the trail ──
    for vec in vectors["folds"]["trail"]:
        s, tgt = vec["stream"], vec["target"]
        ck.eq("chain [%s]" % vec["name"], chain(s, tgt), vec["chain"])
        ck.eq("descendants [%s]" % vec["name"], descendants(s, tgt), vec["descendants"])

    print("\n%d assertions checked, %d failures "
          "(independent Python impl vs committed vectors)" % (ck.checked, ck.failures))
    sys.exit(1 if ck.failures else 0)


if __name__ == "__main__":
    main()
