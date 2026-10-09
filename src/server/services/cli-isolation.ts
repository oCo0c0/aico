/**
 * @module cli-isolation
 * @description CLI 引擎配置隔离层 —— 「首次读本地 CLI 配置，之后全走应用自管」。
 *
 * 背景（用户反复踩到的坑）：我们此前直接读写 CLI 自己的配置目录
 * （`~/.claude/settings.json`、`~/.codex/config.toml`、`~/.pi/agent/auth.json`），
 * 于是出现两类问题：
 *   ① 应用里改了配置却不生效 —— CLI 侧配置优先级更高，把我们的注入覆盖掉；
 *   ② 两边状态互相污染 —— 我们把内置技能写进 `~/.claude/skills`，CLI 换 key 后应用行为突变。
 *
 * 策略（与 pi 引擎一致，三个引擎统一）：
 *   1. 每个引擎有应用自管的 home：`~/.aico/<engine>-home`
 *   2. **首次使用**（home 不存在）时，从 CLI 目录**只读复制**一份选定的配置子集进来
 *      —— 保证「本地已装的 CLI 配置」第一次就被读到，不用用户重配；
 *   3. 之后一切读写都发生在隔离 home 内，CLI 目录不再被读、更不会被写；
 *   4. 应用里显式配置的凭据（模型供应商记录）优先级最高，改完立刻生效。
 *
 * 各引擎的 home 环境变量（已确认 CLI 支持）：
 *   - Claude Code：`CLAUDE_CONFIG_DIR`（claude.exe 内确认存在）
 *   - Codex：`CODEX_HOME`（codex.exe 内确认存在）
 *   - Pi：`PI_CODING_AGENT_DIR`（getAgentDir() 读取）
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {APP_DATA_DIR} from '../utils/constants.js';

/** 引擎标识 */
export type EngineId = 'claude' | 'codex';

/** 应用自管的引擎 home（隔离根） */
export const ISOLATED_HOMES: Record<EngineId, string> = {
    claude: path.join(APP_DATA_DIR, 'claude-home'),
    codex: path.join(APP_DATA_DIR, 'codex-home'),
};

/** 引擎读取 home 的环境变量名 */
export const HOME_ENV_KEYS: Record<EngineId, string> = {
    claude: 'CLAUDE_CONFIG_DIR',
    codex: 'CODEX_HOME',
};

/** 用户本机 CLI 的配置目录（仅在首次播种时读取） */
export const CLI_HOMES: Record<EngineId, string> = {
    claude: path.join(os.homedir(), '.claude'),
    codex: path.join(os.homedir(), '.codex'),
};

/**
 * 首次播种/补缺失时从 CLI 目录复制的条目（白名单）。
 *
 * 只复制「配置 / 可复用资产 / **工具执行能力**」类条目，**不复制会话与缓存**
 * （`projects/`、`todos/`、`shell-snapshots/`、`log/` 等体积大且与隔离目标无关；
 * 会话走 seedReferencedSessions 按需迁移）。
 *
 * 能力类条目缺失的后果（用户实测踩过）：
 * - codex 的 `.sandbox-bin/`（命令执行沙箱二进制）、`.sandbox/`、`.sandbox-secrets/`
 *   —— 没有它们 codex 无法执行命令（shell/git 全废）
 * - claude 的 `CLAUDE.md`（用户全局指令）、`plugins/`（插件工具）
 */
const SEED_ENTRIES: Record<EngineId, string[]> = {
    claude: ['settings.json', 'commands', 'skills', 'agents', 'CLAUDE.md', 'plugins'],
    codex: ['config.toml', 'auth.json', 'prompts', '.sandbox-bin', '.sandbox', '.sandbox-secrets'],
};

/** 隔离状态（供日志/接口展示） */
export interface IsolationInfo {
    engine: EngineId;
    /** 隔离 home 目录 */
    home: string;
    /** 本次是否执行了首次播种 */
    seeded: boolean;
    /** 播种来源（CLI 目录）；未播种为 undefined */
    seededFrom?: string;
    /** 播种复制到的条目 */
    seededEntries: string[];
    /** 本次迁移的历史会话文件数（被应用记录引用到的） */
    seededSessions: number;
}

/** 应用自有执行记录目录（agent-executions/<execId>.json） */
const EXECUTIONS_DIR = path.join(APP_DATA_DIR, 'agent-executions');

/** 引擎侧会话在 CLI 目录下的相对位置 */
const CLI_SESSION_DIRS: Record<EngineId, string> = {
    claude: 'projects',
    codex: 'sessions',
};

/**
 * 收集应用执行记录里引用过的引擎 sessionId（去重）。
 *
 * 目的：隔离后旧记录里的 sessionId 会指向 CLI 目录，续聊时找不到会话文件；
 * 首次播种时把这些**被引用到的**会话一并迁进隔离目录，历史执行即可继续。
 */
