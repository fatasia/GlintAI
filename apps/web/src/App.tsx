import { IdeaStudio } from "./IdeaStudio";
import { OfflineStatus } from "./OfflineStatus";
import { AmbientBackdrop } from "./AmbientBackdrop";
import { PreviewBoundary } from "./PreviewBoundary";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { consumeAnswerStream, type GroundedAnswer } from "./answer-stream";
import entropyProject from "../../../examples/entropy-lecture/project.scenescript.json";
import uncertaintyProject from "../../../examples/uncertainty-principle/project.scenescript.json";

// The shared component tree pulls in Remotion's player runtime and Three.js;
// lazy-loading keeps the question panel usable before the player is needed.
const ProjectPreview = lazy(() => import("./ProjectPreview"));
// Tool panels stay out of the first paint; the disclosure loads them on open.
const ModelSettings = lazy(() => import("./ModelSettings").then(module => ({ default: module.ModelSettings })));
const MediaWorkshop = lazy(() => import("./MediaWorkshop").then(module => ({ default: module.MediaWorkshop })));
const PersonaLibrary = lazy(() => import("./PersonaLibrary").then(module => ({ default: module.PersonaLibrary })));
const VoiceReview = lazy(() => import("./VoiceReview").then(module => ({ default: module.VoiceReview })));
const UnderstandingCheck = lazy(() => import("./UnderstandingCheck").then(module => ({ default: module.UnderstandingCheck })));
const SkillCatalog = lazy(() => import("./SkillCatalog").then(module => ({ default: module.SkillCatalog })));
const NleEditor = lazy(() => import("./NleEditor").then(module => ({ default: module.NleEditor })));

const EXAMPLES: Array<{
  key: string;
  label: string;
  project: unknown;
}> = [
  { key: "entropy", label: "熵与生命 · 中文", project: entropyProject },
  { key: "uncertainty", label: "Uncertainty Principle · English", project: uncertaintyProject },
];

const pageStyle: React.CSSProperties = {
  minHeight: "100dvh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  background: "radial-gradient(900px 520px at 50% -12%, rgba(96, 116, 255, 0.10), transparent 66%), #08090b",
};

const cardStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: 14,
  overflow: "hidden",
  border: "1px solid #26262b",
  background: "#101013",
};

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: "9px 18px",
  borderRadius: 999,
  border: "1px solid",
  borderColor: active ? "#3f3f46" : "#26262b",
  background: active ? "#1c1c21" : "transparent",
  color: active ? "#f4f4f5" : "#8b8b95",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
});

const moreSummary: React.CSSProperties = {
  width: "100%",
  cursor: "pointer",
  color: "#8b8b95",
  fontSize: 13,
  padding: "16px 0",
  borderTop: "1px solid rgba(255, 255, 255, 0.07)",
  display: "flex",
  justifyContent: "center",
  gap: 8,
};

