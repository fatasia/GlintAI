import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SceneScriptProject } from "@glintai/scenescript";
import { xml } from "./native-svg/text";

export interface LearningRecord {
  format: "glint-understanding"; version: 1; projectId: string; revision: string; variant: string; sessionId: string; exportedAt: string;
  quizzes: { sceneId: string; question: string; options: string[]; answerIndex: number }[];
  attempts: { sceneId: string; answer: number; at: string }[];
}
export function parseLearningRecord(value: unknown): LearningRecord {
  const r = value as LearningRecord;
  if (r?.format !== "glint-understanding" || r.version !== 1 || [r.projectId, r.revision, r.variant, r.sessionId].some(v => typeof v !== "string" || !v || v.length > 160) || !Number.isFinite(Date.parse(r.exportedAt)) || !Array.isArray(r.quizzes) || r.quizzes.length > 1000 || !Array.isArray(r.attempts) || r.attempts.length > 10000) throw new Error("Invalid learning record");
  const ids = new Set<string>();
  for (const q of r.quizzes) {
    if (!q || typeof q.sceneId !== "string" || ids.has(q.sceneId) || typeof q.question !== "string" || q.question.length > 500 || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6 || q.options.some(o => typeof o !== "string" || !o || o.length > 300) || !Number.isInteger(q.answerIndex) || !q.options[q.answerIndex]) throw new Error("Invalid quiz in learning record");
    ids.add(q.sceneId);
  }
  for (const a of r.attempts) {
    const q = r.quizzes.find(q => q.sceneId === a.sceneId);
    if (!q || !Number.isInteger(a.answer) || a.answer < 0 || a.answer >= q.options.length || !Number.isFinite(Date.parse(a.at))) throw new Error("Invalid attempt in learning record");
  }
  return r;
}
export function learningRecords(source: string): LearningRecord[] {
  const root = path.resolve(source), files = fs.statSync(root).isDirectory() ? fs.readdirSync(root).filter(f => f.endsWith(".learning.json")).sort().map(f => path.join(root, f)) : [root];
  if (!files.length || files.length > 10000) throw new Error("没有 .learning.json 学习记录，或记录超过 10000 份");
  return files.map(file => { if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error("Learning record exceeds 5 MiB"); return parseLearningRecord(JSON.parse(fs.readFileSync(file, "utf8"))); });
}
const quizDigest = (q: LearningRecord["quizzes"][number]) => createHash("sha256").update(JSON.stringify([q.question, q.options, q.answerIndex])).digest("hex").slice(0, 16);

export function aggregateLearning(values: unknown[], projectId?: string) {
  const sessions = new Map<string, LearningRecord>();
  for (const value of values) {
    const r = parseLearningRecord(value); if (projectId && r.projectId !== projectId) throw new Error(`学习记录属于其它项目:${r.projectId}`);
    const key = JSON.stringify([r.projectId, r.revision, r.variant, r.sessionId]), previous = sessions.get(key);
    if (!previous || Date.parse(r.exportedAt) > Date.parse(previous.exportedAt)) sessions.set(key, r);
  }
  const groups = new Map<string, { projectId: string; revision: string; variant: string; sceneId: string; question: string; quizDigest: string; eligible: number; answered: number; firstCorrect: number; latestCorrect: number; attempts: number }>();
  for (const r of sessions.values()) for (const q of r.quizzes) {
    const digest = quizDigest(q), key = JSON.stringify([r.projectId, r.revision, r.variant, q.sceneId, digest]);
    let group = groups.get(key);
    if (!group) { group = { projectId: r.projectId, revision: r.revision, variant: r.variant, sceneId: q.sceneId, question: q.question, quizDigest: digest, eligible: 0, answered: 0, firstCorrect: 0, latestCorrect: 0, attempts: 0 }; groups.set(key, group); }
    group.eligible++;
    const attempts = r.attempts.filter(a => a.sceneId === q.sceneId).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    group.attempts += attempts.length;
    if (attempts.length) { group.answered++; if (attempts[0]!.answer === q.answerIndex) group.firstCorrect++; if (attempts.at(-1)!.answer === q.answerIndex) group.latestCorrect++; }
  }
  return { version: 1, sessions: sessions.size, records: values.length, groups: [...groups.values()].map(g => ({ ...g, completionRate: g.eligible ? g.answered / g.eligible : null, firstAccuracy: g.answered ? g.firstCorrect / g.answered : null, latestAccuracy: g.answered ? g.latestCorrect / g.answered : null })) };
}

