import { applicationUrl } from "./app-url";
import { useEffect, useMemo, useState } from "react";
import catalog from "./recipe-catalog.json";
import thumbs from "./recipe-thumbs.json";
import "./recipe-gallery.css";

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

/** 100 practical starting points built from the existing templates and styles. */
export function RecipeGallery({ onUse }: { onUse(recipe: Recipe): void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const detail = detailId ? recipes.find(recipe => recipe.id === detailId) : undefined;
  useEffect(() => {
    if (!detail) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setDetailId(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [detail]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return recipes.filter(recipe => (category === "全部" || recipe.category === category) && (!needle || `${recipe.title} ${recipe.description} ${recipe.tags.join(" ")}`.toLowerCase().includes(needle)));
  }, [query, category]);
  const open = (recipe: Recipe) => { setDetailId(recipe.id); setDraft(recipe.sample); };
  const use = (recipe: Recipe, sample: string) => onUse({ ...recipe, sample: sample.trim() || recipe.sample });
  return <section aria-label="模板库" className="recipe-gallery">
    <div className="recipe-gallery-top">
      <input aria-label="搜索模板" placeholder="搜索：产品发布、课程、竖屏、数据…" className="recipe-gallery-search" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="recipe-gallery-chips">{categories.map(item => <button key={item} type="button" aria-pressed={category === item} className="recipe-gallery-chip" onClick={() => setCategory(item)}>{item}</button>)}</div>
      <small role="status" className="recipe-gallery-status">{filtered.length} / {recipes.length} 个配方 · 全部可导出视频、GIF（前段）或当前镜 PNG</small>
    </div>
    <div className="recipe-gallery-grid">
      {filtered.map(recipe => {
        const thumb = thumbOf(recipe.id);
        return <article key={recipe.id} className="recipe-card">
          {thumb && <button type="button" aria-label={`${recipe.title} 查看详情`} className="recipe-card-thumb" onClick={() => open(recipe)}>
            <img src={applicationUrl(thumb)} alt={`${recipe.title} 版式预览`} loading="lazy" width={320} height={180} />
          </button>}
          <div className="recipe-card-head"><strong className="recipe-card-title">{recipe.title}</strong><small className="recipe-card-cat">{recipe.category}</small></div>
          <p className="recipe-card-desc">{recipe.description}</p>
          <div className="recipe-card-meta"><span>{recipe.template}</span><span>·</span><span>{recipe.theme}</span><span>·</span><span>{recipe.aspect}</span><span>·</span><span>{recipe.durationSec}s</span></div>
          <div className="recipe-card-actions">
            <button type="button" className="recipe-use" onClick={() => use(recipe, recipe.sample)}>用这个开始</button>
            <button type="button" aria-label={`${recipe.title} 预览并编辑起始文本`} className="recipe-gallery-chip" onClick={() => open(recipe)}>预览并编辑</button>
          </div>
        </article>;
      })}
      {filtered.length === 0 && <p role="status" className="recipe-empty">没有匹配的配方；换个关键词或选“全部”。</p>}
    </div>
    {detail && <div role="dialog" aria-modal="true" aria-label={`${detail.title} 详情`} className="recipe-dialog-backdrop" onClick={event => { if (event.target === event.currentTarget) setDetailId(null); }}>
      <div className="recipe-dialog">
        {thumbOf(detail.id) && <img src={applicationUrl(thumbOf(detail.id))} alt={`${detail.title} 版式预览`} width={640} height={360} />}
        <div className="recipe-dialog-head"><strong className="recipe-dialog-title">{detail.title}</strong><small className="recipe-dialog-cat">{detail.category} · {detail.template} · {detail.theme} · {detail.aspect} · {detail.durationSec}s</small></div>
        <p className="recipe-dialog-desc">{detail.description}</p>
        <div className="recipe-dialog-tags">{detail.tags.map(tag => <span key={tag} className="recipe-gallery-chip">{tag}</span>)}</div>
        <label className="recipe-dialog-label">起始文本（可直接改写）
          <textarea aria-label="起始文本" rows={6} value={draft} onChange={event => setDraft(event.target.value)} className="recipe-dialog-textarea" />
        </label>
        <div className="recipe-dialog-actions">
          <button type="button" className="recipe-gallery-chip" onClick={() => setDetailId(null)}>取消</button>
          <button type="button" className="recipe-use" onClick={() => { use(detail, draft); setDetailId(null); }}>用这个开始</button>
        </div>
      </div>
    </div>}
  </section>;
}
