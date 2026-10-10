/**
 * @module agent-log-parse
 * @description 结构化执行日志行 → LogMessageData[] 的共享解析器（Agent 执行 / 经典执行 / 开发计划页共用）。
 *
 * 日志行格式（与后端 agent-coordinator / utils/tool-log.ts 写入格式一致）：
 * - {type:'user'|'error'|'warning', content}
 * - {type:'assistant', content}                         → 最终答复（显式答复行）
 * - {type:'thinking', content}                          → Think 折叠行
 * - {type:'tool_use', toolName, toolUseId, toolInput}   → 与配对的 tool_result 合并为分类工具行
 * - {type:'tool_result', toolUseId, isError, content}
 * - {type:'output'|'info'|'system', content}            → 输出气泡
 * - 旧格式兼容：**User:** 前缀 → 用户消息；其余文本 → 输出
 *
 * tool_use + tool_result 配对规则：按 toolUseId 优先；同一 id 的真实结果可覆盖服务端补写的
 * 合成结果（中断/未返回）；无 id 的结果按 FIFO 配对最早的待结果行；未知 id 的结果行丢弃。
 * 服务端在中断/轮末会补写带 `synthetic` 标记的结果行，保证每个工具行都能收敛为终态。
 */

import type {LogMessageData} from '../components/LogMessage';
import type {ToolEventInfo} from '../components/ToolEventRow';

/** 日志输入行：纯文本，或带元数据的日志对象（ExecutionLogEntry 兼容） */
export interface LogLineInput {
    content: string;
    timestamp?: string;
    stepIndex?: number;
}

/** 单行解析结果：结构化工具事件附带配对元数据 */
interface ParsedLine {
    kind: 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'warning' | 'output';
    content: string;
    toolName?: string;
    toolInput?: string;
    toolUseId?: string;
    isError?: boolean;
    /** 服务端补写的合成结果（中断/未返回），非工具真实输出 */
    synthetic?: boolean;
    /** 合成原因：interrupted（被中断）/ unsettled（未返回） */
    reason?: string;
}

/** 解析单行日志文本 */
function parseLine(content: string): ParsedLine {
    try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
        switch (parsed.type) {
            case 'user':
                return {kind: 'user', content: str(parsed.content) || content};
            case 'assistant':
                // 最终答复：执行终态由服务端把最后一段叙述（正文/思考）提升为显式答复行
                return {kind: 'assistant', content: str(parsed.content) || ''};
            case 'thinking':
                return {kind: 'thinking', content: str(parsed.content) || ''};
            case 'tool_use':
                return {
                    kind: 'tool_use',
                    content: str(parsed.toolName) || 'Tool',
                    toolName: str(parsed.toolName),
                    toolUseId: str(parsed.toolUseId),
                    toolInput: str(parsed.toolInput),
                };
            case 'tool_result':
                return {
                    kind: 'tool_result',
                    content: str(parsed.content) || '',
                    toolUseId: str(parsed.toolUseId),
                    isError: parsed.isError === true,
                    // 服务端在「中断/未返回」时补写的合成结果：带标记，真实结果到达时可覆盖
                    synthetic: parsed.synthetic === true,
                    reason: str(parsed.reason),
                };
            case 'error':
                return {kind: 'error', content: str(parsed.content) || ''};
            case 'warning':
                return {kind: 'warning', content: str(parsed.content) || ''};
            case 'output':
            case 'info':
            case 'system':
                return {kind: 'output', content: str(parsed.content) || ''};
            default:
                break;
        }
        // 其他带 content 字符串字段的 JSON 对象统一归为输出
        if (typeof parsed.content === 'string') return {kind: 'output', content: parsed.content};
    } catch { /* not JSON */ }
    // 旧格式兼容：以 **User:** 开头是用户消息
    if (content.startsWith('**User:**')) return {kind: 'user', content};
    return {kind: 'output', content};
}

/**
 * 日志行数组 → LogMessageData[]（供 LogViewer 渲染；折叠/自动滚动由 LogViewer 内部处理）。
 * thinking 保留为独立 kind（渲染为 Think 折叠行）；
 * tool_use + 配对的 tool_result 合并为一条 'tool' 事件消息（渲染为分类工具行）。
 */
export function toLogMessages(logs: Array<string | LogLineInput>): LogMessageData[] {
    return createLogParser().feed(logs);
}

/**
 * 增量日志解析器：日志为追加式时只解析新增行（O(新增)），并复用既有消息对象
 * （身份稳定 → 下游 React.memo 生效）；检测到非追加式变化（切换执行/清空/重载）
 * 时自动全量重建。tool_use↔tool_result 配对状态跨 feed 保持。
 *
 * 高频追加场景（执行日志流）必须用本解析器替代 toLogMessages——
 * 后者每次全量 JSON.parse，O(n²) 会把 CPU 打满。
 */
