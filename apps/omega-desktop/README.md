# omega-desktop

基于本地 Omega monorepo 的 Electron 桌面端（**方案一：完全自维护，不依赖 npm 官方 pi 包**）。

`omega-desktop` 位于 monorepo 的 `apps/omega-desktop`，作为 npm workspace 成员，
依赖的 `@earendil-works/pi-coding-agent` 解析为本地 `packages/coding-agent`（build 产物 `dist/`）。

## 已验证的能力

- 主进程用 `createAgentSession` 跑真实 agent（Node 环境，bash/文件工具可用）
- **自动加载你的两个插件**：`journal-workflow`、`exploration-scout`（从 monorepo 根 `.pi/extensions`，官方 0.84.2 基线 SDK 直接复用，零迁移）
- 插件真实 WIRED：journal-workflow 写入 `~/.pi/agent/journals`
- 端到端事件流：主进程 agent → IPC → preload → 渲染进程
- **全程使用本地 workspace 包，不依赖 npm 上的 `@earendil-works/pi-*` 官方发布**（`node_modules/@earendil-works/pi-coding-agent` 是 → `packages/coding-agent` 的 junction）

## 结构

```
apps/omega-desktop/
  package.json          # @omega/desktop（workspace 成员）
  electron/
    main.js             # 主进程：建窗口 + 跑 agent + IPC 桥
    preload.js          # CJS 桥：窗口暴露 window.omega.{prompt,onEvent}
    agent-bridge.js     # 主进程内创建 agent session + 加载插件
  index.html            # 渲染进程消息列表
  renderer.js           # 订阅 agent 事件并渲染
  scripts/sdk-check.mjs # 纯 Node 冒烟：验证 SDK + 插件加载 + 回环
```

## 运行（在 monorepo 根先装依赖，再在 apps/omega-desktop 运行）

```bash
# 一次性：electron 二进制（国内镜像）
# $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js
npm start               # 启动桌面端（真实窗口）
OMEGA_AUTOTEST=1 npm start  # 端到端自测：自动发一条 prompt 并打印事件流后退出
npm run sdk-check       # 纯 Node 冒烟（无 GUI），证明本地 workspace 包 + 插件加载
```

## 注意

- 若本地 `packages/coding-agent` 代码有改动，需先 `npm run build` 刷新 `dist/`，omega-desktop 用的是 build 产物。
- 渲染进程当前是**自写的极简事件流**验证；接入 `@earendil-works/pi-web-ui` 的 `ChatPanel`（含工具/附件/artifacts UI）是下一阶段。
- 扩展路径硬编码指向 monorepo 根的 `.pi/extensions`（`agent-bridge.js` 的 `OMEGA_EXT`）。