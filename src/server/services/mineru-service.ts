/**
 * @file mineru-service.ts
 * @description MinerU 文档解析服务
 *
 * 封装 MinerU FastAPI 接口，提供文档/图片/表格解析能力。
 * 支持同步解析和异步任务两种模式。
 *
 * MinerU API 端点：
 * - POST /file_parse  — 同步解析（上传文件，等待结果）
 * - POST /tasks       — 异步解析（提交任务，轮询结果）
 * - GET  /tasks/{id}  — 查询任务状态
 * - GET  /tasks/{id}/result — 获取任务结果
 * - GET  /health      — 健康检查
 */

import fs from 'fs';
import path from 'path';
import {getErrorMessage} from '../utils/error-utils.js';

/** MinerU 服务配置 */
export interface MinerUConfig {
    /** MinerU 服务地址 */
    apiUrl?: string;
    /** 是否启用 MinerU 解析（默认 true） */
    enabled?: boolean;
    /** 默认解析后端（字符串形式，运行时验证） */
    defaultBackend?: string;
    /** 默认语言列表 */
    defaultLangList?: string[];
}

/** 解析后端类型 */
export type MinerUBackend =
    | 'pipeline'
    | 'vlm-auto-engine'
    | 'vlm-http-client'
    | 'hybrid-auto-engine'
    | 'hybrid-http-client';

/** 解析方法 */
export type MinerUParseMethod = 'auto' | 'txt' | 'ocr';

/** 解析请求参数 */
export interface MinerUParseOptions {
    /** OCR 语言列表（默认 ['ch']） */
    langList?: string[];
    /** 解析后端（默认 hybrid-auto-engine） */
    backend?: MinerUBackend;
    /** 解析方法（默认 auto） */
    parseMethod?: MinerUParseMethod;
    /** 启用公式解析（默认 true） */
    formulaEnable?: boolean;
    /** 启用表格解析（默认 true） */
    tableEnable?: boolean;
    /** 启用图片分析（默认 true） */
    imageAnalysis?: boolean;
    /** 是否返回 markdown（默认 true） */
    returnMd?: boolean;
    /** 是否返回中间 JSON */
    returnMiddleJson?: boolean;
    /** 是否返回模型输出 */
    returnModelOutput?: boolean;
    /** 是否返回内容列表 */
    returnContentList?: boolean;
    /** 是否返回提取的图片 */
    returnImages?: boolean;
    /** PDF 起始页（从 0 开始） */
    startPageId?: number;
    /** PDF 结束页 */
    endPageId?: number;
}

/** 异步任务提交结果 */
export interface MinerUTaskSubmitResult {
    /** 任务 ID */
    task_id: string;
    /** 任务状态 */
    status?: string;
    /** 消息 */
    message?: string;
}

/** 异步任务状态 */
export interface MinerUTaskStatus {
    /** 任务 ID */
    task_id: string;
    /** 任务状态：pending / processing / completed / failed */
    status: string;
    /** 进度信息 */
    progress?: number;
    /** 消息 */
    message?: string;
}

/** 解析结果 */
export interface MinerUParseResult {
    /** 是否成功 */
    success: boolean;
    /** Markdown 内容 */
    markdown?: string;
    /** 中间 JSON 数据 */
    middleJson?: unknown;
    /** 模型输出 */
    modelOutput?: unknown;
    /** 内容列表 */
    contentList?: unknown;
    /** 提取的图片列表（base64 编码） */
    images?: string[];
    /** 原始响应数据 */
    raw?: unknown;
    /** 错误信息 */
    error?: string;
}

/**
 * MinerU 文档解析服务
 */
export class MinerUService {
    private config: MinerUConfig;

    constructor(config: MinerUConfig | undefined) {
        this.config = config ?? {};
        if (this.config.enabled !== false) {
            console.log(`[mineru] Service initialized (${this.getBaseUrl()})`);
        }
    }