export function createLogParser() {
    let parsedCount = 0;
    let firstLine: string | undefined;
    let lastLine: string | undefined;
    /** 累积真值：历史消息对象身份在此保持稳定（配对结果就地写回） */
    let messages: LogMessageData[] = [];
    /** 对外快照：内容变化时换新引用，未变化时保持同一引用（下游 memo/依赖稳定） */
    let publicMessages: LogMessageData[] = [];
    let openById = new Map<string, number>();
    /** 待结果的行（FIFO）：无 id 的结果按调用顺序配对最早的待结果行 */
    let openQueue: number[] = [];
    /** 已收敛的行：toolUseId → 下标（真实结果可覆盖同 id 的合成结果） */
    let settledById = new Map<string, number>();

    /** 行已收敛：从待结果索引中移除 */
    const closeOpen = (idx: number, id?: string) => {
        if (id) openById.delete(id);
        const at = openQueue.indexOf(idx);
        if (at !== -1) openQueue.splice(at, 1);
    };

    /**
     * 把结果写到目标工具行；合成结果不覆盖已到达的真实结果。
     *
     * 关键：写回时**必须换掉消息对象的引用**。日志行是追加式的，列表只在追加时
     * 拿到新数组；若这里原地改 `tool` 对象，下游 `LogMessage`（React.memo）比较
     * `message` 引用认为没变 → 跳过渲染，工具行会一直停在「转圈」，
     * 直到用户展开/折叠（组件内部 state 变化触发重渲染）才显示真实状态。
     */
    const applyResult = (idx: number, parsed: ParsedLine, synthetic: boolean) => {
        const message = messages[idx];
        const tool = message?.tool;
        if (!tool) return;
        if (synthetic && tool.state !== 'running') return;
        if (!synthetic) {
            tool.result = parsed.content;
            tool.state = parsed.isError ? 'error' : 'ok';
            delete tool.stopReason;
        } else {
            tool.state = 'stopped';
            tool.stopReason = parsed.reason === 'interrupted' ? 'interrupted' : 'unsettled';
            if (!tool.result) tool.result = parsed.content;
        }
        // 换新引用驱动下游重渲染（tool 对象就地更新，保证解析器内部状态一致）
        messages[idx] = {...message, tool};
    };

    const parseFrom = (contents: string[], metas: Array<LogLineInput | undefined>, from: number): LogMessageData[] => {
        for (let i = from; i < contents.length; i++) {
            const meta = metas[i];
            const parsed = parseLine(contents[i]);
            // 时间戳/步骤号透传（ExecutionLogEntry 携带的展示元数据）
            const base = meta ? {timestamp: meta.timestamp, stepIndex: meta.stepIndex} : {};

            if (parsed.kind === 'tool_use') {
                const tool: ToolEventInfo = {
                    name: parsed.toolName || 'Tool',
                    input: parsed.toolInput,
                    state: 'running',
                };
                messages.push({kind: 'tool', content: tool.name, tool, ...base});
                const idx = messages.length - 1;
                if (parsed.toolUseId) openById.set(parsed.toolUseId, idx);
                openQueue.push(idx);
            } else if (parsed.kind === 'tool_result') {
                const synthetic = parsed.synthetic === true;
                const id = parsed.toolUseId;
                if (id && openById.has(id)) {
                    const idx = openById.get(id)!;
                    closeOpen(idx, id);
                    applyResult(idx, parsed, synthetic);
                    // 合成与真实结果都登记：合成结果（中断/未返回）随后可被真实结果升级
                    settledById.set(id, idx);
                } else if (id && settledById.has(id)) {
                    // 同 id 的后续结果：仅当该行先前是**合成结果**（中断/未返回）时，
                    // 用真实结果覆盖它（中断后工具其实已完成）；重复的真实结果一律忽略，
                    // 否则同一工具行会被后续重复行反复改写
                    const idx = settledById.get(id)!;
                    if (!synthetic && messages[idx]?.tool?.stopReason) applyResult(idx, parsed, false);
                } else if (!id) {
                    // 无 id 的结果（部分引擎不返回 id）：FIFO 配对最早的待结果行
                    const idx = openQueue.find(at => messages[at]?.tool?.state === 'running');
                    if (idx !== undefined) {
                        closeOpen(idx);
                        applyResult(idx, parsed, synthetic);
                    }
                }
                // 未知 id 的结果行丢弃（多为历史/重放），避免污染其它工具行
            } else {
                messages.push({kind: parsed.kind, content: parsed.content, ...base});
            }
        }
        parsedCount = contents.length;
        firstLine = contents[0];
        lastLine = contents[contents.length - 1];
        // 内容变化：换对外引用驱动重渲染（内部对象身份不变）
        publicMessages = [...messages];
        return publicMessages;
    };

    return {
        /** 喂入完整日志数组（通常为追加式）；有新行时返回新引用，否则复用同一引用 */
        feed(logs: Array<string | LogLineInput>): LogMessageData[] {
            const contents = logs.map((l) => (typeof l === 'object' && l !== null ? l.content : String(l)));
            const metas = logs.map((l) => (typeof l === 'object' && l !== null ? l : undefined));

            // 追加式判定：长度不减 且 首行 / 上次解析到的尾行一致
            const appendOnly = contents.length >= parsedCount
                && (parsedCount === 0
                    || (contents[0] === firstLine && contents[parsedCount - 1] === lastLine));

            if (!appendOnly) {
                // 非追加式（切换执行 / 清空 / 中间重载）：全量重建
                messages = [];
                publicMessages = [];
                openById = new Map();
                openQueue = [];
                settledById = new Map();
                parsedCount = 0;
                return parseFrom(contents, metas, 0);
            }
            if (contents.length === parsedCount) return publicMessages; // 无新行：复用引用
            return parseFrom(contents, metas, parsedCount);
        },
    };
}

