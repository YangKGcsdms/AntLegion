#!/usr/bin/env python3
"""Cross-language conformance check (PROTOCOL.md §4).

An INDEPENDENT Python reimplementation of canonicalization + content-hash, run
against the committed vectors.json. It shares no code with the TypeScript
reference implementation — its only contract is PROTOCOL.md §4. If it reproduces
every committed `canonical` string and `id` byte-for-byte, the vector set is a
real cross-language interop contract, not prose.

    python3 conformance/verify.py        # exit 0 = all vectors reproduced

This is the §4 hash layer (the cross-language hazard: key sorting + the
Python-float rendering of `ts`). The §3 reader folds are exercised by the TS
suite; porting them is the next-language task, and every fact id used by those
fold vectors is verified here too.
"""
import json
import hashlib
import os
import sys

FLOAT_KEYS = {"ts"}  # §4: top-level fields rendered as a float (trailing .0 when whole)


def ser(value, key=None):
    """Faithful port of canonical.stableJsonStringify's serializer."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):  # bool already handled above
        if key in FLOAT_KEYS and float(value).is_integer():
            return "%.1f" % float(value)
        if isinstance(value, float) and value.is_integer():
            return str(int(value))  # JS String(100.0) === "100"
        return repr(value) if isinstance(value, float) else str(value)
    if isinstance(value, list):
        return "[" + ", ".join(ser(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = [json.dumps(k, ensure_ascii=False) + ": " + ser(value[k], k)
                 for k in sorted(value.keys())]
        return "{" + ", ".join(parts) + "}"
    raise TypeError(f"unserializable: {value!r}")


def canonical_record(inp):
    """Port of types.canonicalRecord: bus-assigned fields excluded; empty refs dropped."""
    rec = {"type": inp["type"], "author": inp["author"], "ts": inp["ts"],
           "payload": inp.get("payload") or {}}
    refs = {k: v for k, v in (inp.get("refs") or {}).items() if v is not None and v != ""}
    if refs:
        rec["refs"] = refs
    if inp.get("nonce"):
        rec["nonce"] = inp["nonce"]
    return rec


def compute_id(inp):
    return hashlib.sha256(ser(canonical_record(inp)).encode("utf-8")).hexdigest()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    vectors = json.load(open(os.path.join(here, "vectors.json"), encoding="utf-8"))

    failures = 0
    checked = 0

    # §4 hash vectors: canonical string + id
    for v in vectors["hash"]:
        canon = ser(canonical_record(v["input"]))
        cid = hashlib.sha256(canon.encode("utf-8")).hexdigest()
        checked += 1
        if canon != v["canonical"]:
            failures += 1
            print(f"FAIL canonical [{v['name']}]\n  py: {canon}\n  ref:{v['canonical']}")
        if cid != v["id"]:
            failures += 1
            print(f"FAIL id [{v['name']}]\n  py: {cid}\n  ref:{v['id']}")

    # every fold-stream fact id must also reproduce (the streams must be portably hashable)
    for group in vectors["folds"].values():
        for vec in group:
            for f in vec["stream"]:
                rid = compute_id({"type": f["type"], "author": f["author"], "ts": f["ts"],
                                  "payload": f.get("payload"), "refs": f.get("refs"),
                                  "nonce": f.get("nonce")})
                checked += 1
                if rid != f["id"]:
                    failures += 1
                    print(f"FAIL stream-id [{vec['name']}] {f['type']}\n  py: {rid}\n  ref:{f['id']}")

    print(f"\n{checked} ids checked, {failures} failures "
          f"(independent Python impl vs committed vectors)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
