/**
 * @module claude-provider
 * @description Claude Code CLI Provider 实现
 *
 * 封装 Claude Agent SDK 的桥接进程管理，从原有的 BridgeProcess 类迁移而来。
 * 通过持久化子进程（claude-bridge.mjs）+ JSON-RPC 2.0 协议实现双向通信。
 *
 * 协议说明：
 * - 父进程发送 JSON-RPC Request（method: "agent.execute" / "agent.confirmPermission"）
 * - Bridge 发送 JSON-RPC Notification（method: "agent.output" / "agent.thinking" 等）用于流式事件
 * - Bridge 发送 JSON-RPC Response 作为 agent.execute 的最终结果
 * - 通知通过 params.sessionId 关联到对应的 PendingRequest
 */

import {ChildProcess, spawn} from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {getErrorMessage} from '../../utils/error-utils.js';
import {extractDescription} from '../../utils/markdown-utils.js';
import {findSkillMdFile} from '../../utils/skill-utils.js';
import {ModelProviderStore} from '../model-provider-store.js';
import {mergeOwnModelsIntoTiers} from './model-options.js';
import {isolatedPath, isolationEnv, ensureSessionMigrated} from '../cli-isolation.js';
import {resolveClaudePermission} from '../permission-mapping.js';
import type {
    CLIProvider,
    CLIProviderInput,
    CLIProviderModelConnection,
    CLIProviderModelOptions,
    CLIProviderOptions,
    CLIProviderResult,
    CLIProviderStatus,
    McpServerInfo,
    ProviderModelSettings,
    SkillInfo,
} from './types.js';

/** 桥接脚本路径（编译后相对 dist/server/services/） */
const BRIDGE_SCRIPT = path.resolve(__dirname, '../../../bridge/claude-bridge.mjs');

/**
 * 隔离 home 的 projects 下是否存在该会话。
 * 会话本体是 `<projects>/<cwd 编码>/<sessionId>.jsonl`，
 * 另可能有同名附属目录 `<sessionId>/`（tool-results 等）。
 */
function hasClaudeSession(sessionId: string): boolean {
    if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) return false;
    const root = isolatedPath('claude', 'projects');
    if (!fs.existsSync(root)) return false;
    try {
        for (const project of fs.readdirSync(root, {withFileTypes: true})) {
            if (!project.isDirectory()) continue;
            const dir = path.join(root, project.name);
            if (fs.existsSync(path.join(dir, `${sessionId}.jsonl`))) return true;
            if (fs.existsSync(path.join(dir, sessionId))) return true;
        }
    } catch { /* 读取失败按不存在处理 */ }
    return false;
}

/**
 * Claude 配置根目录 —— **应用自管隔离目录**（不再直接读写 `~/.claude`）。
 *
 * 首次使用时 cli-isolation 会把 CLI 的 settings.json / commands / skills / agents
 * 复制进隔离目录（只读播种，保证本地已有配置第一次就能用上）；此后应用自管，
 * 对 CLI 目录既不读也不写，避免「改了应用配置不生效 / 两边互相污染」。
 */
function claudeHome(): string {
    return isolatedPath('claude');
}
/** 全局命令目录（slash commands，支持子目录） */
function commandsDir(): string {
    return isolatedPath('claude', 'commands');
}
/** 个人技能目录 */
function skillsDir(): string {
    return isolatedPath('claude', 'skills');
}
/** 已安装插件清单（权威插件 installPath 来源） */
function installedPluginsFile(): string {
    return isolatedPath('claude', 'plugins', 'installed_plugins.json');
}
/** Claude 设置文件（隔离目录内的那份，首次由 CLI 播种） */
function settingsFile(): string {
    return isolatedPath('claude', 'settings.json');
}

/**
 * 读取隔离 settings.json 的 env 块（首次由 CLI 播种而来）
 *
 * bridge 子进程需要与 CLI 一致的 env（ANTHROPIC_BASE_URL / API_KEY / 档位模型），
 * 否则 SDK 走 claude.exe 间接读配置的路径，模型解析不一致会触发中转 API 限流（529）。
 *
 * @returns settings.json 中 env 对象，读取失败返回空对象
 */
function loadClaudeSettingsEnv(): Record<string, string> {
    try {
        const file = settingsFile();
        if (!fs.existsSync(file)) return {};
        const settings = JSON.parse(fs.readFileSync(file, 'utf-8')) as { env?: Record<string, string> };
        return (settings.env && typeof settings.env === 'object') ? settings.env : {};
    } catch {
        return {};
    }
}

