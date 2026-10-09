/**
 * @module pi-provider
 * @description Pi Coding Agent Provider —— RPC 子进程 harness 形态
 *
 * 架构（对标 DeepSeek Harness / OpenCode 的「CLI 作为底层」接入方式）：
 * adw 不再进程内 import pi SDK 跑 agent 循环，而是每次 run spawn 一个
 * `pi --mode rpc` 子进程（rpc-entry），stdin/stdout JSONL 协议交互：
 *
 * - 进程模型：process-per-run——每次 run 起新进程、跑完即退。
 *   会话持久化在 ~/.aico/pi-sessions/<cwd>/（pi 原生 JSONL，
 *   一会话一文件），续接时以 --session <file> 恢复完整历史。
 *   并发任务天然隔离；pi 的任何缺陷（工具挂死/循环异常）只影响该子进程。
 * - 事件归一化：RPC 事件流（JsonAgentSessionEvent，与 SDK 事件同源）→
 *   onOutput(data, {type: thinking|tool_use|tool_result})，编排层零改动。
 * - 权限确认：不再覆盖 pi 内部 beforeToolCall 钩子；由 adw 平台扩展
 *   （resources/pi-extensions/adw-platform.ts，经 -e 显式加载）走官方
 *   tool_call + ui.confirm 协议，RPC 模式映射为 extension_ui_request(confirm)
 *   ↔ extension_ui_response，本 Provider 负责与前端弹窗协议互转。
 * - MCP：平台网关 REST 面（/api/platform）+ 扩展 registerTool 投影，
 *   清单单一事实来源不变（MCPRegistryService）。
 * - 模型：--provider/--model 启动参数 + 各家 API key 经环境变量注入
 *   （「模型供应商页」pi:* 记录 → pi 认可的 *_API_KEY 环境变量）。
 *
 * Claude / Codex Provider 保持 SDK 形态不受影响。
 */

import path from 'path';
import os from 'os';
import {createHash} from 'crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync} from 'fs';
import {getErrorMessage} from '../../utils/error-utils.js';
import {APP_DATA_DIR} from '../../utils/constants.js';
import {ModelProviderStore} from '../model-provider-store.js';
import {resolvePiPermissionMode} from '../permission-mapping.js';
import {getMcpGateway} from '../../platform/mcp-gateway.js';
import {
    PiRpcProcess,
    findSessionFile,
    resolveRpcEntry,
} from './pi-rpc-process.js';
import type {
    CLIProvider,
    CLIProviderCapabilities,
    CLIProviderInput,
    CLIProviderOptions,
    CLIProviderResult,
    CLIProviderStatus,
    McpServerInfo,
    ProviderModelSettings,
    SkillInfo,
} from './types.js';

/** pi 会话存储根目录（adw 自有目录，不污染 ~/.pi/agent） */
export const PI_SESSIONS_ROOT = path.join(APP_DATA_DIR, 'pi-sessions');

/**
 * pi 凭据目录（adw 自有，与 CLI 的 ~/.pi/agent 完全隔离）。
 *
 * 动机：pi 解析凭据的链路是 runtime.getAuth → credentials.read(auth.json)，
 * **CLI 的 ~/.pi/agent/auth.json 优先级高于环境变量** —— 于是「应用里改了 key 却不生效」
 * （旧快照注入的 env 被 CLI 凭据覆盖）会反复出现，且我们无法判断用户改了哪一边。
 * 现在改为：pi 子进程只读本目录，凭据来源唯一 = 应用的模型供应商配置。
 */
export const PI_AGENT_DIR = path.join(APP_DATA_DIR, 'pi-agent');

/** pi 读取 agent 目录的环境变量名（pi 的 getAgentDir() 优先读它，未设才回落 ~/.pi/agent） */
const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

/** CLI 侧凭据文件（仅在「应用未配置任何 pi:* 记录」时一次性镜像，之后不再读） */
const CLI_AUTH_FILE = path.join(os.homedir(), '.pi', 'agent', 'auth.json');

