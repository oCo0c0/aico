[根目录](../../CLAUDE.md) > [src](./..) > **electron**

# Electron 模块（桌面版）

## 模块职责

桌面应用壳层：Electron 主进程管理窗口与生命周期，把既有 Node 服务端作为独立子进程启动，前端复用 SPA（生产=服务端静态页，开发=Vite dev server）。实施计划见 `docs/plans/2026-09-10-desktop-electron.md`。

## 文件清单

| 文件 | 说明 |
|------|------|
| `main.ts` | Electron 主进程：单实例锁、PATH 修复、服务端子进程管理（`ELECTRON_RUN_AS_NODE`）、HTTP 就绪探测、窗口创建、托盘与关闭行为、退出级联清理 |
| `server-bootstrap.ts` | 服务端引导（以纯 Node 模式运行）：删除 `ELECTRON_RUN_AS_NODE` 防泄漏给孙进程；开发走 tsx 源码，生产加载 `dist/cli` |
| `fix-path.ts` | GUI 启动 PATH 修复：登录 shell 提取（带标记解析）+ 兜底目录合并；win32 no-op |
| `fix-path.test.ts` | `extractShellPath` / `mergePath` 纯函数单测 |
| `titlebar-theme.ts`(+test) | 窗口控制按钮覆盖层配色（明暗两套），IPC 运行时切换 |
| `tray-settings.ts`(+test) | 关闭行为设置（ask/tray/quit）持久化到 userData/settings.json |
| `preload.ts` | contextBridge 桥：主题 → 主进程 IPC |

## 启动流程（生产）

1. `app.requestSingleInstanceLock()` 单实例
2. `fixPath()` —— 必须先于任何子进程派生（子进程继承主进程环境）
3. `findAvailablePort()` 选端口（开发模式固定 3000，对齐 Vite 代理）
4. `spawn(process.execPath, [dist-electron/electron/server-bootstrap.js], {env: {ELECTRON_RUN_AS_NODE:'1', ADW_PORT}})` —— 生产日志重定向 `~/.aico/logs/desktop-server.log`
5. HTTP 轮询 `127.0.0.1:port` 就绪后 `loadURL`
6. 退出：`will-quit` → `serverProc.kill()`（POSIX 触发服务端既有 SIGTERM 优雅清理；Windows 为强杀，已知限制）

## 编译与构建

- 编译：`tsconfig.electron.json`（CommonJS → `dist-electron/`，含 `src/cli/port-finder.ts`）
- 命令：`pnpm build:electron`；开发：`pnpm dev:desktop`；打包：`pnpm dist:win|mac|linux`（electron-builder，配置 `electron-builder.yml`，产物 `release/`）
- `package.json` 的 `main` 指向 `dist-electron/electron/main.js`（Electron 入口；npm 包以 `bin: adw` 消费不受影响）

## 关键约束

- **`asar: false`**（electron-builder.yml）——`resources/pi-extensions` 等需被孙进程（pi RPC 子进程、系统 node 运行的 bridge）按真实文件路径读取；electron-builder 锁 24.x 避免 v26 收集器在 CI 触发 EMFILE
- **ADW_PORT 环境变量**（`src/cli/port-finder.ts` 的 `resolvePreferredPort`）保证主进程选的端口与子进程监听端口一致
- **不内嵌 AI 引擎 CLI**（claude/codex/pi），沿用 Provider 运行时自动检测
- macOS/Linux GUI 启动无 shell PATH —— `fix-path.ts` 是所有 CLI 子进程能被找到的前提

## 变更记录 (Changelog)

