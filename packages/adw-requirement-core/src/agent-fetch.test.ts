/**
 * @module agent-fetch.test
 * @description agent 中介需求拉取/搜索单元测试（fake AgentLlm + fake 桥，不连真实 MCP/模型）
 */

import {describe, it, expect} from 'vitest';
import {
    AgentFetchService,
    type AgentChat,
    type AgentContentBlock,
    type AgentLlm,
    type AgentToolDef,
    type AgentTurnResult,
} from './agent-fetch.js';
import type {MCPBridgeService, ServerToolInfo} from './mcp-bridge.js';

/** fake 桥：可编程的工具清单与调用结果 */
function fakeBridge(overrides?: Partial<Record<'listEnabledServers' | 'listServerTools' | 'callServerTool', unknown>>) {
    const toolCalls: Array<{server: string; tool: string; args: Record<string, unknown>}> = [];
    const listedServers: string[] = [];
    const bridge = {
        listEnabledServers: () => [
            {name: 'ones-api', type: 'custom', command: 'x', args: [], env: {}, enabled: true},
            {name: 'github', type: 'custom', command: 'y', args: [], env: {}, enabled: true},
        ],
        listServerTools: async (server: string): Promise<ServerToolInfo[]> => {
            listedServers.push(server);
            if (server === 'ones-api') {
                return [
                    {name: 'get_work_item', description: '拉详情', inputSchema: {type: 'object', properties: {id: {type: 'string'}}}},
                    {name: 'search_requirements', description: '搜索'},
                ];
            }
            return [{name: 'get_issue', description: 'issue'}];
        },
        callServerTool: async (server: string, tool: string, args: Record<string, unknown>) => {
            toolCalls.push({server, tool, args});
            return {text: `result of ${server}.${tool}`, isError: false};
        },
        getAttachmentImageService: () => undefined,
        getServerConfig: () => undefined,
        ...overrides,
    };
    return {bridge: bridge as unknown as MCPBridgeService, toolCalls, listedServers};
}

/** fake 会话：按脚本顺序吐轮次结果，记录全部输入 */
class ScriptedChat implements AgentChat {
    readonly sent: AgentContentBlock[][] = [];
    constructor(private script: AgentTurnResult[], readonly mountedTools: AgentToolDef[]) {}
    async send(content: AgentContentBlock[]): Promise<AgentTurnResult> {
        this.sent.push(content);
        const turn = this.script.shift();
        if (!turn) throw new Error('script exhausted');
        return turn;
    }
}

/** fake AgentLlm：每次 createChat 消费一段脚本 */
function fakeLlm(sessions: AgentTurnResult[][]): {llm: AgentLlm; chats: ScriptedChat[]} {
    const chats: ScriptedChat[] = [];
    const llm: AgentLlm = {
        createChat(opts) {
            const script = sessions.shift() ?? [];
            const chat = new ScriptedChat(script, opts.tools);
            chats.push(chat);
            return chat;
        },
    };
    return {llm, chats};
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): AgentContentBlock => ({
    type: 'tool-call', id, name, arguments: JSON.stringify(args),
});
const textTurn = (text: string): AgentTurnResult => ({blocks: [{type: 'text', text}], stopKind: 'stop'});
const toolTurn = (...calls: AgentContentBlock[]): AgentTurnResult => ({blocks: calls, stopKind: 'tool-calls'});