    isEnabled(): boolean {
        return this.config.enabled !== false && !!this.config.apiUrl;
    }

    getBaseUrl(): string {
        return this.config.apiUrl ?? '';
    }

    getStatus(): { enabled: boolean; apiUrl: string } {
        return {enabled: this.isEnabled(), apiUrl: this.getBaseUrl()};
    }

    /** 健康检查 */
    async healthCheck(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
        if (!this.isEnabled()) {
            return {healthy: false, error: 'MinerU service is disabled'};
        }
        const start = Date.now();
        try {
            const res = await fetch(`${this.getBaseUrl()}/health`, {signal: AbortSignal.timeout(10_000)});
            const latency = Date.now() - start;
            return {healthy: res.ok, latency, error: res.ok ? undefined : `HTTP ${res.status}`};
        } catch (err) {
            return {healthy: false, latency: Date.now() - start, error: getErrorMessage(err)};
        }
    }

    /** 同步解析本地文件 */
    async parseFile(filePath: string, options?: MinerUParseOptions): Promise<MinerUParseResult> {
        if (!this.isEnabled()) return {success: false, error: 'MinerU service is disabled'};
        if (!fs.existsSync(filePath)) return {success: false, error: `File not found: ${filePath}`};

        const fileName = path.basename(filePath);
        const fileBuffer = fs.readFileSync(filePath);
        const mimeType = this.getMimeType(fileName);
        return this.parseBuffer(fileName, fileBuffer, mimeType, options);
    }

    /** 同步解析 Buffer 文件 */
    async parseBuffer(
        fileName: string,
        buffer: Buffer,
        mimeType: string,
        options?: MinerUParseOptions,
    ): Promise<MinerUParseResult> {
        if (!this.isEnabled()) return {success: false, error: 'MinerU service is disabled'};

        try {
            const fd = this.buildFormData(fileName, buffer, mimeType, options);
            const res = await fetch(`${this.getBaseUrl()}/file_parse`, {
                method: 'POST',
                body: fd,
                // 大 PDF 上传 + 上游解析排队：5 分钟兜底
                signal: AbortSignal.timeout(300_000),
            });

            if (!res.ok) {
                const text = await res.text();
                return {success: false, error: `MinerU HTTP ${res.status}: ${text.substring(0, 500)}`};
            }

            const text = await res.text();
            return this.parseResponse(text);
        } catch (err) {
            return {success: false, error: getErrorMessage(err)};
        }
    }

    /** 提交异步解析任务（本地文件） */
    async submitTask(filePath: string, options?: MinerUParseOptions): Promise<MinerUTaskSubmitResult & {
        error?: string
    }> {
        if (!this.isEnabled()) return {task_id: '', error: 'MinerU service is disabled'};
        if (!fs.existsSync(filePath)) return {task_id: '', error: `File not found: ${filePath}`};

        const fileName = path.basename(filePath);
        const fileBuffer = fs.readFileSync(filePath);
        const mimeType = this.getMimeType(fileName);
        return this.submitTaskBuffer(fileName, fileBuffer, mimeType, options);
    }

    /** 提交异步解析任务（Buffer） */
    async submitTaskBuffer(
        fileName: string,
        buffer: Buffer,
        mimeType: string,
        options?: MinerUParseOptions,
    ): Promise<MinerUTaskSubmitResult & { error?: string }> {
        if (!this.isEnabled()) return {task_id: '', error: 'MinerU service is disabled'};

        try {
            const fd = this.buildFormData(fileName, buffer, mimeType, options);
            const res = await fetch(`${this.getBaseUrl()}/tasks`, {
                method: 'POST',
                body: fd,
                signal: AbortSignal.timeout(300_000),
            });

            if (!res.ok) {
                const text = await res.text();
                return {task_id: '', error: `MinerU HTTP ${res.status}: ${text.substring(0, 500)}`};
            }

            const result = await res.json() as Record<string, unknown>;
            return {
                task_id: result.task_id as string,
                status: result.status as string,
                message: result.message as string
            };
        } catch (err) {
            return {task_id: '', error: getErrorMessage(err)};
        }
    }

