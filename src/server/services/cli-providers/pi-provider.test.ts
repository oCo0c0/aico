/**
 * @module pi-provider.test
 * @description Pi RPC harness Provider 回归测试（假子进程注入，不依赖真实 pi）
 *
 * 覆盖层（每条对应一次线上问题面，防止回归）：
 * - run() 事件归一化：thinking/tool_use/tool_result/text → onOutput meta 契约
 * - 权限确认往返：extension_ui_request(confirm) → onPermissionRequest →
 *   confirmPermission → extension_ui_response 回写
 * - abort：signal 触发 abort 命令 + agent_end 收尾
 * - 模型错误透传：stopReason=error → exitCode 1（不允许无声成功）
 * - 会话降级：sessionId 无对应文件时提示并开新会话
 * - adw 平台扩展：权限门规则（bash/edit/write/平台工具确认，只读放行）+
 *   MCP 工具注册与执行（fetch 回连网关）
 */

import {describe, it, expect, vi} from 'vitest';
import {PiProvider, piSessionDir} from './pi-provider.js';
import type {PiRpcHooks, PiRpcSpawnOptions} from './pi-rpc-process.js';
import adwPlatformExtension from '../../../../resources/pi-extensions/adw-platform.js';

/** 假 RPC 进程：记录命令、可编程应答、可注入事件 */
class FakeRpc {
    opts: PiRpcSpawnOptions;
    hooks: PiRpcHooks;
    sent: Array<Record<string, unknown>> = [];
    killed = false;
    /** 按命令类型可编程的应答表 */
    responders = new Map<string, (cmd: Record<string, unknown>) => unknown>();

    constructor(opts: PiRpcSpawnOptions, hooks: PiRpcHooks) {
        this.opts = opts;
        this.hooks = hooks;
    }

    get alive(): boolean {
        return !this.killed;
    }

    pid = 9999;

    async send(cmd: Record<string, unknown>): Promise<unknown> {
        this.sent.push(cmd);
        const responder = this.responders.get(String(cmd.type));
        if (!responder) throw new Error(`FakeRpc: no responder for "${String(cmd.type)}"`);
        return responder(cmd);
    }

    notify(cmd: Record<string, unknown>): void {
        this.sent.push(cmd);
    }

    async kill(): Promise<void> {
        this.killed = true;
    }

    /** 向 Provider 推送一行事件 */
    emit(event: Record<string, unknown>): void {
        this.hooks.onEvent?.(event);
    }
}

/** 创建 provider 与「晚绑定」的假进程句柄（run 调用后才有实例） */
function makeProvider(): {
    provider: PiProvider;
    getRpc: () => FakeRpc | null;
    getOpts: () => PiRpcSpawnOptions | undefined;
} {
    let rpc: FakeRpc | null = null;
    let opts: PiRpcSpawnOptions | undefined;
    const fakeStart = (async (o: PiRpcSpawnOptions, hooks: PiRpcHooks) => {
        opts = o;
        rpc = new FakeRpc(o, hooks);
        // 默认应答：就绪握手 get_state + prompt 预检 ack
        rpc.responders.set('get_state', () => ({sessionId: 'newsess-1', isStreaming: false}));
        rpc.responders.set('prompt', () => undefined);
        return rpc as unknown as PiRpcProcess;
    }) as unknown as typeof PiRpcProcess.start;
    return {
        provider: new PiProvider(fakeStart),
        getRpc: () => rpc,
        getOpts: () => opts,
    };
}

/** 组装一次完整事件序列（正常完成路径） */
function emitRunEvents(rpc: FakeRpc, extra: Array<Record<string, unknown>> = []): void {
    rpc.emit({type: 'agent_start'});
    rpc.emit({type: 'message_update', assistantMessageEvent: {type: 'thinking_delta', delta: '想想'}});
    rpc.emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'Hello'}});
    rpc.emit({type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'read', args: {path: 'a.ts'}});
    rpc.emit({type: 'tool_execution_update', toolCallId: 'tc-1', partialResult: {text: '文件内容'}});
    rpc.emit({type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'read', isError: false});
    rpc.emit({type: 'message_end', message: {stopReason: 'endTurn'}});
    for (const evt of extra) rpc.emit(evt);
    rpc.emit({type: 'agent_end', messages: []});
}

