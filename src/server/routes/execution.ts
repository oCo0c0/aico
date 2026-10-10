/**
 * @file 执行管理路由模块
 * @module routes/execution
 * @description 提供执行（Execution）相关的 RESTful API 路由，涵盖：
 *              - 基于开发计划启动代码执行（通过 Claude CLI 桥接）
 *              - 执行过程的暂停、中止、重试当前步骤、跳过当前步骤
 *              - 执行状态查看与日志获取
 *              - 执行过程中的多轮对话回复支持
 *              - 执行完成后自动触发测试阶段（根据 Pipeline 配置）
 *              - 执行数据同时存储在内存（活跃执行）和文件持久化层
 */

import {Router} from 'express';
import crypto from 'crypto';
import os from 'os';
import {CLIRunnerService} from '../services/cli-runner-service.js';
import {PipelineService} from '../services/pipeline-service.js';
import {TestExecutorService} from '../services/test-executor-service.js';
import {validateBody, validateWorkspacePath} from '../middleware/validation.js';
import {broadcast, type WSMessage} from '../websocket.js';
import {getPlanStore} from './plan.js';
import {PlanStoreService} from '../services/plan-store-service.js';
import {getPhaseSkills} from '../utils/skill-utils.js';
import type {MemoryService} from '../services/memory/memory-service.js';
import {enrichPrompt} from '../utils/prompt-enrichment.js';
import {renderPrompt} from '../utils/prompt-renderer.js';
import {PROMPTS} from '../prompts';
import {ExecutionStoreService, type PersistedExecution} from '../services/execution-store-service.js';
import {TestStoreService, type PersistedTestRun} from '../services/test-store-service.js';
import {RequirementStoreService} from '../services/requirement-store-service.js';
import type {StoredPlan} from './plan.js';
import {getErrorMessage} from '../utils/error-utils.js';
import {processToolOutput} from '../utils/tool-log.js';
import type {SandboxService} from '../services/sandbox-service.js';
import type {WorkspaceService} from '../services/workspace-service.js';
import type {AttachmentStore} from '../services/attachment-store.js';
import {formatAttachmentsBlock} from '../services/attachment-store.js';
import type {TestStrategyConfig} from '../services/pipeline-service.js';

/**
 * 活跃执行的内存数据结构。
 * 与持久化格式（PersistedExecution）相比，额外包含 AbortController 用于中止操作。
 * @interface StoredExecution
 */
interface StoredExecution {
    /** 执行任务的唯一标识符 */
    id: string;
    /** 关联的开发计划ID */
    planId: string;
    /** 关联需求ID */
    requirementId: string;
    /** 执行状态 */
    status: 'running' | 'paused' | 'completed' | 'failed' | 'aborted' | 'waiting_skill_confirm';
    /** 当前执行到的步骤索引 */
    currentStep: number;
    /** 总步骤数 */
    totalSteps: number;
    /** 执行开始时间（ISO 8601 格式） */
    startedAt: string;
    /** 执行完成时间（ISO 8601 格式，未完成时为 undefined） */
    completedAt?: string;
    /** 执行过程中的日志输出数组 */
    logs: string[];
    /** Claude 会话ID，用于多轮对话的上下文连续性 */
    sessionId?: string;
    /** 工作区路径 */
    workspacePath?: string;
    /** 中止控制器，用于向 CLI 运行器发送中止信号 */
    abortController?: AbortController;
    /** 待执行技能队列（顺序敏感） */
    pendingSkills?: string[];
    /** 已执行完成的技能列表 */
    executedSkills?: string[];
    /** 当前执行中的技能名 */
    currentSkill?: string;
}

/**
 * 活跃执行的内存存储 Map。
 * 键为执行ID，值为执行状态对象。
 * 服务重启后该存储会清空，持久化数据需从 ExecutionStoreService 读取。
 */
const executionStore = new Map<string, StoredExecution>();

/**
 * 将内存中的执行对象转换为持久化格式。
 * 移除不可序列化的 AbortController 字段。
 * @param exec - 内存中的执行对象
 * @returns 可持久化的执行数据对象
 */
function toPersisted(exec: StoredExecution): PersistedExecution {
    return {
        id: exec.id,
        planId: exec.planId,
        requirementId: exec.requirementId,
        status: exec.status,
        currentStep: exec.currentStep,
        totalSteps: exec.totalSteps,
        startedAt: exec.startedAt,
        completedAt: exec.completedAt,
        logs: exec.logs,
        sessionId: exec.sessionId,
        workspacePath: exec.workspacePath,
        pendingSkills: exec.pendingSkills,
        executedSkills: exec.executedSkills,
        currentSkill: exec.currentSkill,
    };
}

/**
 * 统一处理 runBridge 返回结果：保存 sessionId、判定终态、持久化、广播。
 * 多处调用点复用（/start、/retry-step、/skip-step、/reply）。
 */
function finalizeRunResult(
    execution: StoredExecution,
    result: { sessionId?: string; aborted?: boolean; exitCode?: number | null },
    persistStore: ExecutionStoreService,
    broadcastFn: (msg: WSMessage) => void,
): void {
    if (result.sessionId) execution.sessionId = result.sessionId;
    const curStatus = execution.status as string;
    if (result.aborted && curStatus !== 'paused') {
        execution.status = 'aborted';
    } else if (curStatus !== 'paused') {
        execution.status = result.exitCode === 0 ? 'completed' : 'failed';
    }
    if ((execution.status as string) !== 'paused') {
        execution.completedAt = new Date().toISOString();
    }
    persistStore.upsert(toPersisted(execution));
    broadcastFn({type: 'execution:complete', data: {executionId: execution.id, status: execution.status, workspacePath: execution.workspacePath}});
}

/** 执行路由依赖的 service 集合 */
interface ExecutionRouteServices {
    cliRunnerService: CLIRunnerService;
    memoryService?: MemoryService;
    pipelineService?: PipelineService;
    testExecutorService?: TestExecutorService;
    testPersistStore: TestStoreService;
    sandboxService?: SandboxService;
}

/**
 * 构造执行日志的 onOutput 回调：对工具调用摘要化后写入 logs 并广播 execution:output。
 * 避免把 Read 等工具结果全文灌入执行日志（与计划页一致的精简策略）。
 */
function makeExecutionOutputHandler(execution: StoredExecution) {
    return (data: string, meta?: Record<string, unknown>): void => {
        const {silent, text} = processToolOutput(data, meta);
        if (silent) return;
        execution.logs.push(text);
        broadcast({
            type: 'execution:output',
            data: {executionId: execution.id, stepIndex: execution.currentStep, content: text}
        });
    };
}

/**
 * 构造 runNextExecutionSkill 的 args 对象（prompt + onOutput + 各 service）。
 * continue-skill / skip-skill 共用。
 */
function buildSkillArgs(
    execution: StoredExecution,
    plan: StoredPlan,
    services: ExecutionRouteServices,
): ExecutionRouteServices & { prompt: string; onOutput: (data: string, meta?: Record<string, unknown>) => void } {
    const prompt = enrichPrompt(plan.rawOutput ?? plan.summary ?? '', services.memoryService, execution.workspacePath || process.cwd());
    const onOutput = makeExecutionOutputHandler(execution);
    return {...services, prompt, onOutput};
}

