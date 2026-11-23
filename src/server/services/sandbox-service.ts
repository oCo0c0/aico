/**
 * @file Daytona 沙箱服务
 * @description 封装 Daytona SDK，提供统一的沙箱管理接口。
 *   当 Daytona 未配置时，所有方法返回 null/false，上层服务透明回退到本地执行。
 *   沙箱按 workspacePath 复用，避免重复创建。
 */

import {Daytona, Sandbox, SandboxState} from '@daytona/sdk';
import {execSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {DAYTONA_DEFAULTS, TIMEOUTS} from '../utils/constants.js';
import {getErrorMessage} from '../utils/error-utils.js';
import {validateWorkspacePath} from '../middleware/validation.js';

/** 禁止出现在沙箱命令中的 shell 元字符 */
const SHELL_METACHARACTERS = /[;|&$()<>`"']/;

/** Daytona 沙箱配置（从 AppConfig['daytona'] 提取） */
export interface DaytonaConfig {
    apiKey?: string;
    apiUrl?: string;
    /** 是否启用 Daytona 沙箱 */
    enabled?: boolean;
    /** 创建沙箱时使用的镜像模板（sandboxId 为空时生效） */
    template?: string;
    /** 预创建的沙箱 ID（优先级最高，指定后不再自动创建沙箱） */
    sandboxId?: string;
}

/** 沙箱执行结果 */
export interface SandboxExecResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/** 沙箱状态信息 */
export interface SandboxInfo {
    id: string;
    name: string;
    state: string;
    workspacePath: string;
}

/**
 * Daytona 沙箱服务
 *
 * 封装 Daytona SDK 客户端，提供沙箱生命周期管理和命令执行能力。
 * 设计原则：Daytona 未配置时所有操作静默降级，不抛异常。
 */
export class SandboxService {
    private client: Daytona | null = null;
    private config: DaytonaConfig;
    /** workspacePath → Sandbox 实例缓存 */
    private sandboxes: Map<string, Sandbox> = new Map();

    constructor(config: DaytonaConfig | undefined) {
        this.config = config ?? {};
        this.initClient();
    }

    /** 初始化 Daytona 客户端 */
    private initClient(): void {
        if (!this.config.enabled || !this.config.apiKey) return;
        try {
            this.client = new Daytona({
                apiKey: this.config.apiKey,
                apiUrl: this.config.apiUrl ?? DAYTONA_DEFAULTS.API_URL,
            });
        } catch (err) {
            this.client = null;
        }
    }

    /** Daytona 沙箱是否启用 */
    isEnabled(): boolean {
        return this.client !== null && this.config.enabled === true;
    }

    /** 获取或创建沙箱 */
    async getSandbox(workspacePath: string, overrideSandboxId?: string): Promise<Sandbox | null> {
        if (!this.isEnabled() || !this.client) return null;

        // 确定使用的 sandboxId：调用参数 > 配置文件
        const targetSandboxId = overrideSandboxId || this.config.sandboxId;

        // 模式一：指定了 sandboxId，直接获取（不创建新的）
        if (targetSandboxId) {
            const cached = this.sandboxes.get(targetSandboxId);
            if (cached) {
                try {
                    await cached.refreshData();
                    if (cached.state === SandboxState.STARTED) return cached;
                } catch {
                    this.sandboxes.delete(targetSandboxId);
                }
            }

            try {
                const sandbox = await this.client.get(targetSandboxId);
                this.sandboxes.set(targetSandboxId, sandbox);
                console.log(`[sandbox] Using sandbox: ${targetSandboxId} (${sandbox.state})`);
                return sandbox;
            } catch (err) {
                console.error(`[sandbox] Failed to get sandbox "${targetSandboxId}": ${getErrorMessage(err)}`);
                return null;
            }
        }

        // 模式二：自动创建（按 workspacePath 复用）
        const cached = this.sandboxes.get(workspacePath);
        if (cached) {
            try {
                // 刷新沙箱状态
                await cached.refreshData();
                if (cached.state === SandboxState.STARTED) return cached;
            } catch (err) {
                // 沙箱已失效，移除缓存
                console.warn(`[sandbox] Cached sandbox for "${workspacePath}" is stale, removing: ${getErrorMessage(err)}`);
                this.sandboxes.delete(workspacePath);
            }
        }

        try {
            const sandboxName = `aiwb-${Buffer.from(workspacePath).toString('base64url').slice(0, 20)}`;
            const sandbox = await this.client.create({
                name: sandboxName,
                snapshot: this.config.template || DAYTONA_DEFAULTS.DEFAULT_TEMPLATE,
                labels: {'aiwb-workspace': workspacePath},
                autoStopInterval: 60, // 60 分钟无活动后停止
            }, {timeout: TIMEOUTS.BRIDGE_START});

            this.sandboxes.set(workspacePath, sandbox);
            return sandbox;
        } catch (err) {
            console.error(`[sandbox] Failed to create sandbox for "${workspacePath}": ${getErrorMessage(err)}`);
            return null;
        }
    }

    /** 在沙箱中执行命令 */
    async executeCommand(
        workspacePath: string,
        command: string,
        cwd?: string,
        env?: Record<string, string>,
        sandboxId?: string,
    ): Promise<SandboxExecResult | null> {
        if (SHELL_METACHARACTERS.test(command)) {
            throw new Error('Sandbox command contains invalid shell characters');
        }

        const sandbox = await this.getSandbox(workspacePath, sandboxId);
        if (!sandbox) return null;

        try {
            const result = await sandbox.process.executeCommand(
                command,
                cwd,
                env,
                TIMEOUTS.TEST_EXECUTION,
            );
            return {
                exitCode: result.exitCode,
                stdout: result.result,
                stderr: '',
            };
        } catch (err) {
            console.error(`[sandbox] Command execution failed in sandbox for "${workspacePath}": ${getErrorMessage(err)}`);
            return null;
        }
    }

    /**
     * 将本地工作区的变更文件同步到沙箱
     *
     * 使用 git 获取变更文件列表（包括未提交的新文件），
     * 通过 Daytona SDK 的 uploadFiles API 上传到沙箱。
     * 无 git 仓库时回退到全量同步最近修改的文件。
     *
     * @param localPath - 本地工作区路径
     * @param sandboxId - 目标沙箱 ID
     * @returns 是否同步成功
     */
    async syncChangedFiles(localPath: string, sandboxId?: string): Promise<boolean> {
        // 校验本地路径：禁止路径遍历，且必须位于用户主目录下
        const wsCheck = validateWorkspacePath(localPath, [require('os').homedir()]);
        if (!wsCheck.valid) {
            console.error(`[sandbox] Invalid localPath for sync: ${wsCheck.error}`);
            return false;
        }
        const safeLocalPath = wsCheck.path!;

        const sandbox = await this.getSandbox(safeLocalPath, sandboxId);
        if (!sandbox) return false;

        try {
            // 获取变更文件列表：git 索引中的所有文件 + 未跟踪的新文件
            let filesToSync: string[];
            try {
                const tracked = execSync('git ls-files', {cwd: safeLocalPath, encoding: 'utf-8'}).trim();
                const untracked = execSync('git ls-files --others --exclude-standard', {
                    cwd: safeLocalPath,
                    encoding: 'utf-8'
                }).trim();
                filesToSync = [...tracked.split('\n'), ...untracked.split('\n')]
                    .map(f => f.trim())
                    .filter(f => f.length > 0);
            } catch {
                // 无 git 仓库，尝试获取最近修改的文件
                console.warn(`[sandbox] Not a git repo, falling back to recent file scan: ${safeLocalPath}`);
                filesToSync = this.getRecentFiles(safeLocalPath);
            }

            if (filesToSync.length === 0) {
                console.warn(`[sandbox] No files to sync from ${safeLocalPath}`);
                return true;
            }

            // 分批上传（避免单次请求过大）
            const BATCH_SIZE = 50;
            for (let i = 0; i < filesToSync.length; i += BATCH_SIZE) {
                const batch = filesToSync.slice(i, i + BATCH_SIZE);
                const uploads = batch
                    .filter(f => {
                        const fullPath = path.join(safeLocalPath, f);
                        return fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
                    })
                    .map(f => ({
                        source: path.join(safeLocalPath, f),
                        destination: `/workspace/${f}`,
                    }));

                if (uploads.length > 0) {
                    await sandbox.fs.uploadFiles(uploads, 600);
                }
            }

            console.log(`[sandbox] Synced ${filesToSync.length} files to sandbox`);
            return true;
        } catch (err) {
            console.error(`[sandbox] File sync failed: ${getErrorMessage(err)}`);
            return false;
        }
    }

    /**
     * 获取最近修改的文件列表（非 git 仓库的回退方案）
     * 递归扫描目录，返回最近 24 小时内修改的文件，排除 node_modules 等
     */
    private getRecentFiles(rootPath: string): string[] {
        const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.gradle', 'target']);
        const result: string[] = [];
        const now = Date.now();
        const ONE_DAY = 24 * 60 * 60 * 1000;

        const walk = (dir: string) => {
            try {
                const entries = fs.readdirSync(dir, {withFileTypes: true});
                for (const entry of entries) {
                    if (EXCLUDE.has(entry.name)) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        walk(fullPath);
                    } else if (entry.isFile()) {
                        const stat = fs.statSync(fullPath);
                        if (now - stat.mtimeMs < ONE_DAY) {
                            result.push(path.relative(rootPath, fullPath).replace(/\\/g, '/'));
                        }
                    }
                }
            } catch {
                // 忽略权限错误等
            }
        };

        walk(rootPath);
        return result;
    }

    /** 获取所有活跃沙箱信息 */
    async listActive(): Promise<SandboxInfo[]> {
        if (!this.isEnabled() || !this.client) return [];

        try {
            const iterator = this.client.list();
            const items: Sandbox[] = [];
            for await (const s of iterator) items.push(s);
            return items
                .filter((s: Sandbox) => s.state === SandboxState.STARTED)
                .map((s: Sandbox) => ({
                    id: s.id,
                    name: s.name ?? '',
                    state: s.state ?? 'unknown',
                    workspacePath: s.labels?.['airbag-workspace'] ?? '',
                }));
        } catch {
            return [];
        }
    }

    /** 销毁指定沙箱 */
    async destroySandbox(workspacePath: string): Promise<boolean> {
        const sandbox = this.sandboxes.get(workspacePath);
        if (!sandbox) return false;

        try {
            await sandbox.delete();
            this.sandboxes.delete(workspacePath);
            return true;
        } catch {
            return false;
        }
    }

    /** 销毁所有缓存沙箱（服务关闭时调用） */
    async cleanup(): Promise<void> {
        const paths = [...this.sandboxes.keys()];
        await Promise.allSettled(paths.map(p => this.destroySandbox(p)));
    }

    /** 获取当前配置状态（用于调试/状态接口） */
    getStatus(): { enabled: boolean; apiUrl: string; sandboxId?: string; template?: string; activeCount: number } {
        return {
            enabled: this.isEnabled(),
            apiUrl: this.config.apiUrl ?? DAYTONA_DEFAULTS.API_URL,
            sandboxId: this.config.sandboxId || undefined,
            template: this.config.sandboxId ? undefined : (this.config.template || DAYTONA_DEFAULTS.DEFAULT_TEMPLATE),
            activeCount: this.sandboxes.size,
        };
    }
}
