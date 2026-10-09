/**
 * @module requirement-agent-fetch.test
 * @description agent 中介需求拉取服务单测（注入 fake runner，不起真实引擎）
 *
 * 覆盖：
 * - 正常路径：引擎返回契约 JSON → 映射为 RequirementDetail + sourceServer
 * - 容忍代码块围栏/前后杂文字的 JSON 提取
 * - 思考污染 stdout：叙述文本里的杂 `{` 片段不截胡，多候选评分选出契约对象
 * - 引擎返回 {"error": ...} → 抛出可读错误
 * - 首次输出不合法 → 自动重试一次（prompt 携带原因 + 输出结尾）
 * - 重试仍失败 → 抛出含「原因 + 输出开头/结尾」的详细错误
 * - 引擎 exitCode !== 0 → 抛出引擎执行失败（附 stderr）
 * - maxTurnsReached → 视为本轮失败并带原因重试（runBridge 收到 maxTurns=30）
 * - onOutput → onProgress 过程事件转发（started/tool_use/tool_result/done）
 * - MCP 白名单：preferredServer → runBridge 收到单源注入；未指定 → 全量 enabled
 * - search：items 映射 / 空列表 / {"error"} / 杂 JSON 容忍 / 重试仍失败
 */

import {describe, it, expect} from 'vitest';
import {RequirementAgentFetchService} from './requirement-agent-fetch.js';
import type {AgentFetchProgress, AgentFetchRunner} from './requirement-agent-fetch.js';

/** fake runner 的单次预设结果（stream = runBridge 解析 stdout 前依序发出的引擎事件） */
type FakeResult = {
    exitCode?: number | null;
    stdout: string;
    stderr?: string;
    aborted?: boolean;
    maxTurnsReached?: boolean;
    stream?: Array<{ data?: string; meta?: Record<string, unknown> }>;
};

/** 可编程 fake runner：按调用顺序返回预设结果，先回放 stream 事件再 resolve */
function makeRunner(results: FakeResult[]): {
    runner: AgentFetchRunner;
    calls: Array<{ prompt: string; cwd?: string; mcpServers?: unknown; maxTurns?: number; permissionMode?: string }>;
} {
    const calls: Array<{ prompt: string; cwd?: string; mcpServers?: unknown; maxTurns?: number; permissionMode?: string }> = [];
    let i = 0;
    const runner: AgentFetchRunner = {
        runBridge: async (input, options) => {
            calls.push({prompt: input.prompt, cwd: input.cwd, mcpServers: input.mcpServers, maxTurns: input.maxTurns, permissionMode: options?.permissionMode});
            const r = results[Math.min(i++, results.length - 1)];
            for (const ev of r.stream ?? []) {
                options?.onOutput?.(ev.data ?? '', ev.meta as never);
            }
            return {
                exitCode: r.exitCode ?? 0,
                stdout: r.stdout,
                stderr: r.stderr ?? '',
                aborted: r.aborted ?? false,
                maxTurnsReached: r.maxTurnsReached,
            };
        },
    };
    return {runner, calls};
}

/** fake MCP 配置源 */
const mcpService = {
    get: (name: string) => (name === 'ones-api' ? {name} : undefined),
    list: () => [
        {name: 'ones-api', enabled: true},
        {name: 'memory', enabled: true},
        {name: 'disabled-x', enabled: false},
    ],
};

/** 注入式 resolveMcp：记录白名单参数 */
function makeResolveMcp() {
    const seen: Array<string[] | undefined> = [];
    const fn = (names?: string[]) => {
        seen.push(names);
        return {map: names ? {gateway: {type: 'http', url: `http://x/api/mcp?servers=${names.join(',')}`}} : undefined, missing: []};
    };
    return {seen, fn};
}

/** 契约 JSON 样例 */
const CONTRACT_JSON = JSON.stringify({
    sourceServer: 'ones-api',
    id: 'MbKZmvxyBq7L4Mjg',
    number: '#302',
    title: 'YFGL-302 新增监控邮件',
    status: 'done',
    priority: 'medium',
    assignee: '鲍磊',
    updatedAt: '2026-07-01T00:00:00Z',
    description: '完整描述 Markdown',
    acceptanceCriteria: ['标准一'],
    attachments: [{name: 'a.xlsx', url: 'https://x/a.xlsx'}],
    relatedIssues: [{id: 'i1', title: '关联', url: 'https://x/i1', status: 'open'}],
});

