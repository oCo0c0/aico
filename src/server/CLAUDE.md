[根目录](../../CLAUDE.md) > [src](./) > **server**

# Server 模块

## 模块职责

Express 后端服务层，提供 REST API、WebSocket 实时推送、AI Bridge 通信管理、文件系统持久化、MCP 协议集成、沙箱管理、任务调度等核心能力。

## 入口与启动

- **入口**：`index.ts` -- `createServer(port)` 工厂函数，组装中间件、服务实例、路由，创建 HTTP + WebSocket 服务器
- **开发入口**：`../dev-server.ts` -- 固定端口 3000 启动
- **编译**：`tsconfig.server.json`，CommonJS 模块，输出到 `dist/server/` + `dist/cli/`

## 对外接口

通过 Express Router 挂载到 `/api/*` 前缀，共 15 组业务路由 + 2 个平台 API 面（`/api/mcp` HTTP MCP、`/api/platform` REST，详见根级 CLAUDE.md 路由总览）。

## 内部结构

### routes/ -- 路由层（15 个文件）

| 文件 | 前缀 | 说明 |
|------|------|------|
| `requirements.ts` | `/api/requirements` | 需求 CRUD + agent 中介拉取/搜索 + 图片服务 |
| `workspace.ts` | `/api/workspace` | 工作区管理 + 文件浏览 + Git 全操作 |
| `plan.ts` | `/api/plan` | 计划生成/回复/暂停/恢复/重生成/技能队列/任务导出 xlsx |
| `execution.ts` | `/api/execution` | 代码执行/暂停/中止/重试/跳步/技能队列 + 自动触发测试 |
| `tests.ts` | `/api/tests` | 三种测试模式 + 沙箱三阶段 + 变更文件定向测试 |
| `skills.ts` | `/api/skills` | 技能 CRUD（内置 + Provider 外部合并去重） |
| `mcp-servers.ts` | `/api/mcp-servers` | MCP 服务器配置 CRUD + 连接测试 |
| `pipelines.ts` | `/api/pipelines` | 工作流管线配置 CRUD |
| `system.ts` | `/api/system` | 系统状态 + CLI Provider 选择/检测 |
| `analytics.ts` | `/api/analytics` | 数据分析 |
| `mineru.ts` | `/api/mineru` | MinerU 文档解析 |
| `projects.ts` | `/api/tasks` | 多任务调度管理 |
| `agent-execution.ts` | `/api/agent-execution` | Agent 自主执行（create/start/abort/reply） |
| `model-providers.ts` | `/api/model-providers` | 自定义模型供应商（models.json）增删查、检测、导入、拉取模型列表 |
| `prompts.ts` | `/api/prompts` | AI Prompt 优化 |
| `wallpapers.ts` | `/api/wallpapers` | 壁纸库：清单、上传（octet-stream 原始字节流）、媒体流（sendFile Range 206）、缩略图、隐藏/恢复/删除、设置持久化 |

### services/ -- 服务层

**核心服务**：

| 文件 | 类名 | 说明 |
|------|------|------|
| `cli-runner-service.ts` | `CLIRunnerService` | CLI Provider Facade，统一代理 Claude/Codex/Pi |
| `cli-providers/types.ts` | -- | CLI Provider 接口定义（`CLIProvider`、`CLIProviderInput` 等） |
| `cli-providers/index.ts` | -- | Provider 注册表与自动检测 |
| `cli-providers/claude-provider.ts` | `ClaudeProvider` | Claude Code CLI Provider 实现（SDK） |
| `cli-providers/codex-provider.ts` | `CodexProvider` | OpenAI Codex CLI Provider 实现（SDK） |
| `cli-providers/pi-provider.ts` | `PiProvider` | Pi Provider——RPC 子进程 harness（`pi --mode rpc`），process-per-run，会话文件续接 |
| `cli-providers/pi-rpc-process.ts` | `PiRpcProcess` | pi RPC 子进程管理：JSONL 命令/应答（id 关联）、事件流回调、优雅退出/强杀、rpc-entry 解析 |
| `config-service.ts` | `ConfigService` | 全局配置管理（`~/.aico/config.json`） |
| `requirement-agent-fetch.ts` | `RequirementAgentFetchService` | agent 中介需求拉取/搜索（标准 MCP 消费模式：AI 引擎动态面对已挂载 MCP 工具，读 schema → 自主选择与调用，JSON 契约输出；零源硬编码，新增需求源只需配置 MCP server） |
| `mcp-config-service.ts` | `MCPConfigService` | MCP 服务器配置管理 |
| `workspace-service.ts` | `WorkspaceService` | 工作区文件系统操作 + Git 命令 |
| `task-scheduler-service.ts` | `TaskScheduler` | 多任务并行调度器（Coordinator 模式） |
| `agent-coordinator.ts` | `AgentCoordinator` | Agent 执行协调器（解析 thinking/tool_use/tool_result 事件） |

