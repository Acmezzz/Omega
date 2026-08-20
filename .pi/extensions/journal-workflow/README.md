# journal-workflow：日志、工作流与可追溯演进

`journal-workflow` 是一个独立的 Pi 扩展，负责正式任务的事实记录和可复用工作流演进：

1. 记录主 Agent 实际收到和执行的正式事件；
2. 在触发上下文压缩时，从事实日志 + 备份预切片**提炼记忆日志**；
3. 由用户手动 `/wf-extract`，基于**记忆日志**通过 LLM 一次生成 L1/L2/L3 工作流并跨功能分类；
4. 在后续任务开始时匹配工作流并提供可验证的执行引导。

它**不启动 Scout**，不注册 `explore_space` / `select_exploration`，不读取探索候选，也不会把探索选择自动算作 workflow evidence。探索空间由独立的 `exploration-scout` 负责。

## 1. 产品边界与能力等级

### 日志链路

```text
Pi 生命周期事件
  → append-only 事实 turn（每回合自动）
  → 受限备份 + 预切片 fragment（每回合自动）
  → 记忆日志 MemoryRecord（触发上下文压缩时，LLM 从事实日志+备份切片刻量提炼）
  → /wf-extract 基于记忆日志提取与演进（仅用户手动触发）
```

程序直接保存事实，LLM 只追加 patch，不改写事实行。普通 journal 保存用户输入、assistant 正文、正式工具调用、参数、结果、状态、可见 reasoning、回合结果和未完成事项。长字段使用 head-tail 截断，并保留原文长度、截断信息和 fragment ID。

### 记忆日志

**记忆日志**是**工作流提取的唯一输入**，区别于主流 LLM 的"纯上下文压缩"：
- **工具调用：完整、忠实、按真实时间顺序**，成功和失败都保留；
- **工具结果：只总结**——成功记录"得到了什么"，失败分析"为什么失败"；
- 用户输入 / LLM 思考 / 输出：LLM 提炼；
- 被截断字段保留备份 fragment ID，需要时可回取完整原文；
- **骨架是数据不是文本**：工具序列是结构化字段，可由程序校验（幻觉调用、漏报、状态翻转均可检出）。

因为底层事实日志和备份始终在，压缩清除上文不会丢失信息。记忆日志是**分段覆盖的日志流**，append-only 存储于
`<journalsRoot>/<project-key>/<task-id>/memory/`：

```text
coverage.json   # 覆盖水位：distilledUpTo、stale、segments 索引
seg-<NNN>.json  # 蒸馏段（JSONL append-only）
```

**触发与覆盖水位**（统一机制，消除短任务采样偏差）：
- `session_before_compact` → 蒸馏至当前 seq（compact 段）；
- `session_shutdown` → 补齐剩余 gap（新增，一等路径）+ 追加整任务 review（outcome）；
- 短任务（从不压缩）在 shutdown 时一次性全量蒸馏，不再被漏掉；
- task 重开 → 旧段不重写，coverage 标 `stale`，下次触发增量续蒸。
- 不变式：`distilledUpTo >= journal maxSeq 且 !stale` → 覆盖完整。

骨架程序化校验由 `/wf-skeleton <task-id>` 查看，覆盖状态由 `/wf-cover` 查看。

完整事件可以另外保存到受限备份。备份只包含扩展实际收到的内容；provider 没有返回或已经 redacted 的隐藏推理无法恢复。敏感 thinking/reasoning 默认不会提供给辅助提炼模型。

#### Schema 三层
每个记忆记录是三层规范：
- `meta`：span（fromSeq/toSeq）、trigger（compact/shutdown/manual）；
- `skeleton`：结构化工具调用序列（完整忠实、程序可校验、可渲染）；
- `narrative`：用户意图、思考、长期记忆（强调解释性字段）；
- `review`：仅 shutdown 触发——整任务 outcome + outcomeEvidence + pendingItems（self-assessed，`verifiedOutcome` 的未来挂载点）。