function collectReferencedSessionIds(): Set<string> {
    const ids = new Set<string>();
    if (!fs.existsSync(EXECUTIONS_DIR)) return ids;
    try {
        for (const entry of fs.readdirSync(EXECUTIONS_DIR)) {
            if (!entry.endsWith('.json')) continue;
            try {
                const rec = JSON.parse(fs.readFileSync(path.join(EXECUTIONS_DIR, entry), 'utf-8')) as {sessionId?: unknown};
                if (typeof rec.sessionId === 'string' && rec.sessionId.trim()) ids.add(rec.sessionId.trim());
            } catch { /* 单条记录损坏不影响其它 */ }
        }
    } catch { /* 读取失败视为无引用 */ }
    return ids;
}

/** 递归收集目录下的所有文件（相对路径） */
function listFilesRecursive(root: string, base = root): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, {withFileTypes: true});
    } catch {
        return out;
    }
    for (const entry of entries) {
        const abs = path.join(root, entry.name);
        if (entry.isDirectory()) out.push(...listFilesRecursive(abs, base));
        else out.push(path.relative(base, abs));
    }
    return out;
}

/**
 * 迁移被应用记录引用到的引擎会话文件（CLI 目录只读）。
 *
 * - claude：`~/.claude/projects/<编码cwd>/<sessionId>.jsonl`（含同名的 `tool-results/` 子目录）
 * - codex：`~/.codex/sessions/<y>/<m>/<d>/rollout-…-<sessionId>.jsonl`
 *
 * @returns 本次复制的会话文件数
 */
function seedReferencedSessions(engine: EngineId, home: string): number {
    const sessionSub = CLI_SESSION_DIRS[engine];
    const cliSessionRoot = path.join(CLI_HOMES[engine], sessionSub);
    if (!fs.existsSync(cliSessionRoot)) return 0;

    const wanted = collectReferencedSessionIds();
    if (wanted.size === 0) return 0;

    let copied = 0;
    for (const rel of listFilesRecursive(cliSessionRoot)) {
        // 命中判定：sessionId 作为「文件名主体」或「目录名」出现（避免前缀误伤）。
        //   会话本体：<...>/<id>.jsonl           → 命中 `<id>.`
        //   附属文件：<...>/<id>/tool-results/*  → 命中 `<id>/`
        // 统一用 '/' 匹配（Windows 下 path.relative 返回反斜杠）。
        // 一个会话可能对应多个文件（jsonl + tool-results），因此必须全部复制。
        const relPosix = rel.split(path.sep).join('/');
        let hit = false;
        for (const id of wanted) {
            if (relPosix.includes(`${id}.`) || relPosix.includes(`${id}/`)) {
                hit = true;
                break;
            }
        }
        if (!hit) continue;
        const src = path.join(cliSessionRoot, rel);
        const dest = path.join(home, sessionSub, rel);
        try {
            fs.mkdirSync(path.dirname(dest), {recursive: true});
            fs.copyFileSync(src, dest);
            copied += 1;
        } catch { /* 单个文件失败不影响其它 */ }
    }
    return copied;
}

/** 进程内已确保过的引擎（避免重复播种检查） */
const ensured = new Set<EngineId>();

/**
 * claude 侧平台 MCP 聚合 server 名。必须与 src/server/platform/mcp-gateway.ts
 * 的 PLATFORM_MCP_SERVER_NAME 保持一致：claude 看到的工具全名是
 * `mcp__<server>__<upstream>__<tool>`，permissions.allow 规则按该前缀匹配。
 */
const CLAUDE_PLATFORM_MCP_SERVER = 'adw-platform';

/**
 * 保证隔离 claude home 满足「无头引擎」的两个权限前提（幂等，只补缺失，不动其它字段）。
 *
 * 背景（无头拉需求被拒的根因，2026-10-08）：
 *  1. `.claude.json` 缺 `bypassPermissionsModeAccepted` —— claude 2.x 在无头模式下
 *     `--permission-mode bypassPermissions` 要求先交互式接受过免责声明，否则**静默降级
 *     default**（CLI 二进制内确认的降级逻辑）。真实 home 是用户交互接受过的；隔离 home
 *     是新生的，永远没有交互机会 → 必须由应用代为接受（隔离 home 本就是应用自管沙箱）。
 *  2. `settings.json` 的 `permissions.allow` 全是「直连时代」前缀（`mcp__ones-api__*` 等，
 *     首次播种从真实配置拷来）——网关架构下所有 MCP 工具挂在平台聚合 server 名下，
 *     全名 `mcp__adw-platform__...`，一条 allow 规则都匹配不上 → 每次工具调用都落
 *     「待授权」→ 无头自动拒绝。并入平台前缀规则后，与模式无关地放行平台工具
 *     （SDK 未传 settingSources → 用户级 settings.json 默认加载，规则生效）。
 *
 * 只写应用自管的隔离 home，绝不触碰用户真实 CLI 配置。
 *
 * @returns 本次实际补上的条目描述（用于日志；空数组 = 已满足，无写入）
 */