describe('PiProvider（RPC harness）', () => {
    it('run() 归一化事件流并返回结果', async () => {
        const {provider, getRpc, getOpts} = makeProvider();
        const outputs: Array<{data: string; meta?: Record<string, unknown>}> = [];

        const resultPromise = provider.run(
            {prompt: '读一下 a.ts', cwd: 'D:/ws/project'},
            {
                onOutput: (data, meta) => outputs.push({data, meta}),
                modelProvider: 'deepseek',
                model: 'deepseek-chat',
            },
        );
        await vi.waitFor(() => {
            expect(getRpc()?.sent.some((c) => c.type === 'prompt')).toBe(true);
        });
        emitRunEvents(getRpc()!);
        const result = await resultPromise;

        expect(result.exitCode).toBe(0);
        expect(result.aborted).toBe(false);
        expect(result.sessionId).toBe('newsess-1');
        expect(result.stdout).toBe('Hello');

        // meta 契约：thinking / tool_use（含参数）/ tool_result（含输出）
        const metas = outputs.filter((o) => o.meta).map((o) => o.meta!.type);
        expect(metas).toContain('thinking');
        expect(metas).toContain('tool_use');
        expect(metas).toContain('tool_result');
        const toolUse = outputs.find((o) => o.meta?.type === 'tool_use');
        expect(toolUse?.meta?.toolName).toBe('read');
        expect(toolUse?.meta?.toolInput).toEqual({path: 'a.ts'});
        const toolResult = outputs.find((o) => o.meta?.type === 'tool_result');
        expect(toolResult?.data).toBe('文件内容');

        // 启动参数：模型注入；不再传 tools 启用白名单（--tools 会静默禁用
        // 扩展注册的平台 MCP 工具）
        expect(getOpts()?.provider).toBe('deepseek');
        expect(getOpts()?.model).toBe('deepseek-chat');
        expect(getOpts()?.tools).toBeUndefined();
    });

    it('权限确认往返：extension_ui_request → confirmPermission → extension_ui_response', async () => {
        const {provider, getRpc} = makeProvider();
        const permissionRequests: Array<Record<string, unknown>> = [];

        const resultPromise = provider.run(
            {prompt: '跑个命令', cwd: 'D:/ws/x'},
            {
                onOutput: () => undefined,
                onPermissionRequest: (meta) => {
                    permissionRequests.push(meta);
                    // 模拟用户点击「允许」
                    provider.confirmPermission(String(meta.permissionRequestId), 'allow');
                },
            },
        );
        await vi.waitFor(() => {
            expect(getRpc()?.sent.some((c) => c.type === 'prompt')).toBe(true);
        });
        // pi 扩展请求确认 bash
        getRpc()!.emit({type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'bash', message: '{"command":"dir"}'});
        emitRunEvents(getRpc()!);
        const result = await resultPromise;

        expect(result.exitCode).toBe(0);
        expect(permissionRequests).toHaveLength(1);
        expect(permissionRequests[0].toolName).toBe('bash');
        expect(permissionRequests[0].permissionRequestId).toBe('pi-u1');
        // 回写命令已发往子进程
        expect(getRpc()!.sent).toContainEqual({type: 'extension_ui_response', id: 'u1', confirmed: true});
    });

    it('abort：发送 abort 命令并正常收尾', async () => {
        const {provider, getRpc} = makeProvider();
        const controller = new AbortController();

        const resultPromise = provider.run(
            {prompt: '长任务', cwd: 'D:/ws/y'},
            {onOutput: () => undefined, signal: controller.signal},
        );
        await vi.waitFor(() => {
            expect(getRpc()?.sent.some((c) => c.type === 'prompt')).toBe(true);
        });
        controller.abort();
        getRpc()!.emit({type: 'agent_end', messages: []});
        const result = await resultPromise;

        expect(result.aborted).toBe(true);
        expect(result.exitCode).toBeNull();
        expect(getRpc()!.sent.some((c) => c.type === 'abort')).toBe(true);
    });

    it('模型错误（stopReason=error）→ exitCode 1 并透传 stderr', async () => {
        const {provider, getRpc} = makeProvider();
        const errors: string[] = [];

        const resultPromise = provider.run(
            {prompt: 'x', cwd: 'D:/ws/z'},
            {onOutput: () => undefined, onError: (e) => errors.push(e)},
        );
        await vi.waitFor(() => {
            expect(getRpc()?.sent.some((c) => c.type === 'prompt')).toBe(true);
        });
        getRpc()!.emit({type: 'message_end', message: {stopReason: 'error', errorMessage: '402 balance insufficient'}});
        getRpc()!.emit({type: 'agent_end', messages: []});
        const result = await resultPromise;

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('402');
        expect(errors).toHaveLength(1);
    });

    it('sessionId 无对应会话文件时降级开新会话并提示', async () => {
        const {provider, getRpc, getOpts} = makeProvider();
        const outputs: string[] = [];

        const resultPromise = provider.run(
            {prompt: 'x', cwd: 'D:/ws/none', sessionId: 'gone-session'},
            {onOutput: (d) => outputs.push(d)},
        );
        await vi.waitFor(() => {
            expect(getRpc()?.sent.some((c) => c.type === 'prompt')).toBe(true);
        });
        emitRunEvents(getRpc()!);
        const result = await resultPromise;

        expect(getOpts()?.sessionFile).toBeUndefined();
        expect(outputs.some((d) => d.includes('不存在或已失效'))).toBe(true);
        expect(result.sessionId).toBe('newsess-1');
    });
});

