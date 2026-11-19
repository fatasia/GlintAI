import { describe, expect, it } from "vitest";
import { chartScenesFromTable } from "./chart-table";
import { parseProject } from "@glintai/scenescript";

const csv = (text: string) => {
  const r = chartScenesFromTable(text);
  const project = parseProject({ schemaVersion: 1, id: "t", title: "t", aspect: "16:9", knowledgeSources: [], scenes: r.scenes });
  return { ...r, scenes: project.scenes };
};

describe("CSV → chart scenes, zero configuration", () => {
  it("auto-picks bar for one short series and keeps facts editable", () => {
    const result = csv("月份,销售额\n一月,120\n二月,150\n三月,180");
    expect(result.scenes).toHaveLength(1);
    const scene = result.scenes[0]!;
    if (scene.kind !== "chart") throw new Error("Expected chart scene");
    expect(scene.chartType).toBe("bar");
    expect(scene.data[0]).toEqual({ label: "一月", value: 120 });
    expect(scene.data).toHaveLength(3);
    expect(result.series).toEqual(["销售额"]);
  });
  it("auto-picks line for long series and combo for two series", () => {
    const long = csv("月份,用户数\n" + Array.from({ length: 10 }, (_, i) => `M${i},${i * 10}`).join("\n"));
    expect(long.scenes[0]!.kind === "chart" && long.scenes[0]!.chartType).toBe("line");
    const combo = csv("季度,收入,增速\nQ1,10,5\nQ2,20,8");
    expect(combo.scenes[0]!.kind === "chart" && combo.scenes[0]!.chartType).toBe("combo");
    if (combo.scenes[0]!.kind === "chart") expect(combo.scenes[0]!.seriesLabel2).toBe("增速");
  });
  it("splits many series into labeled scenes with a warning", () => {
    const result = csv("地区,a,b,c\n东,1,2,3\n西,4,5,6");
    expect(result.scenes).toHaveLength(3); expect(result.warnings.join()).toContain("3 个数值列");
    expect(result.scenes.map(s => s.id)).toEqual(["chart", "chart-2", "chart-3"]);
  });
  it("handles tab delimiters, quoted cells and truncation", () => {
    const tab = csv("品类\t数量\n\"手机, 5G\"\t10\n耳机\t20");
    if (tab.scenes[0]!.kind !== "chart") throw new Error("Expected chart scene");
    expect(tab.scenes[0]!.data[0]!.label).toBe("手机, 5G");
    const big = csv("月份,值\n" + Array.from({ length: 30 }, (_, i) => `M${i},${i}`).join("\n"));
    if (big.scenes[0]!.kind !== "chart") throw new Error("Expected chart scene");
    expect(big.scenes[0]!.data).toHaveLength(24); expect(big.warnings.join()).toContain("截断");
  });
  it("reports every lossy table conversion and keeps full source untouched", () => {
    const label = "长标签".repeat(10), series = "系列名称".repeat(5);
    const source = `名称,一,${series},三,四,五,六,七\n${label},1,2,3,4,5,6,7`;
    const result = csv(source);
    expect(result.warnings.join(" ")).toContain("标签超过 24");
    expect(result.warnings.join(" ")).toContain("系列名称超过 16");
    expect(result.warnings.join(" ")).toContain("1 列未用于图表");
    expect(result.scenes).toHaveLength(6);
    expect(result.scenes[0]!.kind === "chart" && result.scenes[0]!.data[0]!.label).toBe(label.slice(0, 24));
    expect(source).toContain(label);
  });
  it("throws actionable errors on single-column and broken tables", () => {
    expect(() => csv("只有一列\n没有数字")).toThrow(/数值列/);
    expect(() => csv("a,b\n1")).toThrow(/数值列|数据行/);
    expect(() => csv("label,value\n甲,不是数字")).toThrow(/数值列/);
  });
  it("rejects out-of-range numbers before creating scenes, including secondary and truncated rows", () => {
    expect(() => csv("项目,数量\nA,1000000000001")).toThrow(/超出图表范围/);
    expect(() => csv("项目,数量,利润\nA,1,-1000000000001")).toThrow(/利润.*超出图表范围/);
    expect(() => csv("项目,数量\n" + Array.from({ length: 24 }, (_, i) => `行${i},1`).join("\n") + "\n末行,1000000000001")).toThrow(/超出图表范围/);
    expect(csv("项目,数量\nA,-1000000000000\nB,1000000000000").scenes).toHaveLength(1);
  });
  it("reads CSV quoting, BOM, escaped quotes and embedded newlines", () => {
    const result = csv('\uFEFF品类,数量\r\n"手机,\"\"旗舰\"\"",10\r\n"跨\n行",20');
    expect(result.scenes[0]!.kind === "chart" && result.scenes[0]!.data[0]!.label).toBe('手机,"旗舰"');
    expect(() => csv('a,b\n"未闭合,2')).toThrow("引号未闭合");
  });
  it("recognizes calendar dates, sorts chronologically and does not coerce missing values to zero", () => {
    const result = csv("日期,销售额\n2026-03-01,30\n2026-01-01,10\n2026-02-01,20");
    expect(result.scenes[0]!.kind === "chart" && result.scenes[0]!.chartType).toBe("line");
    expect(result.scenes[0]!.kind === "chart" && result.scenes[0]!.data.map(d => d.value)).toEqual([10, 20, 30]);
    expect(result.warnings.join()).toContain("日期列");
    expect(() => csv("label,value,other\nA,10,2\nB,,3")).toThrow("空值");
    expect(() => csv("label,value,other\nA,10,2\nB,12,no")).toThrow("无法解析");
  });
});