export function applyClaudeHeadlessGrants(home: string): string[] {
    const applied: string[] = [];

    // ① .claude.json：bypassPermissionsModeAccepted
    const configPath = path.join(home, '.claude.json');
    let config: Record<string, unknown> = {};
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch { /* 不存在或损坏 → 从空对象重建（该文件本就是 CLI 可自建的状态文件） */ }
    if (config.bypassPermissionsModeAccepted !== true) {
        config.bypassPermissionsModeAccepted = true;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        applied.push('.claude.json:bypassPermissionsModeAccepted');
    }

    // ② settings.json：permissions.allow 并入平台聚合前缀
    const settingsPath = path.join(home, 'settings.json');
    const platformAllow = `mcp__${CLAUDE_PLATFORM_MCP_SERVER}__*`;
    let settings: {permissions?: {allow?: string[]}} = {};
    try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as typeof settings;
    } catch { /* 不存在/损坏 → 跳过（播种会先拷入；无 settings 时走模式路径） */ }
    const allow = settings.permissions?.allow;
    if (Array.isArray(allow) && !allow.includes(platformAllow)) {
        allow.push(platformAllow);
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
        applied.push(`settings.json:permissions.allow+=${platformAllow}`);
    }

    return applied;
}

/**
 * 确保引擎的隔离 home 可用。
 *
 * - home 不存在 → 从 CLI 目录播种白名单条目（不存在则创建空 home）
 * - home 已存在 → **补缺失的白名单条目**（只补没有的，绝不覆盖已有文件：
 *   CLI 侧后续改动不会渗入应用，但「漏播的能力类条目」能被修复——
 *   旧版本创建的隔离目录因此自动升级，不用用户删目录重来）
 * - 进程内缓存：已确保过且无需补条目时直接返回
 *
 * @param engine - 引擎标识
 * @param opts.force - 强制重新检查（忽略进程内缓存）
 */
export function ensureIsolatedHome(engine: EngineId, opts: {force?: boolean} = {}): IsolationInfo {
    const home = ISOLATED_HOMES[engine];
    const cliHome = CLI_HOMES[engine];
    const seededEntries: string[] = [];
    let seeded = false;
    let seededSessions = 0;

    if (!opts.force && ensured.has(engine) && fs.existsSync(home)) {
        return {engine, home, seeded: false, seededEntries, seededSessions};
    }

    try {
        const freshHome = !fs.existsSync(home);
        if (freshHome) {
            // 首次：建目录 + 从 CLI 播种（只读复制，绝不修改 CLI 目录）
            fs.mkdirSync(home, {recursive: true});
        }
        // 首次与既有 home 都走「补缺失」：首次即全量播种，既有 home 只补漏
        const filled = seedMissingEntries(SEED_ENTRIES[engine], cliHome, home);
        seededEntries.push(...filled);
        if (filled.length > 0) {
            seeded = true;
            if (!freshHome) {
                console.log(`[cli-isolation] ${engine} 隔离目录补齐缺失条目：${filled.join('、')}`);
            }
        }

        // 会话文件：按「应用记录里引用到的」精确迁移（体量可控）。
        // 触发条件：隔离目录里还没有对应会话目录 —— 既覆盖首次播种，
        // 也覆盖「早先版本创建的隔离目录（无会话）」，且不会重复搬运。
        const sessionSub = CLI_SESSION_DIRS[engine];
        if (!fs.existsSync(path.join(home, sessionSub))) {
            seededSessions = seedReferencedSessions(engine, home);
        }

        // claude 无头权限前提（幂等，只补缺失）：隔离 home 新生，永远没有交互机会
        // 接受 bypass 免责声明；播种来的 allow 规则也可能是直连时代前缀（匹配不上
        // 平台聚合 server）。缺失会导致无头下 MCP 工具调用被静默拒绝。
        if (engine === 'claude') {
            const granted = applyClaudeHeadlessGrants(home);
            if (granted.length > 0) {
                console.log(`[cli-isolation] claude 隔离目录补无头权限前提：${granted.join('、')}`);
            }
        }
    } catch (err) {
        throw new Error(`初始化 ${engine} 隔离目录失败：${home}（${err instanceof Error ? err.message : String(err)}）`);
    }

    ensured.add(engine);
    return {
        engine,
        home,
        seeded,
        ...(seeded ? {seededFrom: cliHome} : {}),
        seededEntries,
        seededSessions,
    };
}

