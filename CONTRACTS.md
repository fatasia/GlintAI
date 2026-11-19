# Glint 合同清单（CONTRACTS）

本文件只记录**能被机器判定**的合同：字段归属、禁止内容、版本规则、不变量。每条断言给出代码路径；路径相对仓库根 `glint/`，行号为本次快照。`计划中` = 仓库里没有实现或没有机器检查，不得当作已支持能力。设计稿不是合同（[DESIGN-LANGUAGE](docs/design/DESIGN-LANGUAGE.md) 只规范界面，不定义数据合同）。

## 0. 总表
| # | 合同 | 载体 | 版本字段 | 机器校验入口 | 状态 |
|---|---|---|---|---|---|
| 1 | Project / SceneScript | `SceneScriptProject`（zod，`packages/scenescript/src/types.ts:398`） | `schemaVersion: 1`（`types.ts:400`） | `parseProject`（`packages/scenescript/src/parse.ts:33`） | 已实现 |
| 2 | BuildNode / BuildGraph | `BuildNode`/`BuildGraph`（`packages/buildgraph/src/index.ts:44`、`:58`） | `graph.version: 1`（`:59`） | `createBuildGraph`（`:78`）、`topologicalOrder`（`:107`） | 已实现 |
| 3 | BuildManifest / BuildPlan | `index.ts:181`、`:190` | `version: 1`（`:182`、`:191`） | `loadManifest`（`apps/studio/scripts/build.ts:149`）、`planBuild`（`index.ts:209`） | 已实现 |
| 4 | Snapshot | 无类型、无文件 | 无 | 无 | `计划中` |
| 5 | Receipt / Provenance | `Receipt`/`ProvenanceRange`（`index.ts:302`、`:288`） | `format:"glint-receipt"` + `version: 1`（`:303-304`） | `validateReceipt`（`:323`）、`verifyReceipt`（`build.ts:314`） | 已实现 |

## 1. Project / SceneScript
### 1.1 归属数据
| 区块 | 字段 | 语义 | 代码 |
|---|---|---|---|
| 身份 | `schemaVersion`、`id`、`title`、`language`、`aspect` | 工程身份与画幅；`id` 为 kebab-case | `types.ts:400-408`、`:6-8` |
| 时间基 | `fps`（可选，默认 30） | 只存十进制；精确有理数在渲染前解析 | `types.ts:413`、`frame-rate.ts:26-49` |
| 资料引用 | `knowledgeSources[{id,kind:"markdown",name,digest}]` | 出处引用，不存正文 | `types.ts:366-372` |
| 声音 | `music{src,volume}`、`sfx[{sceneId,word,effect,gain}]` | 配乐与按词触发的音效 | `types.ts:374-396` |
| 主题 | `theme`（名称字符串或 token 覆盖记录） | 设计 token | `types.ts:418-420` |
| 资产身份 | `assets[{id,kind,name,version,refs}]`、`assetRefs[{assetId,version}]` | 版本 pin，场景按版本引用 | `types.ts:81-93`、`:163` |
| 场景 | `scenes[]`，12 种 `kind`（title…chart） | 内容 + 旁白 + 对象 + 轨道 + 运镜 + 转场 | `types.ts:339-352`、`:152-176` |
| 对象层 | `elements`（≤20/场景）、`tracks`（≤40/场景，≤64 关键帧/轨） | 仅 `text`/`rect` 两种；采样只有一份实现 | `types.ts:119-143`、`elements.ts:71-85` |
| 时长 | `narration.durationMs`，缺省由文本估算（下限 800ms） | 场景时长唯一来源 | `timeline.ts:18-26`、`timing.ts:17`、`:39-50` |

### 1.2 禁止数据
| 禁止内容 | 为什么（机器事实） | 代码 |
|---|---|---|
| 绝对路径、URL、`..` 穿越 | `LocalAssetPath` 必须以 `assets/` 开头并逐段白名单校验；`GltfAssetPath` 还要求 `.gltf/.glb` | `assets.ts:4-17` |
| 把 `audioRef`/`music.src` 当工程资产路径 | 二者只是渲染工作区内的字符串，不做路径校验，语义不同 | `types.ts:33`、`:376` |
| DOM / React / GSAP / Three 实例 / GPU 对象 / 供应商任务结构 | 未在 schema 声明的键被 zod 默认 strip，不进解析结果，也不会被传播 | `parse.ts:27-36` |
| 会话运行时状态（播放头、选区、撤销栈） | 属于 `SessionState`，不属于工程文档 | `packages/session/src/index.ts:27-29` |
| 凭据、模型 prompt、任务 ID、素材字节 | 没有任何字段承载；工程只引用路径 | `types.ts:398-424` |
| 任意图层/脚本 | scene `kind`、element `kind`、transition、chartType 均为封闭枚举；`html` 有 1MiB 上限 | `types.ts:47-59`、`:119-142`、`:283-304` |

