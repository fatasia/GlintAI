import { useMemo, useState } from "react";
import catalog from "./recipe-catalog.json";
import thumbs from "./recipe-thumbs.json";

const thumbOf = (id: string): string | undefined => {
  const entry = (thumbs as { entries: Array<{ id: string; thumb: string }> }).entries.find(item => item.id === id);
  return entry?.thumb;
};

export interface Recipe {
  id: string;
  title: string;
  category: string;
  description: string;
  template: string;
  theme: string;
  aspect: string;
  durationSec: number;
  tags: string[];
  sampleMode: "source" | "idea";
  sample: string;
}

const recipes = (catalog as { recipes: Recipe[] }).recipes;
const categories = ["全部", ...Array.from(new Set(recipes.map(recipe => recipe.category)))];
const field = { width: "100%", minWidth: 0, padding: "10px 12px", borderRadius: 9, border: "1px solid #2b2b31", background: "#151518", color: "#f4f4f5", font: "inherit", fontSize: 13 };
const chip = { border: "1px solid #2b2b31", borderRadius: 999, background: "transparent", color: "#a1a1aa", padding: "5px 10px", font: "inherit", fontSize: 12, cursor: "pointer" };

/** 100 practical starting points built from the existing templates and styles. */
export function RecipeGallery({ onUse }: { onUse(recipe: Recipe): void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return recipes.filter(recipe => (category === "全部" || recipe.category === category) && (!needle || `${recipe.title} ${recipe.description} ${recipe.tags.join(" ")}`.toLowerCase().includes(needle)));
  }, [query, category]);
  return <section aria-label="模板库" style={{ display: "grid", gap: 12 }}>
    <div style={{ display: "grid", gap: 8 }}>
      <input aria-label="搜索模板" placeholder="搜索：产品发布、课程、竖屏、数据…" style={field} value={query} onChange={event => setQuery(event.target.value)} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{categories.map(item => <button key={item} type="button" aria-pressed={category === item} style={{ ...chip, ...(category === item ? { background: "#1c1c21", color: "#f4f4f5", borderColor: "#3f3f46" } : {}) }} onClick={() => setCategory(item)}>{item}</button>)}</div>
      <small role="status" style={{ color: "#8b8b95", fontSize: 12 }}>{filtered.length} / {recipes.length} 个配方 · 全部可导出视频、GIF（前段）或当前镜 PNG</small>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 250px), 1fr))", gap: 10 }}>
      {filtered.map(recipe => <article key={recipe.id} style={{ display: "grid", gap: 8, padding: 12, borderRadius: 12, border: "1px solid #26262b", background: "#101013", color: "#e4e4e7", minWidth: 0 }}>
        {thumbOf(recipe.id) && <img src={thumbOf(recipe.id)} alt={`${recipe.title} 版式预览`} loading="lazy" width={320} height={180} style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 8, border: "1px solid #232328", background: "#0a0a0c" }} />}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}><strong style={{ fontSize: 13 }}>{recipe.title}</strong><small style={{ color: "#6f6f78", fontSize: 11 }}>{recipe.category}</small></div>
        <p style={{ margin: 0, color: "#a1a1aa", fontSize: 12, lineHeight: 1.6, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{recipe.description}</p>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", color: "#8b8b95", fontSize: 10 }}><span>{recipe.template}</span><span>·</span><span>{recipe.theme}</span><span>·</span><span>{recipe.aspect}</span><span>·</span><span>{recipe.durationSec}s</span></div>
        <button type="button" style={{ justifySelf: "start", border: "1px solid #f4f4f5", borderRadius: 999, padding: "7px 12px", background: "#f4f4f5", color: "#09090b", font: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }} onClick={() => onUse(recipe)}>用这个开始</button>
      </article>)}
      {filtered.length === 0 && <p role="status" style={{ color: "#8b8b95", fontSize: 13 }}>没有匹配的配方；换个关键词或选“全部”。</p>}
    </div>
  </section>;
}