/**
 * 按需把某个历史会话从 CLI 目录补迁进隔离 home（幂等）。
 *
 * 首次播种只迁移「当时被应用记录引用到」的会话（见 seedReferencedSessions）。
 * 历史记录后来被继续、或播种后才被引用的会话，隔离 home 里就没有，
 * 续聊时会表现为「会话不存在」→ 静默开新会话。这里在续接前做一次定向补迁。
 *
 * @param engine - 引擎标识
 * @param sessionId - 会话 id
 * @returns 隔离 home 中现在是否存在该会话
 */
export function ensureSessionMigrated(engine: EngineId, sessionId: string): boolean {
    if (!sessionId || !/^[A-Za-z0-9_.-]+$/.test(sessionId)) return false;
    const sub = CLI_SESSION_DIRS[engine];
    const home = ISOLATED_HOMES[engine];
    const cliRoot = path.join(CLI_HOMES[engine], sub);
    const isolatedRoot = path.join(home, sub);

    // 已在隔离目录（含附属子目录）：直接判定存在
    const hitIn = (root: string): boolean => {
        if (!fs.existsSync(root)) return false;
        for (const rel of listFilesRecursive(root)) {
            const relPosix = rel.split(path.sep).join('/');
            if (relPosix.includes(`${sessionId}.`) || relPosix.includes(`${sessionId}/`)) return true;
        }
        return false;
    };
    if (hitIn(isolatedRoot)) return true;
    if (!fs.existsSync(cliRoot)) return false;

    let copied = 0;
    for (const rel of listFilesRecursive(cliRoot)) {
        const relPosix = rel.split(path.sep).join('/');
        if (!relPosix.includes(`${sessionId}.`) && !relPosix.includes(`${sessionId}/`)) continue;
        const src = path.join(cliRoot, rel);
        const dest = path.join(isolatedRoot, rel);
        if (fs.existsSync(dest)) continue;
        try {
            fs.mkdirSync(path.dirname(dest), {recursive: true});
            fs.copyFileSync(src, dest);
            copied += 1;
        } catch { /* 单个文件失败不影响其它 */ }
    }
    if (copied > 0) {
        console.log(`[cli-isolation] 按需补迁 ${engine} 会话 ${sessionId}：${copied} 个文件 → ${isolatedRoot}`);
    }
    return hitIn(isolatedRoot);
}

/**
 * 把白名单条目从 CLI 目录补进隔离 home（**只补缺失，绝不覆盖已有**）。
 *
 * 首次播种与「既有 home 的能力补齐」共用：漏掉的能力类条目
 * （codex 沙箱二进制、claude 全局 CLAUDE.md 等）缺失会让对应引擎的工具不可用，
 * 既有安装也要能自动修复，而不是要求用户删掉隔离目录重来。
 *
 * @returns 本次新复制的条目名列表
 */
export function seedMissingEntries(entries: readonly string[], cliHome: string, home: string): string[] {
    const filled: string[] = [];
    for (const entry of entries) {
        const src = path.join(cliHome, entry);
        const dest = path.join(home, entry);
        if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
        try {
            copyRecursive(src, dest);
            filled.push(entry);
        } catch { /* 单个条目复制失败不影响其它 */ }
    }
    return filled;
}

/** 递归复制（文件/目录；目标已存在时覆盖同名文件） */
function copyRecursive(src: string, dest: string): void {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, {recursive: true});
        for (const child of fs.readdirSync(src)) {
            copyRecursive(path.join(src, child), path.join(dest, child));
        }
    } else {
        fs.mkdirSync(path.dirname(dest), {recursive: true});
        fs.copyFileSync(src, dest);
    }
}

/**
 * 隔离 home 内的绝对路径（首次访问前会确保 home 存在）。
 * 所有引擎配置的读写都应经由此函数，不要直接拼 `~/.claude` / `~/.codex`。
 */
export function isolatedPath(engine: EngineId, ...segments: string[]): string {
    ensureIsolatedHome(engine);
    return path.join(ISOLATED_HOMES[engine], ...segments);
}

/** 隔离 home 下某路径是否存在 */
export function isolatedExists(engine: EngineId, ...segments: string[]): boolean {
    return fs.existsSync(isolatedPath(engine, ...segments));
}

/**
 * 引擎子进程的环境片段：把 CLI 的家庭目录指向隔离 home。
 * 与其它 env 合并时请使用「后者覆盖前者」，并让应用配置位于最末（优先级最高）。
 */
export function isolationEnv(engine: EngineId): Record<string, string> {
    ensureIsolatedHome(engine);
    return {[HOME_ENV_KEYS[engine]]: ISOLATED_HOMES[engine]};
}

/** 当前隔离状态快照（诊断/设置页展示用） */
export function isolationStatus(): IsolationInfo[] {
    return (['claude', 'codex'] as EngineId[]).map((engine) => ensureIsolatedHome(engine));
}
