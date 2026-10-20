/**
 * @module agent-coordinator.test
 * @description 「最终答复显性化」行为测试：appendFinalAssistantLog 从输出追踪中
 *   提取最后一段叙述（正文/思考中更晚者）写成 {type:'assistant'} 行。
 *
 * 背景：模型的汇总可能走正文通道也可能走 thinking 通道，刷新后两者都不再以
 * 显式姿态出现在消息流里（用户报「输出标签内容像被截断/丢失」）。
 *
 * 另覆盖「立即处理」中断流（interrupt 非终态）：中断续跑不落 aborted 终态、
 * 不广播 complete（此前前端会闪现「Agent执行已中止」+ 排队条永久滞留）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';

// broadcast 依赖真实 WebSocket 服务，测试中 mock 掉
vi.mock('../websocket.js', () => ({
    broadcast: vi.fn(),
    broadcastToWorkspace: vi.fn(),
}));

import {AgentCoordinator} from './agent-coordinator';
import {broadcast} from '../websocket.js';

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

/** 记录 store.updateStatus 调用 */
type StatusCall = { id: string; status: string };

describe('AgentCoordinator「立即处理」中断流（interrupt 非终态）', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    /**
     * 驱动 execute() 外层循环：fake store + 桩 runOnce。
     * drain：每轮 drainPendingReplies 依次返回的队列内容；
     * outcomes：每轮 runOnce 依次返回的终态（耗尽后返回 undefined → 循环按非 aborted/completed 收敛）。
     */
    function makeLoopCoordinator(drain: string[][], outcomes: Array<'completed' | 'failed' | 'aborted'>) {
        const coord = new AgentCoordinator({} as never);
        const statuses: StatusCall[] = [];
        const added: Array<{ id: string; line: string }> = [];
        const drains: string[][] = [];
        const store = {
            drainPendingReplies: async (_id: string) => {
                const batch = drain.shift() ?? [];
                drains.push(batch);
                return batch;
            },
            addLog: async (id: string, line: string) => {
                added.push({id, line});
            },
            addThought: async () => undefined,
            updateStatus: async (id: string, status: string) => {
                statuses.push({id, status});
            },
            get: async () => null,
            updateFull: async () => undefined,
            addStepLog: async () => undefined,
            updateSteps: async () => undefined,
            list: async () => [],
        };
        (coord as unknown as { store: unknown }).store = store;
        let round = 0;
        (coord as unknown as {
            runOnce: (id: string) => Promise<'completed' | 'failed' | 'aborted' | undefined>;
        }).runOnce = async () => outcomes[round++];
        return {coord, statuses, added, drains};
    }

    /** 广播调用记录（紧凑视图） */
    function broadcasts() {
        return vi.mocked(broadcast).mock.calls.map(c => c[0]);
    }

    it('中断续跑：循环继续下一轮，drain 后即时广播 queued_update，排队消息以 user 行上屏', async () => {
        const {coord, drains} = makeLoopCoordinator([['hello'], []], ['aborted', 'completed']);
        // 模拟 interruptNow 已设置的两个标志位
        (coord as unknown as {interruptFlags: Set<string>}).interruptFlags.add('e1');
        (coord as unknown as {queuedReplyFlags: Set<string>}).queuedReplyFlags.add('e1');

        await coord.execute('e1');

        // 第一轮 aborted+interrupt → 循环未退出，第二轮真实执行
        expect(drains).toEqual([['hello'], []]);

        const msgs = broadcasts();
        // 队列被消费的即时通知（前端清排队条）
        expect(msgs).toContainEqual({type: 'agent-execution:queued_update', data: {executionId: 'e1', queued: false}});
        // 排队消息以 user 行进入消息流
        expect(msgs).toContainEqual({
            type: 'agent-execution:log',
            data: {executionId: 'e1', log: JSON.stringify({type: 'user', content: 'hello'})},
        });
        // 循环层不广播 complete（终态广播只属于 runOnce 内部真实终态）
        expect(msgs.filter(m => m.type === 'agent-execution:complete')).toEqual([]);
    });

    it('interruptNow：中止在飞控制器并即时写「立即处理」日志；未运行的执行返回 false', async () => {
        const {coord, added} = makeLoopCoordinator([], []);
        const controller = new AbortController();
        (coord as unknown as {abortControllers: Map<string, AbortController>}).abortControllers.set('e2', controller);

        expect(coord.interruptNow('e2')).toBe(true);
        expect(controller.signal.aborted).toBe(true);
        // addLog 异步记录，冲微任务后断言
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(added.some(a => a.id === 'e2' && a.line.includes('立即处理排队消息'))).toBe(true);

        // 未运行的执行：无中断可触
        expect(coord.interruptNow('not-running')).toBe(false);
    });

    it('runSingleShot：中断（interruptFlags）跳过 aborted 终态落库/广播；真实中止仍正常落终态', async () => {
        const coord = new AgentCoordinator({
            cliRunner: {
                runBridge: async () => ({aborted: true, exitCode: 1, stdout: '', stderr: ''}),
            },
        } as never);
        const statuses: StatusCall[] = [];
        const execution = {id: 'e3', logs: [], steps: [], subTasks: [], requirementText: 'r', workspacePath: 'w'};
        (coord as unknown as { store: unknown }).store = {
            get: async () => execution,
            updateStatus: async (id: string, status: string) => {
                statuses.push({id, status});
            },
            addLog: async () => undefined,
            addThought: async () => undefined,
            updateSteps: async () => undefined,
            updateFull: async () => undefined,
        };
        const run = (coord as unknown as {
            runSingleShot: (
                id: string,
                exec: typeof execution,
                cwd: string,
                controller: AbortController,
                replies: string[],
                docs?: unknown[],
            ) => Promise<'completed' | 'failed' | 'aborted'>;
        }).runSingleShot.bind(coord);

        // 「立即处理」中断：不写 aborted 终态
        (coord as unknown as {interruptFlags: Set<string>}).interruptFlags.add('e3');
        expect(await run('e3', execution, 'w', new AbortController(), [], [])).toBe('aborted');
        expect(statuses).toEqual([]);
        expect(broadcasts().filter(m => m.type === 'agent-execution:complete')).toEqual([]);

        // 真实用户点停止：终态照常（清掉中断标志——真实链路里由 execute() 循环/finally 清除）
        (coord as unknown as {interruptFlags: Set<string>}).interruptFlags.delete('e3');
        expect(await run('e3', execution, 'w', new AbortController(), [], [])).toBe('aborted');
        expect(statuses).toEqual([{id: 'e3', status: 'aborted'}]);
        expect(broadcasts().some(m => m.type === 'agent-execution:complete')).toBe(true);
    });
});