Pi 原生压缩摘要会作为对照数据（`compactions.jl`）按 turn seq 锚定捕获，供将来合并双轨总结系统时对照评估。

### 工作流粒度

L1/L2/L3 是执行粒度，不是功能分类：

```text
L1 模板      细粒度、通用的最小工具组合
L2 工作流    中等粒度、带检查点、重试、备选和 escape 的专用流程
L3 方案      完整任务的解题思路 + 注意事项（advisory，不执行）
```

当前实际支持程度：

- **L1**：可直接作为轻量 guidance 使用；
- **L2**：有运行时 tracker，可推进工具步骤、等待 checkpoint、重试、切换 L1 alternative 和 escape；步骤可用 `run_code` 引用已保存的代码资产；
- **L3（WorkStrategy）**：完整任务的方案（解题思路 + 注意事项 + 引用的 L2/L1），advisory 指导、不执行。

### 存储：按功能 + 渐进披露

工作流**按功能（feature）存放**，而非按层级。每个实体命名带 `l<level>-` 前缀。一个任务贡献的 L1/L2/L3 可跨多个功能类别（例如"做题"的计算、统计、分析分属不同 feature）。渐进披露：先公开 `catalog.json`（功能摘要 + L 语义说明），用户选定功能后再读取其内部工作流。

```text
<workflowsRoot>/
  catalog.json                 # 功能目录：label/description/aliases/levelSemantics + member ids
  features/<feature-id>/
    l1-<id>.json   l2-<id>.json
  workstrategies/<ws-id>.json  # L3 完整任务方案，独立存放，仍被目录索引
  code-assets/                 # 可复用代码资产（含真脚本文件）
    asset-<id>.json   asset-<id>.<ext>
  registry.json                # 扁平索引：id → {featureId, level, intent, status/usage/evidence}
```

L3（WorkStrategy）是**完整任务方案**，提供解题思路与注意事项，advisory 不执行；它单列 `workstrategies/` 目录，但同时带 `featureId` 从而仍能被渐进披露目录索引到。

功能目录由 `catalog.json` 维护，分类可以同时包含不同 level（执行粒度与功能类别正交）。`/wf-extract` 由 LLM 一次性生成工作流并分配功能类别。

工作流 registry 状态：

```text
probation → active → probation → deprecated
```

## 2. 正式运行流程

默认 `workflowPolicy` 为 `workflow-first`：

```text
before_agent_start
  → 目录/registry 路由与工作流匹配
  → 注入 guidance
  → 创建或恢复 L2 tracker
  → 正式工具调用写入 workflowRef
  → checkpoint 通过、重试、alternative 或 escape
  → 完成后增加 evidence，escape 后增加 escapes
```

tracker 当前以任务目录下的 `tracker.json` 保存活动快照。快照包括 workflow ID、步骤数量、当前步骤、retry、已消费 toolCall、工具进度和 alternative 状态。重新打开同一个 task 时，只有 workflow ID 和步骤数量都匹配才恢复；不匹配或损坏时会安全删除快照并从新流程开始。尚未完成的异步 checkpoint 不会被提前写成通过。

tracker 快照是**任务级、版本敏感的恢复**，不是跨版本迁移机制。L3 阶段状态、跨进程完整事件 replay 和未 flush 的内存回合仍不能自动恢复。每次 workflow 激活还会在任务目录追加 `trace.jl`，记录 executionId、workflowRunId、workflow activation、tracker completion、escape 和 recovery hint；`workflow-completed` 只表示流程完成，不等同于用户目标 succeeded。

设置 `workflowPolicy: "off"` 时：

- 仍记录正式日志；
- 仍可进行 LLM 提炼和 `/wf-extract`；
- 不匹配、不注入、不创建 tracker；
- 不关闭备份功能。

## 3. 日志、备份与恢复

### 普通 journal

```text
<journalsRoot>/<project-key>/<task-id>/
  task.json       任务元数据、block 索引和结果
  0001.jl         turn 事实行与 patch 行
  0002.jl         按回合数/字节数滚动的后续 block
  tracker.json    当前活动 L2 tracker 快照（存在时）
  failures.jl     workflow escape 记录
```

