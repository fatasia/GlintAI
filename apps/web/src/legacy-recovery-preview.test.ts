import { expect, it } from "vitest";
import { legacyRecordSummary } from "./legacy-recovery-preview";
it("previews project, document and generation records without executing HTML",()=>{
 expect(legacyRecordSummary(null)).toBe("无记录");
 expect(legacyRecordSummary(JSON.stringify([{name:"旧作品"},{title:"另一稿"}]))).toBe("2 项 · 旧作品、另一稿");
 expect(legacyRecordSummary(JSON.stringify({project:{title:"当前工作"}}))).toBe("当前工作");
 expect(legacyRecordSummary(JSON.stringify({documents:[{title:"<script>evil()</script>"}]}))).toContain("<script>");
 expect(legacyRecordSummary("dark")).toBe("深色主题");
 expect(legacyRecordSummary("broken")).toContain("无法解析");
});
it("limits labels and ignores malformed label types",()=>{
 expect(legacyRecordSummary(JSON.stringify(Array.from({length:20},()=>({name:"x".repeat(1000)}))))).toBe(`20 项 · ${Array(4).fill("x".repeat(60)).join("、")}…`);
 expect(legacyRecordSummary(JSON.stringify([{name:{html:"unsafe"}}]))).toBe("1 项");
});
