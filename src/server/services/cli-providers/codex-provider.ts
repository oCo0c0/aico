/**
 * @module codex-provider
 * @description OpenAI Codex CLI Provider 实现
 *
 * 通过 @openai/codex-sdk 直接调用 Codex CLI，无需子进程桥接。
 * 支持流式输出和会话续接。
 */

import {execSync} from 'child_process';
import path from 'path';
import {getNpmGlobalRoot, resolveSystemCodexBinary} from './codex-binary';
import fs from 'fs';
import os from 'os';
import {getErrorMessage} from '../../utils/error-utils.js';
import {extractDescription, inferServerType} from '../../utils/markdown-utils.js';
import {ModelProviderStore} from '../model-provider-store.js';
import {mergeOwnModelsIntoTiers} from './model-options.js';
import {isolatedPath, isolationEnv} from '../cli-isolation.js';
import type {
    CLIProvider,
    CLIProviderStatus,
    CLIProviderInput,
    CLIProviderModelOptions,
    CLIProviderOptions,
    CLIProviderResult,
    ProviderModelSettings,
    SkillInfo,
    McpServerInfo,
} from './types.js';

/** Codex 配置目录 —— 应用自管隔离目录（首次由 CLI 播种 config.toml / auth.json） */
const CODEX_DIR = isolatedPath('codex');
/** Codex 配置文件路径（TOML 格式，隔离目录内） */
const CODEX_CONFIG_FILE = path.join(CODEX_DIR, 'config.toml');

/**
 * Codex 事件里的 item（判别值为 **snake_case**，见 @openai/codex-sdk 的 ThreadItem 联合）。
 * 此前按 camelCase（agentMessage/commandExecution/toolCall）判定 → 一条都匹配不上，
 * codex 执行时消息流里既没有助手文本也没有工具行。
 */
interface CodexItem {
    id?: string;
    type?: string;
    /** agent_message / reasoning 的文本 */
    text?: string;
    /** command_execution */
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    status?: string;
    /** file_change */
    changes?: Array<{path?: string; kind?: string}>;
    /** mcp_tool_call */
    server?: string;
    tool?: string;
    arguments?: unknown;
    result?: {content?: unknown; structured_content?: unknown};
    /** web_search */
    query?: string;
    /** todo_list */
    items?: Array<{text?: string; completed?: boolean}>;
    /** error */
    message?: string;
}

/** 把 MCP 结果内容块拍平成文本 */
function flattenCodexContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
    const parts: string[] = [];
    for (const block of content) {
        if (typeof block === 'string') parts.push(block);
        else if (block && typeof block === 'object') {
            const b = block as Record<string, unknown>;
            if (typeof b.text === 'string') parts.push(b.text);
            else parts.push(JSON.stringify(b));
        }
    }
    return parts.join('\n');
}

/**
 * 构造 Codex 子进程的隔离环境。
 *
 * SDK 在传入 `env` 时**不再继承 process.env**，因此这里必须带全：
 *   1. process.env 基线（PATH、系统变量等）
 *   2. 隔离 config.toml（`CODEX_HOME` 下，首次从 CLI 播种）—— 由 codex 自己读取
 *   3. **应用模型供应商配置（codex 记录）优先级最高**：OPENAI_API_KEY / OPENAI_BASE_URL / 记录 env
 *   4. `CODEX_HOME` → 应用自有目录（与用户安装的 CLI 完全隔离）
 *
 * 不再改写本进程的 `process.env`（此前 `applyOwnCodexEnv` 会污染服务进程全局环境，
 * 且只填空缺 → 外部 env 反而优先于应用配置）。
 */
export function buildIsolatedCodexEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
    }

    try {
        const rec = new ModelProviderStore().get('codex');
        if (rec && rec.enabled !== false) {
            if (rec.apiKey) {
                env.OPENAI_API_KEY = rec.apiKey;
                env.CODEX_API_KEY = rec.apiKey;
            }
            if (rec.baseUrl) env.OPENAI_BASE_URL = rec.baseUrl;
            if (rec.env && typeof rec.env === 'object') Object.assign(env, rec.env);
        }
    } catch {
        // 读取失败：使用基线环境（隔离 config.toml 仍然生效）
    }

    Object.assign(env, isolationEnv('codex'));
    return env;
}