describe('AgentFetchService.fetchByInput', () => {
    it('完整链路：挂载 <server>__ 工具 → agent 调用 → 剥前缀路由 → JSON 契约映射', async () => {
        const {bridge, toolCalls, listedServers} = fakeBridge();
        const {llm, chats} = fakeLlm([[
            toolTurn(toolCall('c1', 'ones-api__get_work_item', {id: 'CWXT-129290'})),
            textTurn(JSON.stringify({
                sourceServer: 'ones-api', id: 'KPHW', number: 'CWXT-129290', title: '需求 A',
                status: '开发已分派', priority: 'high', assignee: '张三',
                updatedAt: '2026-07-23T00:00:00Z', description: '## 正文',
                acceptanceCriteria: ['标准1'], attachments: [{name: 'a.png', url: 'https://x/a.png'}],
                relatedIssues: [{id: 'CWXT-1', title: '关联', status: '进行中'}],
            })),
        ]]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});

        const detail = await service.fetchByInput('CWXT-129290');
        expect(detail.id).toBe('KPHW');
        expect(detail.number).toBe('CWXT-129290');
        expect(detail.title).toBe('需求 A');
        expect(detail.sourceServer).toBe('ones-api');
        expect(detail.attachments).toEqual([{name: 'a.png', url: 'https://x/a.png', type: 'file'}]);

        // 工具面：两个启用 server 全挂载，带前缀
        expect(listedServers).toEqual(['ones-api', 'github']);
        const names = chats[0].mountedTools.map(t => t.name);
        expect(names).toContain('ones-api__get_work_item');
        expect(names).toContain('github__get_issue');

        // 调用剥前缀路由回原 server
        expect(toolCalls).toEqual([{server: 'ones-api', tool: 'get_work_item', args: {id: 'CWXT-129290'}}]);

        // 第二轮回喂工具结果（toolCallId 对应）
        const second = chats[0].sent[1];
        expect(second).toEqual([{type: 'tool-result', toolCallId: 'c1', content: [{type: 'text', text: 'result of ones-api.get_work_item'}], isError: false}]);
    });

    it('显式 serverName 白名单：只挂载该 server', async () => {
        const {bridge, listedServers} = fakeBridge();
        const {llm, chats} = fakeLlm([[textTurn(JSON.stringify({sourceServer: 'ones-api', id: '1', title: 't'}))]]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});

        await service.fetchByInput('129290', {serverName: 'ones-api'});
        expect(listedServers).toEqual(['ones-api']);
        expect(chats[0].mountedTools.every(t => t.name.startsWith('ones-api__'))).toBe(true);
    });

    it('error 契约：抛出 agent 拉取失败 + 原因', async () => {
        const {bridge} = fakeBridge();
        const {llm} = fakeLlm([[textTurn(JSON.stringify({error: '找不到该需求'}))]]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});
        await expect(service.fetchByInput('X-1')).rejects.toThrow('agent 拉取失败: 找不到该需求');
    });

    it('解析失败自动纠正重试一次', async () => {
        const {bridge} = fakeBridge();
        const {llm, chats} = fakeLlm([
            [textTurn('我认为无法完成这个任务。')], // 第一段会话：非 JSON
            [textTurn(JSON.stringify({sourceServer: 'ones-api', id: '9', number: '#9', title: '重试成功'}))],
        ]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});

        const detail = await service.fetchByInput('#9');
        expect(detail.id).toBe('9');
        expect(chats).toHaveLength(2);
        // 第二段会话带纠错指令
        expect(JSON.stringify(chats[1].sent[0])).toContain('必须只是一个 JSON 对象');
    });

    it('思考草稿污染：杂 JSON 片段不截胡，评分选出契约对象', async () => {
        const {bridge} = fakeBridge();
        const polluted = [
            '让我分析一下这个任务。计划 {"step": 1} 先调用工具。',
            '草稿 {"error": "这是思考不是最终答案"}。',
            '',
            '```json',
            JSON.stringify({sourceServer: 'ones-api', id: 'K2', number: '#2', title: '污染测试'}),
            '```',
        ].join('\n');
        const {llm} = fakeLlm([[textTurn(polluted)]]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});

        const detail = await service.fetchByInput('#2');
        expect(detail.id).toBe('K2');
        expect(detail.title).toBe('污染测试');
    });

    it('工具执行异常：isError 结果回喂，agent 换路自愈', async () => {
        const {bridge, toolCalls} = fakeBridge({
            callServerTool: async (server: string, tool: string) => {
                if (tool === 'get_work_item') throw new Error('connection reset');
                toolCalls.push({server, tool, args: {}});
                return {text: 'ok', isError: false};
            },
        });
        const {llm, chats} = fakeLlm([[
            toolTurn(toolCall('c1', 'ones-api__get_work_item', {id: 'x'})),
            toolTurn(toolCall('c2', 'ones-api__search_requirements', {q: 'x'})),
            textTurn(JSON.stringify({sourceServer: 'ones-api', id: '1', title: '自愈成功'})),
        ]]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});

        const detail = await service.fetchByInput('x');
        expect(detail.title).toBe('自愈成功');
        const fed = chats[0].sent[1][0];
        expect(fed).toMatchObject({type: 'tool-result', toolCallId: 'c1', isError: true});
        expect(JSON.stringify(fed)).toContain('connection reset');
    });

    it('模型失败（error finish）：抛出失败信息', async () => {
        const {bridge} = fakeBridge();
        const {llm} = fakeLlm([[{blocks: [], stopKind: 'error', error: 'RATE_LIMIT'}]]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});
        await expect(service.fetchByInput('x')).rejects.toThrow('模型调用失败：RATE_LIMIT');
    });

    it('缺 AgentLlm：明确报错', async () => {
        const {bridge} = fakeBridge();
        const service = new AgentFetchService({bridge, agentLlm: () => undefined});
        await expect(service.fetchByInput('x')).rejects.toThrow('agent LLM 运行时不可用');
    });

    it('未配置任何 MCP server：明确报错', async () => {
        const {bridge} = fakeBridge({listEnabledServers: () => []});
        const {llm} = fakeLlm([]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});
        await expect(service.fetchByInput('x')).rejects.toThrow('未配置任何 MCP server');
    });

    it('全部 server 工具枚举失败：报未挂载到任何 MCP 工具', async () => {
        const {bridge} = fakeBridge({listServerTools: async () => {throw new Error('connect fail');}});
        const {llm} = fakeLlm([]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});
        await expect(service.fetchByInput('x')).rejects.toThrow('未挂载到任何 MCP 工具');
    });
});