/**
 * 创建执行管理路由
 * @param cliRunnerService - CLI 运行器服务实例，用于调用 Claude CLI 执行代码
 * @param pipelineService - 可选的流水线服务实例，用于解析执行阶段的技能和测试配置
 * @param testExecutorService - 可选的测试执行器服务实例，用于执行完成后自动运行测试
 * @param memoryService
 * @param sandboxService
 * @param workspaceService
 * @returns 配置好的 Express Router 实例
 *
 * @example
 * ```ts
 * const router = createExecutionRoutes(cliRunner, pipelineService, testExecutor);
 * app.use('/api/execution', router);
 * ```
 */
export function createExecutionRoutes(
    cliRunnerService: CLIRunnerService,
    pipelineService?: PipelineService,
    testExecutorService?: TestExecutorService,
    memoryService?: MemoryService,
    sandboxService?: SandboxService,
    workspaceService?: WorkspaceService,
    attachmentStore?: AttachmentStore,
): Router {
    const persistStore = new ExecutionStoreService();
    const planFileStore = new PlanStoreService();
    const testPersistStore = new TestStoreService();
    const reqStore = new RequirementStoreService();
    const router = Router();

    /**
     * GET /api/execution/list
     * @description 获取最近的执行记录列表，返回精简信息（不包含完整日志）
     * @returns {Object[]} 执行列表，每个元素包含 id、计划ID、状态、步骤进度等字段
     */
    router.get('/list', (_req, res) => {
        try {
            const planStore = getPlanStore();
            const executions = persistStore.list().map(e => {
                // 优先从内存缓存取 plan，否则从文件存储取
                let plan = planStore.get(e.planId) as StoredPlan | undefined;
                if (!plan) plan = planFileStore.get(e.planId);

                // 补数据：plan 缺 requirementTitle 时从 requirement store 查
                let reqTitle = plan?.requirementTitle;
                let reqNumber = plan?.requirementNumber;
                if (!reqTitle && plan?.requirementId) {
                    try {
                        const req = reqStore.get(plan.requirementId);
                        if (req) {
                            reqTitle = req.title;
                            reqNumber = req.number;
                        }
                    } catch { /* 补数据失败不影响列表返回 */
                    }
                }

                return {
                    id: e.id,
                    planId: e.planId,
                    requirementTitle: reqTitle,
                    requirementNumber: reqNumber,
                    status: e.status,
                    currentStep: e.currentStep,
                    totalSteps: e.totalSteps,
                    startedAt: e.startedAt,
                    completedAt: e.completedAt,
                    workspacePath: e.workspacePath,
                    logCount: e.logs.length,
                };
            });
            res.json(executions);
        } catch (err) {
            res.status(500).json({code: 'STORE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * POST /api/execution/start
     * @description 基于指定的开发计划启动代码执行。该接口为异步操作，立即返回 executionId，
     *              执行过程通过 WebSocket 广播输出日志。
     *              如果关联的 Pipeline 配置了自动测试，执行完成后会自动触发测试阶段。
     *              允许在计划状态为 'ready' 或 'generating' 时启动执行（后者处理时序问题）。
     * @param {string} planId.body - 开发计划ID（必填）
     * @returns {{ executionId: string }} 执行任务ID，用于后续查询状态和控制
     */
    router.post('/start', validateBody([
        {field: 'planId', required: true, type: 'string'},
    ]), async (req, res) => {
        const {planId} = req.body;
        let plan = getPlanStore().get(planId) as StoredPlan | undefined;
        if (!plan) plan = planFileStore.get(planId);

        if (!plan) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
            return;
        }

        // 允许计划状态为 ready、generating 或 failed（有内容可重试）时启动执行
        if (plan.status === 'failed' && !plan.rawOutput && !plan.summary) {
            res.status(400).json({code: 'INVALID_STATE', message: 'Plan has no content to execute'});
            return;
        }

        const executionId = crypto.randomUUID();
        const abortController = new AbortController();

        // 从 Pipeline 配置中解析执行阶段所需的技能列表
        let executionSkills: string[] | 'all' | undefined;
        if (plan.pipelineId && pipelineService) {
            const pipeline = pipelineService.get(plan.pipelineId);
            if (pipeline?.steps) {
                const phaseConfig = getPhaseSkills(pipeline.steps, 'execution');
                // ponytail: 过滤掉Agent模式，execution暂时不支持Agent
                executionSkills = (phaseConfig && typeof phaseConfig === 'object' && 'mode' in phaseConfig && phaseConfig.mode === 'agent')
                    ? undefined
                    : phaseConfig as string[] | 'all' | undefined;
            }
        }

        // 初始化执行对象
        const execution: StoredExecution = {
            id: executionId,
            planId,
            requirementId: plan.requirementId,
            status: 'running',
            currentStep: 0,
            totalSteps: 1,
            startedAt: new Date().toISOString(),
            logs: [],
            sessionId: plan.sessionId,
            workspacePath: plan.workspacePath,
            abortController,
        };
        executionStore.set(executionId, execution);
        persistStore.upsert(toPersisted(execution));

        // 立即返回执行ID，后续执行过程异步进行
        res.json({executionId});

        // 异步执行代码
        try {
            const onOutput = makeExecutionOutputHandler(execution);

            const prompt = enrichPrompt(plan.rawOutput ?? plan.summary ?? '', memoryService, plan.workspacePath);

            // 多技能串行执行；非数组/空数组则单次执行（兼容旧行为）
            if (Array.isArray(executionSkills) && executionSkills.length > 0) {
                execution.pendingSkills = [...executionSkills];
                execution.executedSkills = [];
                persistStore.upsert(toPersisted(execution));

                await runNextExecutionSkill(
                    execution,
                    plan,
                    {
                        cliRunnerService,
                        prompt,
                        memoryService,
                        pipelineService,
                        testExecutorService,
                        testPersistStore,
                        sandboxService,
                        onOutput
                    },
                    persistStore,
                );
            } else {
                const result = await cliRunnerService.runBridge(
                    {
                        prompt,
                        cwd: plan.workspacePath,
                        sessionId: plan.sessionId,
                        maxTurns: 50,
                        skills: executionSkills,
                    },
                    {
                        workspacePath: plan.workspacePath,
                        onOutput,
                        signal: abortController.signal,
                    }
                );

                finalizeRunResult(execution, result, persistStore, broadcast);

                if (execution.status === 'completed' && plan.pipelineId && pipelineService && testExecutorService) {
                    void triggerTestPhase(execution, plan, pipelineService, cliRunnerService, testExecutorService, testPersistStore, sandboxService, workspaceService);
                }
            }
        } catch (err) {
            execution.status = 'failed';
            execution.completedAt = new Date().toISOString();
            executionStore.set(execution.id, execution); // 同步更新内存状态
            persistStore.upsert(toPersisted(execution));
            broadcast({type: 'execution:complete', data: {executionId: execution.id, status: 'failed', workspacePath: execution.workspacePath}});
            broadcast({type: 'error', data: {message: `Execution failed: ${getErrorMessage(err)}`}});
        }
    });

    /**
     * POST /api/execution/:id/pause
     * @description 暂停正在运行的执行任务。通过 AbortController 向 CLI 发送中止信号。
     * @param {string} id.path - 执行任务ID
     * @returns {{ status: 'paused' }} 确认已暂停
     */
    router.post('/:id/pause', (req, res) => {
        let execution = executionStore.get(req.params.id);
        if (!execution) {
            const persisted = persistStore.get(req.params.id);
            if (!persisted) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
                return;
            }
            if (persisted.status !== 'running') {
                res.status(400).json({code: 'INVALID_STATE', message: 'Execution is not running'});
                return;
            }
            execution = {
                ...persisted,
                abortController: new AbortController(),
                workspacePath: persisted.workspacePath,
            };
            executionStore.set(execution.id, execution);
        }
        if (execution.status !== 'running') {
            res.status(400).json({code: 'INVALID_STATE', message: 'Execution is not running'});
            return;
        }
        execution.status = 'paused';
        execution.abortController?.abort(); // 向 CLI 进程发送中止信号
        persistStore.upsert(toPersisted(execution));
        res.json({status: 'paused'});
    });

    /**
     * POST /api/execution/:id/retry-step
     * @description 重试当前步骤。仅当执行处于"已暂停"或"已失败"状态时允许操作。
     *              如果执行不在内存中，会从持久化存储恢复并重新启动 bridge。
     * @param {string} id.path - 执行任务ID
     * @returns {{ status: 'retrying' }} 确认正在重试
     */
    router.post('/:id/retry-step', async (req, res) => {
        let execution = executionStore.get(req.params.id);

        // 内存未命中，从持久化存储恢复（服务重启后场景）
        if (!execution) {
            const persisted = persistStore.get(req.params.id);
            if (!persisted) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
                return;
            }
            if (persisted.status !== 'paused' && persisted.status !== 'failed') {
                res.status(400).json({code: 'INVALID_STATE', message: 'Execution must be paused or failed to retry'});
                return;
            }
            // 恢复到内存
            let plan = getPlanStore().get(persisted.planId) as StoredPlan | undefined;
            if (!plan) plan = planFileStore.get(persisted.planId);
            execution = {
                ...persisted,
                abortController: new AbortController(),
                workspacePath: persisted.workspacePath || plan?.workspacePath,
            };
            executionStore.set(execution.id, execution);
        } else {
            if (execution.status !== 'paused' && execution.status !== 'failed') {
                res.status(400).json({code: 'INVALID_STATE', message: 'Execution must be paused or failed to retry'});
                return;
            }
        }

        execution.status = 'running';
        execution.completedAt = undefined;
        persistStore.upsert(toPersisted(execution));
        res.json({status: 'retrying'});

        // 真正重新执行：用已有的 sessionId 继续对话
        const plan = (getPlanStore().get(execution.planId) as StoredPlan | undefined) ?? planFileStore.get(execution.planId);
        const retryPrompt = renderPrompt(PROMPTS.executionRetry, {});

        try {
            const result = await cliRunnerService.runBridge(
                {
                    prompt: enrichPrompt(retryPrompt, memoryService, execution.workspacePath || process.cwd()),
                    cwd: execution.workspacePath || process.cwd(),
                    sessionId: execution.sessionId,
                    maxTurns: 50,
                },
                {
                    workspacePath: execution.workspacePath || process.cwd(),
                    onOutput: makeExecutionOutputHandler(execution),
                    signal: execution.abortController?.signal,
                }
            );

            finalizeRunResult(execution, result, persistStore, broadcast);

            if ((execution.status as string) === 'completed' && plan?.pipelineId && pipelineService && testExecutorService) {
                void triggerTestPhase(execution, plan, pipelineService, cliRunnerService, testExecutorService, testPersistStore, sandboxService, workspaceService);
            }
        } catch (err) {
            execution.status = 'failed';
            execution.completedAt = new Date().toISOString();
            executionStore.set(execution.id, execution); // 同步更新内存状态
            persistStore.upsert(toPersisted(execution));
            broadcast({type: 'execution:complete', data: {executionId: execution.id, status: 'failed', workspacePath: execution.workspacePath}});
            broadcast({type: 'error', data: {message: `Execution retry failed: ${getErrorMessage(err)}`}});
        }
    });

    /**
     * POST /api/execution/:id/skip-step
     * @description 跳过当前步骤，步骤索引递增并恢复运行状态。
     *              仅当执行处于"已暂停"或"已失败"状态时允许操作。
     *              支持从持久化存储恢复（服务重启后场景）。
     * @param {string} id.path - 执行任务ID
     * @returns {{ status: 'skipped' }} 确认已跳过
     */
    router.post('/:id/skip-step', async (req, res) => {
        let execution = executionStore.get(req.params.id);

        // 内存未命中，从持久化存储恢复
        if (!execution) {
            const persisted = persistStore.get(req.params.id);
            if (!persisted) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
                return;
            }
            if (persisted.status !== 'paused' && persisted.status !== 'failed') {
                res.status(400).json({code: 'INVALID_STATE', message: 'Execution must be paused or failed to skip'});
                return;
            }
            execution = {
                ...persisted,
                abortController: new AbortController(),
                workspacePath: persisted.workspacePath,
            };
            executionStore.set(execution.id, execution);
        } else {
            if (execution.status !== 'paused' && execution.status !== 'failed') {
                res.status(400).json({code: 'INVALID_STATE', message: 'Execution must be paused or failed to skip'});
                return;
            }
        }

        execution.currentStep += 1;
        execution.status = 'running';
        execution.completedAt = undefined;
        persistStore.upsert(toPersisted(execution));
        res.json({status: 'skipped'});

        // 继续执行后续步骤
        const plan = (getPlanStore().get(execution.planId) as StoredPlan | undefined) ?? planFileStore.get(execution.planId);
        const continuePrompt = renderPrompt(PROMPTS.executionSkip, {});

        try {
            const result = await cliRunnerService.runBridge(
                {
                    prompt: enrichPrompt(continuePrompt, memoryService, execution.workspacePath || process.cwd()),
                    cwd: execution.workspacePath || process.cwd(),
                    sessionId: execution.sessionId,
                    maxTurns: 50,
                },
                {
                    workspacePath: execution.workspacePath || process.cwd(),
                    onOutput: makeExecutionOutputHandler(execution),
                    signal: execution.abortController?.signal,
                }
            );

            finalizeRunResult(execution, result, persistStore, broadcast);

            if ((execution.status as string) === 'completed' && plan?.pipelineId && pipelineService && testExecutorService) {
                void triggerTestPhase(execution, plan, pipelineService, cliRunnerService, testExecutorService, testPersistStore, sandboxService, workspaceService);
            }
        } catch (err) {
            execution.status = 'failed';
            execution.completedAt = new Date().toISOString();
            executionStore.set(execution.id, execution); // 同步更新内存状态
            persistStore.upsert(toPersisted(execution));
            broadcast({type: 'execution:complete', data: {executionId: execution.id, status: 'failed', workspacePath: execution.workspacePath}});
            broadcast({type: 'error', data: {message: `Execution skip-continue failed: ${getErrorMessage(err)}`}});
        }
    });

    /**
     * POST /api/execution/:id/abort
     * @description 中止执行任务，记录完成时间并通过 AbortController 终止 CLI 进程。
     * @param {string} id.path - 执行任务ID
     * @returns {{ status: 'aborted' }} 确认已中止
     */
    router.post('/:id/abort', (req, res) => {
        let execution = executionStore.get(req.params.id);
        if (!execution) {
            const persisted = persistStore.get(req.params.id);
            if (!persisted) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
                return;
            }
            execution = {
                ...persisted,
                abortController: new AbortController(),
                workspacePath: persisted.workspacePath,
            };
            executionStore.set(execution.id, execution);
        }
        execution.status = 'aborted';
        execution.completedAt = new Date().toISOString();
        execution.abortController?.abort();
        persistStore.upsert(toPersisted(execution));
        res.json({status: 'aborted'});
    });

    /**
     * GET /api/execution/:id/status
     * @description 获取执行任务的详细状态和日志。
     *              优先从内存中读取（活跃执行的最新状态），未命中时回退到持久化存储。
     * @param {string} id.path - 执行任务ID
     * @param {number} id.query.logsFrom - 可选，从第 N 条开始返回（0 起，默认尾部 200 条，兼容旧客户端）
     * @returns {Object} 执行状态详情，包含日志数组（logsFrom 时可能为全量分段）
     */
    router.get('/:id/status', (req, res) => {
        // 分段读取起点：logsFrom=N 从第 N 条起全量返回（首次加载传 0 拿全量，轮询不传走尾部窗口）
        const logsFromRaw = Number(req.query.logsFrom);
        const logsFrom = Number.isFinite(logsFromRaw) && logsFromRaw >= 0 ? Math.floor(logsFromRaw) : null;

        // 优先检查内存中的活跃执行（状态更实时）
        const active = executionStore.get(req.params.id);
        if (active) {
            const all = active.logs;
            const recentLogs = logsFrom !== null ? all.slice(logsFrom) : all.slice(-200);
            res.json({
                id: active.id,
                planId: active.planId,
                status: active.status,
                currentStep: active.currentStep,
                totalSteps: active.totalSteps,
                startedAt: active.startedAt,
                completedAt: active.completedAt,
                logs: recentLogs,
                totalLogs: all.length, // 总日志数供前端参考
            });
            return;
        }

        // 回退到持久化存储
        const persisted = persistStore.get(req.params.id);
        if (!persisted) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
            return;
        }
        const all = persisted.logs || [];
        const recentLogs = logsFrom !== null ? all.slice(logsFrom) : all.slice(-200);
        res.json({
            ...persisted,
            logs: recentLogs,
            totalLogs: all.length,
        });
    });

    /**
     * DELETE /api/execution/:id
     * @description 删除执行记录，同时清除内存缓存和持久化存储中的数据
     * @param {string} id.path - 执行任务ID
     * @returns {{ success: boolean }} 删除操作是否成功
     */
    router.delete('/:id', (req, res) => {
        executionStore.delete(req.params.id);
        const deleted = persistStore.delete(req.params.id);
        res.json({success: deleted});
    });

    /**
     * POST /api/execution/:id/reply
     * @description 在执行过程中向 Claude 发送追加消息（多轮对话）。
     *              需要执行存在活跃的会话（sessionId）才能回复。
     *              回复后执行状态恢复为 'running'，通过 WebSocket 广播输出。
     * @param {string} id.path - 执行任务ID
     * @param {string} message.body - 用户发送的消息内容（必填）
     * @returns {{ ok: boolean }} 确认消息已接收
     */
    router.post('/:id/reply', async (req, res) => {
        let execution = executionStore.get(req.params.id);

        // 内存未命中，从持久化存储恢复
        if (!execution) {
            const persisted = persistStore.get(req.params.id);
            if (!persisted) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
                return;
            }
            execution = {
                ...persisted,
                abortController: new AbortController(),
                workspacePath: persisted.workspacePath,
            };
            executionStore.set(execution.id, execution);
        }

        const {message} = req.body as { message: string };
        if (!message?.trim()) {
            res.status(400).json({code: 'VALIDATION_ERROR', message: 'message is required'});
            return;
        }

        // 聊天附件：一次性取出（取出即删），全文只拼进发给引擎的 prompt；
        // 对话日志/广播只落 stub 行
        const docs = attachmentStore?.drain((req.body?.attachmentIds ?? []) as string[]) ?? [];
        const fullMessage = message + formatAttachmentsBlock(docs);
        const attachmentStub = docs.length > 0
            ? `\n📎 已附加文档：${docs.map(d => `${d.fileName}（${d.chars} 字）`).join('、')}\n`
            : '';

        // 如果没有活跃会话（用户调用了 /new-session），创建新会话
        const isNewSession = !execution.sessionId;
        if (isNewSession) {
            console.log(`[execution] 创建新会话: executionId=${execution.id}`);
        }

        // 先确认收到请求，异步执行回复处理
        res.json({ok: true, isNewSession});

        // 重建 abortController（旧的在 pause 时已 aborted）
        execution.abortController = new AbortController();

        // 将执行状态恢复为运行中，并广播用户消息（保持原始 message，不含附件全文）
        execution.status = 'running';
        execution.logs.push(`\n**User:** ${message}\n`);
        broadcast({
            type: 'execution:output',
            data: {executionId: execution.id, stepIndex: execution.currentStep, content: `\n**User:** ${message}\n`}
        });
        if (attachmentStub) {
            execution.logs.push(attachmentStub);
            broadcast({
                type: 'execution:output',
                data: {executionId: execution.id, stepIndex: execution.currentStep, content: attachmentStub}
            });
        }

        try {
            // 继续对话：如果有 sessionId 则复用（旧会话），否则创建新会话
            const bridgeOptions: any = {
                prompt: enrichPrompt(fullMessage, memoryService, execution.workspacePath || process.cwd()),
                cwd: execution.workspacePath || process.cwd(),
                maxTurns: 50,
            };

            // 仅在有 sessionId 时传递（继续旧会话）
            if (execution.sessionId) {
                bridgeOptions.sessionId = execution.sessionId;
            }

            const result = await cliRunnerService.runBridge(bridgeOptions,
                {
                    workspacePath: execution.workspacePath || process.cwd(),
                    onOutput: makeExecutionOutputHandler(execution),
                    signal: execution.abortController?.signal,
                }
            );

            finalizeRunResult(execution, result, persistStore, broadcast);
        } catch (err) {
            execution.status = 'failed';
            execution.completedAt = new Date().toISOString();
            executionStore.set(execution.id, execution); // 同步更新内存状态
            persistStore.upsert(toPersisted(execution));
            broadcast({type: 'execution:complete', data: {executionId: execution.id, status: 'failed', workspacePath: execution.workspacePath}});
            broadcast({type: 'error', data: {message: `Execution reply failed: ${getErrorMessage(err)}`}});
        }
    });

    /**
     * POST /api/execution/:id/continue-skill
     * 确认继续执行下一个技能
     */
    router.post('/:id/continue-skill', async (req, res) => {
        const execution = executionStore.get(req.params.id);
        if (!execution) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
            return;
        }
        if (execution.status !== 'waiting_skill_confirm') {
            res.status(400).json({code: 'INVALID_STATE', message: 'Execution is not waiting for skill confirmation'});
            return;
        }
        if (!execution.pendingSkills || execution.pendingSkills.length === 0) {
            res.status(400).json({code: 'INVALID_STATE', message: 'No pending skills'});
            return;
        }

        res.json({ok: true});

        execution.abortController = new AbortController();
        const plan = (getPlanStore().get(execution.planId) as StoredPlan | undefined) ?? planFileStore.get(execution.planId);
        if (!plan) {
            execution.status = 'failed';
            persistStore.upsert(toPersisted(execution));
            return;
        }

        try {
            const args = buildSkillArgs(execution, plan, {
                cliRunnerService,
                memoryService,
                pipelineService,
                testExecutorService,
                testPersistStore,
                sandboxService
            });
            await runNextExecutionSkill(execution, plan, args, persistStore);
        } catch (err) {
            execution.status = 'failed';
            execution.completedAt = new Date().toISOString();
            executionStore.set(execution.id, execution); // 同步更新内存状态
            persistStore.upsert(toPersisted(execution));
            broadcast({type: 'execution:complete', data: {executionId: execution.id, status: 'failed', workspacePath: execution.workspacePath}});
            broadcast({type: 'error', data: {message: `Continue skill failed: ${getErrorMessage(err)}`}});
        }
    });

    /**
     * POST /api/execution/:id/skip-skill
     * 跳过下一个待执行技能
     */
    router.post('/:id/skip-skill', async (req, res) => {
        const execution = executionStore.get(req.params.id);
        if (!execution) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
            return;
        }
        if (execution.status !== 'waiting_skill_confirm') {
            res.status(400).json({code: 'INVALID_STATE', message: 'Execution is not waiting for skill confirmation'});
            return;
        }

        const skipped = execution.pendingSkills?.shift();
        if (skipped) {
            execution.executedSkills = [...(execution.executedSkills ?? []), `${skipped}(skipped)`];
        }

        if (execution.pendingSkills && execution.pendingSkills.length > 0) {
            res.json({ok: true, skipped});
            execution.abortController = new AbortController();
            const plan = (getPlanStore().get(execution.planId) as StoredPlan | undefined) ?? planFileStore.get(execution.planId);
            if (!plan) {
                execution.status = 'failed';
                persistStore.upsert(toPersisted(execution));
                return;
            }
            try {
                const args = buildSkillArgs(execution, plan, {
                    cliRunnerService,
                    memoryService,
                    pipelineService,
                    testExecutorService,
                    testPersistStore,
                    sandboxService
                });
                await runNextExecutionSkill(execution, plan, args, persistStore);
            } catch (err) {
                execution.status = 'failed';
                execution.completedAt = new Date().toISOString();
                persistStore.upsert(toPersisted(execution));
            }
        } else {
            execution.status = 'completed';
            execution.completedAt = new Date().toISOString();
            persistStore.upsert(toPersisted(execution));
            broadcast({type: 'execution:complete', data: {executionId: execution.id, status: execution.status, workspacePath: execution.workspacePath}});
            res.json({ok: true, skipped, completed: true});
        }
    });

    /**
     * POST /api/execution/:id/new-session
     * 开始新会话（保留历史显示，清空后端上下文）
     *
     * 用途：当上下文即将满时（>80%），允许用户开启新会话避免 529 错误，
     * 同时保留前端历史消息显示。
     */
    router.post('/:id/new-session', async (req, res) => {
        const execution = executionStore.get(req.params.id);

        if (!execution) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
            return;
        }

        // 清空 sessionId，下次 /reply 调用时将创建新会话
        const oldSessionId = execution.sessionId;
        execution.sessionId = undefined;

        // 持久化更新
        persistStore.upsert(toPersisted(execution));

        console.log(`[execution] 新会话: executionId=${execution.id}, oldSessionId=${oldSessionId?.slice(0, 8)}...`);

        res.json({
            ok: true,
            message: '新会话已创建，历史消息保留在页面显示中'
        });
    });

    return router;
}

