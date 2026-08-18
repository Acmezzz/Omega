# exploration-scout：独立方案空间探索

`exploration-scout` 是一个独立的 Pi 扩展，用于在主 Agent 正式执行前扩大候选思路空间。它不是日志系统，也不是工作流执行器：

- 不执行正式任务；
- 不修改正式工作区；
- 不提交代码或安装依赖；
- 不创建 `EngineTracker`，不激活 workflow；
- 不写 `journal-workflow` 的 task journal；
- 不增加 workflow usage/evidence；
- 不替主 Agent 排名或选择“最佳”方案。

## 1. 用户流程与边界

```text
中立 TaskBrief
  → explore_space
  → 多个独立 Scout 只读探查
  → ExplorationPacket
  → 主 Agent 自行去重、组合、否定或重设计
  → select_exploration
  → 主 Agent 正式执行并用外部结果验证
```

Scout 只返回未验证的 observation、hypothesis、mechanism、proposal、简单验证、unknown、反证和限制。proposal 可以包含目标、原理、前置条件、步骤、预期证据、回退路径和 `closureStatus=closed|partial`；它不声称任务完成，也不把候选当作执行约束。报告中的观察、原理和候选不包含排名、推荐、评分或置信度。

默认 `policy` 为 `manual`。用户通过 `/exploration-scout` 开启或关闭 Scout 模式；只有模式开启时，插件才在 `before_agent_start` 追加探索协议。显式配置 `policy: "explore-first"` 仍保留旧的自动协议行为，`off` 永久禁用。

TaskBrief 可以包含：

- objective；
- deliverable；
- acceptance criteria；
- constraints；
- 有来源的 known facts；
- unknowns；
- relevant paths；
- forbidden assumptions。

TaskBrief 不能预先写入解决方案、推荐文件、工具序列或根因断言。所有这些字段都会经过方案偏置检查。

## 2. 工具

### `/exploration-scout`

用户控制 Scout 模式，不直接执行候选方案：

```text
/exploration-scout          切换模式
/exploration-scout on       开启模式
/exploration-scout off      关闭模式
/exploration-scout status   查看状态
/exploration-scout <文本>   开启模式，并把文本作为 follow-up 交给主 Agent
```

命令会等待当前 Agent 回合空闲后再切换；模式状态保存在当前 session 的 custom entry 中。命令参数只是用户提供的非可信任务描述，仍由主 Agent 形成并校验中立 TaskBrief。命令不会直接启动 Scout、执行候选方案或激活 workflow。

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
- 按 task 的 round budget 拒绝重复或超预算轮次；
- 启动多个独立的 `pi --no-session` Scout；
- 默认继承当前会话的 provider/model，不强制降低 thinking level；Scout 可以广泛思考、扩展搜索空间，只做简单的只读验证；
- 单个 Scout 默认不限制思考 token、工具调用数、运行时间或原始输出长度；这些字段只有显式配置时才作为失控保护；
- 所有 Scout 使用相同的只读工具白名单：`read,grep,find,ls`；可以自由选择工作区内相关文件和目录，但不能运行 shell、git、网络、写入或安装操作；
- 每轮至少保留一个不接收 focus/prior 详情的 blind `independent` Scout；
- `focus` 只会暴露给定向角色，作为不可信的“待检验问题”，不会被当作既定方案或路径限制；
- 返回受 `maxPacketChars` 限制的 ExplorationPacket；
- 将 round、focus、模型、预算、Scout 状态、报告和真实工具足迹追加到 exploration journal；真实足迹包含实际只读工具、目标路径、查询和成功状态，不等同于 Scout 自己声称检查过的来源；

### `select_exploration`

```text
select_exploration({
  selectedProposalIds,
  combinedPlanSummary?,
  reason?
})
```

它只记录主 Agent 的收敛结果：

