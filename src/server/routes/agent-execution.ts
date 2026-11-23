/**
 * @file Agent Execution Routes
 * @description Agent执行API路由 - 简化版：直接执行，无复杂子任务管理
 */

import {Router} from 'express';
import fs from 'fs';
import path from 'path';
import {AgentExecutionStore} from '../services/agent-execution-store.js';
import {createAgentCoordinator, type CoordinatorConfig} from '../services/agent-coordinator.js';
import {WorkspaceService} from '../services/workspace-service.js';
import type {MinerUService} from '../services/mineru-service.js';
import {broadcast} from '../websocket.js';
import {isPathWithinRoots} from '../middleware/validation.js';

/** 附加文档的单文件内容上限（字符），防止超大文档撑爆上下文 */
const MAX_DOCUMENT_CHARS = 100_000;

/**
 * 解析附加文档并追加到需求文本。
 * 文本类（md/txt/json/csv）直接读取；二进制文档（docx/xlsx/pdf 等）走 MinerU
 * 解析（未启用或解析失败时跳过并记日志）——对齐 Plan 页的参考文档模式。
 * 安全约束：路径必须解析到工作区内，防止任意文件读取。
 */
async function enrichWithDocuments(
    requirementText: string,
    documentPaths: string[],
    workspacePath: string,
    mineruService?: MinerUService,
): Promise<{text: string; loaded: string[]; skipped: string[]}> {
    const loaded: string[] = [];
    const skipped: string[] = [];
    const parts: string[] = [];
    const workspaceRoot = path.resolve(workspacePath);

    for (const relPath of documentPaths.slice(0, 5)) {
        if (typeof relPath !== 'string' || !relPath.trim()) continue;
        const fullPath = path.resolve(workspacePath, relPath.trim());
        if (!isPathWithinRoots(fullPath, [workspaceRoot])) {
            skipped.push(`${relPath}（超出工作区范围）`);
            continue;
        }
        try {
            let content = '';
            if (/\.(md|txt|json|csv|log)$/i.test(fullPath)) {
                content = fs.readFileSync(fullPath, 'utf8');
            } else if (mineruService?.isEnabled()) {
                const result = await mineruService.parseFile(fullPath);
                if (result.success && result.markdown) content = result.markdown;
            } else {
                skipped.push(`${relPath}（需启用 MinerU 才能解析 ${path.extname(fullPath) || '该类型'} 文件）`);
                continue;
            }
            if (!content.trim()) {
                skipped.push(`${relPath}（内容为空或解析失败）`);
                continue;
            }
            parts.push(`### ${relPath}\n\n${content.slice(0, MAX_DOCUMENT_CHARS)}`);
            loaded.push(relPath);
        } catch (err) {
            skipped.push(`${relPath}（读取失败：${err instanceof Error ? err.message : String(err)}）`);
        }
    }

    let text = requirementText;
    if (parts.length > 0) {
        text += '\n\n---\n\n## 参考文档\n\n' + parts.join('\n\n---\n\n');
    }
    return {text, loaded, skipped};
}

