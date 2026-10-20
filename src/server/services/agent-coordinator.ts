/**
 * @file Agent Coordinator (通用设计，不依赖特定格式)
 * @description 执行Agent并透传所有输出，解析结构化事件（thinking/tool_use/tool_result），
 *              生成思考过程、执行步骤、子任务数据并广播给前端。
 *
 * 执行模式：
 * - 首次运行（无 subTasks / 无 session / 无用户回复）：先 LLM 任务分解（2-8 个子任务），
 *   再串行执行每个子任务（复用 session 续接）；分解失败降级为单次执行。
 * - 续接 / 用户回复：跳过分解，直接单次执行（沿用旧行为）。
 */

import {randomUUID} from 'crypto';
import {AgentExecutionStore} from './agent-execution-store.js';
import {CLIRunnerService, type CLIExecutionResult} from './cli-runner-service.js';
import {broadcast} from '../websocket.js';
import {renderPrompt} from '../utils/prompt-renderer.js';
import {PROMPTS} from '../prompts';
import {enrichPrompt} from '../utils/prompt-enrichment.js';
import {runBridgeJson} from '../utils/bridge-json-runner.js';
import {validateShape, type FieldSpec} from '../utils/json-validator.js';
import {getErrorMessage} from '../utils/error-utils.js';
import type {AgentExecution, SubTask} from '../../types/agent-execution.js';
import type {MemoryService} from './memory/memory-service.js';
import type {AttachmentStore, StoredAttachment} from './attachment-store.js';
import {formatAttachmentsBlock} from './attachment-store.js';
import {isStepWorthyTool} from '../platform/tool-catalog.js';
import {buildSkillInjections} from './skill-injection.js';
import {buildTranscript} from '../utils/transcript.js';

export interface CoordinatorConfig {
    cliRunner: CLIRunnerService;
    workspacePath?: string;
    /** 记忆服务（可选，用于 enrichPrompt 注入项目上下文） */
    memoryService?: MemoryService;
    /** 聊天附件暂存（可选）：路由 reply/start 时 bindPending，协调器组 prompt 时 takePending 一次性注入 */
    attachments?: AttachmentStore;
}

// 写类/Shell/任务/定时类工具才创建独立步骤，Read/Glob/Grep 等读操作是噪声。
// 按工具分类目录判定（覆盖 claude/pi/codex 三个引擎的工具名，见 platform/tool-catalog），
// 不再硬编码单个引擎的工具名集合。

/**
 * 从工具结果内容中抽取可展示的文本摘要。
 * 兼容三种形态：
 * - string：直接返回
 * - Claude content block 数组：[{type:'text', text:'...'}, {type:'tool_result', content:[...]}] 等
 * - 其他对象：JSON 序列化
 */
function extractToolResultText(content: unknown): string {
    if (typeof content === 'string') return content.trim();
    if (content == null) return '';
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
            if (typeof block === 'string') {
                parts.push(block);
            } else if (block && typeof block === 'object') {
                const b = block as Record<string, unknown>;
                if (typeof b.text === 'string') parts.push(b.text);
                else if (typeof b.content === 'string') parts.push(b.content);
                else if (Array.isArray(b.content)) {
                    const nested = extractToolResultText(b.content);
                    if (nested) parts.push(nested);
                }
            }
        }
        return parts.join('\n').trim();
    }
    // 其他对象 → 序列化
    try {
        return JSON.stringify(content).trim();
    } catch {
        return '';
    }
}

/**
 * 跨引擎/会话失效续接时注入 prompt 的上下文块。
 *
 * 会话实体由各引擎自己托管，换引擎就无法直接续接 —— 用应用侧保存的对话摘要
 * 让新引擎接上前面的工作，而不是让用户感觉「上下文凭空丢了」。
 */
export function continuityBlock(transcript: string): string {
    return '\n\n---\n\n## 此前会话上下文（摘要）\n\n'
        + '因引擎切换或会话失效，你无法直接看到此前的对话记录。以下是同一任务此前的对话摘要，'
        + '请据此延续工作，不要重复已完成的部分：\n\n'
        + transcript;
}

/** 任务分解输出校验规格：{subTasks: [{id?, title, description?}]}，1-8 项 */
const SUBTASK_DECOMPOSE_SPEC: Record<string, FieldSpec> = {
    subTasks: {
        type: 'array',
        required: true,
        minItems: 1,
        maxItems: 8,
        item: {
            type: 'object',
            fields: {
                id: {type: 'string', required: false},
                title: {type: 'string', required: true, minLength: 2},
                description: {type: 'string', required: false},
            },
        },
    },
};

export class AgentCoordinator {
    private store = AgentExecutionStore.getInstance();
    private abortControllers = new Map<string, AbortController>();
    /** 每个执行已「允许并记住」的工具名白名单（executionId → toolNames） */
    private allowedTools = new Map<string, Set<string>>();
    /** 挂起的权限请求：permissionRequestId → {executionId, toolName} */
    private pendingPermissions = new Map<string, { executionId: string; toolName: string }>();
    /** 运行期间收到排队回复的标志（消息本身已写入 user 日志，本轮结束后自动续跑消费） */
    private queuedReplyFlags = new Set<string>();
    /** 「立即处理」标志：abort 当前轮后不落 aborted 终态，自动带新消息续跑 */
    private interruptFlags = new Set<string>();
    /**
     * 尚未收到结果的工具调用（executionId → toolUseId 集合）。
     * 用于轮次结束时兜底闭合：权限被拒/被中止/工具未返回等情况下，
     * 前端工具行会永远停在「运行中」转圈 —— 轮末补一条结果把它收到终态。
     */
    private pendingToolCalls = new Map<string, Set<string>>();
    /**
     * 「最终答复」追踪（executionId → 本轮最近一次正文/thinking 输出）。
     * makeOutputHandler 持续覆盖，执行终态时由 appendFinalAssistantLog 消费并清除。
     * 背景：模型的最终答复可能走 text 通道（常规），也可能走 thinking 通道
     * （思考模型偶发把汇总说在 reasoning 里，正文通道为空）——刷新/切页后
     * 执行日志里只剩一条收起的 Think 行，用户以为汇总丢了。取两者中更晚出现者
     * 写成 {type:'assistant'} 行，让「最终答复」成为消息流里的显式形态。
     */
    private lastOutputs = new Map<string, { plain: string; thinking: string; seq: number; plainSeq: number; thinkingSeq: number }>();
    /**
     * 正在运行的执行（单个执行同时只允许一个 execute 循环）。
     * 重复 start / 客户端重放 / 中断续跑重入会把同一执行跑成多个并发循环：
     * 日志重复（同一行写多次）、bridge 事件串线、工具行错配。
     */
    private runningExecutions = new Set<string>();
    /** 跨引擎/会话失效续接时注入的上下文摘要上限（字符） */
    private static readonly CONTINUITY_TRANSCRIPT_CHARS = 12_000;
    /** 单轮步数上限（引擎 maxTurns）的自动续跑批数上限：8 × 50 = 400 轮 */
    private static readonly MAX_TURN_BATCHES = 8;
    private config: CoordinatorConfig;

