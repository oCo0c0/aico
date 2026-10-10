/**
 * @module agent-log-parse.test
 * @description 结构化日志行解析器测试：assistant（最终答复）新形态 + 既有 kind 回归
 *   + tool_use/tool_result 配对 + 增量解析器身份稳定。
 */
import {describe, it, expect} from 'vitest';
import {toLogMessages, createLogParser} from './agent-log-parse';

describe('parseLine：assistant 最终答复', () => {
    it('{type:"assistant"} → kind assistant', () => {
        const msgs = toLogMessages([JSON.stringify({type: 'assistant', content: '编译通过。汇总：…'})]);
        expect(msgs).toHaveLength(1);
        expect(msgs[0].kind).toBe('assistant');
        expect(msgs[0].content).toBe('编译通过。汇总：…');
    });

    it('assistant 不并入输出组（LogViewer 渲染为独立答复气泡的前提）', () => {
        const msgs = toLogMessages([
            '输出片段1',
            JSON.stringify({type: 'assistant', content: '最终答复'}),
            '输出片段2',
        ]);
        expect(msgs.map(m => m.kind)).toEqual(['output', 'assistant', 'output']);
    });
});

describe('parseLine：既有形态回归', () => {
    it('user / thinking / error / warning / output 映射', () => {
        const msgs = toLogMessages([
            JSON.stringify({type: 'user', content: '任务'}),
            JSON.stringify({type: 'thinking', content: '思考中'}),
            JSON.stringify({type: 'error', content: '出错'}),
            JSON.stringify({type: 'warning', content: '警告'}),
            JSON.stringify({type: 'output', content: '输出'}),
            '纯文本行',
        ]);
        expect(msgs.map(m => m.kind)).toEqual(['user', 'thinking', 'error', 'warning', 'output', 'output']);
    });

    it('旧格式 **User:** 前缀 → user', () => {
        const msgs = toLogMessages(['**User:** 做一下']);
        expect(msgs[0].kind).toBe('user');
    });

    it('tool_use + tool_result 按 id 配对为 tool 消息', () => {
        const msgs = toLogMessages([
            JSON.stringify({type: 'tool_use', toolName: 'Bash', toolUseId: 't1', toolInput: '{}'}),
            JSON.stringify({type: 'tool_result', toolUseId: 't1', isError: false, content: 'ok'}),
        ]);
        expect(msgs).toHaveLength(1);
        expect(msgs[0].kind).toBe('tool');
        expect(msgs[0].tool?.state).toBe('ok');
        expect(msgs[0].tool?.result).toBe('ok');
    });

    it('中断收敛：synthetic 结果把工具行置为 stopped，真实结果可再覆盖', () => {
        const parser = createLogParser();
        const use = JSON.stringify({type: 'tool_use', toolName: 'Bash', toolUseId: 't1'});
        const syn = JSON.stringify({type: 'tool_result', toolUseId: 't1', synthetic: true, reason: 'interrupted', content: '已中断'});
        const real = JSON.stringify({type: 'tool_result', toolUseId: 't1', isError: false, content: '其实完成了'});
        parser.feed([use]);
        const afterSynthetic = parser.feed([use, syn]);
        const stopped = afterSynthetic.find(m => m.kind === 'tool');
        expect(stopped?.tool?.state).toBe('stopped');
        expect(stopped?.tool?.stopReason).toBe('interrupted');
        const afterReal = parser.feed([use, syn, real]);
        const final = afterReal.find(m => m.kind === 'tool');
        expect(final?.tool?.state).toBe('ok');
    });
});

describe('createLogParser：增量身份稳定', () => {
    it('追加 assistant 行后既有消息对象身份不变', () => {
        const parser = createLogParser();
        const first = parser.feed(['第一段输出']);
        const second = parser.feed(['第一段输出', JSON.stringify({type: 'assistant', content: '答复'})]);
        expect(second).toHaveLength(2);
        expect(second[0]).toBe(first[0]); // 引用相等 → 下游 memo 跳过重渲染
        expect(second[1].kind).toBe('assistant');
    });
});
