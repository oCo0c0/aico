/**
 * @file 工作区管理路由模块
 * @module routes/workspace
 * @description 提供工作区（Workspace）相关的 RESTful API 路由，涵盖：
 *              - 已保存工作区的增删改查
 *              - 活动工作区的选择与历史记录
 *              - 目录浏览与文件内容预览
 *              - 跨平台系统原生文件夹选择器
 *              - Git 状态查看与差异对比
 */

import {Router} from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {spawn} from 'child_process';
import {WorkspaceService} from '../services/workspace-service.js';
import {validateBody, validateWorkspacePath} from '../middleware/validation.js';
import {getErrorMessage} from '../utils/error-utils.js';

/** 文件夹选择器兜底超时：交互式对话框可合法占用很久，只防进程异常挂死 */
const PICKER_TIMEOUT_MS = 10 * 60_000;

/**
 * 对标题进行安全过滤，防止跨平台的 Shell 注入攻击。
 * 仅允许字母、数字、空格、连字符、下划线以及常见中日韩（CJK）字符通过。
 * 截断至最多 100 个字符，过滤后为空则使用默认值 'Select Folder'。
 * @param title - 待过滤的原始标题字符串
 * @returns 过滤后的安全标题字符串
 */
function sanitizeTitle(title: string): string {
    return title.replace(/[^a-zA-Z0-9\s\-_\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, '').slice(0, 100) || 'Select Folder';
}

/**
 * 打开系统原生的文件夹选择对话框。
 * 根据当前运行平台自动选择对应的实现方式：
 * - Windows: 使用 PowerShell 的 Shell.Application COM 对象
 * - macOS: 使用 AppleScript 的 choose folder 命令
 * - Linux: 使用 zenity 图形对话框工具
 * @param title - 文件夹选择对话框的标题（会经过 sanitizeTitle 安全过滤）
 * @returns 用户选择的文件夹路径，若用户取消或出错则返回 null
 */
function openSystemFolderPicker(title: string): Promise<string | null> {
    const safe = sanitizeTitle(title);
    return new Promise((resolve) => {
        const platform = process.platform;
        /** 收口：只认第一次调用（close/error/超时兜底三者竞速），并清理兜底定时器 */
        let settled = false;
        let killer: NodeJS.Timeout | null = null;
        let pickerProcess: import('child_process').ChildProcess | null = null;
        const finish = (value: string | null): void => {
            if (settled) return;
            settled = true;
            if (killer) clearTimeout(killer);
            resolve(value);
        };

        if (platform === 'win32') {
            // Windows 平台：使用 PowerShell 调用 Shell.Application COM 对象
            // 对单引号进行转义，以适配 PowerShell 单引号字符串语法
            const escaped = safe.replace(/'/g, "''");
            const script = [
                '$shell = New-Object -ComObject Shell.Application',
                "$folder = $shell.BrowseForFolder(0, '${escaped}', 0, 0)",
                'if ($folder) { Write-Output $folder.Self.Path }',
            ].join('; ');

            const child = spawn('powershell', ['-NoProfile', '-Command', script], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            pickerProcess = child;

            let output = '';
            child.stdout.on('data', (d: Buffer) => {
                output += d.toString();
            });
            child.on('close', () => finish(output.trim() || null));
            child.on('error', () => finish(null));

        } else if (platform === 'darwin') {
            // macOS 平台：使用 osascript 调用 AppleScript
            // 对双引号进行转义，以适配 osascript 命令
            const escaped = safe.replace(/"/g, '"');
            const script = `choose folder with prompt "${escaped}"`;
            const child = spawn('osascript', ['-e', script], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            pickerProcess = child;
            let output = '';
            child.stdout.on('data', (d: Buffer) => {
                output += d.toString();
            });
            child.on('close', () => {
                // macOS 返回的路径格式为 "alias Macintosh HD:path:to:folder"，需要转换为 POSIX 路径
                const raw = output.trim().replace(/^alias /, '');
                const p = raw ? '/' + raw.split(':').slice(1).join('/') : null;
                finish(p);
            });
            child.on('error', () => finish(null));

        } else {
            // Linux 平台：使用 zenity 图形化文件选择对话框
            // 直接移除双引号字符，防止 zenity --title 参数注入
            const escaped = safe.replace(/"/g, '');
            const child = spawn('zenity', ['--file-selection', '--directory', `--title=${escaped}`], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            pickerProcess = child;
            let output = '';
            child.stdout.on('data', (d: Buffer) => {
                output += d.toString();
            });
            child.on('close', () => finish(output.trim() || null));
            child.on('error', () => finish(null));
        }

        // 安全兜底（10 分钟）：对话框是交互式的，用户浏览目录可合法占用很久，
        // 不能用短超时；这里只防选择器进程异常挂死（从未打开也永不退出）导致
        // Promise 永不 resolve。到点强杀并按「未选择」返回。
        killer = setTimeout(() => {
            pickerProcess?.kill();
            finish(null);
        }, PICKER_TIMEOUT_MS);
    });
}

/**
 * 列出系统可用的根目录/盘符，供文件夹选择器作为起始位置。
 * - Windows: 枚举 A: ~ Z: 中实际存在的盘符（如 C:\\、D:\\）
 * - macOS/Linux: 返回根目录 /
 * @returns {string[]} 盘符/根目录路径数组
 */
function listSystemDrives(): string[] {
    if (process.platform === 'win32') {
        const drives: string[] = [];
        for (let code = 65; code <= 90; code++) {
            const letter = String.fromCharCode(code);
            const root = `${letter}:\\`;
            try {
                if (fs.existsSync(root)) drives.push(root);
            } catch {
                // 跳过无权限访问的盘符
            }
        }
        return drives;
    }
    return ['/'];
}

/**
 * 创建工作区管理路由
 * @param workspaceService - 工作区服务实例，提供工作区的增删改查、浏览、Git 操作等功能
 * @returns 配置好的 Express Router 实例
 *
 * @example
 * ```ts
 * const router = createWorkspaceRoutes(workspaceService);
 * app.use('/api/workspace', router);
 * ```
 */
export function createWorkspaceRoutes(workspaceService: WorkspaceService): Router {
    const router = Router();

    /**
     * 获取允许作为工作区/浏览根目录的列表。
     * 包含用户主目录和所有已保存工作区，避免前端随意访问任意系统目录。
     */
    function getAllowedRoots(): string[] {
        const saved = workspaceService.listSavedWorkspaces().map(w => w.path);
        return [os.homedir(), ...saved];
    }

    /**
     * 校验传入的 workspacePath 是否在允许根目录内。
     * 用于 Git 等会以此为 cwd 执行命令的接口。
     */
    function requireAllowedWorkspace(workspacePath: string): { valid: boolean; path?: string; error?: string } {
        if (!workspacePath) {
            return {valid: false, error: 'workspacePath is required'};
        }
        return validateWorkspacePath(workspacePath, getAllowedRoots());
    }

    // ─── 已保存的工作区 ────────────────────────────────────────────────────────

    /**
     * GET /api/workspace/saved
     * @description 获取所有已保存的工作区列表
     * @returns {Object[]} 工作区数组
     */
    router.get('/saved', (_req, res) => {
        try {
            res.json(workspaceService.listSavedWorkspaces());
        } catch (err) {
            res.status(500).json({code: 'WORKSPACE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * POST /api/workspace/saved
     * @description 将一个工作区路径添加到已保存列表中
     * @param {string} path.body - 工作区路径（必填）
     * @param {string} [name.body] - 工作区显示名称（可选，不提供则自动推断）
     * @returns {Object} 保存后的工作区数据，HTTP 201
     */
    router.post('/saved', validateBody([{field: 'path', required: true, type: 'string'}]), (req, res) => {
        try {
            const {path: workspacePath, name} = req.body as { path: string; name?: string };

            // workspace 路径安全校验
            const wsCheck = validateWorkspacePath(workspacePath);
            if (!wsCheck.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
                return;
            }

            const saved = workspaceService.addSavedWorkspace(wsCheck.path!, name);
            res.status(201).json(saved);
        } catch (err) {
            res.status(400).json({code: 'WORKSPACE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * PUT /api/workspace/saved/:id
     * @description 重命名已保存的工作区
     * @param {string} id.path - 工作区的唯一标识符
     * @param {string} name.body - 新的工作区显示名称
     * @returns {Object} 更新后的工作区数据
     */
    router.put('/saved/:id', (req, res) => {
        try {
            const {name} = req.body as { name: string };
            const updated = workspaceService.updateSavedWorkspaceName(req.params.id, name);
            if (!updated) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Workspace not found'});
                return;
            }
            res.json(updated);
        } catch (err) {
            res.status(400).json({code: 'WORKSPACE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * DELETE /api/workspace/saved/:id
     * @description 从已保存列表中移除指定的工作区
     * @param {string} id.path - 工作区的唯一标识符
     * @returns {{ success: boolean }} 删除操作是否成功
     */
    router.delete('/saved/:id', (req, res) => {
        try {
            const deleted = workspaceService.removeSavedWorkspace(req.params.id);
            res.json({success: deleted});
        } catch (err) {
            res.status(500).json({code: 'WORKSPACE_ERROR', message: getErrorMessage(err)});
        }
    });

    // ─── 旧版接口 / 活动工作区 ───────────────────────────────────────────────

    /**
     * POST /api/workspace/select
     * @description 选择一个工作区作为当前活动工作区，同时将该路径添加到历史记录中
     * @param {string} path.body - 工作区路径（必填）
     * @returns {Object} 工作区基本信息
     */
    router.post('/select', validateBody([{field: 'path', required: true, type: 'string'}]), async (req, res) => {
        try {
            const workspacePath = req.body.path as string;
            const info = workspaceService.select(workspacePath);
            workspaceService.addToHistory(workspacePath);
            res.json(info);
        } catch (err) {
            res.status(400).json({code: 'WORKSPACE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * GET /api/workspace/history
     * @description 获取工作区的历史选择记录
     * @returns {Object[]} 历史工作区列表（按最近使用排序）
     */
    router.get('/history', (_req, res) => {
        try {
            res.json(workspaceService.getHistory());
        } catch (err) {
            res.status(500).json({code: 'WORKSPACE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * GET /api/workspace/drives
     * @description 获取系统可用盘符（Windows）或根目录（macOS/Linux），
     *              作为文件夹选择器的起始位置（如 C:\、D:\ 等）。
     * @returns {string[]} 盘符/根目录路径数组
     */
    router.get('/drives', (_req, res) => {
        try {
            res.json(listSystemDrives());
        } catch (err) {
            res.status(500).json({code: 'WORKSPACE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * GET /api/workspace/picker-browse?path=
     * @description 浏览任意绝对路径（文件夹选择器专用，不受允许根目录限制）。
     *              仅用于本机文件夹选择 UI，用户可浏览系统盘符下的任意目录。
     * @param {string} path.query - 要浏览的目录绝对路径（必填）
     * @returns {Object[]} 目录下的条目列表（文件和文件夹）
     */
    router.get('/picker-browse', (req, res) => {
        try {
            const dirPath = (req.query.path as string) || '';
            if (!dirPath.trim()) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'path is required'});
                return;
            }
            // 仅做路径规范化与遍历防护，不限制根目录（选择器需要浏览任意盘符）
            const check = validateWorkspacePath(dirPath);
            if (!check.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: check.error});
                return;
            }
            const entries = workspaceService.browse(check.path!);
            res.json(entries);
        } catch (err) {
            res.status(400).json({code: 'WORKSPACE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * GET /api/workspace/browse?path=
     * @description 浏览指定目录的内容。若未提供路径参数，默认浏览用户主目录。
     * @param {string} [path.query] - 要浏览的目录路径（可选，默认为用户主目录）
     * @returns {Object[]} 目录下的条目列表（文件和文件夹）
     */
    router.get('/browse', (req, res) => {
        try {
            const dirPath = (req.query.path as string) || '';
            let resolvedPath: string;
            if (dirPath.trim() === '') {
                resolvedPath = os.homedir();
            } else {
                const check = validateWorkspacePath(dirPath, getAllowedRoots());
                if (!check.valid) {
                    res.status(400).json({code: 'VALIDATION_ERROR', message: check.error});
                    return;
                }
                resolvedPath = check.path!;
            }
            const entries = workspaceService.browse(resolvedPath);
            res.json(entries);
        } catch (err) {
            res.status(400).json({code: 'WORKSPACE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * GET /api/workspace/file?path=&workspace=
     * @description 读取指定文件的内容用于预览。
     *              文件路径必须在指定的工作区范围内（安全校验）。
     * @param {string} path.query - 文件路径（必填）
     * @param {string} workspace.query - 工作区路径（必填，用于安全校验）
     * @returns {Object} 包含文件名、内容、语言类型等信息的对象
     */
    router.get('/file', (req, res) => {
        try {
            const filePath = req.query.path as string;
            const workspacePath = req.query.workspace as string;

            if (!filePath || !workspacePath) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'path and workspace are required'});
                return;
            }

            const wsCheck = validateWorkspacePath(workspacePath, getAllowedRoots());
            if (!wsCheck.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
                return;
            }

            const result = workspaceService.readFileContent(filePath, wsCheck.path!);
            res.json(result);
        } catch (err) {
            res.status(400).json({code: 'WORKSPACE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * POST /api/workspace/pick
     * @description 打开系统原生的文件夹选择对话框，返回用户选择的路径。
     *              支持跨平台（Windows/macOS/Linux），标题会经过安全过滤。
     * @param {string} [title.body] - 对话框标题（可选，默认为 'Select Workspace Folder'）
     * @returns {{ path: string | null }} 用户选择的文件夹路径，取消时为 null
     */
    router.post('/pick', async (req, res) => {
        try {
            const title = (req.body?.title as string) || 'Select Workspace Folder';
            const selectedPath = await openSystemFolderPicker(title);
            res.json({path: selectedPath});
        } catch (err) {
            res.status(500).json({code: 'WORKSPACE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * POST /api/workspace/reveal
     * @description 在系统文件管理器中显示文件/目录（定位并选中）
     * @param {string} path.body - 文件或目录的绝对路径（必填）
     * @returns {{success: true}}
     */
    router.post('/reveal', validateBody([{field: 'path', required: true, type: 'string'}]), (req, res) => {
        const target = String(req.body?.path ?? '').trim();
        if (!target || !fs.existsSync(target)) {
            res.status(400).json({code: 'PATH_NOT_FOUND', message: `路径不存在: ${target}`});
            return;
        }
        try {
            const platform = process.platform;
            if (platform === 'win32') {
                const isDir = fs.statSync(target).isDirectory();
                if (isDir) {
                    spawn('explorer', [target], {detached: true, stdio: 'ignore'}).unref();
                } else {
                    // /select 参数含空格时 explorer 解析怪异：windowsVerbatimArguments + 手工引号
                    spawn('explorer', [`/select,"${target}"`], {
                        detached: true,
                        stdio: 'ignore',
                        windowsVerbatimArguments: true,
                    }).unref();
                }
            } else if (platform === 'darwin') {
                spawn('open', ['-R', target], {detached: true, stdio: 'ignore'}).unref();
            } else {
                const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
                spawn('xdg-open', [dir], {detached: true, stdio: 'ignore'}).unref();
            }
            res.json({success: true});
        } catch (err) {
            res.status(500).json({code: 'REVEAL_ERROR', message: getErrorMessage(err)});
        }
    });

    // ─── Git 操作 ────────────────────────────────────────────────────────

    /**
     * GET /api/workspace/git/status?workspacePath=
     * @description 获取指定工作区的 Git 仓库状态信息
     * @param {string} workspacePath.query - 工作区路径（必填）
     * @returns {Object} Git 状态信息，包含分支、变更文件等
     */
    router.get('/git/status', async (req, res) => {
        try {
            const workspacePath = req.query.workspacePath as string;
            const wsCheck = requireAllowedWorkspace(workspacePath);
            if (!wsCheck.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
                return;
            }
            const result = await workspaceService.gitStatus(wsCheck.path!);
            res.json(result);
        } catch (err) {
            res.status(500).json({code: 'GIT_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * GET /api/workspace/git/diff?workspacePath=xxx&file=xxx
     * @description 获取指定工作区的 Git 差异信息。
     *              可选指定单个文件以查看该文件的差异。
     * @param {string} workspacePath.query - 工作区路径（必填）
     * @param {string} [file.query] - 指定查看差异的文件路径（可选）
     * @returns {Object} Git 差异信息
     */
    router.get('/git/diff', async (req, res) => {
        try {
            const workspacePath = req.query.workspacePath as string;
            const file = req.query.file as string | undefined;
            const wsCheck = requireAllowedWorkspace(workspacePath);
            if (!wsCheck.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
                return;
            }
            const result = await workspaceService.gitDiff(wsCheck.path!, file);
            res.json(result);
        } catch (err) {
            res.status(500).json({code: 'GIT_ERROR', message: getErrorMessage(err)});
        }
    });

    // ==================== Git 分支操作 ====================

    /** GET /api/workspace/git/branches?workspacePath=xxx */
    router.get('/git/branches', async (req, res) => {
        try {
            const workspacePath = req.query.workspacePath as string;
            const wsCheck = requireAllowedWorkspace(workspacePath);
            if (!wsCheck.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
                return;
            }
            res.json(await workspaceService.gitBranchList(wsCheck.path!));
        } catch (err) {
            res.status(500).json({code: 'GIT_ERROR', message: getErrorMessage(err)});
        }
    });

    /** POST /api/workspace/git/checkout  body: {workspacePath, branch} */
    router.post('/git/checkout', async (req, res) => {
        try {
            const {workspacePath, branch} = req.body as { workspacePath: string; branch: string };
            if (!branch) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'branch is required'});
                return;
            }
            const wsCheck = requireAllowedWorkspace(workspacePath);
            if (!wsCheck.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
                return;
            }
            res.json(await workspaceService.gitCheckout(wsCheck.path!, branch));
        } catch (err) {
            res.status(500).json({code: 'GIT_ERROR', message: getErrorMessage(err)});
        }
    });

    /** POST /api/workspace/git/stash  body: {workspacePath, message?} */
    router.post('/git/stash', async (req, res) => {
        try {
            const {workspacePath, message} = req.body as { workspacePath: string; message?: string };
            const wsCheck = requireAllowedWorkspace(workspacePath);
            if (!wsCheck.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
                return;
            }
            res.json(await workspaceService.gitStash(wsCheck.path!, message));
        } catch (err) {
            res.status(500).json({code: 'GIT_ERROR', message: getErrorMessage(err)});
        }
    });

    /** POST /api/workspace/git/stash-pop  body: {workspacePath} */
    router.post('/git/stash-pop', async (req, res) => {
        try {
            const {workspacePath} = req.body as { workspacePath: string };
            const wsCheck = requireAllowedWorkspace(workspacePath);
            if (!wsCheck.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
                return;
            }
            res.json(await workspaceService.gitStashPop(wsCheck.path!));
        } catch (err) {
            res.status(500).json({code: 'GIT_ERROR', message: getErrorMessage(err)});
        }
    });

    /** POST /api/workspace/git/checkout-force  body: {workspacePath, branch} */
    router.post('/git/checkout-force', async (req, res) => {
        try {
            const {workspacePath, branch} = req.body as { workspacePath: string; branch: string };
            if (!branch) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'branch is required'});
                return;
            }
            const wsCheck = requireAllowedWorkspace(workspacePath);
            if (!wsCheck.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
                return;
            }
            res.json(await workspaceService.gitCheckoutForce(wsCheck.path!, branch));
        } catch (err) {
            res.status(500).json({code: 'GIT_ERROR', message: getErrorMessage(err)});
        }
    });

    /** POST /api/workspace/git/merge  body: {workspacePath, sourceBranch} */
    router.post('/git/merge', async (req, res) => {
        try {
            const {workspacePath, sourceBranch} = req.body as { workspacePath: string; sourceBranch: string };
            if (!sourceBranch) {
                res.status(400).json({
                    code: 'VALIDATION_ERROR',
                    message: 'sourceBranch is required'
                });
                return;
            }
            const wsCheck = requireAllowedWorkspace(workspacePath);
            if (!wsCheck.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
                return;
            }
            res.json(await workspaceService.gitMergeBranch(wsCheck.path!, sourceBranch));
        } catch (err) {
            res.status(500).json({code: 'GIT_ERROR', message: getErrorMessage(err)});
        }
    });

    /** GET /api/workspace/git/conflict-diff?workspacePath=xxx&file=xxx */
    router.get('/git/conflict-diff', async (req, res) => {
        try {
            const workspacePath = req.query.workspacePath as string;
            const file = req.query.file as string;
            if (!file) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'file is required'});
                return;
            }
            const wsCheck = requireAllowedWorkspace(workspacePath);
            if (!wsCheck.valid) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
                return;
            }
            const content = await workspaceService.gitConflictDiff(wsCheck.path!, file);
            res.json({path: file, content});
        } catch (err) {
            res.status(500).json({code: 'GIT_ERROR', message: getErrorMessage(err)});
        }
    });

    // ─── 远程分支列表 ──────────────────────────────────────────────────────────

    /**
     * GET /api/workspace/:id/remote-branches
     * @description 获取指定工作区的远程分支列表
     * @param {string} id.param - 已保存工作区的 ID
     * @returns {string[]} 远程分支名列表
     */
    router.get('/:id/remote-branches', async (req, res) => {
        try {
            const ws = workspaceService.listSavedWorkspaces().find(w => w.id === req.params.id);
            if (!ws) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Workspace not found'});
                return;
            }
            const branches = await workspaceService.listRemoteBranches(ws.path);
            res.json(branches);
        } catch (err) {
            res.status(500).json({code: 'GIT_ERROR', message: getErrorMessage(err)});
        }
    });

    return router;
}