/**
 * 从自有模型供应商配置（~/.aico/models.json）读取 Claude 的 env 兜底。
 *
 * 免 CLI 依赖：当本地未安装 Claude CLI（无 ~/.claude/settings.json）时，
 * 仍可使用自动导入/手动添加的 API Key / Base URL / 模型配置。
 * 映射关系：claude 记录 → ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL。
 */
function loadOwnClaudeEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    try {
        const store = new ModelProviderStore();
        const rec = store.get('claude');
        if (rec && rec.enabled !== false) {
            if (rec.apiKey) env.ANTHROPIC_API_KEY = rec.apiKey;
            if (rec.baseUrl) env.ANTHROPIC_BASE_URL = rec.baseUrl;
            if (rec.defaultModel) {
                env.ANTHROPIC_MODEL = rec.defaultModel;
                // 默认档位为 sonnet，注入对应档位模型，保证 SDK 能解析 'sonnet' 别名
                env.ANTHROPIC_DEFAULT_SONNET_MODEL = rec.defaultModel;
            }
            if (rec.env && typeof rec.env === 'object') Object.assign(env, rec.env);
        }
    } catch {
        // 自有配置读取失败时静默降级
    }
    return env;
}

/**
 * 将自有模型供应商配置（models.json 的 claude 记录）中的模型合并进档位下拉。
 * 实现抽到 `./model-options.ts` 与 codex Provider 共用；此处 re-export
 * 保持既有测试与外部引用路径不变。
 */
export {mergeOwnModelsIntoTiers} from './model-options.js';

/** 待处理请求的内部数据结构 */
interface PendingRequest {
    onOutput?: (data: string, meta?: Record<string, unknown>) => void;
    onError?: (data: string) => void;
    onPermissionRequest?: (meta: Record<string, unknown>) => void;
    resolve: (result: CLIProviderResult) => void;
    reject: (err: Error) => void;
    stdout: string;
    sessionId?: string;
    aborted: boolean;
    abortHandler?: () => void;
}

/**
 * Claude Code CLI Provider
 * @description 通过持久化桥接子进程与 Claude Agent SDK 通信
 */
export class ClaudeProvider implements CLIProvider {
    readonly id = 'claude' as const;
    readonly label = 'Claude Code';

    readonly capabilities = {
        supportsPermission: true,
        supportsRuntimeSkills: true,
        supportsRuntimeMcp: true,
        supportsMaxTurns: true,
        supportsReasoningEffort: true,
        supportsExtendedThinking: true,
        supportsCustomEndpoint: true,
    } as const;

    /** 默认模型配置（cliProvider.models.claude 无存储值时使用） */
    readonly defaultModelSettings: ProviderModelSettings = {
        model: 'sonnet',
        extendedThinking: true,
        reasoningEffort: 'high',
        streaming: true,
    };

    private process: ChildProcess | null = null;
    private ready = false;
    private buffer = '';
    private pendingRequests = new Map<string, PendingRequest>();
    /** sessionId → PendingRequest 反向索引，用于 JSON-RPC 通知关联 */
    private sessionRequests = new Map<string, PendingRequest>();
    private readyCallbacks: Array<() => void> = [];
    private startPromise: Promise<void> | null = null;
    private healthCheckTimer: NodeJS.Timeout | null = null;
    /** JSON-RPC 自增 id 计数器 */
    private jsonRpcIdCounter = 0;
    /** 是否正在主动释放（避免 kill 触发的 exit 日志噪音） */
    private disposing = false;
    /** 当前激活的自定义供应商记录（Anthropic 兼容端点），由 CLIRunnerService 在切换时注入 */
    private modelRecord: CLIProviderModelConnection | null = null;

    async detect(): Promise<CLIProviderStatus> {
        try {
            // 检查桥接脚本是否存在
            if (!fs.existsSync(BRIDGE_SCRIPT)) {
                return {available: false, error: `Bridge script not found: ${BRIDGE_SCRIPT}`};
            }

            // 检查 @anthropic-ai/claude-agent-sdk 是否可导入
            let sdkPath: string | undefined;
            try {
                sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
            } catch {
                return {available: false, error: '@anthropic-ai/claude-agent-sdk not installed'};
            }

            return {
                available: true,
                version: 'claude-agent-sdk',
                path: sdkPath,
            };
        } catch (err) {
            return {available: false, error: getErrorMessage(err)};
        }
    }

    /**
     * 设置当前激活的自定义供应商记录（Anthropic 兼容端点）。
     * 传入 null 清除。调用方需在设置后重启 bridge（dispose + initialize）以加载新 env。
     */
    setModelRecord(rec: CLIProviderModelConnection | null): void {
        this.modelRecord = rec;
    }