    constructor(config: CoordinatorConfig) {
        this.config = config;
    }

    /**
     * 执行 Agent — 首次运行任务分解 + 串行子任务 / 单次执行。
     * 外层循环消费两类续跑：①运行期间排队的用户消息（本轮结束后自动续跑）；
     * ②「立即处理」中断（中止当前轮后直接带新消息续跑）。
     */
    async execute(executionId: string): Promise<void> {
        // 单执行单循环：已有循环在跑时忽略重复调用（日志重复 / 事件串线的源头）
        if (this.runningExecutions.has(executionId)) {
            console.warn(`[coordinator] 执行 ${executionId} 已在运行，忽略重复的 execute 调用`);
            return;
        }
        this.runningExecutions.add(executionId);
        try {
            while (true) {
                this.queuedReplyFlags.delete(executionId);
                // 消费排队消息：此刻才写入对话日志（上屏时机=消费时机，
                // 避免消息在发送瞬间插入当前轮输出导致显示顺序错乱）
                const drained = await this.store.drainPendingReplies(executionId).catch(() => [] as string[]);
                if (drained.length > 0) {
                    // 队列已被消费：即时通知前端清掉排队条（不等下一次轮询。
                    // 此前队列变化只能靠轮询，轮询被瞬时终态窗口杀掉时排队条永久滞留）
                    broadcast({
                        type: 'agent-execution:queued_update',
                        data: {executionId, queued: false},
                    });
                }
                for (const message of drained) {
                    this.broadcastLog(executionId, JSON.stringify({type: 'user', content: message}));
                }

                const outcome = await this.runOnce(executionId);

                // 轮末收敛：把没有收到结果的工具调用收成终态，
                // 否则前端工具行会永远停在「运行中」转圈（权限被拒/被中止/工具未返回等）
                await this.settlePendingToolCalls(executionId, 'unsettled');

                if (outcome === 'aborted' && this.interruptFlags.has(executionId)) {
                    // 「立即处理」中断：非终态——aborted 状态未落库/未广播
                    // （runOnce 内已跳过终态写入），新消息已在循环顶部 drain 进日志，
                    // 直接续跑即可（runOnce 开头会重新声明 running）
                    this.interruptFlags.delete(executionId);
                    continue;
                }
                if (outcome === 'completed' && this.queuedReplyFlags.has(executionId)) {
                    // 排队消息自动续跑：runOnce 会从日志提取 user 回复续接会话。
                    // 以真实队列为准（而非仅标志位）：排队消息可能已被用户编辑/删除，
    // 删空后不再空转一轮
                    const execution = await this.store.get(executionId).catch(() => undefined);
                    if (!execution?.pendingReplies?.length) {
                        break;
                    }
                    await this.store.updateStatus(executionId, 'running');
                    this.broadcastStatus(executionId, 'running');
                    await this.store.addLog(executionId, '📨 存在排队消息，继续处理').catch(() => undefined);
                    continue;
                }
                break;
            }
        } catch (error) {
            console.error(`[coordinator] execute error:`, error);
            await this.finalizeSteps(executionId, 'failed');
            await this.store.updateStatus(executionId, 'failed');
            await this.store.addLog(executionId, `执行失败: ${(error as Error).message}`);
            this.broadcastStatus(executionId, 'failed');
            this.broadcastComplete(executionId, 'failed');
        } finally {
            this.runningExecutions.delete(executionId);
            this.abortControllers.delete(executionId);
            // 兜底收敛最后一次（异常路径 / 提前 return 也要收干净）
            await this.settlePendingToolCalls(executionId, 'unsettled').catch(() => undefined);
            this.pendingToolCalls.delete(executionId);
            // 执行结束清理本次白名单与挂起权限（bridge 侧超时兜底会处理残留）
            this.allowedTools.delete(executionId);
            this.denyPendingPermissions(executionId, '执行已结束');
            this.queuedReplyFlags.delete(executionId);
            this.interruptFlags.delete(executionId);
        }
    }