/** 读取 CLI 侧 auth.json（容错：缺失/损坏返回空对象） */
function readCliAuth(): Record<string, unknown> {
    try {
        if (!existsSync(CLI_AUTH_FILE)) return {};
        const parsed = JSON.parse(readFileSync(CLI_AUTH_FILE, 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

/**
 * 同步隔离目录里的 auth.json —— pi 子进程的唯一凭据来源。
 *
 * - 应用有启用的 `pi:*` 记录 → **以应用配置为准**写入（模型供应商页改完立刻生效，不再有旧快照）
 * - 应用没有任何记录 → 镜像 CLI 的 auth.json（保留「没在应用里配过就跟随 CLI」的行为）
 *
 * @returns 本次凭据来源，便于日志定位
 */
export function syncIsolatedPiAuth(): {source: 'app' | 'cli' | 'empty'; file: string} {
    const file = path.join(PI_AGENT_DIR, 'auth.json');
    // 目录创建失败要带着路径抛出：否则后续写入只会报无指向性的 ENOENT
    if (!existsSync(PI_AGENT_DIR)) {
        try {
            mkdirSync(PI_AGENT_DIR, {recursive: true});
        } catch (err) {
            throw new Error(`创建 pi 凭据目录失败：${PI_AGENT_DIR}（${err instanceof Error ? err.message : String(err)}）`);
        }
    }

    let records: Array<{id: string; apiKey?: string; env?: Record<string, string>}> = [];
    try {
        records = new ModelProviderStore()
            .list()
            .filter((r) => r.kind === 'pi' && r.enabled && r.apiKey);
    } catch { /* 读取失败按「无记录」处理，镜像 CLI */ }

    if (records.length > 0) {
        const auth: Record<string, unknown> = {};
        for (const rec of records) {
            const providerId = rec.id.startsWith('pi:') ? rec.id.slice(3) : rec.id;
            auth[providerId] = {
                type: 'api_key',
                key: rec.apiKey,
                ...(rec.env && Object.keys(rec.env).length > 0 ? {env: rec.env} : {}),
            };
        }
        writeFileSync(file, JSON.stringify(auth, null, 2), 'utf-8');
        return {source: 'app', file};
    }

    const cliAuth = readCliAuth();
    writeFileSync(file, JSON.stringify(cliAuth, null, 2), 'utf-8');
    return {source: Object.keys(cliAuth).length > 0 ? 'cli' : 'empty', file};
}

/**
 * pi 子进程的隔离环境：agent 目录指向 adw 自有目录。
 * @param sync - 是否先同步 auth.json 与工具链播种（探测类调用可跳过，避免副作用）
 */
function piIsolationEnv(sync = true): Record<string, string> {
    if (sync) {
        try {
            const {source} = syncIsolatedPiAuth();
            if (source !== 'app') {
                console.log(`[pi-provider] 凭据来源=${source}（应用未配置 pi:* 记录，使用${source === 'cli' ? ' CLI 镜像' : '空凭据'}）`);
            }
        } catch (err) {
            console.warn(`[pi-provider] 凭据同步失败：${err instanceof Error ? err.message : err}`);
        }
        try {
            const seeded = seedIsolatedPiAgentHome();
            if (seeded.length > 0) {
                console.log(`[pi-provider] 工具链播种（~/.pi/agent → 隔离目录）：${seeded.join('、')}`);
            }
        } catch (err) {
            console.warn(`[pi-provider] 工具链播种失败：${err instanceof Error ? err.message : err}`);
        }
        try {
            const tools = ensurePiDefaultTools();
            if (tools.changed) {
                console.log(`[pi-provider] 内置工具集已配置：${tools.tools.join(', ')}（settings.json defaultTools）`);
            }
        } catch (err) {
            console.warn(`[pi-provider] 内置工具集配置失败：${err instanceof Error ? err.message : err}`);
        }
    }
    return {[PI_AGENT_DIR_ENV]: PI_AGENT_DIR};
}

/** pi 的内置工具全集（对应 pi dist/core/tools/index.js 的 allToolNames） */
export const PI_BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

/**
 * 在隔离 agent 目录的 settings.json 里确保 `defaultTools` 覆盖**全部内置工具**。
 *
 * 为什么必须配这一项（用户实测「工具集里没有 grep/find」）：
 * pi 的默认激活集只有 `["read","bash","edit","write"]`
 * （dist/core/sdk.js: `defaultActiveToolNames`，可被 `settingsManager.getDefaultTools()` 覆盖），
 * grep / find / ls 默认**不激活**；而走「`--tools` allowlist」那条路会连带裁掉扩展/平台工具
 * （dist/core/agent-session.js：一旦给了 allowlist，扩展工具只有名字在表里才激活 ——
 * 这正是当初「扩展平台工具被静默禁用」的根因）。
 * 因此正解是：不动 `--tools`，改为在应用自管的隔离配置里把 `defaultTools` 配全 ——
 * 内置工具全开，扩展工具依旧全量激活。
 *
 * 只增加 `defaultTools`（与已有值取并集），其余设置（shellPath 等）原样保留。
 *
 * @param targetDir - 隔离 agent 目录（默认 PI_AGENT_DIR）
 * @param tools - 期望激活的内置工具
 * @returns 是否写入、最终工具集与文件路径
 */
export function ensurePiDefaultTools(
    targetDir: string = PI_AGENT_DIR,
    tools: readonly string[] = PI_BUILTIN_TOOLS,
): {changed: boolean; tools: string[]; file: string} {
    const file = path.join(targetDir, 'settings.json');
    let settings: Record<string, unknown> = {};
    if (existsSync(file)) {
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                settings = parsed as Record<string, unknown>;
            }
        } catch { /* 内容损坏：以空配置重建（只补 defaultTools，不猜用户意图） */ }
    }

    const current = Array.isArray(settings.defaultTools)
        ? (settings.defaultTools as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
    const merged = [...current];
    for (const t of tools) {
        if (!merged.includes(t)) merged.push(t);
    }
    const changed = merged.length !== current.length || !existsSync(file);
    if (!changed) return {changed: false, tools: merged, file};

    if (!existsSync(targetDir)) {
        try {
            mkdirSync(targetDir, {recursive: true});
        } catch (err) {
            throw new Error(`创建 pi agent 目录失败：${targetDir}（${err instanceof Error ? err.message : String(err)}）`);
        }
    }
    writeFileSync(file, JSON.stringify({...settings, defaultTools: merged}, null, 2), 'utf-8');
    return {changed: true, tools: merged, file};
}

/**
 * 把用户 CLI 的 pi agent 目录里**影响工具可用性**的条目一次性播种进隔离目录（只补缺失，不覆盖）。
 *
 * 此前隔离只搬凭据（auth.json），结果 pi 的内置工具链裸奔（用户实测 bash/git/grep 失效，
 * 只能靠浏览器工具干活）：
 * - `settings.json` —— 里面的 `shellPath` 是 bash 工具的 shell 解析首选；Git 装在非标准位置
 *   （如 D:\javaSE\Git）时**只有**这里能找到 bash（getShellConfig 的已知位置/PATH 都不含它）；
 *   还带 defaultThinkingLevel 等偏好
 * - `bin/`（rg.exe / fd.exe）—— grep/find 工具的二进制；缺失时 pi 会尝试联网从 GitHub 下载，
 *   离线/受限环境下直接不可用
 * - `trust.json` —— 工作区信任表（项目级 .pi 资源/扩展加载）
 *
 * 与凭据不同，这些是「环境能力」而非「密钥」：应用不管理它们，首次从 CLI 拷贝后
 * 即归隔离目录所有（此后 CLI 侧改动不再影响应用，符合隔离契约）。
 *
 * @param sourceDir - 用户 CLI 的 agent 目录（默认 ~/.pi/agent）
 * @param targetDir - 隔离 agent 目录（默认 PI_AGENT_DIR）
 * @returns 本次新复制过的相对路径列表（幂等：已存在的不动）
 */
export function seedIsolatedPiAgentHome(
    sourceDir: string = path.join(os.homedir(), '.pi', 'agent'),
    targetDir: string = PI_AGENT_DIR,
): string[] {
    if (!existsSync(sourceDir)) return [];
    if (!existsSync(targetDir)) {
        try {
            mkdirSync(targetDir, {recursive: true});
        } catch (err) {
            throw new Error(`创建 pi agent 目录失败：${targetDir}（${err instanceof Error ? err.message : String(err)}）`);
        }
    }

    const copied: string[] = [];
    const copyFileIfMissing = (rel: string) => {
        const src = path.join(sourceDir, rel);
        const dest = path.join(targetDir, rel);
        if (!existsSync(src) || existsSync(dest)) return;
        try {
            mkdirSync(path.dirname(dest), {recursive: true});
            copyFileSync(src, dest);
            copied.push(rel);
        } catch { /* 单个条目失败不影响其它 */ }
    };

    // 单文件：settings.json / trust.json
    copyFileIfMissing('settings.json');
    copyFileIfMissing('trust.json');

    // bin/：rg、fd 等工具二进制
    const srcBin = path.join(sourceDir, 'bin');
    if (existsSync(srcBin)) {
        try {
            for (const entry of readdirSync(srcBin, {withFileTypes: true})) {
                if (!entry.isFile()) continue;
                copyFileIfMissing(path.join('bin', entry.name));
            }
        } catch { /* 列目录失败按无 bin 处理 */ }
    }
    return copied;
}

/**
 * 工作区路径归一化（会话目录键）。
 *
 * 会话目录名 = 净化路径 + `md5(cwd)`，因此 `D:\a\b` 与 `D:/a/b`、`d:\a\b`
 * 会算出**三个不同目录**，导致同一工作区的历史会话突然「找不到」。
 * 这里统一成绝对路径 + 盘符大写 + 去尾部分隔符，保证同一物理目录只有一个会话目录。
 */
export function normalizeWorkspacePath(cwd: string): string {
    let p = path.resolve(cwd);
    // Windows 盘符大小写归一（d: 与 D: 是同一目录）
    p = p.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
    // 去掉末尾分隔符；盘符根（D:）需补回分隔符
    p = p.replace(/[\\/]+$/, '');
    if (/^[A-Za-z]:$/.test(p) || p === '') return path.resolve(cwd);
    return p;
}

/** 由会话目录键（已归一化或历史原始 cwd）算出会话目录 */
function sessionDirFor(key: string): string {
    const encoded = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-60);
    const hash = createHash('md5').update(key).digest('hex').slice(0, 8);
    return path.join(PI_SESSIONS_ROOT, `${encoded}-${hash}`);
}

/**
 * 计算 cwd 对应的 pi 会话目录（新会话写入此处）
 * @description 目录名 = 净化后的 cwd + 短哈希，保证不同 cwd 不冲突；cwd 先归一化
 */
export function piSessionDir(cwd: string): string {
    return sessionDirFor(normalizeWorkspacePath(cwd));
}

/** 历史（未归一化）命名下的会话目录：D:/a/b 与 D:\a\b 曾各建一个，续接时需回退查找 */
function legacyPiSessionDir(cwd: string): string {
    return sessionDirFor(cwd);
}

/**
 * 定位会话文件：归一化 cwd 目录 → 该 cwd 的旧命名目录 → 全库按 id 扫描。
 *
 * 为什么不只看 cwd 目录：目录名由 cwd 字符串决定，历史上切换过路径写法的
 * 工作区会把会话落在「另一个」目录里；会话 id 全局唯一，按 id 扫描能找回来，
 * 否则就会误判「会话不存在」而静默开新会话。
 */
export function resolvePiSessionFile(
    sessionId: string,
    cwd: string,
): {file?: string; dir: string; via?: 'cwd' | 'legacy' | 'global'} {
    const primary = piSessionDir(cwd);
    const direct = findSessionFile(sessionId, primary);
    if (direct) return {file: direct, dir: primary, via: 'cwd'};

    const legacyDir = legacyPiSessionDir(cwd);
    if (legacyDir !== primary) {
        const legacyHit = findSessionFile(sessionId, legacyDir);
        if (legacyHit) return {file: legacyHit, dir: legacyDir, via: 'legacy'};
    }

    try {
        for (const entry of readdirSync(PI_SESSIONS_ROOT, {withFileTypes: true})) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(PI_SESSIONS_ROOT, entry.name);
            if (dir === primary || dir === legacyDir) continue;
            const hit = findSessionFile(sessionId, dir);
            if (hit) return {file: hit, dir, via: 'global'};
        }
    } catch { /* 扫描失败按未找到处理 */ }
    return {dir: primary};
}

/** detect() 探测进程的会话目录（一次性，不产生会话文件） */
const DETECT_SESSION_DIR = path.join(PI_SESSIONS_ROOT, '_detect');

/** adw 平台扩展文件（相对仓库根；rpc-entry 同款向上查找策略） */
const EXTENSION_REL_PATH = path.join('resources', 'pi-extensions', 'adw-platform.ts');

/**
 * 从引擎 MCP 注入配置中提取 servers 白名单（网关形态的 ?servers=a,b query）
 * @description pi 不直接消费 input.mcpServers（平台工具经扩展 REST 面注册），
 *   但白名单语义需要透传：解析 http 条目 url 的 servers 参数，逗号拼接后
 *   经 ADW_PLATFORM_SERVERS 传给扩展收敛工具面（与 Claude 侧语义一致）。
 */
export function extractMcpServersWhitelist(
    mcpServers: CLIProviderInput['mcpServers'],
): string | undefined {
    if (!mcpServers) return undefined;
    for (const cfg of Object.values(mcpServers)) {
        const url = cfg && typeof cfg === 'object' && 'url' in cfg
            ? String((cfg as { url?: unknown }).url ?? '')
            : '';
        if (!url) continue;
        try {
            const servers = new URL(url).searchParams.get('servers');
            if (servers) return servers;
        } catch { /* 非 URL 形态忽略 */
        }
    }
    return undefined;
}

/**
 * 「模型供应商页」provider id → pi 认可的 API key 环境变量名
 * @description 仅映射帮助文档明示的变量；未列出的提供商走 pi 自身
 * 的 ~/.pi/agent/auth.json / OAuth。
 */
const PI_PROVIDER_ENV_KEYS: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    google: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    xai: 'XAI_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    together: 'TOGETHER_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
    baseten: 'BASETEN_API_KEY',
    zai: 'ZAI_API_KEY',
    'zai-cn': 'ZAI_CODING_CN_API_KEY',
    minimax: 'MINIMAX_API_KEY',
    moonshot: 'MOONSHOT_API_KEY',
    kimi: 'KIMI_API_KEY',
    qwen: 'QWEN_TOKEN_PLAN_API_KEY',
    'qwen-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY',
    xiaomi: 'XIAOMI_API_KEY',
    azure: 'AZURE_OPENAI_API_KEY',
    opencode: 'OPENCODE_API_KEY',
    cloudflare: 'CLOUDFLARE_API_KEY',
};

