/**
 * @file 需求本地存储服务（文件夹结构）
 * @description 每个需求以独立文件夹存储在 ~/.aico/requirements/{id}/ 下。
 *   文件夹结构：
 *     requirements/{id}/metadata.json  — 结构化元数据（状态、优先级、负责人等）
 *     requirements/{id}/document.md    — 需求描述（Markdown 格式）
 *     requirements/{id}/images/        — 下载的图片资源
 *
 *   同时提供旧版 requirements.json → 文件夹结构的自动迁移。
 */
import fs from 'fs';
import path from 'path';
import type {AttachmentImageService} from './requirement-sources';
import type {MinerUService} from './mineru-service.js';
import {APP_DATA_DIR, REQUIREMENTS_DIR, LEGACY_IMAGE_DIR} from '../utils/constants.js';
import {isPathWithinRoots, HttpError} from '../middleware/validation.js';
import {writeFileAtomic} from '../utils/fs-utils.js';
import {downloadFile as httpDownloadFile, urlToImageFilename} from '../utils/http-utils.js';
import {parseMarker} from '../utils/parse-merge.js';

/**
 * 一份附件的 MinerU 解析结果（持久化，随需求走）
 */
export interface ParsedAttachment {
    /** 解析出的 Markdown 源码 */
    markdown: string;
    /** 所用后端（pipeline / vlm-* …） */
    backend: string;
    /** 解析时间（ISO 8601） */
    parsedAt: string;
}

/**
 * 已存储的需求信息接口
 */
export interface StoredRequirement {
    id: string;
    number?: string;
    title: string;
    status: string;
    priority: string;
    assignee: string;
    updatedAt: string;
    description: string;
    acceptanceCriteria: string[];
    attachments: { name: string; url: string; type: string }[];
    relatedIssues: { id: string; title: string; status: string }[];
    savedAt: string;
    source: string;
    /** 附件解析结果，按附件名索引（解析动作写入） */
    parsedAttachments?: Record<string, ParsedAttachment>;
    /** 文档工作副本（编辑 + 解析合并写入）；未设置时展示/执行均用源 description */
    workingDescription?: string;
    /** 工作副本最后写入时间（ISO 8601；用于「源已更新」提示） */
    workingUpdatedAt?: string;
}

/** 需求元数据（存储在 metadata.json，不含 description/workingDescription） */
interface RequirementMetadata {
    id: string;
    number?: string;
    title: string;
    status: string;
    priority: string;
    assignee: string;
    updatedAt: string;
    acceptanceCriteria: string[];
    attachments: { name: string; url: string; type: string }[];
    relatedIssues: { id: string; title: string; status: string }[];
    savedAt: string;
    source: string;
    parsedAttachments?: Record<string, ParsedAttachment>;
    workingUpdatedAt?: string;
}

/** 旧版存储文件路径 */
const LEGACY_STORE_FILE = path.join(APP_DATA_DIR, 'requirements.json');

/**
 * 需求本地存储服务类
 *
 * 以需求 ID 为键，每个需求独立文件夹存储。
 * metadata.json 存结构化元数据，document.md 存 Markdown 描述。
 */
export class RequirementStoreService {
    private readonly rootDir: string;

    constructor(rootDir?: string) {
        this.rootDir = rootDir ?? REQUIREMENTS_DIR;
    }

    // === 基础目录 ===

    /**
     * 需求文件夹路径（全部 id 入口的唯一收口）
     *
     * id 来自路由参数/请求体（外部输入），resolve 后必须仍落在 rootDir 内，
     * 否则抛 400 —— 防止 `..%2F..` 类路径遍历读/写/删除任意目录。
     */
    private reqDir(id: string): string {
        const dir = path.resolve(this.rootDir, id);
        if (!isPathWithinRoots(dir, [this.rootDir])) {
            throw new HttpError(400, `Invalid requirement id: ${id}`);
        }
        return dir;
    }

    /** metadata.json 路径 */
    private metadataPath(id: string): string {
        return path.join(this.reqDir(id), 'metadata.json');
    }

    /** document.md 路径 */
    private documentPath(id: string): string {
        return path.join(this.reqDir(id), 'document.md');
    }

    /** working.md 路径（文档工作副本） */
    private workingPath(id: string): string {
        return path.join(this.reqDir(id), 'working.md');
    }

