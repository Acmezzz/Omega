# journal-workflow：日志与工作流自进化插件

`journal-workflow` 是一个独立的 Pi 扩展，负责两件相互关联但都属于**记忆系统**的能力：

1. 忠实保存主 Agent 的正式执行日志；
2. 从日志中提取、验证和维护可复用工作流。

它不启动 Scout，不注册 `explore_space` / `select_exploration`，不读取探索插件的候选报告，也不把探索结果直接当作工作流证据。

---

## 1. 职责

### 会话日志

程序直接记录事实，LLM 只追加语义提炼 patch：

- 用户输入和主 Agent 正文；
- 每个正式工具调用、参数、结果和成功/失败状态；
- 工具调用前的可见 reasoning 片段；
- 工具目的、实际贡献、结果摘要和后续动作；
- 回合关系、任务本质、交付物、未完成事项和错误摘要。

事实行 append-only，提炼行通过 `seq` 合并，原始 Pi 会话仍可通过 entry id 回查。

普通 journal 对长参数、结果、回复和 reasoning 使用前后保留的受控截断，并记录原文长度和可用片段 ID。完整事件会另外写入受限备份：备份保存扩展实际收到的完整 user/assistant/tool payload（包括实际暴露的 thinking；provider 未提供或已 redacted 的隐藏 COT 无法恢复），不默认进入普通上下文。

当提炼模型认为截断内容不足时，它只能请求备份索引中已有的 fragment ID。系统验证任务范围、敏感权限和字符预算后，只注入请求的局部片段，再进行一次提炼；不会把整个备份放进上下文。

### 工作流库

L1/L2/L3 表示执行粒度，不是功能分类：

```text
L1 模板      细粒度、通用的最小工具组合
L2 工作流    中等粒度、带检查点、重试和失败分支的专用流程
L3 编排      粗粒度、由多个阶段组成的大型任务骨架
```

功能分类由提取阶段逐步维护在 `catalog.json` 中。分类是扁平的能力摘要，可以同时包含 L1、L2 和 L3；L1/L2/L3 是执行粒度，不是分类维度。每次 `/wf-extract` 在同一轮内分两阶段维护目录：先只尝试把新条目归入已有分类，无法归入的条目才进入新分类提议阶段。阶段失败时不会因为一次 LLM 异常批量创建新分类。

目录只保存类别 ID、名称、简短描述、别名和内部工作流 ID 索引，不复制工作流步骤。运行时先用目录摘要路由功能，再用包含 `level` 的工作流卡片选择具体条目；命中后才按需加载实体详情。

工作流状态：

```text
probation → active → probation → deprecated
```

工作流执行只是正式任务的引导：检查点失败时重试或切换分支，连续失败后硬跳出并恢复自由模式。

---

## 2. 运行方式

默认 `workflowPolicy` 是 `workflow-first`：

```text
before_agent_start
  → 匹配 active 工作流
  → 注入简短 guidance
  → 必要时创建 L2 checkpoint tracker
  → 正式工具调用写入 workflowRef
  → 成功/跳出反馈到 workflow evidence/escapes
```

如果设置为 `off`：

- 仍然记录正式会话日志；
- 仍然运行 LLM 提炼；
- 不匹配、不注入、不执行工作流检查点。

`off` 不会关闭日志功能。

---

## 3. 命令

| 命令 | 作用 |
|---|---|
| `/wf-extract` | 从日志中提取或更新工作流，并在同一轮维护功能目录 |
| `/wf-list` | 查看工作流 registry、状态和证据 |
| `/wf-catalog` | 查看按功能组织的目录类别和成员 |
| `/wf-stats` | 查看项目日志统计和失败记录 |

推荐循环：

```text
主 Agent 正式执行 → journal 自动记录 → /wf-extract（已有类别优先，再为未归类条目提议新类别）→ 工作流库和功能目录演进 → 后续任务得到引导
```

---

## 4. 数据位置

```text
~/.pi/agent/journals/<project-key>/<task-id>/
  task.json      任务元数据
  0001.jl        事实行和提炼 patch（按大小/回合数滚动）
  failures.jl    工作流跳出记录

~/.pi/agent/workflows/
  registry.json   工作流摘要、状态和证据
  catalog.json    按抽象功能组织的目录摘要
  atoms/          L1 实体
  workflows/      L2 实体
  orchestrations/ L3 实体

~/.pi/agent/journal-backups/<project-key>/<task-id>/
  events.jl       完整原始事件 JSONL（受限数据）
  fragments.jl    预切片正文
  index.json      fragment ID、方向、范围和来源索引
```

本插件不创建或写入 `explorations/`、`rounds.jl` 或旧式 `scouts.jl`。

---

## 5. 配置

配置位于 `~/.pi/agent/settings.json` 的 `journalWorkflow` 段：

```json
{
  "journalWorkflow": {
    "enabled": true,
    "journalsRoot": "~/.pi/agent/journals",
    "workflowsRoot": "~/.pi/agent/workflows",
    "auxModel": "provider/model",
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

- `enabled`：是否启用本插件；
- `workflowPolicy`：`workflow-first` 或 `off`；
- `auxModel`：可选的提炼/匹配/校验模型；
- `backupEnabled`：是否保存完整事件备份，默认开启；
- `backupsRoot`：备份根目录；
- `fragmentSize` / `fragmentOverlap`：预切片大小和重叠字符数；
- `captureToolUpdates`：是否捕获高体积的工具流式增量，当前默认关闭；
- `maxFragmentCharsPerRequest` / `maxFragmentsPerRequest`：单次按需补片预算；
- `allowSensitiveFragments`：是否允许把 thinking/reasoning 片段提供给辅助 LLM，默认关闭；
- `PI_JW_DISABLE=1`：临时禁用本插件。

完整备份应视为 restricted/sensitive 数据。它只保证保存 Pi 扩展实际暴露的内容，不保证 provider 未返回的隐藏推理；备份不应放在共享目录中，并应按使用环境设置保留和清理策略。

本插件没有探索预算或探索策略配置。探索配置属于独立的 `exploration-scout` 插件。

---

## 6. 与 exploration-scout 同时使用

两个插件可以在同一个 Pi 会话中加载：

```json
{
  "journalWorkflow": {
    "enabled": true,
    "workflowPolicy": "off"
  },
  "explorationScout": {
    "enabled": true,
    "policy": "explore-first"
  }
}
```

此时：

- `journal-workflow` 记录主 Agent 的正式执行；
- `exploration-scout` 负责独立方案发散；
- 两者使用不同目录和不同状态；
- 探索选择不会激活本插件的工作流；
- 本插件不会把 Scout 候选写入 registry 或 evidence。

如果希望只使用工作流系统，可以不安装或关闭 `exploration-scout`。

---

## 7. 开发与测试

```bash
cd .pi/extensions/journal-workflow
npx vitest run                 # 49 项通过，3 项 live 测试按条件跳过
npx tsc -p tsconfig.check.json # strict 类型检查
```

核心入口：

```text
index.ts / adapter.ts  Pi 生命周期和事件映射
core/journal/          事实日志、完整备份、预切片读取和 LLM 提炼
core/library/          工作流 schema、存储和状态机
core/engine/           匹配、指导、检查点和跳出
core/extractor/        日志到工作流的提取管线
commands.ts            /wf-* 命令
```