| 日期 | 操作 | 说明 |
|------|------|------|
| 2026-11-18 | 修复+新增 | **跨平台托盘恢复 + Windows 优雅退出**：① 托盘扩至 win32+darwin（Linux 桌面托盘可用性参差不创建），隐藏到托盘置 `windowHiddenToTray`，`second-instance` 与 macOS `activate` 一律 `showMainWindow()`——此前 mac/Linux 选「最小化到托盘」后窗口无恢复入口只能重启；② **Windows 退出握手**：spawn 追加第 4 路 `ipc` 通道，will-quit 发送 `adw:shutdown`（服务端走与 SIGTERM 相同的清理路径后退出），5 秒超时兜底强杀——此前 `kill()` 是 TerminateProcess，服务端信号清理不运行，bridge/pi RPC/MCP 孙进程全部孤儿化；③ 杂项：宠物窗 title `ADW Pet`→`Aico Pet`；构建配套见根 CLAUDE.md（electron-builder `mac.identity:null`、依赖分区、release 工作流） |
| 2026-09-20 | 修复+新增 | Bongo Cat 输入镜像（用户期望"自己敲键盘猫也敲"，原实现只认 agent 事件流）：① 键盘——主窗口 `webContents.before-input-event` 在主进程直接捕获（无系统级钩子、不干扰输入），按物理键盘左右分区映射左右爪（与 client `lib/paw-side.ts` 同逻辑副本），IME 组合期/纯修饰键跳过；② 鼠标——主窗口渲染层 `mousedown` 经 `notifyInputActivity` IPC 上报；③ 主进程统一转发 `adw:pet-input` 给宠物窗（宠物窗复用主 preload 才能收到），PetRoot/MascotWidget 用 `paw-tap.ts` 命令式摘/挂类重触发单次敲击动画（直改 DOM，免每键 React 重渲染）。范围说明：输入镜像仅应用聚焦时生效（系统级全局钩子需原生模块，暂不引入）；agent 活动流为全局（WS）。dev 模式链路确认：宠物窗 WS 走 vite /ws 代理 |
| 2026-09-20 | 修复 | 玻璃顶栏被原生覆盖层盖死：Windows `titleBarOverlay` 在窗口顶部画不透明实色条，此前 applyTheme 还给整条顶栏强加 `titlebar-solid` 实色（让覆盖层不像补丁的妥协），壁纸在顶栏后完全透不出。改为 **titleBarStyle hidden 无覆盖层 + 前端自绘窗口控制按钮**（client/components/WindowControls.tsx；IPC `adw:window-control` minimize/toggle-maximize/close，close 复用既有关闭行为询问；`adw:maximize-changed` 推送驱动最大化/还原图标切换，preload 暴露 `windowControl`/`onMaximizeChange`）。双击拖拽区切换最大化保留；已知取舍：Win11 原生吸附布局弹层不可用。applyTheme 移除 titlebar-solid 注入，index.css 删除对应实色规则 |
| 2026-09-20 | 更新 | 桌面宠物悬浮窗（Bongo Cat）：main.ts 新增 `createPetWindow`/`destroyPetWindow`（透明 + 无边框 + 无阴影 + screen-saver 层置顶 + skipTaskbar + focusable:false 不抢焦点，默认停靠主屏工作区右下角，页面内 -webkit-app-region 整窗拖拽，位置不持久化）；内容加载主应用 URL 附加 `?pet=1`（前端轻量分支 PetRoot，自持 /ws 连接实时反映 agent 任务动态，主窗口最小化到托盘后宠物依然工作）；新增 IPC `adw:set-pet-visible`（preload 暴露 `window.adwDesktop.setPetVisible`，由悬浮设置面板「吉祥物」开关驱动）；will-quit 时随级联清理销毁 |
| 2026-09-11 | 修复+新增 | ① 桌面包 pi 引擎 `rpc process exited (code 0)` 根因：server-bootstrap 删除 `ELECTRON_RUN_AS_NODE` 后，`process.execPath` 派生的 pi 子进程变成新 GUI 实例、被单实例锁立即退出——`pi-rpc-process.start`/`pi-provider.detectVersion` 在 `ADW_DESKTOP=1` 时显式注入该变量（回归测试覆盖）；② 新增系统托盘（win32：16px 图标、左键恢复、右键 打开/退出）+ 关闭行为询问框（最小化到托盘/直接退出，可记住选择，存 userData/settings.json，隐藏时气泡提示）；③ win 目标增加 `portable` 单文件绿色版（零安装零注册表），nsis 写 HKCU 卸载信息与 orca/VS Code 用户级安装一致（Windows 标准） |
| 2026-09-10 | 创建 | 桌面版里程碑 1：Electron 壳 + 三平台打包配置 + PATH 修复 |
