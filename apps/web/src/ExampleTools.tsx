import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { appFetch as fetch } from "./app-url";
import { PreviewBoundary } from "./PreviewBoundary";
import { consumeAnswerStream, type GroundedAnswer } from "./answer-stream";

const ProjectPreview = lazy(() => import("./ProjectPreview"));
const PersonaLibrary = lazy(() => import("./PersonaLibrary").then(module => ({ default: module.PersonaLibrary })));
const UnderstandingCheck = lazy(() => import("./UnderstandingCheck").then(module => ({ default: module.UnderstandingCheck })));

const EXAMPLES = [
  { key: "entropy", label: "熵与生命 · 中文", load: () => import("../../../examples/entropy-lecture/project.scenescript.json") },
  { key: "uncertainty", label: "Uncertainty Principle · English", load: () => import("../../../examples/uncertainty-principle/project.scenescript.json") },
];
const toolCardStyle: CSSProperties = { border: "1px solid var(--line-1)", borderRadius: "var(--r-md)", background: "var(--ink-2)", overflow: "hidden", padding: 22, display: "grid", gap: 14 };
export function ExampleTools() {
  const [selected, setSelected] = useState(EXAMPLES[0]!);
  const [showPreview, setShowPreview] = useState(false);
  const [exampleProject, setExampleProject] = useState<unknown>(null);
  const [exampleError, setExampleError] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<GroundedAnswer | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { activeRequest.current?.abort(); activeRequest.current = null; }, []);
  useEffect(() => {
    if (!showPreview) return;
    let live = true;
    setExampleError(false);
    void selected.load().then(module => { if (live) setExampleProject(module.default); }).catch(() => { if (live) setExampleError(true); });
    return () => { live = false; };
  }, [selected, showPreview, previewAttempt]);
  const cancelAsk = () => { activeRequest.current?.abort(); activeRequest.current = null; setAsking(false); };
  const ask = async () => {
    if (!question.trim() || activeRequest.current) return;
    const controller = new AbortController(); activeRequest.current = controller;
    const timer = setTimeout(() => controller.abort(new DOMException("提问超时，请重试。", "TimeoutError")), 70_000);
    setAsking(true); setResult(null);
    try {
      const response = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, project: selected.key }), signal: controller.signal });
      const answer = await consumeAnswerStream(response, controller.signal);
      if (activeRequest.current === controller) setResult(answer);
    } catch (error) {
      if (activeRequest.current === controller) setResult({ answer: null, refused: true, refusalReason: null, citations: [], error: error instanceof Error ? error.message : "提问失败，请重试。" });
    } finally {
      clearTimeout(timer);
      if (activeRequest.current === controller) { activeRequest.current = null; setAsking(false); }
    }
  };
  return <div className="workspace-examples">
    <p className="tool-note">问答与理解检查针对所选示例工程。</p>
    <div className="example-bar">{EXAMPLES.map(example => <button key={example.key} type="button" className="example-chip" aria-pressed={selected.key === example.key} onClick={() => { if (selected.key === example.key) return; cancelAsk(); setSelected(example); setExampleProject(null); setResult(null); }}>{example.label}</button>)}</div>
    <div className="tool-grid">
      <div className="example-stage">{showPreview ? <PreviewBoundary key={selected.key}><Suspense fallback={<p className="workspace-loading" role="status">正在加载播放器…</p>}>
        {exampleError ? <p role="alert" className="workspace-error">示例加载失败。<button type="button" className="app-ghost" onClick={() => setPreviewAttempt(value => value + 1)}>重试</button></p> : exampleProject ? <ProjectPreview project={exampleProject} /> : <p className="workspace-loading" role="status">正在加载示例…</p>}
      </Suspense></PreviewBoundary> : <button type="button" className="example-placeholder" onClick={() => setShowPreview(true)}><strong>预览示例</strong><span>点击后加载播放器</span></button>}</div>
      <div className="qa-panel">
        <p className="tool-note">对示例提问，回答会附带检索来源。</p>
        <div className="qa-row"><input aria-label="对示例提问" value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void ask(); }} placeholder={selected.key === "entropy" ? "熵增原理的前提是什么？" : "Why doesn't an electron fall in?"} />
          <button type="button" className="qa-submit" title={asking ? "正在等待回答" : !question.trim() ? "请先输入问题" : "提交问题"} onClick={() => void ask()} disabled={asking || !question.trim()}>{asking ? "思考中…" : "提问"}</button></div>
        {asking && <div role="status" className="qa-muted">正在检索并核对回答…<button type="button" className="qa-cancel" onClick={cancelAsk}>取消</button></div>}
        {result && <div className="qa-answer">{result.error ? <span role="alert" className="qa-error">{result.error}</span> : result.refused ? <span className="qa-muted">资料不足，未提供回答。{result.refusalReason === "no_relevant_context" ? "（检索层未命中）" : ""}</span> : <>
          <div>{result.answer}</div>{result.citations.length > 0 && <div className="qa-cite">检索参考（不代表逐项事实核验）：{result.citations.map((citation, index) => <span key={index}>[{citation.docId}] {citation.headingPath.join(" › ")} </span>)}</div>}
        </>}</div>}
      </div>
    </div>
    <div className="tool-grid"><UnderstandingCheck key={selected.key} project={selected.key} cardStyle={toolCardStyle} /><PersonaLibrary cardStyle={toolCardStyle} /></div>
  </div>;
}
