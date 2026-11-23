/**
 * @module task-scheduler-service
 * @description 任务调度器 — Coordinator 模式实现
 *
 * 管理多个并行任务，每个任务拥有独立的 Provider 子进程（按用户当前选择的 CLI Provider 实例化）。
 * 借鉴 Claude Code 的 Coordinator 模式：
 * - 每个 Task 对应一个独立的 CLIProvider 实例（独立子进程）
 * - 最大并行数控制，超出排队
 * - 任务完成自动启动排队中的下一个
 * - 内部编排完整流水线：Plan → Execution → Test
 */

import type {CLIProvider, CLIProviderResult} from './cli-providers';
import {createConfiguredProvider} from './cli-runner-service.js';
import {getErrorMessage} from '../utils/error-utils.js';
import {enrichPrompt} from '../utils/prompt-enrichment.js';
import {renderPrompt} from '../utils/prompt-renderer.js';
import {PROMPTS} from '../prompts/index.js';
import {getPhaseSkills, getPhaseMcpServers, resolveMcpServerMap} from '../utils/skill-utils.js';
import {MCPRegistryService} from './mcp-registry-service.js';
import {broadcast} from '../websocket.js';
import type {MemoryService} from './memory/memory-service.js';
import type {PipelineService} from './pipeline-service.js';
import type {RequirementAgentFetchService} from './requirement-agent-fetch.js';
import type {RequirementStoreService} from './requirement-store-service.js';

// === 类型定义 ===

export type TaskStatus = 'pending' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
export type TaskPhase = 'idle' | 'plan' | 'waiting_plan_confirm' | 'execution' | 'waiting_execution_confirm' | 'test';

export interface TaskLog {
    timestamp: string;
    phase: TaskPhase;
    logType: 'info' | 'output' | 'error' | 'warning';
    content: string;
}

export interface TaskInfo {
    id: string;
    name: string;
    projectId: string;
    requirementId: string;
    pipelineId: string;
    branch: string;
    workspacePath: string;
    worktreePath?: string;
    dependsOn: string[];
    baseBranch: string;
    status: TaskStatus;
    phase: TaskPhase;
    sessionId?: string;
    logs: TaskLog[];
    createdAt: string;
    updatedAt: string;
}

/** 运行中的任务上下文 */
interface RunningTask {
    task: TaskInfo;
    provider: CLIProvider;
    abortController: AbortController;
}

/** 流水线编排所需的依赖注入 */
export interface PipelineDependencies {
    requirementStore: RequirementStoreService;
    agentFetchService: RequirementAgentFetchService;
    pipelineService: PipelineService;
    memoryService?: MemoryService;
    workspaceService?: import('./workspace-service.js').WorkspaceService;
}

// === 调度器 ===

export class TaskScheduler {
    private running = new Map<string, RunningTask>();
    private queue: string[] = [];
    private tasks = new Map<string, TaskInfo>();
    private maxConcurrent: number;
    private deps: PipelineDependencies | null = null;
    /** MCP 配置服务（无状态，按名解析为 stdio 配置注入执行阶段） */
    private mcpConfigService = new MCPRegistryService();
    /** 持久化回调：状态变更时同步写入磁盘 */
    onPersist?: (task: TaskInfo) => void;
    /** 确认等待：taskId → resolve 回调 */
    private confirmationResolvers = new Map<string, () => void>();

    constructor(maxConcurrent: number = 3) {
        this.maxConcurrent = maxConcurrent;
    }

    /** 注入流水线依赖 */
    setDependencies(deps: PipelineDependencies): void {
        this.deps = deps;
    }

    // === 基础访问 ===

    getMaxConcurrent(): number {
        return this.maxConcurrent;
    }

    setMaxConcurrent(n: number): void {
        this.maxConcurrent = Math.max(1, n);
    }

    getRunningCount(): number {
        return this.running.size;
    }

    getQueueLength(): number {
        return this.queue.length;
    }

    registerTask(task: TaskInfo): void {
        this.tasks.set(task.id, task);
    }

    getTask(taskId: string): TaskInfo | undefined {
        return this.tasks.get(taskId);
    }

