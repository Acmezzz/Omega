# journal-workflow — Pi 会话日志 + 工作流库扩展

基于 Pi 扩展 API 实现的"日志 → 工作流"系统：忠实记录每个任务的全过程，
从日志自动提取可复用工作流，运行时以最小够用粒度注入、带检查点校验地执行、
失败可跳出、结果反馈进化。**零 Pi 核心代码改动**。

## 架构

```
index.ts / adapter.ts     ← Pi 适配层（唯一接触 ExtensionAPI 的地方）
core/                     ← 纯逻辑（零 Pi 依赖，测试直接打这里）
  journal/                精简日志：事实层(程序) + patch层(LLM提炼)，append-only 分块 JSONL
  library/                工作流库：L1 模板 / L2 工作流 / L3 编排 + registry（引用不复制）
  engine/                 运行时：匹配(最小够用) / 注入(骨架+懒展开) / 检查点校验 / 跳出
  extractor/              提取器：程序粗切+共现挖掘(零随机) + LLM 语义标注/相似度归并
commands.ts               /wf-extract /wf-list /wf-stats
test/                     离线环节测试（fake-pi 事件回放 + 路由式 fake LLM）
fixtures/                 事件序列 / 会话语料 / 种子工作流 / LLM 响应脚本
```

## 数据目录

```
~/.pi/agent/journals/<project-key>/<task-id>/     task.json + 0001.jl(+patch行) + failures.jl
~/.pi/agent/workflows/                            registry.json + atoms/ + workflows/ + orchestrations/
```

project-key 与 Pi 会话目录的 cwd 编码一致（如 `--G--try-agent-demo--`）。

## 运行时行为

1. **记录**：每回合结束（agent_settled）追加事实行；后台异步一次 LLM 提炼写 patch 行；
   崩溃/失败补丁可由提取器离线重放补齐（缺 `extractedAt` 即待补）。
2. **匹配**：`before_agent_start` 时对 registry（仅 active 条目）做一次 LLM 分类，
   取最小够用单元；命中即把骨架追加进系统提示词（`<workflow_guidance>` 块）。
3. **执行**：L2 步骤带 `expect` 的为检查点；工具结果到达时 LLM 语义判定（宁松勿紧，
   判定失败=通过）；未过→重试提示（steer）；耗尽→alternative 分支或**硬跳出**
   （steer 指令 + failures.jl + escape 计数）。自由模式永远兜底。
4. **进化**：引导下完成→evidence++；跳出→escapes++；escapeRate 过阈值自动降级
   active→probation→deprecated。

## 命令

| 命令 | 作用 |
|---|---|
| `/wf-extract` | 扫描当前项目日志 → 共现挖掘/骨架对齐/失败反演 → 更新工作流库 |
| `/wf-list` | 列出库条目（层级/状态/evidence/usage/escapes） |
| `/wf-stats` | 当前项目日志统计（任务/回合/待提炼/跳出数） |

## 测试（离线，秒级，无 pi、无构建、无网络）

```bash
cd .pi/extensions/journal-workflow && npx vitest run        # 38 项环节测试
npx tsc -p tsconfig.check.json                             # strict 类型检查
```

保存结果到文件（注意 vitest 终端输出带 ANSI 颜色码，直接重定向会让记事本显示乱码，
需用 sed 剥离）：

```bash
npx vitest run --reporter=default --reporter=junit \
  --outputFile=test-results/junit.xml > test-results/latest-run.txt 2>&1
sed -i 's/\x1b\[[0-9;]*m//g' test-results/latest-run.txt    # 去除颜色码
```

环节矩阵：J1/J2 事实写入与补丁｜D1/D2 提炼解析与容错｜E1/E2/E3 匹配/注入/执行状态机｜
V1 库状态迁移｜X1/X2 粗切共现与提取入库｜S1 端到端（成功路径 + 跳出路径）。

**live 模式**（可选，验证真实提示词质量）：

```bash
PI_JW_LIVE=1 PI_JW_MODEL="anthropic/claude-haiku-4-5" npx vitest run -t live
# 产物写入 fixtures/live-output/ 供人工审阅；凭据走环境变量（如 ANTHROPIC_API_KEY）
```

## 配置（settings.json 自定义段，全部可选）

```json
{
	"journalWorkflow": {
		"enabled": true,
		"journalsRoot": "~/.pi/agent/journals",
		"workflowsRoot": "~/.pi/agent/workflows",
		"auxModel": "anthropic/claude-haiku-4-5"
	}
}
```

辅助 LLM（提炼/匹配/校验）默认用会话当前模型；`PI_JW_DISABLE=1` 可临时关闭。

## 种子工作流

`fixtures/workflows/seed/` 内含手写示例：`l1-locate-symbol`（符号定位组合）与
`l2-fix-failing-test`（修测试四步：复现◆/定位/修复/验证◆，验证步带 alternative）。
首次使用可复制到 `~/.pi/agent/workflows/`。

## 语料来源

`test/helpers/corpus.ts` 的会话语料（4 任务 6 回合）提取自本系统的设计会话，
场景与预期结果见 `fixtures/corpus/README.md`。真实运行后 `~/.pi/agent/journals/`
的日志可直接替换该语料做回归。
