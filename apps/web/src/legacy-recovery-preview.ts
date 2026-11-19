/** A bounded, text-only preview. Never render imported HTML or execute snippets. */
export function legacyRecordSummary(raw: string | null): string {
  if (raw === null) return "无记录";
  try {
    const value = JSON.parse(raw);
    const list = Array.isArray(value) ? value : value?.documents ?? value?.nodes ?? value?.scenes;
    if (Array.isArray(list)) {
      const labels = list.slice(0, 4).map(item => item && typeof item === "object" ? item.name ?? item.title ?? item.id : "").filter(item => typeof item === "string" && item.trim()).map(item => item.slice(0, 60));
      return `${list.length} 项${labels.length ? ` · ${labels.join("、")}${list.length>4?"…":""}` : ""}`;
    }
    const title = value?.project?.title ?? value?.title ?? value?.name;
    if (typeof title === "string") return title.slice(0, 120);
    if (value && typeof value === "object") return `${Object.keys(value).length} 个字段 · ${(new TextEncoder().encode(raw).length / 1024).toFixed(1)} KB`;
    return typeof value === "string" ? value.slice(0, 120) : "基础设置";
  } catch { return raw === "dark" ? "深色主题" : raw === "light" ? "浅色主题" : "原记录无法解析，替换前请先下载备份"; }
}