/** 单工具执行看门狗：超限强制中止本次运行 */
const TOOL_WATCHDOG_MS = 10 * 60 * 1000;
/** 整轮运行看门狗（兜底：事件流彻底沉寂的病态场景） */
const RUN_WATCHDOG_MS = 30 * 60 * 1000;
/** abort 后等待 agent_end 的宽限期，超时直接收尾 */
const ABORT_GRACE_MS = 8_000;

/** 从工具 partialResult / result 中提取可展示文本（形状随工具而异，启发式提取） */
function extractToolText(source: unknown): string {
    if (source == null) return '';
    if (typeof source === 'string') return source;
    if (Array.isArray(source)) {
        return source.map((c) => extractToolText(c)).join('');
    }
    if (typeof source === 'object') {
        const obj = source as Record<string, unknown>;
        for (const key of ['text', 'stdout', 'output', 'content']) {
            const v = obj[key];
            if (typeof v === 'string') return v;
        }
        return '';
    }
    return String(source);
}

/** 挂起的权限确认（permissionRequestId → 应答通道） */
interface PendingPermission {
    proc: PiRpcProcess;
    /** pi extension_ui_request 的 id（extension_ui_response 回写用） */
    uiId: string;
}

/**
 * Pi Coding Agent Provider（RPC harness）
 */