### 1.3 版本规则
- `schemaVersion` 是字面量 1；写成 2 直接解析失败，不会降级处理（`types.ts:400-404`、`packages/scenescript/src/scenescript.test.ts:79-81`）。
- `schemaVersion` 与 `id` 在会话层不可编辑（`packages/session/src/index.ts:122`）——换版本只能整体重写文件。
- 仓库内**没有迁移器**，见 §7。

### 1.4 不变量
| 不变量 | 机器检查 | 代码 |
|---|---|---|
| 场景 id 唯一 | `superRefine` 收集重复 | `types.ts:425-436` |
| 资料 id 唯一 | 同上 | `types.ts:437-447` |
| 场景内 element id 唯一 | 同上 | `types.ts:448-453` |
| `track.elementId` 必须存在 | 否则报 `unknown element` | `types.ts:454-455` |
| 同一轨道关键帧 `atMs` 唯一 | 重复即报错 | `types.ts:456-461` |
| `assetRefs` 不重复、指向已声明资产、`version` 精确相等 | 未知资产/版本不符即失败 | `types.ts:469-478` |
| 至少 1 个场景、每场景非空旁白 | `scenes.min(1)` + `Narration.text.min(1)` | `types.ts:423`、`:29` |
| 时间线单调：叠化被夹到两侧各留 200ms | `Math.min(requested, dur-200, prev-200)` | `timeline.ts:34-43` |
| 毫秒→帧只走有理数换算，累计边界取整 | `framesForMs`（round half up）、`timelineToFrames` | `frame-rate.ts:36-39`、`timeline.ts:62-80` |
| 同一毫秒、两个渲染器的对象动画取值相同 | 唯一实现 `evaluateElements`；关键帧排序 + 端点 clamp | `elements.ts:46-85` |
| `video`：0.25≤speed≤4、trim 起点必须早于终点 | 抛错而非静默纠正 | `frame-rate.ts:74-83`、`types.ts:258-267` |

## 2. BuildNode / BuildGraph
### 2.1 归属数据
| 字段 | 含义 | 代码 |
|---|---|---|
| `id`、`kind` | 节点身份；kind 为 8 值封闭集合 | `index.ts:17-36`、`:45-46` |
| `inputs[]` | 依赖的**节点 id**，不是文件路径 | `index.ts:47` |
| `params` | 一切影响输出、但不是输入节点的东西；SceneScript 映射里就是渲染器自己的 cache key | `index.ts:48-49`、`build.ts:124-132` |
| `executability` | `deterministic`/`snapshot`/`opaque`，缺省 deterministic | `index.ts:38-39`、`:166` |
| `granularity` | 后端诚实的缓存粒度，缺省 `scene` | `index.ts:41-42`、`:167` |
| `costCny`、`estimatedMs` | 仅用于预算；外部生成节点才应非零 | `index.ts:52-55` |
| `EnvironmentFingerprint` | node/platform/os/resvg/browser/fonts/extra，进摘要 | `index.ts:145-154` |

### 2.2 禁止数据
| 禁止 | 依据 |
|---|---|
| 手工维护的失效列表 | 失效只能经边与 digest 传播（包注释即合同） | `index.ts:3-15` |
| 重复 id、未知输入、自环、环 | 四类 `BuildGraphError` 分别抛出 | `index.ts:63-71`、`:85`、`:97-98`、`:130-132` |
| 超过 100000 节点 / 单节点超过 512 输入 / id 超过 200 字符 | 构造时拒绝 | `index.ts:79-89` |
| 非有限或负的 `costCny`、`estimatedMs` | 构造时拒绝 | `index.ts:92-93` |
| 依赖未声明的隐式输入（字体、浏览器版本、工具链） | 必须进 environment 或 params，否则不参与 digest | `index.ts:156-171` |
| 把 `costCny`/`estimatedMs`/自身 `id` 当作语义输入 | digest 载荷只含 kind/params/executability/granularity/environment/inputs | `index.ts:162-170` |

