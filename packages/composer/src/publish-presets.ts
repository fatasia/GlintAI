import fs from "node:fs";
import path from "node:path";

/** DELIVER-08（降级范围）：按平台的导出预设。只做元数据与画幅预设，不做账号连接。 */
export interface PublishPreset { platform: string; aspect: "16:9" | "9:16" | "1:1"; maxSeconds: number; titleTemplate: string; descTemplate: string; coverHint: string }

export const PUBLISH_PRESETS: PublishPreset[] = [
  { platform: "douyin", aspect: "9:16", maxSeconds: 600, titleTemplate: "{hook}", descTemplate: "{takeaway}\n{tags}", coverHint: "首帧或中点帧，竖屏 3:4 安全区内" },
  { platform: "shipinhao", aspect: "9:16", maxSeconds: 3600, titleTemplate: "{title}", descTemplate: "{takeaway}", coverHint: "首帧，避免底部互动区" },
  { platform: "bilibili", aspect: "16:9", maxSeconds: 0, titleTemplate: "{title}｜{hook}", descTemplate: "{takeaway}\n\n{sourceNote}", coverHint: "16:9 大字封面" },
];

export function renderPreset(platform: string, plan: { title: string; hook: string; takeaway: string }, tags: string[] = []): { preset: PublishPreset; title: string; description: string; warnings: string[] } {
  const preset = PUBLISH_PRESETS.find(entry => entry.platform === platform);
  if (!preset) throw new Error(`未知平台预设：${platform}（可用：${PUBLISH_PRESETS.map(entry => entry.platform).join("、")}）`);
  const warnings: string[] = [];
  const fill = (template: string) => template
    .replace("{title}", plan.title).replace("{hook}", plan.hook).replace("{takeaway}", plan.takeaway)
    .replace("{tags}", tags.map(tag => `#${tag}`).join(" ")).replace("{sourceNote}", "本视频由 Glint 生成");
  const title = fill(preset.titleTemplate).slice(0, 80);
  const description = fill(preset.descTemplate).slice(0, 2000);
  if (plan.title.length > 40 && platform !== "bilibili") warnings.push("标题偏长，建议平台内手动精简");
  return { preset, title, description, warnings };
}

export function writePublishKit(platform: string, plan: { title: string; hook: string; takeaway: string }, outDir: string, tags: string[] = []): { file: string; title: string; description: string } {
  const rendered = renderPreset(platform, plan, tags);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `publish-${platform}.json`);
  fs.writeFileSync(file, JSON.stringify({ platform, aspect: rendered.preset.aspect, coverHint: rendered.preset.coverHint, title: rendered.title, description: rendered.description, warnings: rendered.warnings }, null, 2), "utf8");
  return { file, title: rendered.title, description: rendered.description };
}
