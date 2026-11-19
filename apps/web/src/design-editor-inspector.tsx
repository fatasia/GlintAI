import { useEffect, useRef, useState } from "react";
import { useAuthoringLeaveGuard } from "./authoring-leave";
import { describeDesignNode, designLayers, designStyleProperties, type DesignAlign, type DesignPatch } from "./design-editor-dom";
import "./design-inspector.css";
const alignActions: { key: DesignAlign; label: string; hint: string }[] = [
  { key: "left", label: "左对齐", hint: "以所选图层最左边缘对齐" },
  { key: "centerX", label: "水平居中", hint: "以所选图层水平中心对齐" },
  { key: "right", label: "右对齐", hint: "以所选图层最右边缘对齐" },
  { key: "top", label: "顶对齐", hint: "以所选图层最上边缘对齐" },
  { key: "middleY", label: "垂直居中", hint: "以所选图层垂直中心对齐" },
  { key: "bottom", label: "底对齐", hint: "以所选图层最下边缘对齐" },
  { key: "distributeX", label: "水平分布", hint: "按左边缘等距分布，至少选择三项" },
  { key: "distributeY", label: "垂直分布", hint: "按上边缘等距分布，至少选择三项" },
];
export function DesignInspector({ projectId, html, selected, onSelect, onPatch, pages=[], onMaskEdit, onRegenerate }: { pages?: Array<{id:string;title:string}>; projectId?: string; html: string; selected: string[]; onSelect: (ids: string[]) => void; onPatch: (patch: DesignPatch) => void; onMaskEdit?: () => void; onRegenerate?: () => void }) {
  const node = selected[0] ? describeDesignNode(html, selected[0]) : undefined;
  const [values, setValues] = useState<Record<string, string>>({});
  const root = useRef<HTMLElement>(null);
  useAuthoringLeaveGuard(projectId, () => {
    if (!node) return;
    const baseline: Record<string, string> = { ...node.style, text: node.text };
    for (const input of root.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[name]") ?? [])
      if (input.value !== (baseline[input.name] ?? ""))
        throw new Error("元素属性尚未应用；请先应用属性或还原输入，再离开编辑器。");
  });
  useEffect(() => { setValues(node ? { ...node.style, text: node.text } : {}); }, [html, selected.join(",")]);
  const layers = designLayers(html);
  const propertyDraft=Boolean(node)&&Object.entries(values).some(([key,value])=>value!==(key==="text"?node!.text:node!.style[key]??""));
  function field(key: keyof DesignPatch, label: string, placeholder: string) {
    return <label>{label}<input name={key} aria-label={label} value={values[key] ?? ""} placeholder={placeholder} onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))} /></label>;
  }
  return <aside ref={root} className="design-inspector" aria-label="元素属性">
    <div className="design-panel-head"><strong>元素属性</strong><span>{selected.length > 1 ? `已选 ${selected.length} 项` : node ? `<${node.tagName}>` : "未选择"}</span></div>
    {!node ? <p className="design-hint">在画布点选静态元素，或从图层列表选择。脚本生成的元素不能写回静态源码。</p> : <>
      <div className="design-panel-actions"><button type="button" onClick={() => onPatch({ locked: !node.locked })}>{node.locked ? "解锁元素" : "锁定元素"}</button><button type="button" onClick={() => onSelect([])}>清除选择</button></div>
      <div className="design-panel-actions"><button type="button" disabled={selected.length < 2 || node.locked} onClick={() => onPatch({ group: "group" })}>编组</button><button type="button" disabled={node.locked} onClick={() => onPatch({ group: "ungroup" })}>取消编组</button></div>
      <form onSubmit={event => {
        event.preventDefault();
        const patch: DesignPatch = {};
        for (const key of designStyleProperties) if (values[key] !== node.style[key]) patch[key] = values[key] ?? "";
        if (node.textEditable && selected.length === 1 && values.text !== node.text) patch.text = values.text ?? "";
        onPatch(patch);
      }}>
        <fieldset disabled={node.locked}><legend>{node.locked ? "此元素已锁定" : "文字与外观"}</legend>
          {node.textEditable && selected.length === 1 ? <label>文字<textarea name="text" aria-label="元素文字" value={values.text ?? ""} onChange={event => setValues(previous => ({ ...previous, text: event.target.value }))} /></label> : <p className="design-hint">容器或多选不替换文字，避免删除子元素。请选择具体文字层。</p>}
          <div className="design-property-grid">{field("fontSize", "字号", "16px")}{field("color", "文字颜色", "#ffffff")}{field("backgroundColor", "背景颜色", "transparent")}
            {field("fontFamily", "字体", '"Microsoft YaHei", sans-serif')}{field("fontWeight", "字重", "400")}{field("lineHeight", "行高", "1.5")}{field("letterSpacing", "字距", "0.02em")}
            <label>文字对齐<select name="textAlign" aria-label="文字对齐" value={values.textAlign ?? ""} onChange={event => setValues(previous => ({ ...previous, textAlign: event.target.value }))}><option value="">继承样式</option>{[["left", "左对齐"], ["center", "居中"], ["right", "右对齐"], ["justify", "两端对齐"], ["start", "起始端"], ["end", "结束端"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>定位<select name="position" aria-label="元素定位" value={values.position ?? ""} onChange={event => setValues(previous => ({ ...previous, position: event.target.value }))}><option value="">继承样式</option>{["static", "relative", "absolute", "fixed", "sticky"].map(value => <option key={value}>{value}</option>)}</select></label>
            {field("left", "水平位置", "0px")}{field("top", "垂直位置", "0px")}{field("width", "宽度", "auto")}{field("height", "高度", "auto")}
            {field("padding", "内边距", "12px 16px")}{field("gap", "元素间距", "8px")}{field("borderRadius", "圆角", "8px")}{field("boxShadow", "阴影", "0 4px 16px #00000033")}{field("rotate", "旋转", "0deg")}</div>
          <button type="submit" className="design-primary">应用属性</button>
          <button type="button" onClick={() => setValues({ ...node.style, text: node.text })}>还原属性输入</button>
        </fieldset>
      </form>
      {["a","button"].includes(node.tagName)&&<label>跳转页面<select aria-label="跳转页面" disabled={node.locked||propertyDraft} value={node.pageTarget??""} onChange={event=>onPatch({pageTarget:event.target.value})}><option value="">无页面跳转</option>{node.pageTarget&&!pages.some(page=>page.id===node.pageTarget)&&<option value={node.pageTarget}>未匹配：{node.pageTarget}</option>}{pages.map(page=><option key={page.id} value={page.id}>{page.title}</option>)}</select></label>}
      {node.tagName==="img"&&<fieldset disabled={node.locked||propertyDraft} aria-label="图片修改入口"><legend>图片修改</legend>
        <div className="design-panel-actions"><button type="button" onClick={onMaskEdit}>局部修改（掩膜）</button><button type="button" onClick={onRegenerate}>整图重生</button></div>
        <p className="design-hint">局部修改：在图片上涂抹掩膜，只重画涂过的区域，其余像素保持不变，走报价批准后提交。</p>
        <p className="design-hint">整图重生：不涂掩膜，重新生成整张图片并替换，原图在素材库保留。</p>
      </fieldset>}
      {node.entranceError&&<p role="alert">{node.entranceError} 可选择“无”清除后重新设置。</p>}
      {propertyDraft&&<p className="design-hint">先应用或还原属性输入，再修改入场动画。</p>}
      <fieldset disabled={node.locked||propertyDraft} aria-label="对象入场动画"><legend>对象入场 · 更改立即应用</legend>
        <label>入场<select aria-label="对象入场方式" value={node.entrance?.type??"none"} onChange={event=>onPatch({entrance:{durationMs:600,delayMs:0,...node.entrance,type:event.target.value as "none"|"fade"|"rise"|"zoom"}})}><option value="none">无</option><option value="fade">淡入</option><option value="rise">上移进入</option><option value="zoom">缩放进入</option></select></label>
        <label>时长<select aria-label="对象入场时长" value={node.entrance?.durationMs??600} onChange={event=>onPatch({entrance:{type:"fade",delayMs:0,...node.entrance,durationMs:Number(event.target.value)}})}>{[...new Set([200,400,600,1000,1500,2000,3000,5000,node.entrance?.durationMs??600])].sort((a,b)=>a-b).map(value=><option key={value} value={value}>{value} ms</option>)}</select></label>
        <label>开始时间<select aria-label="对象入场延迟" value={node.entrance?.delayMs??0} onChange={event=>onPatch({entrance:{type:"fade",durationMs:600,...node.entrance,delayMs:Number(event.target.value)}})}>{[...new Set([0,500,1000,1500,2000,3000,5000,8000,10000,node.entrance?.delayMs??0])].sort((a,b)=>a-b).map(value=><option key={value} value={value}>{value/1000} 秒</option>)}</select></label>
        <p className="design-hint">运行交互或播放演示查看动画；HTML 与视频保留入场时间，PNG/PDF/PPTX 保存最终静态画面。</p>
      </fieldset>
      <p className="design-hint">再次拖动已选元素移动；编组成员一起移动，图层列表仍可单独编辑。右下角方块缩放；单选时顶部圆点旋转，按住 Shift 对齐到 15°。流式布局以相对位移保留原布局，复杂网格建议源码调整。</p>
    </>}
    {selected.length > 1 && <section className="design-align" aria-label="对齐与分布">
      <div className="design-align-head"><strong>对齐与分布</strong><span>已选 {selected.length} 项</span></div>
      <div className="design-align-grid" role="group" aria-label="对齐与分布操作">{alignActions.map(action => {
        const needed = action.key.startsWith("distribute") ? 3 : 2;
        return <button key={action.key} type="button" aria-label={action.label} title={selected.length < needed ? `${action.label}需要至少 ${needed} 个图层` : action.hint} disabled={selected.length < needed} onClick={() => onPatch({ align: action.key })}>{action.label}</button>;
      })}</div>
      <p className="design-hint">按内联 left/top 与 width/height 计算；缺少定位或尺寸的图层会提示先补齐，不会猜测位置。</p>
    </section>}
    <details className="design-layers" open><summary>静态图层 · {layers.length}</summary><p className="design-hint">可多选图层并统一修改样式或移动。上移下移改变 DOM 顺序；锁定后属性、对齐与分布都会被拒绝。</p>
      {layers.map(layer => {
        const picked = selected.includes(layer.id);
        return <div key={layer.id} className={`design-layer-row${picked ? " is-selected" : ""}`} data-design-layer={layer.id}>
          <label className="design-layer" title={`${layer.tagName} · ${layer.text}`}><input type="checkbox" checked={picked} onChange={event => onSelect(event.target.checked ? [...selected, layer.id] : selected.filter(id => id !== layer.id))} /><span>&lt;{layer.tagName}&gt; {layer.text || "空元素"}</span>{layer.groupId && <small title={layer.groupId}>编组</small>}{layer.locked && <small>锁定</small>}{!layer.visible && <small>隐藏</small>}</label>
          <div className="design-layer-tools" role="group" aria-label={`图层操作 · ${layer.tagName}`}>
            <button type="button" aria-label="上移图层" title={layer.first ? "已在最前，无法上移" : "与上一个同级元素交换顺序"} disabled={layer.first} onClick={() => onPatch({ target: layer.id, layer: "up" })}>上移</button>
            <button type="button" aria-label="下移图层" title={layer.last ? "已在最后，无法下移" : "与下一个同级元素交换顺序"} disabled={layer.last} onClick={() => onPatch({ target: layer.id, layer: "down" })}>下移</button>
            <button type="button" aria-label={layer.visible ? "隐藏图层" : "显示图层"} aria-pressed={!layer.visible} title={layer.visible ? "用 display:none 隐藏，可再次显示" : "恢复该图层的显示"} onClick={() => onPatch({ target: layer.id, layer: layer.visible ? "hide" : "show" })}>{layer.visible ? "隐藏" : "显示"}</button>
            <button type="button" aria-label={layer.locked ? "解锁图层" : "锁定图层"} aria-pressed={layer.locked} title={layer.locked ? "解锁后恢复编辑" : "锁定后拒绝属性、对齐与拖动"} onClick={() => onPatch({ target: layer.id, locked: !layer.locked })}>{layer.locked ? "解锁" : "锁定"}</button>
          </div>
        </div>;
      })}
    </details>
  </aside>;
}
