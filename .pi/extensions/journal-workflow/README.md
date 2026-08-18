# journal-workflow：日志、工作流与可追溯演进

`journal-workflow` 是一个独立的 Pi 扩展，负责正式任务的事实记录和可复用工作流演进：

1. 记录主 Agent 实际收到和执行的正式事件；
2. 在受控上下文中追加 LLM 语义提炼；
3. 从历史任务提取、合并和维护 L1/L2/L3 工作流；
4. 在后续任务开始时匹配工作流并提供可验证的执行引导。

它**不启动 Scout**，不注册 `explore_space` / `select_exploration`，不读取探索候选，也不会把探索选择自动算作 workflow evidence。探索空间由独立的 `exploration-scout` 负责。

## 1. 产品边界与能力等级

### 日志链路

```text
Pi 生命周期事件
  → append-only 事实 turn
  → 受控截断与 fragment 索引
  → LLM 语义 patch
  → /wf-extract 提取与演进
```

程序直接保存事实，LLM 只追加 patch，不改写事实行。普通 journal 保存用户输入、assistant 正文、正式工具调用、参数、结果、状态、可见 reasoning、回合结果和未完成事项。长字段使用 head-tail 截断，并保留原文长度、截断信息和 fragment ID。

完整事件可以另外保存到受限备份。备份只包含扩展实际收到的内容；provider 没有返回或已经 redacted 的隐藏推理无法恢复。敏感 thinking/reasoning 默认不会提供给辅助提炼模型。

### 工作流粒度

L1/L2/L3 是执行粒度，不是功能分类：

```text
L1 模板      细粒度、通用的最小工具组合
L2 工作流    中等粒度、带检查点、重试、备选和 escape 的专用流程
L3 编排      粗粒度、多阶段任务骨架；当前主要是 advisory skeleton
```

当前实际支持程度：

- **L1**：可直接作为轻量 guidance 使用；
- **L2**：有运行时 tracker，可推进工具步骤、等待 checkpoint、重试、切换 L1 alternative 和 escape；
- **L3**：可存储、分类和渲染骨架，但还没有完整的 phase tracker、阶段恢复和阶段级验证。

功能目录由 `catalog.json` 维护，分类可以同时包含不同 level。`/wf-extract` 先匹配已有类别，再为无法归类的条目提议新类别；目录只保存摘要和 entry ID，不复制实体步骤。

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

tracker 快照是**任务级、版本敏感的恢复**，不是跨版本迁移机制。L3 阶段状态、跨进程完整事件 replay 和未 flush 的内存回合仍不能自动恢复。

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
| `/wf-catalog` | 查看抽象功能类别及其成员 |
| `/wf-stats` | 查看项目任务、回合、待提炼数量和 escape 记录 |
| `/journal-restore <task-id> [--dry-run\|--apply]` | 从 backup 事件恢复尚未落盘的事实回合，默认 dry-run |
| `/wf-health [task-id] [--json]` | 只读检查 journal、backup、workflow 和 extraction 数据健康状态 |

推荐循环：

```text
正式执行 → journal 记录 → /wf-extract → 工作流/目录演进 → 后续任务得到 guidance
```

`/journal-restore` 只把已成功写入 backup 的事件恢复为 append-only fact turns；不恢复 workflowRef、tracker、failures、registry evidence、LLM patch 或 entry IDs。默认 dry-run，显式 `--apply` 才写入；重复 apply 对已有 turn seq 返回 no-op。恢复后的回合保持 pending distill，由 `/wf-extract` 处理。

`/wf-health` 是只读检查，不自动 repair/cleanup；报告只输出状态、计数、路径和错误码，不输出 payload、正文或 thinking。

`/wf-extract` 会把当前项目任务的 task/seq 输入摘要保存到：

```text
<workflowsRoot>/manifests/<projectKey>.json
<workflowsRoot>/.evidence-ledger.json
```

manifest 当前为 version 2，记录 pipeline/schema/model/registry/catalog fingerprint。同一 project、同一批 task/seq、相同 fingerprint 和同一提炼状态再次执行时会返回 no-op；即使候选计算因新批次或版本变化重新运行，evidence ledger 也会按稳定 evidence key 防止同一来源重复计数。出现新回合、pending turn 状态变化或输入摘要变化后才重新运行。这个水位是**同一输入去重**，不是完整事务回滚；registry、实体和 catalog 的多文件提交仍可能在进程崩溃时处于部分完成状态。`--dry-run`/测试调用仍会计算候选，但不会写库或 manifest。

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
    "allowSensitiveFragments": false
  }
}
```

- `enabled`：是否加载插件；
- `workflowPolicy`：`workflow-first` 或 `off`；
- `backupEnabled`：是否保存完整事件备份；
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
npx vitest run                 # 56 项通过，3 项 live 测试按条件跳过
```

核心入口：

```text
index.ts / adapter.ts  Pi 生命周期、事件映射和 tracker 恢复
core/journal/          事实日志、备份、fragment、提炼
core/library/          workflow schema、registry、catalog 和演进
core/engine/           匹配、指导、checkpoint、alternative、escape
core/extractor/        日志到工作流的提取、水位和目录维护
commands.ts            /wf-* 命令
```

## 9. 已完成、部分可用与后续

### 已完成

- append-only 事实日志与受控 patch；
- head-tail 截断、fragment 索引和受限按需补片；
- L1/L2 匹配、L2 checkpoint/retry/alternative/escape；
- task 级 tracker snapshot 恢复；
- 同输入 extraction watermark；
- level 隔离的 similarity 和 canonical merge；
- 正交功能目录。

### 部分可用

- backup 可记录和读取 fragment，但没有用户 restore/replay；
- L3 可存储和渲染，但没有 phase tracker；
- `/wf-extract` 可恢复 pending distill，但目录/registry 多文件写入仍非事务；
- 跨插件可以并行工作，但没有自动执行结果关联。

### 后续优先级

1. backup event replay/restore 与未 flush turn 恢复；
2. extraction phase checkpoint、增量证据 key 和 registry/catalog 事务提交；
3. L3 phase tracker、阶段 checkpoint 和恢复；
4. exploration selection 与正式 journal/验证结果的关联协议；
5. 独立 `auxModel` 模型解析、并发锁和 retention/清理策略。