### 2.3 版本规则
- `BuildGraph.version` 固定为字面量 1（`index.ts:59`、`:103`）。
- `NodeKind`、`Executability`、`Granularity` 是封闭集合，新增取值会让旧读者在 `createBuildGraph` 抛 `invalid-node`（`index.ts:87`、`:90-91`）——属于破坏性变更。
- digest 载荷自带 `version: 1`（`index.ts:163`），它是**摘要算法版本**，不是图版本；改算法必须同时 bump 它，否则老 manifest 的 digest 会与新算法混用且无任何检测。

### 2.4 不变量
| 不变量 | 机器检查 | 代码 |
|---|---|---|
| 拓扑序完整；有环即失败，不挂起 | Kahn + 长度比对 | `index.ts:107-135` |
| 摘要与对象 key 顺序无关 | `canonicalJson` 排序键 | `index.ts:138-143` |
| 摘要与 `inputs` 数组顺序有关 | 数组按声明顺序序列化 | `index.ts:158-161` |
| 缺输入摘要即失败 | `unknown-input` | `index.ts:156-161` |
| 同图 + 同环境 = 同摘要 | `computeDigests` 为纯函数 | `index.ts:173-179` |
| 执行某节点必然使其依赖者重建 | 预算传播只向下游 | `index.ts:232-237` |

## 3. BuildManifest / BuildPlan
### 3.1 归属数据
| 合同 | 字段 | 位置/代码 |
|---|---|---|
| Manifest | `version`、`environment`、`digests`、`profile?`、`createdAt?` | `index.ts:181-188` |
| Manifest 落盘 | `<工程目录>/.glint/manifest.json`，临时文件 + rename 原子写 | `build.ts:20`、`:147-162` |
| `profile` | 上次渲染的 5 个旗标（fast/plate/resolution/tts/music），下次 plan 继承 | `build.ts:177-187`、`:298` |
| Plan | `predicted`、`reused`、`changed`、`forced`、`digests`、`costCny`、`estimatedMs` | `index.ts:190-203` |
| Plan 落盘 | 仅当 `--out=` 显式指定；否则只是返回值 | `build.ts:394-395` |

### 3.2 禁止数据
| 禁止 | 依据 |
|---|---|
| 把 manifest 当交付凭据 | 文档明确它为本机状态并已 gitignore | `docs/build-system.md:36` |
| 在 manifest 里存工程内容副本或产物路径 | 类型里没有这些字段 | `index.ts:181-188` |
| 依赖 manifest 做严格校验 | `loadManifest` 只检查 `version===1` 且 `digests`/`environment` 存在，其余字段不校验 | `build.ts:149-154` |
| 在 plan 里假装精确 | 无 `narration.durationMs` 时 `exact=false`，预算只是近似 | `build.ts:143`、`:204`、`:413` |

### 3.3 版本规则
- 两者 `version` 均为字面量 1（`index.ts:182`、`:191`）。
- `loadManifest` 丢弃 `version !== 1` 的清单（`build.ts:152`）：后果是**全量重建**，不是报错。
- `planBuild` 永远输出 `version: 1`（`index.ts:243`），没有协商字段。

### 3.4 不变量
| 不变量 | 机器检查 | 代码 |
|---|---|---|
| `predicted ∪ reused` = 全部节点，且不交 | 同一次拓扑序过滤 | `index.ts:238-240` |
| `changed ⊆ predicted`、`forced ⊆ predicted` | 分别由 `changed`/`forced` 集合过滤 | `index.ts:246-247` |
| `mustExecute` 指向未知节点即失败 | `unknown-input` | `index.ts:220-223` |
| 首次构建（无 previous）全部视为 changed | `!previous` 分支 | `index.ts:226` |
| `executionOnly` 时以 forced 为起点，内容已缓存则不算 dirty | 注释与实现一致 | `index.ts:228-230` |
| 成本 = 预测节点成本之和，保留 4 位小数 | 求和后四舍五入 | `index.ts:240`、`:249` |
| 显式渲染旗标与上次不同 → 提示缓存键全变 | 对比 `profile` | `build.ts:203` |