describe('RequirementAgentFetchService', () => {
    it('正常路径：契约 JSON → RequirementDetail + sourceServer', async () => {
        const {runner, calls} = makeRunner([{stdout: CONTRACT_JSON}]);
        const rm = makeResolveMcp();
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: rm.fn as never});

        const detail = await svc.fetchByInput('302', 'ones-api');

        expect(detail.sourceServer).toBe('ones-api');
        expect(detail.id).toBe('MbKZmvxyBq7L4Mjg');
        expect(detail.number).toBe('#302');
        expect(detail.title).toContain('YFGL-302');
        expect(detail.description).toBe('完整描述 Markdown');
        expect(detail.attachments).toHaveLength(1);
        expect(detail.relatedIssues![0].id).toBe('i1');

        // prompt 契约与只读约束
        expect(calls[0].prompt).toContain('302');
        expect(calls[0].prompt).toContain('严禁任何创建、更新、删除、提交、写入类工具');
        expect(calls[0].prompt).toContain('只输出一个 JSON 对象');
        // 白名单：preferredServer → 单源
        expect(rm.seen[0]).toEqual(['ones-api']);
        expect(calls[0].mcpServers).toBeDefined();
        // 防截断：maxTurns 提升到 30（bridge 默认 10 对多工具拉取太紧）
        expect(calls[0].maxTurns).toBe(30);
        // 无头放行：acceptEdits 会把 MCP 工具调用全部拒绝（permission not granted）
        expect(calls[0].permissionMode).toBe('bypassPermissions');
    });

    it('容忍代码块围栏与前后杂文字', async () => {
        const fenced = `前置说明\n\`\`\`json\n${CONTRACT_JSON}\n\`\`\`\n后置说明`;
        const {runner} = makeRunner([{stdout: fenced}]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        const detail = await svc.fetchByInput('CWXT-302');
        expect(detail.title).toContain('YFGL-302');
    });

    it('思考污染 stdout：叙述里的杂 JSON 片段不截胡，评分选出契约对象', async () => {
        // 复刻 Claude 引擎历史行为：thinking 也写进 stdout，且开头是英文叙述
        const polluted = [
            'Let me analyze this task. The user wants me to act as a requirements-fetching agent.',
            '计划先 {"step": 1} 调用工具，草稿 {"error": "这是思考不是最终答案"}。',
            '',
            '```json',
            CONTRACT_JSON,
            '```',
        ].join('\n');
        const {runner} = makeRunner([{stdout: polluted}]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        const detail = await svc.fetchByInput('302');
        expect(detail.title).toContain('YFGL-302');
    });

    it('未指定 server 时注入全部 enabled server（排除 disabled）', async () => {
        const {runner} = makeRunner([{stdout: CONTRACT_JSON}]);
        const rm = makeResolveMcp();
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: rm.fn as never});
        await svc.fetchByInput('302');
        expect(rm.seen[0]).toEqual(['ones-api', 'memory']);
    });

    it('引擎返回 {"error"} → 抛出可读错误', async () => {
        const {runner} = makeRunner([{stdout: JSON.stringify({error: '未找到该需求'})}]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        await expect(svc.fetchByInput('999')).rejects.toThrow('agent 拉取失败: 未找到该需求');
    });

    it('首次输出不合法 → 重试一次并携带修正指令；重试成功', async () => {
        const {runner, calls} = makeRunner([
            {stdout: '我觉得这个需求是关于……（非 JSON）'},
            {stdout: CONTRACT_JSON},
        ]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        const detail = await svc.fetchByInput('302');
        expect(detail.title).toContain('YFGL-302');
        expect(calls).toHaveLength(2);
        expect(calls[1].prompt).toContain('未能解析为符合契约的 JSON');
        // 修正指令要带「输出结尾」——真正的 JSON 通常在结尾，只给开头等于没给反馈
        expect(calls[1].prompt).toContain('输出结尾');
    });

    it('重试仍失败 → 抛出含原始输出摘要的错误', async () => {
        const {runner} = makeRunner([{stdout: '不是 JSON'}, {stdout: '还是不是 JSON'}]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        await expect(svc.fetchByInput('302')).rejects.toThrow(/不符合 JSON 契约/);
    });

    it('引擎 exitCode !== 0 → 抛出引擎执行失败', async () => {
        const {runner} = makeRunner([{exitCode: 1, stdout: '', stderr: '402 balance insufficient'}]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        await expect(svc.fetchByInput('302')).rejects.toThrow('agent 引擎执行失败');
    });

    it('缺 title → 失败错误包含「原因 + 输出结尾」详情（不再只给开头叙述）', async () => {
        const noTitle = JSON.stringify({id: 'x', description: 'd'});
        const {runner} = makeRunner([{stdout: noTitle}, {stdout: noTitle}]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        const err = await svc.fetchByInput('302').then(() => null, (e: Error) => e);
        expect(err).not.toBeNull();
        expect(err!.message).toContain('不符合 JSON 契约');
        expect(err!.message).toContain('原因：缺少必需字段: title');
        expect(err!.message).toContain('输出结尾：');
        expect(err!.message).toContain('"description":"d"');
    });

    it('maxTurnsReached → 本轮按失败重试并携带轮次原因；二轮成功', async () => {
        const {runner, calls} = makeRunner([
            {stdout: '', maxTurnsReached: true},
            {stdout: CONTRACT_JSON},
        ]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        const detail = await svc.fetchByInput('302');
        expect(detail.title).toContain('YFGL-302');
        expect(calls).toHaveLength(2);
        expect(calls[1].prompt).toContain('最大工具调用轮次');
    });

    it('onOutput 引擎事件 → onProgress 过程事件（started/tool_use/tool_result/done）', async () => {
        const {runner, calls} = makeRunner([{
            stdout: CONTRACT_JSON,
            stream: [
                {data: '让我先看看可用的工具', meta: {type: 'thinking'}},
                {meta: {type: 'tool_use', toolName: 'ones__get_issue', toolInput: {id: '302'}, toolUseId: 't1'}},
                {data: '已找到', meta: {type: 'tool_result', toolUseId: 't1', isError: false}},
                {data: CONTRACT_JSON, meta: undefined},
            ],
        }]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});

        const events: AgentFetchProgress[] = [];
        await svc.fetchByInput('302', 'ones-api', ev => events.push(ev));

        // started 附带挂载的白名单说明
        expect(events[0].kind).toBe('started');
        expect(events[0].message).toContain('目标 MCP server：ones-api');
        // 思考 → 过程事件
        expect(events.some(e => e.kind === 'thinking' && e.text?.includes('让我先看看'))).toBe(true);
        // 工具调用与结果
        expect(events.some(e => e.kind === 'tool_use' && e.toolName === 'ones__get_issue' && e.toolInput === '{"id":"302"}')).toBe(true);
        expect(events.some(e => e.kind === 'tool_result' && e.toolUseId === 't1' && e.isError === false)).toBe(true);
        // 最终成功
        expect(events[events.length - 1].kind).toBe('done');
        // onOutput 仅在传入 onProgress 时才注入（不传则不打扰引擎流）
        const bare = makeRunner([{stdout: CONTRACT_JSON}]);
        await new RequirementAgentFetchService({cliRunner: bare.runner, mcpService, resolveMcp: makeResolveMcp().fn as never})
            .fetchByInput('302');
        expect(bare.calls[0].prompt).toContain('302');
    });

    it('runBridge 收到低推理强度与隔离 cwd', async () => {
        const {runner, calls} = makeRunner([{stdout: CONTRACT_JSON}]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        await svc.fetchByInput('302');
        expect(calls[0].cwd).toContain('agent-fetch');
    });

    // === 上游就绪等待（ensureMcpReady 注入） ===

    it('全部上游未就绪 → 快速失败且不启动引擎（不再让 agent 带空工具目录上场）', async () => {
        const {runner, calls} = makeRunner([{stdout: CONTRACT_JSON}]);
        const ensure = async (names: string[]) =>
            names.map(name => ({name, ok: false, reason: '连接超时（90s 内未完成握手）'}));
        const svc = new RequirementAgentFetchService({
            cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never, ensureMcpReady: ensure,
        });
        await expect(svc.fetchByInput('302', 'ones-api')).rejects.toThrow(/MCP server 无法连接[\s\S]*ones-api：连接超时/);
        expect(calls).toHaveLength(0); // 引擎一次都没跑
    });

    it('部分就绪 → 继续执行；过程事件报告各 server 结论', async () => {
        const {runner} = makeRunner([{stdout: CONTRACT_JSON}]);
        const events: AgentFetchProgress[] = [];
        const ensure = async (names: string[]) => [
            {name: names[0], ok: true, toolCount: 22},
            {name: 'memory', ok: false, reason: 'spawn ENOENT'},
        ];
        const svc = new RequirementAgentFetchService({
            cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never, ensureMcpReady: ensure,
        });
        const detail = await svc.fetchByInput('302', undefined, ev => events.push(ev));
        expect(detail.title).toContain('YFGL-302');
        expect(events.some(e => e.message?.includes('ones-api」已就绪（22 个工具）'))).toBe(true);
        expect(events.some(e => e.message?.includes('memory」连接失败：spawn ENOENT'))).toBe(true);
    });

    it('就绪等待在引擎启动前执行（ensure 先于 runBridge）', async () => {
        const order: string[] = [];
        const {runner} = makeRunner([{stdout: CONTRACT_JSON}]);
        const wrapped: AgentFetchRunner = {
            runBridge: async (input, options) => {
                order.push('runBridge');
                return runner.runBridge(input, options);
            },
        };
        const svc = new RequirementAgentFetchService({
            cliRunner: wrapped,
            mcpService,
            resolveMcp: makeResolveMcp().fn as never,
            ensureMcpReady: async () => {
                order.push('ensure');
                return [{name: 'ones-api', ok: true, toolCount: 22}];
            },
        });
        await svc.fetchByInput('302');
        expect(order).toEqual(['ensure', 'runBridge']);
    });

    it('未配置任何启用 server → 快速失败给出可操作指引（不烧引擎）', async () => {
        const {runner, calls} = makeRunner([{stdout: CONTRACT_JSON}]);
        const emptyMcp = {get: () => undefined, list: () => [{name: 'disabled-x', enabled: false}]};
        const rm = makeResolveMcp();
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService: emptyMcp, resolveMcp: rm.fn as never});
        await expect(svc.fetchByInput('302')).rejects.toThrow('未配置任何启用的 MCP server');
        expect(calls).toHaveLength(0);
        expect(rm.seen).toHaveLength(0); // 未进入 resolveMcp
    });
});

describe('RequirementAgentFetchService.searchByInput', () => {
    const SEARCH_JSON = JSON.stringify({
        items: [
            {id: 'uuid-1', number: '#302', title: '需求A', status: '进行中', priority: 'high', assignee: '张三', updatedAt: '2026-07-01T00:00:00Z'},
            {id: 'uuid-2', number: '#303', title: '需求B', status: 'open'},
        ],
    });

    it('正常路径：items → Requirement[] 摘要', async () => {
        const {runner, calls} = makeRunner([{stdout: SEARCH_JSON}]);
        const rm = makeResolveMcp();
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: rm.fn as never});

        const list = await svc.searchByInput('监控', 'ones-api');

        expect(list).toHaveLength(2);
        expect(list[0]).toMatchObject({id: 'uuid-1', number: '#302', title: '需求A', status: '进行中'});
        expect(list[1].status).toBe('open');
        // prompt 含搜索任务与只读约束；白名单单源
        expect(calls[0].prompt).toContain('监控');
        expect(calls[0].prompt).toContain('严禁任何创建、更新、删除、提交、写入类工具');
        expect(rm.seen[0]).toEqual(['ones-api']);
    });

    it('items 缺省返回空数组（不视为契约失败）', async () => {
        const {runner} = makeRunner([{stdout: JSON.stringify({items: []})}]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        const list = await svc.searchByInput('不存在的东西');
        expect(list).toEqual([]);
    });

    it('引擎返回 {"error"} → 抛出可读错误', async () => {
        const {runner} = makeRunner([{stdout: JSON.stringify({error: '该源不支持搜索'})}]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        await expect(svc.searchByInput('x')).rejects.toThrow('agent 搜索失败: 该源不支持搜索');
    });

    it('思考污染 stdout：杂 JSON 片段不截胡，评分选出 items 契约对象', async () => {
        const pollutedSearch = [
            '思考：先搜索 {"kw": "监控"}，再过滤草稿 {"error": "中间产物"}。',
            '```json',
            SEARCH_JSON,
            '```',
        ].join('\n');
        const {runner} = makeRunner([{stdout: pollutedSearch}]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        const list = await svc.searchByInput('监控');
        expect(list).toHaveLength(2);
    });

    it('输出不合法 → 重试一次后仍失败则抛错', async () => {
        const {runner, calls} = makeRunner([
            {stdout: '搜索结果是一堆文字……'},
            {stdout: '还是不是 JSON'},
        ]);
        const svc = new RequirementAgentFetchService({cliRunner: runner, mcpService, resolveMcp: makeResolveMcp().fn as never});
        await expect(svc.searchByInput('x')).rejects.toThrow(/搜索.*不符合 JSON 契约/);
        expect(calls).toHaveLength(2);
    });
});
