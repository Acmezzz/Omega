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
  styles.css             # 深色桌面 UI tokens 和组件样式
  scripts/sdk-check.mjs  # 纯 Node 冒烟：验证 SDK + 插件加载 + 回环
  test/                  # Electron 边界和 Renderer 静态回归测试
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
- 渲染进程现在使用本地安全 DTO、消息聚合、工具卡片和只读事件展示；不把 thinking、原始工具参数/结果或 restricted fragment 暴露给 Renderer。
- workspace 根 `package-lock.json` 是唯一依赖锁文件；旧的 app 独立 lockfile 已移除。
- 开发环境从 monorepo 加载 `.pi/extensions`；打包环境从 `extraResources/omega-runtime/.pi/extensions` 加载。可用 `OMEGA_EXTENSIONS_ROOT` 覆盖扩展目录，`OMEGA_WORKSPACE` 指定工作区。
- `npm run typecheck` 和 `npm test` 是桌面基础门禁；`npm run package:dir` 使用 electron-builder 生成 unpacked 目录。首次打包需要可访问 Electron 构建缓存或配置企业/国内镜像，当前环境证书失败时不会伪装为成功。
- 当前不支持 Markdown/HTML 原样渲染；消息使用纯文本 DOM 更新，避免模型输出形成 HTML。
