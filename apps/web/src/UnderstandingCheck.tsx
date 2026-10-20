import { useEffect, useRef, useState, type CSSProperties } from "react";
import { jobRequest } from "./jobs-client";
interface Question { id: string; question: string; choices: string[]; concept: string; source: string }
interface Result { correct: number; total: number; results: Array<{ id: string; correct: boolean; explanation: string; source: string }> }
interface Stats { attempts: number; concepts: Array<{ concept: string; answered: number; missed: number }>; basis: string }
export function UnderstandingCheck({ project, cardStyle }: { project: string; cardStyle: CSSProperties }) {
  const [questions, setQuestions] = useState<Question[]>([]), [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<Result | null>(null), [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [reload, setReload] = useState(0);
  const active = useRef<AbortController | null>(null), attempt = useRef(crypto.randomUUID()), lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    setQuestions([]); setResult(null); setStats(null); setError(""); setPending(false); setAnswers({}); lock.current = false; attempt.current = crypto.randomUUID();
    void Promise.all([jobRequest(`/api/checks/${project}`, {}, controller.signal), jobRequest(`/api/checks/${project}/stats`, {}, controller.signal)]).then(([q, s]) => { if (!controller.signal.aborted) { setQuestions(q); setStats(s); } }).catch(() => { if (!controller.signal.aborted) setError("检查题暂不可用，请重试。"); });
    return () => controller.abort();
  }, [project, reload]);
  const submit = async () => {
    if (lock.current || !questions.length || questions.some((question) => answers[question.id] === undefined)) return;
    lock.current = true; setPending(true); setError("");
    const controller = active.current!;
    try {
      const next = await jobRequest(`/api/checks/${project}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attemptId: attempt.current, answers: questions.map((question) => ({ id: question.id, choice: answers[question.id] })) }) }, controller.signal);
      if (controller.signal.aborted) return;
      setResult(next);
      setStats(await jobRequest(`/api/checks/${project}/stats`, {}, controller.signal));
    } catch { if (!controller.signal.aborted) setError("提交未确认，可重试同一次作答。"); }
    finally { if (!controller.signal.aborted) { lock.current = false; setPending(false); } }
  };
  return <section style={{ ...cardStyle, padding: 26, display: "grid", gap: 16 }} aria-labelledby="check-title">
    <h2 id="check-title" style={{ margin: 0, fontSize: 22 }}>看懂了吗？做个小检查</h2>
    <p style={{ color: "#a7b4c4", margin: 0, fontSize: 13 }}>题目由作者指定；提交后仅在本机保存匿名作答与错题计数，不记录观看行为。</p>
    {questions.map((question) => <fieldset key={question.id} disabled={pending || Boolean(result)} style={{ border: "1px solid #35414e", borderRadius: 10, padding: 16, minWidth: 0 }}>
      <legend>{question.question}</legend>
      {question.choices.map((choice, index) => <label key={index} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "8px 0" }}><input type="radio" name={question.id} checked={answers[question.id] === index} onChange={() => setAnswers({ ...answers, [question.id]: index })} />{choice}</label>)}
    </fieldset>)}
    {error && <p role="alert">{error} <button onClick={() => setReload((value) => value + 1)}>重新加载</button></p>}
    {questions.length > 0 && !result && <button disabled={pending || questions.some((question) => answers[question.id] === undefined)} onClick={() => void submit()} style={{ padding: 12 }}>{pending ? "提交中…" : "核对答案"}</button>}
    {result && <div role="status"><strong>答对 {result.correct} / {result.total}</strong>{result.results.map((entry) => <p key={entry.id}>{entry.correct ? "✓" : "待复习"} · {entry.explanation} <small style={{ color: "#a7b4c4" }}>资料：{entry.source}</small></p>)}<button onClick={() => setReload((value) => value + 1)}>再做一次</button></div>}
    {stats && <details><summary>本机作答记录 · {stats.attempts} 次</summary>{stats.concepts.map((concept) => <p key={concept.concept}>{concept.concept}：{concept.missed} / {concept.answered} 次答错</p>)}<small>{stats.basis}</small></details>}
  </section>;
}