/** 解析结果：顶层 table + 数组表 */
interface TomlParseResult {
    tables: Record<string, Record<string, unknown>>;
    arrayTables: Record<string, Record<string, unknown>[]>;
}

/**
 * 最小 TOML 解析器 —— 仅处理 `[section]` 表头和 `[[array.section]]` 数组表头，
 * 以及基础值类型（字符串、数字、布尔、内联数组）。
 * 不支持嵌套表、多行字符串、日期等高级特性。
 */
function parseTomlMinimal(content: string): TomlParseResult {
    const result: TomlParseResult = {tables: {}, arrayTables: {}};
    let currentTarget: Record<string, unknown> | null = null;
    let currentKey: string | null = null;
    let isArrayTable = false;

    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        // 跳过空行和注释
        if (!line || line.startsWith('#')) continue;

        // 数组表头 [[xxx.yyy]]
        const arrayMatch = line.match(/^\[\[([^\]]+)\]\]$/);
        if (arrayMatch) {
            currentKey = arrayMatch[1].trim();
            isArrayTable = true;
            if (!result.arrayTables[currentKey]) result.arrayTables[currentKey] = [];
            const entry: Record<string, unknown> = {};
            result.arrayTables[currentKey].push(entry);
            currentTarget = entry;
            continue;
        }

        // 普通表头 [xxx.yyy]
        const tableMatch = line.match(/^\[([^\]]+)\]$/);
        if (tableMatch) {
            currentKey = tableMatch[1].trim();
            isArrayTable = false;
            result.tables[currentKey] = {};
            currentTarget = result.tables[currentKey];
            continue;
        }

        // 键值对
        const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
        if (kvMatch && currentTarget) {
            const [, k, rawVal] = kvMatch;
            currentTarget[k] = parseTomlValue(rawVal.trim());
        }
    }

    return result;
}

/** 解析单个 TOML 值 */
function parseTomlValue(raw: string): unknown {
    // 布尔
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    // 数字
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    // 字符串（双引号或单引号）
    const strMatch = raw.match(/^"(.*)"$/);
    if (strMatch) return strMatch[1];
    const strMatch2 = raw.match(/^'(.*)'$/);
    if (strMatch2) return strMatch2[1];
    // 内联数组
    if (raw.startsWith('[') && raw.endsWith(']')) {
        const inner = raw.slice(1, -1).trim();
        if (!inner) return [];
        return splitArrayElements(inner).map(v => parseTomlValue(v.trim()));
    }
    return raw;
}

/** 分割 TOML 数组元素（处理嵌套引号） */
function splitArrayElements(s: string): string[] {
    const result: string[] = [];
    let current = '';
    let inStr = false;
    let strChar = '';
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            current += c;
            if (c === strChar && s[i - 1] !== '\\') inStr = false;
        } else if (c === '"' || c === "'") {
            inStr = true;
            strChar = c;
            current += c;
        } else if (c === '[') {
            depth++;
            current += c;
        } else if (c === ']') {
            depth--;
            current += c;
        } else if (c === ',' && depth === 0) {
            result.push(current);
            current = '';
        } else {
            current += c;
        }
    }
    if (current.trim()) result.push(current);
    return result;
}

/**
 * OpenAI Codex CLI Provider
 * @description 通过 @openai/codex-sdk 直接 Node.js 调用，无需子进程
 */
export class CodexProvider implements CLIProvider {
    readonly id = 'codex' as const;
    readonly label = 'OpenAI Codex';

    readonly capabilities = {
        supportsPermission: false,
        supportsRuntimeSkills: false,
        supportsRuntimeMcp: false,
        supportsMaxTurns: false,
        supportsReasoningEffort: false,
        supportsExtendedThinking: false,
        supportsCustomEndpoint: false,
    } as const;