    // === CRUD ===

    /** 列出所有已保存需求（按 savedAt 倒序） */
    list(): StoredRequirement[] {
        if (!fs.existsSync(this.rootDir)) return [];

        const entries: StoredRequirement[] = [];
        const dirs = fs.readdirSync(this.rootDir, {withFileTypes: true});

        for (const dir of dirs) {
            if (!dir.isDirectory()) continue;
            const req = this.readRequirement(dir.name);
            if (req) entries.push(req);
        }

        // 按 savedAt 倒序
        return entries.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
    }

    /** 根据 ID 获取需求 */
    get(id: string): StoredRequirement | undefined {
        return this.readRequirement(id);
    }

    /** 创建或更新需求（自动填充 savedAt；未显式传入时保留既有工作副本与解析结果） */
    upsert(req: Omit<StoredRequirement, 'savedAt'> & { savedAt?: string }): StoredRequirement {
        const now = req.savedAt ?? new Date().toISOString();

        // 工作副本与解析结果跨更新保留（重拉刷新源 description 不抹掉本地成果）
        const existing = this.get(req.id);
        const parsedAttachments = req.parsedAttachments ?? existing?.parsedAttachments;
        const workingDescription = req.workingDescription ?? existing?.workingDescription;
        const workingUpdatedAt = req.workingUpdatedAt ?? existing?.workingUpdatedAt;

        const {description, ...rest} = req as StoredRequirement;
        const meta: RequirementMetadata = {
            ...rest,
            savedAt: now,
            parsedAttachments,
            workingUpdatedAt,
        };
        delete (meta as Partial<StoredRequirement>).workingDescription;

        // 确保目录存在
        const dir = this.reqDir(req.id);
        fs.mkdirSync(dir, {recursive: true});
        fs.mkdirSync(path.join(dir, 'images'), {recursive: true});

        // 写入元数据和文档（metadata 走原子写：写一半崩溃不留撕裂 JSON；
        // 中途失败时最坏是「新 metadata + 旧文档」组合，下一次 upsert 自愈）
        writeFileAtomic(this.metadataPath(req.id), JSON.stringify(meta, null, 2));
        writeFileAtomic(this.documentPath(req.id), description ?? '');
        if (workingDescription !== undefined) {
            writeFileAtomic(this.workingPath(req.id), workingDescription);
        }

        return {...meta, description: description ?? '', workingDescription};
    }

    /** 写入一份附件解析结果（按附件名索引） */
    setParsedAttachment(id: string, name: string, record: ParsedAttachment): StoredRequirement | undefined {
        const req = this.get(id);
        if (!req) return undefined;
        const merged = {...(req.parsedAttachments ?? {}), [name]: record};
        return this.upsert({...req, parsedAttachments: merged});
    }

    /** 保存文档工作副本（编辑 / 合并都走这里） */
    setWorkingDescription(id: string, description: string): StoredRequirement | undefined {
        const req = this.get(id);
        if (!req) return undefined;
        return this.upsert({...req, workingDescription: description, workingUpdatedAt: new Date().toISOString()});
    }

    /** 放弃工作副本，回到源描述 */
    clearWorkingDescription(id: string): StoredRequirement | undefined {
        const req = this.get(id);
        if (!req) return undefined;
        const dir = this.reqDir(id);
        const workingFile = this.workingPath(id);
        if (fs.existsSync(workingFile)) fs.rmSync(workingFile);
        const meta: RequirementMetadata = {
            ...(req as unknown as RequirementMetadata),
        };
        delete meta.workingUpdatedAt;
        // parsedAttachments 保留（只是不再合并；重新合并随时可用）
        writeFileAtomic(this.metadataPath(id), JSON.stringify(meta, null, 2));
        const refreshed = this.readRequirement(id);
        return refreshed ?? this.get(id);
    }