/**
 * 执行队列中下一个技能。队列空 → completed。
 * 完成单个技能后进入 waiting_skill_confirm，等用户 continue-skill 触发下一个。
 */
async function runNextExecutionSkill(
    execution: StoredExecution,
    plan: StoredPlan,
    opts: {
        cliRunnerService: CLIRunnerService;
        prompt: string;
        memoryService?: MemoryService;
        pipelineService?: PipelineService;
        testExecutorService?: TestExecutorService;
        testPersistStore: TestStoreService;
        sandboxService?: SandboxService;
        onOutput: (data: string, meta?: Record<string, unknown>) => void;
    },
    persistStore: ExecutionStoreService,
): Promise<void> {
    const pending = execution.pendingSkills ?? [];

    if (pending.length === 0) {
        // 全部完成
        execution.status = 'completed';
        execution.completedAt = new Date().toISOString();
        execution.currentSkill = undefined;
        persistStore.upsert(toPersisted(execution));
        broadcast({type: 'execution:complete', data: {executionId: execution.id, status: execution.status, workspacePath: execution.workspacePath}});

        // 触发测试阶段
        if (plan.pipelineId && opts.pipelineService && opts.testExecutorService) {
            void triggerTestPhase(execution, plan, opts.pipelineService, opts.cliRunnerService, opts.testExecutorService, opts.testPersistStore, opts.sandboxService);
        }
        return;
    }

    const skill = pending[0];
    execution.pendingSkills = pending.slice(1);
    execution.currentSkill = skill;
    execution.status = 'running';
    persistStore.upsert(toPersisted(execution));

    try {
        const result = await opts.cliRunnerService.runBridge(
            {
                prompt: opts.prompt,
                cwd: execution.workspacePath || plan.workspacePath,
                sessionId: execution.sessionId,
                maxTurns: 50,
                skills: [skill],
            },
            {
                workspacePath: execution.workspacePath || plan.workspacePath,
                onOutput: opts.onOutput,
                signal: execution.abortController?.signal,
            }
        );

        if (result.sessionId) execution.sessionId = result.sessionId;

        // 当前技能完成 → 加入已执行
        execution.executedSkills = [...(execution.executedSkills ?? []), skill];
        execution.currentSkill = undefined;

        const curStatus = execution.status as string;
        // 被 pause 中止时不进 waiting
        if (curStatus === 'paused' || (result.aborted && curStatus === 'paused')) {
            persistStore.upsert(toPersisted(execution));
            return;
        }
        if (result.aborted && curStatus !== 'paused') {
            execution.status = 'aborted';
            execution.completedAt = new Date().toISOString();
            persistStore.upsert(toPersisted(execution));
            broadcast({type: 'execution:complete', data: {executionId: execution.id, status: execution.status, workspacePath: execution.workspacePath}});
            return;
        }
        if (result.exitCode !== 0) {
            execution.status = 'failed';
            execution.completedAt = new Date().toISOString();
            persistStore.upsert(toPersisted(execution));
            broadcast({type: 'execution:complete', data: {executionId: execution.id, status: execution.status, workspacePath: execution.workspacePath}});
            return;
        }

        // 还有下一个技能 → waiting_skill_confirm
        if (execution.pendingSkills && execution.pendingSkills.length > 0) {
            execution.status = 'waiting_skill_confirm';
            persistStore.upsert(toPersisted(execution));
            broadcast({
                type: 'execution:skill_complete',
                data: {
                    executionId: execution.id,
                    completedSkill: skill,
                    nextSkill: execution.pendingSkills[0],
                    pendingCount: execution.pendingSkills.length,
                },
            });
        } else {
            // 最后一个完成
            execution.status = 'completed';
            execution.completedAt = new Date().toISOString();
            persistStore.upsert(toPersisted(execution));
            broadcast({type: 'execution:complete', data: {executionId: execution.id, status: execution.status, workspacePath: execution.workspacePath}});

            if (plan.pipelineId && opts.pipelineService && opts.testExecutorService) {
                void triggerTestPhase(execution, plan, opts.pipelineService, opts.cliRunnerService, opts.testExecutorService, opts.testPersistStore, opts.sandboxService);
            }
        }
    } catch (err) {
        execution.status = 'failed';
        execution.completedAt = new Date().toISOString();
        executionStore.set(execution.id, execution); // 同步更新内存状态
        persistStore.upsert(toPersisted(execution));
        broadcast({type: 'execution:complete', data: {executionId: execution.id, status: 'failed', workspacePath: execution.workspacePath}});
        broadcast({type: 'error', data: {message: `Skill "${skill}" failed: ${getErrorMessage(err)}`}});
    }
}