// ── 本次产出（deliverables）：从写类工具事件派生变更文件清单 ──

/** 产出文件条目 */
export interface DeliverableFile {
    /** 路径（工具参数原值） */
    path: string;
    /** 文件名（末段） */
    name: string;
    /** 所在目录末段（展示用） */
    dir: string;
}

/** 写类工具（产出文件）；读取/搜索/终端不产文件 */
const MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** 从工具参数 JSON 挑路径键（可能被后端截断，解析失败返回 undefined） */
function pickPathArg(inputJson?: string): string | undefined {
    if (!inputJson) return undefined;
    try {
        const args = JSON.parse(inputJson) as Record<string, unknown>;
        if (typeof args !== 'object' || args === null) return undefined;
        for (const key of ['path', 'file_path']) {
            const v = args[key];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
    } catch { /* not JSON */ }
    return undefined;
}

/**
 * 从解析后的消息流派生「本次产出」文件清单（对齐 DSH turn-deliverables 语义）：
 * 仅统计**成功的**写类工具（Write/Edit/MultiEdit/NotebookEdit）参数中的文件路径；
 * 失败的调用不计入，读取不算产出；首次出现顺序去重（同文件先写后改只算一条）。
 */
export function deliverableFilesFromMessages(messages: LogMessageData[]): DeliverableFile[] {
    const out: DeliverableFile[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
        if (m.kind !== 'tool' || !m.tool || m.tool.state !== 'ok') continue;
        if (!MUTATION_TOOLS.has(m.tool.name)) continue;
        const p = pickPathArg(m.tool.input);
        if (!p || seen.has(p)) continue;
        seen.add(p);
        const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        const segments = p.slice(0, at === -1 ? 0 : at).split(/[\\/]/).filter(Boolean);
        out.push({
            path: p,
            name: at === -1 ? p : p.slice(at + 1),
            dir: segments[segments.length - 1] || '',
        });
    }
    return out;
}

/** 便捷重载：从原始日志行派生（内部全量解析，高频场景请用 useParsedLogs + deliverableFilesFromMessages） */
export function deriveDeliverableFiles(logs: Array<string | LogLineInput>): DeliverableFile[] {
    return deliverableFilesFromMessages(toLogMessages(logs));
}

/**
 * 执行结束时的兜底：把仍停在「运行中」的工具行收成 stopped 终态。
 *
 * 权限被拒 / 执行被中止 / 工具无返回等情况下不会有配对的 tool_result，
 * 工具行会永远转圈。就地写入状态（解析器保留对象身份），仅在有变化时返回新数组
 * —— 若执行之后恢复并收到真实结果，配对逻辑会显式覆写为 ok / error。
 *
 * @returns 处理后的消息数组；无变化时返回入参本身（下游 memo 不受影响）
 */
export function finalizeRunningTools(messages: LogMessageData[]): LogMessageData[] {
    let changed = false;
    const out = messages.map((m) => {
        if (m.kind !== 'tool' || m.tool?.state !== 'running') return m;
        changed = true;
        // 就地更新 tool（解析器内部视图同步收敛，下次调用即无变化、引用稳定）
        m.tool.state = 'stopped';
        m.tool.stopReason ??= 'unsettled';
        // 换新消息引用：否则 React.memo 会跳过渲染，工具行仍显示转圈
        return {...m, tool: m.tool};
    });
    return changed ? out : messages;
}
