#!/usr/bin/env node
/**
 * Claude Bridge - Claude Agent SDK 持久化桥接进程（JSON-RPC 2.0 协议）
 *
 * 作为独立子进程运行，封装 @anthropic-ai/claude-agent-sdk。
 * 采用 JSON-RPC 2.0 协议：从 stdin 逐行读取 JSON-RPC Request，
 * 向 stdout 逐行写入 JSON-RPC Response / Notification。
 *
 * === Server Methods（父进程 → Bridge，带 id，期待 Response）===
 *   agent.execute          — 执行 AI 对话（长时阻塞，完成时才响应）
 *   agent.confirmPermission — 反向写回工具权限决策
 *   agent.ping             — 健康检查
 *
 * === Notifications（Bridge → 父进程，无 id，不期待 Response）===
 *   agent.ready             — 进程启动就绪
 *   agent.output            — AI 文本输出
 *   agent.thinking          — AI 思考过程
 *   agent.tool_use          — 工具调用事件
 *   agent.tool_result       — 工具结果事件
 *   agent.session           — 会话标识
 *   agent.permission_required — 需要权限确认
 *
 * === JSON-RPC 错误码 ===
 *   -32700  Parse error
 *   -32600  Invalid Request
 *   -32601  Method not found
 *   -32602  Invalid params
 *   -32000  Agent execution error
 *   -32001  Agent rate limited (529/429)
 */

// 在导入 SDK 之前配置 CLI 身份标识
process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
process.env.USER_TYPE = 'external';
delete process.env.CLAUDE_AGENT_SDK_VERSION;

import {query} from '@anthropic-ai/claude-agent-sdk';
import {execSync} from 'child_process';
import {createRequire} from 'module';
import {existsSync, appendFileSync} from 'fs';
import {join} from 'path';
import os from 'os';
import readline from 'readline';
import crypto from 'crypto';

// 轻量诊断日志开关：通过环境变量 BRIDGE_DEBUG_LOG 指定日志文件路径，未指定则关闭
const DBG_FILE = process.env.BRIDGE_DEBUG_LOG || '';

function dbg(tag, data) {
    if (!DBG_FILE) return;
    try {
        const text = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 1200);
        appendFileSync(DBG_FILE, `[${new Date().toISOString()}] ${tag}: ${text}\n`);
    } catch { /* ignore */
    }
}

/**
 * 解析 Claude CLI 可执行文件路径
 *
 * 按优先级依次在以下位置查找 claude-code/cli.js：
 * 1. 用户全局 npm 目录（Windows）
 * 2. 当前项目 node_modules
 * 3. 通过 require.resolve 动态解析
 *
 * @returns CLI 路径字符串，未找到时返回 null
 */
function resolveClaudeCliPath() {
    // 允许通过环境变量显式指定 CLI 路径
    if (process.env.CLAUDE_CODE_CLI_PATH) {
        return existsSync(process.env.CLAUDE_CODE_CLI_PATH) ? process.env.CLAUDE_CODE_CLI_PATH : null;
    }

    const candidates = [
        // 原生安装器（claude 直装用户目录，桌面瘦身包不随附 SDK 二进制时的首选回退）
        join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
        join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
    ];

    for (const p of candidates) {
        if (existsSync(p)) return p;
    }

    // PATH 查找（where/which）：仅接受真实可执行（claude.exe / claude），
    // 跳过 .cmd/.ps1 shim——SDK 直接 spawn 不经 shell，shim 无法执行
    try {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        const found = execSync(`${finder} claude`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
        })
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        const real = found.find((p) => /claude(\.exe)?$/i.test(p) && existsSync(p));
        if (real) return real;
    } catch {
        // PATH 无 claude，继续回退
    }

    try {
        const require = createRequire(import.meta.url);
        return require.resolve('@anthropic-ai/claude-code/cli.js');
    } catch {
        return null;
    }
}

const CLI_PATH = resolveClaudeCliPath();

// ═══════════════════════════════════════════════════════════════
// JSON-RPC 2.0 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 向 stdout 写入 JSON-RPC 2.0 成功响应
 * @param {string|number} id - 请求 id
 * @param {object} result - 结果对象
 */
function emitJsonRpcResponse(id, result) {
    process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        result,
    }) + '\n');
}