- 只能选择当前 round 中真实存在的 proposal ID；
- 拒绝空 ID、重复 ID 和跨 round ID；
- 同一 round 的后续 selection 会作为新的 append-only 事件，读取时采用最新有效选择；
- 不接受 workflowId，不调用 WorkflowStore，不创建 tracker，不执行候选方案。

## 3. Scout 角色和报告约束

角色是轻量搜索起点，不是硬分工：

- `independent`：无偏置、blind，从任务和工作区事实自由开始；
- `prior-first`：优先检查可选 advisory，但其他方向仍可自由搜索；
- `evidence-first`：优先看代码、测试、配置和调用关系；
- `alternative-first`：优先尝试不同的问题分解或证据路径；
- `counterexample-first`：优先寻找前置条件、反例和兼容性风险。

角色顺序会按轮次和任务输入轮换；所有角色的 bias/searchPolicy/allowedTools/contextExposure 都会记录。角色偏好可以被事实推翻，不能限制目录、工具、信息源或结论。证据不足时允许返回 0 个 proposal，不强迫 Scout 编造方案。报告禁止：

```text
best / rank / confidence / recommendation
```

每个 Scout 受只读工具、并发数量、用户取消和进程回收约束；工具调用数、输出字符数和超时只有显式配置时才启用。失败状态包括：

- `completed`；
- `timed_out`；
- `aborted`；
- `budget_exceeded`；
- `parse_failed`；
- `spawn_failed`。

单个 Scout 失败不会阻塞主 Agent，也不会被当作任务完成。

## 4. 持久化、replay 与任务隔离

```text
<explorationsRoot>/<project-key>/<安全编码后的-task-id>/
  rounds.jl
```

`rounds.jl` 保持 append-only，包含两类事件；每次 selection 都有独立的 opaque `selectionId`：

```json
{"kind":"round","record":{...}}
{"kind":"selection","roundId":"...","selection":{...}}
```

读取时会 replay 两类事件，形成 round view：

- round 本身；
- 最新有效 selection；
- adopted proposal IDs；
- combined plan summary；
- skipped/invalid 行统计。

因此 session 重启或重新 wire 后，可以恢复最近有效 round，并继续 `select_exploration`。损坏尾行、孤立 roundId、空 proposal ID 和不存在的 proposal 会被忽略并计入容错统计。selection 不会改写旧 round 行。

任务目录由 project key 和安全编码后的 task ID 组成。task ID 缺失时会清空当前 journal、currentRound 和 user input，不会把新上下文写入旧任务。项目或 task 切换时会重新绑定对应目录。

探索 journal 不是正式执行日志。它不会自动知道主 Agent 是否执行了 selection，也不会自动更新 `verifiedOutcome`。正式执行结果目前需要由其他插件或用户流程单独记录。

## 5. 成本、配置与数据安全

默认预算：

```json
{
  "maxScouts": 3,
  "maxConcurrent": 3,
  "maxProposalsPerScout": 2,
  "maxPacketChars": 18000,
  "maxRoundsPerTask": 2
}
```

配置默认根目录为 `~/.pi/agent`；设置 `PI_CODING_AGENT_DIR` 后，settings 和默认 exploration 数据根目录改用该目录。`explorationsRoot` 支持 `~/...`，相对路径按 agent 目录解析。

示例：

```json
{
  "explorationScout": {
    "enabled": true,
    "explorationsRoot": "~/.pi/agent/explorations",
    "policy": "manual",
    "budget": {
      "maxScouts": 3,
      "maxRoundsPerTask": 2
    }
  }
}
```

- `enabled`：是否加载插件；
- `policy`：`manual`、`explore-first` 或 `off`；默认 `manual`。`manual` 只能由 `/exploration-scout` 开启，`explore-first` 保留兼容的自动协议行为，`off` 永久禁用；
- `budget`：覆盖默认探索预算；
- `PI_EXPLORATION_DISABLE=1`：临时禁用插件。

`auxModel` 目前没有独立模型解析路径，即使配置存在，实际仍使用当前 session model，不应视为已生效能力。

