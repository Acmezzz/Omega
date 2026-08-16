# journal-workflow —— Pi 会话日志与工作流库系统

一个运行在 Pi 上的扩展：**忠实记录每一次任务的完整过程，从日志中自动长出可复用工作流，让 agent 越用越聪明**。零修改 Pi 核心代码，纯扩展实现，随时可装卸。

- **对任务零干扰**：被动监听事件，不拦截、不修改任何工具执行，忠实记录成功与失败；
- **可验证**：40 项离线测试（`vitest`）覆盖每个环节，不需启动 pi、不需要 API key、不联网；
- **自进化**：任务 → 日志 → 提取 → 工作流库 → 匹配注入 → 结果反馈 → 工作流更准。

---

## 一、能做什么（四大能力）

### 1. 会话日志 —— 每个任务的“精简大纲 + 完整事实”

每回合自动落盘两层记录（append-only，永不改写）：

| 层 | 内容 | 写入者 |
|---|---|---|
| **事实行** | 用户输入原文、工具调用（名称/参数/结果/成败）、可见 CoT（按工具调用切分，挂在相应工具上）、模型正文、任务结局、原始会话引用 id | 程序（零幻觉） |
| **提炼行** | 任务的本质抽象（taskEssence）、最终交付物（deliverable）、每个工具的**目的**与**实际贡献**（essential/helpful/neutral/wasted）、失败原因与应对、未完成清单 | 一次 LLM 调用（大纲压缩） |

要点：

- **“成功≠有用”**：每个工具调用都会被标注对任务的真实贡献，绕路和废调用一目了然；
- **CoT 可见时**：每个工具调用带着模型当时的决策理由原文（“为什么用 grep 不用 find”）——提炼时摘录而不是猜测；隐藏 CoT 模型自动回退为行为反推；
- **可信**：事实层纯程序抄录；LLM 只做大名纲，缺料填 null、禁止编造；原始全文随时可经 refId 回查。

### 2. 工作流库 —— 三层结构，自动生长

```
L1 模板      3~5 个工具调用的组合（最小共享件，如“定位符号→读实现”）
L2 工作流    一个可自验证的中等任务（3~12 步，带检查点与失败分支）★主粒度
L3 编排      大任务的多阶段骨架（引用 L2，按需演进）
```

- **引用不复制**：重叠内容只存一份，跨任务共享，改进一处全体受益；
- **生命周期**：新提取条目 `probation`（观察，不参与匹配）→ 证据 ≥2 自动 `active`（可被匹配注入）→ 频繁失效自动 `deprecated`；
- **种子示例**：`l1-locate-symbol`（符号定位）与 `l2-fix-failing-test`（修测试四步）随仓库提供。

### 3. 运行时引擎 —— 引导而不绑架

任务到达时匹配工作流（**最小够用**：只需要 L1 就只给 L1，绝不注入多余上下文）：

```
匹配（registry 语义分类，excludes 防错配）
  → 骨架注入系统提示词（几百 token）
  → 执行：检查点校验（实际结果 vs 期望，宁松勿紧）
      ├─ 通过 → 推进下一步
      ├─ 未过 → 重试提示（steer）→ 备选分支
      └─ 连续失败 → 硬跳出：明确声明放弃工作流、自由模式接管（无条件兜底）
  → 结果反馈：引导下完成 → evidence++；跳出 → escapes++（自动降级依据）
```

### 4. 提取器 —— 日志变工作流

`/wf-extract` 一条命令：统计共现模式（跨 ≥3 回合）→ LCS 骨架对齐 → LLM 命名/判重 → 入库（相似归并、新条观察）→ 失败反演（跳出后的成功路径补成备选分支）。**结构决策全程序化，LLM 只管语义**。

---

## 二、快速开始

```bash
# 1. 安装种子工作流（一次性）
mkdir -p ~/.pi/agent/workflows
cp -r .pi/extensions/journal-workflow/fixtures/workflows/seed/* ~/.pi/agent/workflows/

# 2. 启动 pi（项目信任后扩展自动加载）
cd 你的项目 && pi        # 或 ./pi-test.sh（源码运行）

# 3. 验证
/wf-list          # 应列出 3 个种子条目
/wf-stats         # 日志统计

# 4. 正常干活，然后：
/wf-extract       # 从积累的日志提取工作流
/wf-list          # 看新条目（probation → 用两次自动 active）
```

**日常循环**：正常用 pi → 日志自动积累 → 攒 2~3 个同类任务后 `/wf-extract` → 库变强 → 同类任务自动被引导 → 反馈继续强化。

---

## 三、命令速查