/**
 * 向 stdout 写入 JSON-RPC 2.0 错误响应
 * @param {string|number|null} id - 请求 id（Parse error 时可为 null）
 * @param {number} code - 错误码
 * @param {string} message - 错误消息
 * @param {object} [data] - 可选的附加数据
 */
function emitJsonRpcError(id, code, message, data) {
    const error = {code, message};
    if (data !== undefined) error.data = data;
    process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: id ?? null,
        error,
    }) + '\n');
}

/**
 * 向 stdout 写入 JSON-RPC 2.0 通知（无 id）
 * @param {string} method - 通知方法名
 * @param {object} [params] - 通知参数
 */
function emitNotification(method, params) {
    const msg = {jsonrpc: '2.0', method};
    if (params !== undefined) msg.params = params;
    process.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * 发出**请求作用域**的通知：在 params 上附加发起该查询的 requestId。
 *
 * 父进程据此把事件精确路由回发起请求的调用方，不再只依赖 sessionId 反向索引
 * ——会话续接 / 压缩换 session / 并发查询时，sessionId 映射会错配或查不到，
 * 事件就会被静默丢弃（表现为工具行永远转圈）。requestId 是唯一无歧义的关联键。
 * @param {string|number} requestId - agent.execute 的 JSON-RPC id
 * @param {string} method - 通知方法名
 * @param {object} [params] - 通知参数
 */
function emitQueryNotification(requestId, method, params) {
    emitNotification(method, {...(params || {}), requestId});
}

// 保留旧 emit 作为底层兼容（供 uncaughtException 等无会话场景使用）
function emit(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

// ═══════════════════════════════════════════════════════════════
// 权限确认机制
// ═══════════════════════════════════════════════════════════════

/**
 * 等待用户权限决策的 Promise resolver，按 permissionRequestId 索引。
 * canUseTool 触发时存入，agent.confirmPermission 方法唤醒。
 */
const pendingPermissionResolvers = new Map();

/**
 * 创建 canUseTool 回调（仅当调用方启用权限确认时注入到 options）。
 * 触发时发送 agent.permission_required 通知（带 requestId，父进程可精确路由），
 * 等待 agent.confirmPermission 方法调用唤醒；叠加 10 分钟超时与 SDK abort 兜底，
 * 避免 query 永久挂起。
 * @param {string|number} requestId - 发起本次查询的 JSON-RPC id
 * @param {() => string|null} getSessionId - 读取本次查询当前 sessionId
 */
function createCanUseTool(requestId, getSessionId) {
    return async (toolName, input, o) => {
        const permissionRequestId = crypto.randomUUID();
        emitQueryNotification(requestId, 'agent.permission_required', {
            sessionId: getSessionId(),
            permissionRequestId,
            toolName: toolName || '',
            toolInput: input || {},
            toolUseId: o?.toolUseID || '',
            title: o?.title || '',
            displayName: o?.displayName || '',
        });

        // 等待 agent.confirmPermission 方法调用唤醒
        const resolverPromise = new Promise((resolve) => {
            pendingPermissionResolvers.set(permissionRequestId, resolve);
        });

        // 超时兜底：10 分钟无响应自动拒绝
        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => resolve({behavior: 'deny', message: '权限确认超时（10 分钟），已自动拒绝'}), 10 * 60 * 1000);
        });

        // abort 兜底：SDK 中止该 query 时立即拒绝
        const signalPromise = o?.signal
            ? new Promise((resolve) => {
                if (o.signal.aborted) resolve({behavior: 'deny', message: '执行已中止'});
                else o.signal.addEventListener('abort', () => resolve({
                    behavior: 'deny',
                    message: '执行已中止'
                }), {once: true});
            })
            : new Promise(() => {
            }); // 永不 resolve，被 race 忽略

        const decision = await Promise.race([resolverPromise, timeoutPromise, signalPromise]);
        pendingPermissionResolvers.delete(permissionRequestId);
        return decision; // {behavior:'allow'} | {behavior:'deny', message}
    };
}

// ═══════════════════════════════════════════════════════════════
// SDK 查询与重试
// ═══════════════════════════════════════════════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isOverloaded = (msg) => /529|429|overloaded|访问量过大|使用上限|rate.?limit|too many requests/i.test(msg || '');