    /**
     * 删除一份附件：移出附件列表 + 清掉它的解析结果 + 从工作副本剥掉它的合并标记块
     * （本地图片/文档文件保留——描述里的图片引用可能仍指向它，删文件会破图）
     */
    removeAttachment(id: string, name: string): StoredRequirement | undefined {
        const req = this.get(id);
        if (!req) return undefined;
        const attachments = req.attachments.filter(a => a.name !== name);
        if (attachments.length === req.attachments.length && req.parsedAttachments?.[name] === undefined) {
            return req; // 附件本就不存在
        }
        const parsedAttachments = {...(req.parsedAttachments ?? {})};
        delete parsedAttachments[name];
        // 剥掉工作副本里的合并标记块
        let workingDescription = req.workingDescription;
        if (workingDescription !== undefined) {
            const {open, close} = parseMarker(name);
            const openIdx = workingDescription.indexOf(open);
            if (openIdx >= 0) {
                const closeIdx = workingDescription.indexOf(close, openIdx);
                if (closeIdx >= 0) {
                    workingDescription = workingDescription.slice(0, openIdx) + workingDescription.slice(closeIdx + close.length);
                    // 清理残留空行
                    workingDescription = workingDescription.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
                }
            }
            // 标记块清空后若「附件解析」小节只剩空标题则一并移除
            if (!workingDescription.includes('<!--adw-parse:')) {
                workingDescription = workingDescription.replace(/\n*### 附件解析\s*\n*$/g, '');
            }
            workingDescription = workingDescription.trimEnd() + '\n';
        }
        return this.upsert({
            ...req,
            attachments,
            parsedAttachments,
            ...(workingDescription !== undefined ? {workingDescription} : {}),
        });
    }

    /** 根据 ID 删除需求（整个文件夹） */
    delete(id: string): boolean {
        const dir = this.reqDir(id);
        if (!fs.existsSync(dir)) return false;
        fs.rmSync(dir, {recursive: true, force: true});
        return true;
    }

    // === 内部读取 ===

    /** 从文件夹读取完整需求数据 */
    private readRequirement(id: string): StoredRequirement | undefined {
        const metaFile = this.metadataPath(id);
        const docFile = this.documentPath(id);
        if (!fs.existsSync(metaFile)) return undefined;

        try {
            const meta: RequirementMetadata = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
            const description = fs.existsSync(docFile) ? fs.readFileSync(docFile, 'utf-8') : '';
            const workingFile = this.workingPath(id);
            const workingDescription = meta.workingUpdatedAt !== undefined && fs.existsSync(workingFile)
                ? fs.readFileSync(workingFile, 'utf-8')
                : undefined;
            return {...meta, description, ...(workingDescription !== undefined ? {workingDescription} : {})};
        } catch {
            return undefined;
        }
    }

    // === 图片管理 ===

    /** 获取需求图片存储目录 */
    getImageDir(reqId: string): string {
        return path.join(this.reqDir(reqId), 'images');
    }

    /** 获取需求文档附件存储目录（downloadAndParseDocuments 下载目标） */
    getDocumentsDir(reqId: string): string {
        return path.join(this.reqDir(reqId), 'documents');
    }

    /** 获取本地图片文件路径，不存在返回 null */
    getImagePath(reqId: string, filename: string): string | null {
        // 清理 ID 和文件名中的路径分隔符/遍历片段
        const safeReqId = reqId.replace(/[\\/]/g, '-').replace(/\.{2,}/g, '');
        const safeFilename = filename.replace(/[\\/]/g, '-').replace(/\.{2,}/g, '');
        if (!safeReqId || !safeFilename) return null;

        const imgDir = this.getImageDir(safeReqId);
        const filePath = path.join(imgDir, safeFilename);
        // 路径安全检查（resolve + 根目录边界，避免前缀字符串比较被同前缀兄弟目录绕过）
        if (!isPathWithinRoots(filePath, [this.rootDir])) return null;
        return fs.existsSync(filePath) ? filePath : null;
    }

    /** 下载需求中的远程图片到本地，替换 URL 为本地路径 */
    async downloadImages(
        req: { id: string; description: string; attachments: { name: string; url: string; type: string }[] },
        imageService?: AttachmentImageService,
    ): Promise<void> {
        const reqId = req.id;
        const imgDir = this.getImageDir(reqId);
        fs.mkdirSync(imgDir, {recursive: true});

        // 自动本地化的附件范围：文档中的图片 + Excel 表格（其他格式保持源链接，不下载）
        const downloadableRe = /\.(png|jpe?g|gif|svg|webp|bmp|xlsx|xlsm|xls)$/i;
        // 有效 URL 判定：http(s) 才算（空串与"（ONES Wiki 附件…）"类占位文本都视同无 URL）
        const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);

        // 文档正文实际引用的图片（[Image: xxx] 标记）——wiki 源会把整页历史图都挂进
        // 附件列表（无 URL 的 hash 资源），只有被文档引用的才下载、才有展示价值
        const referencedNames = new Set<string>();
        for (const match of req.description.matchAll(/\[Image:\s*([^\]]+)\]/g)) {
            const name = match[1].trim();
            if (name !== '') referencedNames.add(name);
        }