**存储服务**：

| 文件 | 类名 | 说明 |
|------|------|------|
| `requirement-store-service.ts` | `RequirementStoreService` | 需求持久化（文件夹结构） |
| `plan-store-service.ts` | `PlanStoreService` | 计划持久化 |
| `execution-store-service.ts` | `ExecutionStoreService` | 执行记录持久化 |
| `test-store-service.ts` | `TestStoreService` | 测试结果持久化 |
| `task-store-service.ts` | `TaskStoreService` | 任务持久化 |
| `agent-execution-store.ts` | `AgentExecutionStore` | Agent 执行记录持久化 |
| `analytics-store-service.ts` | `AnalyticsStoreService` | 分析数据持久化 |
| `json-store.ts` | `JsonStore` | 通用 JSON 文件存储工具 |

**业务服务**：

| 文件 | 类名 | 说明 |
|------|------|------|
| `pipeline-service.ts` | `PipelineService` | 工作流管线配置管理 |
| `skills-service.ts` | `SkillsService` | AI 技能管理 |
| `test-executor-service.ts` | `TestExecutorService` | 测试执行器（多框架自动检测） |
| `sandbox-service.ts` | `SandboxService` | Daytona 沙箱管理 |
| `mineru-service.ts` | `MinerUService` | MinerU 文档解析 |
| `ones-image-service.ts` | `OnesImageService` | ONES 平台图片下载（PKCE 认证插件；`createAttachmentImageService` 按 server env 检测构建） |
| `memory/memory-service.ts` | `MemoryService` | 记忆子系统（项目事实/反馈日志/用户画像） |
| `memory/project-facts-store.ts` | `ProjectFactsStore` | 项目事实存储 |
| `memory/feedback-log-store.ts` | `FeedbackLogStore` | 反馈日志存储 |
| `memory/user-profile-store.ts` | `UserProfileStore` | 用户画像存储 |
| `analytics-service.ts` | `AnalyticsService` | 数据分析服务 |
| `skill-derivation-service.ts` | `SkillDerivationService` | （已废弃）技能自动派生 — 不再实例化 |

**需求文档模型**（源中立，`requirement-sources/`）：

| 文件 | 说明 |
|------|------|
| `requirement-sources/types.ts` | 中立数据模型（`Requirement`/`RequirementDetail`）与附件图片服务契约（`AttachmentImageService`） |
| `requirement-sources/parsers.ts` | 共享解析器（agent JSON 契约 → 数据模型映射，兼容驼峰/下划线） |
| `requirement-sources/index.ts` | 纯 re-export（types + parsers） |

需求拉取已全面 agent 中介化：`requirement-agent-fetch.ts` 让 AI 引擎动态面对已挂载的 MCP 工具（读 schema → 自主选择与调用 → JSON 契约输出），应用侧零源硬编码。原 per-source 适配器（ones/github/generic）与 `mcp-bridge-service.ts` 已删除——新增需求源（GitLab/Jira/任意 MCP）只需在 MCP 设置页配置 server，零代码。唯一源特定残留是附件图片认证插件（`createAttachmentImageService` 按 server env 检测，如 ONES PKCE）。

**测试 Provider**：

| 文件 | 说明 |
|------|------|
| `test-providers/types.ts` | 测试 Provider 接口 |
| `test-providers/index.ts` | Provider 注册表 |
| `test-providers/node-provider.ts` | Node.js (jest/vitest/mocha) |
| `test-providers/python-provider.ts` | Python (pytest/unittest) |
| `test-providers/java-provider.ts` | Java (junit/maven/gradle) |
| `test-providers/generic-provider.ts` | 通用（命令行） |

