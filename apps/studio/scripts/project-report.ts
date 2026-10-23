import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseProject, sceneDurationMs, buildTimeline } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { renderSceneSvg, supportsNativeScene } from "./native-svg";
import { xml } from "./native-svg/text";

export interface ReportOptions { projectPath: string; out: string; video?: string; taskDir?: string }

function extractVideoStill(video: string, atSec: number, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-y", "-ss", String(atSec), "-i", video, "-frames:v", "1", outFile], { stdio: ["ignore", "ignore", "pipe"], shell: false });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
  });
}

/**
 * One self-contained HTML page that answers "这条片现在的状态如何":
 * scene stills, QA gates, lint/repair diffs, task journal — no app required.
 */
export async function generateReport(options: ReportOptions) {
  const projectPath = path.resolve(options.projectPath), projectDir = path.dirname(projectPath);
  const project = parseProject(JSON.parse(fs.readFileSync(projectPath, "utf8")));
  const theme = resolveTheme(project.theme), c = theme.colors;
  const read = (file: string | undefined) => { try { return file ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined; } catch { return undefined; } };
  const videoPath = options.video ? path.resolve(options.video) : undefined;
  const metrics = read(videoPath ? `${videoPath}.metrics.json` : undefined);
  const qa = read(videoPath ? `${videoPath}.qa.json` : undefined) ?? read(videoPath ? path.join(path.dirname(videoPath), `${project.id}.qa.json`) : undefined);
  const repair = read(path.join(projectDir, `${project.id}.repair.json`)) ?? read(videoPath ? `${videoPath}.qa-repair.json` : undefined);
  const journal = options.taskDir ? read(path.join(path.resolve(options.taskDir), "journal.json")) : undefined;
  const events = options.taskDir ? (() => { try { return fs.readFileSync(path.join(path.resolve(options.taskDir), "events.jsonl"), "utf8").trim().split("\n").slice(-12); } catch { return []; } })() : [];
  const fps = project.fps ?? 30;
  const timeline = buildTimeline(project);
  const stills = await Promise.all(project.scenes.map(async (scene, i) => {
    const durationMs = sceneDurationMs(scene);
    const entry = { id: scene.id, label: "heading" in scene ? scene.heading || scene.id : "title" in scene ? scene.title : scene.id, durationMs, notes: scene.notes, quiz: scene.quiz, image: "" };
    if (supportsNativeScene(scene)) {
      entry.image = `data:image/svg+xml;base64,${Buffer.from(renderSceneSvg(project, scene, Math.round(durationMs / 1000 * fps) - 1, { plate: true, previousScene: project.scenes[i - 1] })).toString("base64")}`;
    } else if (videoPath && fs.existsSync(videoPath)) {
      const still = path.join(projectDir, `.report-still-${scene.id}.png`);
      const at = (timeline.entries[i]!.startMs + durationMs / 2) / 1000;
      try { await extractVideoStill(videoPath, Number(at.toFixed(2)), still); entry.image = `data:image/png;base64,${fs.readFileSync(still).toString("base64")}`; } catch { entry.image = ""; }
      finally { fs.rmSync(still, { force: true }); }
    }
    return entry;
  }));
  const gate = (g: any) => `<li class="${g.level}">${g.id}: ${g.detail}</li>`;
  const section = (title: string, body: string) => body ? `<section><h2>${title}</h2>${body}</section>` : "";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>报告 · ${xml(project.title)}</title><style>
body{margin:0;background:${c.bg};color:${c.text};font:15px/1.6 ${theme.fonts.body};padding:32px;max-width:1100px;margin:auto}
h1{font-family:${theme.fonts.display}}h2{border-bottom:1px solid ${c.border};padding-bottom:8px}
img{max-width:100%;border:1px solid ${c.border};border-radius:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}
figure{margin:0}figcaption{color:${c.textMuted};font-size:13px;margin-top:6px}
li.green{color:#2e8b57}li.yellow{color:#b8860b}li.red{color:#c0392b}
pre{background:${c.surface};padding:12px;border-radius:8px;overflow:auto;font-size:12px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid ${c.border};padding:6px 10px;text-align:left}
</style></head><body><h1>${xml(project.title)}</h1><p>${project.scenes.length} 场景 · ${project.aspect} · ${fps}fps · 风格 ${typeof project.theme === "string" ? project.theme : "自定义"}</p>
${section("画面预览(每镜末帧/浏览器镜头取自成片中点)", `<div class="grid">${stills.map(s => `<figure><img src="${s.image || ""}" alt="${s.label}"><figcaption>${s.id} · ${Math.round(s.durationMs / 100) / 10}s${s.quiz ? " · 含理解检查" : ""}</figcaption></figure>`).join("")}</div>`)}
${section("QA 门禁", qa ? `<ul>${qa.gates.map(gate).join("")}</ul><p>总体: ${qa.verdict}(${qa.frames} 样帧)</p>` : "<p>未运行(用 glint qa 生成)</p>")}
${section("呈现修复记录", repair ? `<pre>${xml(JSON.stringify(repair, null, 2))}</pre>` : "<p>无自动修复记录</p>")}
${section("渲染耗时", metrics ? `<table><tr><th>阶段</th><th>毫秒</th></tr>${Object.entries(metrics.stages ?? {}).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}<tr><td>总计</td><td>${metrics.totalMs}</td></tr></table>` : "<p>未找到 metrics(请对成片保留 .metrics.json)</p>")}
${section("任务日志", journal ? `<p>已完成步骤:${Object.entries(journal.steps).filter(([, s]: any) => s.state === "completed").map(([id, s]: any) => `${id}(${s.attempts} 次)`).join(", ")}</p>${events.length ? `<pre>${xml(events.join("\n"))}</pre>` : ""}` : "<p>无任务计划记录</p>")}
</body></html>`;
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.writeFileSync(path.resolve(options.out), html);
  return { out: path.resolve(options.out), scenes: stills.length, qa: qa?.verdict ?? "not-run" };
}