    /**
     * 启动任务（如果达到并行上限则排队，否则直接执行完整流水线）
     */
    async startTask(taskId: string): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        if (task.status === 'running') throw new Error(`Task already running: ${taskId}`);

        // 检查依赖是否都已完成
        const pendingDeps = task.dependsOn.filter(depId => {
            const dep = this.tasks.get(depId);
            return !dep || dep.status !== 'completed';
        });
        if (pendingDeps.length > 0) {
            // 有未完成依赖，标记为 pending 等待
            task.status = 'pending';
            task.updatedAt = new Date().toISOString();
            this.addLog(taskId, 'idle', 'info', `等待前置任务完成: ${pendingDeps.join(', ')}`);
            this.notifyUpdate(task);
            return;
        }

        // 无依赖或依赖全部完成，加入执行队列
        if (this.running.size >= this.maxConcurrent) {
            task.status = 'queued';
            task.updatedAt = new Date().toISOString();
            this.queue.push(taskId);
            this.notifyUpdate(task);
            return;
        }

        await this.executeTask(taskId);
    }

    async pauseTask(taskId: string): Promise<void> {
        const running = this.running.get(taskId);
        if (!running) throw new Error(`Task not running: ${taskId}`);

        running.abortController.abort();
        running.task.status = 'paused';
        running.task.updatedAt = new Date().toISOString();
        this.notifyUpdate(running.task);
    }

    async resumeTask(taskId: string): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'paused') throw new Error(`Task not paused: ${taskId}`);

        if (this.running.size >= this.maxConcurrent) {
            task.status = 'queued';
            task.updatedAt = new Date().toISOString();
            this.queue.push(taskId);
            this.notifyUpdate(task);
            return;
        }

        await this.executeTask(taskId);
    }

    async abortTask(taskId: string): Promise<void> {
        const running = this.running.get(taskId);
        if (running) {
            running.abortController.abort();
            await running.provider.dispose().catch(() => {
            });
            this.running.delete(taskId);
        }

        const queueIdx = this.queue.indexOf(taskId);
        if (queueIdx >= 0) this.queue.splice(queueIdx, 1);

        const task = this.tasks.get(taskId);
        if (task) {
            task.status = 'aborted';
            task.updatedAt = new Date().toISOString();
            this.notifyUpdate(task);
        }

        this.processQueue();
    }

    removeTask(taskId: string): void {
        const running = this.running.get(taskId);
        if (running) {
            running.abortController.abort();
            running.provider.dispose().catch(() => {
            });
            this.running.delete(taskId);
        }
        this.tasks.delete(taskId);
        const queueIdx = this.queue.indexOf(taskId);
        if (queueIdx >= 0) this.queue.splice(queueIdx, 1);
    }

    /**
     * 向运行中的任务发送对话（多轮回复）
     */
    async sendReply(taskId: string, message: string): Promise<CLIProviderResult> {
        const running = this.running.get(taskId);
        if (!running) throw new Error(`Task not running: ${taskId}`);
        if (!running.task.sessionId) throw new Error(`Task has no session: ${taskId}`);

        return running.provider.run(
            {prompt: message, sessionId: running.task.sessionId, maxTurns: 30},
            {
                signal: running.abortController.signal,
                onOutput: (data) => this.addLog(taskId, running.task.phase, 'output', data),
                onError: (data) => this.addLog(taskId, running.task.phase, 'error', data),
            }
        );
    }

    updateTaskState(taskId: string, updates: Partial<Pick<TaskInfo, 'status' | 'phase' | 'name'>>): void {
        const task = this.tasks.get(taskId);
        if (task) {
            Object.assign(task, updates, {updatedAt: new Date().toISOString()});
            this.notifyUpdate(task);
        }
    }

    /**
     * 用户确认当前阶段，推进流水线
     */
    async confirmTask(taskId: string): Promise<void> {
        const resolver = this.confirmationResolvers.get(taskId);
        if (!resolver) throw new Error(`No pending confirmation for task: ${taskId}`);
        this.confirmationResolvers.delete(taskId);
        resolver();
    }

    /**
     * 等待用户确认（可被 abort 中断）
     */
    private waitForConfirmation(taskId: string, signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // 正常确认路径也要移除 abort 监听：否则监听器随 signal 残留（每任务两处）
            const onAbort = () => {
                this.confirmationResolvers.delete(taskId);
                signal.removeEventListener('abort', onAbort);
                reject(new Error('Aborted'));
            };
            const resolveAndCleanup = () => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            };
            this.confirmationResolvers.set(taskId, resolveAndCleanup);
            signal.addEventListener('abort', onAbort, {once: true});
        });
    }

    // === 内部：任务执行 + 流水线编排 ===

    /**
     * 启动独立 provider 进程，然后编排完整流水线
     */
    private async executeTask(taskId: string): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task) return;
        if (!this.deps) {
            task.status = 'failed';
            task.updatedAt = new Date().toISOString();
            this.addLog(taskId, 'idle', 'error', 'Pipeline dependencies not configured');
            this.notifyUpdate(task);
            return;
        }

        // 按当前配置实例化独立 Provider（内置 id → 对应引擎；自定义记录 → 注入端点的引擎实例），
        // 与用户在系统设置中选择的 Provider 保持一致
        const provider = createConfiguredProvider();
        const abortController = new AbortController();

        task.status = 'running';
        task.updatedAt = new Date().toISOString();
        this.running.set(taskId, {task, provider, abortController});
        this.notifyUpdate(task);

        try {
            await provider.initialize();
            this.addLog(taskId, 'idle', 'info', 'Provider 进程启动成功');
        } catch (err) {
            task.status = 'failed';
            task.updatedAt = new Date().toISOString();
            this.addLog(taskId, task.phase, 'error', `Provider 进程启动失败: ${getErrorMessage(err)}`);
            this.running.delete(taskId);
            this.notifyUpdate(task);
            this.processQueue();
            return;
        }

        // 编排完整流水线
        try {
            await this.runPipeline(taskId, provider, abortController.signal);
            task.status = 'completed';
        } catch (err) {
            if (abortController.signal.aborted) {
                task.status = 'aborted';
            } else {
                task.status = 'failed';
                this.addLog(taskId, task.phase, 'error', `Pipeline failed: ${getErrorMessage(err)}`);
            }
        } finally {
            task.updatedAt = new Date().toISOString();
            await provider.dispose().catch(() => {
            });
            this.running.delete(taskId);
            this.notifyUpdate(task);

            // 任务成功完成：stash 代码并触发依赖任务
            if (task.status === 'completed' && this.deps?.workspaceService) {
                await this.stashAndTriggerDependents(taskId);
            }

            this.processQueue();
        }
    }

    /**
     * 任务完成后 stash 代码，如果有依赖任务则合并到 base 后触发
     */
    private async stashAndTriggerDependents(completedTaskId: string): Promise<void> {
        const task = this.tasks.get(completedTaskId);
        if (!task || !this.deps?.workspaceService) return;

        // 先 stash 代码（按需求号标记）
        try {
            await this.deps.workspaceService.stashTaskChanges(task.workspacePath, task.name || task.requirementId);
            this.addLog(completedTaskId, task.phase, 'info', `代码已 stash: ${task.name || task.requirementId}`);
        } catch (err) {
            this.addLog(completedTaskId, task.phase, 'warning', `Stash 失败: ${getErrorMessage(err)}`);
        }

        // 查找依赖此任务的后继任务
        const hasDependents = Array.from(this.tasks.values()).some(
            t => (t.status === 'pending' || t.status === 'queued') && t.dependsOn.includes(completedTaskId)
        );

        // 如果有后继任务，需要合并分支到 base（让后继任务基于最新代码）
        if (hasDependents) {
            try {
                const baseBranch = task.baseBranch || 'main';
                await this.deps.workspaceService.mergeBranchToBase(task.workspacePath, task.branch, baseBranch);
                this.addLog(completedTaskId, task.phase, 'info', `分支 ${task.branch} 已合并到 ${baseBranch}（存在依赖任务）`);
            } catch (err) {
                this.addLog(completedTaskId, task.phase, 'warning', `合并失败（依赖任务可能基于旧 base）: ${getErrorMessage(err)}`);
            }
        }

        // 触发等待的后继任务
        for (const [id, t] of this.tasks) {
            if (t.status !== 'pending' && t.status !== 'queued') continue;
            if (!t.dependsOn.includes(completedTaskId)) continue;

            const allDepsMet = t.dependsOn.every(depId => {
                const dep = this.tasks.get(depId);
                return dep?.status === 'completed';
            });

            if (allDepsMet) {
                this.addLog(id, 'idle', 'info', `所有前置任务完成，开始执行...`);
                if (this.running.size < this.maxConcurrent) {
                    this.executeTask(id).catch(() => {
                    });
                } else {
                    t.status = 'queued';
                    t.updatedAt = new Date().toISOString();
                    this.queue.push(id);
                    this.notifyUpdate(t);
                }
            }
        }
    }

    /**
     * 内部编排完整流水线：Plan → Execution → Test
     * 同一个 provider/session 贯穿全流程
     */
    private async runPipeline(taskId: string, provider: CLIProvider, signal: AbortSignal): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task || !this.deps) return;

        const {requirementStore, agentFetchService, pipelineService, memoryService} = this.deps;

        // 直接使用项目目录（不使用 worktree）
        const cwd = task.workspacePath;

        // --- Phase 1: Plan ---
        this.updateTaskState(taskId, {phase: 'plan'});
        this.addLog(taskId, 'plan', 'info', '开始生成开发计划...');

        // 获取需求内容
        const {
            title,
            description
        } = await this.getRequirementContent(task.requirementId, requirementStore, agentFetchService);

        const promptText = renderPrompt(PROMPTS.plan, {title, description});

        const planSkills = getPhaseSkills(
            pipelineService.get(task.pipelineId)?.steps ?? {},
            'plan'
        );
        const {map: planMcpServers, missing: planMcpMissing} = resolveMcpServerMap(
            getPhaseMcpServers(pipelineService.get(task.pipelineId)?.steps ?? {}, 'plan'),
            this.mcpConfigService,
        );
        if (planMcpMissing.length > 0) {
            this.addLog(taskId, 'plan', 'warning', `MCP servers not found, skipped: ${planMcpMissing.join(', ')}`);
        }

        const planPrompt = enrichPrompt(promptText, memoryService, cwd);

        let planOutput = '';
        // ponytail: 过滤掉Agent模式
        const filteredPlanSkills = (planSkills && typeof planSkills === 'object' && 'mode' in planSkills && planSkills.mode === 'agent')
            ? undefined
            : planSkills as string[] | 'all' | undefined;
        const planResult = await provider.run(
            {
                prompt: planPrompt,
                cwd: cwd,
                maxTurns: 20,
                skills: filteredPlanSkills,
                mcpServers: planMcpServers,
            },
            {
                signal,
                onOutput: (data) => {
                    planOutput += data;
                    this.addLog(taskId, 'plan', 'output', data);
                    broadcast({type: 'plan:progress', data: {taskId, content: data}});
                },
            }
        );

        if (planResult.sessionId) task.sessionId = planResult.sessionId;
        if (planResult.exitCode !== 0) {
            throw new Error(`Plan generation failed: ${planResult.stderr || 'exit code ' + planResult.exitCode}`);
        }

        this.addLog(taskId, 'plan', 'info', '计划生成完成，等待用户确认...');

        // --- 暂停：等待用户确认计划 ---
        this.updateTaskState(taskId, {phase: 'waiting_plan_confirm'});
        broadcast({type: 'plan:waiting_confirm', data: {taskId}});
        await this.waitForConfirmation(taskId, signal);

        // --- Phase 2: Execution ---
        this.updateTaskState(taskId, {phase: 'execution'});
        this.addLog(taskId, 'execution', 'info', '用户已确认，开始执行...');

        const executionSkills = getPhaseSkills(
            pipelineService.get(task.pipelineId)?.steps ?? {},
            'execution'
        );
        const {map: executionMcpServers, missing: executionMcpMissing} = resolveMcpServerMap(
            getPhaseMcpServers(pipelineService.get(task.pipelineId)?.steps ?? {}, 'execution'),
            this.mcpConfigService,
        );
        if (executionMcpMissing.length > 0) {
            this.addLog(taskId, 'execution', 'warning', `MCP servers not found, skipped: ${executionMcpMissing.join(', ')}`);
        }

        const executionPrompt = enrichPrompt(planOutput, memoryService, cwd);

        // ponytail: 过滤掉Agent模式
        const filteredExecutionSkills = (executionSkills && typeof executionSkills === 'object' && 'mode' in executionSkills && executionSkills.mode === 'agent')
            ? undefined
            : executionSkills as string[] | 'all' | undefined;
        const execResult = await provider.run(
            {
                prompt: executionPrompt,
                cwd: cwd,
                sessionId: task.sessionId,
                maxTurns: 50,
                skills: filteredExecutionSkills,
                mcpServers: executionMcpServers,
            },
            {
                signal,
                onOutput: (data) => {
                    this.addLog(taskId, 'execution', 'output', data);
                    broadcast({type: 'execution:output', data: {taskId, content: data}});
                },
            }
        );

        if (execResult.sessionId) task.sessionId = execResult.sessionId;
        if (execResult.aborted) throw new Error('Aborted');
        if (execResult.exitCode !== 0) {
            throw new Error(`Execution failed: exit code ${execResult.exitCode}`);
        }

        this.addLog(taskId, 'execution', 'info', '执行完成，等待用户确认...');
        broadcast({
            type: 'execution:complete',
            data: {taskId, executionId: task.id, status: 'completed', workspacePath: task.workspacePath}
        });

        // --- 暂停：等待用户确认执行结果 ---
        this.updateTaskState(taskId, {phase: 'waiting_execution_confirm'});
        broadcast({type: 'execution:waiting_confirm', data: {taskId}});
        await this.waitForConfirmation(taskId, signal);

        // --- Phase 3: Test（如果配置了自动测试） ---
        const pipeline = pipelineService.get(task.pipelineId);
        const testStrategy = pipeline?.steps?.testStrategy;
        if (testStrategy?.autoRunAfterExecution) {
            this.updateTaskState(taskId, {phase: 'test'});
            this.addLog(taskId, 'test', 'info', '自动测试已配置，但多任务模式下暂不支持独立测试阶段。');
            // 测试阶段需要 TestExecutorService 等更多依赖，后续迭代补充
        }
    }

    /**
     * 获取需求内容（本地 store 优先，fallback agent 中介拉取）
     */
    private async getRequirementContent(
        requirementId: string,
        reqStore: RequirementStoreService,
        agentFetchService: RequirementAgentFetchService,
    ): Promise<{ title: string; description: string }> {
        const saved = reqStore.get(requirementId);
        // 工作副本（编辑 + 解析合并的成果）优先于源描述
        if (saved) return {title: saved.title, description: saved.workingDescription ?? saved.description};
        const detail = await agentFetchService.fetchByInput(requirementId);
        return {title: detail.title, description: detail.description};
    }

    // === 内部工具 ===

    private processQueue(): void {
        while (this.queue.length > 0 && this.running.size < this.maxConcurrent) {
            const nextId = this.queue.shift()!;
            this.executeTask(nextId).catch(() => {
            });
        }
    }

    private addLog(taskId: string, phase: TaskPhase, logType: TaskLog['logType'], content: string): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        const log: TaskLog = {timestamp: new Date().toISOString(), phase, logType, content};
        task.logs.push(log);
        broadcast({type: 'task:log', data: {taskId, log: {timestamp: log.timestamp, phase, logType, content}}});
    }

    private notifyUpdate(task: TaskInfo): void {
        broadcast({
            type: 'task:status_change',
            data: {taskId: task.id, status: task.status, phase: task.phase},
        });
        this.onPersist?.(task);
    }

    async dispose(): Promise<void> {
        for (const [, running] of this.running) {
            running.abortController.abort();
            await running.provider.dispose().catch(() => {
            });
        }
        this.running.clear();
        this.queue.length = 0;
        this.confirmationResolvers.clear();
    }
}
