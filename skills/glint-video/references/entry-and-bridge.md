# Glint Skill 与产品入口桥接

这份 reference 规定 Skill 与产品不是上下游导入导出关系，而是两个平等入口。

## 进入规则

1. 先识别工程状态：新建、已有工程、任务恢复、冲突待处理。
2. 新建请求生成 `IntentRecord`，再按交付物只路由一次。
3. 已有工程的明确编辑直接进入 route，不重复问意图。
4. 每个 route 只写 ProjectDocument 和 EditTransaction，不写私有工程格式。
5. 修改后必须 lint/check，并按指定时间做 frame readback；没有验证只能返回 dispatched/saved，不得说 verified。

## 产品接续

产品打开同一工程时通过 `ProjectSession` 连接 Skill bridge。Skill 写入必须带 `projectId`、`baseRevision`、目标 handle、前置条件和逆操作。产品收到事务后同步选中对象、播放头、时间线和收据。

## 外部 Agent 接续

没有产品时，Skill 使用 CLI + 本地 journal 完成工作；产品稍后打开时从 journal 恢复工程和任务状态。产品已经打开时，Skill 请求 ProjectSession；版本不匹配就返回冲突，不允许静默覆盖。

## 最短工作流

```text
inspect → route → plan → apply transaction → frame readback → lint/check → render → receipt
```

## 相关合同

- `docs/design/unified-entry-studio-spec.md`
- `ProjectDocument`
- `EditTransaction`
- `CapabilityManifest`
- `TaskReceipt`

## 参考

