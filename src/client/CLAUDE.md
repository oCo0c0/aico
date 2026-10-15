[根目录](../../CLAUDE.md) > [src](./) > **client**

# Client 模块

## 模块职责

React 18 SPA 前端，提供 Aico 的可视化操作界面。包含页面路由、UI 组件库、全局状态管理、API 封装、WebSocket 实时通信、国际化等。

## 入口与启动

- **入口**：`main.tsx` -- 创建 React 根节点，注册 `BrowserRouter` 路由，初始化 i18n，检测 CLI Provider 配置状态
- **构建**：Vite 8，配置 `vite.config.ts`（根目录），`root: 'src/client'`
- **开发代理**：Vite dev server (5173) 代理 `/api/` -> `http://localhost:3000`，`/ws` -> `ws://localhost:3000`

## 对外接口

前端通过 `api.ts` 封装的 HTTP 函数与后端 REST API 通信：

| 函数 | 方法 | 说明 |
|------|------|------|
| `apiGet<T>(path)` | GET | 查询 |
| `apiPost<T>(path, body)` | POST | 创建 |
| `apiPut<T>(path, body)` | PUT | 更新 |
| `apiDelete(path)` | DELETE | 删除 |
| `pickFolder(title?)` | POST | 打开系统文件夹选择器 |

## 页面路由

| 路径 | 文件 | 功能 |
|------|------|------|
| `/` | `RequirementsPage.tsx` | 需求管理（首页） |
| `/projects` | `ProjectsPage.tsx` | 多任务/项目管理 |
| `/workspace` | `WorkspacePage.tsx` | 工作区浏览与文件预览 |
| `/plan` | `PlanPage.tsx` | 开发计划生成与管理 |
| `/execution` | `ExecutionPage.tsx` | 代码执行监控 |
| `/tests` | `TestsPage.tsx` | 测试运行与结果 |
| `/skills` | `SkillsPage.tsx` | AI 技能管理 |
| `/mcp` | `MCPPage.tsx` | MCP 服务器配置 |
| `/pipelines` | `PipelinesPage.tsx` | 工作流管线配置 |
| `/mineru` | `MinerUPage.tsx` | MinerU 文档解析 |
| `/agent-execution` | `AgentExecutionPage.tsx` | Agent 自主执行 |

## 关键依赖与配置

- **状态管理**：`stores/app-store.ts` -- Zustand store，管理需求、工作区、计划、执行、测试、UI 偏好等全局状态
- **WebSocket**：`hooks/useWebSocket.ts` -- 自动连接/重连（指数退避），将服务端事件分发到 Zustand store
- **国际化**：`i18n.ts` -- i18next 初始化
- **UI 组件**：`components/ui/` -- 基础 UI 组件（button、card、input、badge）
- **业务组件**：`components/` -- Layout、MarkdownContent、SetupWizard、BranchSelector 等
- **引导系统**：`guides/` -- react-joyride 引导功能
- **工具**：`lib/utils.ts`（通用工具）、`lib/token-estimator.ts`（token 估算）

## 数据模型

前端数据模型定义在 `stores/app-store.ts` 中，包括：
- `Requirement` / `RequirementDetail` -- 需求
- `WorkspaceInfo` -- 工作区
- `DevelopmentPlan` -- 开发计划
- `TestRun` / `TestResult` -- 测试
- `AgentExecution` / `AgentExecutionSummary` -- Agent 执行

## 测试与质量

- 当前无前端测试覆盖
- 无 ESLint / Prettier 配置

## 相关文件清单

```
src/client/
  main.tsx              # 入口
  index.html            # HTML 模板
  index.css             # 全局样式（Tailwind）
  api.ts                # HTTP 封装
  i18n.ts               # 国际化配置
  stores/app-store.ts   # 全局状态
  hooks/useWebSocket.ts # WebSocket hook
  hooks/useKeyboardShortcuts.ts
  guides/index.ts       # 引导系统入口
  guides/useGuide.ts    # 引导 hook
  lib/utils.ts          # 工具函数
  lib/token-estimator.ts
  pages/*.tsx           # 11 个页面
  components/*.tsx      # 业务组件
  components/ui/*.tsx   # 基础 UI 组件
```

