/**
 * @file wallpapers.ts
 * @description 壁纸库路由模块
 *
 * 路由前缀：/api/wallpapers
 *
 * 设计参考 dsh-wallpaper-engine（MIT）的同源媒体管道：
 * - 媒体/缩略图经同源 HTTP 直出（sendFile 自带 Range/条件请求支持），
 *   视频可拖动进度、浏览器可缓存；
 * - 上传走 application/octet-stream 原始字节流（全局 express.json 只解析
 *   JSON Content-Type，二者互不干扰，也不把大文件读成字符串）；
 * - 设置持久化在服务端 settings.json（端口无关），客户端另有 localStorage
 *   缓存做秒开回显。
 *
 * 端点列表：
 * - GET    /              壁纸清单（含隐藏项，前端自行过滤）
 * - POST   /upload        上传（query: title、原始文件名走 X-File-Name 头）
 * - PUT    /:id/thumb     保存客户端生成的缩略图 dataURL
 * - GET    /:id/media     媒体流（Range）
 * - GET    /:id/thumb     缩略图
 * - PATCH  /:id           更新（hidden / title）
 * - DELETE /:id           删除（文件 + 缩略图 + 元数据）
 * - GET    /settings      读取设置
 * - PUT    /settings      保存设置（patch 合并）
 */

import {Router} from 'express';
import fs from 'fs';
import {pipeline} from 'stream/promises';
import {WallpaperStoreService} from '../services/wallpaper-store-service.js';
import {validateBody} from '../middleware/validation.js';
import {getErrorMessage} from '../utils/error-utils.js';

/** 上传大小上限：2GB（4K 视频也在内） */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 创建壁纸路由实例
 */
export function createWallpaperRoutes(store: WallpaperStoreService): Router {
    const router = Router();

    // 清单
    router.get('/', (_req, res) => {
        res.json({wallpapers: store.list()});
    });

    // 上传：原始字节流 + query/title + X-File-Name 头。
    // 流式落盘：请求体直接管道到临时文件再改名登记——此前 express.raw 会把
    // 最大 2GB 的字节流整块读成 Buffer（4K 视频上传 = 峰值 2GB 堆内存）。
    router.post('/upload', (req, res) => {
        const origName = String(req.header('X-File-Name') || 'wallpaper');
        const title = typeof req.query.title === 'string' ? req.query.title : undefined;
        const tmpPath = store.tempUploadPath();
        let received = 0;
        let tooLarge = false;

        void (async () => {
            try {
                await pipeline(
                    req,
                    async function* (source) {
                        // 生成器边收边计数，超限即中断管道（上游请求被销毁）
                        for await (const chunk of source as AsyncIterable<Buffer>) {
                            received += chunk.length;
                            if (received > MAX_UPLOAD_BYTES) {
                                tooLarge = true;
                                throw new Error('payload too large');
                            }
                            yield chunk;
                        }
                    },
                    fs.createWriteStream(tmpPath),
                );
                const meta = store.addFromStream(tmpPath, received, title, origName);
                if (!res.writableEnded) res.status(201).json({wallpaper: meta});
            } catch (err) {
                // 管道失败（超限/客户端中断/写盘错误）→ 清理临时文件再回错
                try {
                    fs.rmSync(tmpPath, {force: true});
                } catch { /* ignore */ }
                if (res.writableEnded || res.destroyed) return; // 客户端已断开，无法也应答
                if (tooLarge) {
                    res.status(413).json({code: 'PAYLOAD_TOO_LARGE', message: '上传超过 2GB 上限'});
                } else {
                    res.status(400).json({code: 'UPLOAD_ERROR', message: getErrorMessage(err)});
                }
            }
        })();
    });

    // 设置（放于 /:id 之前，避免 settings 被当作 id）
    router.get('/settings', (_req, res) => {
        res.json(store.getSettings());
    });

    router.put('/settings', validateBody([]), (req, res) => {
        try {
            res.json(store.saveSettings((req.body ?? {}) as Record<string, never>));
        } catch (err) {
            res.status(400).json({code: 'SETTINGS_ERROR', message: getErrorMessage(err)});
        }
    });

    // 缩略图保存（客户端 canvas 生成）
    router.put('/:id/thumb', validateBody([{field: 'dataUrl', required: true, type: 'string'}]), (req, res) => {
        try {
            const ok = store.saveThumb(req.params.id, String(req.body.dataUrl));
            if (!ok) {
                res.status(404).json({code: 'NOT_FOUND', message: '壁纸不存在'});
                return;
            }
            res.json({ok: true});
        } catch (err) {
            res.status(400).json({code: 'THUMB_ERROR', message: getErrorMessage(err)});
        }
    });

    // 媒体流（sendFile 自动处理 Range / 条件请求 / 缓存头）
    router.get('/:id/media', (req, res) => {
        const filePath = store.mediaPath(req.params.id);
        if (!filePath) {
            res.status(404).json({code: 'NOT_FOUND', message: '壁纸文件不存在'});
            return;
        }
        res.sendFile(filePath, (err) => {
            if (err && !res.headersSent) {
                res.status(500).json({code: 'MEDIA_ERROR', message: '媒体读取失败'});
            }
        });
    });

    // 缩略图（未生成时 404，前端回退占位）
    router.get('/:id/thumb', (req, res) => {
        const filePath = store.thumbPath(req.params.id);
        if (!filePath) {
            res.status(404).json({code: 'NOT_FOUND', message: '暂无缩略图'});
            return;
        }
        res.sendFile(filePath, (err) => {
            if (err && !res.headersSent) {
                res.status(500).json({code: 'THUMB_ERROR', message: '缩略图读取失败'});
            }
        });
    });

    // 更新（隐藏/恢复、改名）
    router.patch('/:id', validateBody([]), (req, res) => {
        const {hidden, title} = (req.body ?? {}) as {hidden?: boolean; title?: string};
        let meta;
        if (typeof hidden === 'boolean') meta = store.setHidden(req.params.id, hidden);
        if (typeof title === 'string') meta = store.rename(req.params.id, title);
        if (!meta) {
            res.status(404).json({code: 'NOT_FOUND', message: '壁纸不存在'});
            return;
        }
        res.json({wallpaper: meta});
    });

    // 删除
    router.delete('/:id', (req, res) => {
        const ok = store.remove(req.params.id);
        if (!ok) {
            res.status(404).json({code: 'NOT_FOUND', message: '壁纸不存在'});
            return;
        }
        res.json({ok: true});
    });

    return router;
}