/**
 * 根据流水线配置，在执行完成后自动触发测试阶段。
 * 支持两种测试模式：
 * 1. 'run_existing': 使用 TestExecutorService 运行项目中已有的测试用例
 * 2. 其他（如 AI 生成模式）: 使用 CLIRunnerService 让 Claude 分析代码变更并编写测试
 *
 * 仅当 Pipeline 配置中 testStrategy.autoRunAfterExecution 为 true 时才会触发。
 *
 * @param execution - 已完成的执行对象
 * @param plan - 关联的开发计划对象
 * @param pipelineService - 流水线服务实例，用于获取测试策略配置
 * @param cliRunnerService - CLI 运行器服务实例，用于 AI 生成测试
 * @param testExecutorService - 测试执行器服务实例，用于运行已有测试
 * @param testPersistStore - 测试持久化存储服务实例，用于保存测试结果
 * @param sandboxService - 沙箱测试接入
 * @param workspaceService - 工作区服务实例，用于获取 git 变更文件
 */
async function triggerTestPhase(
    execution: StoredExecution,
    plan: StoredPlan,
    pipelineService: PipelineService,
    cliRunnerService: CLIRunnerService,
    testExecutorService: TestExecutorService,
    testPersistStore: TestStoreService,
    sandboxService?: SandboxService,
    workspaceService?: WorkspaceService
): Promise<void> {
    const pipeline = pipelineService.get(plan.pipelineId!);
    if (!pipeline?.steps) return;

    const testStrategy = pipeline.steps.testStrategy;
    // 仅在配置了自动运行测试时触发
    if (!testStrategy.autoRunAfterExecution) return;

    const testRunId = crypto.randomUUID();
    // 从 Pipeline 配置中解析测试阶段的技能列表
    const phaseConfig = getPhaseSkills(pipeline.steps, 'test');
    // ponytail: 过滤掉Agent模式
    const testSkills = (phaseConfig && typeof phaseConfig === 'object' && 'mode' in phaseConfig && phaseConfig.mode === 'agent')
        ? undefined
        : phaseConfig as string[] | 'all' | undefined;

    // 如果配置了 changedFilesOnly，获取变更文件列表
    let changedFiles: string[] | undefined;
    if (testStrategy.changedFilesOnly && plan.workspacePath && workspaceService) {
        const wsCheck = validateWorkspacePath(plan.workspacePath, [os.homedir()]);
        if (wsCheck.valid) {
            try {
                changedFiles = await workspaceService.getChangedFiles(wsCheck.path!);
            } catch {
                changedFiles = [];
            }
        }
    }

    if (testStrategy.mode === 'run_existing') {
        // 模式一：运行已有的测试用例（支持变更文件定向测试）
        const testRun: PersistedTestRun = {
            id: testRunId,
            status: 'running',
            mode: 'pipeline_run_existing',
            framework: testStrategy.framework,
            workspacePath: plan.workspacePath,
            executionId: execution.id,
            planId: plan.id,
            pipelineId: plan.pipelineId,
            startedAt: new Date().toISOString(),
        };
        testPersistStore.upsert(testRun);
        broadcast({type: 'test:auto_start', data: {testRunId, executionId: execution.id, mode: 'run_existing'}});

        testExecutorService.runTests(
            {
                workspacePath: plan.workspacePath,
                framework: testStrategy.framework || '',
                command: testStrategy.command,
                changedFiles,
                taskId: testRunId,
                sandboxId: testStrategy.environment === 'sandbox' ? testStrategy.sandboxId : undefined,
            },
            {
                onOutput: (data) => {
                    testRun.rawOutput = (testRun.rawOutput || '') + data;
                    broadcast({type: 'test:output', data: {taskId: testRunId, content: data}});
                },
            }
        ).then((results) => {
            testRun.status = 'completed';
            testRun.results = results;
            testRun.completedAt = new Date().toISOString();
            testPersistStore.upsert(testRun);
            broadcast({type: 'test:complete', data: {taskId: testRunId, results, status: 'completed', workspacePath: execution.workspacePath}});
        }).catch((err) => {
            testRun.status = 'failed';
            testRun.error = getErrorMessage(err);
            testRun.completedAt = new Date().toISOString();
            testPersistStore.upsert(testRun);
            broadcast({type: 'error', data: {message: `Auto test run failed: ${testRun.error}`}});
        });

    } else if (testStrategy.mode === 'ai_generate_e2e') {
        // 模式三：AI 生成 Playwright E2E 测试文件，然后通过 Provider 结构化执行
        const testRun: PersistedTestRun = {
            id: testRunId,
            status: 'running',
            mode: 'pipeline_ai_generate',
            workspacePath: plan.workspacePath,
            executionId: execution.id,
            planId: plan.id,
            pipelineId: plan.pipelineId,
            startedAt: new Date().toISOString(),
        };
        testPersistStore.upsert(testRun);
        broadcast({type: 'test:auto_start', data: {testRunId, executionId: execution.id, mode: 'ai_generate_e2e'}});

        // E2E 测试生成的提示词：要求生成 Playwright 测试文件并保存到项目目录
        const e2ePrompt = renderPrompt(PROMPTS.testE2eAuto, {
            workspacePath: plan.workspacePath,
            planSummary: plan.summary || 'See previous context',
        });

        let accumulatedOutput = '';
        cliRunnerService.runBridge(
            {
                prompt: e2ePrompt,
                cwd: plan.workspacePath,
                sessionId: execution.sessionId,
                maxTurns: 30,
                skills: testSkills,
            },
            {
                workspacePath: plan.workspacePath,
                onOutput: (data) => {
                    accumulatedOutput += data;
                    testRun.rawOutput = accumulatedOutput;
                    broadcast({type: 'test:output', data: {taskId: testRunId, content: data}});
                },
            }
        ).then(async (result) => {
            // AI 生成阶段完成，标记为 completed
            testRun.status = result.exitCode === 0 ? 'completed' : 'failed';
            testRun.rawOutput = accumulatedOutput;
            testRun.completedAt = new Date().toISOString();
            if (result.exitCode !== 0) testRun.error = 'AI E2E test generation failed';
            testPersistStore.upsert(testRun);
            broadcast({
                type: 'test:complete',
                data: {taskId: testRunId, status: testRun.status, rawOutput: accumulatedOutput, workspacePath: execution.workspacePath}
            });

            // 如果生成成功，自动触发 Playwright Provider 执行生成的测试文件
            if (result.exitCode === 0) {
                const e2eRunId = crypto.randomUUID();
                const e2eRun: PersistedTestRun = {
                    id: e2eRunId,
                    status: 'running',
                    mode: 'pipeline_run_existing',
                    framework: 'playwright',
                    workspacePath: plan.workspacePath,
                    executionId: execution.id,
                    planId: plan.id,
                    pipelineId: plan.pipelineId,
                    startedAt: new Date().toISOString(),
                };
                testPersistStore.upsert(e2eRun);
                broadcast({
                    type: 'test:auto_start',
                    data: {testRunId: e2eRunId, executionId: execution.id, mode: 'run_existing'}
                });

                try {
                    const e2eResults = await testExecutorService.runTests(
                        {
                            workspacePath: plan.workspacePath,
                            framework: 'playwright',
                            taskId: e2eRunId,
                            sandboxId: testStrategy.environment === 'sandbox' ? testStrategy.sandboxId : undefined,
                        },
                        {
                            onOutput: (data) => {
                                e2eRun.rawOutput = (e2eRun.rawOutput || '') + data;
                                broadcast({type: 'test:output', data: {taskId: e2eRunId, content: data}});
                            },
                        }
                    );
                    e2eRun.status = 'completed';
                    e2eRun.results = e2eResults;
                    e2eRun.completedAt = new Date().toISOString();
                    testPersistStore.upsert(e2eRun);
                    broadcast({
                        type: 'test:complete',
                        data: {taskId: e2eRunId, results: e2eResults, status: 'completed', workspacePath: execution.workspacePath}
                    });
                } catch (err) {
                    e2eRun.status = 'failed';
                    e2eRun.error = getErrorMessage(err);
                    e2eRun.completedAt = new Date().toISOString();
                    testPersistStore.upsert(e2eRun);
                    broadcast({type: 'error', data: {message: `E2E test execution failed: ${e2eRun.error}`}});
                }
            }
        }).catch((err) => {
            testRun.status = 'failed';
            testRun.error = getErrorMessage(err);
            testRun.completedAt = new Date().toISOString();
            testPersistStore.upsert(testRun);
            broadcast({type: 'error', data: {message: `AI E2E test generation failed: ${testRun.error}`}});
        });

    } else {
        // 模式二（默认）：使用 AI（Claude）分析代码变更并生成测试
        const isSandboxMode = testStrategy.environment === 'sandbox' && !!testStrategy.sandboxId && !!sandboxService?.isEnabled();
        console.log(`[test-phase] ai_generate mode: environment=${testStrategy.environment}, sandboxId=${testStrategy.sandboxId || 'none'}, sandboxEnabled=${sandboxService?.isEnabled()}, isSandboxMode=${isSandboxMode}`);

        const testRun: PersistedTestRun = {
            id: testRunId,
            status: 'running',
            mode: 'pipeline_ai_generate',
            workspacePath: plan.workspacePath,
            executionId: execution.id,
            planId: plan.id,
            pipelineId: plan.pipelineId,
            startedAt: new Date().toISOString(),
            environment: isSandboxMode ? 'sandbox' : 'local',
            sandboxId: isSandboxMode ? testStrategy.sandboxId : undefined,
            phases: [],
        };
        testPersistStore.upsert(testRun);
        broadcast({
            type: 'test:auto_start',
            data: {testRunId, executionId: execution.id, mode: 'ai_generate', environment: testRun.environment}
        });

        if (isSandboxMode) {
            // === 沙箱三阶段流程 ===
            void executeAiGenerateSandbox(
                execution, plan, testStrategy, testRunId, testRun,
                cliRunnerService, testExecutorService!, sandboxService!, testPersistStore,
                testSkills, changedFiles
            );
        } else {
            // === 原有本地一体化流程（不变） ===
            const prompt = renderPrompt(PROMPTS.testAnalyzeAuto, {
                workspacePath: plan.workspacePath,
                planSummary: plan.summary || 'See previous context',
            });

            let accumulatedOutput = '';
            cliRunnerService.runBridge(
                {
                    prompt,
                    cwd: plan.workspacePath,
                    sessionId: execution.sessionId,
                    maxTurns: 30,
                    skills: testSkills,
                },
                {
                    workspacePath: plan.workspacePath,
                    onOutput: (data) => {
                        accumulatedOutput += data;
                        testRun.rawOutput = accumulatedOutput;
                        broadcast({type: 'test:output', data: {taskId: testRunId, content: data}});
                    },
                }
            ).then((result) => {
                testRun.status = result.exitCode === 0 ? 'completed' : 'failed';
                testRun.rawOutput = accumulatedOutput;
                testRun.completedAt = new Date().toISOString();
                if (result.exitCode !== 0) testRun.error = 'AI test generation failed';
                testPersistStore.upsert(testRun);
                broadcast({
                    type: 'test:complete',
                    data: {taskId: testRunId, status: testRun.status, rawOutput: accumulatedOutput, workspacePath: execution.workspacePath}
                });
            }).catch((err) => {
                testRun.status = 'failed';
                testRun.error = getErrorMessage(err);
                testRun.completedAt = new Date().toISOString();
                testPersistStore.upsert(testRun);
                broadcast({type: 'error', data: {message: `AI test generation failed: ${testRun.error}`}});
            });
        }
    }
}

