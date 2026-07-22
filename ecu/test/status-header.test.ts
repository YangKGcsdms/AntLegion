import { describe, it, expect } from "vitest";
import { extractStatusHeader } from "../src/dcus/ingestor-req.js";

describe("extractStatusHeader", () => {
  it("extracts a full-width colon status header", () => {
    const md = "# 方案\n\n状态：方案待评审（只出文档）\n\n## 背景\n";
    expect(extractStatusHeader(md)).toBe("方案待评审（只出文档）");
  });

  it("extracts a half-width colon status header", () => {
    expect(extractStatusHeader("状态: 开发中\n")).toBe("开发中");
  });

  it("returns null when there is no status header", () => {
    expect(extractStatusHeader("# 报告\n\n没有状态头。\n")).toBeNull();
  });

  it("returns null when the header is beyond the first 30 lines", () => {
    const md = Array.from({ length: 35 }, (_, i) => `line ${i}`).join("\n") + "\n状态：太靠后\n";
    expect(extractStatusHeader(md)).toBeNull();
  });

  it("respects a custom maxLines", () => {
    const md = "a\nb\n状态：深\n";
    expect(extractStatusHeader(md, 2)).toBeNull();
    expect(extractStatusHeader(md, 3)).toBe("深");
  });

  it("returns null for an empty status value", () => {
    expect(extractStatusHeader("状态：\n状态：\n")).toBeNull();
  });

  it("takes the first matching line", () => {
    expect(extractStatusHeader("状态：第一\n状态：第二\n")).toBe("第一");
  });

  it("does not match 状态 embedded in prose or tables", () => {
    expect(extractStatusHeader("| 状态 | 说明 |\n正文提到状态：x\n")).toBeNull();
  });
});
