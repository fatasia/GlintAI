import { applicationUrl } from "./app-url";
import { useEffect } from "react";
import "./docs-page.css";

const repo = "https://github.com/fatasia/GlintAI";

export default function DocsPage({ localDownload = false }: { localDownload?: boolean }) {
  useEffect(() => {
    const scroll = () => {
      const section = window.location.hash.match(/^#\/docs\/(start|install|model|features|data)$/)?.[1];
      if (section) document.getElementById(`docs-${section}`)?.scrollIntoView({ block: "start" });
      else if (window.location.hash === "#/docs") window.scrollTo(0, 0);
    };
    scroll();
    window.addEventListener("hashchange", scroll);
    return () => window.removeEventListener("hashchange", scroll);
  }, []);
  return <div className="docs-page">
    <header className="docs-header">
      <a className="docs-brand" href="#studio">Glint <span>文档</span></a>
      <nav aria-label="文档导航"><a href="#studio">返回工作台</a><a href={applicationUrl(repo)} target="_blank" rel="noreferrer">GitHub ↗</a></nav>
    </header>
    <main className="docs-layout">
      <aside aria-label="文档目录"><p>目录</p><a href="#/docs/start">快速上手</a><a href="#/docs/install">客户端下载</a><a href="#/docs/model">连接模型</a><a href="#/docs/features">创作与导出</a><a href="#/docs/data">数据与隐私</a></aside>
      <article>
        <div className="docs-intro"><p className="docs-kicker">GLINT / GUIDE</p><h1>从想法，到可编辑的视频。</h1><p className="docs-lede">Glint 同时提供 Web 工作台和本地客户端。先用离线草稿整理内容，需要生成素材或配音时再连接服务。</p></div>
        <section id="docs-start"><h2>快速上手</h2><ol><li>在工作台输入主题或导入资料，生成草稿。</li><li>调整分镜、画面和旁白；需要精剪时打开剪辑台。</li><li>检查预览并导出视频。外部生成服务按供应商计费。</li></ol></section>
        <section id="docs-install"><h2>下载客户端</h2>{localDownload ? <><p>下载 Windows 精简便携包，解压后运行安装脚本。该版本需要系统 Node.js 22+、FFmpeg 和 WebView2；部分渲染需要 Chrome 或 Edge。</p><a className="docs-action" href={applicationUrl("/api/download/client")} download>下载 Windows 精简包 ↓</a></> : <><p>Windows 客户端发行版发布在 GitHub Releases。若发行页暂无安装包，表示当前版本尚未发布。</p><a className="docs-action" href={applicationUrl(`${repo}/releases`)} target="_blank" rel="noreferrer">查看客户端发行版 ↗</a></>}<p>源码本地运行需要 Node.js、pnpm、FFmpeg 和 Chrome 或 Edge；安装与构建步骤见仓库说明。</p></section>
        <section id="docs-model"><h2>连接模型</h2><p>离线编排不需要模型账号。Web 部署通过服务端环境变量配置模型地址和密钥；工作台的“模型连接”显示可用能力。具体配置方式以运行环境的文档为准。</p><a className="docs-action" href={applicationUrl(`${repo}/blob/main/docs/providers.md`)} target="_blank" rel="noreferrer">查看模型与媒体配置 ↗</a></section>
        <section id="docs-features"><h2>创作与导出</h2><p>生成画布用于组织文本和素材任务；批量混剪按表格和素材库生成工程。纯色抠图与插值放大可在浏览器本地处理；智能主体抠图与 4× AI 超分需要在运行 Glint 的机器上额外配置引擎和模型。</p><p>高级编辑的「章节」管理本机工程快照，切换前备份当前工程；章节 JSON 不包含素材文件。「画面 → 对象与关键帧」支持手绘路径、曲线数据与逐笔动画，可保存工程并导出视频。</p><a className="docs-action" href={applicationUrl(`${repo}/blob/main/docs/web.md`)} target="_blank" rel="noreferrer">查看工作台说明 ↗</a></section>
        <section id="docs-data"><h2>数据与隐私</h2><p>离线操作在运行 Glint 的设备上处理；使用外部模型或配音服务时，相关提示词或素材会发送给对应服务。迁移或升级前请备份工程、素材与配置。</p><a className="docs-action" href={applicationUrl(`${repo}/blob/main/docs/data-lifecycle.md`)} target="_blank" rel="noreferrer">查看数据存放与备份 ↗</a></section>
      </article>
    </main>
  </div>;
}