    /** 当前激活的自定义供应商记录 */
    getModelRecord(): CLIProviderModelConnection | null {
        return this.modelRecord;
    }

/**
 * 读取本地可提供的模型选项：
 * 1. 解析 ~/.claude/settings.json env 中的档位映射（tier 为 SDK 可识别的别名 haiku/sonnet/opus）
 * 2. 合并自有模型供应商配置（~/.aico/models.json 的 claude 记录）中的模型，
 *    使「模型供应商」页添加的模型出现在下拉中（否则该页配置的模型永远无法选择）
 */
async loadModelOptions(): Promise<CLIProviderModelOptions> {
    const tiers: Array<{value: string; label: string; model: string}> = [];
    try {
        if (fs.existsSync(settingsFile())) {
            const raw = fs.readFileSync(settingsFile(), 'utf-8');
            const settings = JSON.parse(raw) as {env?: Record<string, string>};
            const env = settings.env ?? {};
            const tierDefs: Array<[string, string, string]> = [
                ['haiku', 'Haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
                ['sonnet', 'Sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
                ['opus', 'Opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
            ];
            for (const [value, label, envKey] of tierDefs) {
                const model = env[envKey];
                if (model) tiers.push({value, label, model});
            }
        }
    } catch { /* ignore */ }
    try {
        const rec = new ModelProviderStore().get('claude');
        return {tiers: mergeOwnModelsIntoTiers(tiers, rec)};
    } catch { /* 自有配置读取失败时仅返回档位 */ }
    return {tiers};
}

    async initialize(): Promise<void> {
        await this.ensureStarted();
    }

    /**
     * Claude 会话能否续接：会话文件在 `<隔离 home>/projects/<cwd 编码>/<sessionId>.jsonl`。
     *
     * 隔离后历史会话可能还没迁进来（首次播种只迁「当时被引用到」的会话）——
     * 这里先在用户 CLI 目录里定向补迁一次再判定，避免历史任务续聊被误判为「会话失效」。
     * 只读复制，不改动用户 CLI 目录。
     */
    canResumeSession(sessionId: string): boolean {
        if (hasClaudeSession(sessionId)) return true;
        try {
            if (ensureSessionMigrated('claude', sessionId)) return true;
        } catch { /* 迁移失败按「不可续接」处理，由上层提示并开新会话 */ }
        return false;
    }

    async run(input: CLIProviderInput, options?: CLIProviderOptions): Promise<CLIProviderResult> {
        await this.ensureStarted();

        if (!this.process || !this.ready) {
            throw new Error('Bridge process is not ready');
        }

        const jsonRpcId = String(++this.jsonRpcIdCounter);

        return new Promise((resolve, reject) => {
            const req: PendingRequest = {
                onOutput: options?.onOutput,
                onError: options?.onError,
                onPermissionRequest: options?.onPermissionRequest,
                resolve,
                reject,
                stdout: '',
                aborted: false,
            };

            if (options?.signal) {
                if (options.signal.aborted) {
                    resolve({exitCode: null, stdout: '', stderr: '', aborted: true});
                    return;
                }
                const abortHandler = () => {
                    req.aborted = true;
                    // 通知 bridge 中止**本请求**的 SDK 查询（agent.abort → abortSignal），
                    // 带上 jsonRpcId 精确中止，避免并发执行时误伤其它查询。
                    // 不发的话旧查询继续占用 bridge，续跑轮的 agent.execute 会与它并发导致消息"发不出去"。
                    this.sendAbort(jsonRpcId);
                    this.pendingRequests.delete(jsonRpcId);
                    if (req.sessionId && this.sessionRequests.get(req.sessionId) === req) this.sessionRequests.delete(req.sessionId);
                    // 给 bridge 一小段时间结束旧查询，再放行续跑轮（协调器随即发起新 execute）
                    setTimeout(() => resolve({exitCode: null, stdout: req.stdout, stderr: '', aborted: true}), 150);
                };
                req.abortHandler = abortHandler;
                options.signal.addEventListener('abort', abortHandler, {once: true});
            }

            this.pendingRequests.set(jsonRpcId, req);

            // 构造 JSON-RPC 2.0 请求
            const params: Record<string, unknown> = {
                prompt: input.prompt,
                ...(input.cwd ? {cwd: input.cwd} : {}),
                ...(input.sessionId ? {sessionId: input.sessionId} : {}),
                ...(input.maxTurns !== undefined ? {maxTurns: input.maxTurns} : {}),
                ...(input.skills ? {skills: input.skills} : {}),
                ...(input.mcpServers ? {mcpServers: input.mcpServers} : {}),
                ...resolveClaudePermission(options?.permissionMode ?? 'confirm', !!options?.onPermissionRequest),
            };
            if (options?.model) params.model = options.model;
            if (options?.reasoningEffort) params.reasoningEffort = options.reasoningEffort;
            if (options?.extendedThinking !== undefined) params.extendedThinking = options.extendedThinking;

            const message = JSON.stringify({
                jsonrpc: '2.0',
                id: jsonRpcId,
                method: 'agent.execute',
                params,
            }) + '\n';

            const proc = this.process;
            if (proc && proc.stdin) {
                proc.stdin.write(message);
            } else {
                this.pendingRequests.delete(jsonRpcId);
                reject(new Error('Bridge process stdin not available'));
            }
        });
    }

    async loadSkills(): Promise<SkillInfo[]> {
        // 用 name 去重（同源同名只保留一个），保留插入顺序
        const map = new Map<string, SkillInfo>();

        // 1. 个人技能 ~/.claude/skills/<name>/SKILL.md（含根 .md）
        scanSkillsDir(skillsDir(), '', 'personal', map);

        // 2. 命令 ~/.claude/commands/**/*.md（子目录 → dir:name）
        scanCommandsDir(commandsDir(), '', map);

        // 3. 插件技能（权威：installed_plugins.json 的 installPath）
        scanPluginSkills(installedPluginsFile(), map);

        return Array.from(map.values());
    }

    async loadMcpServers(): Promise<McpServerInfo[]> {
        if (!fs.existsSync(settingsFile())) {
            return [];
        }

        try {
            const raw = fs.readFileSync(settingsFile(), 'utf-8');
            const settings = JSON.parse(raw);
            const servers: McpServerInfo[] = [];

            if (settings.mcpServers && typeof settings.mcpServers === 'object') {
                for (const [name, config] of Object.entries(settings.mcpServers as Record<string, {
                    command?: string;
                    args?: string[];
                    env?: Record<string, string>;
                }>)) {
                    servers.push({
                        name,
                        type: inferServerType(config.command),
                        command: config.command ?? '',
                        args: config.args ?? [],
                        env: config.env ?? {},
                        enabled: true,
                    });
                }
            }

            return servers;
        } catch {
            return [];
        }
    }

    async dispose(): Promise<void> {
        this.disposing = true;
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        if (this.process) {
            this.process.kill();
            this.process = null;
            this.ready = false;
        }
        this.startPromise = null;
    }

    private async ensureStarted(): Promise<void> {
        if (this.ready && this.process) return;
        if (this.startPromise) return this.startPromise;

        this.startPromise = this.start();
        return this.startPromise;
    }

    private start(): Promise<void> {
        return new Promise((resolve, reject) => {
            // 清除 NODE_OPTIONS 中的 inspector 参数，避免子进程启动 debugger
            const settingsEnv = loadClaudeSettingsEnv();
            const ownEnv = loadOwnClaudeEnv();
            // 优先级（低 → 高）：process.env 基线 < 隔离 settings.json（首次从 CLI 播种）
            //                    < 应用模型供应商配置（claude 记录）< 自定义端点记录 < 隔离环境
            //
            // 「应用里配过就以应用为准」：此前 own 仅作兜底（settings.json 优先），
            // 于是应用里改了 key/baseUrl 却不生效 —— 与 pi 的凭据错配是同一类问题。
            // 隔离环境（CLAUDE_CONFIG_DIR）置于最末，保证子进程只读应用自有配置目录。
            const recordEnv: Record<string, string> = {};
            if (this.modelRecord) {
                if (this.modelRecord.baseUrl) recordEnv.ANTHROPIC_BASE_URL = this.modelRecord.baseUrl;
                if (this.modelRecord.apiKey) recordEnv.ANTHROPIC_API_KEY = this.modelRecord.apiKey;
                if (this.modelRecord.defaultModel) recordEnv.ANTHROPIC_MODEL = this.modelRecord.defaultModel;
            }
            const env = {
                ...process.env,
                ...settingsEnv,
                ...ownEnv,
                ...recordEnv,
                ...isolationEnv('claude'),
            };
            if (env.NODE_OPTIONS) {
                env.NODE_OPTIONS = env.NODE_OPTIONS
                    .split(/\s+/)
                    .filter((opt: string) => !opt.startsWith('--inspect') && !opt.startsWith('--debug'))
                    .join(' ');
            }

            const child = spawn('node', [BRIDGE_SCRIPT], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env,
            });

            this.process = child;

            const timeout = setTimeout(() => {
                reject(new Error('Bridge process failed to start within 30 seconds'));
                child.kill();
            }, 30000);

            child.stdout.on('data', (chunk: Buffer) => {
                this.buffer += chunk.toString();
                const lines = this.buffer.split('\n');
                this.buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        this.handleMessage(JSON.parse(line));
                    } catch { /* ignore non-JSON */
                    }
                }
            });

            child.stderr.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                console.error(`[claude-provider] stderr: ${text.trim().slice(0, 500)}`);
                for (const req of this.pendingRequests.values()) {
                    req.onError?.(text);
                }
            });

            child.on('error', (err) => {
                console.error(`[claude-provider] process error: ${err.message}`);
                clearTimeout(timeout);
                this.ready = false;
                this.process = null;
                this.startPromise = null;
                for (const [, req] of this.pendingRequests) {
                    req.reject(new Error(`Bridge process error: ${err.message}`));
                }
                this.pendingRequests.clear();
                this.sessionRequests.clear();
                reject(err);
            });

            child.on('exit', (code, signal) => {
                if (!this.disposing) {
                    console.error(`[claude-provider] process exited with code ${code}, signal ${signal}`);
                }
                this.disposing = false;
                clearTimeout(timeout);
                this.ready = false;
                this.process = null;
                this.startPromise = null;

                // 健止健康检测
                if (this.healthCheckTimer) {
                    clearInterval(this.healthCheckTimer);
                    this.healthCheckTimer = null;
                }

                // Reject 所有 pending 请求（主动释放时不 reject，避免噪音）
                if (!this.disposing) {
                    for (const [, req] of this.pendingRequests) {
                        req.reject(new Error(`Bridge process exited with code ${code}`));
                    }
                }
                this.pendingRequests.clear();
                this.sessionRequests.clear();
            });

            this.readyCallbacks.push(() => {
                clearTimeout(timeout);
                console.log('[claude-provider] bridge process ready');
                // 启动健康检测（每 30 秒检查进程存活）
                this.startHealthCheck(child);
                resolve();
            });
        });
    }

    /**
     * 启动健康检测定时器
     * 每 30 秒检查进程是否存活，异常退出时清理 pending 请求
     */
    private startHealthCheck(proc: ChildProcess): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }

        this.healthCheckTimer = setInterval(() => {
            if (!proc || proc.killed) {
                console.error('[claude-provider] health check: process not alive, cleaning up');
                this.ready = false;
                this.process = null;
                this.startPromise = null;

                if (this.healthCheckTimer) {
                    clearInterval(this.healthCheckTimer);
                    this.healthCheckTimer = null;
                }

                // Reject 所有 pending 请求
                for (const [, req] of this.pendingRequests) {
                    req.reject(new Error('Bridge process not alive (health check)'));
                }
                this.pendingRequests.clear();
                this.sessionRequests.clear();
            }
        }, 30000); // 30 秒检查一次
    }

    /**
     * 处理 bridge 发来的 JSON-RPC 2.0 消息
     *
     * 三种消息类型：
     * 1. Notification（有 method，无 id） — 流式事件，通过 params.sessionId 关联 PendingRequest
     * 2. Response（有 id + result/error，无 method） — agent.execute 的最终响应
     */
    private handleMessage(msg: Record<string, unknown>) {
        // 仅处理 JSON-RPC 2.0 消息
        if (msg.jsonrpc !== '2.0') return;

        const hasId = msg.id !== undefined && msg.id !== null;
        const hasMethod = typeof msg.method === 'string';
        const hasResult = msg.result !== undefined;
        const hasError = msg.error !== undefined;

        // ── Notification（method，无 id）──
        if (hasMethod && !hasId) {
            this.handleNotification(msg.method as string, msg.params as Record<string, unknown> | undefined);
            return;
        }

        // ── Response（id + result/error，无 method）──
        if (hasId && !hasMethod && (hasResult || hasError)) {
            this.handleJsonRpcResponse(msg.id as string, msg.result, msg.error);
            return;
        }
    }

    /**
     * 处理 JSON-RPC Notification（流式事件）
     *
     * 归属解析优先级：params.requestId（bridge 精确标注发起请求）→ sessionId 反向索引
     * → 唯一在飞请求兜底。解析失败**必须留痕**：此前这里是两处静默 `return`，
     * 事件被丢掉后前端工具行永远转圈，且现场没有任何日志可查（本次工具行不收敛的根因之一）。
     */
    private handleNotification(method: string, params?: Record<string, unknown>) {
        const sessionId = params?.sessionId as string | undefined;
        const requestId = params?.requestId === undefined || params?.requestId === null
            ? undefined
            : String(params.requestId);

        switch (method) {
            case 'agent.ready':
                this.ready = true;
                this.startPromise = null;
                for (const cb of this.readyCallbacks) cb();
                this.readyCallbacks = [];
                return;

            case 'agent.session':
                if (sessionId) {
                    // 找到第一个没有 sessionId 的 pending 请求（刚创建的）
                    for (const [, req] of this.pendingRequests) {
                        if (!req.sessionId) {
                            req.sessionId = sessionId;
                            this.sessionRequests.set(sessionId, req);
                            break;
                        }
                    }
                }
                return;

            case 'agent.output':
            case 'agent.thinking':
            case 'agent.tool_use':
            case 'agent.tool_result':
            case 'agent.permission_required':
                // 所有流式通知按 requestId / sessionId 归属
                break;
            default:
                return; // 未知通知，忽略
        }

        const req = this.resolveRequest(method, requestId, sessionId);
        if (!req) return;

        switch (method) {
            case 'agent.output':
                if (params?.content) {
                    req.stdout += params.content as string;
                    req.onOutput?.(params.content as string);
                }
                break;

            case 'agent.thinking':
                if (params?.content) {
                    req.stdout += params.content as string;
                    req.onOutput?.(params.content as string, {type: 'thinking'});
                }
                break;

            case 'agent.tool_use':
                req.onOutput?.('', {
                    type: 'tool_use',
                    toolName: params?.toolName as string,
                    toolInput: params?.toolInput,
                    toolUseId: params?.toolUseId as string,
                });
                break;

            case 'agent.tool_result':
                req.onOutput?.(params?.content as string, {
                    type: 'tool_result',
                    toolUseId: params?.toolUseId as string,
                    isError: params?.isError as boolean,
                });
                break;

            case 'agent.permission_required':
                req.onPermissionRequest?.({
                    permissionRequestId: params?.permissionRequestId,
                    toolName: params?.toolName,
                    toolInput: params?.toolInput,
                    toolUseId: params?.toolUseId,
                    title: params?.title,
                    displayName: params?.displayName,
                });
                break;
        }
    }

    /**
     * 解析流式事件归属的请求：requestId（精确）→ sessionId（反向索引）→ 唯一在飞请求兜底。
     *
     * sessionId 反向索引在「会话续接复用同一 sessionId」「压缩换 sessionId」
     * 「并发查询」下会错配/查不到，事件就会被丢弃 —— 因此优先用 bridge 标注的 requestId，
     * 并在兜底/丢弃时打日志留痕，不再静默吞事件。
     */
    private resolveRequest(
        method: string,
        requestId: string | undefined,
        sessionId: string | undefined,
    ): PendingRequest | undefined {
        if (requestId) {
            const byRequest = this.pendingRequests.get(requestId);
            if (byRequest) return byRequest;
            console.warn(`[claude-provider] 通知 ${method} 的 requestId=${requestId} 已无对应请求，退回会话归属`);
        }
        if (sessionId) {
            const bySession = this.sessionRequests.get(sessionId);
            if (bySession) return bySession;
        }
        const inFlight = [...this.pendingRequests.values()].filter(r => !r.aborted);
        if (inFlight.length === 1) {
            console.warn(
                `[claude-provider] 通知 ${method} 无归属（requestId=${requestId ?? 'null'} sessionId=${sessionId ?? 'null'}），`
                + '兜底投递给唯一在飞请求',
            );
            return inFlight[0];
        }
        console.error(
            `[claude-provider] 丢弃通知 ${method}：requestId=${requestId ?? 'null'} sessionId=${sessionId ?? 'null'} `
            + `匹配不到请求（在飞 ${inFlight.length}/${this.pendingRequests.size}）`,
        );
        return undefined;
    }

    /**
     * 处理 JSON-RPC Response（agent.execute 的最终结果）
     */
    private handleJsonRpcResponse(id: string, result?: unknown, error?: unknown) {
        const req = this.pendingRequests.get(id);
        if (!req) return; // 已清理（如 abort），忽略

        this.pendingRequests.delete(id);
        if (req.sessionId && this.sessionRequests.get(req.sessionId) === req) this.sessionRequests.delete(req.sessionId);

        if (error) {
            const errObj = error as { code?: number; message?: string; data?: unknown };
            const errMsg = errObj.message || 'Unknown error';
            req.onError?.(errMsg);
            req.resolve({
                exitCode: 1,
                stdout: req.stdout,
                stderr: errMsg,
                aborted: req.aborted,
                sessionId: req.sessionId,
            });
        } else {
            const res = result as {
                exitCode?: number;
                sessionId?: string;
                maxTurnsReached?: boolean;
                numTurns?: number | null;
            } | undefined;
            req.resolve({
                exitCode: res?.exitCode ?? 0,
                stdout: req.stdout,
                stderr: '',
                aborted: req.aborted,
                sessionId: res?.sessionId || req.sessionId,
                // 单轮步数上限：透传给协调器做自动续跑（不是失败）
                ...(res?.maxTurnsReached ? {maxTurnsReached: true} : {}),
                ...(typeof res?.numTurns === 'number' ? {turnsUsed: res.numTurns} : {}),
            });
        }
    }

    /**
     * 通知 bridge 中止正在执行的查询（JSON-RPC agent.abort，fire-and-forget）。
     * 传入发起该查询的 JSON-RPC id 时按请求粒度中止（并发执行下不误伤其它查询）；
     * bridge 触发 SDK abortSignal 结束旧查询，避免与续跑轮的 agent.execute 并发。
     * 无活动请求时 bridge 幂等 ack，进程未就绪时静默跳过。
     */
    private sendAbort(requestId?: string): void {
        const proc = this.process;
        if (!proc || !proc.stdin || !this.ready) return;
        const jsonRpcId = String(++this.jsonRpcIdCounter);
        proc.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: jsonRpcId,
            method: 'agent.abort',
            params: requestId ? {requestId} : {},
        }) + '\n');
    }

    /**
     * 反向写回工具权限决策给 bridge（JSON-RPC agent.confirmPermission 方法调用）
     * 唤醒 bridge 中挂起的 canUseTool Promise
     */
    confirmPermission(permissionRequestId: string, decision: 'allow' | 'deny', message?: string, modifiedInput?: Record<string, unknown>): void {
        const proc = this.process;
        if (proc && proc.stdin) {
            const jsonRpcId = String(++this.jsonRpcIdCounter);
            proc.stdin.write(JSON.stringify({
                jsonrpc: '2.0',
                id: jsonRpcId,
                method: 'agent.confirmPermission',
                params: {
                    permissionRequestId,
                    decision,
                    ...(message ? {message} : {}),
                    ...(modifiedInput ? {modifiedInput} : {}),
                },
            }) + '\n');
        }
    }
}