/**
 * 活动查询表：requestId(string) → {abortController}。
 * 按请求粒度登记，agent.abort 才能只中止目标查询（此前是单个全局句柄，
 * 并发执行时互相踩：中止 A 会误伤 B，且后发查询会覆盖先发查询的句柄）。
 */
const activeQueries = new Map();

/**
 * 执行一次 SDK query（流式发送通知；每条通知带 requestId 供父进程精确路由）。
 * sessionId 是**本次查询的局部状态**（由首个 system 消息给出）——此前是模块级全局变量，
 * 并发/续接查询互相串线，事件会被路由到错误的请求后丢弃（工具行永远转圈）。
 * @param {string} prompt - 提示词
 * @param {object} options - SDK options
 * @param {string|number} requestId - 发起本次查询的 JSON-RPC id
 * @returns {Promise<{status: 'done'|'overloaded'|'error', error?: string, sessionId?: string|null}>}
 */
async function runQueryOnce(prompt, options, requestId) {
    const notify = (method, params) => emitQueryNotification(requestId, method, params);
    let sessionId = null;
    for await (const msg of query({prompt, options})) {
        if (msg.type === 'system' && msg.session_id) {
            sessionId = msg.session_id;
            notify('agent.session', {sessionId});
        }
        if (msg.type === 'assistant') {
            const content = msg.message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === 'text' && block.text) {
                        notify('agent.output', {sessionId, content: block.text});
                    } else if (block.type === 'thinking' && block.thinking) {
                        notify('agent.thinking', {sessionId, content: block.thinking});
                    } else if (block.type === 'tool_use') {
                        notify('agent.tool_use', {
                            sessionId,
                            toolName: block.name || '',
                            toolInput: block.input || {},
                            toolUseId: block.id || '',
                        });
                    }
                }
            }
        }
        // SDK 的 tool_result 在 user 类型消息中（API 把工具结果作为 user turn 返回）
        if (msg.type === 'user') {
            const content = msg.message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === 'tool_result') {
                        notify('agent.tool_result', {
                            sessionId,
                            toolUseId: block.tool_use_id || '',
                            isError: block.is_error || false,
                            content: typeof block.content === 'string'
                                ? block.content
                                : JSON.stringify(block.content ?? ''),
                        });
                    }
                }
            }
        }
        if (msg.type === 'result') {
            dbg('result', {
                is_error: msg.is_error,
                subtype: msg.subtype,
                terminalReason: msg.terminal_reason,
                result: msg.is_error ? msg.result : undefined,
                totalMs: msg.duration_ms,
                numTurns: msg.num_turns,
            });
            if (msg.is_error) {
                const classified = classifyResultError(msg);
                if (classified.kind === 'max_turns') {
                    // 步数上限**不是失败**：会话已持久化，父进程可带着同一会话再跑一批。
                    // 此前这里当成普通错误返回，用户看到的是「执行失败（退出码 1）: SDK error:
                    // error_max_turns | no detail」——把正常的步数边界误报成故障。
                    return {status: 'max_turns', sessionId, numTurns: msg.num_turns};
                }
                return isOverloaded(classified.message)
                    ? {status: 'overloaded', error: classified.message}
                    : {status: 'error', error: classified.message};
            }
        }
    }
    return {status: 'done', sessionId};
}

/**
 * 把 SDK 的 result 错误分类成人话。
 *
 * SDK 的 TerminalReason 明确区分「步数上限」与「上下文超长」：
 *   max_turns / budget_exhausted / prompt_too_long / blocking_limit …
 * `subtype` 则是 error_max_turns / error_max_budget_usd / error_during_execution 等。
 * 此前一律拼成 `SDK error: <subtype> | no detail`，用户完全无法据此行动。
 *
 * @param {object} msg - SDK 的 result 消息
 * @returns {{kind: 'max_turns'|'prompt_too_long'|'budget'|'other', message: string}}
 */
