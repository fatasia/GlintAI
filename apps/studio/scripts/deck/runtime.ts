export function deckRuntime() {
  const data = JSON.parse(document.getElementById("deck-data")!.textContent!);
  const get = (id: string) => document.getElementById(id)!;
  const image = get("scene-image") as HTMLImageElement, previousImage = get("scene-previous") as HTMLImageElement;
  const render = (window as any).__glintRender;
  let audio = get("voice") as HTMLAudioElement, tail = get("voice-tail") as HTMLAudioElement;
  const select = get("outline") as HTMLSelectElement, seek = get("seek") as HTMLInputElement;
  const key = `glint-deck-${data.digest}-${data.variant}`;
  let page = 0, answers: Record<string, number> = {}, attempts: any[] = [], sessionId = crypto.randomUUID();
  let playing = false, generation = 0, globalMs = 0, baseMs = 0, anchor = 0, animation = 0;
  let urls: string[] = [], lastFrame = "", captionKey = "", applyingRemote = false;
  const sender = crypto.randomUUID(), channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(key) : undefined;
  const say = (text: string) => { get("status").textContent = text; };
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (Number.isInteger(saved.page)) page = Math.max(0, Math.min(data.scenes.length - 1, saved.page));
    if (typeof saved.sessionId === "string") sessionId = saved.sessionId;
    if (Array.isArray(saved.attempts)) attempts = saved.attempts.slice(-10000);
    for (const s of data.scenes) { const a = saved.answers?.[s.id]; if (s.quiz && Number.isInteger(a) && a >= 0 && a < s.quiz.options.length) answers[s.id] = a; }
  } catch { /* Storage may be disabled; export still works. */ }
  function save() { try { localStorage.setItem(key, JSON.stringify({ page, answers, sessionId, attempts })); } catch { say("无法保存浏览进度，可使用“导出学习记录”保留本次答题。"); } }
  const localMs = () => Math.max(0, globalMs - data.scenes[page].startMs);
  function caption(ms: number) {
    const scene = data.scenes[page], words = scene.narration.segments?.flatMap((s: any) => s.words ?? []) ?? [];
    const current = words.findIndex((w: any) => ms >= w.startMs && ms < w.endMs);
    const start = Math.max(0, Math.floor(Math.max(0, current) / 24) * 24), nextKey = `${page}:${current}:${start}`;
    if (nextKey === captionKey) return; captionKey = nextKey;
    if (!words.length) { get("caption").textContent = scene.narration.text; return; }
    get("caption").replaceChildren();
    words.slice(start, start + 24).forEach((w: any, i: number) => { const span = document.createElement(start + i === current ? "mark" : "span"); span.textContent = w.text; get("caption").append(span); });
  }
  function paint() {
    const scene = data.scenes[page], fps = data.project.fps ?? 30;
    const frame = Math.min(Math.ceil(scene.durationMs * fps / 1000) - 1, Math.floor(localMs() * fps / 1000));
    const nextKey = `${page}:${frame}`;
    if (nextKey !== lastFrame) {
      lastFrame = nextKey; const nextUrls: string[] = [];
      const set = (node: HTMLImageElement, sceneData: any, frameNo: number) => { const svg = render(data.project, sceneData.scene, frameNo, { plate: true, previousScene: sceneData.previousScene }); const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })); nextUrls.push(url); node.src = url; };
      set(image, scene, Math.max(0, frame));
      const overlap = scene.overlapMs ?? 0, previous = data.scenes[page - 1];
      const blending = previous && overlap > 0 && localMs() < overlap;
      previousImage.hidden = !blending;
      if (blending) set(previousImage, previous, Math.min(Math.ceil(previous.durationMs * fps / 1000) - 1, Math.floor((globalMs - previous.startMs) * fps / 1000)));
      image.style.opacity = blending ? String(localMs() / overlap) : "1";
      for (const url of urls) URL.revokeObjectURL(url); urls = nextUrls;
    }
    seek.value = String(Math.round(localMs() / scene.durationMs * 1000));
    caption(scene.audio && !audio.paused ? audio.currentTime * 1000 : localMs());
    get("time").textContent = `${(localMs() / 1000).toFixed(1)} / ${(scene.durationMs / 1000).toFixed(1)}s`;
  }
  function pause(message = "已暂停") {
    if (playing) globalMs = Math.min(data.totalMs, baseMs + performance.now() - anchor);
    generation++; playing = false; cancelAnimationFrame(animation); audio.pause(); tail.pause(); get("play").textContent = "继续播放"; say(message); paint();
  }
  function result() {
    const scene = data.scenes[page], answer = answers[scene.id];
    get("result").textContent = answer === undefined ? "选一个答案，检查这一页是否讲清楚。" : `${answer === scene.quiz?.answerIndex ? "回答正确。" : "还没讲清楚。可以重新听这一页。"} ${scene.quiz?.explanation ?? ""}`;
    get("answers").querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String(answer === i)));
    const quizzes = data.scenes.filter((s: any) => s.quiz), answered = quizzes.filter((s: any) => answers[s.id] !== undefined), correct = answered.filter((s: any) => answers[s.id] === s.quiz.answerIndex);
    get("learning-summary").textContent = `已答 ${answered.length}/${quizzes.length} · 最新答对 ${correct.length} · 本地记录 ${attempts.length} 次`;
  }
  function mount(index: number, preserveAudio = false) {
    if (preserveAudio) { tail.pause(); const old = tail; tail = audio; audio = old; }
    else { audio.pause(); tail.pause(); }
    page = Math.max(0, Math.min(data.scenes.length - 1, index));
    const scene = data.scenes[page]; lastFrame = ""; captionKey = "";
    audio.removeAttribute("src"); if (scene.audio) { audio.src = scene.audio; audio.load(); }
    audio.ontimeupdate = () => caption(audio.currentTime * 1000);
    audio.onerror = () => { if (playing) pause("旁白读取失败，请检查导出目录中的音频文件。"); };
    image.alt = scene.label; select.value = String(page); get("count").textContent = `${page + 1} / ${data.scenes.length}`;
    (get("previous") as HTMLButtonElement).disabled = page === 0; (get("next") as HTMLButtonElement).disabled = page === data.scenes.length - 1;
    get("progress").style.width = `${(page + 1) / data.scenes.length * 100}%`;
    get("notes").textContent = scene.notes || "本页没有演讲备注。";
    const next = data.scenes[page + 1]; (get("next-image") as HTMLImageElement).src = next?.image ?? scene.image;
    get("next-label").textContent = next ? `下一页：${next.label}` : "已到最后一页";
    get("quiz").hidden = !scene.quiz; get("answers").replaceChildren();
    if (scene.quiz) {
      get("question").textContent = scene.quiz.question;
      scene.quiz.options.forEach((text: string, i: number) => { const b = document.createElement("button"); b.textContent = text; b.onclick = () => { answers[scene.id] = i; attempts.push({ sceneId: scene.id, answer: i, at: new Date().toISOString() }); attempts = attempts.slice(-10000); save(); result(); }; get("answers").append(b); });
    }
    result(); save(); if (!applyingRemote) channel?.postMessage({ type: "page", page, sender });
  }
  async function playAudio() {
    if (!data.scenes[page].audio) return;
    const seconds = localMs() / 1000;
    if (Math.abs(audio.currentTime - seconds) > 0.08) audio.currentTime = seconds;
    await audio.play();
  }
  function tick() {
    if (!playing) return;
    globalMs = Math.min(data.totalMs, baseMs + performance.now() - anchor);
    const next = data.scenes[page + 1], continuous = (get("continuous") as HTMLInputElement).checked;
    if (continuous && next && globalMs >= next.startMs) {
      mount(page + 1, true);
      const token = generation;
      void playAudio().catch(() => { if (token === generation) pause("浏览器阻止了自动播放，请点击“继续播放”。"); });
    }
    paint();
    const scene = data.scenes[page];
    if (globalMs >= data.totalMs || !continuous && globalMs >= scene.startMs + scene.durationMs) { pause("本页播放完毕。"); return; }
    animation = requestAnimationFrame(tick);
  }
  async function play() {
    const token = ++generation;
    if (localMs() >= data.scenes[page].durationMs - 10) globalMs = data.scenes[page].startMs;
    try { await playAudio(); if (token !== generation) return; playing = true; baseMs = globalMs; anchor = performance.now(); get("play").textContent = "暂停"; say(data.scenes[page].audio ? "正在播放旁白，字幕随词高亮。" : "正在播放无声演示。"); animation = requestAnimationFrame(tick); }
    catch { if (token === generation) pause("浏览器阻止了自动播放，请点击“继续播放”。"); }
  }
  function show(index: number, autoplay = false) { pause(""); mount(index); globalMs = data.scenes[page].startMs; paint(); get("play").textContent = "播放演示"; say(data.scenes[page].audio ? "旁白已就绪，点击播放。" : "本页无旁白，仍可播放动画。"); if (autoplay) void play(); }
  data.scenes.forEach((s: any, i: number) => { const o = document.createElement("option"); o.value = String(i); o.textContent = `${i + 1}. ${s.label}`; select.append(o); });
  get("play").onclick = () => playing ? pause() : void play();
  get("previous").onclick = () => show(page - 1, playing); get("next").onclick = () => show(page + 1, playing); select.onchange = () => show(Number(select.value));
  seek.oninput = () => { const resume = playing, value = Number(seek.value); pause(); globalMs = data.scenes[page].startMs + data.scenes[page].durationMs * value / 1000; audio.currentTime = localMs() / 1000; paint(); if (resume) void play(); };
  get("relisten").onclick = () => show(page, true);
  get("presenter-toggle").onclick = () => { get("presenter").hidden = !get("presenter").hidden; get("presenter-toggle").setAttribute("aria-expanded", String(!get("presenter").hidden)); };
  get("presenter-window").onclick = () => { const url = new URL(location.href); url.searchParams.set("presenter", "1"); if (!window.open(url.href, `glint-presenter-${data.digest}`, "width=1280,height=900")) say("请允许弹窗，或使用同页演讲者视图。"); };
  get("fullscreen").onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { say("当前浏览器不允许全屏，请使用浏览器全屏快捷键。"); } };
  get("reset").onclick = () => { answers = {}; attempts = []; sessionId = crypto.randomUUID(); save(); result(); say("已清空本次答题记录。"); };
  get("export-learning").onclick = () => {
    const quizzes = data.scenes.filter((s: any) => s.quiz).map((s: any) => ({ sceneId: s.id, question: s.quiz.question, options: s.quiz.options, answerIndex: s.quiz.answerIndex }));
    const record = { format: "glint-understanding", version: 1, projectId: data.project.id, revision: data.digest, variant: data.variant, sessionId, exportedAt: new Date().toISOString(), quizzes, attempts };
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: "application/json" })), a = document.createElement("a"); a.href = url; a.download = `${data.project.id}-${data.variant}-${sessionId}.learning.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); say("学习记录已导出，不含姓名或账号。可用 glint insights 聚合。");
  };
  channel?.addEventListener("message", e => { const m = e.data; if (!m || m.sender === sender || m.type !== "page" || !Number.isInteger(m.page) || m.page < 0 || m.page >= data.scenes.length) return; applyingRemote = true; try { show(m.page); } finally { applyingRemote = false; } });
  document.addEventListener("keydown", e => { if (e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return; if (e.key === "ArrowRight") { e.preventDefault(); show(page + 1, playing); } if (e.key === "ArrowLeft") { e.preventDefault(); show(page - 1, playing); } if (e.key === " ") { e.preventDefault(); playing ? pause() : void play(); } if (e.key === "Home") show(0); if (e.key === "End") show(data.scenes.length - 1); if (e.key === "Escape") get("presenter").hidden = true; });
  const startedAt = performance.now(); setInterval(() => { const s = Math.floor((performance.now() - startedAt) / 1000); get("clock").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }, 1000);
  image.onerror = () => say("画面读取失败，请检查导出目录。");
  show(page);
  if (new URL(location.href).searchParams.get("presenter") === "1") { get("presenter").hidden = false; get("presenter-toggle").setAttribute("aria-expanded", "true"); }
  window.addEventListener("beforeunload", () => { channel?.close(); cancelAnimationFrame(animation); audio.pause(); tail.pause(); urls.forEach(url => URL.revokeObjectURL(url)); });
}