        // 下载集 = ① 有真实 http URL 且属于图片/Excel 的附件（真实附件，直连/签名下载）
        //        + ② 文档引用的图片标记（wiki hash 资源无 URL，按名走 token 下载）
        const imageResources = new Map<string, string>();
        for (const att of req.attachments) {
            if (downloadableRe.test(att.name) && (isHttpUrl(att.url) || referencedNames.has(att.name))) {
                imageResources.set(att.name, att.name);
            }
        }
        for (const name of referencedNames) {
            if (!imageResources.has(name)) imageResources.set(name, name);
        }

        // 记录"原本有真实远程 URL"的附件（供清洗判定：改写为本地 URL 后 http 判定会失效）
        const hadRemoteUrl = new Set(req.attachments.filter(a => isHttpUrl(a.url)).map(a => a.name));

        // 构建 filename → 附件 URL 映射
        const urlMap = new Map<string, string>();
        for (const att of req.attachments) {
            if (att.url) urlMap.set(att.name, att.url);
        }

        // 策略1（优先）: 适配器图片服务批量下载（wiki content token 等，源特定策略）
        if (imageService && imageResources.size > 0) {
            try {
                const resources = Array.from(imageResources.entries()).map(([name]) => ({name, url: urlMap.get(name)}));
                // 120 秒总体超时：wiki 图片可能几十张（并发下载下仍需余量）
                const count = await Promise.race([
                    imageService.downloadWikiImages(reqId, resources, imgDir),
                    new Promise<number>((_, reject) =>
                        setTimeout(() => reject(new Error('Image download timeout')), 120000)
                    ),
                ]);
                console.log(`[ones-image] Wiki token download: ${count}/${imageResources.size} images`);
            } catch (err) {
                console.warn(`[ones-image] Wiki token download failed, falling back: ${err instanceof Error ? err.message : err}`);
            }
        }

        // 策略1.5: MCP 输出无图片资源时（ai-dev-requirements 0.2.0 将图片降级为 [image] 占位符），
        // 直接从 ONES 任务富文本提取 <img> 附件下载，不依赖 MCP 输出格式
        let richTextImages: Array<{ uuid: string; filename: string; localPath: string }> = [];
        if (imageService && imageResources.size === 0) {
            try {
                richTextImages = await Promise.race([
                    imageService.downloadTaskImages(reqId, imgDir),
                    new Promise<Array<{ uuid: string; filename: string; localPath: string }>>((_, reject) =>
                        setTimeout(() => reject(new Error('Rich text image download timeout')), 30000)
                    ),
                ]);
                if (richTextImages.length > 0) {
                    console.log(`[ones-image] Rich text download: ${richTextImages.length} images for ${reqId}`);
                }
            } catch (err) {
                console.warn(`[ones-image] Rich text download failed: ${err instanceof Error ? err.message : err}`);
            }
        }

        // 策略2（回退）: 并行下载未成功的图片（每文件内回退链串行）
        await Promise.all(Array.from(imageResources.keys()).map(async (filename) => {
            const localPath = path.join(imgDir, filename);
            if (fs.existsSync(localPath)) return;

            const directUrl = urlMap.get(filename);

            // 回退A: 直接下载（无认证）
            if (directUrl) {
                try {
                    await httpDownloadFile(directUrl, localPath);
                    return;
                } catch { /* 回退 */
                }
            }

            // 回退B: 适配器图片服务旧方法
            if (imageService) {
                try {
                    const resourceHash = filename.replace(/\.[^.]+$/, '');
                    await imageService.downloadImage(resourceHash, localPath);
                } catch { /* 下载失败不阻塞流程 */
                }
            }
        }));

        let desc = req.description;

