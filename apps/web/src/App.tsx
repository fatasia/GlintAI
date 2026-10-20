

import { IdeaStudio } from "./IdeaStudio";
import { PersonaLibrary } from "./PersonaLibrary";
import { OfflineStatus } from "./OfflineStatus";
import { UnderstandingCheck } from "./UnderstandingCheck";
import { VoiceReview } from "./VoiceReview";
import { PreviewBoundary } from "./PreviewBoundary";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { consumeAnswerStream, type GroundedAnswer } from "./answer-stream";
import entropyProject from "../../../examples/entropy-lecture/project.scenescript.json";
import uncertaintyProject from "../../../examples/uncertainty-principle/project.scenescript.json";

// The shared component tree pulls in Remotion's player runtime and Three.js;
// lazy-loading keeps the question panel usable before the player is needed.
const ProjectPreview = lazy(() => import("./ProjectPreview"));

const EXAMPLES: Array<{
  key: string;
  label: string;
  project: unknown;
}> = [
  { key: "entropy", label: "熵与生命 · 中文", project: entropyProject },
  { key: "uncertainty", label: "Uncertainty Principle · English", project: uncertaintyProject },
];

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 28,
  padding: "48px 20px 64px",
  background:
    "radial-gradient(1200px 700px at 80% -10%, rgba(79, 140, 255, 0.10), transparent 60%), radial-gradient(1100px 700px at 0% 110%, rgba(155, 107, 255, 0.08), transparent 60%), #0b0f14",
};

const cardStyle: React.CSSProperties = {
  width: "min(92vw, 1100px)",
  borderRadius: 20,
  overflow: "hidden",
  boxShadow: "0 30px 90px rgba(0, 0, 0, 0.45)",
  border: "1px solid rgba(242, 246, 250, 0.10)",
  background: "#0b0f14",
};

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: "10px 22px",
  borderRadius: 999,
  border: "1px solid",
  borderColor: active ? "rgba(155, 139, 251, 0.5)" : "rgba(242, 246, 250, 0.14)",
  background: active ? "rgba(155, 139, 251, 0.14)" : "transparent",
  color: active ? "#f2f6fa" : "#8a99a8",
  cursor: "pointer",
  fontSize: 15,
  fontFamily: "inherit",
});

export const App: React.FC = () => {
  const [selected, setSelected] = useState(EXAMPLES[0]!);
  const [showPreview, setShowPreview] = useState(false);
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

  return (
    <div style={pageStyle}>
      <OfflineStatus />
      <header
        style={{
          display: "flex",
          alignItems: "center", flexWrap: "wrap",
          gap: 12,
          fontSize: 22,
          fontWeight: 700,
          color: "#8a99a8",
        }}
      >
        Glint
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #4f8cff, #9b6bff)",
          }}
        />
        <span style={{ fontWeight: 400, fontSize: 15, marginLeft: 8 }}>
          资料到成片 · 先编辑，再导出
        </span>
      </header>

      <IdeaStudio cardStyle={cardStyle} />

      <h2 style={{ fontSize: 18, color: "#a7b4c4", margin: 0 }}>示例与试讲</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        {EXAMPLES.map((example) => (
          <button
            key={example.key}
            style={tabStyle(selected.key === example.key)}
            onClick={() => selectExample(example)}
          >
            {example.label}
          </button>
        ))}
      </div>

      <div style={cardStyle}>
        {showPreview ? <PreviewBoundary><Suspense fallback={<p style={{ padding: 24 }} role="status">正在加载播放器…</p>}>
          <ProjectPreview project={selected.project} />
        </Suspense></PreviewBoundary> : <button onClick={() => setShowPreview(true)} style={{ width: "100%", padding: 28, background: "#172330", color: "#c5dcf8", border: 0, font: "inherit", cursor: "pointer" }}>▶ 预览示例 · 按需加载播放器</button>}
      </div>

      <div style={{ ...cardStyle, padding: 26, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void ask();
            }}
            placeholder={`看不懂?问一句「${selected.key === "entropy" ? "熵增原理的前提是什么" : "Why doesn't an electron fall in?"}」`}
            style={{
              flex: 1, minWidth: 0,
              padding: "14px 20px",
              borderRadius: 12,
              border: "1px solid rgba(242, 246, 250, 0.14)",
              background: "rgba(242, 246, 250, 0.05)",
              color: "#f2f6fa",
              fontSize: 15,
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={() => void ask()}
            disabled={asking || !question.trim()}
            style={{
              padding: "14px 28px",
              borderRadius: 12,
              border: "none",
              background: asking ? "rgba(155, 139, 251, 0.4)" : "linear-gradient(120deg, #6d5ae0, #9b8bfb)",
              color: "#fff",
              fontSize: 15,
              cursor: asking ? "wait" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {asking ? "思考中…" : "问"}
          </button>
        </div>
        {asking ? (
          <div role="status" style={{ color: "#a09aae" }}>
            正在检索并核对回答，判定完成后显示正文。
            <button onClick={cancelAsk} style={{ marginLeft: 12 }}>取消</button>
          </div>
        ) : null}
        {result ? (
          <div style={{ fontSize: 15, lineHeight: 1.7 }}>
            {result.error ? (
              <span style={{ color: "#ff9d8a" }}>{result.error}</span>
            ) : result.refused ? (
              <span style={{ color: "#a09aae" }}>
                资料未检索到相关内容，或模型判定资料不足，未提供回答。
                {result.refusalReason === "no_relevant_context" ? "(检索层未命中)" : ""}
              </span>
            ) : (
              <>
                <div>{result.answer}</div>
                {result.citations.length > 0 ? (
                  <div style={{ marginTop: 10, color: "#6f6980", fontSize: 13 }}>
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

      <PersonaLibrary cardStyle={cardStyle} />
      <VoiceReview cardStyle={cardStyle} />
      <UnderstandingCheck key={selected.key} project={selected.key} cardStyle={cardStyle} />

      <p style={{ color: "#8a99a8", fontSize: 14, margin: 0, textAlign: "center" }}>
        Preview channel: same <code>@glintai/video</code> components as the MP4 render.
        Web · desktop · mobile browser.
      </p>
    </div>
  );
};