describe('AgentFetchService.searchByInput', () => {
    it('数组契约映射为需求摘要列表', async () => {
        const {bridge} = fakeBridge();
        const {llm} = fakeLlm([[
            toolTurn(toolCall('c1', 'ones-api__search_requirements', {q: '关键词'})),
            textTurn(JSON.stringify([
                {id: 'A1', number: 'CWXT-1', title: '结果一', status: '进行中', updatedAt: '2026-07-23T00:00:00Z'},
                {id: 'A2', title: '结果二'},
            ])),
        ]]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});

        const results = await service.searchByInput('关键词');
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({id: 'A1', number: 'CWXT-1', title: '结果一', status: '进行中'});
        expect(results[1]).toMatchObject({id: 'A2', title: '结果二', status: 'unknown', priority: 'medium'});
    });

    it('error 对象契约：抛出 agent 搜索失败', async () => {
        const {bridge} = fakeBridge();
        const {llm} = fakeLlm([[textTurn(JSON.stringify({error: '该源不支持搜索'}))]]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});
        await expect(service.searchByInput('x')).rejects.toThrow('agent 搜索失败: 该源不支持搜索');
    });

    it('items 对象契约：{items:[...]} 也能映射，思考草稿里的 error 不截胡', async () => {
        const {bridge} = fakeBridge();
        const polluted = [
            '先 {"kw": "关键词"} 搜索，草稿 {"error": "中间产物"}。',
            '```json',
            JSON.stringify({items: [{id: 'B1', title: '结果一'}]}),
            '```',
        ].join('\n');
        const {llm} = fakeLlm([[textTurn(polluted)]]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});

        const results = await service.searchByInput('关键词');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({id: 'B1', title: '结果一'});
    });

    it('非 JSON 输出：抛出解析错误', async () => {
        const {bridge} = fakeBridge();
        const {llm} = fakeLlm([[textTurn('没有找到相关内容')]]);
        const service = new AgentFetchService({bridge, agentLlm: () => llm});
        await expect(service.searchByInput('x')).rejects.toThrow('无法解析为 JSON 数组契约');
    });
});