/** 读 .md 文件并写入 map（已存在则跳过） */
function addMdSkill(filePath: string, name: string, source: string, map: Map<string, SkillInfo>): void {
    if (map.has(name)) return;
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        map.set(name, {
            name,
            description: extractDescription(content),
            enabled: true,
            filePath,
            source,
        });
    } catch { /* skip unreadable */
    }
}

/**
 * 扫描个人技能目录 ~/.claude/skills/
 * - 子目录 <name>/SKILL.md → 名 <name>
 * - 根 .md 文件 → 名 <name>（去 .md）
 */
function scanSkillsDir(dir: string, _prefix: string, source: string, map: Map<string, SkillInfo>): void {
    if (!fs.existsSync(dir)) return;
    try {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.isDirectory()) {
                const mdFile = findSkillMdFile(path.join(dir, entry.name));
                if (mdFile) addMdSkill(mdFile, entry.name, source, map);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                addMdSkill(path.join(dir, entry.name), entry.name.replace(/\.md$/, ''), source, map);
            }
        }
    } catch { /* ignore */
    }
}

/**
 * 递归扫描命令目录（commands 下所有 md 文件，含子目录）
 * 子目录命令名带前缀：paddleocr/http-doc-workflow.md → paddleocr:http-doc-workflow
 * @param dir    当前目录
 * @param prefix 已积累的前缀（含末尾冒号，顶层为空）
 */
