/**
 * @module mcp-config-service
 * @description MCP（Model Context Protocol）服务器配置管理服务模块
 *
 * 该模块负责管理 Claude 的 MCP 服务器配置。MCP 是一种协议，允许 Claude 通过
 * 外部工具服务器扩展其能力（如文件系统访问、数据库操作、API 调用等）。
 * MCP 服务器配置存储在用户主目录下的 `~/.claude/settings.json` 文件中，
 * 与 Claude Code CLI 共享同一份配置。
 *
 * 主要功能：
 * - MCP 服务器配置的增删改查（CRUD）操作
 * - 连接测试：通过启动进程验证 MCP 服务器是否可用
 * - 服务器类型自动推断（根据命令和参数判断运行时类型）
 * - 配置变更时保留 settings.json 中的其他字段
 *
 * @example
 * ```typescript
 * const mcpService = new MCPConfigService();
 * const servers = mcpService.list();
 * const result = await mcpService.testConnection('my-server');
 * ```
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import {spawn} from 'child_process';
import {getErrorMessage} from '../utils/error-utils.js';

/** 禁止出现在 MCP 命令/参数中的 shell 元字符，防止命令注入 */
const SHELL_METACHARACTERS = /[;|&$()<>`"']/;

/**
 * 校验 MCP 命令字符串是否安全。
 * 允许普通可执行文件路径和名称，禁止 shell 元字符。
 */
function validateMcpCommand(command: string): void {
    if (!command || command.trim() === '') {
        throw new Error('MCP Server command is required');
    }
    if (SHELL_METACHARACTERS.test(command)) {
        throw new Error('MCP Server command contains invalid characters');
    }
}

/**
 * 校验 MCP 参数数组是否安全。
 * 要求必须是字符串数组，且每个参数不包含 shell 元字符。
 */
function validateMcpArgs(args: unknown): string[] {
    if (args === undefined || args === null) {
        return [];
    }
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
        throw new Error('MCP Server args must be an array of strings');
    }
    for (const arg of args) {
        if (SHELL_METACHARACTERS.test(arg)) {
            throw new Error('MCP Server args contain invalid characters');
        }
    }
    return args as string[];
}

/**
 * 校验 MCP 环境变量对象是否安全。
 * 要求键值均为字符串。
 */
function validateMcpEnv(env: unknown): Record<string, string> {
    if (env === undefined || env === null) {
        return {};
    }
    if (typeof env !== 'object' || Array.isArray(env)) {
        throw new Error('MCP Server env must be an object');
    }
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
        if (typeof v !== 'string') {
            throw new Error(`MCP Server env value for "${k}" must be a string`);
        }
    }
    return env as Record<string, string>;
}

/**
 * MCP 服务器配置接口
 * @interface MCPServerConfig
 * @description 描述一个 MCP 服务器的完整配置信息
 */
export interface MCPServerConfig {
    /** 服务器名称，作为配置中的唯一标识 */
    name: string;
    /** 服务器运行时类型（由系统根据命令自动推断：node/python/docker/custom） */
    type: string;
    /** 启动服务器的可执行命令 */
    command: string;
    /** 传递给命令的参数数组 */
    args: string[];
    /** 环境变量键值对 */
    env: Record<string, string>;
    /** 服务器是否启用 */
    enabled: boolean;
    /**
     * server 进程工作目录（可选）。
     * 部分 server 按 cwd 推断"项目"位置——不设置时
     * 会继承平台服务进程的启动目录，把无关目录误当项目。
     * 未配置时网关使用平台数据目录（~/.aico）作为默认值。
     */
    cwd?: string;
    /** 服务器连接状态（运行时动态值，非持久化） */
    status?: 'connected' | 'disconnected' | 'error';
}

/**
 * Claude settings.json 文件的内部结构接口
 * @interface ClaudeSettingsFile
 * @description 对应 ~/.claude/settings.json 的完整结构，支持 mcpServers 字段和任意其他字段
 * @internal
 */
interface ClaudeSettingsFile {
    /** MCP 服务器配置映射表，key 为服务器名称 */
    mcpServers?: Record<string, {
        /** 启动命令 */
        command: string;
        /** 命令参数（可选） */
        args?: string[];
        /** 环境变量（可选） */
        env?: Record<string, string>;
    }>;

    /** 允许其他未知字段，保存时原样保留 */
    [key: string]: unknown;
}

/** Claude 配置目录：用户主目录下的 .claude */
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
/** Claude 设置文件路径：~/.claude/settings.json（项目级） */
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
/** Claude 全局配置文件路径：~/.claude.json */
const GLOBAL_SETTINGS_FILE = path.join(os.homedir(), '.claude.json');

/**
 * MCP 配置服务类
 *
 * 管理 Claude 的 MCP 服务器配置，直接读写 Claude Code CLI 的 settings.json 文件。
 * 提供服务器配置的完整生命周期管理：列出、查询、添加、更新、删除和连接测试。
 * 在读写配置时会保留 settings.json 中的其他字段（如 permissions 等）不被破坏。
 *
 * @example
 * ```typescript
 * // 使用默认路径（~/.claude/settings.json）
 * const mcpService = new MCPConfigService();
 * // 使用自定义配置文件路径
 * const mcpService = new MCPConfigService('/path/to/custom-settings.json');
 * ```
 */
export class MCPConfigService {
    /** Claude 设置文件的绝对路径 */
    private settingsFile: string;
    /** Claude 配置目录的绝对路径 */
    private claudeDir: string;

    /**
     * 构造 MCP 配置服务
     * @param settingsFile - 可选的自定义设置文件路径，默认为 ~/.claude/settings.json
     */
    constructor(settingsFile?: string) {
        this.settingsFile = settingsFile ?? SETTINGS_FILE;
        this.claudeDir = path.dirname(this.settingsFile);
    }

    /**
     * 确保 Claude 配置目录存在
     * 如果目录不存在，则递归创建所有必要的父目录。
     */
    private ensureClaudeDir(): void {
        if (!fs.existsSync(this.claudeDir)) {
            fs.mkdirSync(this.claudeDir, {recursive: true});
        }
    }

    /**
     * 从磁盘加载 Claude 设置文件
     *
     * 容错策略：
     * - 文件不存在时返回空对象
     * - JSON 解析失败或内容不是对象时返回空对象
     *
     * @returns ClaudeSettingsFile 解析后的设置对象
     */
    private loadSettings(): ClaudeSettingsFile {
        if (!fs.existsSync(this.settingsFile)) {
            return {};
        }

        try {
            const raw = fs.readFileSync(this.settingsFile, 'utf-8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null) {
                return {};
            }
            return parsed as ClaudeSettingsFile;
        } catch {
            // 解析失败时返回空对象，避免因配置文件损坏导致服务不可用
            return {};
        }
    }

    /**
     * 保存 Claude 设置文件到磁盘
     * 保存前确保目录存在。写入格式化的 JSON，保留文件中的所有字段。
     *
     * @param settings - 要保存的完整设置对象
     */
    private saveSettings(settings: ClaudeSettingsFile): void {
        this.ensureClaudeDir();
        fs.writeFileSync(this.settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
    }

    /**
     * 列出所有已配置的 MCP 服务器
     *
     * 同时读取 ~/.claude/settings.json 和 ~/.claude.json 两个配置文件，
     * 合并两边的 mcpServers（settings.json 优先，同名服务器以 settings.json 为准）。
     * 这样无论用户通过 Claude CLI 还是手动编辑哪个文件，都能被正确识别。
     *
     * @returns MCPServerConfig[] 服务器配置数组
     */
    list(): MCPServerConfig[] {
        // 1. 读取全局配置 ~/.claude.json
        const globalMcpServers = this.loadMcpServersFromFile(GLOBAL_SETTINGS_FILE);
        // 2. 读取项目级配置 ~/.claude/settings.json（优先级更高）
        const localMcpServers = this.loadMcpServersFromFile(this.settingsFile);

        // 3. 合并：全局配置为基础，项目级覆盖同名项
        const merged = {...globalMcpServers, ...localMcpServers};
        const configs: MCPServerConfig[] = [];

        for (const [name, config] of Object.entries(merged)) {
            configs.push({
                name,
                type: this.inferType(config.command, config.args),
                command: config.command,
                args: config.args ?? [],
                env: config.env ?? {},
                enabled: true,
                status: 'disconnected',
            });
        }

        return configs;
    }

    /**
     * 从指定文件中读取 mcpServers 配置
     * @param filePath - 配置文件路径
     * @returns mcpServers 映射表，读取失败返回空对象
     */
    private loadMcpServersFromFile(filePath: string): Record<string, {
        command: string;
        args?: string[];
        env?: Record<string, string>
    }> {
        if (!fs.existsSync(filePath)) {
            return {};
        }
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || !parsed.mcpServers) {
                return {};
            }
            return parsed.mcpServers as Record<string, {
                command: string;
                args?: string[];
                env?: Record<string, string>
            }>;
        } catch {
            return {};
        }
    }

    /**
     * 根据名称获取单个 MCP 服务器配置
     * 同时查找 ~/.claude/settings.json 和 ~/.claude.json，settings.json 优先。
     *
     * @param name - 服务器名称
     * @returns MCPServerConfig | undefined 找到则返回配置，未找到返回 undefined
     */
    get(name: string): MCPServerConfig | undefined {
        // 优先从项目级配置查找
        const localMcpServers = this.loadMcpServersFromFile(this.settingsFile);
        let config = localMcpServers[name];

        // 项目级没有，查全局配置
        if (!config) {
            const globalMcpServers = this.loadMcpServersFromFile(GLOBAL_SETTINGS_FILE);
            config = globalMcpServers[name];
        }

        if (!config) {
            return undefined;
        }

        return {
            name,
            type: this.inferType(config.command, config.args),
            command: config.command,
            args: config.args ?? [],
            env: config.env ?? {},
            enabled: true,
            status: 'disconnected',
        };
    }

    /**
     * 添加新的 MCP 服务器配置
     *
     * 验证名称和命令不为空，检查是否已存在同名服务器，通过验证后写入配置文件。
     *
     * @param config - 要添加的服务器配置（必须包含 name 和 command）
     * @returns MCPServerConfig 添加后的服务器配置（含自动推断的类型）
     * @throws {Error} 名称或命令为空、或同名服务器已存在时抛出
     */
    add(config: MCPServerConfig): MCPServerConfig {
        // 验证必填字段
        if (!config.name || config.name.trim() === '') {
            throw new Error('MCP Server name is required');
        }

        validateMcpCommand(config.command);
        const validatedArgs = validateMcpArgs(config.args);
        const validatedEnv = validateMcpEnv(config.env);

        const settings = this.loadSettings();
        if (!settings.mcpServers) {
            settings.mcpServers = {};
        }

        // 检查同名服务器是否已存在，防止意外覆盖
        if (settings.mcpServers[config.name]) {
            throw new Error(`MCP Server "${config.name}" already exists`);
        }

        // 写入配置：空数组和空对象不写入文件，保持配置文件简洁
        settings.mcpServers[config.name] = {
            command: config.command,
            args: validatedArgs.length > 0 ? validatedArgs : undefined,
            env: Object.keys(validatedEnv).length > 0 ? validatedEnv : undefined,
        };

        this.saveSettings(settings);

        return {
            ...config,
            args: validatedArgs,
            env: validatedEnv,
            type: this.inferType(config.command, validatedArgs),
            status: 'disconnected',
        };
    }

    /**
     * 更新已有的 MCP 服务器配置
     *
     * 支持部分更新（Partial），未指定的字段保持原值。
     * 更新后的配置会写入磁盘。
     *
     * @param name - 要更新的服务器名称
     * @param config - 要更新的配置字段（部分更新）
     * @returns MCPServerConfig 更新后的完整服务器配置
     * @throws {Error} 指定名称的服务器不存在时抛出
     */
    update(name: string, config: Partial<Omit<MCPServerConfig, 'name'>>): MCPServerConfig {
        const settings = this.loadSettings();
        if (!settings.mcpServers) {
            settings.mcpServers = {};
        }

        if (!settings.mcpServers[name]) {
            throw new Error(`MCP Server "${name}" not found`);
        }

        const existing = settings.mcpServers[name];

        // 合并更新：未指定的字段使用已有值，未定义的已有字段使用空默认值
        const updatedCommand = config.command ?? existing.command;
        const updatedArgs = config.args ?? existing.args ?? [];
        const updatedEnv = config.env ?? existing.env ?? {};

        validateMcpCommand(updatedCommand);
        const validatedArgs = validateMcpArgs(updatedArgs);
        const validatedEnv = validateMcpEnv(updatedEnv);

        // 写入更新后的配置
        settings.mcpServers[name] = {
            command: updatedCommand,
            args: validatedArgs.length > 0 ? validatedArgs : undefined,
            env: Object.keys(validatedEnv).length > 0 ? validatedEnv : undefined,
        };

        this.saveSettings(settings);

        return {
            name,
            type: this.inferType(updatedCommand, validatedArgs),
            command: updatedCommand,
            args: validatedArgs,
            env: validatedEnv,
            enabled: config.enabled ?? true,
            status: 'disconnected',
        };
    }

    /**
     * 删除 MCP 服务器配置
     *
     * @param name - 要删除的服务器名称
     * @returns boolean 删除成功返回 true，服务器不存在返回 false
     */
    delete(name: string): boolean {
        const settings = this.loadSettings();
        if (!settings.mcpServers || !settings.mcpServers[name]) {
            return false;
        }

        delete settings.mcpServers[name];
        this.saveSettings(settings);
        return true;
    }

    /**
     * 测试 MCP 服务器连接
     *
     * 通过实际启动 MCP 服务器的命令来验证其是否可用。测试逻辑如下：
     * - 在指定超时时间内进程仍在运行 → 判定为连接成功
     * - 进程正常退出（退出码 0）→ 判定为连接成功
     * - 进程异常退出（非零退出码）→ 判定为连接失败
     * - 进程启动失败（spawn 错误）→ 判定为连接失败
     *
     * 注意：测试完成后会自动终止启动的进程，不会留下残留进程。
     *
     * @param name - 要测试的服务器名称
     * @param timeoutMs - 超时时间（毫秒），默认 5000ms
     * @returns Promise<{ status: 'connected' | 'error'; message: string }> 测试结果
     */
    testConnection(name: string, timeoutMs: number = 5000): Promise<{
        status: 'connected' | 'error';
        message: string
    }> {
        const config = this.get(name);
        if (!config) {
            return Promise.resolve({status: 'error', message: `MCP Server "${name}" not found`});
        }

        return new Promise((resolve) => {
            try {
                // 再次校验，确保从文件读取的配置也符合安全要求
                validateMcpCommand(config.command);
                const safeArgs = validateMcpArgs(config.args);
                const safeEnv = validateMcpEnv(config.env);

                // 启动 MCP 服务器进程，合并当前环境变量和服务器自定义环境变量
                const child = spawn(config.command, safeArgs, {
                    env: {...process.env, ...safeEnv},
                    stdio: ['pipe', 'pipe', 'pipe'],
                    // Windows 平台需要通过 shell 启动以正确解析命令路径（.cmd/.bat）。
                    // 命令和参数已在上层校验不含 shell 元字符，降低注入风险。
                    shell: process.platform === 'win32',
                });

                // 防止多次 resolve 的标志位
                let resolved = false;

                // 超时计时器：如果在超时时间内进程仍在运行，认为启动成功
                const timer = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        // 进程在超时后仍存活，视为连接成功，然后终止测试进程
                        child.kill();
                        resolve({status: 'connected', message: 'MCP Server started successfully'});
                    }
                }, timeoutMs);

                // 进程启动错误处理（命令不存在、权限不足等）
                child.on('error', (err) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timer);
                        resolve({status: 'error', message: `Failed to start: ${err.message}`});
                    }
                });

                // 进程退出处理
                child.on('exit', (code) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timer);
                        if (code === 0) {
                            // 正常退出（某些 MCP 服务器可能快速完成初始化后退出）
                            resolve({status: 'connected', message: 'MCP Server exited cleanly'});
                        } else {
                            // 异常退出
                            resolve({status: 'error', message: `Process exited with code ${code}`});
                        }
                    }
                });
            } catch (err) {
                // spawn 调用本身抛出异常（如参数无效）
                resolve({status: 'error', message: `Failed to spawn process: ${getErrorMessage(err)}`});
            }
        });
    }

    /**
     * 获取设置文件路径
     * @returns string 设置文件的绝对路径
     */
    getSettingsFile(): string {
        return this.settingsFile;
    }

    /**
     * 根据命令和参数推断 MCP 服务器的运行时类型
     *
     * 通过检查命令和参数中是否包含特定关键字来判断服务器类型：
     * - 包含 npx/node/.js → 'node'
     * - 包含 python/.py → 'python'
     * - 包含 docker → 'docker'
     * - 其他 → 'custom'
     *
     * @param command - 启动命令
     * @param args - 命令参数（可选）
     * @returns string 推断出的运行时类型标识
     */
    private inferType(command: string, args?: string[]): string {
        // 将命令和参数拼接为小写字符串进行关键字匹配
        const allParts = [command, ...(args ?? [])].join(' ').toLowerCase();

        if (allParts.includes('npx') || allParts.includes('node') || allParts.includes('.js')) {
            return 'node';
        }
        if (allParts.includes('python') || allParts.includes('.py')) {
            return 'python';
        }
        if (allParts.includes('docker')) {
            return 'docker';
        }

        return 'custom';
    }
}