## 4. Snapshot（`计划中`）
**没有实现**：没有类型、没有生产者、没有 CLI/MCP 动词、没有校验器。仓库里只预留了枚举槽位，用来在接入时不改格式版本：

| 预留槽位 | 现值/语义 | 代码 |
|---|---|---|
| 节点 kind | `"snapshot/external"` 已在封闭集合中，但 `graphForProject` 从不生成 | `index.ts:25`、`build.ts:122-139` |
| 节点执行性 | `"snapshot"` = 固定外部结果 | `index.ts:38-39` |
| 回执可复现等级 | `"L2"` = 含外部快照；生产代码只会写 L0/L1 | `index.ts:273`、`build.ts:253`、`docs/build-system.md:45` |
| 来源类型 | `"generated"` 与 `model`/`seed` 字段；当前只产出 rendered/footage | `index.ts:285-294`、`build.ts:266-275` |
| 断言等级 | `determinism.level` 只接受 `L0`/`L1` | `apps/studio/scripts/prove.ts:77` |

计划中的语义（`计划中`，未实现，不得引用为现状）：一条 snapshot 记录 = 外部生成结果的固定引用（digest + 来源 + 模型/种子），进入图后表现为 `executability:"snapshot"` 的 `snapshot/external` 节点，`L3` 相应区间 `origin:"generated"`，回执等级升为 `L2`，`verify --rebuild` 对该节点不做像素比对、只校验引用未漂移。以上四项在代码里**均不存在**。

归属数据 / 禁止数据 / 不变量：**均为空**——没有类型就没有字段归属，也没有可判定的不变量，不许在文档或 UI 里声称已支持。版本规则：**不新增格式版本**，接入只允许复用上表的既有槽位（`snapshot/external`、`"snapshot"`、`L2`、`generated`）；若必须改 `NodeKind` 或回执枚举，按 §7.4 属破坏性变更。

## 5. Receipt / Provenance
### 5.1 归属数据
| 字段 | 含义 | 代码 |
|---|---|---|
| `format`/`version` | `"glint-receipt"` + 1 | `index.ts:303-304` |
| `project` | `id`、`revision`、`path?`、`changes?`（`path=value` 编辑，重建时重放） | `index.ts:305`、`build.ts:282`、`:350-356` |
| `reproducibility` | `L0`/`L1`/`L2` | `index.ts:273`、`build.ts:253` |
| `environment` | 生成该成片的环境指纹 | `index.ts:307` |
| `plan` | `predicted`/`actual`/`matches`/`missing`/`extra` | `index.ts:308` |
| `nodes[]` | `id`/`kind`/`digest`/`executability`/`reused`/`costCny`/`wallMs?` | `index.ts:275-283` |
| `recipe` | 重建必须沿用同一组渲染参数 | `index.ts:310-311`、`build.ts:284` |
| `provenance[]` | `frameRange:[start,end]`、`origin`、`source?`、`model?`、`seed?` | `index.ts:288-294` |
| `output` | `path`/`sha256`/`bytes`/`frames?` | `index.ts:313` |
| `verification[]` | `{law: L1/L2/L3, pass, detail?}` | `index.ts:296-300` |
| `totals` | `modelCalls`/`costCny`/`wallMs`/`executed`/`reused` | `index.ts:315` |
| 落盘 | `<out>.receipt.json`，原子写 | `build.ts:297`、`:212-217` |

### 5.2 禁止数据
| 禁止 | 依据 |
|---|---|
| 场景正文、旁白全文、素材字节 | 类型中无字段；工程由 `project.path` + `revision` 定位 | `index.ts:302-316` |
| 凭据、密钥、供应商账号 | 无字段；`totals.modelCalls` 只计数 | `index.ts:315` |
| 审美/正确性结论 | 断言只接受机器谓词，OCR/人工判断一律报错 | `prove.ts:21-39` |
| 伪造 `output.sha256` | 必须是 64 位小写十六进制 | `index.ts:339` |
| 把 `revision` 当文件字节哈希 | 它是对 `parseProject` 之后对象的哈希（未声明字段已被 strip） | `build.ts:47-49`、`:207` |

### 5.3 版本规则
- `format` 必须精确等于 `"glint-receipt"`，`version` 必须为 1，否则拒绝（`index.ts:325-326`）。
- `reproducibility` 的合法值含 `L2`，但生产代码只写 `L0`/`L1`（`build.ts:253`）；L2 依赖 §4 的 Snapshot，`计划中`。
- `validateReceipt` 不拒绝未知字段，因此新增字段对老读者可读；但老读者也不校验它们（无 strict 模式）。

