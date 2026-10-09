/**
 * @file 需求管理路由模块
 * @module routes/requirements
 * @description 提供需求相关的 RESTful API 路由，包括本地需求存储管理、
 *              agent 中介的需求拉取与搜索（标准 MCP 消费模式：AI 引擎动态
 *              面对已挂载的 MCP 工具，读 schema → 自主选择与调用，零源硬编码）。
 *              新增需求源 = 在 MCP 设置页配置 server，本路由零改动。
 */

import {Router} from 'express';
import {RequirementStoreService} from '../services/requirement-store-service.js';
import type {MinerUService} from '../services/mineru-service.js';
import type {RequirementAgentFetchService, AgentFetchProgress} from '../services/requirement-agent-fetch.js';
import {createAttachmentImageService} from '../services/ones-image-service.js';
import type {MCPRegistryService} from '../services/mcp-registry-service.js';
import {getErrorMessage} from '../utils/error-utils.js';
import {mergeParsedIntoDescription} from '../utils/parse-merge.js';
import {broadcast} from '../websocket.js';

/**
 * 构造 agent 拉取过程事件转发器：把 AgentFetchProgress 广播为 WebSocket
 * `requirement:fetch_progress`（data 附 source 标记来源），前端实时渲染
 * 工具调用 / 思考 / 重试等拉取过程。
 */
function emitFetchProgress(source: 'fetch' | 'search' | 'detail'): (event: AgentFetchProgress) => void {
    return (event) => broadcast({type: 'requirement:fetch_progress', data: {...event, source}});
}

/**
 * 创建需求管理路由
 * @param requirementStore - 需求本地存储服务实例，用于持久化已保存的需求
 * @param mineruService - MinerU 文档解析服务（可选）
 * @param agentFetch - agent 中介需求拉取服务（唯一拉取路径）
 * @param mcpRegistryService - MCP 注册中心（附件认证插件按 server env 构建）
 * @returns 配置好的 Express Router 实例
 *
 * @example
 * ```ts
 * const router = createRequirementsRoutes(requirementStore, mineruService, agentFetch, mcpRegistry);
 * app.use('/api/requirements', router);
 * ```
 */