export class PiProvider implements CLIProvider {
    readonly id = 'pi' as const;
    readonly label = 'Pi Coding Agent';

    readonly capabilities: CLIProviderCapabilities = {
        // 扩展 tool_call + ui.confirm 协议（RPC 模式 extension_ui_request）
        supportsPermission: true,
        // pi 使用 SKILL.md 文件注入技能，不在运行时动态注入
        supportsRuntimeSkills: false,
        // MCP 由平台网关统一管理，扩展 registerTool 投影（input.mcpServers 被忽略）
        supportsRuntimeMcp: true,
        // pi 有自动上下文压缩，轮次由模型自主决定
        supportsMaxTurns: false,
        supportsReasoningEffort: true,
        supportsExtendedThinking: true,
        // pi 有自己的 20+ provider 体系，不支持注入 Anthropic 兼容端点
        supportsCustomEndpoint: false,
    };

    readonly defaultModelSettings: ProviderModelSettings = {
        modelProvider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        streaming: true,
        reasoningEffort: 'medium',
    };

    /** 挂起中的权限确认 */
    private pendingPermissions = new Map<string, PendingPermission>();

    /** 可注入的进程启动函数（测试替换用） */
    private startRpc: typeof PiRpcProcess.start;

    constructor(startRpc: typeof PiRpcProcess.start = PiRpcProcess.start) {
        this.startRpc = startRpc;
    }