事实行是 append-only；patch 通过 `seq` 合并。writer 重开时会扫描已有有效 turn 的最大 seq，避免过期 `task.json.turnCount` 导致重复 seq。block 新建时从实际下一 seq 开始，`task.json` 使用临时文件再 rename，降低半写风险。

坏 JSON 行和缺失 block 会被容错跳过，并通过读取结果的 skipped-line 统计暴露；这不是完整数据修复工具。

### 完整备份

```text
<backupsRoot>/<project-key>/<task-id>/
  events.jl       完整事件 JSONL
  fragments.jl    预切片正文
  index.json      fragment/event 索引
```

备份写入 user、assistant、tool、session 等扩展实际收到的 payload。提炼模型只能先看到受控 journal 和当前 turn 的可用 fragment 摘要；它若返回 `needs`，系统只允许读取白名单 fragment ID，并应用敏感权限、数量和字符预算。

当前同时提供内部按需补片能力和面向用户的 `/journal-restore` 恢复命令。异常退出时，已写入 backup 的事件不会自动重建为 journal turn；未到 `agent_settled` 或 `session_shutdown` 的内存 current turn 可能只存在于 backup。恢复命令默认 dry-run，显式 `--apply` 后才以 append-only 方式补写事实回合。

### 一致性边界

本插件当前不保证：

- 多进程同时写同一个 task 或 workflow root；
- journal、backup、registry、entity、catalog 的跨文件事务一致性；
- 崩溃后所有 append 与索引同时提交；
- backup 的 retention、压缩和自动清理。

备份应被视为 restricted/sensitive 数据，建议放在不共享的目录，并由部署方设置保留和销毁策略。

## 4. 命令与提取水位

| 命令 | 作用 |
|---|---|
| `/wf-extract` | 重新提炼 pending turn，提取/合并工作流，并维护功能目录 |
| `/wf-list` | 查看 registry、level、状态、evidence、usage 和 escapes |
| `/wf-catalog` | 查看抽象功能类别、成员和客观 usage/escape/evidence 统计 |
| `/wf-stats` | 查看项目任务、回合、待提炼数量和 escape 记录 |
| `/journal-restore <task-id> [--dry-run\|--apply]` | 从 backup 事件恢复尚未落盘的事实回合，默认 dry-run |
| `/wf-health [task-id] [--json]` | 只读检查 journal、backup、workflow 和 extraction 数据健康状态 |
| `/wf-trace <task-id>` | 只读查看 workflow execution trace |
| `/wf-show <workflow-id>` | 只读查看 workflow 定义、步骤、checkpoint 和 alternative |
| `/wf-sources <workflow-id>` | 只读查看 workflow evidence 来源摘要 |

推荐循环：

```text
正式执行 → journal 记录 → /wf-extract → 工作流/目录演进 → 后续任务得到 guidance
```

`/journal-restore` 只把已成功写入 backup 的事件恢复为 append-only fact turns；不恢复 workflowRef、tracker、failures、registry evidence、LLM patch 或 entry IDs。默认 dry-run，显式 `--apply` 才写入；重复 apply 对已有 turn seq 返回 no-op。恢复后的回合保持 pending distill，由 `/wf-extract` 处理。

`/wf-health` 是只读检查，不自动 repair/cleanup；报告只输出状态、计数、路径和错误码，不输出 payload、正文或 thinking。`trace.jl` 是任务目录下的 append-only 执行关联 sidecar，只记录 opaque ID、workflow/task/turn 引用、事件类型、结果状态和来源；`/wf-trace`、`/wf-show`、`/wf-sources` 只输出摘要，不输出 payload、正文、thinking 或 restricted fragment。

`/wf-extract` 会把当前项目任务的 task/seq 输入摘要保存到：

```text
<workflowsRoot>/manifests/<projectKey>.json
<workflowsRoot>/.evidence-ledger.json
```