/**
 * ai_generate 模式的沙箱三阶段测试执行流程
 *
 * Phase 1: AI 本地编写测试文件（需要读写 workspace）
 * Phase 2: 同步文件到沙箱并在沙箱中执行测试
 * Phase 3 (条件): AI 修复失败用例 + 沙箱重新执行
 */
async function executeAiGenerateSandbox(
    execution: StoredExecution,
    plan: StoredPlan,
    testStrategy: TestStrategyConfig,
    testRunId: string,
    testRun: PersistedTestRun,
    cliRunnerService: CLIRunnerService,
    testExecutorService: TestExecutorService,
    sandboxService: SandboxService,
    testPersistStore: TestStoreService,
    testSkills: string[] | 'all' | undefined,
    changedFiles?: string[],
): Promise<void> {
    const phases = testRun.phases!;

    // === Phase 1: AI 编写测试文件（本地） ===
    const phase1Start = new Date().toISOString();
    testRun.currentPhase = 'writing';
    phases.push({phase: 'writing', label: 'AI 编写测试文件', startedAt: phase1Start, status: 'running'});
    testPersistStore.upsert(testRun);
    broadcast({type: 'test:phase_change', data: {taskId: testRunId, phase: 'writing', label: 'AI 编写测试文件'}});

    const writeOnlyPrompt = renderPrompt(PROMPTS.testWriteOnlyAuto, {
        workspacePath: plan.workspacePath,
        planSummary: plan.summary || 'See previous context',
    });

    let phase1Output = '';
    try {
        const phase1Result = await cliRunnerService.runBridge(
            {
                prompt: writeOnlyPrompt,
                cwd: plan.workspacePath,
                sessionId: execution.sessionId,
                maxTurns: 20,
                skills: testSkills,
            },
            {
                workspacePath: plan.workspacePath,
                onOutput: (data) => {
                    phase1Output += data;
                    testRun.rawOutput = phase1Output;
                    broadcast({type: 'test:output', data: {taskId: testRunId, content: data, phase: 'writing'}});
                },
            }
        );

        // Phase 1 完成
        phases[0].completedAt = new Date().toISOString();
        phases[0].status = phase1Result.exitCode === 0 ? 'completed' : 'failed';
        testPersistStore.upsert(testRun);

        if (phase1Result.exitCode !== 0) {
            // Phase 1 失败，终止流程
            testRun.status = 'failed';
            testRun.error = 'AI test file generation failed';
            testRun.completedAt = new Date().toISOString();
            testPersistStore.upsert(testRun);
            broadcast({type: 'test:complete', data: {taskId: testRunId, status: 'failed', error: testRun.error, workspacePath: execution.workspacePath}});
            return;
        }
    } catch (err) {
        phases[0].completedAt = new Date().toISOString();
        phases[0].status = 'failed';
        testRun.status = 'failed';
        testRun.error = `Phase 1 failed: ${getErrorMessage(err)}`;
        testRun.completedAt = new Date().toISOString();
        testPersistStore.upsert(testRun);
        broadcast({type: 'test:complete', data: {taskId: testRunId, status: 'failed', error: testRun.error, workspacePath: execution.workspacePath}});
        return;
    }

    // === Phase 2: 沙箱执行测试 ===
    const phase2Start = new Date().toISOString();
    testRun.currentPhase = 'sandbox_run';
    phases.push({phase: 'sandbox_run', label: '在沙箱中执行测试', startedAt: phase2Start, status: 'running'});
    testPersistStore.upsert(testRun);
    broadcast({type: 'test:phase_change', data: {taskId: testRunId, phase: 'sandbox_run', label: '在沙箱中执行测试'}});

    // 同步变更文件到沙箱
    const syncOk = await sandboxService.syncChangedFiles(plan.workspacePath, testStrategy.sandboxId);
    if (!syncOk) {
        console.error(`[sandbox-test] File sync failed for sandbox "${testStrategy.sandboxId}"`);
        // 标记阶段失败并终止
        const runPhase = testRun.phases!.find(p => p.phase === 'sandbox_run');
        if (runPhase) {
            runPhase.completedAt = new Date().toISOString();
            runPhase.status = 'failed';
        }
        testRun.status = 'failed';
        testRun.error = `Sandbox "${testStrategy.sandboxId}" is not available. File sync failed.`;
        testRun.completedAt = new Date().toISOString();
        testPersistStore.upsert(testRun);
        broadcast({type: 'test:complete', data: {taskId: testRunId, status: 'failed', error: testRun.error, workspacePath: execution.workspacePath}});
        return;
    }

    let phase2Output = '';
    let sandboxResults;
    try {
        sandboxResults = await testExecutorService.runTests(
            {
                workspacePath: plan.workspacePath,
                framework: testStrategy.framework || '',
                command: testStrategy.command,
                changedFiles,
                taskId: testRunId,
                sandboxId: testStrategy.sandboxId,
            },
            {
                onOutput: (data) => {
                    phase2Output += data;
                    testRun.rawOutput = (testRun.rawOutput || '') + '\n--- Sandbox Test Output ---\n' + data;
                    broadcast({type: 'test:output', data: {taskId: testRunId, content: data, phase: 'sandbox_run'}});
                },
            }
        );

        phases[1].completedAt = new Date().toISOString();
        phases[1].status = 'completed';
        testRun.results = sandboxResults;
        testPersistStore.upsert(testRun);
    } catch (err) {
        phases[1].completedAt = new Date().toISOString();
        phases[1].status = 'failed';
        testRun.status = 'failed';
        testRun.error = `Sandbox test execution failed: ${getErrorMessage(err)}`;
        testRun.completedAt = new Date().toISOString();
        testPersistStore.upsert(testRun);
        broadcast({type: 'test:complete', data: {taskId: testRunId, status: 'failed', error: testRun.error, workspacePath: execution.workspacePath}});
        return;
    }

    // === Phase 3: AI 修复（条件：存在失败用例） ===
    if (sandboxResults.failed > 0) {
        const phase3Start = new Date().toISOString();
        testRun.currentPhase = 'fixing';
        phases.push({phase: 'fixing', label: 'AI 修复失败用例', startedAt: phase3Start, status: 'running'});
        testPersistStore.upsert(testRun);
        broadcast({type: 'test:phase_change', data: {taskId: testRunId, phase: 'fixing', label: 'AI 修复失败用例'}});

        // 构造失败详情
        const failureDetails = sandboxResults.suites
            ?.flatMap(s => s.tests?.filter(t => t.status === 'failed').map(t => `- [${s.name}] ${t.name}: ${t.error || 'Unknown error'}`) ?? [])
            .join('\n') || `${sandboxResults.failed} test(s) failed`;

        const fixPrompt = renderPrompt(PROMPTS.testFix, {
            workspacePath: plan.workspacePath,
            failureDetails,
        });

        let phase3Output = '';
        try {
            const fixResult = await cliRunnerService.runBridge(
                {
                    prompt: fixPrompt,
                    cwd: plan.workspacePath,
                    sessionId: execution.sessionId,
                    maxTurns: 15,
                    skills: testSkills,
                },
                {
                    workspacePath: plan.workspacePath,
                    onOutput: (data) => {
                        phase3Output += data;
                        testRun.rawOutput = (testRun.rawOutput || '') + '\n--- AI Fix Output ---\n' + data;
                        broadcast({type: 'test:output', data: {taskId: testRunId, content: data, phase: 'fixing'}});
                    },
                }
            );

            const fixPhase = phases.find(p => p.phase === 'fixing')!;
            fixPhase.completedAt = new Date().toISOString();
            fixPhase.status = fixResult.exitCode === 0 ? 'completed' : 'failed';

            if (fixResult.exitCode === 0) {
                // 重新在沙箱中执行测试
                const rerunStart = new Date().toISOString();
                testRun.currentPhase = 'sandbox_rerun';
                phases.push({
                    phase: 'sandbox_rerun',
                    label: '在沙箱中重新执行测试',
                    startedAt: rerunStart,
                    status: 'running'
                });
                testPersistStore.upsert(testRun);
                broadcast({
                    type: 'test:phase_change',
                    data: {taskId: testRunId, phase: 'sandbox_rerun', label: '在沙箱中重新执行测试'}
                });

                // 再次同步修复后的文件
                const resyncOk = await sandboxService.syncChangedFiles(plan.workspacePath, testStrategy.sandboxId);
                if (!resyncOk) {
                    console.error(`[sandbox-test] Re-sync failed for sandbox "${testStrategy.sandboxId}"`);
                    const rerunPhase = testRun.phases!.find(p => p.phase === 'sandbox_rerun');
                    if (rerunPhase) {
                        rerunPhase.completedAt = new Date().toISOString();
                        rerunPhase.status = 'failed';
                    }
                    testRun.status = 'failed';
                    testRun.error = `Sandbox "${testStrategy.sandboxId}" is not available. File sync failed during re-run.`;
                    testRun.completedAt = new Date().toISOString();
                    testPersistStore.upsert(testRun);
                    broadcast({
                        type: 'test:complete',
                        data: {taskId: testRunId, status: 'failed', error: testRun.error, workspacePath: execution.workspacePath}
                    });
                    return;
                }

                let rerunOutput = '';
                const rerunResults = await testExecutorService.runTests(
                    {
                        workspacePath: plan.workspacePath,
                        framework: testStrategy.framework || '',
                        command: testStrategy.command,
                        changedFiles,
                        taskId: testRunId,
                        sandboxId: testStrategy.sandboxId,
                    },
                    {
                        onOutput: (data) => {
                            rerunOutput += data;
                            testRun.rawOutput = (testRun.rawOutput || '') + '\n--- Sandbox Re-run Output ---\n' + data;
                            broadcast({
                                type: 'test:output',
                                data: {taskId: testRunId, content: data, phase: 'sandbox_rerun'}
                            });
                        },
                    }
                );

                // 使用重跑结果
                const rerunPhase = phases.find(p => p.phase === 'sandbox_rerun')!;
                rerunPhase.completedAt = new Date().toISOString();
                rerunPhase.status = 'completed';
                testRun.results = rerunResults;
            }
        } catch (err) {
            const fixPhase = phases.find(p => p.phase === 'fixing')!;
            fixPhase.completedAt = new Date().toISOString();
            fixPhase.status = 'failed';
            console.error(`[sandbox-test] AI fix phase failed: ${getErrorMessage(err)}`);
        }
    }

    // 最终完成
    testRun.status = 'completed';
    testRun.currentPhase = undefined;
    testRun.completedAt = new Date().toISOString();
    testPersistStore.upsert(testRun);
    broadcast({type: 'test:complete', data: {taskId: testRunId, status: 'completed', results: testRun.results, workspacePath: execution.workspacePath}});
}
