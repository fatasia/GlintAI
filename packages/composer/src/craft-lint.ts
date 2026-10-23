import type { SceneScriptProject } from "@glintai/scenescript";

/**
 * Craft-rules lint over a parsed project — the mechanical half of the
 * quality gates (huashu storyboard_lint lineage). The measured half lives in
 * apps/studio/scripts/qa.ts and runs on rendered pixels; this one runs on
 * the storyboard before any code or audio is produced, where fixes are
 * cheapest. Levels: "error" blocks the workflow, "warn" needs a written
 * reason to ship.
 */

export interface LintIssue {
  rule: string;
  level: "error" | "warn";
  sceneId?: string;
  message: string;
}

/** Detect a saturated blue-purple background hex — the "AI slop" band. */
export function isSlopBackground(hex: string): boolean {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return false;
  const value = parseInt(match[1]!, 16);
  const r = (value >> 16) & 0xff, g = (value >> 8) & 0xff, b = value & 0xff;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === 0) return false;
  const saturation = (max - min) / max;
  const lightness = max / 255;
  let hue = 0;
  const delta = max - min;
  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
  }
  // Hand-picked hex backgrounds get a slightly wider band (220–300) than the
  // pixel-based QA measurement (230–300): a curated color sits exactly where
  // the author put it, while rendered pixels smear under antialiasing.
  return saturation > 0.35 && lightness > 0.15 && hue >= 220 && hue <= 300;
}

export function craftLint(project: SceneScriptProject): LintIssue[] {
  const issues: LintIssue[] = [];
  const scenes = project.scenes;

  scenes.forEach((scene, index) => {
    const textLength = scene.narration.text.trim().length;
    if (textLength < 4) {
      issues.push({ rule: "empty-content", level: "warn", sceneId: scene.id, message: `旁白不足 4 个字,这一镜接近空镜;给画面一个具体动作或补齐讲述` });
    }
    if (textLength > 220) {
      issues.push({ rule: "long-scene", level: "warn", sceneId: scene.id, message: `单镜旁白 ${textLength} 字(>220),一镜只讲一件事,建议拆成两镜` });
    }
    if (scene.kind === "chart" && scene.data.length > 12 && !scene.heading) {
      issues.push({ rule: "chart-unlabeled", level: "warn", sceneId: scene.id, message: `图表 ${scene.data.length} 个数据点且无标题,观众抓不到重点;加 heading 或删数据` });
    }
  });

  const accents = scenes.filter(scene => ["flash", "zoom-punch"].includes(scene.transition?.in ?? ""));
  if (accents.length > 2) issues.push({ rule: "accent-budget", level: "error", message: `全片重音转场 ${accents.length} 次，最多 2 次；其余镜头改用缓转场。` });
  scenes.forEach((scene, index) => {
    if (scene.transition?.in !== "magic-move") return;
    const keys = new Set(scenes[index - 1]?.sharedElements?.map(element => element.key) ?? []);
    if (!scene.sharedElements?.some(element => keys.has(element.key))) issues.push({ rule: "missing-shared-element", level: "error", sceneId: scene.id, message: "Magic Move 需要前后镜头至少一个同 key 的 sharedElements 元素。" });
  });
  const sceneIds = new Set(scenes.map(scene => scene.id));
  for (const cue of project.sfx ?? []) if (!sceneIds.has(cue.sceneId)) issues.push({ rule: "sfx-target", level: "error", sceneId: cue.sceneId, message: "音效引用了不存在的场景。" });

  let pushRun = 0;
  for (const scene of scenes) {
    pushRun = scene.camera?.type === "push" ? pushRun + 1 : 0;
    if (pushRun >= 3) {
      issues.push({ rule: "consecutive-push", level: "error", sceneId: scene.id, message: `连续 ${pushRun} 镜都是推近;镜头要有来有回,插一镜切构图或拉远` });
    }
  }

  const last = scenes[scenes.length - 1];
  if (last && last.kind === "title" && scenes.length > 1) {
    issues.push({ rule: "card-ending", level: "warn", sceneId: last.id, message: `结尾落在字卡上(翻页式 PPT 的标志);让结尾落在主角或主物的一个动作上` });
  }

  for (let index = 2; index < scenes.length; index++) {
    const [a, b, c] = [scenes[index - 2]!, scenes[index - 1]!, scenes[index]!];
    const kind = a.transition?.in;
    if (kind && kind === b.transition?.in && kind === c.transition?.in) {
      issues.push({ rule: "same-transition", level: "warn", sceneId: c.id, message: `连续 3 镜使用转场 "${kind}";编排默认会轮换,显式指定时请换手法` });
    }
  }

  if (typeof project.theme === "object" && project.theme !== null) {
    const overrides = project.theme as { colors?: { bg?: unknown } };
    const bg = overrides.colors?.bg;
    if (typeof bg === "string" && isSlopBackground(bg)) {
      issues.push({ rule: "slop-background", level: "warn", sceneId: undefined, message: `自定义底色 ${bg} 是高饱和蓝紫(AI 味最重的组合);换风格包或改低饱和底色` });
    }
  }

  if (scenes.length >= 4) {
    const bulletish = scenes.filter((scene) => scene.kind === "bullets").length;
    if (bulletish / scenes.length >= 0.6) {
      issues.push({ rule: "slide-deck-shape", level: "warn", sceneId: undefined, message: `${bulletish}/${scenes.length} 镜都是要点列表,结构像 PPT;混入图表/对比/图解场景分担叙事` });
    }
  }

  return issues;
}

export function lintVerdict(issues: LintIssue[]): "green" | "yellow" | "red" {
  if (issues.some((issue) => issue.level === "error")) return "red";
  if (issues.some((issue) => issue.level === "warn")) return "yellow";
  return "green";
}
