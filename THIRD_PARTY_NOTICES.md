# 第三方组件

Glint 自有代码使用 [MIT](LICENSE)；第三方代码、字体、解码器和适配器保留各自许可，不随 Glint 改为 MIT。

| 组件 | 用途 | 许可与义务 |
|---|---|---|
| [Remotion](https://www.remotion.dev/license) | HTML/CSS 场景渲染适配器 | Remotion 自己的源码可用许可：个人与小微团队免费，更大的公司使用需按其条款获取公司许可；引入本仓库即表示接受其许可 |
| [FFmpeg](https://www.ffmpeg.org/legal.html) | 编码、抽帧、混音（便携包内置二进制） | LGPL/GPL 组件随构建配置不同，内置构建的许可说明随包附带 |
| [resvg](https://github.com/linebender/resvg)（`@resvg/resvg-js`） | SVG 栅格化原生模块 | MPL-2.0 |
| Geist 字体 | 界面字体 | SIL OFL 1.1，随包分发须保留其许可文本 |
| [GSAP](https://gsap.com/standard-license) | HTML 场景时间线（由用户以代码定义动画的渲染运行时） | GSAP 标准许可：含商用在内免费；其「禁止用途」针对免代码可视化动画构建工具，Glint 的 HTML 场景动画由用户代码定义，不在该范围；无代码的设计对象动画与页间转场使用 Glint 自研运行时 |
| 设计对象动画与页间转场运行时 | Glint 自研的小型可按帧求值运行时 | MIT（随 Glint） |
| 本地编码 Agent 适配器（Claude Code / Codex ACP） | 连接用户已安装的编码 Agent | 适配器代码随本仓库 MIT；被连接的 Agent 与其 SDK 各自的许可由用户自行遵守，便携包只在构建机上已安装相应 SDK 时才包含它 |
| [OpenMotion](https://github.com/nexu-io/openmotion) | Motion 简报格式、模板目录形制、参考片复刻工作流（`packages/composer/src/motion-brief.ts`、`template-catalog.ts`、`recreate.ts` 及相关测试） | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)：Glint 中对应文件标注 "Portions derived from OpenMotion (nexu-io/openmotion)"；修改以适配 Glint（SceneScript、zh-CN、自研目录内容）。其模板目录内嵌的第三方素材与品牌引用保留各自权利，未随本仓库分发 |

便携包实际包含 FFmpeg 组件、resvg 原生模块及字体，不能只检查 npm 顶层依赖；打包前建议运行 `node scripts/license-inventory.mjs`（只读本地文件，不安装依赖或运行包内程序）核对实际边界。

引入新的第三方依赖前，先确认其许可允许随 MIT 仓库分发，并在本表登记。
