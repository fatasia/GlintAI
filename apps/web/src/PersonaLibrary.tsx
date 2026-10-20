import { useEffect, useState, type CSSProperties } from "react";
import {
  parsePersonaCatalog,
  type PersonaCatalog,
} from "@glintai/listener/catalog";
export function PersonaLibrary({ cardStyle }: { cardStyle: CSSProperties }) {
  const [catalog, setCatalog] = useState<PersonaCatalog | null>(null),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/personas", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((data) => setCatalog(parsePersonaCatalog(data)))
      .catch(() => {
        if (!controller.signal.aborted) setError("画像目录暂时不可用。");
      });
    return () => controller.abort();
  }, []);
  return (
    <details style={{ ...cardStyle, padding: 26 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        听众画像库{catalog ? ` · ${catalog.entries.length} 个包` : ""}
      </summary>
      <div style={{ display: "grid", gap: 16, marginTop: 20 }}>
        <p style={{ margin: 0, color: "#a7b4c4" }}>
          下载 JSON 包，在 CLI 试讲时用 --persona-pack
          指定。导入画像只增加审阅视角，不执行代码。
        </p>
        <input
          aria-label="搜索听众画像"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索画像"
          style={{
            padding: 12,
            borderRadius: 8,
            border: "1px solid #35414e",
            background: "#141b24",
            color: "#f2f6fa",
            minWidth: 0,
          }}
        />
        {error && <p role="alert">{error}</p>}
        {catalog?.entries
          .filter((x) =>
            (x.title + x.description)
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((entry) => (
            <article
              key={entry.id}
              style={{ borderTop: "1px solid #35414e", paddingTop: 16 }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 16,
                  flexWrap: "wrap",
                }}
              >
                <strong>{entry.title}</strong>
                <a
                  href={`/api/personas/${entry.id}`}
                  download
                  style={{ color: "#aecef6" }}
                >
                  下载画像包
                </a>
              </div>
              <p style={{ color: "#a7b4c4" }}>{entry.description}</p>
              <small>
                {entry.version} · {entry.license} · {entry.personas.length}{" "}
                位听众
              </small>
              <details style={{ marginTop: 12 }}>
                <summary>查看审阅指令</summary>
                {entry.personas.map((p) => (
                  <p key={p.id}>
                    <strong>{p.name}</strong>：{p.prompt}
                  </p>
                ))}
              </details>
            </article>
          ))}
      </div>
    </details>
  );
}
