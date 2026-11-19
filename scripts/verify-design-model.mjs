/** Opt-in paid-provider acceptance. Run with server-side GLINT_LLM_* and an external output directory. */
import fs from "node:fs/promises";
import path from "node:path";
import { llmFromEnvironment } from "../packages/llm/src/index.ts";
import { proposeArtifact } from "../apps/web/server/artifact-proposal.mjs";

const out = process.env.GLINT_DESIGN_MODEL_OUT;
if (!out || !path.isAbsolute(out)) throw new Error("Set an absolute GLINT_DESIGN_MODEL_OUT");
await fs.mkdir(out, { recursive: true });
const provider = llmFromEnvironment();
const report = { model: process.env.GLINT_LLM_MODEL, startedAt: new Date().toISOString(), results: [] };
const cases = [
  { id: "page", kind: "page", instruction: "设计一个中文独立书店的预约页面，含营业时间、三场活动与预约表单，克制的纸白底深绿文字，桌面与390px手机都能使用。不要虚构真实店铺或使用外部素材。" },
  { id: "wireframe", kind: "prototype", instruction: "生成一个播客应用的低保真线框图，包含搜索、节目列表、订阅按钮和播放器，使用黑白灰，不使用装饰图和外部素材。390px与1280px均不横向溢出。" },
  { id: "slides", kind: "slides", instruction: "生成一页1280x720中文幻灯片：主题为社区图书交换，包含问题、解决方式和下一步三个清晰部分。资料：读完的书闲置；邻居可在周末带书交换；先试办一次活动再收集反馈。不要编造统计。附80字以内演讲备注。" },
];
if(process.env.GLINT_TEST_REFERENCE_IMAGE){
  const bytes=await fs.readFile(process.env.GLINT_TEST_REFERENCE_IMAGE);
  cases.push({id:"reference",kind:"page",instruction:"参考所附截图的版式和内容层次，重新设计一个可编辑的书店预约页面。保留营业时间、三场活动和表单结构；改用浅蓝底与深蓝文字。所有布局使用响应式 CSS，不嵌入整张截图，不依赖外部图片。",referenceImage:{mimeType:"image/png",data:bytes.toString("base64")}});
}
const selected=process.env.GLINT_DESIGN_MODEL_CASES?.split(",")??cases.map(item=>item.id);
if(selected.some(id=>!cases.some(item=>item.id===id)))throw new Error("Unknown model acceptance case");
for (const item of cases.filter(item=>selected.includes(item.id))) {
  const started = performance.now();
  const document = { id: `live-${item.id}`, kind: item.kind, title: "真实模型验收", updatedAt: 0, activePageId: "page-1", pages: [{ id: "page-1", title: "首页", html: "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>" }] };
  try {
    const result = await proposeArtifact({ document, instruction: item.instruction, ...(item.referenceImage?{referenceImage:item.referenceImage}:{}) }, { chat: async request => {
      const response = await provider.chat(request);
      await fs.writeFile(path.join(out, `${item.id}.response.txt`), response.text);
      return response;
    } });
    await fs.writeFile(path.join(out, `${item.id}.json`), JSON.stringify(result, null, 2));
    await fs.writeFile(path.join(out, `${item.id}.html`), result.document.pages[0].html);
    report.results.push({ id: item.id, validated: true, elapsedMs: performance.now() - started });
  } catch (error) {
    const detail = String(error).replaceAll(process.env.GLINT_LLM_API_KEY, "[redacted]");
    report.results.push({ id: item.id, validated: false, elapsedMs: performance.now() - started, error: detail.slice(0, 600) });
  }
  await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
if (report.results.some(result => !result.validated)) process.exitCode = 1;
