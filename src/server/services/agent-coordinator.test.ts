/**
 * @module agent-coordinator.test
 * @description 「最终答复显性化」行为测试：appendFinalAssistantLog 从输出追踪中
 *   提取最后一段叙述（正文/思考中更晚者）写成 {type:'assistant'} 行。
 *
 * 背景：模型的汇总可能走正文通道也可能走 thinking 通道，刷新后两者都不再以
 * 显式姿态出现在消息流里（用户报「输出标签内容像被截断/丢失」）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';

// broadcast 依赖真实 WebSocket 服务，测试中 mock 掉
vi.mock('../websocket.js', () => ({
    broadcast: vi.fn(),
    broadcastToWorkspace: vi.fn(),
}));

import {AgentCoordinator} from './agent-coordinator';

/** 构造被测 coordinator + fake store（记录 addLog 调用；其余方法 noop 防噪音） */
function makeCoordinator() {
    const coord = new AgentCoordinator({} as never);
    const added: Array<{ id: string; line: string }> = [];
    (coord as unknown as { store: unknown }).store = {
        addLog: async (id: string, line: string) => {
            added.push({id, line});
        },
        addThought: async () => undefined,
        get: async () => null,
        updateFull: async () => undefined,
        addStepLog: async () => undefined,
        list: async () => [],
    };
    return {coord, added};
}

/** 驱动私有 makeOutputHandler 喂一组输出事件（模拟引擎流） */
function feed(coord: AgentCoordinator, executionId: string, events: Array<[string, Record<string, unknown>?]>) {
    const handler = (coord as unknown as {
        makeOutputHandler: (id: string) => (data: string, meta?: Record<string, unknown>) => void;
    }).makeOutputHandler(executionId);
    for (const [data, meta] of events) handler(data, meta);
}

/** 驱动私有 appendFinalAssistantLog（终态落盘） */
async function finalize(coord: AgentCoordinator, executionId: string) {
    await (coord as unknown as {
        appendFinalAssistantLog: (id: string) => Promise<void>;
    }).appendFinalAssistantLog(executionId);
}

/** 从 addLog 记录中提取 assistant 行（正文/thinking 等过程行不计入断言；非 JSON 行跳过） */
function assistantLines(added: Array<{ id: string; line: string }>) {
    return added
        .map(a => {
            try {
                return JSON.parse(a.line) as { type?: string; content?: string };
            } catch {
                return null; // 正文流写入的是纯文本行，不是 JSON
            }
        })
        .filter((l): l is { type?: string; content?: string } => l?.type === 'assistant');
}

describe('AgentCoordinator 最终答复显性化（appendFinalAssistantLog）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('正文流在最后：assistant 行取最后一段正文', async () => {
        const {coord, added} = makeCoordinator();
        feed(coord, 'e1', [
            ['第一步开始分析', {type: 'thinking'}],
            ['修改了 src/a.ts', undefined],
            ['再改映射', undefined],
        ]);
        await finalize(coord, 'e1');
        const lines = assistantLines(added);
        expect(lines).toHaveLength(1);
        expect(lines[0].content).toBe('再改映射');
    });

    it('thinking 在正文之后（汇总说在 reasoning 里）：assistant 行取 thinking 内容', async () => {
        const {coord, added} = makeCoordinator();
        feed(coord, 'e2', [
            ['修改映射逻辑', undefined],
            ['编译通过。汇总：改了两处映射', {type: 'thinking'}],
        ]);
        await finalize(coord, 'e2');
        const lines = assistantLines(added);
        expect(lines).toHaveLength(1);
        expect(lines[0].content).toContain('汇总：改了两处映射');
    });

    it('无任何叙述输出（只有工具事件）：不写 assistant 行', async () => {
        const {coord, added} = makeCoordinator();
        feed(coord, 'e3', [
            ['', {type: 'tool_use', toolName: 'Bash', toolUseId: 't1'}],
            ['done', {type: 'tool_result', toolUseId: 't1'}],
        ]);
        await finalize(coord, 'e3');
        expect(assistantLines(added)).toHaveLength(0);
    });

    it('纯空白叙述：不写 assistant 行', async () => {
        const {coord, added} = makeCoordinator();
        feed(coord, 'e4', [['   \n  ', undefined]]);
        await finalize(coord, 'e4');
        expect(assistantLines(added)).toHaveLength(0);
    });

    it('消费后追踪清除：二次 finalize 不再写行', async () => {
        const {coord, added} = makeCoordinator();
        feed(coord, 'e5', [['最终答复内容', undefined]]);
        await finalize(coord, 'e5');
        expect(assistantLines(added)).toHaveLength(1);
        await finalize(coord, 'e5');
        expect(assistantLines(added)).toHaveLength(1); // 无新增
    });

    it('超长答复截断到 16000 字符（带省略号）', async () => {
        const {coord, added} = makeCoordinator();
        const long = 'x'.repeat(20000);
        feed(coord, 'e6', [[long, undefined]]);
        await finalize(coord, 'e6');
        const lines = assistantLines(added);
        expect(lines).toHaveLength(1);
        expect(lines[0].content).toHaveLength(16001); // 16000 + …
        expect(lines[0].content.endsWith('…')).toBe(true);
    });

    it('thinking 截断放宽到 8000（行级仍截断防长思考刷爆日志）', async () => {
        const {coord, added} = makeCoordinator();
        const long = 'y'.repeat(9000);
        feed(coord, 'e7', [[long, {type: 'thinking'}]]);
        // 直查 thinking 行本身（appendStructured 写入）
        const thinkLine = added.map(a => JSON.parse(a.line) as { type?: string; content?: string })
            .find(l => l.type === 'thinking');
        expect(thinkLine?.content).toHaveLength(8001); // 8000 + …
    });
});