        // 替换 0.2.0 的 [image] / [Image omitted] 占位符（按出现顺序对应富文本图片）
        if (richTextImages.length > 0) {
            let imgIdx = 0;
            desc = desc.replace(/\[image(?: omitted)?\]/gi, () => {
                const img = richTextImages[imgIdx++];
                if (!img) return '[图片未下载]';
                const localUrl = `/api/requirements/images/${reqId}/${img.filename}`;
                // 同步到附件列表，使前端附件面板可展示
                if (!req.attachments.some(a => a.name === img.filename)) {
                    const ext = (img.filename.split('.').pop() ?? 'png').toLowerCase();
                    req.attachments.push({
                        name: img.filename,
                        url: localUrl,
                        type: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`,
                    });
                }
                return `![${img.uuid}](${localUrl})`;
            });
        }

        // 替换 [Image: filename.png] 格式
        desc = desc.replace(/\[Image:\s*([^\]]+)\]/g, (_match, imageName: string) => {
            const trimmed = imageName.trim();
            const localPath = path.join(imgDir, trimmed);
            const localUrl = `/api/requirements/images/${reqId}/${trimmed}`;
            const remoteUrl = req.attachments.find(a => a.name === trimmed)?.url || '';

            if (fs.existsSync(localPath)) return `![${trimmed}](${localUrl})`;
            if (isHttpUrl(remoteUrl)) return `![${trimmed}](${remoteUrl})`;
            return `[图片未下载：${trimmed}]`; // 无本地文件也无有效远程地址：不再伪造成图片链接
        });

        // 替换 [Embed: drawio] 格式
        desc = desc.replace(/\[Embed:\s*([^\]]+)\]/g, (_match, embedType: string) => {
            return `> 📎 嵌入内容: ${embedType.trim()}（请在 ONES 中查看）`;
        });

        // 替换 markdown 图片语法中的远程 URL
        desc = desc.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (_match, alt: string, url: string) => {
            const filename = urlToImageFilename(url);
            const localPath = path.join(imgDir, filename);
            if (fs.existsSync(localPath)) {
                return `![${alt}](/api/requirements/images/${reqId}/${filename})`;
            }
            return `![${alt}](${url})`;
        });

        req.description = desc;

        // 更新附件 URL 指向本地（图片 + Excel；不要求原有 URL——盘上有文件就改写，含空 URL 条目）
        for (const att of req.attachments) {
            if (downloadableRe.test(att.name)) {
                const localPath = path.join(imgDir, att.name);
                if (fs.existsSync(localPath)) {
                    att.url = `/api/requirements/images/${reqId}/${att.name}`;
                }
            }
        }

        // === 附件清洗 ===
        // 1) 同名同 URL 去重（源侧可能把同一内嵌图列多遍）；
        // 2) 死条目移除——附件面板就是「解析」的输入清单，只保留真正可用的：
        //    ① 原本有真实远程 URL 的（未本地化时解析端可按 URL 下载）；
        //    ② 已下载到本地且被文档引用的（url 已改写为本地地址）。
        //    无 URL 的 wiki hash 资源若未被文档引用（源侧整页历史图）一律不列。
        const seen = new Set<string>();
        req.attachments = req.attachments.filter(att => {
            const key = `${att.name}\n${att.url}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        req.attachments = req.attachments.filter(att =>
            hadRemoteUrl.has(att.name)
            || (fs.existsSync(path.join(imgDir, att.name))
                && (referencedNames.has(att.name) || req.description.includes(att.name))));

        // 持久化：把替换后的描述与附件写回存储（图片本地化完成）
        const existing = this.get(reqId);
        if (existing) {
            this.upsert({...existing, description: req.description, attachments: req.attachments});
        }
    }

    // === 文档解析 ===

    /** 文档附件扩展名正则 */
    private static readonly DOC_EXTENSIONS = /\.(pdf|docx|pptx|xlsx)$/i;

    /**
     * 下载并解析文档附件（PDF/DOCX/PPTX/XLSX）
     *
     * 遍历附件列表，对文档类型附件：
     * 1. 从远程 URL 下载到本地 documents/ 目录
     * 2. 调用 MinerU 服务解析为 Markdown
     * 3. 返回所有解析结果合并的 Markdown 字符串
     *
     * @param req - 需求数据（需含 id、attachments）
     * @param mineruService - MinerU 解析服务实例
     * @param imageService - 可选的附件图片下载服务（由需求源适配器构建，用于认证下载）
     * @returns 合并后的 Markdown 字符串，无文档附件时返回空字符串
     */
    async downloadAndParseDocuments(
        req: { id: string; attachments: { name: string; url: string; type: string }[] },
        mineruService: MinerUService,
        imageService?: AttachmentImageService,
    ): Promise<string> {
        // 过滤文档类型附件
        const docAttachments = req.attachments.filter(
            att => att.url && RequirementStoreService.DOC_EXTENSIONS.test(att.name),
        );
        if (docAttachments.length === 0) return '';

        const docDir = path.join(this.reqDir(req.id), 'documents');
        fs.mkdirSync(docDir, {recursive: true});

        const mdParts: string[] = [];

        for (const att of docAttachments) {
            const localPath = path.join(docDir, att.name);

            try {
                // 下载文档文件
                if (!fs.existsSync(localPath)) {
                    let downloaded = false;

                    // 策略1: 直接下载
                    if (!downloaded) {
                        try {
                            await httpDownloadFile(att.url, localPath);
                            downloaded = true;
                        } catch { /* 回退 */
                        }
                    }

                    // 策略2: 如果有 ONES 服务且 URL 在 ONES 域名下，尝试认证下载
                    if (!downloaded && imageService) {
                        try {
                            const fileUrl = new URL(att.url);
                            // 构造 wiki 资源下载 URL（与图片类似的认证方式）
                            const resourceHash = att.name.replace(/\.[^.]+$/, '');
                            downloaded = await imageService.downloadImage(resourceHash, localPath);
                        } catch { /* 回退 */
                        }
                    }

                    if (!downloaded) {
                        console.warn(`[mineru-integration] Failed to download: ${att.name}`);
                        continue;
                    }
                }

                // 调用 MinerU 解析
                const result = await mineruService.parseFile(localPath);
                if (result.success && result.markdown) {
                    mdParts.push(`### ${att.name}\n\n${result.markdown}`);
                } else {
                    console.warn(`[mineru-integration] Failed to parse ${att.name}: ${result.error ?? 'no markdown'}`);
                }
            } catch (err) {
                console.warn(`[mineru-integration] Error processing ${att.name}: ${err instanceof Error ? err.message : err}`);
            }
        }

        return mdParts.join('\n\n---\n\n');
    }

    // === 数据迁移 ===

    /**
     * 从旧版 requirements.json 迁移到文件夹结构
     * 迁移成功后旧文件重命名为 .bak
     */
    migrateFromLegacy(): void {
        if (!fs.existsSync(LEGACY_STORE_FILE)) return;

        try {
            const raw = fs.readFileSync(LEGACY_STORE_FILE, 'utf-8');
            const items: StoredRequirement[] = JSON.parse(raw);
            if (!Array.isArray(items)) return;

            let migrated = 0;
            for (const item of items) {
                if (!item.id) continue;
                // 跳过已存在的需求
                if (fs.existsSync(this.metadataPath(item.id))) continue;
                this.upsert(item);
                migrated++;
            }

            // 迁移旧图片目录
            this.migrateLegacyImages(items);

            // 重命名旧文件
            fs.renameSync(LEGACY_STORE_FILE, LEGACY_STORE_FILE + '.bak');
            console.log(`[migration] migrated ${migrated} requirements from legacy format`);
        } catch (err) {
            console.warn(`[migration] failed to migrate requirements.json: ${err}`);
        }
    }

    /** 将旧版 requirement-images/{id}/ 下的图片移动到新结构 */
    private migrateLegacyImages(items: StoredRequirement[]): void {
        if (!fs.existsSync(LEGACY_IMAGE_DIR)) return;

        for (const item of items) {
            const legacyDir = path.join(LEGACY_IMAGE_DIR, item.id);
            if (!fs.existsSync(legacyDir)) continue;

            const newDir = this.getImageDir(item.id);
            if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, {recursive: true});

            // 移动图片文件
            const files = fs.readdirSync(legacyDir);
            for (const file of files) {
                const src = path.join(legacyDir, file);
                const dest = path.join(newDir, file);
                if (!fs.existsSync(dest)) {
                    fs.copyFileSync(src, dest);
                }
            }
        }

        // 重命名旧图片目录
        try {
            fs.renameSync(LEGACY_IMAGE_DIR, LEGACY_IMAGE_DIR + '.bak');
        } catch { /* 非关键，忽略 */
        }
    }
}
