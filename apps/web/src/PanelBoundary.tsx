import { Component, type ReactNode } from "react";

/**
 * Keeps a failed lazy chunk from blanking the editor. A missing/corrupt build
 * asset cannot be recovered in place, so the fallback offers a reload.
 */
export class PanelBoundary extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) {
      return <p role="alert" style={{ margin: 0 }}>
        {this.props.label}加载失败，可能是构建文件缺失或版本不一致。请刷新页面重试；当前工程已自动保存，不会丢失。
        <button type="button" style={{ marginLeft: 8 }} onClick={() => location.reload()}>刷新页面</button>
      </p>;
    }
    return this.props.children;
  }
}
