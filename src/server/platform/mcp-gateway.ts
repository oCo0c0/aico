/**
 * @module platform/mcp-gateway
 * @description MCP 聚合网关（平台统一管理 MCP 的唯一入口）
 *
 * 设计决策（平台化改造核心）：
 * - MCP 服务器是平台资源（清单来自 MCPRegistryService，~/.aico/mcp-servers.json），
 *   不再由各引擎各自 spawn。本网关统一持有上游连接，向引擎提供两种消费方式：
 *     1. Claude 引擎：SDK 原生 HTTP MCP 挂载（options.mcpServers 传 {type:'http', url}），
 *        工具调用回流到本进程，平台可观测、可鉴权；
 *     2. pi 引擎：asPiCustomTools() 把上游工具投影为原生 customTools 直接注册。
 * - 上游连接懒建立（首次调用时 spawn），进程崩溃自动重连（单次重试）；
 *   工具目录在连接后缓存，refresh() 强制重建。
 * - HTTP 暴露采用 Streamable HTTP 无状态模式（每请求新建 server/transport 实例，
 *   官方推荐的无会话形态，无需维护连接状态）。
 */

import type {Express} from 'express';
import {dirname} from 'path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {MCPRegistryService} from '../services/mcp-registry-service.js';
import type {MCPServerConfig} from '../services/mcp-config-service.js';
import {MCP_REGISTRY_FILE} from '../utils/constants.js';
import {getPlatformToolRegistry, toPiCustomTool} from './tool-registry.js';
import type {PlatformToolDefinition, PlatformToolResult, PlatformToolSchema} from './types.js';

/** 网关对外的 MCP server 名（Claude 侧挂载名） */
export const PLATFORM_MCP_SERVER_NAME = 'adw-platform';

/**
 * 上游 server 的默认工作目录（平台数据目录，与注册中心文件同目录）。
 * 必须显式设置：不设时子进程继承服务启动目录，依赖 cwd 的 server会把启动目录误当项目，
 * 可能向无关目录写入数据。注册中心可按 server 覆盖（cwd 字段）。
 */
const DEFAULT_UPSTREAM_CWD = dirname(MCP_REGISTRY_FILE);

/** 上游连接的超时（毫秒）——覆盖 connect + listTools 整体 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;
/** 上游连接失败后的熔断冷却（毫秒）：冷却内不再尝试连接，避免每个请求都重新 spawn */
const UPSTREAM_FAIL_COOLDOWN_MS = 60_000;
/** 上游工具调用超时（毫秒） */
const UPSTREAM_CALL_TIMEOUT_MS = 120_000;
/** 工具目录构建的软超时（毫秒）：超时降级为空工具目录，保证 agent 启动不被阻塞 */
const TOOL_CATALOG_SOFT_TIMEOUT_MS = 10_000;
/** 单个上游连接的软超时（毫秒）：就绪的先入目录，慢启动的跳过本轮 */
const PER_SERVER_SOFT_TIMEOUT_MS = 8_000;
/** 平台 REST 面工具目录缓存时长（毫秒） */
const PLATFORM_CATALOG_TTL_MS = 30_000;
/** 降级目录（上游软超时）的短冷却：过期后下次调用重试上游枚举 */
const DEGRADED_CATALOG_TTL_MS = 2_000;
/**
 * 显式等待上游就绪的超时（毫秒）：需求拉取等「用户主动等待」场景用。
 * 与目录构建的软超时（8s）语义相反——用户点击后的等待值得长等：
 * Windows 下 npx 冷启动实测 3~15s+（npm registry 解析/解压），8s 软超时
 * 会静默跳过慢启动的上游，agent 拿到空目录只能瞎猜。
 */
const UPSTREAM_EXPLICIT_WAIT_TIMEOUT_MS = 90_000;

/** 单个上游的运行时连接状态 */
interface UpstreamConnection {
    client: Client;
    transport: StdioClientTransport;
    /** listTools 的缓存（连接成功后填充） */
    tools: Array<{name: string; description?: string; inputSchema?: unknown}>;
}

/**
 * MCP 聚合网关
 */