export function createAgentExecutionRoutes(
    config: CoordinatorConfig,
    workspaceService?: WorkspaceService,
    mineruService?: MinerUService,
): Router {
    const router = Router();
    const store = AgentExecutionStore.getInstance();
    const coordinator = createAgentCoordinator(config);

    /**
     * GET /api/agent-execution/list
     * 列出所有执行记录
     */
    router.get('/list', async (_req, res) => {
        try {
            const list = await store.list();
            res.json(list);
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    /**
     * POST /api/agent-execution/create
     * 创建新执行记录（准备状态，等待启动）
     */
    router.post('/create', async (req, res) => {
        try {
            const {requirementText, workspacePath} = req.body;

            if (!requirementText || typeof requirementText !== 'string') {
                return res.status(400).json({code: 'VALIDATION_ERROR', message: 'requirementText is required'});
            }

            const requirementId = req.body.requirementId || `manual-${Date.now()}`;

            // 附加文档：解析内容追加进需求文本（对齐 Plan 页参考文档模式），
            // 让模型直接看到文档内容，而不是口头说"看文档"
            const documentPaths: string[] = Array.isArray(req.body.documentPaths)
                ? req.body.documentPaths.filter((p: unknown): p is string => typeof p === 'string')
                : [];
            const {text: enrichedText, loaded, skipped} = await enrichWithDocuments(
                requirementText,
                documentPaths,
                workspacePath || '',
                mineruService,
            );

            const execution = await store.create({
                requirementId,
                requirementText: enrichedText,
                requirementNumber: req.body.requirementNumber,
                requirementTitle: req.body.requirementTitle || requirementText.split('\n')[0].substring(0, 50),
                workspacePath: workspacePath || '',
                status: 'ready',
            });

            // 文档加载结果记入日志（前端与模型侧均可见）
            if (loaded.length > 0) {
                const docMsg = `📎 已附加文档：${loaded.join('、')}`;
                await store.addLog(execution.id, docMsg);
            }
            for (const skip of skipped) {
                await store.addLog(execution.id, `⚠️ 文档跳过：${skip}`);
            }

            // 记录到工作区历史，便于下次快速选择（静默失败）
            if (workspacePath && typeof workspacePath === 'string' && workspacePath.trim()) {
                try {
                    workspaceService?.addToHistory(workspacePath);
                } catch { /* 忽略历史记录失败 */ }
            }

            res.json({executionId: execution.id});
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    /**
     * POST /api/agent-execution/:id/start
     * 开始执行
     */
    router.post('/:id/start', async (req, res) => {
        try {
            const {id} = req.params;
            const {message} = req.body || {};

            const execution = await store.get(id);
            if (!execution) {
                return res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
            }

            if (execution.status !== 'ready' && execution.status !== 'paused') {
                return res.status(400).json({
                    code: 'INVALID_STATUS',
                    message: `Execution is not ready: ${execution.status}`
                });
            }

            // 聊天附件：一次性取出并绑定到该执行，协调器组 prompt 时取走注入；
            // 对话日志只落 stub 行，不落全文
            const docs = config.attachments?.drain((req.body?.attachmentIds ?? []) as string[]) ?? [];
            if (docs.length > 0) {
                config.attachments!.bindPending(id, docs);
                const stub = `📎 已附加文档：${docs.map(d => `${d.fileName}（${d.chars} 字）`).join('、')}`;
                await store.addLog(id, stub);
                broadcast({type: 'agent-execution:log', data: {executionId: id, log: stub}});
            }

            // 如果用户在回复框中输入了详细需求但未点发送，start 时一并写入日志
            if (message && typeof message === 'string' && message.trim()) {
                const userMsg = JSON.stringify({type: 'user', content: message.trim()});
                await store.addLog(id, userMsg);
                broadcast({
                    type: 'agent-execution:log',
                    data: {executionId: id, log: userMsg},
                });
            }

            // 异步执行（不阻塞响应）；coordinator 内部已处理错误（更新状态+广播）
            coordinator.execute(id).catch(error => {
                console.error('Execution error:', error);
                // coordinator 已广播 failed 状态，此处仅兜底广播
                broadcast({type: 'agent-execution:status', data: {executionId: id, status: 'failed'}});
            });

            res.json({success: true});
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    /**
     * POST /api/agent-execution/:id/abort
     * 中止执行
     */
    router.post('/:id/abort', async (req, res) => {
        try {
            const {id} = req.params;
            coordinator.abort(id);
            await store.updateStatus(id, 'aborted');
            res.json({success: true});
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    /**
     * POST /api/agent-execution/:id/reply
     * 发送回复消息
     */
    router.post('/:id/reply', async (req, res) => {
        try {
            const {id} = req.params;
            const {message} = req.body || {};

            if (!message || typeof message !== 'string') {
                return res.status(400).json({code: 'VALIDATION_ERROR', message: 'message is required'});
            }

            if (message.length > 10000) {
                return res.status(400).json({
                    code: 'VALIDATION_ERROR',
                    message: 'message is too long (max 10000 characters)'
                });
            }

            const execution = await store.get(id);
            if (!execution) {
                return res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
            }

            // 聊天附件：一次性取出并绑定到该执行（排队分支同样绑定，消费时由协调器取走注入）；
            // 对话日志只落 stub 行，不落全文
            const docs = config.attachments?.drain((req.body?.attachmentIds ?? []) as string[]) ?? [];
            if (docs.length > 0) {
                config.attachments!.bindPending(id, docs);
                const stub = `📎 已附加文档：${docs.map(d => `${d.fileName}（${d.chars} 字）`).join('、')}`;
                await store.addLog(id, stub);
                broadcast({type: 'agent-execution:log', data: {executionId: id, log: stub}});
            }

            if (execution.status === 'running') {
                // 运行中：消息进入 pendingReplies 排队，不写对话日志——
                // 消费时（自动续跑/立即处理）才落日志上屏，避免插入当前轮输出导致顺序错乱
                await store.queueReply(id, message);
                coordinator.markQueuedReply(id);
                res.json({success: true, queued: true});
                return;
            }

            // 非 running：立即写入对话日志（此场景下消息马上被消费，上屏时机即消费时机）
            const userMsg = JSON.stringify({type: 'user', content: message});
            await store.addLog(id, userMsg);
            broadcast({
                type: 'agent-execution:log',
                data: {executionId: id, log: userMsg},
            });

            // 如果执行已完成/失败/中止，直接重新执行（coordinator 内部会设 running 并广播）
            if (execution.status === 'completed' || execution.status === 'failed' || execution.status === 'aborted') {
                // 异步自动执行，无需用户手动点开始
                coordinator.execute(id).catch(error => {
                    console.error('Auto-execute after reply error:', error);
                });
            }

            res.json({success: true, queued: false});
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    /**
     * PUT /api/agent-execution/:id/replies/:index
     * 编辑排队中的消息（运行中排队、尚未消费；越界 500 带原因，前端刷新列表自愈）
     */
    router.put('/:id/replies/:index', async (req, res) => {
        try {
            const {id} = req.params;
            const index = Number(req.params.index);
            const {message} = req.body || {};

            if (!Number.isInteger(index) || index < 0) {
                return res.status(400).json({code: 'VALIDATION_ERROR', message: 'index is required'});
            }
            if (!message || typeof message !== 'string') {
                return res.status(400).json({code: 'VALIDATION_ERROR', message: 'message is required'});
            }
            if (message.length > 10000) {
                return res.status(400).json({
                    code: 'VALIDATION_ERROR',
                    message: 'message is too long (max 10000 characters)'
                });
            }

            await store.updatePendingReply(id, index, message);
            res.json({success: true});
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    /**
     * DELETE /api/agent-execution/:id/replies/:index
     * 删除排队中的消息（不想让执行的内容直接移出队列）
     */
    router.delete('/:id/replies/:index', async (req, res) => {
        try {
            const index = Number(req.params.index);
            if (!Number.isInteger(index) || index < 0) {
                return res.status(400).json({code: 'VALIDATION_ERROR', message: 'index is required'});
            }
            await store.deletePendingReply(req.params.id, index);
            res.json({success: true});
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    /**
     * POST /api/agent-execution/:id/process-now
     * 立即处理排队消息：中止当前轮，自动带新消息续跑
     */
    router.post('/:id/process-now', async (req, res) => {
        try {
            const {id} = req.params;
            const triggered = coordinator.interruptNow(id);
            if (!triggered) {
                return res.status(400).json({code: 'NOT_RUNNING', message: '执行未在运行中，无需立即处理'});
            }
            res.json({success: true});
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    /**
     * POST /api/agent-execution/:id/confirm-tool
     * 确认工具权限请求（允许 / 拒绝 / 允许并记住）
     */
    router.post('/:id/confirm-tool', async (req, res) => {
        try {
            const {id} = req.params;
            const {permissionRequestId, decision, remember, modifiedInput} = req.body || {};

            if (!permissionRequestId || typeof permissionRequestId !== 'string') {
                return res.status(400).json({code: 'VALIDATION_ERROR', message: 'permissionRequestId is required'});
            }
            if (decision !== 'allow' && decision !== 'deny') {
                return res.status(400).json({code: 'VALIDATION_ERROR', message: 'decision must be allow or deny'});
            }

            await coordinator.confirmTool(id, permissionRequestId, decision, remember, modifiedInput);
            res.json({success: true});
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    /**
     * POST /api/agent-execution/:id/new-session
     * 创建新会话（清空上下文）
     */
    router.post('/:id/new-session', async (req, res) => {
        try {
            const execution = await store.get(req.params.id);
            if (!execution) {
                return res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
            }

            await store.updateSessionId(req.params.id, undefined);
            res.json({success: true});
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    /**
     * GET /api/agent-execution/:id/detail
     * 获取执行详情
     */
    router.get('/:id/detail', async (req, res) => {
        try {
            const {id} = req.params;

            const execution = await store.get(id);
            if (!execution) {
                return res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
            }

            res.json(execution);
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    /**
     * DELETE /api/agent-execution/:id
     * 删除执行记录
     */
    router.delete('/:id', async (req, res) => {
        try {
            const {id} = req.params;

            const deleted = await store.delete(id);
            if (!deleted) {
                return res.status(404).json({code: 'NOT_FOUND', message: 'Execution not found'});
            }

            res.json({success: true});
        } catch (error) {
            res.status(500).json({code: 'INTERNAL_ERROR', message: (error as Error).message});
        }
    });

    return router;
}