describe('adw 平台扩展（resources/pi-extensions/adw-platform.ts）', () => {
    type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
    let handlers: Record<string, Handler>;
    let registered: Array<Record<string, unknown>>;
    let confirms: Array<{title: string; message: string; timeout?: number}>;
    let confirmResult: boolean;
    let notifies: string[];

    function setup(permissionMode = 'confirm'): Promise<void> {
        handlers = {};
        registered = [];
        confirms = [];
        confirmResult = true;
        notifies = [];
        process.env.ADW_PERMISSION_MODE = permissionMode;
        const pi = {
            on: (event: string, handler: Handler) => {
                handlers[event] = handler;
            },
            registerTool: (tool: Record<string, unknown>) => registered.push(tool),
        };
        // factory 为 async（pi 官方语义：pi await factory 后才继续启动）；
        // 未设置 ADW_PLATFORM_URL 时立即返回（权限门仍同步注册）
        return adwPlatformExtension(pi as never) as Promise<void>;
    }

    const confirmCtx = () => ({
        hasUI: true,
        ui: {
            confirm: async (title: string, message: string, opts?: {timeout?: number}) => {
                confirms.push({title, message, timeout: opts?.timeout});
                return confirmResult;
            },
        },
    });

    it('副作用工具（bash/write）需确认；只读工具直接放行', async () => {
        setup();
        const allowed = await handlers['tool_call']({toolName: 'read', input: {path: 'x'}}, confirmCtx());
        expect(allowed).toBeUndefined();
        expect(confirms).toHaveLength(0);

        await handlers['tool_call']({toolName: 'bash', input: {command: 'ls'}}, confirmCtx());
        expect(confirms).toHaveLength(1);
        expect(confirms[0].title).toBe('bash');
        expect(confirms[0].message).toContain('ls');
        expect(confirms[0].timeout).toBe(90_000);

        await handlers['tool_call']({toolName: 'write', input: {path: 'y'}}, confirmCtx());
        expect(confirms).toHaveLength(2);
    });

    it('平台工具按读写区分：写类需确认（拒绝返回 block），读类直接放行', async () => {
        setup();
        // 写类：确认 + 拒绝时返回 block
        confirmResult = false;
        const blocked = await handlers['tool_call'](
            {toolName: 'ones__create_issue', input: {title: 't'}},
            confirmCtx(),
        );
        expect(blocked).toEqual({block: true, reason: '用户拒绝了该工具调用'});
        expect(confirms).toHaveLength(1);
        expect(confirms[0].title).toBe('ones__create_issue');

        // 读类（get/search/list 等命名前缀）：直接放行不弹窗（agent 拉取等纯查询场景）
        confirmResult = false; // 即使会拒绝也不该走到 confirm
        const readPass1 = await handlers['tool_call'](
            {toolName: 'ones-api__get_work_item', input: {id: '302'}},
            confirmCtx(),
        );
        expect(readPass1).toBeUndefined();
        const readPass2 = await handlers['tool_call'](
            {toolName: 'ones-api__search_requirements', input: {query: 'x'}},
            confirmCtx(),
        );
        expect(readPass2).toBeUndefined();
        expect(confirms).toHaveLength(1);

        // 无法判断语义的平台工具（非读前缀且未命中写词）：保守确认
        await handlers['tool_call']({toolName: 'ones-api__wiki_tree', input: {}}, confirmCtx());
        expect(confirms).toHaveLength(2);
    });

    it('ADW_PERMISSION_MODE=auto-allow 时全部放行（经典流程未接权限回调）', async () => {
        setup('auto-allow');
        const result = await handlers['tool_call'](
            {toolName: 'bash', input: {command: 'rm -rf /'}},
            confirmCtx(),
        );
        expect(result).toBeUndefined();
        expect(confirms).toHaveLength(0);
    });

    it('factory 顶层拉取工具目录并注册；execute 回连 /call', async () => {
        await setup();
        const calls: Array<{url: string}> = [];
        const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
            calls.push({url: String(url)});
            if (String(url).includes('/tools')) {
                return new Response(JSON.stringify([
                    {name: 'ones__search', label: 'ones.search', description: '搜索', inputSchema: {type: 'object', properties: {q: {type: 'string'}}, required: ['q']}},
                ]), {status: 200});
            }
            return new Response(JSON.stringify({text: '结果', isError: false}), {status: 200});
        });
        vi.stubGlobal('fetch', fetchMock);
        process.env.ADW_PLATFORM_URL = 'http://127.0.0.1:3000/api/platform';

        try {
            // 重新加载 factory（带 env），模拟 pi await factory 的启动路径
            await adwPlatformExtension({
                on: () => undefined,
                registerTool: (tool: Record<string, unknown>) => registered.push(tool),
            } as never);
            expect(registered).toHaveLength(1);
            expect(registered[0].name).toBe('ones__search');
            expect(registered[0].parameters).toEqual({type: 'object', properties: {q: {type: 'string'}}, required: ['q']});

            const execute = registered[0].execute as (
                id: string,
                params: Record<string, unknown>,
            ) => Promise<{content: Array<{type: string; text: string}>}>;
            const result = await execute('tc', {q: 'xx'});
            expect(result.content[0].text).toBe('结果');
            expect(calls.some((c) => c.url.endsWith('/call'))).toBe(true);
        } finally {
            delete process.env.ADW_PLATFORM_URL;
            delete process.env.ADW_PLATFORM_SERVERS;
            vi.unstubAllGlobals();
        }
    });

    it('ADW_PLATFORM_SERVERS 白名单：拉目录时附加 ?servers= query', async () => {
        await setup();
        const urls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
            urls.push(String(url));
            return new Response(JSON.stringify([{name: 'ones-api__get_work_item'}]), {status: 200});
        }));
        process.env.ADW_PLATFORM_URL = 'http://127.0.0.1:3000/api/platform';
        process.env.ADW_PLATFORM_SERVERS = 'ones-api,github';
        try {
            await adwPlatformExtension({
                on: () => undefined,
                registerTool: (tool: Record<string, unknown>) => registered.push(tool),
            } as never);
            expect(urls[0]).toBe('http://127.0.0.1:3000/api/platform/tools?servers=ones-api%2Cgithub');
            // 非空目录不触发重试
            expect(urls).toHaveLength(1);
            expect(registered).toHaveLength(1);
            expect(registered[0].name).toBe('ones-api__get_work_item');
        } finally {
            delete process.env.ADW_PLATFORM_URL;
            delete process.env.ADW_PLATFORM_SERVERS;
            delete process.env.ADW_CATALOG_RETRY_DELAY_MS;
            vi.unstubAllGlobals();
        }
    });

    it('空目录（上游冷启动）自动重试：退避后再拉到工具并注册', async () => {
        await setup();
        process.env.ADW_CATALOG_RETRY_DELAY_MS = '1';
        let calls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            calls++;
            // 前两次空目录（模拟网关软超时降级），第三次上游就绪
            const body = calls <= 2 ? '[]' : JSON.stringify([{name: 'ones-api__search_requirements'}]);
            return new Response(body, {status: 200});
        }));
        process.env.ADW_PLATFORM_URL = 'http://127.0.0.1:3000/api/platform';
        try {
            await adwPlatformExtension({
                on: () => undefined,
                registerTool: (tool: Record<string, unknown>) => registered.push(tool),
            } as never);
            expect(calls).toBe(3);
            expect(registered).toHaveLength(1);
            expect(registered[0].name).toBe('ones-api__search_requirements');
        } finally {
            delete process.env.ADW_PLATFORM_URL;
            delete process.env.ADW_CATALOG_RETRY_DELAY_MS;
            vi.unstubAllGlobals();
        }
    });

    it('重试后仍为空目录：不注册任何工具', async () => {
        await setup();
        process.env.ADW_CATALOG_RETRY_DELAY_MS = '1';
        let calls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            calls++;
            return new Response('[]', {status: 200});
        }));
        process.env.ADW_PLATFORM_URL = 'http://127.0.0.1:3000/api/platform';
        try {
            await adwPlatformExtension({
                on: () => undefined,
                registerTool: (tool: Record<string, unknown>) => registered.push(tool),
            } as never);
            expect(calls).toBe(4); // CATALOG_RETRY_COUNT 次后放弃
            expect(registered).toHaveLength(0);
        } finally {
            delete process.env.ADW_PLATFORM_URL;
            delete process.env.ADW_CATALOG_RETRY_DELAY_MS;
            vi.unstubAllGlobals();
        }
    });

    it('网关不可达时降级：不注册工具，不阻塞启动', async () => {
        await setup();
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        }));
        process.env.ADW_PLATFORM_URL = 'http://127.0.0.1:9/api/platform';
        try {
            await adwPlatformExtension({
                on: () => undefined,
                registerTool: (tool: Record<string, unknown>) => registered.push(tool),
            } as never);
            expect(registered).toHaveLength(0);
        } finally {
            delete process.env.ADW_PLATFORM_URL;
            delete process.env.ADW_PLATFORM_SERVERS;
            vi.unstubAllGlobals();
        }
    });

    it('未配置 ADW_PLATFORM_URL 时跳过注册（无网关环境）', async () => {
        delete process.env.ADW_PLATFORM_URL;
        await adwPlatformExtension({
            on: () => undefined,
            registerTool: (tool: Record<string, unknown>) => registered.push(tool),
        } as never);
        expect(registered).toHaveLength(0);
    });
});