    /** 默认模型配置（cliProvider.models.codex 无存储值时使用） */
    readonly defaultModelSettings: ProviderModelSettings = {
        model: 'codex-mini-latest',
        streaming: true,
    };

    /** Codex SDK 客户端实例 */
    private client: InstanceType<typeof import('@openai/codex-sdk').Codex> | null = null;
    /** 会话 ID → Thread ID 映射 */
    private sessionIdToThreadId = new Map<string, string>();
    /** Thread ID → 会话 ID 映射 */
    private threadIdToSessionId = new Map<string, string>();

    /**
     * 读取本地可提供的模型选项：
     * 1. 从隔离 config.toml 解析当前配置的模型（顶层 model = "xxx" 字段），置前；
     * 2. 合并自有模型供应商配置（~/.aico/models.json 的 codex 记录）中的模型，
     *    使「模型供应商」页添加的模型出现在下拉中（与 claude Provider 同款合并逻辑）。
     *    current 先入列保证 store 的档位校正不会把用户 config.toml 的模型覆盖掉。
     */
    async loadModelOptions(): Promise<CLIProviderModelOptions> {
        let current: string | null = null;
        try {
            if (fs.existsSync(CODEX_CONFIG_FILE)) {
                const raw = fs.readFileSync(CODEX_CONFIG_FILE, 'utf-8');
                // 简单解析顶层 model = "xxx"（在第一个 [section] 之前）
                const sectionIdx = raw.indexOf('\n[');
                const head = sectionIdx >= 0 ? raw.slice(0, sectionIdx) : raw;
                const match = head.match(/^model\s*=\s*"([^"]+)"/m);
                current = match ? match[1] : null;
            }
        } catch { /* ignore */ }