    /** 单轮执行（任务分解 + 串行子任务 / 单次），返回本轮终态 */
    private async runOnce(executionId: string): Promise<'completed' | 'failed' | 'aborted'> {
        const execution = await this.store.get(executionId);
        if (!execution) throw new Error('Execution not found');

        const controller = new AbortController();
        this.abortControllers.set(executionId, controller);

        await this.store.updateStatus(executionId, 'running');
        this.broadcastStatus(executionId, 'running');

        const cwd = execution.workspacePath || this.config.workspacePath || process.cwd();

        // 从日志中提取用户回复消息（兼容新旧两种格式），拼入 prompt 让 Agent 看到后续指令
        const userReplies = execution.logs
            .map(log => {
                // 新格式：JSON {type: 'user', content: '...'}
                try {
                    const parsed = JSON.parse(log);
                    if (parsed.type === 'user') return parsed.content || '';
                } catch { /* fall through */ }
                // 旧格式：**User:** 前缀（向后兼容）
                if (log.startsWith('**User:**')) return log.replace('**User:** ', '');
                return null;
            })
            .filter((r): r is string => r !== null && r.length > 0);

        // 技能手势注入（对齐 DSH 的 agent/pre-step 注入）：用户消息里的 `/skill-name` 由服务端
        // 展开为 <skill_content> 追加到本轮上下文；原文保留 —— 前端只写字面 /name，
        // 因此菜单选中、手打与其它客户端走同一条路。命中未知技能不注入也不报错。
        try {
            const skillBlock = await buildSkillInjections(userReplies);
            if (skillBlock) userReplies.push(skillBlock);
        } catch (err) {
            console.error(`[coordinator] skill injection failed: ${err instanceof Error ? err.message : err}`);
        }

        // 一次性取走该执行绑定的聊天附件（取出即删），组 prompt 时注入——每轮循环
        // （排队续跑/中断续跑）都会走到这里，保证排队消息的附件在其被消费的那轮注入
        const pendingDocs = this.config.attachments?.takePending(executionId) ?? [];

        // 仅「首次运行」做任务分解：已有 subTasks / 已有会话 / 有用户回复都跳过
        let subTasks = execution.subTasks ?? [];
        // 所有子任务均已结束且本次为回复/续接 → 回退单次执行，让用户补充信息生效
        const allTerminal = subTasks.length > 0
            && subTasks.every(t => t.status === 'completed' || t.status === 'failed' || t.status === 'skipped');
        if (allTerminal && (userReplies.length > 0 || execution.sessionId)) {
            subTasks = [];
        }
        if (subTasks.length === 0 && !execution.sessionId && userReplies.length === 0) {
            subTasks = await this.tryDecompose(execution, cwd, controller.signal);
        }

        // 分解过程中被中止：直接终态，避免空跑一次 bridge
        if (controller.signal.aborted) {
            // 「立即处理」中断不是终态：跳过终态写入/广播，外层循环带新消息续跑
            if (!this.interruptFlags.has(executionId)) {
                await this.finalizeSteps(executionId, 'aborted');
                await this.store.updateStatus(executionId, 'aborted');
                this.broadcastStatus(executionId, 'aborted');
                this.broadcastComplete(executionId, 'aborted');
            }
            return 'aborted';
        }

        if (subTasks.length > 0) {
            return this.runSubTaskLoop(executionId, execution, cwd, subTasks, controller, pendingDocs);
        }
        return this.runSingleShot(executionId, execution, cwd, controller, userReplies, pendingDocs);
    }

    /**
     * 运行中的用户回复入队标志：消息本体在 store.pendingReplies 中，
     * 由 execute 外层循环消费（drainPendingReplies 落日志）后续跑
     */
    markQueuedReply(executionId: string): void {
        this.queuedReplyFlags.add(executionId);
        broadcast({
            type: 'agent-execution:queued_update',
            data: {executionId, queued: true},
        });
    }

    /**
     * 「立即处理」：中止当前轮，外层循环检测标志后自动带新消息续跑。
     * 中断不是终态——全程保持 running，不广播 aborted/complete，
     * 前端因此不会闪现「Agent执行已中止」。
     * @returns 是否成功触发（无运行中的控制器时返回 false）
     */
    interruptNow(executionId: string): boolean {
        const controller = this.abortControllers.get(executionId);
        if (!controller) return false;
        this.interruptFlags.add(executionId);
        this.queuedReplyFlags.add(executionId);
        // 即时反馈：点击「立即处理」立刻有日志说明发生了什么，
        // 而不是沉默等 abort 走完后才由续跑轮次间接体现
        const notice = '⚡ 立即处理排队消息：正在中断当前轮…';
        this.store.addLog(executionId, notice)
            .then(() => this.broadcastLog(executionId, notice))
            .catch(() => undefined);
        controller.abort();
        this.denyPendingPermissions(executionId, '已中断当前轮，立即处理新消息');
        // 中断瞬间就收敛在飞工具：被 abort 的工具不会再返回结果，
        // 立刻收起转圈（真实结果若仍到达，前端会用真实结果覆盖合成行）
        this.settlePendingToolCalls(executionId, 'interrupted').catch(err => {
            console.error(`[coordinator] settle interrupted tools failed:`, err);
        });
        return true;
    }