export function classifyResultError(msg) {
    const subtype = msg.subtype || '';
    const terminal = msg.terminal_reason || '';
    if (subtype === 'error_max_turns' || terminal === 'max_turns') {
        return {kind: 'max_turns', message: `已达单轮步数上限（${msg.num_turns ?? '?'} 轮）`};
    }
    if (terminal === 'prompt_too_long' || terminal === 'blocking_limit') {
        return {
            kind: 'prompt_too_long',
            message: '上下文过长（prompt too long）：可用 /compact 压缩后再继续，或新建会话',
        };
    }
    if (subtype === 'error_max_budget_usd' || terminal === 'budget_exhausted') {
        return {kind: 'budget', message: '已达本轮预算上限（max budget usd）'};
    }
    if (typeof msg.result === 'string' && msg.result.trim()) {
        return {kind: 'other', message: msg.result};
    }
    const detail = msg.result == null ? 'no detail' : JSON.stringify(msg.result);
    const suffix = terminal ? `（${terminal}）` : '';
    return {kind: 'other', message: `SDK error: ${subtype || 'unknown'}${suffix} | ${detail}`};
}

/**
 * 发送限流重试通知，并按指数退避等待。
 * @param {number} attempt - 当前重试序号（从 0 起）
 * @param {string} errorMsg - 触发重试的错误信息
 * @param {number} maxRetries - 最大重试次数
 * @param {(method: string, params?: object) => void} notify - 请求作用域的通知器
 * @param {string|null} sessionId - 本次查询的 sessionId
 */
async function waitForRetry(attempt, errorMsg, maxRetries, notify, sessionId) {
    const wait = Math.min(2 ** attempt * 1000, 8000);
    notify('agent.output', {
        sessionId,
        content: `\n\n[模型限流(${errorMsg?.includes('429') ? '429' : '529'})，${Math.round(wait / 1000)}s 后重试 ${attempt + 1}/${maxRetries}...]\n\n`,
    });
    dbg('retry-rate-limit', {attempt: attempt + 1, wait, error: errorMsg});
    await sleep(wait);
}

// ═══════════════════════════════════════════════════════════════
// JSON-RPC Method 处理
// ═══════════════════════════════════════════════════════════════

/**
 * 处理 agent.execute — 执行 AI 对话（含 529 限流自动重试）
 *
 * 长时阻塞：Agent 完全结束（含所有权限确认）后才发 JSON-RPC Response。
 * 期间流式事件通过 Notification 发送。
 */