### 5.4 不变量
| 不变量 | 机器检查 | 代码 |
|---|---|---|
| `project.id`/`revision` 非空 | 结构校验 | `index.ts:327` |
| `environment.node`/`platform` 存在 | 结构校验 | `index.ts:329` |
| `plan` 三字段类型正确 | 结构校验 | `index.ts:330` |
| `nodes` 非空，每项 id/digest 非空、executability/reused 合法 | 结构校验 | `index.ts:331-336` |
| `provenance` 存在时必须非空，区间整数且 `0 ≤ start ≤ end` | 结构校验 | `index.ts:344-354` |
| `output.sha256` 64 hex、`bytes` 非负整数、`frames>0` | 结构校验 | `index.ts:337-342` |
| `totals.costCny` 有限、`executed` 整数 | 结构校验 | `index.ts:356` |
| 帧来源每帧恰好被覆盖一次 | `provenanceCovers` | `index.ts:375-385` |
| 结构合法 ≠ 内容可信 | `validateReceipt` 只做结构；内容靠 `verifyReceipt` | `index.ts:322`、`build.ts:314-371` |

## 6. 三条定律 L1 / L2 / L3
| 定律 | 陈述 | 机器检查（唯一判定点） | 代码 | 失败表现 |
|---|---|---|---|---|
| **L1 预算** | 计划的 `predicted` 集合必须等于实际执行集合 | `checkBudget` 求 missing/extra 并置 `matches` | `buildgraph/src/index.ts:261-267`；写入 `build.ts:249-252`、`:286`、`:291`；CLI 断言 `build.ts:412-415`；MCP `mcp.ts:85` | `matches=false`，`--assert-budget` 退出码 1；回执仍写出，`verify` 不复核此项 |
| **L2 产物** | 交付字节与回执声明一致；重建必须可解释 | 文件存在 + sha256 相等 + 字节数相等；ffprobe 可用时解码帧数 = `output.frames`；`--rebuild` 要求字节一致，`reproducibility:"L1"` 时退化为帧差容差（fps=2，变化比例≤0.02） | `build.ts:320-329`、`:360-364`；构建时刻的 L2 条目是自证（`pass` 恒 true，`build.ts:292`） | `verify` 该检查 `pass=false`，`runVerify` 退出码 1（`build.ts:424`） |
| **L3 来源** | 每个交付帧恰好被一条来源区间覆盖，且能追到 rendered/footage | 长度 `frames` 的计数数组，每帧计数必须等于 1；`provenanceCovers` 为同一规则的库内形式 | `buildgraph/src/index.ts:375-385`；构建期 `build.ts:263-279`；校验期 `build.ts:330-337`；`prove` 的 provenance 谓词 `prove.ts:89-94` | 出现缺口、重叠、越界，或回执根本没写 provenance（`build.ts:336`） |

补充事实（属于合同，不是实现细节）：

- 区间是**闭区间** `[start, end]`，`output.frames = 最后一条.end + 1`。`ProvenanceRange` 注释写作 “half-open”（`index.ts:287`），但 `provenanceCovers`（`:382`）、构建期（`build.ts:267-274`）与校验期（`build.ts:332`）都按闭区间遍历——以实现为准，注释待修。
- L1 是**构建期**门禁；`verifyReceipt` 只校验结构、产物、来源覆盖、环境与重建（`build.ts:314-371`），不会因为历史回执的 `plan.matches=false` 而失败。
- L2 的 `encoded-frames` 检查在 ffprobe 不可用时跳过，不会伪报通过（`docs/build-system.md:86`）。
- 环境漂移只对照 6 个键，`environment.extra` 参与 digest（`index.ts:168`）却不参与漂移对照（`index.ts:362`）。

## 7. 兼容与迁移
### 7.1 现状
- 只有一个版本：`schemaVersion=1`；写成 2 直接解析失败（`scenescript.test.ts:79-81`）。
- 仓库**没有迁移函数**，也没有 v2 分支；v1→v2 迁移目前没有实现，属 `计划中`。