## 变更记录 (Changelog)

| 日期 | 操作 | 说明 |
|------|------|------|
| 2026-10-15 | 更新 | **Web 端吉祥物改可拖动悬浮球**（用户报「挡住输入框按钮」：此前 fixed bottom-3 right-4 正好压在 ChatInputBox 右下角的优化/放大/发送按钮上）。① `MascotWidget.tsx` 重写交互：pointer 按住拖动（4px 阈值区分点击与拖动，防误拖；`touch-action:none` + `preventDefault` 防选中；基点取按下时 rect 实际中心，默认定位与百分比定位统一换算），松手提交位置，双击（<350ms）复位默认角落；**默认位置 bottom-56（224px）right-4——完全让开输入框按钮区**（初版 bottom-40=160px 对高输入框仍骑边，用户反馈后抬高）；② 位置记忆：app-store `MascotSettings` 新增 `position: {xPct,yPct} \| null`（中心点视口百分比，窗口缩放自适应），`sanitizeMascotPosition` 统一校验（localStorage 读取 + `applyPreferencePatch` ui-preferences 同步两路），setMascot 原样透传自动落盘/同步服务端；渲染时 `clampCenterPct` 夹取保证宠物整体不出视口；③ 吉祥物设置页签新增「悬浮位置」行（说明文案 + 复位按钮，position 为空时禁用），locale 中英齐备；④ 顺手修 3 个存量 tsc 错误：`ExecutionPanel.tsx`/`ExecutionPage.tsx` 本地 `ExecutionDetail` 补 `totalLogs?: number`（服务端 status 实际返回该字段，2026-10-10 增量拼接用到了但类型没跟上；`?? Infinity` 缺字段时保守走拼接）+ 新增 `src/client/vite-env.d.ts`（`/// <reference types="vite/client" />`，修 pets.tsx `import.meta.env` 报错）。验证：client tsc 全绿（此前 3 错误归零）+ vite build（2600 模块，主包 1.35MB 不变） |
| 2026-10-12 | 替换 | **吉祥物换装轴伊 Joi 双衣装 + 轴芯鲸鱼娘，整体撤掉 Live2D**（用户否决 Live2D 方案：加载不出来 + 形象不满意，指定参考开源主题 github.com/tpmoonchefryan/dsh-joi-channel-theme）。素材：该仓库 `stuff/Stuff for Use/` 的三张对齐版 2×2 四格精灵图源 PNG，经 `scripts/fetch-joi-mascot.mjs`（复刻其 gen-assets 管线：LANCZOS 降到 512 + WebP 无损/q95 取小，PIL）压成 `public/mascot/{joi-flowers,joi-library,zhouxin}.webp` 合计 265KB（对比 Live2D 的 18.5MB），署名文件 LICENSE-ASSETS.md/THIRD_PARTY_NOTICES.md 随目录落盘（素材 **CC BY-NC-SA 4.0**：署名+非商业+同方式共享；仓库代码 MIT）。实现：`pets.tsx` 重写为纯 div + `backgroundSize:200%` + `backgroundPosition` 换格（格序沿用原主题 CELL 常量：`[0,0]=idle [1,0]=happy(success) [0,1]=typing(running) [1,1]=sad(error)`），心情契约 `MascotMood` 与 `PetAvatar({form,mood,width,className})` 签名不变，MascotWidget/PetRoot/tabs-appearance 零改动；`onPetTap` 总线照旧 → 摘/挂 `.joi-pet--tap-l/r` 挤压动画（reflow 重触发）；`.joi-pet--typing` 颠动动画（index.css 换掉 .live2d-pet 块）。零运行时依赖：没有动态 import、没有 WebGL、没有异步初始化，静态资源同源加载，不存在「转圈加载不出来」的失败模式。删除：Live2dPet.tsx、models.ts、public/models/live2d/（18.5MB）、live2dcubismcore.min.js、pixi.js/pixi-live2d-display 依赖（package.json 已去，**node_modules 里仍有残留，下次 pnpm install 自清**）、download-live2d-models.mjs/l2d-smoke.cjs 脚本。app-store PetForm union 切 `'joi-flowers'|'joi-library'|'zhouxin'`（旧 hiyori…/kitty… 存量自动回落 joi-flowers）。验证：client tsc + vite build（2600 模块，主包 1.35MB 不变）+ dist/client/mascot/ 产物核对 |
| 2026-10-12 | 更新 | **吉祥物换装 Live2D 动漫少女**（用户要求把三款自绘动物 SVG 换成动漫女角色；初音/崩坏因许可不可打包，选用 Live2D 官方免费示例模型）：① `components/mascot/Live2dPet.tsx` 新增——pixi.js@6 + pixi-live2d-display(cubism4) 渲染，Cubism Core（`public/live2dcubismcore.min.js`）按需单例注入，pixi/live2d 动态 import 不进主 bundle；透明背景画布、fitModel 居中适配（每模型 scale/offset 微调表）、MOTION_PRIORITY 本地常量（IDLE=1/NORMAL=2/FORCE=3）；StrictMode 双挂载安全（disposed 标记 + 就绪后二次校验销毁）；effect 分通道：[form] 重建 / [width] resize / [mood] setMood / [state] onPetTap 订阅；setMood：happy/sad 走 setExpression+FORCE 一次性动作（Natori 有命名表情 Smile/Sad），回 idle 复位表情；onTap 350ms 节流随机 Tap 组；② `components/mascot/models.ts` 形态注册表：hiyori 日和莉 / haru 小春 / rice 米雪儿（女仆） / natori 名取（银发） / mao 真绪，五款 `public/models/live2d/<Name>/`（共 18.5MB，model3.json 已剔除未下载的 UserData/DisplayInfo 引用与动作 Sound 字段）；③ `pets.tsx` 重写为 PetAvatar→Live2dPet 委托（PET_FORMS 由 LIVE2D_MODELS 派生，MascotMood 契约不变）；④ `paw-tap.ts` 改事件总线（onPetTap/tapPaw，root 参数保留兼容）——Live2D 无左右爪 DOM 钩子，输入镜像由节流 Tap 动作表达；⑤ app-store PetForm union 与默认值切 hiyori，导入合并改 PET_FORMS 白名单（旧 kitty/shiba/penguin 存量值自动回落 hiyori）；⑥ locale 五形态文案 + index.css 删 .bongo-cat 动画块换 .live2d-pet__canvas。**初版两坑已修**：① Live2dPet 外层 div 漏挂 `ref={holderRef}` → effect `if (!holder) return` 早退、无限 loading（表象即「一直转圈」且零报错）；② `pixi-live2d-display/cubism4` 在**模块求值期**硬校验 `window.Live2DCubismCore`（`if (!window.Live2DCubismCore) throw`），core 脚本注入必须先于该包 import，否则模块缓存永久污染。排查工具：`scripts/l2d-smoke.cjs`（Electron 隐藏窗口加载 dev 页面，读组件 console/DOM + 五模型 `Live2DModel.from` 逐个探活）。验证：冒烟 5 模型全 OK + 真实组件 2s 出画布、client tsc、vite build（pixi/l2d code-split 独立 chunk ~118/239/262KB）。许可：Live2D 官方免费素材（`public/models/live2d/Live2D-LICENSE.md`），仅限该许可允许用途。**（本行方案已被上一行 Joi 方案整体替换，仅留档）** |
| 2026-10-10 | 修复+新增 | **最终答复/汇总刷新后消失 + 日志渲染体验补齐**（用户报任务执行完的「输出」汇总，切页/刷新后没了；服务端根因与修复见 src/server/CLAUDE.md——最终答复现以 `{type:'assistant'}` 显式行落盘）。前端配套：① `utils/agent-log-parse.ts` 新增 assistant kind 解析（独立答复气泡，不并入输出组）；② `LogMessage.tsx` 新增「答复」形态（emerald 配色 + 左侧竖条，同 user 机制）；③ `LogViewer.tsx` 输出组新增「展开全部输出/收起」按钮（历史叙述常被工具行切碎成多个单行输出组，此前只展开最新组，看起来像丢了）；④ `ExecutionPanel.tsx`/`ExecutionPage.tsx` 轮询 `/api/execution/:id/status` 改 `?logsFrom=N` 增量拼接（服务端新增该参数，默认仍尾部 200 兼容旧客户端）——此前轮询的尾部窗口会**覆盖**本地已累积的全量日志，长任务日志越滚越少；`applyDetail` 统一拼接逻辑（totalLogs 变小视为重载，全量替换）；⑤ 新增 `utils/agent-log-parse.test.ts` 7 项（assistant 解析/输出组边界/工具配对/synthetic 收敛/增量身份稳定）。验证：client 7 项 + 服务端 coordinator 7 项，全量 32 文件 312 用例过，pnpm build 全链路 OK |
| 2026-10-08 | 修复+新增 | **需求拉取全链路修复 + 过程可视化**（用户报「拉取不下来，报错只有开头英文叙述」）：根因三连——① Claude provider 把 thinking 也写进 stdout；② 服务端单候选 JSON 提取（首个围栏/首个 `{` 配平）被叙述里的杂 `{` 截胡 → 报「不符合 JSON 契约」；③ 重试反馈与最终报错都取输出**开头** 200 字（=thinking），真正的 JSON 在结尾看不到。修复：`utils/structured-json.ts` 多候选提取（`balancedSpanAt` + `extractJsonObjectCandidates` 全起点扫描 + `extractBestJsonObject` 评分取优/同分取更靠后/剥尾逗号）；`requirement-agent-fetch.ts` 重写——显式 `maxTurns:30`（bridge 默认 10 太紧）、`maxTurnsReached` 带原因重试、10 分钟整体超时（MCP 挂起不再永久转圈）、onOutput→`AgentFetchProgress` 事件流、错误含「原因+输出开头/结尾」；路由 fetch/search/:id 经 WS 广播 `requirement:fetch_progress`（`useWebSocket` 转 CustomEvent）；新增 `components/RequirementFetchActivity.tsx` 活动面板（工具行带参数摘要与成败态、思考流、可折叠）+ 错误框 `<pre>` 多行详情 + i18n 中英。验证：17 项服务端单测 + tsc 全过 |
| 2026-09-24 | 更新 | **三引擎工具名覆盖矩阵**（不再逐个引擎打补丁）：从各引擎源码枚举权威清单并逐一断言前端可正确分类——claude 25 个（PascalCase 全集含 AskUserQuestion/ExitPlanMode/SlashCommand/BashOutput/KillShell）、pi 15 个（小写注册表 read/bash/edit/write/grep/find/ls/tool_search + MCP 形态）、codex 6 个（归一化产物 bash/write/edit/web_search/todo_write + `server__tool`）、通用别名 7 个，**合计 53 个工具名 0 个落兜底**；补齐 `tool_search`/`fd`/`ripgrep`/`questionnaire`/`askuserquestion`/`exitplanmode`/`slashcommand`/`local_image`/`view_image` 映射。配套验证（21 项全过）：假 client/thread 驱动真实 CodexProvider 的事件契约端到端（thinking 恰一次、同 id 去重、失败命令带退出码、无 started 的 item 自愈出工具行、7 行工具全部配对收敛） |
| 2026-09-24 | 修复 | 工具行图标/标题在非 Claude 引擎下全部消失（用户报「写、读这些图标没有了」）：根因有二 ——① `TOOL_META` 的键是 **PascalCase**（`Read`/`Write`/`Edit`/`Bash`），而 pi 的工具名是**小写**（真实日志：`read`×144、`edit`×30、`write`×16、`bash`×7），查表全部落空 → 兜底「工具调用」+ 通用扳手图标；② 状态槽在 running 时用转圈**替换**了工具图标，执行期间所有行都看不到专属图标（首版即如此，非本次回归）。修复：`toolMetaOf` 按 **小写规范名**查表（对齐 DSH `tool-call-model.ts`）并覆盖各方言别名（`read_file`/`str_replace`/`apply_patch`/`shell`/`find`/`todo_write`…），MCP 形态 `server__tool`/`mcp__server__tool` 统一成 `MCP server · tool` 且基础名沿用专属图标（如 `Playwright__browser_navigate` → 网页图标）；状态槽改为**图标常驻**（对齐 DSH `ToolRow.leadingFor`：running 与 ok 都显示图标，只有 error/stopped 换成状态标记），running 信号由尾部小转圈 + 图标脉冲承担；未知工具把真实工具名带进摘要（DSH 的 `${toolName} · ${summary}`）。顺带按**参数结构**（而非工具名）合成 Diff：pi `edit` 的 `{edits:[{oldText,newText}]}`、Codex `apply_patch` 的 `{patch}` 此前都退化成 IN/OUT 卡。验证：24 项全过（真实日志 17 个工具名 0 个落兜底；真实编辑类调用 50/50 能合成 Diff） |
| 2026-09-24 | 修复 | 工具行配对战与收敛（`utils/agent-log-parse.ts` + `components/ToolEventRow.tsx` + `hooks/useParsedLogs.ts`）：① 配对改为「id 优先」——同一 id 的**真实结果可升级**服务端补写的合成结果（中断后工具其实已完成），真实结果不被合成结果覆盖，重复结果忽略；② 无 id 的结果按 **FIFO** 配对最早的待结果行（旧实现配到「最近一条未闭合行」，并行工具下会错配）；③ 未知 id 的结果行不再错配到无关工具行（真实记录里 3 条孤立结果此前会污染别的行）；④ 工具行新增 `stopReason`（interrupted / unsettled）与琥珀色「已中断」文案，未返回显示「未返回结果」，执行结束时由 `finalizeRunning` 兜底收敛，不再永久转圈。真实记录回放：262 工具行全部收敛（2 条中断行为 stopped） |
| 2026-09-20 | 修复 | UI 偏好跨来源不一致（用户报告 `electron .` 与 `dev:desktop` 设置不同）：根因有二——① 代码来源不同（dev:desktop 走 Vite 源码热更，`electron .` 走 dist 构建产物快照）；② 根本原因是 **localStorage 按 origin 隔离**：5173 / 生产随机端口 / 3000 各存各的，且桌面版生产模式每次 findAvailablePort 可能换端口导致设置"随机丢失"。修复：新增 `syncUiPreferences()`（app-store 末尾）+ 服务端 `/api/ui-preferences` GET/PUT（`services/ui-preferences-service.ts` → `~/.aico/ui-preferences.json`，端口无关）——同步主题/语言/字体/字号/通知/透明度/配色/玻璃颜色/字体颜色/吉祥物/背景照片 12 项；localStorage 秒开回显 → 启动 GET 服务端为准合并（服务端为空则反向播种）→ 变更 400ms 防抖全量 PUT；applyPreferencePatch 校验 + 走各 applier 即时生效，快照对比防回环 PUT |
| 2026-09-20 | 修复+新增 | ① 自定义字体输入失效修复：FontTab 误改为「仅非内置项时显示输入框」导致选「自定义」后输入框永不出现，恢复始终显示（内置选中时空占位，直接输入即切自定义）；② 新增字体自定义（对齐插件「字体」页签）：ui.fontColor（enabled/color/weight/caretColor，localStorage）+ applyFontColorSettings —— 字体颜色覆盖 --foreground token（muted 次级保持层次）、字重挂 html font-weight 继承生效、光标颜色 caret-color 继承全局（独立于总开关）；FontTab 增总开关/颜色/字重/光标控件；③ 透明度公式重写：「调到最大也不透」根因是旧版把设置值直接当 alpha 系数（max=1 不衰减，而顶栏/侧栏基础 alpha 0.62/0.85 本就高），改为真透明度语义 factor = clamp(1.15 - v, 0.12, 1)（拉满玻璃底色只剩 ~12-15%，blur 保留可读），外观页签加「越大越透」提示 |
| 2026-09-20 | 更新 | 吉祥物改版：① 桌面端去重 —— MascotWidget 仅 Web 模式渲染（检测 `window.adwDesktop` 即 return null），桌面只保留独立悬浮窗；② 形象库重绘 `components/mascot/pets.tsx`（替代 BongoCat.tsx，已删）：三款自绘 kawaii SVG 形态 kitty 小猫喵 / shiba 柴犬君 / penguin 企鹅桑（大头圆眼双高光+腮红+物种特征：橘纹卷尾/白吻卷尾/呆毛橙嘴脚蹼），统一动画契约（.bongo-cat--{mood} 循环 + .bongo-cat__paw--l/--r 输入镜像钩子 + PawTap 命令式敲击）；③ app-store ui.mascot 增 form 字段（PetForm union，localStorage 持久化 + 合法性校验）；④ 悬浮面板「吉祥物」页签增形态卡片（PetAvatar 实时预览三选一，对齐 dsh-wallpaper-engine 形态卡片交互）；⑤ 输入镜像（Bongo Cat 敲键盘跟手）：键盘经主进程 before-input-event 捕获转发（无系统级钩子）、鼠标经 notifyInputActivity IPC，paw-side.ts 物理键盘左右分区映射左右爪，paw-tap.ts 命令式摘/挂类重触发动画免重渲染；桌面窗复用主 preload 接收 adw:pet-input |
| 2026-09-20 | 更新 | 悬浮快捷设置面板 + 桌面宠物：新增 `components/quick-settings/`（FloatingSettingsPanel 六页签右侧悬浮玻璃抽屉 + controls.tsx 行语法控件 + tabs-appearance/tabs-wallpaper 页签；外观页签含配色/玻璃颜色，经 `lib/appearance.ts` 的 applyAccent/applyGlassColor 注入 CSS 变量）；新增 `components/mascot/`（BongoCat 纯 SVG 打字猫、MascotWidget Web 右下角、PetRoot 宠物窗口分支）与 `hooks/useAgentActivity.ts`（独立 /ws 连接 → typing/happy/sad 心情推导）；`main.tsx` 增 ?pet=1 分支；原 AppearanceSection/WallpaperSection 改为引导卡片（功能全部迁入悬浮面板）；顶栏 Palette 按钮直达面板（原主题下拉移除，背景照片收进外观页签）；app-store 增 accent/glassColor/mascot/quickSettings 状态与持久化 |
| 2026-09-20 | 更新 | 壁纸功能前端落地（设计参考 dsh-wallpaper-engine，MIT）：新增 `types/wallpaper.ts`（数据模型）、`lib/wallpaper-media.ts`（canvas 缩略图生成 + MediaError 人话翻译）、`stores/wallpaper-store.ts`（localStorage 秒开缓存 + 服务端事实源合并、300ms 防抖持久化、`applyEffects` 统一注入 `--wp-*` CSS 变量 + body 属性、identity 不设合成层变量）、`components/wallpaper/WallpaperLayer.tsx`（body 下 z:-2 壁纸 + z:-1 scrim portal；播放意图/元素真实态分离、AbortError 自动补播、换源 pause+清 src 释放解码器）、`components/wallpaper/WallpaperPickerModal.tsx`（缩略图网格/类型过滤/隐藏恢复/上传）、`pages/settings/WallpaperSection.tsx`（八效果滑杆 accent 填充、胶囊开关、黑胶唱片、倍速/翻转/适配、遮挡暂停三档）；`index.css` 升级液态玻璃配方（镜面高光+内阴影三件套+模糊饱和度联动+@supports 回退+`body[data-wallpaper-active]` 可读性适配）；`SettingsPage` 新增 wallpaper 分区、`Layout` 挂载 WallpaperLayer；i18n 中英文齐备 |
| 2026-07-21 | 创建 | 初始化模块文档 |