        const tiers: Array<{value: string; label: string; model: string}> = [];
        if (current) tiers.push({value: current, label: current, model: current});
        try {
            const rec = new ModelProviderStore().get('codex');
            return {current, tiers: mergeOwnModelsIntoTiers(tiers, rec)};
        } catch { /* 自有配置读取失败时仅返回当前模型 */ }
        return {tiers};
    }

    async detect(): Promise<CLIProviderStatus> {
        try {
            // 优先检查 codex CLI 是否安装（Windows 用 where，Unix 用 which，抑制 stderr 避免 GBK 乱码）
            let cliPath: string | undefined;
            try {
                const cmd = process.platform === 'win32' ? 'where codex' : 'which codex 2>/dev/null';
                cliPath = execSync(cmd, {encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']}).trim();
            } catch {
                // CLI 未安装，继续检查 SDK
            }

            // 检查 SDK 是否安装（优先用 require.resolve，会自动在应用依赖中查找）
            let sdkPath: string | undefined;
            try {
                const resolved = require.resolve('@openai/codex-sdk/package.json');
                sdkPath = path.dirname(resolved);
            } catch {
                // require.resolve 失败，尝试从执行文件位置查找
                // 找到 __dirname 的真实位置（处理全局安装的符号链接）
                const realDir = fs.realpathSync(__dirname);

                // 从当前文件向上查找，最多尝试 6 级
                let current = realDir;
                for (let i = 0; i < 6; i++) {
                    const candidate = path.join(current, 'node_modules', '@openai', 'codex-sdk');
                    if (fs.existsSync(path.join(candidate, 'package.json'))) {
                        sdkPath = candidate;
                        break;
                    }
                    current = path.dirname(current);
                }
            }

            // CLI 或 SDK 至少一个可用即可
            if (!cliPath && !sdkPath) {
                return {
                    available: false,
                    error: 'Neither codex CLI nor @openai/codex-sdk installed. Run: npm install -g @openai/codex'
                };
            }

            return {
                available: true,
                version: cliPath ? 'codex-cli' : 'codex-sdk',
                path: cliPath || sdkPath,
            };
        } catch (err) {
            return {available: false, error: getErrorMessage(err)};
        }
    }

    async initialize(): Promise<void> {
        // Codex SDK 不需要预启动，按需创建客户端
        this.client = await this.createClient();
    }

    async run(input: CLIProviderInput, options?: CLIProviderOptions): Promise<CLIProviderResult> {
        const client = await this.ensureClient();

        try {
            // 确定是否续接已有 thread。
            // 新版把**真实 threadId** 直接作为 sessionId 持久化（可跨进程续接）；
            // 旧记录里是 `codex-<时间戳>` 占位 id，只能靠进程内映射（重启后必然丢失）。
            let thread: InstanceType<typeof import('@openai/codex-sdk').Thread>;

            if (input.sessionId) {
                const threadId = this.sessionIdToThreadId.get(input.sessionId)
                    ?? (input.sessionId.startsWith('codex-') ? undefined : input.sessionId);
                if (threadId) {
                    thread = client.resumeThread(threadId);
                } else {
                    thread = client.startThread({
                        workingDirectory: input.cwd,
                    });
                }
            } else {
                thread = client.startThread({
                        workingDirectory: input.cwd,
                    });
            }

            // 会话 ID：会话创建前的占位值，拿到 thread 后会被真实 threadId 覆盖
            let sessionId = input.sessionId || `codex-${Date.now()}`;

            let stdout = '';
            let lastErrorMessage = '';
            /** 已发过 tool_use 的 item id（item.started/updated/completed 可能重复投递同一 id） */
            const startedItems = new Set<string>();

            // 使用 runStreamed 获取流式输出
            const {events} = await thread.runStreamed(input.prompt, {
                signal: options?.signal,
                ...(options?.model ? {model: options.model} : {}),
            });

            for await (const event of events) {
                if (options?.signal?.aborted) {
                    break;
                }

                // Codex 的事件契约（@openai/codex-sdk）：
                //   thread.started / turn.started / turn.completed / turn.failed
                //   item.started / item.updated / item.completed（item.type 为 **snake_case**）
                // item 类型：agent_message / reasoning / command_execution / file_change /
                //            mcp_tool_call / web_search / todo_list / error / local_image
                // 归一化到 adw 的 thinking / tool_use / tool_result（与 claude、pi 同构），
                // 工具名使用与前端分类表一致的小写规范名。
                switch (event.type) {
                    case 'item.started':
                    case 'item.updated':
                        this.emitCodexItemStarted(event.item as CodexItem, options, startedItems);
                        break;

                    case 'item.completed': {
                        const item = event.item as CodexItem;
                        stdout += this.emitCodexItemCompleted(item, options, startedItems);
                        break;
                    }

                    case 'turn.failed': {
                        const message = (event as {error?: {message?: string}}).error?.message || 'turn failed';
                        lastErrorMessage = message;
                        options?.onError?.(message);
                        break;
                    }

                    case 'turn.completed':
                    case 'thread.started':
                        // 无需额外处理（会话指针取自 thread.id）
                        break;
                }
            }

            // 会话指针 = 真实 thread id（持久化到执行记录，重启后仍可 resumeThread）
            const threadId = thread.id;
            if (threadId && typeof threadId === 'string') {
                sessionId = threadId;
                this.sessionIdToThreadId.set(sessionId, threadId);
                this.threadIdToSessionId.set(threadId, sessionId);
                // 旧占位 id → 真实 threadId：本次运行内的续接与诊断都还能对上
                if (input.sessionId && input.sessionId !== threadId) {
                    this.sessionIdToThreadId.set(input.sessionId, threadId);
                }
            }

            if (options?.signal?.aborted) {
                return {exitCode: null, stdout, stderr: '', sessionId, aborted: true};
            }

            // turn.failed（模型/工具错误）：按失败返回，执行状态与日志才有据可查
            if (lastErrorMessage) {
                return {exitCode: 1, stdout, stderr: lastErrorMessage, sessionId, aborted: false};
            }

            return {exitCode: 0, stdout, stderr: '', sessionId, aborted: false};
        } catch (err) {
            const message = getErrorMessage(err);
            options?.onError?.(message);
            return {exitCode: 1, stdout: '', stderr: message, aborted: false};
        }
    }

    async loadSkills(): Promise<SkillInfo[]> {
        const skills: SkillInfo[] = [];

        // 来源 1：config.toml 中的 [[skills.config]] 数组表
        if (fs.existsSync(CODEX_CONFIG_FILE)) {
            try {
                const raw = fs.readFileSync(CODEX_CONFIG_FILE, 'utf-8');
                const parsed = parseTomlMinimal(raw);
                const skillEntries = parsed.arrayTables['skills.config'];
                if (Array.isArray(skillEntries)) {
                    for (const entry of skillEntries) {
                        const skillPath = typeof entry.path === 'string' ? entry.path : '';
                        const enabled = entry.enabled !== false;
                        if (!skillPath) continue;
                        const name = path.basename(skillPath);
                        let description = '';
                        // 尝试读取 skill 文件获取描述
                        const candidates = [skillPath, path.join(skillPath, 'SKILL.md'), path.join(skillPath, 'AGENTS.md')];
                        for (const candidate of candidates) {
                            if (fs.existsSync(candidate)) {
                                try {
                                    description = extractDescription(fs.readFileSync(candidate, 'utf-8'));
                                } catch { /* skip */
                                }
                                break;
                            }
                        }
                        skills.push({name, description, enabled, filePath: skillPath});
                    }
                }
            } catch { /* ignore */
            }
        }

        // 来源 2：AGENTS.md 文件（Codex 的另一种 skill 定义方式）
        const agentsFile = path.join(CODEX_DIR, 'AGENTS.md');
        if (fs.existsSync(agentsFile) && skills.length === 0) {
            try {
                const content = fs.readFileSync(agentsFile, 'utf-8');
                skills.push({
                    name: 'AGENTS',
                    description: extractDescription(content),
                    enabled: true,
                    filePath: agentsFile,
                });
            } catch { /* skip */
            }
        }

        return skills;
    }

    async loadMcpServers(): Promise<McpServerInfo[]> {
        // Codex MCP 配置在 config.toml 的 [mcp_servers.<name>] 段
        if (!fs.existsSync(CODEX_CONFIG_FILE)) {
            return [];
        }

        try {
            const raw = fs.readFileSync(CODEX_CONFIG_FILE, 'utf-8');
            const parsed = parseTomlMinimal(raw);
            const servers: McpServerInfo[] = [];

            for (const [sectionKey, sectionVal] of Object.entries(parsed.tables)) {
                // 匹配 mcp_servers.<name> 段
                const mcpMatch = sectionKey.match(/^mcp_servers\.(.+)$/);
                if (mcpMatch) {
                    const name = mcpMatch[1];
                    const cmd = typeof sectionVal.command === 'string' ? sectionVal.command : '';
                    servers.push({
                        name,
                        type: inferServerType(cmd),
                        command: cmd,
                        args: Array.isArray(sectionVal.args) ? sectionVal.args as string[] : [],
                        env: (typeof sectionVal.env === 'object' && sectionVal.env !== null) ? sectionVal.env as Record<string, string> : {},
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
        this.client = null;
        this.sessionIdToThreadId.clear();
        this.threadIdToSessionId.clear();
    }

    /**
     * codex 会话能否续接。
     *
     * - 真实 threadId：查 `$CODEX_HOME/sessions/<y>/<m>/<d>/rollout-<ts>-<threadId>.jsonl`
     *   —— 文件在即可续接（跨进程有效）
     * - 旧占位 id（`codex-<时间戳>`）：只在进程内映射里，进程重启后无法续接
     */
    canResumeSession(sessionId: string): boolean {
        if (!sessionId) return false;
        if (sessionId.startsWith('codex-')) return this.sessionIdToThreadId.has(sessionId);
        return !!this.findRolloutFile(sessionId);
    }

    /** 在隔离 CODEX_HOME/sessions 下按 threadId 查 rollout 文件 */
    private findRolloutFile(threadId: string): string | undefined {
        const root = path.join(CODEX_DIR, 'sessions');
        if (!fs.existsSync(root)) return undefined;
        const walk = (dir: string, depth: number): string | undefined => {
            if (depth > 4) return undefined;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, {withFileTypes: true});
            } catch {
                return undefined;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    const hit = walk(full, depth + 1);
                    if (hit) return hit;
                } else if (entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
                    return full;
                }
            }
            return undefined;
        };
        return walk(root, 0);
    }

    /** 工具权限确认（Codex 暂不支持，空实现以满足接口） */
    confirmPermission(_permissionRequestId: string, _decision: 'allow' | 'deny', _message?: string, _modifiedInput?: Record<string, unknown>): void {
        // no-op: Codex 走自有 SDK，无 canUseTool 机制
    }

    /**
     * item 开始/更新 → 工具行（running）。
     *
     * 同一 id 只发一次（`item.started`/`item.updated`/`item.completed` 可能都带同一 id，
     * 重复发会让消息流里出现重复工具行）。文件名与参数形状都归一到与前端分类表一致的形式。
     */
    private emitCodexItemStarted(
        item: CodexItem,
        options?: CLIProviderOptions,
        started?: Set<string>,
    ): void {
        const emitOnce = (toolUseId: string, toolName: string, toolInput: Record<string, unknown>) => {
            if (!toolUseId) return;
            if (started?.has(toolUseId)) return;
            started?.add(toolUseId);
            options?.onOutput?.('', {type: 'tool_use', toolName, toolInput, toolUseId});
        };

        switch (item.type) {
            case 'command_execution':
                emitOnce(String(item.id ?? ''), 'bash', {command: item.command ?? ''});
                break;
            case 'file_change':
                // 一个补丁可能改多个文件：逐个文件出工具行（对应「本次产出」也才能逐条统计）
                for (const change of item.changes ?? []) {
                    const filePath = change.path ?? '';
                    const toolName = change.kind === 'add' ? 'write' : 'edit';
                    emitOnce(`${String(item.id ?? '')}#${filePath}`, toolName, {path: filePath, kind: change.kind ?? ''});
                }
                break;
            case 'mcp_tool_call':
                // server__tool 命名：前端据此渲染「MCP server · tool」并沿用基础工具图标
                emitOnce(
                    String(item.id ?? ''),
                    `${item.server ?? 'mcp'}__${item.tool ?? 'tool'}`,
                    (item.arguments && typeof item.arguments === 'object'
                        ? item.arguments as Record<string, unknown>
                        : {arguments: item.arguments ?? ''}),
                );
                break;
            case 'web_search':
                emitOnce(String(item.id ?? ''), 'web_search', {query: item.query ?? ''});
                break;
            case 'todo_list':
                emitOnce(String(item.id ?? ''), 'todo_write', {items: item.items ?? []});
                break;
            default:
                // agent_message / reasoning 是文本流，不产生工具行
                break;
        }
    }

    /**
     * item 完成 → 工具结果 / 文本 / 思考；返回应并入 stdout 的文本。
     * 与 `emitCodexItemStarted` 用同一 id 生成规则，保证工具行能配对收敛。
     *
     * 先自愈补发 tool_use：并非所有 item 都保证先来 item.started
     * （如 file_change「补丁成功/失败时发一次」）—— 没有 use 就没有行，
     * 结果会变成无人配对的孤儿。
     */
    private emitCodexItemCompleted(
        item: CodexItem,
        options?: CLIProviderOptions,
        started?: Set<string>,
    ): string {
        this.emitCodexItemStarted(item, options, started);
        switch (item.type) {
            case 'agent_message': {
                const text = typeof item.text === 'string' ? item.text : '';
                if (text) options?.onOutput?.(text);
                return text;
            }
            case 'reasoning': {
                if (typeof item.text === 'string' && item.text) {
                    options?.onOutput?.(item.text, {type: 'thinking'});
                }
                return '';
            }
            case 'command_execution': {
                const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
                const failed = item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0);
                const suffix = item.exit_code !== undefined && item.exit_code !== 0
                    ? `${output}\n（退出码 ${item.exit_code}）`
                    : output;
                options?.onOutput?.(suffix, {
                    type: 'tool_result',
                    toolName: 'bash',
                    toolUseId: String(item.id ?? ''),
                    isError: failed,
                });
                return output;
            }
            case 'file_change': {
                const failed = item.status === 'failed';
                for (const change of item.changes ?? []) {
                    const filePath = change.path ?? '';
                    options?.onOutput?.(
                        failed ? `变更失败（${change.kind ?? ''}）：${filePath}` : `已应用变更（${change.kind ?? ''}）：${filePath}`,
                        {
                            type: 'tool_result',
                            toolName: change.kind === 'add' ? 'write' : 'edit',
                            toolUseId: `${String(item.id ?? '')}#${filePath}`,
                            isError: failed,
                        },
                    );
                }
                return '';
            }
            case 'mcp_tool_call': {
                const text = flattenCodexContent(item.result?.content)
                    || (item.result?.structured_content !== undefined ? JSON.stringify(item.result.structured_content) : '');
                options?.onOutput?.(text, {
                    type: 'tool_result',
                    toolName: `${item.server ?? 'mcp'}__${item.tool ?? 'tool'}`,
                    toolUseId: String(item.id ?? ''),
                    isError: item.result === undefined,
                });
                return text;
            }
            case 'web_search': {
                const note = `已检索：${item.query ?? ''}`;
                options?.onOutput?.(note, {
                    type: 'tool_result',
                    toolName: 'web_search',
                    toolUseId: String(item.id ?? ''),
                    isError: false,
                });
                return '';
            }
            case 'todo_list': {
                const items = item.items ?? [];
                const done = items.filter(t => t.completed).length;
                const text = `${done}/${items.length} 已完成\n${items.map(t => `${t.completed ? '[x]' : '[ ]'} ${t.text ?? ''}`).join('\n')}`;
                options?.onOutput?.(text, {
                    type: 'tool_result',
                    toolName: 'todo_write',
                    toolUseId: String(item.id ?? ''),
                    isError: false,
                });
                return '';
            }
            case 'error': {
                const message = item.message ?? 'unknown error';
                options?.onError?.(message);
                return '';
            }
            default:
                return '';
        }
    }

    /** 动态导入并创建 Codex 客户端 */
    private async createClient(): Promise<InstanceType<typeof import('@openai/codex-sdk').Codex>> {        // 桌面瘦身包不随附平台二进制（BYO-CLI）：SDK 自有平台包全部不可解析时，
        // 回退系统 npm 全局安装的 codex 真实二进制
        let executablePath: string | null = null;
        const platformPkgs = [
            '@openai/codex-win32-x64', '@openai/codex-win32-arm64',
            '@openai/codex-darwin-x64', '@openai/codex-darwin-arm64',
            '@openai/codex-linux-x64', '@openai/codex-linux-arm64',
        ];
        const bundled = platformPkgs.some((pkg) => {
            try {
                require.resolve(`${pkg}/package.json`);
                return true;
            } catch {
                return false;
            }
        });
        if (!bundled) {
            const npmRoot = getNpmGlobalRoot();
            executablePath = (npmRoot && resolveSystemCodexBinary(npmRoot)) || null;
        }
        // ESM-only SDK 在 CJS 编译产物中需要特殊处理：
        // 使用 Function 构造器绕过 bundler/tsc 的静态分析，确保运行时动态 import
        const dynamicImport = new Function('modulePath', 'return import(modulePath)') as (m: string) => Promise<typeof import('@openai/codex-sdk')>;
        const {Codex} = await dynamicImport('@openai/codex-sdk');
        // 隔离：显式注入完整环境（SDK 传 env 时不再继承 process.env），
        //   CODEX_HOME → 应用自有目录（config.toml 首次由 CLI 播种，之后应用自管）
        //   应用模型供应商配置（codex 记录）优先级最高 —— 改完立刻生效
        const env = buildIsolatedCodexEnv();
        return new Codex({
            ...(executablePath ? {codexPathOverride: executablePath} : {}),
            env,
        });
    }

    /** 确保客户端已初始化 */
    private async ensureClient(): Promise<InstanceType<typeof import('@openai/codex-sdk').Codex>> {
        if (!this.client) {
            this.client = await this.createClient();
        }
        return this.client;
    }
}