### 7.2 加性变更规则（v1 内）
| 变更 | 老 v1 读者行为 | 是否允许 | 依据 |
|---|---|---|---|
| 新增**可选**字段 | 读取时被 zod strip；写回解析对象时**永久丢失**（含 CLI 与 Session） | 允许，但发布说明必须标注“写回丢失”；v2 迁移时统一处理 | `parse.ts:27-36`、`build.ts:467-470` |
| 新增**必填**字段 | 既有文件解析失败 | 不允许（须进 v2） | 同上 |
| 新增枚举值（scene/element kind、transition、chartType、sfx、origin） | union/discriminatedUnion 解析失败 | 不允许在 v1 | `types.ts:339-352`、`:119-142` |
| 字段改名或删除 | 老字段被 strip，值静默消失，不报错 | 不允许 | `parse.ts:33-36` |
| 收紧数值界（如 `overlapMs` 上限） | 既有文件可能突然非法 | 不允许（须 v2 + 迁移器） | `types.ts:46-68` |
| 改语义但形状不变 | 解析通过、画面变了、所有缓存 key 未变 → **静默错误** | 禁止；必须把差异放进 `params`/digest 或 bump `schemaVersion` | `index.ts:162-170` |

### 7.3 v1 → v2 规则（`计划中`：迁移器尚未实现，以下为规则而非现行实现）
1. v2 文件不得被 v1 读取；现状是硬拒绝（`types.ts:400-404`），不要加“尽力解析”回退。
2. 迁移必须是显式函数（输入原始 JSON，输出 v2 工程 + 不可等价项清单），并留下 v1 原文。
3. `schemaVersion` 在会话层不可编辑（`session/src/index.ts:122`），所以迁移只能整体重写文件，不能作为一次普通编辑提交。
4. 迁移后 `revision` 必变，因为它是对解析后对象的哈希（`build.ts:47-49`）——旧回执不会再匹配新文件，这是预期行为。
5. 回执/清单的 `version` **不随工程版本变化**：Receipt 的 `version` 是回执自身格式版本（`index.ts:303-304`），Manifest 同理（`build.ts:152`）。
6. 迁移必须写兼容测试矩阵；当前仓库没有这类测试，属 `计划中`。

### 7.4 构建层不兼容变更的后果
| 变更 | 后果 |
|---|---|
| 新增 `NodeKind` | 旧读者 `invalid-node`（`index.ts:87`） |
| 修改 digest 载荷字段（不加 `version`） | 无任何报错；所有缓存键与老 manifest 对不上，表现为全量重建 |
| 提升 `BuildGraph.version`/`Receipt.version` | 旧 manifest 被忽略（全量重建），旧回执被 `validateReceipt` 拒绝（`index.ts:326`） |

## 8. 不是合同的东西
以下对象要么是机制、要么是派生数据，**不得**被引用为跨入口语义或交付承诺。

| 名称 | 实际所在 | 为什么不是合同 |
|---|---|---|
| `SessionState` / `EditTransaction` | `packages/session/src/index.ts:11-29` | 会话机制：`revision` 是整数计数器而非内容哈希；撤销栈与选区不随成片交付 |
| `TaskReceipt`（会话回执） | `packages/session/src/index.ts:16-20` | 描述一次提交的阶段（refused/dispatched/saved/verified/failed），与交付回执同名不同物 |
| `RenderGraph` | 无 | `计划中`，无实现；现实执行计划是 `BuildGraph` |
| `CapabilityProfile` | 真实数据是 `apps/studio/scripts/capability-catalog.ts:6-15`、`INSPIRATIONS`（`:17-21`） | `计划中`，无版本化 schema；当前目录是产品元数据，不是可校验合同 |
| `.glint/manifest.json` | `build.ts:20`、`:147` | 本机预测缓存，已 gitignore；损坏只导致全量重建 |
| plan 输出 JSON | `build.ts:394` | 诊断快照，无校验器 |
| `.cache/native-scenes` | `build.ts:19` | 私有内容寻址缓存，可随时删除 |
| `<out>.project.json` | `build.ts:263` | 渲染器实际使用的工程副本，是 L3 的输入，不是独立合同 |
| MCP 工具 schema | `apps/studio/scripts/mcp.ts:56-101` | 传输门面，字段是子集：`glint_plan` 无 `plate`/`resolution`（`:62`、`:64`），`glint_build` 有 `plate` 无 `resolution`（`:77`）；不定义语义 |
