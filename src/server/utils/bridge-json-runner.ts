/**
 * @module bridge-json-runner
 * @description 调用 CLI Bridge 并要求结构化 JSON 输出的封装（注入式，避免循环依赖）。
 *
 * 流程：runBridge → 累积 stdout（provider 已把 output+thinking 都累进 result.stdout）
 * → extractJsonValue → validateShape → 校验失败把错误列表拼回 prompt 重试（默认 2 次）。
 *
 * 调用方注意：validator 校验失败时返回 ok:false 但带完整 raw，
 * 可自行用 raw 做 markdown 表格等兜底解析（见 plan.ts export-tasks）。
 */

import type {CLIRunnerService} from '../services/cli-runner-service.js';
import type {McpServerMap} from '../services/cli-providers/types.js';
import {extractJsonValue} from './structured-json.js';
import type {ValidationResult} from './json-validator.js';

export interface RunBridgeJsonOptions<T = unknown> {
    /** CLIRunnerService 实例（注入，不 import 服务） */
    cliRunner: CLIRunnerService;
    /** 已 render + enrich 的 prompt */
    prompt: string;
    cwd: string;
    sessionId?: string;
    skills?: string[] | 'all';
    mcpServers?: McpServerMap;
    /** 中止信号（透传给 runBridge，abort 时不再重试） */
    signal?: AbortSignal;
    /** 单次最大轮数，默认 20 */
    maxTurns?: number;
    /** 校验失败重试次数，默认 2；0 = 不重试 */
    maxRetries?: number;
    /** 单次调用超时（毫秒），默认 30 分钟 */
    timeoutMs?: number;
    /** 结构化输出校验器 */
    validator: (value: unknown) => ValidationResult;
    /** 透传进度（同 runBridge 的 onOutput） */
    onOutput?: (data: string, meta?: Record<string, unknown>) => void;
}

export interface RunBridgeJsonResult<T = unknown> {
    ok: boolean;
    /** 校验通过的数据 */
    data?: T;
    /** 完整累积输出（调用方可用 fallback 解析） */
    raw: string;
    /** 实际尝试次数（含重试） */
    attempts: number;
    /** 保留 session 续接 */
    bridgeSessionId?: string;
    /** 校验失败时的错误列表 */
    validationErrors?: string[];
    /** 失败原因 */
    error?: string;
}

/** 未解析出 JSON 时的纠错提示 */
const NO_JSON_FEEDBACK = '\n\n输出必须是可解析的 JSON，不要包含多余解释。请重新输出。';

/** 校验失败时的纠错提示（前缀，后接错误列表） */
const VALIDATION_FEEDBACK_HEADER = '\n\n输出校验失败：\n- ';

/**
 * 「无输出才超时」看门狗：定时器由输出活动重置——只要引擎还在产出
 * （文本 / 思考 / 工具事件，经 onOutput 到达），就永远不到点；
 * 只有真正沉寂满 ms（疑似卡死）才中止底层 bridge 并以明确错误拒绝。
 *
 * 取代旧的绝对定时器（Promise.race + 30 分钟 reject）的两个缺陷：
 * ① 健康长任务到点被无脑杀掉（用户报「正常执行就断了」）；
 * ② reject 后底层 bridge 仍在跑（进程泄漏）。
 * 现在到点时先 abort 内部信号（真正停掉 bridge），再拒绝。
 *
 * @param ms - 无输出容忍时长（毫秒）
 * @param label - 错误信息前缀（如 '计划生成'）
 * @param callerSignal - 调用方中止信号（内部信号联动：调用方 abort → 底层 bridge 立即停）
 * @param callerOnOutput - 调用方进度回调（活动重置后原样透传）
 * @param run - 发起 bridge 调用；接收（内部 signal, 已包装活动的 onOutput）
 */
export function withOutputTimeout<T>(
    ms: number,
    label: string,
    callerSignal: AbortSignal | undefined,
    callerOnOutput: ((data: string, meta?: Record<string, unknown>) => void) | undefined,
    run: (signal: AbortSignal, onOutput: (data: string, meta?: Record<string, unknown>) => void) => Promise<T>,
): Promise<T> {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, {once: true});

    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectWatchdog: ((reason: Error) => void) | undefined;
    const watchdog = new Promise<never>((_, reject) => {
        rejectWatchdog = reject;
    });
    const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            controller.abort();
            rejectWatchdog?.(new Error(`${label}：已 ${Math.round(ms / 60_000)} 分钟无任何输出（疑似卡死），已自动中止。可重试；若任务确实需要更长无输出时间请在设置中调整`));
        }, ms);
    };

    arm();
    return Promise.race([
        run(controller.signal, (data, meta) => {
            arm();
            callerOnOutput?.(data, meta);
        }),
        watchdog,
    ]).finally(() => {
        if (timer) clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
    });
}

/**
 * 运行一次结构化 JSON 输出请求（含校验失败自动重试）。
 */
export async function runBridgeJson<T>(opts: RunBridgeJsonOptions<T>): Promise<RunBridgeJsonResult<T>> {
    const maxRetries = opts.maxRetries ?? 2;
    const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
    let attemptPrompt = opts.prompt;
    let lastErrors: string[] | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let result;
        try {
            result = await withOutputTimeout(
                timeoutMs,
                'Bridge 调用',
                opts.signal,
                opts.onOutput,
                (signal, onOutput) =>
                    opts.cliRunner.runBridge(
                        {
                            prompt: attemptPrompt,
                            cwd: opts.cwd,
                            sessionId: opts.sessionId,
                            maxTurns: opts.maxTurns ?? 20,
                            skills: opts.skills,
                            mcpServers: opts.mcpServers,
                        },
                        {
                            workspacePath: opts.cwd,
                            signal,
                            onOutput,
                        },
                    ),
            );
        } catch (err) {
            return {
                ok: false,
                raw: '',
                attempts: attempt + 1,
                bridgeSessionId: opts.sessionId,
                error: err instanceof Error ? err.message : String(err),
            };
        }

        const raw = result.stdout ?? '';
        if (result.aborted) {
            return {ok: false, raw, attempts: attempt + 1, bridgeSessionId: result.sessionId, error: 'aborted'};
        }

        const value = extractJsonValue(raw);
        if (value === undefined) {
            if (attempt < maxRetries) {
                attemptPrompt += NO_JSON_FEEDBACK;
                continue;
            }
            return {
                ok: false, raw, attempts: attempt + 1, bridgeSessionId: result.sessionId,
                error: '未从输出中解析出 JSON',
            };
        }

        const vr = opts.validator(value);
        if (vr.ok) {
            return {ok: true, data: value as T, raw, attempts: attempt + 1, bridgeSessionId: result.sessionId};
        }
        lastErrors = vr.errors;
        if (attempt < maxRetries) {
            attemptPrompt += VALIDATION_FEEDBACK_HEADER + vr.errors.join('\n- ') + '\n\n请修正后重新输出完整 JSON。';
            continue;
        }
        return {
            ok: false, raw, attempts: attempt + 1, bridgeSessionId: result.sessionId,
            validationErrors: vr.errors, error: '校验失败',
        };
    }

    // 不可达（循环内必有 return）
    return {ok: false, raw: '', attempts: 0, validationErrors: lastErrors, error: '未知错误'};
}