export function learningConfusions(project: SceneScriptProject, records: LearningRecord[]) {
  const summary = aggregateLearning(records, project.id);
  return project.scenes.flatMap(scene => {
    if (!scene.quiz) return [];
    const digest = quizDigest({ sceneId: scene.id, ...scene.quiz });
    // Only identical questions/options/answers can target this revision's scene.
    const groups = summary.groups.filter(g => g.sceneId === scene.id && g.quizDigest === digest && g.firstCorrect < g.answered);
    if (!groups.length) return [];
    const wrong = groups.reduce((n, g) => n + g.answered - g.firstCorrect, 0);
    return [{ sceneId: scene.id, confusion: `理解检查「${scene.quiz.question}」有 ${wrong} 次会话首次答错，请补足推导或换类比，保留事实与题目。`, wrong }];
  }).sort((a, b) => b.wrong - a.wrong);
}

export function exportInsights(source: string, out: string, projectId?: string) {
  const summary = aggregateLearning(learningRecords(source), projectId), output = path.resolve(out);
  if (fs.existsSync(output) || fs.existsSync(`${output}.json`)) throw new Error("Insights output already exists; choose a new path");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const pct = (n: number | null) => n === null ? "—" : `${Math.round(n * 100)}%`;
  const rows = summary.groups.map(g => `<tr><td>${xml(g.sceneId)}<small>${xml(g.question)}</small></td><td>${xml(g.variant)}<small>${xml(g.revision)}</small></td><td>${g.answered}/${g.eligible}</td><td>${pct(g.firstAccuracy)}</td><td>${pct(g.latestAccuracy)}</td><td>${g.attempts}</td></tr>`).join("");
  fs.writeFileSync(output, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Glint 理解反馈</title><style>body{font:15px/1.6 'Microsoft YaHei',sans-serif;background:#f3f4ef;color:#202820;margin:0;padding:40px}main{max-width:1100px;margin:auto}h1{font-size:30px}p,small{color:#687266}small{display:block;font-size:12px}.table{overflow:auto}table{border-collapse:collapse;width:100%;background:white}th,td{padding:18px;text-align:left;border-bottom:1px solid #e0e5db}th{font-size:12px}strong{font-size:26px;color:#286b4b}@media(max-width:600px){body{padding:16px}td,th{padding:10px}}</style><main><p>GLINT / UNDERSTANDING</p><h1>哪些地方还没讲清楚？</h1><p><strong>${summary.sessions}</strong> 个本地会话 · ${summary.records} 份导出 · 相同会话只保留最新导出</p><div class="table"><table><thead><tr><th>镜头 / 题目</th><th>版本 / 修订</th><th>作答 / 可答</th><th>首次正确率</th><th>末次正确率</th><th>尝试</th></tr></thead><tbody>${rows || '<tr><td colspan="6">暂无答题数据</td></tr>'}</tbody></table></div><p>选择题表现不等同于真实理解。不同修订分别统计；只有相同题目才可比较。A/B 数据未随机分组，不作因果结论；一份本地会话不等于一个独立用户。</p><p>将记录目录传给 <code>glint review --feedback=目录 --project=工程 --out=新工程.json</code> 可生成定向重讲版本，原工程保留。</p></main></html>`);
  fs.writeFileSync(`${output}.json`, JSON.stringify(summary, null, 2));
  return { output, ...summary };
}