    /**
     * 构造输出处理器（单次与子任务循环共用）。
     * 对话输出写入执行日志；thinking / tool_use / tool_result 以结构化 JSON 行
     * 写入同一日志流，前端 LogMessage 按类型渲染为 Think 行 / 工具行
     * （对齐 DeepSeek Harness 的消息流设计，取代旁路的「思考过程 / 执行步骤」面板）。
     * thoughts / steps 数据照常落 store（历史详情与统计仍可用）。
     * 结构化行做长度截断，避免文件全文/长思考刷爆日志。
     */
    private makeOutputHandler(executionId: string): (data: string, meta?: Record<string, unknown>) => void {
        const appendStructured = (line: Record<string, unknown>) => {
            const text = JSON.stringify(line);
            // Store 写成功后再广播，保证前端收到日志时数据已持久化
            this.store.addLog(executionId, text)
                .then(() => this.broadcastLog(executionId, text))
                .catch(err => {
                    console.error(`[coordinator] addLog failed for ${executionId}:`, err);
                });
        };
        // 最终答复追踪：同一执行的多次 runBridge（多轮对话/子任务）各自覆盖，
        // 终态时只保留最后一轮的输出（appendFinalAssistantLog 消费后清除）
        const track = {plain: '', thinking: '', seq: 0, plainSeq: 0, thinkingSeq: 0};
        this.lastOutputs.set(executionId, track);
        return (data: string, meta?: Record<string, unknown>) => {
            if (data && meta?.type !== 'tool_result' && meta?.type !== 'thinking') {
                // 最终答复候选：正文通道（text delta 流）
                track.seq++;
                track.plain = data;
                track.plainSeq = track.seq;
                // Store 写成功后再广播，保证前端收到日志时数据已持久化
                this.store.addLog(executionId, data)
                    .then(() => this.broadcastLog(executionId, data))
                    .catch(err => {
                        console.error(`[coordinator] addLog failed for ${executionId}:`, err);
                    });
            }

            // 结构化事件 → 写 store + 广播 rich events
            if (!meta) return;

            switch (meta.type) {
                case 'thinking': {
                    // 8000：思考模型可能把最终汇总说在 reasoning 里（正文通道为空），
                    // 截断太狠会让唯一的答复在刷新后不可读；行级截断仍防长思考刷爆日志
                    const content = data.length > 8000 ? `${data.slice(0, 8000)}…` : data;
                    track.seq++;
                    track.thinking = data;
                    track.thinkingSeq = track.seq;
                    appendStructured({type: 'thinking', content});
                    this.handleThinking(executionId, data).catch(err => {
                        console.error(`[coordinator] handleThinking failed:`, err);
                    });
                    break;
                }
                case 'tool_use': {
                    const toolInput = meta.toolInput as Record<string, unknown> | undefined;
                    // 登记未闭合的工具调用（轮末兜底闭合用）
                    const openId = typeof meta.toolUseId === 'string' ? meta.toolUseId : '';
                    if (openId) {
                        const set = this.pendingToolCalls.get(executionId) ?? new Set<string>();
                        set.add(openId);
                        this.pendingToolCalls.set(executionId, set);
                    }
                    appendStructured({
                        type: 'tool_use',
                        toolName: (meta.toolName as string) || 'Tool',
                        toolUseId: meta.toolUseId,
                        toolInput: toolInput ? JSON.stringify(toolInput).slice(0, 2000) : undefined,
                    });
                    this.handleToolUse(executionId, meta).catch(err => {
                        console.error(`[coordinator] handleToolUse failed:`, err);
                    });
                    break;
                }
                case 'tool_result': {
                    // 工具结果内容（data）截断后进日志流，同时照旧写 stepLog 供历史详情查看
                    const content = data && data.length > 2000 ? `${data.slice(0, 2000)}…` : (data || '');
                    const closedId = typeof meta.toolUseId === 'string' ? meta.toolUseId : '';
                    if (closedId) this.pendingToolCalls.get(executionId)?.delete(closedId);
                    appendStructured({
                        type: 'tool_result',
                        toolUseId: meta.toolUseId,
                        isError: !!meta.isError,
                        content,
                    });
                    this.handleToolResult(executionId, meta, data).catch(err => {
                        console.error(`[coordinator] handleToolResult failed:`, err);
                    });
                    break;
                }
            }
        };
    }

    /**
     * 从最终输出追踪中提取「最终答复」，写成显式 {type:'assistant'} 日志行。
     *
     * 背景：模型的汇总/答复走 text 或 thinking 通道，两种形态在刷新/切页后
     * 都不再以「输出/答复」的显式姿态出现在消息流里（thinking 行折叠、正文行
     * 可能混在工具行之间）——用户以为汇总丢了。此方法在执行终态把最后出现的
     * 叙述内容（正文段与思考段中更晚者）提升为 assistant 行，前端渲染为
     * 独立的「答复」消息，持久化后刷新也可见。
     */
    private async appendFinalAssistantLog(executionId: string): Promise<void> {
        const track = this.lastOutputs.get(executionId);
        if (!track) return;
        this.lastOutputs.delete(executionId);
        // 取正文段与思考段中更晚出现者（pi 的 flush 顺序是 thinking 先、正文后）
        const finalText = track.plainSeq >= track.thinkingSeq ? track.plain : track.thinking;
        const text = finalText.trim();
        if (!text) return;
        const content = text.length > 16000 ? `${text.slice(0, 16000)}…` : text;
        const line = JSON.stringify({type: 'assistant', content});
        try {
            await this.store.addLog(executionId, line);
            this.broadcastLog(executionId, line);
        } catch (err) {
            console.error(`[coordinator] appendFinalAssistantLog failed for ${executionId}:`, err);
        }
    }

    /**
     * 收敛尚未收到结果的工具调用：写一条带标记的「合成结果」行，使前端工具行进入终态。
     *
     * 两种语义分开标记，前端据此渲染不同文案（对齐 DSH：工具行状态由已收敛的结果节点决定）：
     * - interrupted：用户中断（「立即处理」/中止）——SDK 被 abort，在飞工具不会有结果；
     *   中断瞬间就收敛，工具行立刻停止转圈并显示「已中断」。
     * - unsettled：轮末仍未返回（权限被拒 / 工具无返回 / 子进程退出）——显示「未返回结果」。
     *
     * 合成结果带 `synthetic: true`：若之后真实结果到达（中断时工具其实已完成），
     * 前端会用真实结果覆盖它，不会把真实结果误当重复而丢弃。
     */
    private async settlePendingToolCalls(executionId: string, reason: 'interrupted' | 'unsettled'): Promise<void> {
        const pending = this.pendingToolCalls.get(executionId);
        if (!pending || pending.size === 0) return;
        const ids = [...pending];
        pending.clear();
        const content = reason === 'interrupted'
            ? '（已中断：本轮被中止，该工具未返回结果）'
            : '（本轮结束，未收到该工具的返回结果）';
        for (const toolUseId of ids) {
            const line = JSON.stringify({
                type: 'tool_result',
                toolUseId,
                isError: false,
                synthetic: true,
                reason,
                content,
            });
            await this.store.addLog(executionId, line).catch(() => undefined);
            this.broadcastLog(executionId, line);
        }
    }

    /** 构造权限请求处理器（单次与子任务循环共用） */    private makePermissionHandler(executionId: string): (meta: Record<string, unknown>) => void {
        return (meta) => this.handlePermissionRequest(executionId, meta);
    }

