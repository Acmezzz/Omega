# exploration-scout：独立方案空间探索插件

`exploration-scout` 是一个独立的 Pi 扩展，负责在主 Agent 正式执行前扩大候选方案空间。

它不是日志系统，也不是工作流执行器：

- 不执行正式任务；
- 不修改正式工作区；
- 不提交代码；
- 不激活工作流；
- 不写 `journal-workflow` 的 `task.json`、`0001.jl` 或 `failures.jl`；
- 不增加 workflow usage/evidence；
- 不替主 Agent 排名或选择最佳方案。

---

## 1. 运行协议

```text
主 Agent：中立理解 → explore_space → 自己去重/组合/否定 → select_exploration → 正式执行
Scout：独立上下文发散 → 只读轻探查 → 返回事实、假设、候选和未知
```

默认 `policy` 是 `explore-first`。插件只在 `before_agent_start` 追加短协议，主 Agent 是否调用 `explore_space` 由任务情况决定。

TaskBrief 只包含：

- objective；
- deliverable；
- acceptance criteria；
- constraints；
- 有来源的 known facts；
- unknowns；
- relevant paths；
- forbidden assumptions。

它不能预先写入解决方案、推荐文件、工具序列或根因断言。

---

## 2. 两个工具

### `explore_space`

```text
explore_space({
  taskBrief,
  round: 1 | 2,
  focus?,
  includeCounterexample?
})
```

行为：

- 校验中立 TaskBrief；
- 启动多个独立 `pi --no-session` Scout；
- 默认使用当前会话同一 provider/model；
- 默认 `thinking low`；
- 默认只读工具：`read,grep,find,ls`；
- 返回有大小上限的 ExplorationPacket；
- Scout 报告只包含 observation、hypothesis、proposal、unknown 和限制。

### `select_exploration`

```text
select_exploration({
  selectedProposalIds,
  combinedPlanSummary?,
  reason?
})
```

它只记录主 Agent 的收敛结果。它不接受 `workflowId`，不调用 `WorkflowStore`，不创建 `EngineTracker`，也不执行候选方案。

---

## 3. Scout 角色

角色只是搜索顺序偏好，不是硬分工：

- `prior-first`：先看可选 advisory，再继续从零搜索；
- `evidence-first`：先看代码、测试、错误和调用关系；
- `alternative-first`：优先尝试不同的问题分解或证据路径；
- `counterexample-first`：优先找前置条件、反例和兼容性风险。

所有 Scout 都可以读取任何相关信息源，也都必须具备从零探索能力。

报告禁止：

```text
best / rank / confidence / recommendation
```

---

## 4. 成本与取消

默认预算：

```json
{
  "maxScouts": 3,
  "maxConcurrent": 3,
  "maxToolCallsPerScout": 4,
  "maxProposalsPerScout": 2,
  "maxScoutOutputChars": 8000,
  "maxPacketChars": 18000,
  "timeoutMsPerScout": 45000,
  "maxRoundsPerTask": 2
}
```

预算由程序强制执行。每个 Scout 可以返回：

- `completed`；
- `timed_out`；
- `aborted`；
- `budget_exceeded`；
- `parse_failed`；
- `spawn_failed`。

单个 Scout 失败不会阻塞主 Agent，也不会被当作任务完成。

---

## 5. 独立数据位置

```text
~/.pi/agent/explorations/<project-key>/<task-id>/
  rounds.jl       探索轮次和主 Agent 选择（append-only）
```

每一轮记录：

- TaskBrief；
- Scout 模型、角色和状态；
- 工具调用次数、耗时和输出上限；
- optional prior 状态；
- proposals、facts、negative evidence 和 unknowns；
- `selectedProposalIds`；
- 主 Agent 的组合概要；
- 尚未验证的执行结果状态。

这些数据不是主 Agent 的正式执行日志。正式工具调用由其他插件或 Pi 自己处理。

---

## 6. Optional prior

探索插件不直接导入工作流库。它只接受一个可选的只读 `WorkflowPriorProvider`：

```ts
interface WorkflowPriorProvider {
  resolve(taskText: string): Promise<{
    id: string;
    intent: string;
    summary: string;
    reason: string;
  } | null>;
}
```

没有 provider、没有匹配结果或 provider 失败时，Scout 自动从任务和仓库事实开始探索。

命中的 prior 只是 advisory：

- 不创建 tracker；
- 不改变 workflow usage/evidence；
- 不写 `workflowRef`；
- 不限制工具、目录、信息源或结论。

默认没有 provider。未来若另一个插件提供它，也只能提供只读摘要，不能把探索选择变成工作流激活调用。

---

## 7. 与 journal-workflow 同时使用

两个插件可以同时加载，但职责和存储完全分开：

```json
{
  "journalWorkflow": {
    "enabled": true,
    "workflowPolicy": "off"
  },
  "explorationScout": {
    "enabled": true,
    "explorationsRoot": "~/.pi/agent/explorations",
    "policy": "explore-first"
  }
}
```

推荐组合：

- 需要日志记忆时启用 `journal-workflow`；
- 需要方案发散时启用 `exploration-scout`；
- 两者可以同时启用；
- 若工作流插件使用 `workflow-first`，它仍然只是自己的启动行为，不会改变探索插件的职责；
- 若要避免工作流先验对主 Agent 形成启动锚定，可将 `workflowPolicy` 设为 `off`。

关闭本插件：

```text
PI_EXPLORATION_DISABLE=1
```

---

## 8. 开发与测试

```bash
cd .pi/extensions/exploration-scout
npx vitest run                 # 15 项通过
npx tsc -p tsconfig.check.json # strict 类型检查
```

核心入口：

```text
index.ts / adapter.ts  独立 Pi 生命周期和探索状态
core/                  TaskBrief、角色、prior、报告和 packet
runner.ts              Scout 子进程、JSON 事件、预算和取消
core/journal.ts        rounds.jl append-only 存储
tool.ts                explore_space / select_exploration
```