async function handleExecute(msg) {
    const params = msg.params || {};
    const {
        prompt,
        cwd,
        sessionId,
        maxTurns = 10,
        skills,
        mcpServers,
        model,
        reasoningEffort,
        extendedThinking,
        permissionEnabled,
        permissionMode,
        allowDangerouslySkipPermissions,
    } = params;

    if (!prompt) {
        emitJsonRpcError(msg.id, -32602, 'Invalid params: prompt is required');
        return;
    }

    dbg('req-start', {
        id: msg.id,
        model,
        extendedThinking,
        maxTurns,
        sessionId: !!sessionId,
        promptLen: prompt?.length,
        cwd,
        skills,
        mcpServers: mcpServers ? Object.keys(mcpServers) : undefined,
        permissionEnabled,
    });

    // 中止控制器：本次查询的取消句柄（父进程经 agent.abort 触发「立即处理」中断）。
    // 按 requestId 登记 —— 并发查询各自可被精确中止，不再互相误伤。
    const abortController = new AbortController();
    const requestKey = String(msg.id);
    activeQueries.set(requestKey, {abortController});
    // 请求作用域的事件发射器（限流重试等查询期通知也走它，保证带 requestId）
    const notify = (method, params) => emitQueryNotification(msg.id, method, params);
    /** 本次查询最近一次拿到的 sessionId（重试通知与错误响应回传用） */
    let querySessionId = null;

    const options = {
        cwd: cwd || process.cwd(),
        maxTurns,
        // SDK 中止句柄：选项名是 **abortController**（传 controller 本体，不是 signal）。
        // 此前写的是 abortSignal（SDK 里没有这个名字）→ 被静默忽略，
        // 「立即处理 / 中止」在 SDK 层面从未生效，旧查询仍在后台跑完。
        abortController,
        // 权限模式由服务端按全局配置下发（default/acceptEdits/bypassPermissions），缺省 acceptEdits
        permissionMode: permissionMode || 'acceptEdits',
        // bypassPermissions 在无头模式下需要显式接受免责声明，否则 CLI 静默降级为
        // default：MCP 等工具全部走 ask 分支并被无头自动拒绝（"you haven't granted it yet"）。
        ...(allowDangerouslySkipPermissions ? {allowDangerouslySkipPermissions: true} : {}),
        ...(sessionId ? {resume: sessionId} : {}),
        ...(skills ? {skills} : {}),
        ...(mcpServers ? {mcpServers} : {}),
        // 自动压缩：上下文将满时自动压缩对话，避免 "prompt too long" 直接失败。
        // 注意选项名必须是 SDK 声明的 `autoCompactEnabled` / `autoCompactWindow`
        // ——此前写的是 `compactWindow`（SDK 里不存在这个名字），被静默忽略，
        // 等于「自动压缩」从未生效；窗口大小可用环境变量覆盖。
        autoCompactEnabled: true,
        ...(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
            ? {autoCompactWindow: parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 10)}
            : {}),
    };

    // 权限确认：仅当调用方启用时注入 canUseTool
    // permissionMode 保持 acceptEdits，Bash 等仍需 prompt 的工具会触发回调
    if (permissionEnabled) {
        options.canUseTool = createCanUseTool(msg.id, () => querySessionId);
    }

    if (model) {
        options.model = model;
    }

    // 扩展思考与推理力度：新版 SDK(0.3.278+)的一等选项 thinking/effort。
    // 旧的 additionalArgs 数组形式已被 SDK 移除，CLI 参数 --thinking/--reasoning-effort 不再可用
    if (extendedThinking) {
        options.thinking = {type: 'enabled'};
        // 推理力度仅在与 thinking 一起时设置（与旧行为一致）
        if (reasoningEffort) {
            if (['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) {
                options.effort = reasoningEffort;
            } else {
                dbg('warning', {message: `Unknown reasoningEffort value: ${reasoningEffort}`});
            }
        }
    }
    if (CLI_PATH) {
        options.pathToClaudeCodeExecutable = CLI_PATH;
    }

    try {
        // 529/429 限流指数退避重试：1s/2s/4s（封顶 8s），最多 3 次。
        const maxRetries = 3;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const runResult = await runQueryOnce(prompt, options, msg.id);
                if (runResult.sessionId) querySessionId = runResult.sessionId;
                if (runResult.status === 'done') {
                    emitJsonRpcResponse(msg.id, {
                        exitCode: 0,
                        sessionId: runResult.sessionId || '',
                    });
                    return;
                }
                if (runResult.status === 'max_turns') {
                    // 步数上限：不是失败。带标记返回，父进程可续跑同一会话（继续消耗剩余额度）
                    emitJsonRpcResponse(msg.id, {
                        exitCode: 0,
                        sessionId: runResult.sessionId || '',
                        maxTurnsReached: true,
                        numTurns: runResult.numTurns ?? null,
                    });
                    return;
                }
                const lastError = runResult.error || 'Unknown error';
                if (runResult.status === 'overloaded' && attempt < maxRetries) {
                    await waitForRetry(attempt, lastError, maxRetries, notify, querySessionId);
                    continue;
                }
                emitJsonRpcError(msg.id, -32000, lastError, {sessionId: runResult.sessionId || ''});
                return;
            } catch (err) {
                const lastError = err.message || String(err);
                // agent.abort 中止：父进程已提前本地返回（立即处理语义），此响应无人等待，仅记日志
                if (abortController.signal.aborted) {
                    dbg('aborted', {id: msg.id, message: lastError});
                    return;
                }
                dbg('catch', {attempt, message: lastError});
                if (isOverloaded(lastError) && attempt < maxRetries) {
                    await waitForRetry(attempt, lastError, maxRetries, notify, querySessionId);
                    continue;
                }
                const errorCode = isOverloaded(lastError) ? -32001 : -32000;
                emitJsonRpcError(msg.id, errorCode, lastError, {sessionId: querySessionId || ''});
                return;
            }
        }
    } finally {
        if (activeQueries.get(requestKey)?.abortController === abortController) {
            activeQueries.delete(requestKey);
        }
    }
}

/**
 * 处理 agent.confirmPermission — 反向写回工具权限决策
 *
 * 父进程调用此方法以响应当前的 agent.permission_required 通知，
 * 唤醒挂起的 canUseTool Promise。
 */
