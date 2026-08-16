# 会话语料（Session Corpus）

来源：从本设计会话中讨论的任务场景整理而成，作为提取器（M4）与端到端测试（S1）的输入语料。
由 `test/helpers/corpus.ts` 中的 `buildCorpus()` 通过真实 JournalWriter 生成，保证与磁盘格式零漂移。

## 任务清单（4 个任务 / 6 个回合）

| taskId | 说明 | 工具序列 | 结局 | 验证点 |
|---|---|---|---|---|
| task-login-crash-1 | 修复登录崩溃（一次成功） | bash→grep→read→edit→bash | completed | 骨架对齐 |
| task-login-crash-2 | 修复登录崩溃（失败后换思路，relation=fix_failed 链） | t1: bash→grep→read；t2: bash→grep→read→edit→bash | completed（末回合） | relation 链、骨架 |
| task-list-callers | 轻任务：只列调用点不改代码 | bash→grep→read | completed | 最小够用（L1 即可覆盖） |
| task-escape-recover | 工作流引导下检查点失败→跳出→自由模式解决 | t1: bash（workflowRef=l2-fix-failing-test）；t2: bash→grep→read→edit→bash | completed | FailureRecord、alternative 补录 |

## 预期提取结果（X1/X2 断言依据）

- 相邻工具对共现（跨回合去重）：`bash|grep`×5、`grep|read`×5、`read|edit`×3、`edit|bash`×3
- 完成任务骨架（LCS 折叠）：`bash → grep → read`（长度 3，触发 L2 候选）
- "定位符号"组合（grep→read）即设计讨论中的 B+C 跨边界模式——判定与种子 `l1-locate-symbol` 相似时应归并（evidence++）而非新建
- escape-recover 的 failures.jl 应触发对 `l2-fix-failing-test` 步骤 0 的 alternative 补录

## 扩展方式

在 `SESSION_CORPUS` 中追加任务即可；真实运行后 `~/.pi/agent/journals/` 下的日志可直接替换本语料做回归。