    /**
     * LLM 任务分解。成功写入 subTasks 并广播 agent-execution:plan；
     * 失败降级返回 []，由 execute() 回退到单次执行模式。
     */
    private async tryDecompose(execution: AgentExecution, cwd: string, signal: AbortSignal): Promise<SubTask[]> {
        try {
            const promptText = enrichPrompt(
                renderPrompt(PROMPTS.agentDecompose, {
                    requirementText: execution.requirementText || '',
                    cwd,
                }),
                this.config.memoryService,
                cwd,
            );

            const result = await runBridgeJson<{
                subTasks: Array<{ id?: string; title: string; description?: string }>
            }>({
                cliRunner: this.config.cliRunner,
                prompt: promptText,
                cwd,
                signal,
                maxTurns: 10,
                maxRetries: 2,
                validator: (value) => validateShape(value, SUBTASK_DECOMPOSE_SPEC),
            });

            if (!result.ok || !result.data || !Array.isArray(result.data.subTasks) || result.data.subTasks.length === 0) {
                throw new Error(result.validationErrors?.join('; ') || result.error || '分解失败');
            }

            const subTasks: SubTask[] = result.data.subTasks.map((t, i) => ({
                id: t.id ?? `sub-${i + 1}`,
                title: t.title,
                description: t.description,
                status: 'pending',
                order: i,
            }));

            await this.store.setSubTasks(execution.id, subTasks);
            broadcast({
                type: 'agent-execution:plan',
                data: {executionId: execution.id, subTasks},
            });
            await this.store.addLog(execution.id, `已分解为 ${subTasks.length} 个子任务`);
            return subTasks;
        } catch (err) {
            console.warn(`[coordinator] 任务分解失败，将以单次执行模式继续: ${getErrorMessage(err)}`);
            await this.store.addLog(execution.id, '任务分解失败，将以单次执行模式继续').catch(() => undefined);
            return [];
        }
    }

    /**
     * 串行执行子任务循环，复用 session 续接。
     * 每个子任务独立 runBridge；子任务边界收尾 tool steps。
     * 子任务 prompt 不直接拼用户回复，但 start 时附带的聊天附件
     * （无回复文本、走分解路径的场景）会追加到首个实际执行的子任务 prompt，
     * 避免附件被丢弃。
     */
    private async runSubTaskLoop(
        executionId: string,
        execution: AgentExecution,
        cwd: string,
        subTasks: SubTask[],
        controller: AbortController,
        pendingDocs: StoredAttachment[] = [],
    ): Promise<'completed' | 'failed' | 'aborted'> {
        // 会话归属判定（换引擎 / 会话失效 → 不传旧 id，改用此前对话摘要延续上下文）
        const session = await this.resolveSessionForRun(execution, cwd);
        await this.announceSessionNotice(executionId, session.notice);
        let lastSessionId = session.sessionId;
        let continuityInjected = false;
        let overall: 'completed' | 'failed' | 'aborted' = 'completed';
        let attachmentsInjected = false;

        for (const sub of subTasks) {
            if (controller.signal.aborted) {
                overall = 'aborted';
                break;
            }

            // 恢复执行时跳过已完成/已跳过的子任务
            const current = (await this.store.get(executionId))?.subTasks.find(t => t.id === sub.id);
            if (current && (current.status === 'completed' || current.status === 'skipped')) continue;

            await this.store.updateSubTask(executionId, sub.id, {
                status: 'running',
                startedAt: new Date().toISOString(),
            }).catch(() => undefined);
            broadcast({
                type: 'agent-execution:subtask',
                data: {executionId, subTaskId: sub.id, title: sub.title, status: 'running'},
            });

            const completedTitles = subTasks
                .filter(t => t.order < sub.order)
                .map(t => `- ${t.title}`)
                .join('\n');

            let subPrompt = renderPrompt(PROMPTS.agentSubTask, {
                subTaskTitle: sub.title,
                subTaskDescription: sub.description ?? '',
                completedTitles,
            });
            // 聊天附件块只注入一次（首个实际执行的子任务），避免重复膨胀后续 prompt
            if (pendingDocs.length > 0 && !attachmentsInjected) {
                subPrompt += formatAttachmentsBlock(pendingDocs);
                attachmentsInjected = true;
            }
            // 会话无法续接时，把此前对话摘要带进首个实际执行的子任务
            if (session.transcript && !continuityInjected) {
                subPrompt += continuityBlock(session.transcript);
                continuityInjected = true;
            }

            const result = await this.runBridgeWithTurnContinuation(
                executionId,
                {
                    prompt: enrichPrompt(subPrompt, this.config.memoryService, cwd),
                    cwd,
                    ...(lastSessionId ? {sessionId: lastSessionId} : {}),
                    maxTurns: 50,
                },
                {
                    workspacePath: cwd,
                    signal: controller.signal,
                    onOutput: this.makeOutputHandler(executionId),
                    onPermissionRequest: this.makePermissionHandler(executionId),
                },
                `子任务「${sub.title}」`,
            );

            if (result.sessionId) lastSessionId = result.sessionId;

            // 子任务边界：收尾该子任务内的 tool steps，避免残留 running 步骤
            await this.finalizeSteps(executionId, result.exitCode === 0 ? 'completed' : 'failed');

            if (result.aborted) {
                overall = 'aborted';
                await this.store.updateSubTask(executionId, sub.id, {
                    status: 'failed',
                    // 「立即处理」中断不是用户放弃：文案区分开，避免历史详情里误读
                    error: this.interruptFlags.has(executionId) ? '已中断（立即处理排队消息）' : '已中止',
                    completedAt: new Date().toISOString(),
                }).catch(() => undefined);
                broadcast({
                    type: 'agent-execution:subtask',
                    data: {executionId, subTaskId: sub.id, title: sub.title, status: 'failed'},
                });
                break;
            }

            if (result.exitCode === 0) {
                await this.store.updateSubTask(executionId, sub.id, {
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                    output: (result.stdout || '').slice(0, 500),
                }).catch(() => undefined);
                broadcast({
                    type: 'agent-execution:subtask',
                    data: {executionId, subTaskId: sub.id, title: sub.title, status: 'completed'},
                });
            } else {
                overall = 'failed';
                const errMsg = result.stderr || '未知错误';
                await this.store.updateSubTask(executionId, sub.id, {
                    status: 'failed',
                    error: errMsg.slice(0, 500),
                    completedAt: new Date().toISOString(),
                }).catch(() => undefined);
                broadcast({
                    type: 'agent-execution:subtask',
                    data: {executionId, subTaskId: sub.id, title: sub.title, status: 'failed'},
                });
                await this.store.addLog(executionId, `子任务「${sub.title}」执行失败（退出码 ${result.exitCode}）: ${errMsg}`).catch(() => undefined);
                break;
            }
        }

        // 剩余 pending 子任务标记 skipped + 持久化最后一个 sessionId 供续接
        const latest = await this.store.get(executionId);
        if (latest) {
            for (const r of latest.subTasks) {
                if (r.status === 'pending') {
                    await this.store.updateSubTask(executionId, r.id, {status: 'skipped'}).catch(() => undefined);
                }
            }
            if (lastSessionId && latest.sessionId !== lastSessionId) {
                latest.sessionId = lastSessionId;
                latest.sessionEngine = this.config.cliRunner.getActiveEngineId();
                await this.store.updateFull(latest).catch(() => undefined);
            }
        }

        // 终态
        await this.finalizeSteps(executionId, overall);
        // 最终答复显性化（failed 不写：错误信息已由 error 行表达）
        if (overall !== 'failed') await this.appendFinalAssistantLog(executionId);
        if (overall === 'aborted' && this.interruptFlags.has(executionId)) {
            // 「立即处理」中断：非终态——不落状态/广播/「执行已中止」日志，
            // 外层循环马上带排队消息续跑（全程保持 running）
            return overall;
        }
        await this.store.updateStatus(executionId, overall);
        this.broadcastStatus(executionId, overall);
        this.broadcastComplete(executionId, overall);
        if (overall === 'aborted') {
            await this.store.addLog(executionId, '执行已中止').catch(() => undefined);
        }
        return overall;
    }