function scanCommandsDir(dir: string, prefix: string, map: Map<string, SkillInfo>): void {
    if (!fs.existsSync(dir)) return;
    try {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.isFile() && entry.name.endsWith('.md')) {
                const name = `${prefix}${entry.name.replace(/\.md$/, '')}`;
                addMdSkill(path.join(dir, entry.name), name, 'command', map);
            } else if (entry.isDirectory()) {
                // 递归子目录，前缀累积
                scanCommandsDir(path.join(dir, entry.name), `${prefix}${entry.name}:`, map);
            }
        }
    } catch { /* ignore */
    }
}

/** installed_plugins.json 中单个插件的安装条目 */
interface InstalledPluginEntry {
    installPath: string;
}

/** 读取插件 manifest（installPath/.claude-plugin/plugin.json），失败返回 null */
function readPluginManifest(installPath: string): Record<string, unknown> | null {
    const manifestPath = path.join(installPath, '.claude-plugin', 'plugin.json');
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * 解析插件声明的技能目录（绝对路径）。严格只认 skills 目录，不扫插件根：
 * - manifest 有 skills 字段（字符串或数组，如 "./skills/"）：仅保留指向 skills 的目录
 * - 无 manifest 或无 skills 字段：回退到约定 installPath/skills（不存在则空）
 */
function resolvePluginSkillDirs(installPath: string): string[] {
    const manifest = readPluginManifest(installPath);
    const dirs: string[] = [];

    if (manifest && manifest.skills !== undefined) {
        const raw = manifest.skills as unknown;
        const arr = Array.isArray(raw) ? raw : [raw];
        for (const rel of arr) {
            if (typeof rel !== 'string') continue;
            // ponytail: 只认 skills 类目录，忽略 ./commands/ 等非技能声明
            if (!rel.includes('skills')) continue;
            const abs = path.resolve(installPath, rel);
            if (fs.existsSync(abs)) dirs.push(abs);
        }
        if (dirs.length) return dirs;
    }

    // 约定回退：仅 installPath/skills
    const skillsSub = path.join(installPath, 'skills');
    return fs.existsSync(skillsSub) ? [skillsSub] : [];
}

/** 计算 SKILL.md 内容指纹（大小 + 前 1KB 文本），用于跨插件去重 monorepo 重复内容 */
function skillContentFingerprint(filePath: string): string {
    try {
        const stat = fs.statSync(filePath);
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(1024);
        const bytes = fs.readSync(fd, buf, 0, 1024, 0);
        fs.closeSync(fd);
        return `${stat.size}:${buf.subarray(0, bytes).toString('utf-8')}`;
    } catch {
        return '';
    }
}

/**
 * 扫描插件技能（权威来源 installed_plugins.json）：
 * 1. 对每个插件按 manifest 解析技能目录
 * 2. 扫目录下 SKILL.md，名 <plugin>:<skillDir>
 * 3. 用内容指纹全局去重（context-engineering 等 monorepo 多插件共享内容，避免重复）
 */
function scanPluginSkills(installedFile: string, map: Map<string, SkillInfo>): void {
    let raw: string;
    try {
        raw = fs.readFileSync(installedFile, 'utf-8');
    } catch {
        return; // 无插件清单则跳过
    }

    let pluginsObj: Record<string, InstalledPluginEntry[]>;
    try {
        const parsed = JSON.parse(raw);
        pluginsObj = parsed?.plugins ?? parsed; // 兼容 {plugins:{...}} 或直接 {...}
        if (!pluginsObj || typeof pluginsObj !== 'object') return;
    } catch {
        return;
    }

    const contentSeen = new Set<string>(); // 全局内容指纹去重

    for (const [key, entries] of Object.entries(pluginsObj)) {
        const pluginName = key.split('@')[0];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            if (!entry?.installPath || !fs.existsSync(entry.installPath)) continue;
            for (const skillDir of resolvePluginSkillDirs(entry.installPath)) {
                // 每个 skills 目录只取一层：<skillName>/SKILL.md
                for (const skillMd of findSkillMdFiles(skillDir, 1)) {
                    const fp = skillContentFingerprint(skillMd);
                    if (fp && contentSeen.has(fp)) continue; // monorepo 重复内容跳过
                    if (fp) contentSeen.add(fp);
                    const skillName = path.basename(path.dirname(skillMd));
                    addMdSkill(skillMd, `${pluginName}:${skillName}`, 'plugin', map);
                }
            }
        }
    }
}

/** 递归查找目录下所有 SKILL.md（限定深度避免无限递归，跳过 .git/node_modules） */
function findSkillMdFiles(rootDir: string, maxDepth = 2): string[] {
    const results: string[] = [];
    const walk = (dir: string, depth: number): void => {
        if (depth > maxDepth) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true});
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (entry.name === '.git' || entry.name === 'node_modules') continue;
                walk(path.join(dir, entry.name), depth + 1);
            } else if (entry.isFile() && entry.name === 'SKILL.md') {
                results.push(path.join(dir, entry.name));
            }
        }
    };
    walk(rootDir, 0);
    return results;
}

/** 根据命令推断 MCP 服务器类型 */
function inferServerType(command?: string): string {
    if (!command) return 'custom';
    if (command.includes('node') || command.includes('npx')) return 'node';
    if (command.includes('python') || command.includes('uvx')) return 'python';
    if (command.includes('docker')) return 'docker';
    return 'custom';
}
