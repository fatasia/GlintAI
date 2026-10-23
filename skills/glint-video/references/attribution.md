# 研究来源与净室声明(2026-10-21 实库调研)

本 skill 的工作流、门禁与声音体系吸收了 8 个开源视频技能仓库的**方法论**;引入方式分两档,均记录于此。

## 直接引入代码/资产

| 来源 | 许可 | 引入物 | 位置 |
|---|---|---|---|
| video-shotcraft(github.com/Vincentwei1021/video-shotcraft) | Apache-2.0 | 剪映导出的分层原则(plate 底片/切段/文本轨);「手法参考+全部重写」的净室声明格式 | `references/jianying-export.md`、本文件 |

Apache-2.0 要求:保留许可与 NOTICE;未复制其代码,只采用文档化方法与分层原则。

## 方法参考(未复制代码,重新实现)

| 来源 | 许可 | 学了什么 |
|---|---|---|
| lemo-opuscar(MIT) | MIT | 风格=规则书(色彩逻辑/动效质感/镜头词汇/声音调色板);三层声音+−14 LUFS;导演流程 |
| xilo-opus-video(MIT) | MIT | 三方案→预览→确认;逐镜静帧自检;部分重渲;brief 先行 |
| huashu-art-motion(MIT) | MIT | 分镜 lint(空镜/蓝紫/连续推镜/字卡结尾);六种做坏方式;红灯门禁;分档阅读 |
| dashi-animationstyle(MIT) | MIT | 词级字幕→分镜 marks→丰富度量化检查;转场轮换;静帧确认 |
| mg-styles-15(根目录未见 LICENSE 文件,页面自称 MIT) | 待核 | 「代码合成配乐」路线的存在性证明;签名特征概念。**未复制其代码**;采样合成全部为本仓库原创实现 |
| wtt-code-animation-studio(**无 LICENSE**) | 无 | film.json 单一执行来源;素材版本锁思想。**只学做法,不搬代码** |
| video-production-skills(MIT) | MIT | 工序产物可交接;「检查绑定实际文件」;按需修复 |

## 净室纪律

- 动效手法/时序结构/编排逻辑属方法与创意;具体表达(原片画面、美术、文案、品牌)不复用。所有实现为本仓库从零重写。
- 各仓库的样片、demo 源码、提示词原文不进 Glint;风格包的配色/字体为本仓库独立设计,参考的只有「该类别存在哪些风格」这一事实清单。
- 引入任何仓库的代码前,先核对其 LICENSE 文件(不是 README 自述);Wattter_openSkills 无许可,永远只做方法参考。
- 竞品对标的诚实边界:Glint 对 frametell 保持净室(不读源码);对上述仓库的借鉴仅限公开文档与仓库结构所载方法。