Scout 的子进程只读工作区，但报告、原始输出和 TaskBrief 仍可能包含项目敏感信息。`explorationsRoot` 不应放在共享目录；当前没有自动 retention、压缩或清理命令。

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

没有 provider、没有匹配结果或 provider 失败时，Scout 自动从任务和仓库事实开始探索。命中的 prior 只是 advisory：

- 不创建 tracker；
- 不改变 workflow usage/evidence；
- 不写 workflowRef；
- 不限制工具、目录、信息源或结论。

默认没有 provider。未来即使由另一个插件提供，也不能把 exploration selection 变成 workflow activation。

## 7. 与 journal-workflow 协作

两个插件可以同时加载，但职责和存储完全分开：

```json
{
  "journalWorkflow": {
    "enabled": true,
    "workflowPolicy": "off"
  },
  "explorationScout": {
    "enabled": true,
    "policy": "manual"
  }
}
```

推荐组合：

- 需要方案发散时启用 exploration-scout；
- 需要正式日志和 workflow guidance 时启用 journal-workflow；
- 需要避免 workflow 先验对探索造成启动锚定时，可以将 workflow policy 设为 `off`；
- selection 结果需要由主 Agent 带入正式执行；
- 当前没有自动 `roundId → selectionId → executionId → journal turn → verifiedOutcome` 关联协议；`selectionId` 只作为可选弱关联事件的 opaque 标识。

禁用其中一个插件不会阻止另一个插件独立运行。

## 8. 排障

1. `explore_space` 被拒绝：检查 TaskBrief 中是否包含方案性语言、round 是否重复、`maxRoundsPerTask` 是否已用尽。
2. selection 无法继续：确认当前 task ID、`rounds.jl` 是否存在以及 proposal ID 是否属于最新 round；损坏或不匹配事件会被安全跳过。
3. Scout 运行异常：查看返回的 status；如需失控保护，可显式配置 `maxToolCallsPerScout`、`timeoutMsPerScout` 或 `maxScoutOutputChars`。
4. 找不到数据：检查 `PI_CODING_AGENT_DIR`、`explorationsRoot` 和 task/project identity；配置中的 `~` 会展开到 home 目录。
5. 需要清理：停止任务后备份并删除目标 project/task 目录；当前没有自动 retention 命令。

## 9. 开发与测试

```bash
cd .pi/extensions/exploration-scout
npx tsc -p tsconfig.check.json # strict 类型检查
npx vitest run                 # 25 项通过
```

核心入口：

```text
index.ts / adapter.ts  生命周期、task identity 和 journal replay 恢复
core/                  TaskBrief、角色、prior、报告、packet 和 journal state
runner.ts              Scout 子进程、JSON 事件、预算和取消
tool.ts                explore_space / select_exploration
```

## 10. 已完成、部分可用与后续

### 已完成

- 中立 TaskBrief 与方案偏置检查；
- 多 Scout、只读工具、预算、超时和取消；
- round budget、focus 和 proposal 合法性校验；
- append-only round/selection journal replay；
- session/task 重启后的当前 round 恢复；
- project/task 隔离和安全 task 路径；
- optional prior 的 advisory 边界。

### 部分可用

- selection 已持久化并可恢复，但仍只是主 Agent 的声明；
- `verifiedOutcome` 字段已保留，但正式执行不会自动回写；
- 与 journal-workflow 可以并行使用，但没有强关联 ID；
- 配置、数据和报告有基本边界，但没有自动清理和压缩。

### 后续优先级

1. 接入正式执行生命周期，记录 selected proposal 的实际 tool/turn 范围；
2. 根据 journal 结果回写 `verifiedOutcome`、成功/失败证据和 adopted proposal；
3. 建立可选的 exploration round 与 workflow/task 的关联协议，同时保持插件可独立运行；
4. 自动触发 targeted round、风险反例探索和多轮结果比较；
5. 独立 aux model、retention/清理和更完整的恢复审计。
