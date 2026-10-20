import { Component, type ReactNode } from "react";

export class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div role="alert" style={{ padding: 20, color: "#ffac98" }}>预览加载失败。检查连接后重新加载页面；草稿保存在本机。 <button type="button" onClick={() => location.reload()}>重新加载</button></div>;
    return this.props.children;
  }
}