| 命令 | 作用 |
|---|---|
| `/wf-extract` | 扫描当前项目日志 → 补提炼待处理回合 → 挖掘/提取/归并 → 更新工作流库 |
| `/wf-list` | 列出库条目（层级/状态/evidence/usage/escapes/意图） |
| `/wf-stats` | 项目日志统计（任务/回合/待提炼/跳出记录） |

---

## 四、数据在哪

```
~/.pi/agent/journals/<project-key>/<task-id>/
    task.json      任务元数据（结局、块索引）
    0001.jl        事实行 + 提炼行（append-only，100 回合或 1MB 滚动分块）
    failures.jl    工作流跳出记录（进化原料）
~/.pi/agent/workflows/
    registry.json  条目索引（状态机）
    atoms/          L1 模板
    workflows/      L2 工作流
    orchestrations/ L3 编排
```

`refId`/`refSequence` 关联回 Pi 原始会话（`~/.pi/agent/sessions/`）——精简日志是派生视图，全文永不丢、可随时重建。

---

## 五、测试（离线环节矩阵）

```bash
cd .pi/extensions/journal-workflow
npx vitest run                 # 40 项，秒级，无 pi/无构建/无网络
npx tsc -p tsconfig.check.json # strict 类型检查
```

| 环节 | 覆盖 |
|---|---|
| J1/J2 | 事实写入、块滚动、半行容忍、提炼补丁合并 |
| D1/D2 | 提炼解析、容错降级（坏输出/截断/网络错误） |
| E1/E2/E3 | 匹配过滤与缓存、骨架注入、检查点状态机（重试→分支→跳出） |
| V1 | 库状态迁移（probation→active→deprecated） |
| X1/X2 | 共现挖掘、LCS 骨架、提取入库、归并去重、失败反演 |
| S1 | 端到端：成功路径 + 跳出路径（FakePi 事件回放 + 脚本化 LLM） |
| live* | 可选：真实模型提示词质量验证（`PI_JW_LIVE=1` 开启） |

测试基建：`FakePi` 事件回放（与生产共用同一段 `wire()` 接线代码）+ 路由式脚本 LLM + 会话语料（本仓库 4 任务 6 回合，提取自真实设计会话，见 `fixtures/corpus/README.md`）。

---

## 六、配置（settings.json 自定义段，全部可选）

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

- 辅助 LLM（提炼/匹配/校验）默认用会话当前模型；`auxModel` 可指定便宜快模型；
- `PI_JW_DISABLE=1` 环境变量可临时整体关闭；
- 想全局生效（所有项目）：把整个目录复制/软链到 `~/.pi/agent/extensions/journal-workflow`。

---

## 七、架构（二次开发入口）

```
index.ts / adapter.ts   Pi 适配层 —— 唯一接触 Pi 扩展 API 的地方
                        （事件→核心输入；注入/steer/命令→Pi 输出）
core/                   纯逻辑，零 Pi 依赖，测试直接打这层
  journal/    事实行写入（writer）、LLM 提炼（distill）、refId 解析
  library/    工作流库 schema（types）与存储/状态机（store）
  engine/     匹配（matcher）、注入（injector）、检查点校验（validator）、执行状态机（tracker）
  extractor/  粗切与共现（segment）、LLM 打包（pack）、主管线（extract）
commands.ts   /wf-extract /wf-list /wf-stats
test/         环节测试（见上）
fixtures/     事件序列 / 会话语料 / 种子工作流 / LLM 响应脚本
```

给扩展加能力的最短路径：`core/` 写纯逻辑（不 import Pi）→ `adapter.ts` 挂事件/命令 → `test/` 加离线用例。

---

## 八、设计取舍（为什么这样做）

- **事实与语义分两层**：程序记事实（永不丢、永不假），LLM 只做大纲压缩——被观察者不写观察记录；
- **行为主义**：骨架/共现/匹配全部基于工具调用序列（推理的外化），不依赖 CoT 可见性，GPT/Claude 在提取层完全拉平；
- **三层渐进披露**：大纲常驻（cross-task 记忆/匹配用）、事实行按需（read 日志文件）、原始会话全文（refId 回查）——逻辑上全提供，物理上不复制；
- **跳出无代价**：工作流只是参考，连续失败时硬跳出 + 自由模式兜底 + 失败记录进库，安全阀永远优先；
- **成本恒定**：每回合一次无状态提炼调用（token 随工具数动态调整），不随会话历史增长；原会话 LLM 自整理的“重发全历史”方案被明确否决（成本爆炸 + 损害忠实性）。

## 九、已知限制与路线

- 任务粒度 = 会话（同一会话多个请求记为同一任务的多个回合，靠 relation 区分）；需要时可改为按意图切分任务；
- `/wf-show <taskId>` 合并视图查看命令暂缺（TURN+PATCH 合并成可读文本）；
- 跨项目库共享、条目命中率统计面板、校验器规则化（替换语义比对）在规划中。