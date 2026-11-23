/**
 * @file asr.ts
 * @description 语音识别路由：把前端录音转发到 OpenAI 兼容的 /audio/transcriptions 接口。
 */

import {Router} from 'express';
import multer from 'multer';
import {ConfigService} from '../services/config-service.js';
import {getErrorMessage} from '../utils/error-utils.js';

const upload = multer({storage: multer.memoryStorage(), limits: {fileSize: 25 * 1024 * 1024}});

export function createASRRoutes(): Router {
    const router = Router();

    // POST /api/asr/transcribe — multipart 字段名 audio
    router.post('/transcribe', upload.single('audio'), async (req, res) => {
        try {
            const asr = new ConfigService().load().asr;
            if (!asr?.enabled || !asr.apiUrl) {
                res.status(400).json({code: 'ASR_NOT_CONFIGURED', message: '未配置语音识别服务（config.asr.apiUrl）'});
                return;
            }
            const file = req.file;
            if (!file) {
                res.status(400).json({code: 'NO_FILE', message: 'No audio uploaded'});
                return;
            }

            const fd = new FormData();
            fd.append('file', new Blob([new Uint8Array(file.buffer)], {type: file.mimetype || 'audio/webm'}),
                file.originalname || 'audio.webm');
            fd.append('model', asr.model || 'whisper-1');

            const upstream = await fetch(`${asr.apiUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
                method: 'POST',
                ...(asr.apiKey ? {headers: {Authorization: `Bearer ${asr.apiKey}`}} : {}),
                body: fd,
                // 音频较大 + 上游慢：2 分钟兜底，防止挂死请求
                signal: AbortSignal.timeout(120_000),
            });
            if (!upstream.ok) {
                const detail = await upstream.text().catch(() => '');
                res.status(502).json({code: 'ASR_UPSTREAM_ERROR', message: `语音识别服务返回 ${upstream.status}`, detail: detail.slice(0, 500)});
                return;
            }
            const data = await upstream.json() as {text?: string};
            res.json({text: data.text ?? ''});
        } catch (err) {
            res.status(500).json({code: 'ASR_ERROR', message: getErrorMessage(err)});
        }
    });

    return router;
}