### middleware/ -- 中间件

| 文件 | 说明 |
|------|------|
| `logger.ts` | HTTP 请求日志 |
| `validation.ts` | 请求体验证 + 错误处理 + 路径安全校验 |

### utils/ -- 工具库

| 文件 | 说明 |
|------|------|
| `constants.ts` | 目录路径、超时、AI 参数等常量 |
| `error-utils.ts` | 错误消息提取 |
| `http-utils.ts` | HTTP 请求工具 |
| `lru-cache.ts` | LRU 缓存 |
| `markdown-utils.ts` | Markdown 解析 |
| `skill-utils.ts` | 技能/MCP 解析工具 |
| `prompt-enrichment.ts` | 提示词增强（注入记忆上下文） |

### 核心基础设施

| 文件 | 说明 |
|------|------|
| `websocket.ts` | WebSocket 服务（`/ws`），广播消息到所有客户端 |
| `event-bus.ts` | 服务端事件总线，基于 EventEmitter |
| `../platform/` | 引擎无关平台内核（工具分类目录/工具注册表/MCP 聚合网关 + `/api/platform` REST 面），见 `platform/README.md` |
| `../../resources/pi-extensions/` | adw 平台扩展（pi RPC 子进程内加载：权限门 + MCP 桥），零运行时依赖 |

## 关键数据模型

数据存储在 `~/.aico/` 目录下：
- `config.json` -- 全局配置
- `requirements/` -- 需求（每个需求一个文件夹）
- `plans/` -- 开发计划
- `executions/` -- 执行记录
- `tests/` -- 测试结果
- `tasks/` -- 多任务
- `agent-executions/` -- Agent 执行记录（含 `sessionId` **与会话归属引擎** `sessionEngine`）
- `pi-sessions/<cwd 净化名>-<md5(cwd)>/` -- pi 引擎的原生会话文件（一会话一 jsonl，续接用）
- `claude-home/` -- Claude Code 的隔离配置目录（`CLAUDE_CONFIG_DIR`，其 `projects/<cwd编码>/<id>.jsonl` 即 Claude 会话）
- `codex-home/` -- Codex 的隔离配置目录（`CODEX_HOME`，其 `sessions/**/rollout-*.jsonl` 即 Codex thread）
- `memory/` -- 记忆子系统
- `analytics/` -- 分析数据
- `pipelines.json` -- 管线配置
- `wallpapers/` -- 壁纸库（uploads/ 文件、thumbs/ 缩略图、meta.json 元数据、settings.json 设置持久化，端口无关）

## 测试覆盖

已有 10 个测试文件（`*.test.ts`），覆盖部分服务层。缺失：
- 路由层测试
- `cli-providers/claude-provider.ts` 和 `codex-provider.ts` 测试
- `agent-coordinator.ts` 测试
- `task-scheduler-service.ts` 测试
- 大部分存储服务测试
- 前端测试

## 变更记录 (Changelog)