    /**
     * 解析本次运行可用的会话指针 + 需要延续的上下文。
     *
     * 会话实体由各引擎自己托管（claude 的项目目录 jsonl、pi 的会话文件、codex 的 thread），
     * 因此：① 换引擎后旧 id 在新引擎里必然不存在（正是「pi 会话不存在或已失效」的来源）；
     * ② 同引擎也可能失效（会话文件被删、工作区变了、codex 服务重启）。
     *
     * 两种情况都不再把无效 id 传下去静默开新会话，而是：明确提示 + 用应用侧保存的
     * 对话日志生成摘要注入本轮 prompt，让工作上下文得以延续（应用托管跨引擎连续性）。
     *
     * @param execution - 执行记录
     * @param cwd - 本次运行的工作区
     * @returns 可用 sessionId（可续接时）、提示文案与上下文摘要（不可续接时）
     */
    private async resolveSessionForRun(
        execution: AgentExecution,
        cwd: string,
    ): Promise<{sessionId?: string; notice?: string; transcript?: string}> {
        const sessionId = execution.sessionId;
        if (!sessionId) return {};

        const engineId = this.config.cliRunner.getActiveEngineId();
        const owner = execution.sessionEngine;
        const engineChanged = !!owner && owner !== engineId;
        const canResume = engineChanged
            ? false
            : await this.config.cliRunner.canResumeSession(sessionId, cwd).catch(() => true);
        if (canResume) return {sessionId};

        const reason = engineChanged
            ? `上次会话属于 ${owner} 引擎，当前引擎为 ${engineId}，无法直接续接`
            : `上次会话（${engineId}：${sessionId}）已无法续接（会话文件不存在或工作区已变更）`;
        const transcript = buildTranscript(execution.logs, AgentCoordinator.CONTINUITY_TRANSCRIPT_CHARS);
        return {
            notice: `⚠ ${reason}：已用此前对话摘要开启新会话（历史记录不丢失，上下文以摘要带入）。`,
            transcript: transcript.trim() ? transcript : undefined,
        };
    }

    /** 跨引擎/会话失效续接时注入 prompt 的上下文块 */

    /** 把续接提示写入执行日志并广播（用户在消息流里能直接看到原因） */
    private async announceSessionNotice(executionId: string, notice?: string): Promise<void> {
        if (!notice) return;
        await this.store.addLog(executionId, notice).catch(() => undefined);
        this.broadcastLog(executionId, notice);
    }

    /**
     * 调一次引擎；若因**单轮步数上限**（引擎 maxTurns）停止，则带着同一会话自动续跑下一批。
     *
     * 背景：Claude 侧 `maxTurns` 打满时 SDK 返回 `error_max_turns`，此前被当成硬失败
     * （用户看到「执行失败（退出码 1）: SDK error: error_max_turns | no detail」），
     * 长任务因此半途而废。该状态**不是失败**：会话已持久化，续跑就是让 agent 接着干。
     *
     * @param label - 日志前缀（区分单次执行 / 子任务）
     * @returns 最后一次运行结果；批次上限仍打满时返回带明确说明的失败结果
     */
    private async runBridgeWithTurnContinuation(
        executionId: string,
        input: Parameters<CLIRunnerService['runBridge']>[0],
        options: Parameters<CLIRunnerService['runBridge']>[1],
        label = '执行',
    ): Promise<CLIExecutionResult> {
        let result = await this.config.cliRunner.runBridge(input, options);
        let batch = 1;
        while (result.maxTurnsReached && batch < AgentCoordinator.MAX_TURN_BATCHES && !options?.signal?.aborted) {
            batch += 1;
            const notice = `⏭ ${label}已达单轮步数上限（${result.turnsUsed ?? '上限'} 轮），自动继续第 ${batch} 批（会话已续接，不会从头上重来）`;
            await this.store.addLog(executionId, notice).catch(() => undefined);
            this.broadcastLog(executionId, notice);
            result = await this.config.cliRunner.runBridge(
                {...input, ...(result.sessionId ? {sessionId: result.sessionId} : {})},
                options,
            );
        }
        if (result.maxTurnsReached) {
            const notice = `⚠ 连续 ${batch} 批都达到单轮步数上限，已停止。任务可能过大：建议拆分需求，或再次点执行继续（会话上下文仍在）。`;
            await this.store.addLog(executionId, notice).catch(() => undefined);
            this.broadcastLog(executionId, notice);
            return {...result, exitCode: 1, stderr: notice};
        }
        return result;
    }

