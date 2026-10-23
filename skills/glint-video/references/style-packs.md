# 风格包:选型与审美红线

`pnpm glint styles` 是唯一权威清单(名称/定位/规则);本文件只讲怎么选和雷区。

## 选型速查

| 内容类型 | 首选 | 备选 |
|---|---|---|
| 科技/数据/产品讲解 | glint-dark | blackboard-tech、blueprint |
| 教程/操作步骤 | hand-note | whiteboard、mint-clean |
| 历史/行业/叙事复盘 | retro-news | cream-editorial |
| 机制/流程推演 | whiteboard | blackboard-tech |
| 金句/观点/对比 | bold-poster | retro-news |
| 人文/商业深度 | cream-editorial | retro-news |
| 硬件/结构/系统 | blueprint | blackboard-tech |

## 使用规则(写进分镜,不是装饰)

- **一片一套画风一套色板,管到最后一帧**:人、物、图表、字幕全用该包的 token;混搭画风是最重的否决项。
- 强调色 A/B 各固定给一个核心概念,全片不复用;观众靠颜色回指概念。
- 相邻两镜换构图,不换画风;每 2–3 秒要有一个看得见的新变化(转场、元素进场、运镜都算)。
- 每个包的 `rules` 字段(`pnpm glint styles` 输出)优先级高于本文件的泛化建议。

## 审美红线(计数器会拦的)

- **禁蓝紫**:高饱和蓝紫底/深紫星空/霓虹青紫是「一眼 AI 味」的组合;`craft-lint` 拦人工写死的 hex,Q `qa` 拦成片像素占比(>30% 红灯)。用户点名要蓝紫才例外,交付时写明。
- 禁每镜换一种画风的拼贴;禁固定页眉页码逐条淡入的「翻页式 PPT」(qa 的 richness 门禁会量化)。
- 禁大面积纯色空底:背景两层、一直有东西在动;qa 的 empty-frames 门禁红灯。

## 内联覆盖

`theme` 也接受对象覆盖(`{colors:{bg:"#f6f1e3"}}`),用于品牌色对齐;覆盖 bg 落进蓝紫带会被 lint 拦。需要新风格包时:提案 → 按 STYLE_PACKS 的字段补齐 tokens+rules → 出 3 张静帧并排对照 → 加入注册表;没有并排对照不算新风格交付。
