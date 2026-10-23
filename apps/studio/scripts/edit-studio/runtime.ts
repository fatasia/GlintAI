export function editRuntime() {
  const config = JSON.parse(document.getElementById("edit-data")!.textContent!);
  const get = (id: string) => document.getElementById(id)!;
  const src = get("src") as HTMLSelectElement, prompt = get("prompt") as HTMLTextAreaElement;
  const canvas = get("mask") as HTMLCanvasElement, ctx = canvas.getContext("2d")!;
  const labels = config.labels;
  let state: any, selected = "", drawing = false, erasing = false, dirty = false, pointer = false;
  let draft: { preset?: string; prompt: string }[] = [];
  const say = (s: string) => { get("status").textContent = s; };
  const imageUrl = (file: string) => "/files/" + encodeURIComponent(file);
  async function api(route: string, body?: unknown) {
    const response = await fetch(route, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "x-glint-token": config.token }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "请求失败"); return result;
  }
  function select(file: string) {
    selected = file; src.value = file; dirty = false; ctx.clearRect(0, 0, canvas.width, canvas.height);
    const version = state.versions.find((v: any) => v.file === file);
    const before = get("before") as HTMLImageElement; before.src = imageUrl(version?.parent || file);
    (get("after") as HTMLImageElement).src = imageUrl(file);
    const link = get("download") as HTMLAnchorElement; link.href = imageUrl(file); link.download = file;
    get("position").textContent = version ? (version.cost ?? "?") + " 算力 · " + version.model : "原始图";
    before.onload = () => { canvas.width = before.naturalWidth; canvas.height = before.naturalHeight; ctx.clearRect(0, 0, canvas.width, canvas.height); };
    renderTree();
  }
  function renderTree() {
    get("chain").replaceChildren();
    const versions = new Map<string, any>(state.versions.map((v: any) => [v.file, v]));
    const depth = (file: string, seen = new Set<string>()): number => { if (seen.has(file) || seen.size >= 12) return 0; seen.add(file); const parent = versions.get(file)?.parent; return parent && versions.has(parent) ? 1 + depth(parent, seen) : versions.has(file) ? 1 : 0; };
    for (const file of state.images) {
      const li = document.createElement("li"), button = document.createElement("button");
      button.textContent = (versions.has(file) ? "↳ " : "○ ") + file;
      button.style.paddingLeft = (12 + depth(file) * 16) + "px";
      button.setAttribute("aria-current", String(file === selected)); button.onclick = () => select(file); li.append(button); get("chain").append(li);
    }
  }
  async function refresh() {
    state = await api("/api/state"); src.replaceChildren();
    for (const f of state.images) { const o = document.createElement("option"); o.value = f; o.textContent = f; src.append(o); }
    if (!selected || !state.images.includes(selected)) select(state.images[0] || ""); else { src.value = selected; renderTree(); }
    const q = state.queue;
    get("queue").replaceChildren();
    for (const item of q?.items ?? []) { const li = document.createElement("li"); li.textContent = (labels[item.preset] || "自定义") + " · " + ({ pending: "待执行", running: "处理中", completed: "完成", failed: "已停止" } as any)[item.state] + (item.error ? " · " + item.error : ""); get("queue").append(li); }
    const busy = q?.state === "running";
    (get("edit") as HTMLButtonElement).disabled = !state.canEdit || !state.images.length || busy;
    get("resume").hidden = !q || q.state === "completed" || busy;
    get("connection").textContent = state.canEdit ? "本地工作区 · 网关已配置" : "浏览模式 · 网关未配置";
    if (busy) setTimeout(() => { void refresh().catch(e => say(e.message)); }, 1500);
  }
  function renderDraft() { get("draft").replaceChildren(); draft.forEach((item, i) => { const li = document.createElement("li"), remove = document.createElement("button"); li.textContent = (labels[item.preset!] || item.prompt.slice(0, 20)) + " "; remove.textContent = "移除"; remove.onclick = () => { draft.splice(i, 1); renderDraft(); }; li.append(remove); get("draft").append(li); }); }
  for (const [id, text] of Object.entries(config.presets)) { const button = document.createElement("button"); button.textContent = labels[id] || id; button.setAttribute("aria-pressed", "false"); button.onclick = () => { prompt.value = String(text); prompt.dataset.preset = id; get("presets").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === button))); }; get("presets").append(button); }
  prompt.oninput = () => { delete prompt.dataset.preset; };
  src.onchange = () => select(src.value);
  (get("split") as HTMLInputElement).oninput = e => { get("after-wrap").style.clipPath = "inset(0 0 0 " + (e.target as HTMLInputElement).value + "%)"; };
  get("brush").onclick = () => { drawing = !drawing; get("stage").classList.toggle("drawing", drawing); get("brush").setAttribute("aria-pressed", String(drawing)); };
  get("eraser").onclick = () => { erasing = !erasing; get("eraser").setAttribute("aria-pressed", String(erasing)); };
  get("clear").onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; };
  function draw(e: PointerEvent) {
    const r = canvas.getBoundingClientRect(), image = get("before") as HTMLImageElement;
    const scale = Math.min(r.width / image.naturalWidth, r.height / image.naturalHeight), w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    const x = (e.clientX - r.left - (r.width - w) / 2) / w * canvas.width, y = (e.clientY - r.top - (r.height - h) / 2) / h * canvas.height;
    if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) return;
    ctx.globalCompositeOperation = erasing ? "destination-out" : "source-over"; ctx.fillStyle = "#36b779"; ctx.beginPath(); ctx.arc(x, y, Number((get("size") as HTMLInputElement).value) / scale / 2, 0, Math.PI * 2); ctx.fill(); dirty = true;
  }
  // Overlay uses the image's contained rectangle, not the stage's letterbox.
  (get("before") as HTMLImageElement).addEventListener("load", () => { const img = get("before") as HTMLImageElement; const ratio = img.naturalWidth / img.naturalHeight; canvas.style.objectFit = "contain"; canvas.style.aspectRatio = String(ratio); });
  canvas.style.objectFit = "contain";
  canvas.onpointerdown = e => { if (!drawing) return; pointer = true; canvas.setPointerCapture(e.pointerId); draw(e); };
  canvas.onpointermove = e => { if (pointer) draw(e); };
  canvas.onpointerup = canvas.onpointercancel = () => { pointer = false; };
  function maskData() {
    if (!dirty) return undefined;
    const out = document.createElement("canvas"); out.width = canvas.width; out.height = canvas.height;
    const c = out.getContext("2d")!; c.fillStyle = "black"; c.fillRect(0, 0, out.width, out.height);
    const mask = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < mask.data.length; i += 4) { const v = mask.data[i + 3]!; mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = v; mask.data[i + 3] = 255; }
    c.putImageData(mask, 0, 0); return out.toDataURL("image/png");
  }
  get("add").onclick = () => { if (!prompt.value.trim()) return say("先选择预设或输入改动。"); if (draft.length >= 12) return say("单次队列最多 12 项。"); draft.push({ prompt: prompt.value, preset: prompt.dataset.preset }); renderDraft(); };
  get("edit").onclick = async () => {
    try {
      const items = draft.length ? draft : [{ prompt: prompt.value, preset: prompt.dataset.preset }];
      if (!items[0]!.prompt.trim()) return say("先选择预设或输入改动。");
      (get("edit") as HTMLButtonElement).disabled = true;
      await api("/api/queue", { src: selected, items, mask: maskData() }); draft = []; renderDraft(); say("已提交队列。每项从选中的源图生成独立分支，可关闭页面后回来查看。"); await refresh();
    } catch (e: any) { say(e.message); await refresh(); }
  };
  get("resume").onclick = async () => { try { await api("/api/queue/resume", {}); say("继续队列，已付费项只恢复原任务。"); await refresh(); } catch (e: any) { say(e.message); } };
  get("refresh").onclick = () => { void refresh().catch(e => say(e.message)); };
  void refresh().catch(e => say(e.message));
}
