/**
 * @module platform/mcp-gateway.test
 * @description MCP 聚合网关单元测试（不连接真实上游进程）
 */

import {describe, it, expect, afterEach, vi} from 'vitest';
import express from 'express';
import type {Server} from 'http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {McpGateway, PLATFORM_MCP_SERVER_NAME, normalizeWindowsCommand} from './mcp-gateway.js';
import {getPlatformToolRegistry} from './tool-registry.js';
import type {PlatformToolDefinition} from './types.js';
import type {MCPRegistryService} from '../services/mcp-registry-service.js';

/** 空注册中心 stub（不读真实 ~/.aico/mcp-servers.json） */
function emptyRegistry(): MCPRegistryService {
    return {list: () => []} as unknown as MCPRegistryService;
}

describe('normalizeWindowsCommand', () => {
    it('Windows 下脚本命令经 cmd /c 包装', () => {
        if (process.platform !== 'win32') return; // 仅 Windows 生效
        const result = normalizeWindowsCommand('npx', ['-y', 'server.js']);
        expect(result.command).toBe('cmd');
        expect(result.args).toEqual(['/c', 'npx', '-y', 'server.js']);
    });

    it('已是可执行文件（.exe/.cmd/.bat）不重复包装', () => {
        if (process.platform !== 'win32') return;
        const result = normalizeWindowsCommand('node.exe', ['server.js']);
        expect(result.command).toBe('node.exe');
        expect(result.args).toEqual(['server.js']);
    });
});

describe('McpGateway', () => {
    it('endpoint 未设置时 asClaudeMcpServers 返回 undefined（回退 stdio 的信号）', () => {
        const gateway = new McpGateway(emptyRegistry());
        expect(gateway.asClaudeMcpServers()).toBeUndefined();
    });

    it('设置 endpoint 后返回 HTTP 挂载配置', () => {
        const gateway = new McpGateway(emptyRegistry());
        gateway.setEndpoint('http://127.0.0.1:3777/api/mcp');
        expect(gateway.asClaudeMcpServers()).toEqual({
            [PLATFORM_MCP_SERVER_NAME]: {type: 'http', url: 'http://127.0.0.1:3777/api/mcp'},
        });
    });

    it('servers 白名单以 query 追加，兼容已带 query 的 endpoint', () => {
        const gateway = new McpGateway(emptyRegistry());
        gateway.setEndpoint('http://127.0.0.1:3777/api/mcp?apiKey=secret');

        const servers = gateway.asClaudeMcpServers(['ones', 'github']);
        expect(servers?.[PLATFORM_MCP_SERVER_NAME].url).toBe(
            'http://127.0.0.1:3777/api/mcp?apiKey=secret&servers=ones%2Cgithub'
        );

        gateway.setEndpoint('http://127.0.0.1:3777/api/mcp');
        const plain = gateway.asClaudeMcpServers(['ones']);
        expect(plain?.[PLATFORM_MCP_SERVER_NAME].url).toBe(
            'http://127.0.0.1:3777/api/mcp?servers=ones'
        );
    });

    it('无上游时 listUpstreamTools 返回空数组', async () => {
        const gateway = new McpGateway(emptyRegistry());
        await expect(gateway.listUpstreamTools()).resolves.toEqual([]);
    });

    it('dispose 不抛出（无连接时）', async () => {
        const gateway = new McpGateway(emptyRegistry());
        await expect(gateway.dispose()).resolves.toBeUndefined();
    });

    it('setPlatformEndpoint / getPlatformEndpoint 往返（含 apiKey）', () => {
        const gateway = new McpGateway(emptyRegistry());
        expect(gateway.getPlatformEndpoint()).toBeNull();
        gateway.setPlatformEndpoint('http://127.0.0.1:3000/api/platform', 'secret');
        expect(gateway.getPlatformEndpoint()).toEqual({url: 'http://127.0.0.1:3000/api/platform', apiKey: 'secret'});
    });

    // === ensureUpstreamsReady（显式就绪等待，需求拉取用） ===

    it('就绪的上游返回 ok + 工具数', async () => {
        const gateway = new McpGateway(emptyRegistry());
        vi.spyOn(gateway as never as {ensureUpstream(name: string): Promise<unknown>}, 'ensureUpstream')
            .mockResolvedValue({tools: [{name: 'a'}, {name: 'b'}]});

        const result = await gateway.ensureUpstreamsReady(['ones-api']);
        expect(result).toEqual([{name: 'ones-api', ok: true, toolCount: 2}]);
        vi.restoreAllMocks();
    });

    it('连接失败 → 逐项 ok:false + 可读原因（不抛出）', async () => {
        const gateway = new McpGateway(emptyRegistry());
        vi.spyOn(gateway as never as {ensureUpstream(name: string): Promise<unknown>}, 'ensureUpstream')
            .mockRejectedValue(new Error('spawn ENOENT'));

        const result = await gateway.ensureUpstreamsReady(['ones-api']);
        expect(result).toEqual([{name: 'ones-api', ok: false, reason: 'spawn ENOENT'}]);
        vi.restoreAllMocks();
    });

    it('忽略熔断冷却：清除 failedUntil 后真正重试连接', async () => {
        const gateway = new McpGateway(emptyRegistry());
        const internal = gateway as never as {failedUntil: Map<string, number>};
        internal.failedUntil.set('ones-api', Date.now() + 60_000); // 模拟熔断中
        const ensureSpy = vi.spyOn(gateway as never as {ensureUpstream(name: string): Promise<unknown>}, 'ensureUpstream')
            .mockResolvedValue({tools: [{name: 't'}]});

        const result = await gateway.ensureUpstreamsReady(['ones-api']);
        expect(result[0].ok).toBe(true); // 冷却被绕过，连接真正重试
        expect(ensureSpy).toHaveBeenCalledWith('ones-api');
        expect(internal.failedUntil.has('ones-api')).toBe(false); // 冷却已清除
        vi.restoreAllMocks();
    });

    it('超时上限生效：永不就绪的上游在 timeoutMs 后返回超时原因', async () => {
        const gateway = new McpGateway(emptyRegistry());
        vi.spyOn(gateway as never as {ensureUpstream(name: string): Promise<unknown>}, 'ensureUpstream')
            .mockImplementation(() => new Promise(() => undefined)); // 永不 resolve

        const result = await gateway.ensureUpstreamsReady(['slow'], 50);
        expect(result[0].ok).toBe(false);
        expect(result[0].reason).toContain('连接超时');
        vi.restoreAllMocks();
    }, 5_000);
});