    /** 查询异步任务状态 */
    async getTaskStatus(taskId: string): Promise<MinerUTaskStatus & { error?: string }> {
        if (!this.isEnabled()) return {task_id: taskId, status: 'failed', error: 'MinerU service is disabled'};

        try {
            const res = await fetch(`${this.getBaseUrl()}/tasks/${encodeURIComponent(taskId)}`, {signal: AbortSignal.timeout(30_000)});
            if (!res.ok) {
                const text = await res.text();
                return {task_id: taskId, status: 'failed', error: `HTTP ${res.status}: ${text.substring(0, 300)}`};
            }
            const data = await res.json() as MinerUTaskStatus;
            return data;
        } catch (err) {
            return {task_id: taskId, status: 'failed', error: getErrorMessage(err)};
        }
    }

    /** 获取异步任务结果 */
    async getTaskResult(taskId: string): Promise<MinerUParseResult> {
        if (!this.isEnabled()) return {success: false, error: 'MinerU service is disabled'};

        try {
            const res = await fetch(`${this.getBaseUrl()}/tasks/${encodeURIComponent(taskId)}/result`, {signal: AbortSignal.timeout(30_000)});
            if (!res.ok) {
                const text = await res.text();
                return {success: false, error: `HTTP ${res.status}: ${text.substring(0, 300)}`};
            }
            const text = await res.text();
            return this.parseResponse(text);
        } catch (err) {
            return {success: false, error: getErrorMessage(err)};
        }
    }

    // ========== 私有方法 ==========

    /** 合并默认选项 */
    private mergeOptions(options?: MinerUParseOptions): Required<Pick<MinerUParseOptions,
        'langList' | 'backend' | 'parseMethod' |
        'formulaEnable' | 'tableEnable' | 'imageAnalysis' |
        'returnMd' | 'returnMiddleJson' | 'returnModelOutput' |
        'returnContentList' | 'returnImages' | 'startPageId' | 'endPageId'
    >> {
        return {
            langList: options?.langList ?? this.config.defaultLangList ?? ['ch'],
            // pipeline = 纯 CPU 经典管线，任何部署都能跑；vlm/hybrid 系需要 GPU
            // device（CPU 服务器报 "Device string must not be empty"）——默认保守。
            backend: (options?.backend ?? this.config.defaultBackend ?? 'pipeline') as MinerUBackend,
            parseMethod: options?.parseMethod ?? 'auto',
            formulaEnable: options?.formulaEnable ?? true,
            tableEnable: options?.tableEnable ?? true,
            imageAnalysis: options?.imageAnalysis ?? true,
            returnMd: options?.returnMd ?? true,
            returnMiddleJson: options?.returnMiddleJson ?? false,
            returnModelOutput: options?.returnModelOutput ?? false,
            returnContentList: options?.returnContentList ?? false,
            returnImages: options?.returnImages ?? false,
            startPageId: options?.startPageId ?? 0,
            endPageId: options?.endPageId ?? 99999,
        };
    }

