import { describe, it, expect } from "vitest";
import { parseOawsEnv } from "../src/dcus/ingestor-req.js";

describe("parseOawsEnv", () => {
  it("parses quoted and unquoted KEY=value lines", () => {
    const env = parseOawsEnv([
      'REQ_NAME="薪资人数漏斗追踪"',
      "SLOT=3",
      'BRANCH="feature/salary-headcount-funnel"',
      "PORT_BACKEND=20031",
    ].join("\n"));
    expect(env).toEqual({
      REQ_NAME: "薪资人数漏斗追踪",
      SLOT: "3",
      BRANCH: "feature/salary-headcount-funnel",
      PORT_BACKEND: "20031",
    });
  });

  it("skips comments, blank lines and malformed lines", () => {
    const env = parseOawsEnv([
      "# a comment",
      "",
      "   ",
      "NO_EQUALS_SIGN",
      "=missing-key",
      "1BAD=key",
      "GOOD=value",
    ].join("\n"));
    expect(env).toEqual({ GOOD: "value" });
  });

  it("handles single quotes and values containing = signs", () => {
    const env = parseOawsEnv("A='x'\nB=a=b\n");
    expect(env.A).toBe("x");
    expect(env.B).toBe("a=b");
  });

  it("keeps unbalanced quotes as-is", () => {
    const env = parseOawsEnv('A="unterminated\n');
    expect(env.A).toBe('"unterminated');
  });

  it("handles CRLF line endings and surrounding whitespace", () => {
    const env = parseOawsEnv('  KEY = "v" \r\nNEXT=2\r\n');
    expect(env.KEY).toBe("v");
    expect(env.NEXT).toBe("2");
  });
});