| 日期 | 操作 | 说明 |
|------|------|------|
| 2026-10-15 | 修复 | **「立即处理」中断流重构：interrupt 不再落 aborted 终态**（用户报：agent 执行中点「立即处理」，消息发出去了但输入框上方排队条不消失；且日志闪现「⏹️ Agent执行已中止」不优雅。前端配套见 src/client/CLAUDE.md 同日行）。根因链：`interruptNow()`（abort 控制器）→ 当前轮 runSingleShot/runSubTaskLoop 走 aborted 分支 → updateStatus('aborted')+broadcastComplete('aborted') 落瞬时终态 → 前端轮询恰好撞上就永久停轮询（排队条永不刷新）；即使不撞上，消息流也闪「已中止」。修复（`agent-coordinator.ts` 六处）：① 中断语义改为**非终态**——runOnce 早期 abort / runSingleShot result.aborted / runSubTaskLoop 终态块三处，interruptFlags.has 时保留 finalizeSteps+appendFinalAssistantLog 但跳过 updateStatus/broadcastStatus/broadcastComplete('aborted') 与「执行已中止」日志（runOnce 每轮开头重申 running，中断窗口内状态无间隙）；真实用户点停止的 `abort()` 行为不变；② `interruptNow()` 即时日志「⚡ 立即处理排队消息：正在中断当前轮…」（此前点了没有任何反馈直到下一轮开始）；③ execute() 外层循环 drain 消费队列后即时广播 `agent-execution:queued_update` {queued:false}（此前队列变化前端只能靠轮询感知）；④ interrupt 分支删冗余的 updateStatus('running') 广播；⑤ 子任务 aborted 时 error 文案区分「已中断（立即处理排队消息）」vs「已中止」。验证：agent-coordinator.test.ts 新增 3 项（execute 中断续跑循环继续+queued_update+user 行上屏 / interruptNow 即时反馈+未运行返 false / runSingleShot 中断跳过终态落库而真实中止照常落），全量 32 文件 315 用例过，双端 tsc + pnpm build OK |
| 2026-10-10 | 修复 | **最终答复/汇总在刷新后消失（「输出」标签像被截断）——根因：最终答复从未以显式消息形态落盘**（用户报任务执行完的汇总，切页/刷新后就没了）。node 解析真实执行记录实锤：pi 的模型把最终汇总走 thinking 通道（0b81032a 最后一条 log 是截 2000 字的 thinking 行），另一执行最终答复后还跟 4 条工具行——正文/thinking 都是流式过程通道，刷新重建后沉在「Think 折叠行/收起的输出组」里，毫无「这是最终答复」的姿态。修复（服务端）：`agent-coordinator.ts` 新增 `lastOutputs` 追踪（每执行记录 plain/thinking 谁更晚）+ `appendFinalAssistantLog(executionId)`——终态时把最后一段叙述（正文与 thinking 中 seq 更晚者，空白跳过，截 16000）写成 `{type:'assistant', content}` 显式答复行并广播，消费后清除；调用点：单发 completed/aborted、子任务终态（failed 不写，已有 error 行）；thinking 行级截断 2000→8000（防长思考刷爆日志，答复完整性由 assistant 行兜底）。 |
| 2026-10-08 | 修复 | **30 分钟绝对超时改「无活动看门狗」**（用户报「agent 执行 30 分钟自动终止，长任务正常执行就断了」）：全仓三处绝对定时器逐一改造为活动语义——① `pi-provider.ts`：整轮看门狗旧实现是发起 prompt 前一次性 setTimeout 且**任何事件都不重置**（注释写「兜底事件流沉寂」实为绝对墙钟，健康长任务恰在 30 分钟整被杀、文案失实），改为 `armRunWatchdog()`——handleEvent 首行每事件重置，仅事件流彻底沉寂满 30 分钟（疑似卡死）才 abort+收尾；工具看门狗同步改 `armToolWatchdog(toolCallId, toolName)`——`tool_execution_update`（部分输出）重置，工具 10 分钟零输出才中止（旧实现只看总耗时，长构建/长查询误伤）；② `bridge-json-runner.ts`：删 withTimeout（绝对 reject「Bridge call timed out after Nms」且 reject 后底层 runBridge 泄漏继续跑），新增导出 `withOutputTimeout(ms, label, callerSignal, callerOnOutput, run)`——输出活动重置、到点先 abort 内部信号（真正停掉 bridge，不再泄漏）再以中文明确报错拒绝，调用方 signal 联动；③ `plan.ts`：两处 Promise.race 绝对 reject（`timed out after 30 minutes`）同改 withOutputTimeout。claude/codex provider 本无整轮超时（跑完为止），无需改。验证：新增 bridge-json-runner.test.ts 4 项（正常完成透传/心跳重置/沉寂中止+signal 联动/调用方 abort 传播）+ pi-provider 看门狗 3 项（30 分钟沉寂中止/10 分钟心跳存活 60 分钟/工具部分输出重置），全量 30 文件 298 用例过，build:backend OK |
| 2026-10-08 | 修复 | **隔离 claude home 的无头权限前提缺失——pi 成功而 claude 拒绝工具调用的真正根因**（用户实测 pi 拉取成功、claude 仍报 `you haven't granted it yet`；用户直觉「和应用与本地 claude 的环境隔离有关」正确）。两层叠加：① 隔离 home 的 `.claude.json` 新生、**无 `bypassPermissionsModeAccepted` 字段**——claude 2.x 无头下 bypassPermissions 需先交互式接受免责声明，否则静默降级 default（真实 home 用户交互接受过，隔离 home 永远没有机会）；② 隔离 home 的 `settings.json` 首次播种自真实配置，`permissions.allow` 全是**直连时代前缀**（`mcp__ones-api__*` 等）——网关架构下工具全名是 `mcp__adw-platform__<upstream>__<tool>`，一条 allow 规则都匹配不上 → 每次工具调用落「待授权」→ 无头自动拒绝（SDK 未传 settingSources → 用户级 settings.json 默认加载，规则生效，sdk.d.ts:2147）。此前「直接拉取能用」是因真实 `~/.claude.json` 顶层配了 ones-api user-scope mcpServers（自动受信）+ allow 规则匹配直连名，隔离后两者皆失效。修复：`cli-isolation.ts` 新增 `applyClaudeHeadlessGrants(home)`（幂等只补缺失、不动其它字段，ensureIsolatedHome 对 claude 每次确保时调用）：`.claude.json` 补 `bypassPermissionsModeAccepted:true`（应用代隔离沙箱接受免责声明，不碰用户真实配置）+ `settings.json.permissions.allow` 并入 `mcp__adw-platform__*`（前缀与 mcp-gateway 的 PLATFORM_MCP_SERVER_NAME 一致；allow 规则与模式无关，即使 bypass 被降级也放行）。验证：新增 cli-isolation.test.ts 7 项（补缺失/保留既有字段/幂等/无 permissions 段跳过/损坏文件不抛）+ fetch 21 项全过；端到端拉取 CWXT-150948 交由用户验证 |
| 2026-10-08 | 修复 | **需求拉取「agent 只见 web_reader」根因修复——MCP 上游薛定谔挂载**（用户报「配置了 ONES MCP 还是拉不下来，报错：当前会话未挂载任何需求管理系统类 MCP server，可用的 MCP 工具仅有通用的网页读取器 web_reader」——该文案是 agent 自己的 final answer，即上游没挂上时 agent 拿内置网页工具公网瞎猜）。根因链：网关目录构建有 per-server **8s 软超时**（Windows 下 npx 冷启动实测 3.4~15s+，超时**静默跳过**上游）+ 上游子进程 env 极简（只透传 PATH，APPDATA/TEMP 缺失拖慢 npm，同机对照实测 3.4s vs 10.3s）+ 连接失败进入 **60s 熔断**，三态叠加 → agent 启动时聚合端点常为空工具目录。修复：① 网关新增 `ensureUpstreamsReady(names, timeoutMs=90s)`——显式等待就绪、**清除熔断冷却**（用户点击=明确重试意图）、逐 server 返回 `{name, ok, toolCount?, reason?}`；② `pickDefaultEnv()` 改 Windows 必需变量白名单透传（PATH/PATHEXT/SYSTEMROOT/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/NPM_CONFIG_REGISTRY 等，不透传业务密钥）；③ `requirement-agent-fetch` 新增 DI 钩子 `ensureMcpReady`（index.ts 注入网关实现），拉取前显式等就绪并推过程事件（「正在确保就绪/已就绪 N 个工具/连接失败原因」），**全部失败快速报错不再烧引擎**；白名单为空直接报「未配置任何启用的 MCP server」；④ `~/.aico/mcp-servers.json` ones-api 版本 pin `@0.5.1`（importFromProviders 已存在不覆盖，持久生效）。验证：fetch 21 项 + 网关 17 项（就绪/失败原因/绕过熔断/超时上限）全过，全量 28 文件 283 用例通过（⚠️ 初版记录曾写「端到端拉取成功」，不实——端到端当时仍失败，真正根因见下一行） |
| 2026-10-08 | 修复 | **「agent 只见 web_reader」的真正根因：网关 MCP 协议面注册即崩 + 无头权限降级**（上一条只是前置加固）。① 协议面：`createAggregateServer` 用高层 `McpServer.registerTool(..., {inputSchema: 上游 JSON Schema})`，但该 API 只接受 Zod schema/ZodRawShape → 注册即抛 → 首个 initialize 请求 500 → claude CLI 视 adw-platform 为坏 server → 模型拿不到任何平台工具，只剩模型服务端注入的 web_reader，agent 只能公网瞎猜。**REST 面（/api/platform/tools）不走 registerTool 所以一直是好的**——这就是「REST 能列 22 个工具但 agent 看不到」的原因。修复：改低层 `Server` API（`new Server(..., {capabilities:{tools:...}})` + `setRequestHandler(ListToolsRequestSchema/CallToolRequestSchema)`，inputSchema 原样透传 JSON Schema，工具执行走统一 PlatformToolDefinition.execute）；新增 MCP 官方 Client 直连 /api/mcp 的回归测试（initialize→tools/list→tools/call 全链路断言）——此前协议面零覆盖是 bug 溜进来的原因。② 无头权限链：agent 能调工具后仍被拒（`permission not granted` → `you haven't granted it yet`）。链路：fetch 服务显式传 `permissionMode:'bypassPermissions'`（无头只读契约 agent，工具面已按 server 白名单收敛；默认 confirm 无确认 UI 退化 acceptEdits 会拒 MCP 工具）→ 但 claude CLI 2.x 无头下把 bypassPermissions **静默降级为 default**，除非显式接受免责声明（二进制逆向确认：`bypass requires accepting the disclaimer interactively first`，即需要 `--allow-dangerously-skip-permissions`）→ 修复：`permission-mapping.resolveClaudePermission` 在 bypass 档输出 `allowDangerouslySkipPermissions: true`，provider 参数展开透传，bridge（claude-bridge.mjs）转成 SDK 同名选项。pi 引擎走扩展 REST 面 + `ADW_PERMISSION_MODE=auto-allow`，无此问题；codex `supportsRuntimeMcp:false` 不支持动态 MCP。③ 构建教训：**bridge 改动必须 `pnpm run build:bridge`**——`build:backend` 只清 dist/server、dist/cli，不含 dist/bridge 拷贝，陈旧 bridge 曾导致修复不生效。验证：fetch 21 项（含 permissionMode 断言）+ 权限映射 5 项 + 网关协议面 18 项全过；端到端拉取 CWXT-150948 交由用户按验证清单执行 |
| 2026-09-24 | 修复 | **单轮步数上限不再当作失败 + 自动续跑**（用户报 claude 引擎「执行失败（退出码 1）: SDK error: error_max_turns \| no detail」，误以为上下文超长）：SDK 的 `TerminalReason` 明确区分 `max_turns`（步数上限）与 `prompt_too_long`（上下文超长），此前我们一律按硬失败处理。现在：桥接把 `error_max_turns` 分类为 `{status:'max_turns'}` → provider 透出 `maxTurnsReached/turnsUsed`（`CLIProviderResult` 与 `CLIExecutionResult` 均已加字段）→ 协调器新增 `runBridgeWithTurnContinuation()`：带着**同一会话**自动续跑下一批（单次执行与子任务两条路径都接上），每批写明确日志「⏭ 已达单轮步数上限（N 轮），自动继续第 K 批」；批数上限 8×50=400 轮，仍打满才给出人话失败信息与建议（拆分需求 / 再点执行继续，会话上下文仍在）。验证：续跑逻辑 12 项（含中止后不续跑、正常结束不受影响）+ 桥接选项名与错误分类 14 项断言全过 |
| 2026-09-24 | 修复 | **环境隔离补齐「工具执行能力」条目**（用户报「隔离后 shell/git 等默认工具不可用，只能靠浏览器工具干活」）：原隔离只搬了「配置/凭据」，漏掉让引擎自带工具能跑起来的条目，三个引擎逐一审计后修正 ——① **pi**：`~/.pi/agent` 的 `settings.json`（`shellPath` 是 bash 工具的 shell 解析首选，Git 装在非标准位置时**只有**这里能找到 bash）、`trust.json`（工作区信任）、`bin/`（`rg.exe`/`fd.exe`：grep/find 的二进制，缺失时 pi 会尝试联网下载）→ 新增 `seedIsolatedPiAgentHome()`；另发现 pi 默认激活工具集只有 `read,bash,edit,write`（`dist/core/sdk.js` 的 `defaultActiveToolNames`），grep/find/ls 默认不激活，而 `--tools` allowlist 会连带裁掉扩展工具（`agent-session.js`）→ 新增 `ensurePiDefaultTools()`：不动 `--tools`，改为在隔离 settings.json 里把 `defaultTools` 配全（与已有值取并集）；② **codex**：补 `.sandbox-bin/`（命令执行沙箱二进制 286MB）、`.sandbox/`、`.sandbox-secrets/`（没有这些 codex 无法执行命令）；③ **claude**：补 `CLAUDE.md`（用户全局指令）、`plugins/`（插件工具）。另将 `ensureIsolatedHome` 从「仅首次播种」改为「**既补缺失、绝不覆盖**」——存量安装（如本机）自动修复，无需删目录重来。真实端到端验证（隔离环境 + 真实 pi 子进程）：`write`→写入成功、`bash`→`git version 2.47.0.windows.1`、`grep`→`probe.txt:1: ok`、`find`→`probe.txt`，四个内置工具全部可用；确定性验证 20 项（播种/补缺/幂等/不覆盖/工具集并集）全过 |
| 2026-09-24 | 修复 | **codex 消息流按 SDK 真实契约重写**（三引擎一致性审计发现）：原实现判 `item.type === 'agentMessage'/'commandExecution'/'toolCall'`（camelCase），而 @openai/codex-sdk 的 ThreadItem 判别值是 **snake_case**（`agent_message`/`reasoning`/`command_execution`/`file_change`/`mcp_tool_call`/`web_search`/`todo_list`/`error`/`local_image`；事件 `thread.started`/`turn.started|completed|failed`/`item.started|updated|completed`）→ 一条都匹配不上，**codex 执行时消息流里既无助手文本也无工具行**。重写为两个归一化方法：`emitCodexItemStarted`（item 开始/更新 → tool_use，running）+ `emitCodexItemCompleted`（完成 → tool_result/文本/thinking，**先自愈补发漏掉的 tool_use**——file_change 等 item 只在补丁落定时发一次，没有 use 就没有行，结果会变孤儿）；映射：command_execution→bash（aggregated_output/exit_code→isError+退出码标注）、file_change→逐文件 write(add)/edit(其他)、mcp_tool_call→`server__tool`（前端渲染 MCP 行）、web_search/todo_list→web_search/todo_write、reasoning→thinking、agent_message→文本；同 id 去重（started/updated/completed 重复投递不重复出行）；turn.failed→exitCode 1 + stderr。验证：假 client/thread 驱动真实 provider 的端到端断言 15 项（thinking 恰一次、updated 不重复、失败命令带退出码、无 started 的 item 自愈、7 行工具全部配对、sessionId=threadId 等）+ 全量单测 27 文件 264 用例通过。pi 与 claude 侧同步复核：pi 的 tool_execution_start/end 同一 toolCallId 配对完整，claude 桥接逐 block 发射——三引擎现在同构 |
| 2026-09-24 | 新增 | **会话归属与跨引擎连续性**（用户报「历史任务再执行提示 pi 会话不存在或已失效」）：会话实体由各引擎自己托管（claude 项目目录 / pi 会话文件 / codex thread），应用此前只存一个不带引擎标记的 `sessionId`，换引擎后必然是无效指针。① `AgentExecution` 增 `sessionEngine`（产生会话的引擎 id），`updateSessionId(id, sid, engine)` 同步维护；② `CLIProvider` 增可选 `canResumeSession(sessionId, cwd)`，三个引擎各自判定（claude：隔离 home 的 `projects/*/<id>.jsonl`，缺失时从用户 CLI 目录**按需补迁**；pi：`resolvePiSessionFile` 三级查找；codex：threadId 的 rollout 文件 / 旧占位 id 的进程内映射）；③ 协调器 `resolveSessionForRun()`：引擎不匹配或会话已失效时**不再把无效 id 传下去静默开新会话**，改为写明确提示 + 用 `utils/transcript.js` 生成的对话摘要（≤12k 字符）注入本轮 prompt（`continuityBlock`），历史任务因此「带着上下文继续」而不是从头再来；④ codex 会话指针改为**真实 threadId**（此前是 `codex-<时间戳>`，只在进程内映射里 → 服务重启必定开新会话）；⑤ pi 会话目录键经 `normalizeWorkspacePath` 归一化（`D:/a/b` 与 `D:\a\b` 曾算出两个目录），并按 id 全库回退查找（工作区改名/移动后仍可续接）。确定性验证 38 项全过（含端到端断言：换引擎后下发的 prompt 含摘要且不带旧 sessionId） |
| 2026-09-24 | 修复 | 工具行永久转圈根因修复（claude-provider + agent-coordinator）：① `handleNotification` 改为 requestId → sessionId → 唯一在飞请求兜底三级归属，失配/兜底/丢弃都打日志（此前两处静默 `return` 直接吞事件，真实日志里 3 条结果因此找不到对应 tool_use 行）；会话映射删除加身份校验（避免旧请求清理掉新映射）；`sendAbort(requestId)` 按请求粒度中止。② 新增 `settlePendingToolCalls(executionId, reason)`：中断/中止**瞬间**收敛在飞工具（`synthetic:true, reason:'interrupted'`），轮末收敛未返回工具（`unsettled`），前端工具行因此立刻停止转圈；合成结果可被后到的真实结果覆盖。③ 新增 `runningExecutions` 单执行并发防护——重复 start/重放不再把同一执行跑成多个循环（日志曾出现 4 行重复「已中断」）。全部 18 个真实执行记录回放：344 个工具行 0 转圈 |
| 2026-09-20 | 更新 | 壁纸库服务端：新增 `services/wallpaper-store-service.ts`（WallpaperStoreService：uploads/thumbs/meta.json/settings.json，设置合并 + 数值夹取 + id 白名单防路径穿越）与 `routes/wallpapers.ts`（清单/上传/缩略图/媒体/更新/删除/设置读写）；上传走 `express.raw` octet-stream（与全局 express.json 互不干扰，2GB 上限），媒体流 `res.sendFile` 自动支持 Range 206（视频可拖动进度）；`index.ts` 注册 `/api/wallpapers`。全链路冒烟通过（上传/清单/Range/缩略图/设置/隐藏/删除/落盘） |
| 2026-07-23 | 修复 | 附件面板=解析输入清单：`requirement-store-service.downloadImages` 只保留「真实 http URL」或「已本地化且被文档引用」的附件；下载集=真实 URL 附件+`[Image:]` 引用（不再盲收全部无 URL hash 资源）；下载失败改写为明示未下载；`mcp-registry-service` 磁盘格式标准化 mcpServers 方言（兼容读旧格式，保存自动迁移） |
| 2026-07-23 | 修复 | ONES wiki 图片 0/N 全挂：任务描述 wiki 链接为 `/team/{t}/page/{uuid}`（无 space 段），`ones-image-service.getWikiPageUuids` 旧正则强制 space 段匹配不到 → 兜底拿任务 UUID 当 wiki 页必 404；放宽路由正则与 ai-dev-requirements 对齐（space 可选 + descriptionText 扫描 + URL 解码）。`requirement-store-service` 附件本地化范围收敛为图片 + Excel（xls/xlsx/xlsm），其他格式保留源链接；fetch prompt 加"图片标记原样保留"约束 |
| 2026-07-23 | 修复 | pi 引擎"agent 拉取看不到 MCP 工具"三重根因：① spawn 传 `--tools` 硬白名单静默禁用扩展平台工具（主因，已移除）；② 扩展工具注册从 `session_start` 挪到 async factory 顶层（pi 官方 await 语义，rpc 模式下 session_start 注册不进首轮模型工具清单）；③ 冷启动容错（网关 per-server 软超时 + 降级目录短冷却 + 扩展空目录重试 + `?servers=` 白名单定向枚举） |
| 2026-07-23 | 更新 | 需求拉取全面 agent 中介化：新增 `requirement-agent-fetch.ts`，删除 per-source 适配器（ones/github/generic）与 `mcp-bridge-service.ts`；pi 平台扩展读写权限分离 + servers 白名单 |
| 2026-07-21 | 创建 | 初始化模块文档 |