describe('piSessionDir', () => {
    it('不同 cwd 产生不同目录', () => {
        const a = piSessionDir('D:/idea_workspace/pif_xxl_job');
        const b = piSessionDir('D:/py_workspace/aico');
        expect(a).not.toBe(b);
        expect(a.length).toBeGreaterThan(0);
    });
});

/**
 * 看门狗「无活动」语义（用户报告：健康长任务恰在 30 分钟整被杀）。
 * 旧实现是启动时设定一次的绝对定时器；新实现任何事件都重置，
 * 只有事件流彻底沉寂（疑似卡死）才中止。
 */
describe('PiProvider 看门狗（无活动语义）', () => {
    const MIN = 60 * 1000;

    it('整轮看门狗：30 分钟无任何事件（疑似卡死）→ 发 abort 并收尾', async () => {
        vi.useFakeTimers();
        try {
            const {provider, getRpc} = makeProvider();
            const outputs: string[] = [];
            const resultPromise = provider.run(
                {prompt: 'p', cwd: 'D:/ws/project'},
                {onOutput: (data) => outputs.push(data), modelProvider: 'deepseek', model: 'm'},
            );
            await vi.advanceTimersByTimeAsync(1); // 让 startRpc / prompt 预检落定
            expect(getRpc()?.sent.some((c) => c.type === 'prompt')).toBe(true);

            await vi.advanceTimersByTimeAsync(30 * MIN);

            const result = await resultPromise;
            expect(getRpc()?.sent.some((c) => c.type === 'abort')).toBe(true);
            expect(outputs.join('')).toContain('疑似卡死');
            expect(result.exitCode).toBe(0); // 看门狗路径：非用户中止、非模型错误
        } finally {
            vi.useRealTimers();
        }
    });

    it('整轮看门狗重置：事件心跳让 60 分钟的长任务一直存活', async () => {
        vi.useFakeTimers();
        try {
            const {provider, getRpc} = makeProvider();
            const resultPromise = provider.run(
                {prompt: 'p', cwd: 'D:/ws/project'},
                {modelProvider: 'deepseek', model: 'm'},
            );
            await vi.advanceTimersByTimeAsync(1);
            const rpc = getRpc()!;

            // 每 10 分钟一次心跳（< 30 分钟阈值），共 60 分钟 > 旧绝对阈值
            for (let i = 0; i < 6; i++) {
                await vi.advanceTimersByTimeAsync(10 * MIN);
                rpc.emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: `t${i}`}});
                expect(rpc.sent.some((c) => c.type === 'abort')).toBe(false);
            }

            rpc.emit({type: 'agent_end', messages: []});
            const result = await resultPromise;
            expect(result.exitCode).toBe(0);
            expect(rpc.sent.some((c) => c.type === 'abort')).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('工具看门狗：部分输出会重置；10 分钟零输出才判定疑似挂死', async () => {
        vi.useFakeTimers();
        try {
            const {provider, getRpc} = makeProvider();
            const resultPromise = provider.run(
                {prompt: 'p', cwd: 'D:/ws/project'},
                {modelProvider: 'deepseek', model: 'm'},
            );
            await vi.advanceTimersByTimeAsync(1);
            const rpc = getRpc()!;

            rpc.emit({type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: {cmd: 'build'}});
            await vi.advanceTimersByTimeAsync(9 * MIN);
            expect(rpc.sent.some((c) => c.type === 'abort')).toBe(false);

            // 部分输出到达 → 工具看门狗重置
            rpc.emit({type: 'tool_execution_update', toolCallId: 'tc-1', partialResult: {text: '...compiling'}});
            await vi.advanceTimersByTimeAsync(9 * MIN);
            expect(rpc.sent.some((c) => c.type === 'abort')).toBe(false);

            // 重置后再沉寂满 10 分钟 → 中止
            await vi.advanceTimersByTimeAsync(MIN + 1);
            expect(rpc.sent.some((c) => c.type === 'abort')).toBe(true);

            rpc.emit({type: 'agent_end', messages: []});
            await resultPromise;
        } finally {
            vi.useRealTimers();
        }
    });
});