export class McpGateway {
    private readonly registry: MCPRegistryService;
    /** 上游连接池（name → 连接） */
    private upstreams = new Map<string, UpstreamConnection>();
    /** 连接去重：并发 ensureUpstream 共享同一 Promise */
    private pendingConnects = new Map<string, Promise<UpstreamConnection>>();
    /** 熔断冷却表（name → 失败解除时间戳）：防止失败后每个请求都重新 spawn */
    private failedUntil = new Map<string, number>();
    /** 本网关 HTTP endpoint（attachToExpress + setEndpoint 后可用） */
    private endpoint: string | null = null;
    /** 平台 REST 面端点（引擎子进程内的扩展回连主进程用） */
    private platformEndpoint: {url: string; apiKey?: string} | null = null;
    /** 平台工具目录缓存（REST 面序列化视图 + 调用分发表） */
    private platformCatalog: PlatformToolDefinition[] | null = null;
    private platformCatalogAt = 0;
    /** 上次目录是否为软超时降级结果（降级目录只短冷却，尽快重试上游） */
    private platformCatalogDegraded = false;
    private disposed = false;

    constructor(registry?: MCPRegistryService) {
        this.registry = registry ?? new MCPRegistryService();
    }

    // === 上游连接管理 ===

    /** 启用中的上游清单 */
    private enabledServers(): MCPServerConfig[] {
        try {
            return this.registry.list().filter((s) => s.enabled !== false);
        } catch {
            return [];
        }
    }

    /**
     * 确保与指定上游的连接（懒连接 + 并发去重 + 失败熔断）
     * @throws 连接失败/超时/熔断冷却中抛出（调用方决定跳过或报错）
     */
    private async ensureUpstream(name: string): Promise<UpstreamConnection> {
        const existing = this.upstreams.get(name);
        if (existing) return existing;

        // 熔断冷却中：直接失败，不再 spawn（Windows 下 npx 冷启动可达数十秒，
        // 失败后若每个请求都重试，一次连接故障会拖死全部引擎请求）
        if (this.isCircuitOpen(name)) {
            throw new Error(`MCP server "${name}" is in failure cooldown (recent connect attempt failed)`);
        }

        const pending = this.pendingConnects.get(name);
        if (pending) return pending;

        const connectPromise = this.connectUpstream(name).finally(() => {
            this.pendingConnects.delete(name);
        });
        this.pendingConnects.set(name, connectPromise);
        return connectPromise;
    }

    /** 记录上游熔断（连接失败后冷却期内不再重试） */
    private failCircuit(name: string): void {
        this.failedUntil.set(name, Date.now() + UPSTREAM_FAIL_COOLDOWN_MS);
    }

    /** 上游是否处于熔断冷却中 */
    private isCircuitOpen(name: string): boolean {
        const until = this.failedUntil.get(name);
        return until !== undefined && until > Date.now();
    }