    /**
     * 使用 Node 18+ 原生 FormData + Blob 构建 multipart 请求
     *
     * FormData.append 配合 Blob 会自动处理 multipart boundary、
     * Content-Type header 和二进制编码，无需手动拼接。
     */
    private buildFormData(
        fileName: string,
        buffer: Buffer,
        mimeType: string,
        options?: MinerUParseOptions,
    ): FormData {
        const opts = this.mergeOptions(options);
        const fd = new FormData();

        // 文件字段：Blob 会正确设置 Content-Type
        fd.append('files', new Blob([buffer], {type: mimeType}), fileName);

        // 文本字段
        fd.append('backend', opts.backend);
        fd.append('parse_method', opts.parseMethod);
        fd.append('formula_enable', String(opts.formulaEnable));
        fd.append('table_enable', String(opts.tableEnable));
        fd.append('image_analysis', String(opts.imageAnalysis));
        fd.append('return_md', String(opts.returnMd));
        fd.append('return_middle_json', String(opts.returnMiddleJson));
        fd.append('return_model_output', String(opts.returnModelOutput));
        fd.append('return_content_list', String(opts.returnContentList));
        fd.append('return_images', String(opts.returnImages));
        fd.append('start_page_id', String(opts.startPageId));
        fd.append('end_page_id', String(opts.endPageId));

        // lang_list 数组：每个语言单独 append
        for (const lang of opts.langList) {
            fd.append('lang_list', lang);
        }

        return fd;
    }

    /** 解析 MinerU 响应体 */
    private parseResponse(body: string): MinerUParseResult {
        if (!body) return {success: false, error: 'Empty response from MinerU'};

        try {
            const data = JSON.parse(body);
            const result: MinerUParseResult = {success: true, raw: data};

            if (Array.isArray(data)) {
                result.markdown = data.map((item: unknown) => this.extractMarkdown(item)).filter(Boolean).join('\n\n---\n\n');
                return result;
            }

            if (typeof data === 'object' && data !== null) {
                const obj = data as Record<string, unknown>;
                result.markdown = this.extractMarkdown(obj);
                result.middleJson = obj.middle_json ?? obj.middleJson ?? obj.middle;
                result.modelOutput = obj.model_output ?? obj.modelOutput;
                result.contentList = obj.content_list ?? obj.contentList ?? obj.content;
                result.images = this.extractImages(obj);
            }

            return result;
        } catch {
            return {success: true, markdown: body, raw: body};
        }
    }

    /** 从响应对象中提取 markdown（兼容多种字段名） */
    private extractMarkdown(obj: unknown): string {
        if (typeof obj === 'string') return obj;
        if (typeof obj !== 'object' || obj === null) return '';

        const o = obj as Record<string, unknown>;

        // MinerU 实际结构: { results: { "文件名": { md_content: "..." } } }
        if (typeof o.results === 'object' && o.results !== null) {
            const results = o.results as Record<string, unknown>;
            const mdParts: string[] = [];
            for (const [, fileResult] of Object.entries(results)) {
                if (typeof fileResult === 'object' && fileResult !== null) {
                    const fr = fileResult as Record<string, unknown>;
                    if (typeof fr.md_content === 'string') {
                        mdParts.push(fr.md_content);
                    }
                }
            }
            if (mdParts.length > 0) {
                return mdParts.join('\n\n---\n\n');
            }
        }

        // 顶层字段
        for (const field of ['md_content', 'markdown', 'md', 'content', 'text'] as const) {
            if (typeof o[field] === 'string' && (o[field] as string).length > 0) {
                return o[field] as string;
            }
        }

        // 单数 result 字段
        if (typeof o.result === 'object' && o.result !== null) {
            return this.extractMarkdown(o.result);
        }
        return '';
    }

    /** 提取图片 */
    private extractImages(obj: Record<string, unknown>): string[] | undefined {
        for (const field of ['images', 'image_list', 'imageList'] as const) {
            if (Array.isArray(obj[field]) && (obj[field] as unknown[]).length > 0) {
                return obj[field] as string[];
            }
        }
        return undefined;
    }

    /** MIME 类型映射 */
    private getMimeType(fileName: string): string {
        const ext = path.extname(fileName).toLowerCase();
        const map: Record<string, string> = {
            '.pdf': 'application/pdf',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.docx': 'application/vnd.malformations-office document.multiprocessing.document',
            '.pptx': 'application/vnd.malformations-office document.presentationml.presentation',
            '.xlsx': 'application/vnd.malformations-office document.spreadsheet.sheet',
        };
        return map[ext] ?? 'application/octet-stream';
    }
}