    /**
     * 单次执行模式（未分解或分解失败降级）：保留旧行为。
     * 聊天附件块注入用户回复文本：有回复时追加到最后一条，无回复时补一条合成说明，
     * 保证三个 prompt 组装分支（续接/合并需求/首次）都能看到附件。
     */
    private async runSingleShot(
        executionId: string,
        execution: AgentExecution,
        cwd: string,
        controller: AbortController,
        userReplies: string[],
        pendingDocs: StoredAttachment[] = [],
    ): Promise<'completed' | 'failed' | 'aborted'> {
        if (pendingDocs.length > 0) {
            const block = formatAttachmentsBlock(pendingDocs);
            if (userReplies.length > 0) {
                userReplies[userReplies.length - 1] += block;
            } else {
                userReplies.push(`（已附加文档，请查阅附件内容）${block}`);
            }
        }

        let prompt: string;
        const session = await this.resolveSessionForRun(execution, cwd);
        await this.announceSessionNotice(executionId, session.notice);
        if (userReplies.length > 0 && session.sessionId) {
            // 续接会话：带上用户补充信息
            const repliesText = userReplies.map(r => `- ${r}`).join('\n');
            prompt = renderPrompt(PROMPTS.agentReply, {repliesText});
        } else if (userReplies.length > 0 && !session.sessionId) {
            // 首次执行但用户已在回复框补充了详细信息 → 合并到 requirementText
            const repliesText = userReplies.join('\n');
            const fullRequirement = execution.requirementText + '\n\n用户补充说明：\n' + repliesText;
            prompt = renderPrompt(PROMPTS.agentStart, {requirementText: fullRequirement, cwd});
        } else {
            // 首次执行
            prompt = renderPrompt(PROMPTS.agentStart, {requirementText: execution.requirementText, cwd});
        }
        // 会话无法续接（换引擎/会话失效）：把此前对话摘要带进本轮，避免上下文完全丢失
        if (session.transcript) prompt += continuityBlock(session.transcript);

        const result = await this.runBridgeWithTurnContinuation(
            executionId,
            {
                prompt,
                cwd,
                ...(session.sessionId ? {sessionId: session.sessionId} : {}),
                maxTurns: 50,
            },
            {
                workspacePath: cwd,
                signal: controller.signal,
                onOutput: this.makeOutputHandler(executionId),
                onPermissionRequest: this.makePermissionHandler(executionId),
            },
        );

        // 保存会话指针 + 产生它的引擎（下次据此判断能否续接）
        if (result.sessionId) {
            const exec = await this.store.get(executionId);
            if (exec) {
                exec.sessionId = result.sessionId;
                exec.sessionEngine = this.config.cliRunner.getActiveEngineId();
                await this.store.updateFull(exec);
            }
        }

        if (result.aborted) {
            await this.finalizeSteps(executionId, 'aborted');
            // 中断前若已产出叙述内容（正文/思考），同样提升为答复行保留
            await this.appendFinalAssistantLog(executionId);
            if (this.interruptFlags.has(executionId)) {
                // 「立即处理」中断：非终态——不落 aborted 状态/广播/complete，
                // 外层循环马上带排队消息续跑（全程保持 running，前端不闪「已中止」）
                return 'aborted';
            }
            await this.store.updateStatus(executionId, 'aborted');
            this.broadcastStatus(executionId, 'aborted');
            this.broadcastComplete(executionId, 'aborted');
            return 'aborted';
        } else if (result.exitCode === 0) {
            await this.finalizeSteps(executionId, 'completed');
            // 最终答复显性化：把最后一段叙述（正文/思考中更晚者）写成 assistant 行
            await this.appendFinalAssistantLog(executionId);
            await this.store.updateStatus(executionId, 'completed');
            this.broadcastStatus(executionId, 'completed');
            this.broadcastComplete(executionId, 'completed');
            return 'completed';
        } else {
            await this.finalizeSteps(executionId, 'failed');
            await this.store.updateStatus(executionId, 'failed');
            const errMsg = result.stderr || `未知错误`;
            await this.store.addLog(executionId, `执行失败（退出码 ${result.exitCode}）: ${errMsg}`);
            this.broadcastStatus(executionId, 'failed');
            this.broadcastComplete(executionId, 'failed');
            return 'failed';
        }
    }

    abort(executionId: string): void {
        const controller = this.abortControllers.get(executionId);
        if (controller) controller.abort();
        // 中止时拒绝该执行所有挂起的权限请求，避免 bridge query 永久挂起
        this.denyPendingPermissions(executionId, '执行已中止');
        // 被中止的在飞工具不会再有结果：立刻收敛，工具行停止转圈并显示「已中断」
        this.settlePendingToolCalls(executionId, 'interrupted').catch(err => {
            console.error(`[coordinator] settle aborted tools failed:`, err);
        });
    }

    /**
     * 处理工具权限请求：命中白名单直接放行，否则广播给前端等待用户确认
     */
    private handlePermissionRequest(executionId: string, meta: Record<string, unknown>): void {
        const permissionRequestId = meta.permissionRequestId as string;
        const toolName = meta.toolName as string;
        if (!permissionRequestId) return;

        // 白名单命中（本次执行内「允许并记住」过的同类工具）：直接放行，不打扰用户
        const allowed = this.allowedTools.get(executionId);
        if (allowed && toolName && allowed.has(toolName)) {
            this.config.cliRunner.confirmPermission(permissionRequestId, 'allow');
            return;
        }

        this.pendingPermissions.set(permissionRequestId, {executionId, toolName});

        // 记录日志 + 广播给前端弹确认框
        this.store.addLog(executionId, `⏸ 等待确认工具：${toolName}`).catch(() => undefined);
        broadcast({
            type: 'agent-execution:permission_request',
            data: {executionId, ...meta},
        });
    }

    /**
     * 用户确认工具权限：remember 入白名单，反向回传决策给 bridge
     */
    async confirmTool(
        executionId: string,
        permissionRequestId: string,
        decision: 'allow' | 'deny',
        remember?: boolean,
        modifiedInput?: Record<string, unknown>,
    ): Promise<void> {
        const pending = this.pendingPermissions.get(permissionRequestId);
        if (!pending || pending.executionId !== executionId) return;

        // 「允许并记住」：加入本次执行白名单，后续同类工具自动放行
        if (decision === 'allow' && remember && pending.toolName) {
            const allowed = this.allowedTools.get(executionId) ?? new Set<string>();
            allowed.add(pending.toolName);
            this.allowedTools.set(executionId, allowed);
        }

        this.pendingPermissions.delete(permissionRequestId);
        this.config.cliRunner.confirmPermission(permissionRequestId, decision, undefined, modifiedInput);

        const verb = decision === 'allow' ? '已允许' : '已拒绝';
        await this.store.addLog(executionId, `${verb}工具：${pending.toolName}`).catch(() => undefined);
        this.broadcastLog(executionId, `${verb}工具：${pending.toolName}`);
    }