describe('McpGateway 平台 REST 面（/api/platform）', () => {
    const servers: Server[] = [];

    function listen(app: ReturnType<typeof express>): Promise<string> {
        return new Promise((resolve) => {
            const server = app.listen(0, '127.0.0.1', () => {
                servers.push(server);
                const addr = server.address();
                if (addr && typeof addr === 'object') {
                    resolve(`http://127.0.0.1:${addr.port}`);
                }
            });
        });
    }

    afterEach(async () => {
        await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    });

    /** 注册一个测试用原生工具 */
    function registerEchoTool(): PlatformToolDefinition {
        const registry = getPlatformToolRegistry();
        const tool: PlatformToolDefinition = {
            name: 'test__echo',
            label: 'Echo',
            description: '回显输入',
            category: 'mcp',
            inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']},
            async execute(args) {
                return {text: `echo: ${String(args.text ?? '')}`};
            },
        };
        registry.register(tool);
        return tool;
    }

    it('GET /tools 返回工具目录（不含 execute）；POST /call 执行平台工具', async () => {
        const tool = registerEchoTool();
        const gateway = new McpGateway(emptyRegistry());
        const app = express();
        app.use(express.json());
        gateway.attachPlatformApi(app, '/api/platform');
        const base = await listen(app);

        try {
            const listRes = await fetch(`${base}/api/platform/tools`);
            expect(listRes.status).toBe(200);
            const catalog = await listRes.json() as Array<Record<string, unknown>>;
            const echo = catalog.find((t) => t.name === 'test__echo');
            expect(echo).toBeDefined();
            expect(echo!.inputSchema).toEqual(tool.inputSchema);
            // 目录视图不含执行函数
            expect(echo!.execute).toBeUndefined();

            const callRes = await fetch(`${base}/api/platform/call`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({name: 'test__echo', args: {text: '你好'}}),
            });
            expect(callRes.status).toBe(200);
            expect(await callRes.json()).toEqual({text: 'echo: 你好'});
        } finally {
            getPlatformToolRegistry().unregister('test__echo');
        }
    });

    it('POST /call 未知工具返回 404；缺 name 返回 400；执行异常回喂 isError 结果', async () => {
        const registry = getPlatformToolRegistry();
        registry.register({
            name: 'test__boom',
            label: 'Boom',
            description: '总是抛错',
            category: 'mcp',
            inputSchema: {type: 'object', properties: {}},
            async execute() {
                throw new Error('炸了');
            },
        });
        const gateway = new McpGateway(emptyRegistry());
        const app = express();
        app.use(express.json());
        gateway.attachPlatformApi(app, '/api/platform');
        const base = await listen(app);

        try {
            const missing = await fetch(`${base}/api/platform/call`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({args: {}}),
            });
            expect(missing.status).toBe(400);

            const unknown = await fetch(`${base}/api/platform/call`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({name: 'nope', args: {}}),
            });
            expect(unknown.status).toBe(404);

            const boom = await fetch(`${base}/api/platform/call`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({name: 'test__boom', args: {}}),
            });
            expect(boom.status).toBe(200);
            const payload = await boom.json() as {text: string; isError: boolean};
            expect(payload.isError).toBe(true);
            expect(payload.text).toContain('炸了');
        } finally {
            registry.unregister('test__boom');
        }
    });

    it('GET /tools?servers= 白名单：只枚举白名单内上游并按前缀过滤', async () => {
        const gateway = new McpGateway(emptyRegistry());
        // 打桩上游枚举：断言 (a) 只枚举白名单 server（冷启动不陪跑慢 server）
        // (b) 返回目录只含白名单前缀
        const enumerateArgs: Array<string[] | undefined> = [];
        vi.spyOn(gateway, 'listUpstreamTools').mockImplementation(async (allowed?: string[]) => {
            enumerateArgs.push(allowed);
            return [
                {name: 'ones__get_work_item', label: 'Get', description: 'd', inputSchema: {type: 'object'}, async execute() { return {text: ''}; }} as PlatformToolDefinition,
                {name: 'github__get_issue', label: 'GH', description: 'd', inputSchema: {type: 'object'}, async execute() { return {text: ''}; }} as PlatformToolDefinition,
            ];
        });
        const app = express();
        app.use(express.json());
        gateway.attachPlatformApi(app, '/api/platform');
        const base = await listen(app);

        try {
            // 白名单只留 ones：定向枚举 + 前缀过滤
            const filtered = await fetch(`${base}/api/platform/tools?servers=ones`);
            const list = await filtered.json() as Array<{name: string}>;
            expect(list.map(t => t.name)).toEqual(['ones__get_work_item']);
            expect(enumerateArgs[0]).toEqual(['ones']);

            // 不带 query → 全量缓存目录（allowed 为 undefined）
            await fetch(`${base}/api/platform/tools`);
            expect(enumerateArgs[1]).toBeUndefined();
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('单上游慢启动不拖累整张目录：就绪的先入目录（per-server 软超时）', async () => {
        const registry = {
            list: () => [
                {name: 'fast', type: 'custom', command: 'x', args: [], env: {}, enabled: true},
                {name: 'slow', type: 'custom', command: 'x', args: [], env: {}, enabled: true},
            ],
        } as unknown as MCPRegistryService;
        const gateway = new McpGateway(registry);
        // fast 立即就绪；slow 永不连接（模拟 npx 冷启动超过软超时）
        vi.spyOn(gateway as never as {ensureUpstream(name: string): Promise<unknown>}, 'ensureUpstream')
            .mockImplementation((name: string) => name === 'fast'
                ? Promise.resolve({tools: [{name: 'tool_a', description: 'd'}]})
                : new Promise(() => undefined));

        const tools = await gateway.listUpstreamTools();
        expect(tools.map(t => t.name)).toEqual(['fast__tool_a']);
        vi.restoreAllMocks();
    }, 12_000);

    it('降级目录（上游软超时）只短冷却：过期后重试上游恢复工具', async () => {
        const gateway = new McpGateway(emptyRegistry());
        // 打桩上游枚举：第一次拒绝（模拟软超时降级），之后返回工具
        let upstreamCalls = 0;
        vi.spyOn(gateway, 'listUpstreamTools').mockImplementation(async () => {
            upstreamCalls++;
            if (upstreamCalls === 1) throw new Error('soft timeout');
            return [{
                name: 'ones-api__get_work_item',
                label: 'Get',
                description: 'd',
                inputSchema: {type: 'object', properties: {}},
                async execute() {
                    return {text: 'ok'};
                },
            } as PlatformToolDefinition];
        });
        const app = express();
        app.use(express.json());
        gateway.attachPlatformApi(app, '/api/platform');
        const base = await listen(app);

        try {
            // 第一次：上游超时 → 降级空目录
            const first = await (await fetch(`${base}/api/platform/tools`)).json() as Array<{name: string}>;
            expect(first).toEqual([]);
            expect(upstreamCalls).toBe(1);

            // 等待降级冷却（2s）过期后重试：上游已就绪 → 目录恢复
            await new Promise((r) => setTimeout(r, 2_100));
            const second = await (await fetch(`${base}/api/platform/tools`)).json() as Array<{name: string}>;
            expect(second.map(t => t.name)).toEqual(['ones-api__get_work_item']);
            expect(upstreamCalls).toBe(2);

            // 正常目录走 30s 缓存：再次请求不再枚举上游
            await fetch(`${base}/api/platform/tools`);
            expect(upstreamCalls).toBe(2);
        } finally {
            vi.restoreAllMocks();
        }
    });
});

describe('McpGateway MCP 协议面（/api/mcp）', () => {
    const servers: Server[] = [];

    function listen(app: ReturnType<typeof express>): Promise<string> {
        return new Promise((resolve) => {
            const server = app.listen(0, '127.0.0.1', () => {
                servers.push(server);
                const addr = server.address();
                if (addr && typeof addr === 'object') {
                    resolve(`http://127.0.0.1:${addr.port}`);
                }
            });
        });
    }

    afterEach(async () => {
        await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    });

    /**
     * 回归测试（2026-10-08 需求拉取失败根因）：
     * 聚合 server 曾用高层 McpServer.registerTool 注册上游原始 JSON Schema，
     * registerTool 只接受 Zod schema —— 注册即抛错，首个 initialize 请求 500，
     * Claude CLI 视 adw-platform 为坏 server，模型拿不到任何平台工具。
     * 这里用官方 MCP 客户端走真实协议：initialize → tools/list → tools/call。
     */
    it('initialize + tools/list + tools/call 全链路：inputSchema 原样透传（JSON Schema，非 Zod）', async () => {
        const registry = getPlatformToolRegistry();
        registry.register({
            name: 'test__echo',
            label: 'Echo',
            description: '回显输入',
            category: 'mcp',
            inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']},
            async execute(args) {
                return {text: `echo: ${String(args.text ?? '')}`};
            },
        });
        const gateway = new McpGateway(emptyRegistry());
        const app = express();
        app.use(express.json());
        gateway.attachToExpress(app, '/api/mcp');
        const base = await listen(app);

        const client = new Client({name: 'protocol-test', version: '1.0.0'});
        const transport = new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`));
        try {
            // 修复前此处直接抛「inputSchema must be a Zod schema or raw shape」
            await client.connect(transport);

            const tools = await client.listTools();
            const echo = tools.tools.find((t) => t.name === 'test__echo');
            expect(echo).toBeDefined();
            // JSON Schema 原样下发（不要求调用方持有 Zod）
            expect(echo!.inputSchema).toEqual({
                type: 'object',
                properties: {text: {type: 'string'}},
                required: ['text'],
            });

            const result = await client.callTool({name: 'test__echo', arguments: {text: '协议面'}});
            expect(result.isError).toBeFalsy();
            const blocks = result.content as Array<{type: string; text: string}>;
            expect(blocks[0].text).toBe('echo: 协议面');

            // 未知工具回喂 isError 结果（协议不报错，模型可自行纠正）
            const unknown = await client.callTool({name: 'nope', arguments: {}});
            expect(unknown.isError).toBe(true);
        } finally {
            await client.close().catch(() => {});
            registry.unregister('test__echo');
        }
    });
});