export function createRequirementsRoutes(
    requirementStore: RequirementStoreService,
    mineruService?: MinerUService,
    agentFetch?: RequirementAgentFetchService,
    mcpRegistryService?: MCPRegistryService,
): Router {
    const router = Router();

    // ─── 本地存储（已保存的需求） ───────────────────────────────────────────────

    /**
     * POST /api/requirements/create
     * @description 手动创建需求，描述中可包含 MinerU 解析后的 Markdown
     * @body { title: string, description?: string }
     * @returns {Object} 创建的需求对象
     */
    router.post('/create', async (req, res) => {
        try {
            const title = (req.body.title as string)?.trim();
            if (!title) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'title is required'});
                return;
            }

            const number = (req.body.number as string)?.trim();
            if (!number) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'number is required (e.g. CWXT-130341)'});
                return;
            }

            const description = (req.body.description as string)?.trim() ?? '';
            const mode = (req.body.mode as 'overwrite' | 'merge' | undefined);

            // 重复检测：id 直接用 number（全局唯一）
            const existing = requirementStore.get(number);
            if (existing && !mode) {
                res.status(409).json({
                    code: 'DUPLICATE_NUMBER',
                    message: `需求号 ${number} 已存在`,
                    existingId: existing.id,
                    existingTitle: existing.title,
                });
                return;
            }

            // 合并模式：追加描述到已存在需求
            if (existing && mode === 'merge') {
                const mergedDesc = (existing.description ?? '') + '\n\n---\n\n' + description;
                const merged = {
                    ...existing,
                    title: title || existing.title,
                    description: mergedDesc,
                    updatedAt: new Date().toISOString(),
                };
                const saved = requirementStore.upsert(merged);
                res.json(saved);
                return;
            }

            // 新建或覆盖：id = number
            const requirement = {
                id: number,
                number,
                title,
                status: 'draft',
                priority: 'medium',
                assignee: '',
                updatedAt: new Date().toISOString(),
                description,
                acceptanceCriteria: [],
                attachments: [],
                relatedIssues: [],
                source: 'manual',
            };

            const saved = requirementStore.upsert(requirement);
            res.status(201).json(saved);
        } catch (err) {
            res.status(500).json({code: 'CREATE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * GET /api/requirements/saved
     * @description 获取所有已保存到本地的需求列表
     * @returns {Object[]} 需求数组
     */
    router.get('/saved', (_req, res) => {
        try {
            res.json(requirementStore.list());
        } catch (err) {
            res.status(500).json({code: 'STORE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * PUT /api/requirements/saved/:id
     * @description 更新已保存的需求（部分更新）
     * @param {string} id.path - 需求的唯一标识符
     * @param {Object} body - 需要更新的字段（title、description 等）
     * @returns {Object} 更新后的需求数据
     */
    router.put('/saved/:id', (req, res) => {
        try {
            const existing = requirementStore.get(req.params.id);
            if (!existing) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Requirement not found'});
                return;
            }
            const updated = requirementStore.upsert({
                ...existing,
                ...req.body,
                id: req.params.id,
            });
            res.json(updated);
        } catch (err) {
            res.status(500).json({code: 'STORE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * DELETE /api/requirements/saved/:id
     * @description 根据ID删除本地已保存的需求
     * @param {string} id.path - 需求的唯一标识符
     * @returns {{ success: boolean }} 删除操作是否成功
     */
    router.delete('/saved/:id', (req, res) => {
        try {
            const deleted = requirementStore.delete(req.params.id);
            res.json({success: deleted});
        } catch (err) {
            res.status(500).json({code: 'STORE_ERROR', message: getErrorMessage(err)});
        }
    });

    // ─── 附件解析 / 文档工作副本（与 dsh-adw 插件同语义的闭环） ────────────────

    /**
     * POST /api/requirements/saved/:id/attachments/parse
     * @description 服务端解析一份附件（图片走本地 images/，文档走 documents/），
     *              结果持久化到 parsedAttachments，随需求走
     * @param {string} id.path - 需求 ID
     * @body { name: string, backend?: string }
     * @returns {{ success: boolean, markdown?: string, error?: string, requirement?: object }}
     */
    router.post('/saved/:id/attachments/parse', async (req, res) => {
        try {
            const existing = requirementStore.get(req.params.id);
            if (!existing) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Requirement not found'});
                return;
            }
            if (!mineruService) {
                res.status(503).json({code: 'MINERU_DISABLED', message: 'MinerU service is not configured'});
                return;
            }
            const name = (req.body.name as string)?.trim();
            if (!name) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'name is required'});
                return;
            }
            const att = existing.attachments.find(a => a.name === name);
            if (!att) {
                res.status(404).json({code: 'NOT_FOUND', message: `attachment ${name} not on requirement`});
                return;
            }

            // 解析目标：本地图片 → images/；文档附件 → documents/（无则按 URL 下载）
            const {join} = await import('path');
            const {existsSync} = await import('fs');
            let localPath: string | null = requirementStore.getImagePath(req.params.id, name);
            if (!localPath && /\.(pdf|docx|pptx|xlsx)$/i.test(name)) {
                const docCandidate = join(requirementStore.getDocumentsDir(req.params.id), name);
                localPath = existsSync(docCandidate) ? docCandidate : null;
            }
            if (!localPath && /^https?:/i.test(att.url)) {
                // 远程附件：下载到 documents/ 再解析
                const {downloadFile} = await import('../utils/http-utils.js');
                const docDir = requirementStore.getDocumentsDir(req.params.id);
                const target = join(docDir, name);
                try {
                    await downloadFile(att.url, target);
                    localPath = target;
                } catch {
                    localPath = null;
                }
            }
            if (!localPath) {
                res.status(404).json({code: 'NOT_FOUND', message: `attachment ${name} has no local file`});
                return;
            }

            const backend = typeof req.body.backend === 'string' ? req.body.backend : undefined;
            const result = await mineruService.parseFile(localPath, backend ? {backend: backend as never} : undefined);
            if (!result.success || !result.markdown) {
                res.json({success: false, error: result.error ?? 'no markdown'});
                return;
            }
            const updated = requirementStore.setParsedAttachment(req.params.id, name, {
                markdown: result.markdown,
                backend: backend ?? 'pipeline',
                parsedAt: new Date().toISOString(),
            });
            res.json({success: true, markdown: result.markdown, requirement: updated});
        } catch (err) {
            res.status(500).json({code: 'PARSE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * POST /api/requirements/saved/:id/working-description
     * @description 保存文档工作副本（编辑成果；展示与执行 prompt 优先用它）
     */
    router.post('/saved/:id/working-description', (req, res) => {
        try {
            const description = req.body.description;
            if (typeof description !== 'string') {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'description is required'});
                return;
            }
            const updated = requirementStore.setWorkingDescription(req.params.id, description);
            if (!updated) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Requirement not found'});
                return;
            }
            broadcast({type: 'requirement:updated', data: updated});
            res.json(updated);
        } catch (err) {
            res.status(500).json({code: 'STORE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * DELETE /api/requirements/saved/:id/working-description
     * @description 放弃工作副本，回到源描述
     */
    router.delete('/saved/:id/working-description', (req, res) => {
        try {
            const updated = requirementStore.clearWorkingDescription(req.params.id);
            if (!updated) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Requirement not found'});
                return;
            }
            broadcast({type: 'requirement:updated', data: updated});
            res.json(updated);
        } catch (err) {
            res.status(500).json({code: 'STORE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * DELETE /api/requirements/saved/:id/attachments/:name
     * @description 删除一份附件（移出附件列表 + 清解析结果 + 剥工作副本合并标记块）
     */
    router.delete('/saved/:id/attachments/:name', (req, res) => {
        try {
            const name = decodeURIComponent(req.params.name);
            const updated = requirementStore.removeAttachment(req.params.id, name);
            if (!updated) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Requirement not found'});
                return;
            }
            broadcast({type: 'requirement:updated', data: updated});
            res.json(updated);
        } catch (err) {
            res.status(500).json({code: 'STORE_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * POST /api/requirements/saved/:id/merge
     * @description 把全部解析结果合并进文档工作副本（幂等，服务端文本手术）
     */
    router.post('/saved/:id/merge', (req, res) => {
        try {
            const existing = requirementStore.get(req.params.id);
            if (!existing) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Requirement not found'});
                return;
            }
            const parsed = existing.parsedAttachments ?? {};
            if (Object.keys(parsed).length === 0) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'no parsed attachments to merge'});
                return;
            }
            const merged = mergeParsedIntoDescription(existing.workingDescription ?? existing.description, parsed);
            const updated = requirementStore.setWorkingDescription(req.params.id, merged);
            broadcast({type: 'requirement:updated', data: updated});
            res.json(updated);
        } catch (err) {
            res.status(500).json({code: 'STORE_ERROR', message: getErrorMessage(err)});
        }
    });

    // ─── agent 中介拉取 + 自动保存 ─────────────────────────────────────────────

    /**
     * POST /api/requirements/fetch
     * @description agent 中介拉取需求详情并自动保存到本地存储（唯一拉取路径）。
     *              AI 引擎动态面对已挂载的 MCP 工具（读 schema → 自主选择与调用，
     *              失败自行换工具/参数重试），输入方言（链接/需求号/issue key/
     *              owner-repo#N）由 agent 理解，应用侧零源硬编码。
     * @param {string} id.body - 用户原始输入（必填）
     * @param {string} [mcpServerName.body] - 可选的 MCP server（限定挂载范围）
     * @returns {Object} 保存后的需求数据
     */
    router.post('/fetch', async (req, res) => {
        try {
            const {id, mcpServerName, parseDocuments} = req.body as { id: string; mcpServerName?: string; parseDocuments?: boolean };
            if (!id?.trim()) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'Requirement ID is required'});
                return;
            }
            if (!agentFetch) {
                res.status(503).json({code: 'AGENT_UNAVAILABLE', message: '需求拉取依赖 AI 引擎（agent 中介模式），请先在设置中配置 CLI Provider'});
                return;
            }

            const agentResult = await agentFetch.fetchByInput(id, mcpServerName, emitFetchProgress('fetch'));
            const detail = agentResult;
            const serverName = agentResult.sourceServer || mcpServerName || '';

            // 附件认证插件：按实际使用的 server env 检测（如 ONES PKCE）
            const serverConfig = serverName ? mcpRegistryService?.get(serverName) : undefined;
            const imageService = createAttachmentImageService(serverConfig?.env);

            // 解析文档附件（PDF/DOCX/PPTX/XLSX）为 Markdown（需前端显式请求）
            if (parseDocuments && mineruService?.isEnabled()) {
                try {
                    const parsedMd = await requirementStore.downloadAndParseDocuments(
                        detail, mineruService, imageService,
                    );
                    if (parsedMd) {
                        detail.description += '\n\n---\n\n## 附件文档内容\n\n' + parsedMd;
                    }
                } catch (err) {
                    // 文档解析失败不阻塞需求保存
                    console.warn(`[requirements] Document parsing failed: ${getErrorMessage(err)}`);
                }
            }

            // 先保存并返回文档，然后异步下载图片
            const saved = requirementStore.upsert({
                ...detail,
                source: serverName,
            });
            res.json(saved);

            // 后台异步下载图片（不阻塞HTTP响应）
            if (imageService) {
                // 使用 process.nextTick 确保HTTP响应已发送
                process.nextTick(async () => {
                    try {
                        await requirementStore.downloadImages(detail, imageService);
                        // 下载完成后，通过WebSocket通知前端刷新
                        const updated = requirementStore.get(detail.id);
                        if (updated) {
                            broadcast({
                                type: 'requirement:updated',
                                data: updated,
                            });
                        }
                    } catch (err) {
                        console.warn(`[requirements] Background image download failed: ${err instanceof Error ? err.message : err}`);
                    }
                });
            }
        } catch (err) {
            broadcast({type: 'requirement:fetch_progress', data: {kind: 'failed', source: 'fetch', message: getErrorMessage(err)}});
            res.status(500).json({code: 'AGENT_FETCH_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * GET /api/requirements/search?q=&server=
     * @description agent 中介搜索需求（纯查询模式，不会自动保存到本地存储）
     * @param {string} q.query - 搜索关键词（必填）
     * @param {string} [server.query] - 可选的 MCP server（限定挂载范围）
     * @returns {Object[]} 匹配的需求结果列表
     */
    router.get('/search', async (req, res) => {
        try {
            const query = req.query.q as string;
            if (!query?.trim()) {
                res.status(400).json({code: 'VALIDATION_ERROR', message: 'Query parameter "q" is required'});
                return;
            }
            if (!agentFetch) {
                res.status(503).json({code: 'AGENT_UNAVAILABLE', message: '需求搜索依赖 AI 引擎（agent 中介模式），请先在设置中配置 CLI Provider'});
                return;
            }
            const server = req.query.server as string | undefined;
            const results = await agentFetch.searchByInput(query, server, emitFetchProgress('search'));
            res.json(results);
        } catch (err) {
            broadcast({type: 'requirement:fetch_progress', data: {kind: 'failed', source: 'search', message: getErrorMessage(err)}});
            res.status(500).json({code: 'AGENT_FETCH_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * GET /api/requirements/:id
     * @description 根据ID获取需求详情。优先从本地存储查找，若未找到则回退
     *              agent 中介实时拉取（不自动保存到本地存储）。
     * @param {string} id.path - 需求的唯一标识符
     * @returns {Object} 需求详情数据
     */
    router.get('/:id', async (req, res) => {
        try {
            // 优先检查本地存储
            const local = requirementStore.get(req.params.id);
            if (local) {
                res.json(local);
                return;
            }
            // 本地未找到时，回退 agent 中介实时拉取
            if (!agentFetch) {
                res.status(404).json({code: 'NOT_FOUND', message: `Requirement ${req.params.id} not found in local store`});
                return;
            }
            const detail = await agentFetch.fetchByInput(req.params.id, undefined, emitFetchProgress('detail'));
            res.json(detail);
        } catch (err) {
            broadcast({type: 'requirement:fetch_progress', data: {kind: 'failed', source: 'detail', message: getErrorMessage(err)}});
            res.status(500).json({code: 'AGENT_FETCH_ERROR', message: getErrorMessage(err)});
        }
    });

    // ─── 图片静态文件服务 ─────────────────────────────────────────────────────

    /**
     * GET /api/requirements/images/:reqId/:filename
     * @description 提供已下载到本地的需求图片文件
     * @param {string} reqId.path - 需求 ID
     * @param {string} filename.path - 图片文件名
     */
    router.get('/images/:reqId/:filename', (req, res) => {
        const filePath = requirementStore.getImagePath(req.params.reqId, req.params.filename);
        if (!filePath) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Image not found'});
            return;
        }
        res.sendFile(filePath);
    });

    return router;
}