    /** 实际建立连接并 listTools（connect + listTools 整体限时） */
    private async connectUpstream(name: string): Promise<UpstreamConnection> {
        const config = this.enabledServers().find((s) => s.name === name);
        if (!config) {
            throw new Error(`MCP server "${name}" is not registered or disabled`);
        }

        const {command, args} = normalizeWindowsCommand(config.command, config.args ?? []);
        const transport = new StdioClientTransport({
            command,
            args,
            env: {...config.env, ...pickDefaultEnv()},
            // 不继承 stderr：server 的启动 banner 不再灌入主进程控制台
            //（SDK 对 pipe 模式用 PassThrough 消费，不会阻塞子进程输出）
            stderr: 'pipe',
            // 工作目录：默认平台数据目录，注册中心可 per-server 覆盖
            cwd: config.cwd?.trim() ? config.cwd : DEFAULT_UPSTREAM_CWD,
        });
        const client = new Client({name: 'adw-platform-gateway', version: '1.0.0'}, {});

        try {
            // connect + listTools 整体限时：server 进程存在但协议未就绪时
            //（npx 冷启动慢），避免无限等待挂死共享同一 pending 的后续请求
            const result = await withTimeout(
                (async () => {
                    await client.connect(transport);
                    return client.listTools();
                })(),
                UPSTREAM_CONNECT_TIMEOUT_MS,
                `MCP server "${name}" connect timeout`,
            );
            const connection: UpstreamConnection = {
                client,
                transport,
                tools: (result.tools ?? []).map((t) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                })),
            };
            this.upstreams.set(name, connection);
            this.failedUntil.delete(name);
            return connection;
        } catch (err) {
            // 失败清理：关闭半开连接防止子进程泄漏，并进入熔断冷却
            try {
                await client.close();
            } catch {
                // 连接未建立时忽略关闭错误
            }
            this.failCircuit(name);
            throw err;
        }
    }

    /** 关闭并移除上游连接 */
    private async dropUpstream(name: string): Promise<void> {
        const conn = this.upstreams.get(name);
        this.upstreams.delete(name);
        if (conn) {
            try {
                await conn.client.close();
            } catch {
                // 连接已死时忽略关闭错误
            }
        }
    }

    /**
     * 调用上游工具（崩溃自动重连一次后重试）
     */
    private async callUpstream(
        serverName: string,
        toolName: string,
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<PlatformToolResult> {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const conn = await this.ensureUpstream(serverName);
                const result = await conn.client.callTool(
                    {name: toolName, arguments: args},
                    undefined,
                    {timeout: UPSTREAM_CALL_TIMEOUT_MS, ...(signal ? {signal} : {})},
                );
                const payload = result as {content?: Array<{type?: string; text?: string}>; isError?: boolean};
                const text = (payload.content ?? [])
                    .map((block) => (typeof block.text === 'string' ? block.text : ''))
                    .join('\n')
                    .trim();
                return {
                    text: text || JSON.stringify(result),
                    isError: payload.isError === true,
                };
            } catch (err) {
                // 连接类错误：丢弃连接，重连重试一次
                await this.dropUpstream(serverName);
                if (attempt === 1) {
                    throw err;
                }
            }
        }
        /* istanbul ignore next -- 循环必然 return 或 throw，此处不可达 */
        throw new Error(`MCP upstream "${serverName}" call failed`);
    }

    // === 工具目录（聚合视图） ===

    /**
     * 列出上游工具（懒连接；失败的上游跳过并记日志）
     * @param allowed - 可选的 server 名白名单（pipeline 的 per-phase MCP 选择）；
     *                  缺省 = 全部 enabled 上游
     * @description 工具名带 server 前缀（`<server>__<tool>`）保证全局唯一。
     */
    async listUpstreamTools(allowed?: string[]): Promise<PlatformToolDefinition[]> {
        const allowSet = allowed && allowed.length > 0 ? new Set(allowed) : undefined;
        const servers = this.enabledServers().filter((s) => !allowSet || allowSet.has(s.name));
        const tools: PlatformToolDefinition[] = [];

        await Promise.all(
            servers.map(async (server) => {
                // 熔断冷却中的上游静默跳过（失败告警已在连接时输出过一次）
                if (this.isCircuitOpen(server.name)) return;
                try {
                    // 每 server 独立软超时：就绪的先上桌，慢启动的（Windows npx
                    // 冷启动可达数十秒）本轮跳过、后台继续连——避免一个慢
                    // server 把整张目录拖过全局软超时（agent 冷启动看不到工具）
                    const conn = await withTimeout(
                        this.ensureUpstream(server.name),
                        PER_SERVER_SOFT_TIMEOUT_MS,
                        `[mcp-gateway] upstream "${server.name}" still starting (soft timeout), skipped this round`,
                    );
                    for (const tool of conn.tools) {
                        tools.push({
                            name: `${server.name}__${tool.name}`,
                            label: `${server.name}.${tool.name}`,
                            description: tool.description || `MCP tool "${tool.name}" from server "${server.name}"`,
                            category: 'mcp',
                            inputSchema: (tool.inputSchema as PlatformToolSchema) ?? {type: 'object'},
                            execute: (args, ctx) =>
                                this.callUpstream(server.name, tool.name, args, ctx.signal),
                        });
                    }
                } catch (err) {
                    console.warn(`[mcp-gateway] upstream "${server.name}" unavailable: ${err instanceof Error ? err.message : String(err)}`);
                }
            }),
        );

        return tools;
    }

    /**
     * 投影为 pi 引擎的 customTools（上游工具 + 平台原生工具）
     * @description 工具目录构建带软超时：上游冷启动超时时降级为仅原生工具，
     * 保证 agent 启动永远不被 MCP 阻塞（下次 run 时上游连接已缓存即可用）
     */
    async asPiCustomTools(source: string): Promise<Array<Record<string, unknown>>> {
        const upstreamTools = await withTimeout(
            this.listUpstreamTools(),
            TOOL_CATALOG_SOFT_TIMEOUT_MS,
            '[mcp-gateway] upstream tool catalog soft timeout, degrading to native tools only',
        ).catch((err: unknown) => {
            console.warn(err instanceof Error ? err.message : String(err));
            return [] as PlatformToolDefinition[];
        });
        const nativeTools = getPlatformToolRegistry().list();
        return [...upstreamTools, ...nativeTools].map((tool) => toPiCustomTool(tool, source));
    }

    // === Claude 引擎消费入口（HTTP MCP） ===

    /**
     * 设置本网关的 HTTP endpoint（attachToExpress 配套调用）
     * @example setEndpoint('http://127.0.0.1:3777/api/mcp')
     */
    setEndpoint(url: string): void {
        this.endpoint = url;
    }

    /**
     * Claude SDK 的 mcpServers 注入参数（HTTP 挂载本网关）
     * @param servers - 可选的 server 名白名单（经 url query 过滤，
     *                  保留 pipeline 的 per-phase MCP 选择语义）
     * @description 未设置 endpoint（网关未随服务启动）时返回 undefined，
     * 调用方回退到 stdio 直挂模式。endpoint 可携带已有的 query 参数
     * （如 apiKey 认证），本方法按需追加 servers 过滤参数。
     */
    asClaudeMcpServers(servers?: string[]): Record<string, {type: 'http'; url: string}> | undefined {
        if (!this.endpoint) return undefined;
        let url = this.endpoint;
        if (servers && servers.length > 0) {
            url += `${url.includes('?') ? '&' : '?'}servers=${encodeURIComponent(servers.join(','))}`;
        }
        return {[PLATFORM_MCP_SERVER_NAME]: {type: 'http', url}};
    }

    /**
     * 构造聚合 Server 实例（平台原生工具 + 上游转发工具）
     * @param allowed - 可选的 server 名白名单（url query 传入）
     * @description Streamable HTTP 无状态模式：每个 HTTP 请求新建实例，
     * 注册是纯内存轻量操作。上游连接是网关级共享的（不随请求销毁）。
     *
     * ⚠️ 必须用低层 Server + 显式 handler，不能用高层 McpServer.registerTool：
     * registerTool 的 inputSchema 只接受 Zod schema / ZodRawShape，而网关手里的
     * 是上游原始 JSON Schema——注册即抛「inputSchema must be a Zod schema or raw
     * shape」，首个 initialize 请求直接 500，Claude CLI 视 adw-platform 为坏
     * server，模型一个平台工具都看不到（2026-10-08 需求拉取失败的根因）。
     * 协议线格式的 inputSchema 本就是 JSON Schema，低层 handler 原样透传即可。
     */
    private async createAggregateServer(allowed?: string[]): Promise<Server> {
        const server = new Server(
            {name: PLATFORM_MCP_SERVER_NAME, version: '1.0.0'},
            {capabilities: {tools: {listChanged: false}}},
        );

        const allTools = [
            ...(await this.listUpstreamTools(allowed)),
            ...getPlatformToolRegistry().list(),
        ];

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: allTools.map((tool) => ({
                name: tool.name,
                title: tool.label,
                description: tool.description,
                inputSchema: tool.inputSchema,
            })),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const tool = allTools.find((t) => t.name === request.params.name);
            if (!tool) {
                return {
                    content: [{type: 'text' as const, text: `未找到工具: ${request.params.name}`}],
                    isError: true,
                };
            }
            try {
                const result = await tool.execute(request.params.arguments ?? {}, {source: 'claude'});
                return {
                    content: [{type: 'text' as const, text: result.text}],
                    isError: result.isError === true,
                };
            } catch (err) {
                // 执行异常包装为 isError 结果回喂模型（连接类错误已由 callUpstream 重连兜底）
                const message = err instanceof Error ? err.message : String(err);
                return {
                    content: [{type: 'text' as const, text: `工具执行失败: ${message}`}],
                    isError: true,
                };
            }
        });
        return server;
    }

    /**
     * 将网关挂载到 Express（Streamable HTTP 无状态端点）
     * @description 挂载后需调用 setEndpoint() 登记 URL，asClaudeMcpServers 才会生效。
     * POST /mcp 处理初始化与工具调用；GET/DELETE 按协议返回 405（无状态模式不支持）。
     */
    attachToExpress(app: Express, mountPath: string): void {
        app.post(mountPath, async (req, res) => {
            await this.handleMcpRequest(req, res);
        });
        app.get(mountPath, (_req, res) => {
            res.status(405).json({error: 'Method not allowed (stateless MCP endpoint)'});
        });
        app.delete(mountPath, (_req, res) => {
            res.status(405).json({error: 'Method not allowed (stateless MCP endpoint)'});
        });
    }

    /**
     * 处理单个 MCP HTTP 请求（无状态 Streamable HTTP）
     * @description 每个请求：按 query.servers 过滤 → 新建聚合 server + transport
     * → connect → handleRequest（body 已被全局 express.json() 预解析，按官方
     * 三参形式透传）。连接关闭时同步销毁 server/transport。
     */
    private async handleMcpRequest(
        req: import('express').Request,
        res: import('express').Response,
    ): Promise<void> {
        try {
            const allowed = parseServersQuery(req.query.servers);
            const server = await this.createAggregateServer(allowed);
            const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined});
            res.on('close', () => {
                transport.close().catch(() => { /* ignore */ });
                server.close().catch(() => { /* ignore */ });
            });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!res.headersSent) {
                res.status(500).json({jsonrpc: '2.0', error: {code: -32603, message}, id: null});
            }
        }
    }

    /**
     * 预热：后台建立全部上游连接并缓存工具目录（失败静默，熔断冷却自管理）。
     * 服务启动时 fire-and-forget 调用——任务首次 MCP 交互无需再等 server
     * 冷启动（Windows 下 npx 启动一个 server 可达数十秒）。
     */
    warmUp(): Promise<void> {
        return this.listUpstreamTools().then(() => undefined);
    }

    // === 显式就绪等待（需求拉取等用户主动等待场景） ===

    /**
     * 显式等待指定上游就绪：与 listUpstreamTools 的软超时（8s 跳过）语义相反，
     * 这里允许长等（默认 90s）并忽略熔断冷却（用户点击 = 明确重试意图）。
     * 供需求 agent 拉取在启动引擎前调用——上游没就绪就开跑，agent 只会
     * 拿到空工具目录然后瞎猜；逐 server 返回结论，调用方可精确报错/展示进度。
     * @param names 上游 server 名清单（白名单语义，与 registry 名一致）
     */
    async ensureUpstreamsReady(names: string[], timeoutMs: number = UPSTREAM_EXPLICIT_WAIT_TIMEOUT_MS): Promise<Array<{name: string; ok: boolean; toolCount?: number; reason?: string}>> {
        return Promise.all(names.map(async (name) => {
            // 显式等待：清除熔断冷却，让 ensureUpstream 真正重试连接
            this.failedUntil.delete(name);
            try {
                const conn = await withTimeout(
                    this.ensureUpstream(name),
                    timeoutMs,
                    `MCP server "${name}" 连接超时（${Math.round(timeoutMs / 1000)}s 内未完成握手）`,
                );
                return {name, ok: true, toolCount: conn.tools.length};
            } catch (err) {
                return {name, ok: false, reason: err instanceof Error ? err.message : String(err)};
            }
        }));
    }

    // === 引擎子进程消费入口（平台 REST 面） ===

    /**
     * 登记平台 REST 面端点（供引擎子进程内的扩展回连）
     * @description 由 index.ts 在挂载后调用；PiProvider spawn 子进程时
     * 经 ADW_PLATFORM_URL / ADW_PLATFORM_KEY 环境变量注入给扩展。
     */
    setPlatformEndpoint(url: string, apiKey?: string): void {
        this.platformEndpoint = {url, apiKey};
    }

    /** 平台 REST 面端点（未启用返回 null） */
    getPlatformEndpoint(): {url: string; apiKey?: string} | null {
        return this.platformEndpoint;
    }

    /**
     * 平台工具目录（正常 30 秒缓存；含上游转发工具 + 平台原生工具）
     * @description REST 序列化视图不含 execute；调用经 /call 按名分发表路由。
     *
     * 冷启动容错：上游枚举软超时（TOOL_CATALOG_SOFT_TIMEOUT_MS）会降级为
     * 仅原生工具（常见于 Windows npx 上游冷启动数秒到数十秒）。降级目录
     * 只缓存 DEGRADED_CATALOG_TTL_MS（短冷却，防止每次请求都重枚举打爆
     * 上游），过期后下一次调用立即重试上游——避免"刚重启后拉取需求时
     * agent 看不到任何 MCP 工具"的竞态。
     */
    private async listPlatformCatalog(force = false): Promise<PlatformToolDefinition[]> {
        if (!force && this.platformCatalog) {
            const ttl = this.platformCatalogDegraded ? DEGRADED_CATALOG_TTL_MS : PLATFORM_CATALOG_TTL_MS;
            if (Date.now() - this.platformCatalogAt < ttl) return this.platformCatalog;
        }
        let upstream: PlatformToolDefinition[] = [];
        let degraded = false;
        try {
            upstream = await withTimeout(
                this.listUpstreamTools(),
                TOOL_CATALOG_SOFT_TIMEOUT_MS,
                '[mcp-gateway] platform catalog soft timeout, degrading to native tools only',
            );
        } catch {
            degraded = true;
        }
        this.platformCatalog = [...upstream, ...getPlatformToolRegistry().list()];
        this.platformCatalogDegraded = degraded;
        this.platformCatalogAt = Date.now();
        return this.platformCatalog;
    }

    /**
     * 将平台 REST 面挂载到 Express（引擎子进程消费）
     * - GET  {base}/tools?servers=a,b → 工具目录（name/label/description/inputSchema），
     *   可选 servers 白名单：只保留 <server>__ 前缀命中的转发工具（与
     *   asClaudeMcpServers 的 ?servers= 语义一致；agent 拉取等场景收敛工具面），
     *   且**只枚举白名单内的上游**——冷启动不必陪跑慢 server（Windows npx）
     * - POST {base}/call  → {name, args} 执行（统一超时/熔断/重连）
     * @description 受全局 apiKey 中间件保护（配置了 config.auth.apiKey 时），
     * 扩展侧以 x-api-key 头携带。仅本机回环使用，不对外暴露语义。
     */
    attachPlatformApi(app: Express, basePath: string): void {
        app.get(`${basePath}/tools`, async (req, res) => {
            try {
                const servers = parseServersQuery(req.query.servers);
                let visible: PlatformToolDefinition[];
                if (servers) {
                    // 白名单查询：绕过共享缓存（过滤目录不污染全量目录），
                    // 直接枚举白名单内上游 + 按前缀过滤兜底
                    const upstream = await this.listUpstreamTools(servers);
                    visible = upstream.filter((t) => {
                        const prefix = t.name.includes('__') ? t.name.slice(0, t.name.indexOf('__')) : null;
                        return prefix !== null && servers.includes(prefix);
                    });
                } else {
                    visible = await this.listPlatformCatalog();
                }
                res.json(visible.map((t) => ({
                    name: t.name,
                    label: t.label,
                    description: t.description,
                    inputSchema: t.inputSchema,
                })));
            } catch (err) {
                res.status(500).json({error: err instanceof Error ? err.message : String(err)});
            }
        });

        app.post(`${basePath}/call`, async (req, res) => {
            const body = req.body as {name?: unknown; args?: unknown} | undefined;
            const name = typeof body?.name === 'string' ? body.name : '';
            const args = (body?.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
            if (!name) {
                res.status(400).json({error: 'name is required'});
                return;
            }
            try {
                const catalog = await this.listPlatformCatalog();
                let tool = catalog.find((t) => t.name === name);
                if (!tool) {
                    // 缓存未命中（如白名单会话只枚举了部分上游）：按 <server>__ 前缀定向重枚举
                    const prefix = name.includes('__') ? name.slice(0, name.indexOf('__')) : null;
                    if (prefix) {
                        tool = (await this.listUpstreamTools([prefix])).find((t) => t.name === name);
                    }
                }
                if (!tool) {
                    res.status(404).json({error: `unknown platform tool: ${name}`});
                    return;
                }
                const result = await tool.execute(args, {source: 'pi'});
                res.json(result);
            } catch (err) {
                // 执行异常以 isError 结果回喂模型（HTTP 200，模型可读的错误文本）
                res.json({text: `平台工具执行失败：${err instanceof Error ? err.message : String(err)}`, isError: true});
            }
        });
    }

    /**
     * 强制刷新工具目录（断开全部上游，下次访问重连）
     */
    async refresh(): Promise<void> {
        const names = Array.from(this.upstreams.keys());
        await Promise.all(names.map((name) => this.dropUpstream(name)));
    }

    /** 释放全部上游连接 */
    async dispose(): Promise<void> {
        this.disposed = true;
        await this.refresh();
    }
}

