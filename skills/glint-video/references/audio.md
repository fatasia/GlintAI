# 声音体系:三层模型与离线档

结构借鉴 lemo-opuscar 的「环境/拟音/音乐」三层与 −14 LUFS 交付标准(见 attribution.md);实现全在本仓库,零外部素材依赖。

## 三层

1. **旁白(主)**:9 种 TTS 引擎,词级时间戳驱动字幕与 SFX 钉帧。`--tts=auto` 走 edge→(win)sapi→报错;`mock` 是静音测试。
2. **音乐(垫)**:`--music=` 五选——`off` / `synth`(代码合成,确定性,seed 复现)/ `auto`(ffmpeg 氛围垫)/ 网关(Suno 类)/ MiniMax / 用户文件。默认音量 0.12–0.14,永远垫在旁白下。
3. **音效(点)**:项目 `sfx` 数组,6 种预设,渲前合成进 `public/audio/sfx/`,渲中按词级时间戳钉帧;plate 导出时剥离。

## 交付母带

`pnpm glint audio-master --music=x [--voice=旁白混音] --out=y.wav`:
- 有 voice:sidechain ducking(音乐在说话时自动下沉)+ loudnorm;
- 无 voice:仅 loudnorm;
- 目标 −14 LUFS(`--lufs` 可调;单通 loudnorm 实测落点误差 ≤0.5 LU)。

注意:render 内部的音乐是低音量直混(不经母带);要交付级母带,把 render 用的音乐文件单独跑 audio-master 后再作为 `--music=文件` 重渲,或接受当前混音(实测足够垫底)。

## 卡点流程

1. `pnpm glint beats --audio=bgm.wav --out=beats.json`(能量法:BPM 折叠到 70–180,10ms 网格)。
2. 分镜切点/关键词动作对齐 `beatsMs`;合成器配乐则直接按 `--music-seed` 的 bar 网格(84 BPM 默认)写分镜。
3. 渲后复核:qa 的 richness 只管画面;卡点精度自己抽帧核对(参考误差预算 ≤3 帧)。

## 边界

- 合成配乐是「干净可用的垫乐」,不是 Suno 级编曲;要风格化配乐走网关/MiniMax(需凭据)。
- beat 检测对弱起/切分音乐误差大;拿不准就用 `--music=synth` 的确定网格。
- SFX 无 roll/loop;长环境声(雨声/房间底噪)未内置。
