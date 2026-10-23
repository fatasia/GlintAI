# 运镜、转场、SFX 与图表选型

数值合同在 `packages/video/src/motion.ts`(纯函数,有单测);本文件是创作选型。

## 运镜(camera)

`static | push | pull | pan-left | pan-right | drift`,`intensity` 0..1。

- **镜头是标点**:每动一次先答三问——观众此刻该看哪、这个动是过渡还是重音、上一镜动了什么。
- 看得清就不动;过渡用缓的(push/pan/drift),重音才用快的。
- **有来有回**:不连三镜同向;`consecutive-push` 是 lint 红灯。push 之后用 pull/切景别收。
- drift 首尾回零,适合长旁白;pan 行程上限 ±36px,不会把内容推出安全区。

## 转场(transition.in,10 种)

`fade / slide-left / slide-right / slide-up / wipe / zoom-punch / iris / blur / flip / flash`,默认 420ms(120–1200)。

- 不指定时按镜头顺序自动轮换;显式指定后同一种不连用 3 镜(lint 拦)。
- 手感参照:信息页用 wipe/slide-up(干净);章节切换用 iris/zoom-punch(有仪式感);数据结论用 flash(重音,全片 ≤2 次);blur/flip 留给情绪段落。
- 转场作用在场景内容上,字幕与旁白永远稳定可读。

## SFX(项目级 sfx)

`impact / whoosh / sparkle / click / pop / riser`,纯代码合成、确定性、零素材依赖。

- 每个可见动作有声音:落定=impact、换场=whoosh、数据点亮=sparkle、条目进场=pop、章节抬起=riser(全片 ≤2 次)。
- `word` 对齐旁白词(CJK 单字滑窗匹配词级时间戳);匹配不到落在场景开头,交付时要说明。
- 音量 gain 0..1,默认 0.5;成片前可选 `audio-master` 做统一母带。

## 图表(chartType,6 种)

| 类型 | 数据形状 | 什么时候用 |
|---|---|---|
| bar / line | `{label, value}` | 类目对比 / 趋势;>12 点必须有 heading |
| area | `{label, value}` | 累积/增长叙事(「越陡越快」) |
| pie | `{label, value}` | 占比构成,4–6 块;占比文字自动标注 |
| scatter | 每点需 `value2` | 两变量关系;X=value,Y=value2,双轴独立 |
| combo | 每点需 `value2` | 柱(量)+线(率)双信息,`seriesLabel2` 标线 |

数据超过 6 点自动分页(pie 除外);负值支持(bar/line/area);所有动画帧驱动、可逐帧复现。

## 已知边界(诚实)

- 转场是「入厂转场」(每镜开头),没有跨镜叠化(需要时间线重叠支持,未实现)。
- 2.5D 深度视差(parallax)未做——需要每镜声明前后景层;当前 camera 是整镜 2D 变换。
- 节拍网格是能量法启发式(librosa 级精度未引入),卡点切点渲后必须复核。