    /**
     * 拒绝某执行所有挂起的权限请求（abort / 终态时清理）
     */
    private denyPendingPermissions(executionId: string, message: string): void {
        for (const [permissionRequestId, pending] of this.pendingPermissions) {
            if (pending.executionId === executionId) {
                this.pendingPermissions.delete(permissionRequestId);
                this.config.cliRunner.confirmPermission(permissionRequestId, 'deny', message);
            }
        }
    }

    /**
     * 处理 thinking 事件 → 写 thoughts + 广播
     */
    private async handleThinking(executionId: string, content: string): Promise<void> {
        const display = content.length > 2000
            ? content.slice(0, 2000) + '...'
            : content;

        await this.store.addThought(executionId, {
            type: 'analysis',
            content: display,
            timestamp: new Date().toISOString(),
        });

        broadcast({
            type: 'agent-execution:thought',
            data: {
                executionId,
                thought: {
                    type: 'analysis',
                    content: display,
                    timestamp: new Date().toISOString(),
                },
            },
        });
    }

    /**
     * 处理 tool_use 事件 → 写操作工具创建 step + 广播，读操作只广播日志
     */
    private async handleToolUse(executionId: string, meta: Record<string, unknown>): Promise<void> {
        const toolName = meta.toolName as string || 'Tool';
        const toolUseId = meta.toolUseId as string || randomUUID();
        const toolInput = meta.toolInput as Record<string, unknown>;

        const execution = await this.store.get(executionId);
        if (!execution) return;

        // 避免重复（tool_use_id 去重）
        if (execution.steps.some(s => s.id === toolUseId)) return;

        // 只有写类/Shell/任务类工具才创建独立步骤，读操作（Read/Glob/Grep 等）不创建
        if (!isStepWorthyTool(toolName)) return;

        await this.store.updateSteps(executionId, [
            ...execution.steps,
            {
                id: toolUseId,
                title: toolName,
                status: 'running',
                startedAt: new Date().toISOString(),
                logs: toolInput ? [JSON.stringify(toolInput).slice(0, 500)] : [],
            },
        ]);

        broadcast({
            type: 'agent-execution:subtask',
            data: {
                executionId,
                subTaskId: toolUseId,
                title: toolName,
                status: 'running',
            },
        });
    }

    /**
     * 处理 tool_result 事件 → 标记 step completed/failed + 广播。
     * @param content - 工具结果内容（来自 onOutput 的 data 参数，providers 将内容放在 data 而非 meta）
     */
    private async handleToolResult(executionId: string, meta: Record<string, unknown>, content?: string): Promise<void> {
        const toolUseId = meta.toolUseId as string;
        const isError = meta.isError as boolean;

        if (!toolUseId) return;

        const execution = await this.store.get(executionId);
        if (!execution) return;

        const stepIdx = execution.steps.findIndex(s => s.id === toolUseId);
        if (stepIdx < 0) return;

        const step = execution.steps[stepIdx];
        step.status = isError ? 'failed' : 'completed';
        step.completedAt = new Date().toISOString();
        execution.steps[stepIdx] = step;
        await this.store.updateSteps(executionId, execution.steps);

        broadcast({
            type: 'agent-execution:subtask',
            data: {
                executionId,
                subTaskId: toolUseId,
                title: step.title,
                status: isError ? 'failed' : 'completed',
                completedAt: step.completedAt,
            },
        });

        // 步骤级日志：将工具执行结果摘要通过 stepLog 事件推送，前端展开步骤面板可查看。
        // 优先取 onOutput 的内容参数（data），兜底取 meta.content（兼容 provider 把内容放 meta 的实现）。
        // 内容可能是结构化数组（Claude API content blocks）→ 抽取其中的文本块拼成摘要。
        const raw = extractToolResultText(content) || extractToolResultText(meta.content);
        if (raw) {
            broadcast({
                type: 'agent-execution:stepLog',
                data: {
                    executionId,
                    stepId: toolUseId,
                    log: raw.slice(0, 300),
                    isError,
                },
            });
        }
    }

    /**
     * 执行结束后，将所有仍为 running 的步骤标记为终态，防止前端永久转圈
     */
    private async finalizeSteps(executionId: string, terminalStatus: 'completed' | 'failed' | 'aborted'): Promise<void> {
        const execution = await this.store.get(executionId);
        if (!execution) return;

        const now = new Date().toISOString();
        const changed = execution.steps.some(s => s.status === 'running');
        if (!changed) return;

        execution.steps.forEach(s => {
            if (s.status === 'running') {
                s.status = terminalStatus === 'completed' ? 'completed' : 'failed';
                s.completedAt = now;
            }
        });
        await this.store.updateSteps(executionId, execution.steps);

        // 广播 finalized steps，确保前端看到 step 终态
        for (const s of execution.steps) {
            broadcast({
                type: 'agent-execution:subtask',
                data: {executionId, subTaskId: s.id, title: s.title, status: s.status},
            });
        }
    }

    private broadcastStatus(executionId: string, status: string): void {
        broadcast({type: 'agent-execution:status', data: {executionId, status}});
    }

    /**
     * 广播 Agent 执行终态事件（供 AnalyticsService 消费，为技能沉淀提供素材）。
     * workspacePath 从 store 反查，catch 分支也能取到。
     */
    private broadcastComplete(executionId: string, status: string): void {
        void this.store.get(executionId).then((execution) => {
            const workspacePath = execution?.workspacePath || this.config.workspacePath || process.cwd();
            broadcast({type: 'agent-execution:complete', data: {executionId, status, workspacePath}});
        });
    }

    private broadcastLog(executionId: string, log: string): void {
        broadcast({type: 'agent-execution:log', data: {executionId, log}});
    }
}

export function createAgentCoordinator(config: CoordinatorConfig): AgentCoordinator {
    return new AgentCoordinator(config);
}
