# 长视频故事工作流 Skill 设计（待实现）

本文为拟实现的故事工作流合同。StoryBible、CharacterPassport、ShotCard 和 PerformanceSheet 尚不是当前 SceneScript v1 字段；不得直接写入 v1 工程或声称已有命令支持。实现前只使用已验证的现有命令。目标流程：

```text
intent → story bible → character passports → shot cards → storyboard keyframes
→ continuity review → performance sheets → shot generation → assemble → QA → export
```

不要直接把长视频请求压成一个超长 prompt。先生成并保存 `StoryBible`、`CharacterPassport`、`ShotCard` 和 `PerformanceSheet`，用户可以逐阶段批准，也可以选择自主模式。

一致性约束分为 immutable、stable、variable 三层；每个镜头列出 continuityLocks。参考图必须标明用途，模型能力不支持动作、表情、口型或首尾帧时要返回降级信息。

长任务必须使用 DAG/journal：记录输入 revision、provider/model/version、成本、task ID、事件、产物 digest 和重试策略。付费提交状态未知时只恢复 task ID，不重复提交。

LoomArt 和 LibTV 仅作为竞品参考，不接入为执行器或 provider。LoomArt 本机已观察到章节、导演与视频节点入口；未执行生成，不能声称效果已验证。

完整设计见 `docs/design/long-form-story-workflow.md`。