export const App: React.FC = () => {
  const [nleOpen, setNleOpen] = useState(false);
  const [selected, setSelected] = useState(EXAMPLES[0]!);
  const [showPreview, setShowPreview] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<GroundedAnswer | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => {
    activeRequest.current?.abort();
    activeRequest.current = null;
  }, []);

  const cancelAsk = () => {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setAsking(false);
  };
  const selectExample = (example: typeof EXAMPLES[number]) => {
    cancelAsk();
    setSelected(example);
    setResult(null);
  };
  const ask = async () => {
    if (!question.trim() || activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const timer = setTimeout(() => controller.abort(new DOMException("提问超时，请重试。", "TimeoutError")), 70_000);
    setAsking(true);
    setResult(null);
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, project: selected.key }),
        signal: controller.signal,
      });
      const answer = await consumeAnswerStream(response, controller.signal);
      if (activeRequest.current === controller) setResult(answer);
    } catch (error) {
      if (activeRequest.current === controller) {
        setResult({ answer: null, refused: true, refusalReason: null, citations: [], error: error instanceof Error ? error.message : "提问失败，请重试。" });
      }
    } finally {
      clearTimeout(timer);
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setAsking(false);
      }
    }
  };

  if (nleOpen) return <Suspense fallback={<div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", color: "#a1a1aa", background: "#08090b" }}>打开剪辑台…</div>}><NleEditor onClose={() => setNleOpen(false)} /></Suspense>;
  return (
    <div style={pageStyle}>
      <style>{`#more-tools > summary { list-style: none; } #more-tools > summary::-webkit-details-marker { display: none; } @media (max-width: 640px) { #more-tools > summary { justify-content: flex-start; } }`}</style>
      <AmbientBackdrop />
      <OfflineStatus />
      <div style={{ position: "relative", zIndex: 1, width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <header style={{ width: "100%", borderBottom: "1px solid rgba(255,255,255,.07)", background: "rgba(8,9,11,.74)" }}>
        <div style={{ width: "min(94vw, 1180px)", margin: "0 auto", height: 60, display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em", color: "#f7f7f8" }}>
            Glint
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: "linear-gradient(135deg, #7c8cff, #c084fc)" }} />
          </span>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 12 }}>
            <button type="button" onClick={() => setNleOpen(true)} style={{ color: "#f4f4f5", fontSize: 12, border: "1px solid #3f3f46", borderRadius: 999, padding: "6px 12px", background: "#1c1c21", font: "inherit", cursor: "pointer" }}>剪辑台</button>
            <a href="#more-tools" onClick={() => setToolsOpen(true)} style={{ color: "#a1a1aa", fontSize: 12, textDecoration: "none", border: "1px solid #26262b", borderRadius: 999, padding: "6px 12px" }}>工具与设置</a>
          </span>
        </div>
      </header>

      <main style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 40, padding: "52px 0 64px" }}>
        <IdeaStudio cardStyle={cardStyle} />

        <details id="more-tools" style={{ width: "min(94vw, 1180px)" }} onToggle={event => { if (event.currentTarget.open) setToolsOpen(true); }}>
          <summary style={moreSummary}>工具与设置<span style={{ color: "#8b8b95" }}>示例 · 素材 · 模型 · 审阅</span></summary>
          {toolsOpen && <Suspense fallback={<p role="status" style={{ padding: 22, color: "#8b8b95" }}>正在加载工具…</p>}><div style={{ display: "grid", gap: 16, marginTop: 16 }}>
            <div style={cardStyle}><ModelSettings /></div>
            <div style={cardStyle}><MediaWorkshop /></div>
            <div style={cardStyle}><Suspense fallback={<p role="status" style={{ padding: 22 }}>正在读取 Skills…</p>}><SkillCatalog /></Suspense></div>

            <section style={{ display: "grid", gap: 12, justifyItems: "center", paddingTop: 8 }}>
              <h2 style={{ fontSize: 15, color: "#a1a1aa", margin: 0 }}>看看示例，或对画面问一句</h2>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
                {EXAMPLES.map((example) => (
                  <button key={example.key} style={tabStyle(selected.key === example.key)} onClick={() => selectExample(example)}>
                    {example.label}
                  </button>
                ))}
              </div>
              <div style={cardStyle}>
                {showPreview ? <PreviewBoundary><Suspense fallback={<p style={{ padding: 24 }} role="status">正在加载播放器…</p>}>
                  <ProjectPreview project={selected.project} />
                </Suspense></PreviewBoundary> : <button onClick={() => setShowPreview(true)} style={{ width: "100%", padding: 28, background: "#151518", color: "#c7c7cf", border: 0, font: "inherit", cursor: "pointer" }}>▶ 预览示例 · 按需加载播放器</button>}
              </div>
              <div style={{ ...cardStyle, padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  <input
                    aria-label="对示例提问"
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void ask();
                    }}
                    placeholder={`看不懂？问一句「${selected.key === "entropy" ? "熵增原理的前提是什么" : "Why doesn't an electron fall in?"}」`}
                    style={{
                      flex: 1, minWidth: 0,
                      padding: "12px 16px",
                      borderRadius: 10,
                      border: "1px solid #2b2b31",
                      background: "#151518",
                      color: "#f4f4f5",
                      fontSize: 14,
                      fontFamily: "inherit",
                    }}
                  />
                  <button
                    onClick={() => void ask()}
                    disabled={asking || !question.trim()}
                    style={{
                      padding: "12px 22px",
                      borderRadius: 10,
                      border: "none",
                      background: asking ? "#3f3f46" : "#f4f4f5",
                      color: asking ? "#a1a1aa" : "#09090b",
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: asking ? "wait" : "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    {asking ? "思考中…" : "问"}
                  </button>
                </div>
                {asking ? (
                  <div role="status" style={{ color: "#8b8b95", fontSize: 13 }}>
                    正在检索并核对回答，判定完成后显示正文。
                    <button onClick={cancelAsk} style={{ marginLeft: 12 }}>取消</button>
                  </div>
                ) : null}
                {result ? (
                  <div style={{ fontSize: 14, lineHeight: 1.75, color: "#d4d4d8" }}>
                    {result.error ? (
                      <span style={{ color: "#fca5a5" }}>{result.error}</span>
                    ) : result.refused ? (
                      <span style={{ color: "#8b8b95" }}>
                        资料未检索到相关内容，或模型判定资料不足，未提供回答。
                        {result.refusalReason === "no_relevant_context" ? "(检索层未命中)" : ""}
                      </span>
                    ) : (
                      <>
                        <div>{result.answer}</div>
                        {result.citations.length > 0 ? (
                          <div style={{ marginTop: 10, color: "#8b8b95", fontSize: 12 }}>
                            检索参考（不代表逐项事实核验）:
                            {result.citations.map((citation, index) => (
                              <span key={index} style={{ marginRight: 14 }}>
                                [{citation.docId}] {citation.headingPath.join(" › ")}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            </section>

            <PersonaLibrary cardStyle={cardStyle} />
            <VoiceReview cardStyle={cardStyle} />
            <UnderstandingCheck key={selected.key} project={selected.key} cardStyle={cardStyle} />
          </div></Suspense>}
        </details>

        <p style={{ color: "#8b8b95", fontSize: 12, margin: 0, textAlign: "center" }}>
          预览与导出同源。
        </p>
      </main>
      </div>
    </div>
  );
};