function handleConfirmPermission(msg) {
    const {permissionRequestId, decision, message, modifiedInput} = msg.params || {};

    if (!permissionRequestId) {
        emitJsonRpcError(msg.id, -32602, 'Invalid params: permissionRequestId is required');
        return;
    }

    const resolver = pendingPermissionResolvers.get(permissionRequestId);
    if (!resolver) {
        emitJsonRpcError(msg.id, -32602, `Unknown permissionRequestId: ${permissionRequestId}`);
        return;
    }

    // SDK 的 deny 要求 message 必填，此处兜底；allow 的 message 可空
    const behavior = decision === 'allow' ? 'allow' : 'deny';
    const responseMessage = behavior === 'deny'
        ? (message || '用户拒绝了该工具')
        : message;
    const result = {behavior, message: responseMessage};
    // 用户答案透传给 SDK（如 AskUserQuestion）。SDK 的 PermissionResult 认的是 updatedInput，不是 modifiedInput
    if (modifiedInput) result.updatedInput = modifiedInput;
    resolver(result);
    pendingPermissionResolvers.delete(permissionRequestId);

    emitJsonRpcResponse(msg.id, {acknowledged: true});
}

/**
 * 处理 agent.abort — 中止正在执行的查询（「立即处理」语义）。
 *
 * 支持按请求粒度中止：params.requestId 给出时只中止该查询（并发执行下不误伤）；
 * 未给出时中止所有活动查询（向后兼容旧客户端）。
 * 触发 AbortController：SDK 的 abortSignal 使 query 迭代立即结束，
 * 挂起的 canUseTool 经其 signal 兜底同步拒绝。
 */
function handleAbortQuery(msg) {
    const requested = msg.params?.requestId;
    const keys = (requested === undefined || requested === null)
        ? [...activeQueries.keys()]
        : (activeQueries.has(String(requested)) ? [String(requested)] : []);
    for (const key of keys) {
        try {
            activeQueries.get(key)?.abortController.abort(new Error('用户中断当前轮'));
        } catch { /* 已结束的查询：忽略 */ }
    }
    dbg('abort-requested', {targets: keys, requested});
    emitJsonRpcResponse(msg.id, {acknowledged: true, hadActive: keys.length > 0, aborted: keys});
}

// ═══════════════════════════════════════════════════════════════
// JSON-RPC 消息路由
// ═══════════════════════════════════════════════════════════════

/**
 * 路由 JSON-RPC Method Call 到对应处理器
 */
function handleMethodCall(msg) {
    switch (msg.method) {
        case 'agent.execute':
            handleExecute(msg).catch((err) => {
                emitJsonRpcError(msg.id, -32000, err.message || String(err));
            });
            break;
        case 'agent.confirmPermission':
            handleConfirmPermission(msg);
            break;
        case 'agent.abort':
            handleAbortQuery(msg);
            break;
        case 'agent.ping':
            emitJsonRpcResponse(msg.id, {status: 'ok'});
            break;
        default:
            emitJsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
}

// ═══════════════════════════════════════════════════════════════
// 主循环：stdin → JSON-RPC 解析 → 路由
// ═══════════════════════════════════════════════════════════════

const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
});

// 发送就绪通知
emitNotification('agent.ready');

rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
        msg = JSON.parse(trimmed);
    } catch {
        emitJsonRpcError(null, -32700, 'Parse error');
        return;
    }

    // 校验 jsonrpc 版本
    if (!msg.jsonrpc || msg.jsonrpc !== '2.0') {
        emitJsonRpcError(msg.id ?? null, -32600, 'Invalid Request: jsonrpc must be "2.0"');
        return;
    }

    // JSON-RPC Request（有 id + method） — 期待 Response
    if (msg.id !== undefined && msg.method) {
        handleMethodCall(msg);
        return;
    }

    // JSON-RPC Notification（有 method，无 id） — 不期待 Response
    // Bridge 当前不接收来自父进程的通知，但保留兼容性
    if (msg.method && msg.id === undefined) {
        dbg('unhandled-notification', {method: msg.method});
        return;
    }

    // 无效消息
    emitJsonRpcError(msg.id ?? null, -32600, 'Invalid Request');
});

rl.on('close', () => {
    process.exit(0);
});

// 全局异常捕获，防止进程崩溃
process.on('uncaughtException', (err) => {
    emit({type: 'error', message: `Uncaught: ${err.message}`});
    // 不可恢复的错误，优雅退出
    process.exit(1);
});