manifest 当前为 version 3，记录 pipeline/schema/prompt/model fingerprint。同一 project、同一批记忆记录、相同 fingerprint 再次执行时会返回 no-op；即使候选计算因新批次或版本变化重新运行，evidence ledger 也会按稳定 evidence key 防止同一来源重复计数。出现新记忆记录或输入摘要变化后才重新运行。这个水位是**同一输入去重**，不是完整事务回滚；registry、实体和 catalog 的多文件提交仍可能在进程崩溃时处于部分完成状态。`--dry-run`/测试调用仍会计算候选，但不会写库或 manifest。

提取恢复已有一个基础路径：`/wf-extract` 首先重新提炼 `extractedAt` 缺失的 turn。离线补提炼目前不自动重建前序 `PrevTurnContext`，因此跨回合语义可能比在线提炼更弱。

## 5. 配置

配置文件默认位于：

```text
~/.pi/agent/settings.json
```

也可以通过 `PI_CODING_AGENT_DIR` 指定配置和默认数据根目录：

```text
PI_CODING_AGENT_DIR=/path/to/agent
```

`journalsRoot`、`workflowsRoot` 和 `backupsRoot` 支持 `~/...`；相对路径按 agent 目录解析。

示例：

```json
{
  "journalWorkflow": {
    "enabled": true,
    "journalsRoot": "~/.pi/agent/journals",
    "workflowsRoot": "~/.pi/agent/workflows",
    "workflowPolicy": "workflow-first",
    "backupEnabled": true,
    "backupsRoot": "~/.pi/agent/journal-backups",
    "fragmentSize": 1000,
    "fragmentOverlap": 100,
    "captureToolUpdates": false,
    "maxFragmentCharsPerRequest": 3000,
    "maxFragmentsPerRequest": 3,
    "allowSensitiveFragments": false,
    "memoryOnCompact": true
  }
}
```

- `enabled`：是否加载插件；
- `workflowPolicy`：`workflow-first` 或 `off`；
- `backupEnabled`：是否保存完整事件备份；
- `memoryOnCompact`：是否在上下文压缩时同步生成记忆日志，默认 true；
- `fragmentSize` / `fragmentOverlap`：预切片大小和重叠字符数；
- `captureToolUpdates`：是否捕获高体积流式增量，默认关闭；
- `maxFragmentCharsPerRequest` / `maxFragmentsPerRequest`：按需补片预算；
- `allowSensitiveFragments`：是否允许把 restricted thinking/reasoning 片段提供给辅助 LLM，默认关闭；
- `PI_JW_DISABLE=1`：临时禁用本插件。

`auxModel` 目前只是保留字段，当前 API 路径仍使用会话模型，没有独立模型解析和切换，不应把它视为已生效配置。

## 6. 与 exploration-scout 协作

两个插件可以同时加载，但存储和状态隔离：

```json
{
  "journalWorkflow": { "enabled": true, "workflowPolicy": "off" },
  "explorationScout": { "enabled": true, "policy": "explore-first" }
}
```

- `exploration-scout` 负责正式执行前的只读候选发散和 selection；
- `journal-workflow` 负责正式工具调用、日志、工作流 guidance 和验证；
- exploration selection 不会自动激活 tracker；
- journal 不会把 Scout 候选自动写入 registry/evidence；
- 当前没有自动的 `roundId → journal turn → verifiedOutcome` 回写协议。

因此完整闭环仍由主 Agent 负责把“选择结果”带入正式执行，并由正式日志和工作流结果验证它。

## 7. 排障与安全建议

1. 没有 guidance：检查 `workflowPolicy`、registry 状态和匹配日志；`probation/deprecated` 不会按 active 路径使用。
2. tracker 从头开始：检查 task ID 是否变化、`tracker.json` 是否损坏或 workflow 步骤是否已更新；不兼容快照会被有意丢弃。
3. 待提炼回合：运行 `/wf-extract`；失败时保持 pending，后续可重试。
4. fragment 不可读：检查 backup 是否启用、fragment ID 是否属于当前 task、敏感权限和预算是否允许。
5. 数据清理：先停用写入，再备份并删除对应 task/workflow/backup 目录；当前没有自动 retention 命令。