/** 解析 url query 的 servers 白名单（逗号分隔） */
function parseServersQuery(raw: unknown): string[] | undefined {
    if (typeof raw !== 'string' || raw.trim() === '') return undefined;
    const servers = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return servers.length > 0 ? servers : undefined;
}

/** 给无原生超时参数的调用加超时（Promise.race 实现） */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// === 工具函数 ===

/**
 * Windows 命令归一化
 * @description MCP SDK 的 StdioClientTransport 直接 spawn（无 shell）。
 * Windows 下 npx/node 等脚本命令必须经 cmd /c 启动，否则 spawn 报 ENOENT。
 * 已是可执行文件（.exe/.cmd/.bat）时原样返回。
 */
export function normalizeWindowsCommand(
    command: string,
    args: string[],
): {command: string; args: string[]} {
    if (process.platform !== 'win32') return {command, args};
    if (/\.(exe|cmd|bat)$/i.test(command)) return {command, args};
    return {command: 'cmd', args: ['/c', command, ...args]};
}

/**
 * 上游子进程的环境变量（白名单透传）。
 * 此前只透传 PATH 的极简 env 会让 npm/npx 找不到缓存与临时目录
 * （APPDATA/LOCALAPPDATA/TEMP 缺失）：实测 npx 冷启动从 ~3.5s 劣化到 ~10s，
 * 超出目录软超时 → 上游被静默跳过 → agent 拿到空工具目录。
 * 这里透传 Windows 程序正常工作所需的系统变量 + npm 配置（registry 镜像等），
 * 不透传业务密钥类变量（鉴权仍由注册中心 per-server env 提供）。
 */
function pickDefaultEnv(): Record<string, string> {
    const passthrough = [
        'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'OS',
        'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
        'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'TEMP', 'TMP',
        'USERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
        'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_CACHE', 'NODE_OPTIONS',
    ];
    const out: Record<string, string> = {};
    for (const key of passthrough) {
        const value = process.env[key];
        if (value !== undefined) out[key] = value;
    }
    return out;
}

// === 单例 ===

let gatewayInstance: McpGateway | null = null;

/** 获取 MCP 网关单例（进程内共享；测试可用 resetMcpGateway 重置） */
export function getMcpGateway(): McpGateway {
    if (!gatewayInstance) {
        gatewayInstance = new McpGateway();
    }
    return gatewayInstance;
}

/** 重置网关单例（测试隔离用） */
export function resetMcpGateway(): void {
    gatewayInstance = null;
}