    async detect(): Promise<CLIProviderStatus> {
        let entry: string;
        try {
            entry = resolveRpcEntry();
        } catch (err) {
            return {
                available: false,
                error: getErrorMessage(err) || '@earendil-works/pi-coding-agent not installed. Run: pnpm add @earendil-works/pi-coding-agent',
            };
        }

        // 真实版本号：node <cli.js> --version（cli.js 与 rpc-entry 同目录）
        const version = await this.detectVersion(entry).catch(() => undefined);

        // 可用模型目录：一次性 RPC 子进程 get_available_models
        const models = await this.detectAvailableModels();

        const meta: Record<string, unknown> = {};
        if (models) {
            const providers = new Set(models.map((m) => m.provider));
            meta.availableProviders = Array.from(providers);
            meta.availableModels = models.slice(0, 30);
        }

        return {
            available: true,
            version: version ?? 'unknown',
            path: entry,
            meta,
        };
    }

    /** 读 pi CLI 版本（cli.js --version） */
    private async detectVersion(rpcEntry: string): Promise<string | undefined> {
        const cliJs = path.join(path.dirname(rpcEntry), 'cli.js');
        if (!existsSync(cliJs)) return undefined;
        const {execFile} = await import('child_process');
        // 桌面版：execPath 为 Electron 二进制，须保持纯 Node 模式（同 PiRpcProcess.start）
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) env[key] = value;
        }
        if (process.env.ADW_DESKTOP === '1') {
            env.ELECTRON_RUN_AS_NODE = '1';
        }
        return new Promise<string | undefined>((resolve) => {
            execFile(process.execPath, [cliJs, '--version'], {timeout: 15_000, env}, (err, stdout) => {
                if (err) return resolve(undefined);
                resolve(String(stdout).trim().split('\n').pop()?.trim() || undefined);
            });
        });
    }

    /** 一次性 RPC 子进程探测可用模型（失败返回 undefined，不影响可用性） */
    private async detectAvailableModels(): Promise<Array<{ provider: string; id: string; name?: string }> | undefined> {
        let proc: PiRpcProcess | null = null;
        try {
            proc = await this.startRpc(
                {cwd: process.cwd(), sessionDir: DETECT_SESSION_DIR, env: piIsolationEnv(true)},
                {},
                undefined,
                30_000,
            );
            const data = await proc.send({type: 'get_available_models'}, 20_000) as
                | { models?: Array<{ provider: string; id: string; name?: string }> }
                | undefined;
            const models = (data?.models ?? []).map((m) => ({provider: m.provider, id: m.id, name: m.name ?? m.id}));

            // 合并自有模型供应商配置（pi:* 记录经环境变量注入凭证，pi 侧自动检测看不到）
            try {
                const store = new ModelProviderStore();
                for (const rec of store.list()) {
                    if (rec.kind !== 'pi' || !rec.enabled || !rec.apiKey) continue;
                    const providerId = rec.id.startsWith('pi:') ? rec.id.slice(3) : rec.id;
                    if (models.some((m) => m.provider === providerId)) continue;
                    const modelId = rec.defaultModel || rec.models?.[0];
                    if (modelId) models.push({provider: providerId, id: modelId, name: modelId});
                }
            } catch {
                // 自有配置读取失败时静默降级
            }
            return models;
        } catch {
            return undefined;
        } finally {
            await proc?.kill().catch(() => undefined);
        }
    }

    async initialize(): Promise<void> {
        // 校验 rpc 入口与扩展文件可解析（spawn 在 run 时按需进行）
        resolveRpcEntry();
        this.resolveExtensionPath();
    }

    /**
     * pi 会话能否续接：会话文件是否还在（本 cwd 目录 / 旧命名目录 / 其它工作区目录）。
     * 会话目录按 cwd 区分，工作区变更或历史路径写法差异都会让「本 cwd 找不到」，
     * 因此这里用的是带回退的解析（与 run 内一致），避免误判为失效。
     */
    canResumeSession(sessionId: string, cwd?: string): boolean {
        if (!sessionId) return false;
        return !!resolvePiSessionFile(sessionId, cwd || process.cwd()).file;
    }

    async run(input: CLIProviderInput, options?: CLIProviderOptions): Promise<CLIProviderResult> {
        const cwd = input.cwd || process.cwd();
        const sessionDir = piSessionDir(cwd);

        // 中止信号已触发：直接返回，不起进程
        if (options?.signal?.aborted) {
            return {exitCode: null, stdout: '', stderr: '', aborted: true};
        }

        // === 启动参数组装 ===
        const model = this.resolveSpawnModel(options);
        const env = this.buildSpawnEnv(model.provider, (options as { apiKey?: string } | undefined)?.apiKey);
        // 权限模式：全局配置三档映射到 pi 的 confirm/auto-allow（经典流程无确认回调时自动放行）
        env.ADW_PERMISSION_MODE = resolvePiPermissionMode(
            options?.permissionMode ?? 'confirm',
            !!options?.onPermissionRequest,
        );
        // MCP servers 白名单透传：input.mcpServers 的网关形态（?servers=a,b）
        // 提取后经 ADW_PLATFORM_SERVERS 传给扩展（与 Claude 侧 ?servers= 语义一致）
        const serversWhitelist = extractMcpServersWhitelist(input.mcpServers);
        if (serversWhitelist) env.ADW_PLATFORM_SERVERS = serversWhitelist;
        const extensionPath = this.resolveExtensionPath();
        const resolved = input.sessionId ? resolvePiSessionFile(input.sessionId, cwd) : {dir: sessionDir};
        const sessionFile = resolved.file;
        if (input.sessionId && !sessionFile) {
            options?.onOutput?.(`[pi 会话 "${input.sessionId}" 不存在或已失效，已自动开启新会话]\n`);
        } else if (resolved.via && resolved.via !== 'cwd') {
            // 会话不在本 cwd 的标准目录里（历史路径写法/工作区变更所致）：找回并提示，便于排查
            console.warn(
                `[pi-provider] 会话 ${input.sessionId} 在 ${resolved.via === 'legacy' ? '旧命名目录' : '其它工作区目录'} 中找到：${resolved.dir}`,
            );
        }

        let stdout = '';
        let stderr = '';
        let isAborted = false;
        // 模型调用错误（pi 契约：错误编码为 stopReason='error' 的消息，不抛出）
        let lastErrorMessage = '';

        // 输出缓冲（与旧实现同语义：delta 累积、关键边界批量发出）
        let textBuf = '';
        let thinkingBuf = '';
        let toolBuf = '';

        const flushBuffer = () => {
            if (textBuf) {
                options?.onOutput?.(textBuf);
                textBuf = '';
            }
        };
        const flushThinking = () => {
            if (thinkingBuf) {
                options?.onOutput?.(thinkingBuf, {type: 'thinking'});
                thinkingBuf = '';
            }
        };
        const takeToolOutput = () => {
            const out = toolBuf;
            toolBuf = '';
            return out;
        };

        // 看门狗（工具级 + 整轮级）
        const toolWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
        let runWatchdog: ReturnType<typeof setTimeout> | null = null;
        const clearAllWatchdogs = () => {
            for (const t of toolWatchdogs.values()) clearTimeout(t);
            toolWatchdogs.clear();
            if (runWatchdog) {
                clearTimeout(runWatchdog);
                runWatchdog = null;
            }
        };

        // 完成信号（agent_end / abort 双路径）
        let resolveCompletion!: () => void;
        const completion = new Promise<void>((resolve) => {
            resolveCompletion = resolve;
        });
        const finish = () => {
            clearAllWatchdogs();
            resolveCompletion();
        };

        // 整轮看门狗——「无活动」语义：任何事件（文本/思考/工具/轮次）都会重置计时，
        // 只有事件流彻底沉寂满 30 分钟（疑似卡死）才强制中止。
        // 旧实现是启动时设定一次的绝对定时器：健康长任务（持续产出）也会在 30 分钟整被无脑杀掉。
        const armRunWatchdog = () => {
            if (runWatchdog) clearTimeout(runWatchdog);
            runWatchdog = setTimeout(() => {
                options?.onOutput?.('\n[pi 已 30 分钟无任何事件（疑似卡死），已强制中止本次运行]\n');
                procRef?.send({type: 'abort'}).catch(() => undefined);
                finish();
            }, RUN_WATCHDOG_MS);
            runWatchdog.unref?.();
        };

        // 工具级看门狗——同样「无活动」：tool_execution_update（部分输出到达）会重置，
        // 只在工具长时间零输出（疑似挂死）时中止本次运行。
        const armToolWatchdog = (toolCallId: string, toolName: string) => {
            const timer = setTimeout(() => {
                options?.onOutput?.(`\n[工具 ${toolName} 已 10 分钟无输出（疑似挂死），已强制中止本次运行]\n`);
                procRef?.send({type: 'abort'}).catch(() => undefined);
                finish();
            }, TOOL_WATCHDOG_MS);
            timer.unref?.();
            if (toolCallId) toolWatchdogs.set(toolCallId, timer);
        };

        // 当前 run 绑定的事件处理（process-per-run：进程事件即本 run 事件）
        const handleEvent = (evt: Record<string, any>) => {
            armRunWatchdog(); // 任何事件都算进展：重置整轮看门狗
            switch (evt.type) {
                case 'message_update': {
                    const msgEvent = evt.assistantMessageEvent as Record<string, any> | undefined;
                    switch (msgEvent?.type) {
                        case 'text_delta':
                            stdout += msgEvent.delta || '';
                            textBuf += msgEvent.delta || '';
                            break;
                        case 'thinking_delta':
                            thinkingBuf += msgEvent.delta || '';
                            break;
                        case 'toolcall_start':
                            // JSON 协议下 toolcall_start 不携带参数（partial 已剥离）；
                            // 参数在 tool_execution_start 的 args 中提供
                            flushThinking();
                            flushBuffer();
                            break;
                    }
                    break;
                }

                case 'tool_execution_start': {
                    const toolCallId = String(evt.toolCallId ?? '');
                    // 工具级看门狗：工具开始执行后 10 分钟内零输出（部分输出会重置，见
                    // tool_execution_update）才判定疑似挂死并中止——长工具（大构建/长查询）不误伤
                    armToolWatchdog(toolCallId, String(evt.toolName ?? 'Tool'));
                    flushThinking();
                    flushBuffer();
                    options?.onOutput?.('', {
                        type: 'tool_use',
                        toolName: evt.toolName || 'Tool',
                        toolInput: evt.args ?? {},
                        toolUseId: toolCallId,
                    });
                    break;
                }

                case 'tool_execution_update': {
                    toolBuf += extractToolText(evt.partialResult);
                    // 工具仍在产出（部分输出到达）→ 重置该工具的看门狗（「无活动」语义）
                    const updatingId = String(evt.toolCallId ?? '');
                    if (updatingId && toolWatchdogs.has(updatingId)) {
                        const stale = toolWatchdogs.get(updatingId);
                        if (stale) clearTimeout(stale);
                        armToolWatchdog(updatingId, String(evt.toolName ?? 'Tool'));
                    }
                    break;
                }

                case 'tool_execution_end': {
                    const endedId = String(evt.toolCallId ?? '');
                    const timer = endedId ? toolWatchdogs.get(endedId) : undefined;
                    if (timer) {
                        clearTimeout(timer);
                        toolWatchdogs.delete(endedId);
                    }
                    if (!toolBuf && evt.result) {
                        // 无增量输出时回退取最终结果的文本内容
                        toolBuf = extractToolText(evt.result.content);
                    }
                    flushThinking();
                    options?.onOutput?.(takeToolOutput(), {
                        type: 'tool_result',
                        toolName: evt.toolName,
                        toolUseId: endedId,
                        isError: evt.isError === true,
                    });
                    break;
                }

                case 'message_end': {
                    const finished = evt.message as { stopReason?: string; errorMessage?: string } | undefined;
                    if (finished?.stopReason === 'error' && finished.errorMessage) {
                        lastErrorMessage = finished.errorMessage;
                    }
                    flushThinking();
                    flushBuffer();
                    break;
                }

                case 'agent_end':
                    flushThinking();
                    flushBuffer();
                    finish();
                    break;

                // === 扩展 UI 通道（adw 平台扩展） ===
                case 'extension_ui_request': {
                    if (evt.method === 'confirm' && typeof evt.id === 'string') {
                        const permissionRequestId = `pi-${evt.id}`;
                        this.pendingPermissions.set(permissionRequestId, {
                            // procRef 在进程启动后立即可用；confirm 只会发生在 prompt 之后
                            proc: procRef as unknown as PiRpcProcess,
                            uiId: evt.id,
                        });
                        options?.onPermissionRequest?.({
                            permissionRequestId,
                            toolName: String(evt.title ?? 'Tool'),
                            toolInput: {summary: String(evt.message ?? '')},
                            toolUseId: evt.id,
                            title: String(evt.title ?? 'Tool'),
                            displayName: String(evt.title ?? 'Tool'),
                        });
                    } else if (evt.method === 'notify') {
                        options?.onOutput?.(`${String(evt.message ?? '')}\n`);
                    }
                    break;
                }

                case 'extension_error':
                    options?.onOutput?.(`[pi 扩展错误] ${String(evt.error ?? '')}\n`);
                    break;
            }
        };

        let procRef: PiRpcProcess | null = null;
        try {
            procRef = await this.startRpc(
                {
                    cwd,
                    sessionDir,
                    sessionFile,
                    provider: model.provider,
                    model: model.model,
                    thinkingLevel: mapReasoningToThinkingLevel(options?.reasoningEffort),
                    // 不传 tools 启用白名单：--tools 是"只启用这些"的硬白名单，
                    // 会把扩展注册的平台 MCP 工具（<server>__<tool>）静默禁用
                    //（模型只能看到本地读写/bash 等内置工具）。内置工具面很小
                    //（read/bash/powershell/edit/write 等），放开无副作用风险，
                    // 副作用类仍由扩展权限门 confirm 把关。
                    extensionPath,
                    env,
                },
                {
                    onEvent: handleEvent,
                    onStderr: (text) => {
                        stderr += `${text}\n`;
                    },
                },
            );
            const proc = procRef;

            // 中止信号 → abort 命令 + 宽限期后强制收尾（双保险）
            const signal = options?.signal;
            signal?.addEventListener('abort', () => {
                isAborted = true;
                proc.send({type: 'abort'}).catch(() => undefined);
                setTimeout(finish, ABORT_GRACE_MS).unref?.();
            }, {once: true});

            // 整轮看门狗：首臂（此后任何事件都会重置，见 armRunWatchdog）
            armRunWatchdog();

            // 发送 prompt：应答 success 即预检通过（preflight），完成由 agent_end 驱动
            await proc.send({type: 'prompt', message: input.prompt});
            await completion;

            // 模型侧错误显式透传（不允许 exitCode=0 掩盖）
            if (lastErrorMessage) {
                stderr = `pi 模型调用失败: ${lastErrorMessage}\n${stderr}`;
                options?.onError?.(stderr);
            }

            // 取 sessionId（进程仍存活时；已死则退回输入值）
            let sessionId = input.sessionId;
            try {
                const state = await proc.send({type: 'get_state'}, 5_000) as { sessionId?: string } | undefined;
                sessionId = state?.sessionId ?? sessionId;
            } catch {
                // 进程已退出（如整轮看门狗路径）：保留输入 sessionId
            }

            return {
                exitCode: isAborted ? null : (lastErrorMessage ? 1 : 0),
                stdout,
                stderr: stderr || undefined,
                aborted: isAborted,
                sessionId,
            };
        } catch (err) {
            const message = getErrorMessage(err);
            options?.onError?.(message);
            return {
                exitCode: 1,
                stdout,
                stderr: message,
                aborted: options?.signal?.aborted ?? false,
                sessionId: input.sessionId,
            };
        } finally {
            clearAllWatchdogs();
            // 清理本 run 挂起的权限确认（防泄漏；对应 confirm 已无从应答）
            for (const [key, pending] of this.pendingPermissions) {
                if (pending.proc === procRef) this.pendingPermissions.delete(key);
            }
            await procRef?.kill().catch(() => undefined);
        }
    }

    async loadSkills(): Promise<SkillInfo[]> {
        // pi 使用 SKILL.md 文件系统方式管理 skill（ResourceLoader 自动发现）
        return [];
    }

    async loadMcpServers(): Promise<McpServerInfo[]> {
        // 平台化：pi 引擎的 MCP 视图 = 平台注册中心（网关统一转发）
        try {
            const {MCPRegistryService} = await import('../mcp-registry-service.js');
            const registry = new MCPRegistryService();
            return registry.list()
                .filter((s) => s.enabled)
                .map((s) => ({
                    name: s.name,
                    type: s.type ?? 'custom',
                    command: s.command,
                    args: s.args,
                    env: s.env,
                    enabled: s.enabled,
                    status: 'disconnected' as const,
                }));
        } catch {
            return [];
        }
    }

    async dispose(): Promise<void> {
        // process-per-run：无常驻子进程；拒绝挂起中的权限确认即可
        this.pendingPermissions.clear();
    }

    /**
     * 反向写回工具权限决策：extension_ui_response 回传给子进程
     * @description 与 Claude bridge 的 agent.confirmPermission 同语义
     */
    confirmPermission(
        permissionRequestId: string,
        decision: 'allow' | 'deny',
        _message?: string,
        _modifiedInput?: Record<string, unknown>,
    ): void {
        const pending = this.pendingPermissions.get(permissionRequestId);
        if (!pending) return;
        this.pendingPermissions.delete(permissionRequestId);
        pending.proc.notify({
            type: 'extension_ui_response',
            id: pending.uiId,
            confirmed: decision === 'allow',
        });
    }

    // === 私有方法 ===

    /**
     * 解析启动用模型：调用方显式传入 > pi 原生已配置的 provider > 自有配置首个可用
     *
     * 关键约束：**pi 原生 auth.json 里的凭据优先于我们注入的环境变量**
     * （pi 的解析链是 runtime.getAuth → credentials.read(auth.json)）。
     * 因此自动选择时也以原生已配置的 provider 为准，避免"我们的快照选了 A、pi 实际用 B"的错配。
     */
    private resolveSpawnModel(options?: CLIProviderOptions): { provider?: string; model?: string } {
        const provider = options?.modelProvider;
        const model = options?.model;
        if (provider) return {provider, model};

        try {
            const store = new ModelProviderStore();
            const rec = store.list().find(
                (r) => r.kind === 'pi' && r.enabled && r.apiKey,
            );
            if (rec) {
                return {
                    provider: rec.id.startsWith('pi:') ? rec.id.slice(3) : rec.id,
                    model: model || rec.defaultModel || rec.models?.[0],
                };
            }
        } catch {
            // 忽略：走 pi 自动检测
        }
        // 应用未配置任何 pi:* 记录：不指定 provider，由 pi 用镜像来的凭据自行决定
        return {model};
    }

    /**
     * 构造子进程环境变量：
     * - **隔离**：`PI_CODING_AGENT_DIR` 指向 adw 自有凭据目录（pi 只读这里，不碰 CLI 的 ~/.pi/agent）
     * - 同时把应用的 pi:* 凭据按 provider 注入同名环境变量（与 auth.json 同源，便于 env 型 provider 解析）
     * - 平台网关回连地址（扩展拉取工具目录/回传调用）
     */
    private buildSpawnEnv(provider: string | undefined, explicitApiKey?: string): Record<string, string> {
        const env: Record<string, string> = piIsolationEnv(true);

        try {
            const store = new ModelProviderStore();
            for (const rec of store.list()) {
                if (rec.kind !== 'pi' || !rec.enabled || !rec.apiKey) continue;
                const providerId = rec.id.startsWith('pi:') ? rec.id.slice(3) : rec.id;
                const envName = PI_PROVIDER_ENV_KEYS[providerId];
                if (envName) env[envName] = rec.apiKey;
            }
        } catch {
            // 读取失败：仅依赖隔离 auth.json
        }

        // 调用方显式传入的 key 优先（对应本次选定的 provider）
        if (explicitApiKey && provider) {
            const envName = PI_PROVIDER_ENV_KEYS[provider];
            if (envName) env[envName] = explicitApiKey;
        }

        const endpoint = getMcpGateway().getPlatformEndpoint();
        if (endpoint) {
            env.ADW_PLATFORM_URL = endpoint.url;
            if (endpoint.apiKey) env.ADW_PLATFORM_KEY = endpoint.apiKey;
        }
        return env;
    }

    /** 解析 adw 平台扩展文件路径（不存在返回 undefined，降级为无扩展运行） */
    private resolveExtensionPath(): string | undefined {
        let dir = __dirname;
        for (let i = 0; i < 8; i++) {
            const p = path.join(dir, EXTENSION_REL_PATH);
            if (existsSync(p)) return p;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return undefined;
    }
}

/**
 * 将项目的 reasoningEffort 映射为 pi 的 thinkingLevel
 */
function mapReasoningToThinkingLevel(
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
    switch (effort) {
        case 'low':
            return 'low';
        case 'medium':
            return 'medium';
        case 'high':
            return 'high';
        case 'xhigh':
        case 'max':
            return 'xhigh';
        default:
            return undefined; // 未指定：pi 按 settings/会话默认
    }
}