## 8. 开发与测试

```bash
cd .pi/extensions/journal-workflow
npx tsc -p tsconfig.check.json # strict 类型检查
npx vitest run                 # 62 项通过，3 项 live 测试按条件跳过
```

核心入口：

```text
index.ts / adapter.ts  Pi 生命周期、事件映射、内容压缩触发的记忆日志、tracker 恢复
core/journal/          事实日志、备份、fragment、提炼
core/memory/           记忆日志：MemoryRecord、append-only 存储、压缩时提炼
core/library/          workflow schema、按功能存储的 store、registry、catalog 和演进
core/engine/           匹配、指导、checkpoint、alternative、escape
core/extractor/        记忆日志 → L1/L2/L3 的 LLM 提炼、水位和目录维护
commands.ts            /wf-* 命令
```

## 9. 已完成、部分可用与后续

### 已完成

- append-only 事实日志与受控 patch；
- head-tail 截断、fragment 索引和受限按需补片；
- **记忆日志（分段覆盖日志流）**：coverage.json 水位 + seg-*.json，压缩/结束统一为"蒸馏至某 seq"；短任务在 shutdown 补齐，消除采样偏差；task 重开标 stale 不重写旧段；
- **Schema 三层**：meta（span/trigger）+ skeleton（结构化工具序列，程序可校验）+ narrative（意图/思考/记忆）；
- **review 段**：shutdown 触发，记录整任务 outcome + outcomeEvidence + pendingItems（self-assessed）；
- **Pi 原生压缩摘要**按 turn seq 锚定捕获（compactions.jl）作对照数据；
- **骨架程序化校验**：`/wf-skeleton` 检出幻觉调用/漏报/状态翻转；`/wf-cover` 查看覆盖水位；
- **按功能存储**：工作流按 feature 目录存放，命名带 `l<level>-`，渐进披露目录；
- **分类抗漂移**：提取时把已有 catalog（含 aliases）放入上下文要求先对齐再新建；`mergeCatalogFeatures` 做确定性去碎片化；
- **L3 WorkStrategy**：完整任务方案独立存于 `workstrategies/`，解题思路 + 注意事项 + 引用 L2/L1，advisory；
- **可复用代码资产**：提取时把模型写过的独立脚本存为 `code-assets/`（含真脚本文件），工作流步骤用 `run_code` 引用；
- **LLM 单次提取** L1/L2/L3 并跨功能分类（输入仅记忆日志）；
- L1/L2 匹配、L2 checkpoint/retry/alternative/escape；
- task 级 tracker snapshot 恢复；
- 提取 watermark（version 4）：输入 = 记忆记录 + coverage 状态指纹，只消费覆盖完整的任务。

### 部分可用

- backup 可记录和读取 fragment，但没有用户 restore/replay；
- `/wf-extract` 只消费 coverage 完整的任务（半覆盖任务默认跳过，需显式接受）；目录/registry 多文件写入仍非事务；
- 代码资产目前由 `run_code` 引用并由模型执行；尚无独立的真 `run_code` 工具执行器（按设计靠模型执行）；
- review 为 self-assessed，尚未有用户确认机制；
- 跨插件可以并行工作，但没有自动执行结果关联。

### 后续优先级

1. backup event replay/restore 与未 flush turn 恢复；
2. extraction phase checkpoint、增量证据 key 和 registry/catalog 事务提交；
3. exploration selection 与正式 journal/验证结果的关联协议；
4. 独立 `auxModel` 模型解析、并发锁和 retention/清理策略；
5. 记忆日志与 work 结果自动回写 `verifiedOutcome`（review 从 self-assessed 升级为 user-confirmed）；
6. 代码资产的跨任务复用校验与清理策略；
7. 用对照数据评估并合并 Pi 原生压缩与自研总结。
