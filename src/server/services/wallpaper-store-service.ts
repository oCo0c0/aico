/**
 * @file wallpaper-store-service.ts
 * @description 壁纸库存储服务 —— 服务端托管的壁纸文件 + 元数据 + 外观设置持久化
 *
 * 设计参考 dsh-wallpaper-engine（MIT）的「设置持久化到宿主端文件」思路：
 * - 全部设置（选中壁纸、效果、播放、遮挡暂停）存 `~/.aico/wallpapers/settings.json`，
 *   与端口无关 —— 重启/换端口/换浏览器/清浏览器数据都不丢（localStorage 按 origin 隔离，
 *   而桌面版/随机端口每次都是新 origin）。
 * - 上传文件写入 `~/.aico/wallpapers/uploads/`，缩略图写入 `thumbs/`，
 *   元数据在 `meta.json`。经 /api/wallpapers/:id/media、/thumb 同源路由服务。
 *
 * 线程模型：Node 单线程 + 同步 JSON 读写（与其它 Store Service 一致），
 * 文件写入用同步 API（上传量小频次低）；媒体文件读写由路由层用流处理。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {APP_DATA_DIR} from '../utils/constants.js';

/** 壁纸元数据 */
export interface WallpaperMeta {
    id: string;
    /** 显示名（默认取文件名） */
    title: string;
    /** image | video */
    type: 'image' | 'video';
    /** uploads/ 下的存储文件名 */
    fileName: string;
    mimeType: string;
    size: number;
    addedAt: string;
    /** 软删除标记：隐藏后不出现在默认列表，不删源文件 */
    hidden: boolean;
    /** 是否已生成缩略图 */
    hasThumb: boolean;
}

/** 效果参数（八滑杆 + 衍生） */
export interface WallpaperEffects {
    /** 壁纸模糊 0-60 px */
    wallpaperBlur: number;
    /** 亮度 40-160 % */
    brightness: number;
    /** 对比度 40-200 % */
    contrast: number;
    /** 饱和度 0-200 % */
    saturate: number;
    /** 壁纸透明度 0-90 %（越大越透，融向页面底色） */
    wallpaperOpacity: number;
    /** 暗化 0-0.9（scrim 强度） */
    dim: number;
    /** 边框增强 0-0.9 */
    border: number;
    /** 玻璃模糊半径 0-60 px（玻璃面板 backdrop blur） */
    glassBlur: number;
}

/** 播放参数 */
export interface WallpaperPlayback {
    /** 倍速 0.5-2 */
    rate: number;
    /** 水平翻转 */
    flip: boolean;
    /** 画面适配 */
    objectFit: 'cover' | 'contain' | 'center' | 'fill';
}

/** 遮挡暂停（省电三档） */
export interface WallpaperOcclusion {
    /** 页面隐藏（最小化/切走标签页）时暂停 */
    pauseOnHidden: boolean;
    /** 窗口失焦时暂停 */
    pauseOnBlur: boolean;
    /** 使用电池时暂停 */
    pauseOnBattery: boolean;
}

/** 壁纸插件全部持久化设置 */
export interface WallpaperSettings {
    /** 当前选中的壁纸 id（null = 未启用壁纸） */
    selectedId: string | null;
    /** 用户播放意图（暂停/播放） */
    playing: boolean;
    effects: WallpaperEffects;
    playback: WallpaperPlayback;
    occlusion: WallpaperOcclusion;
}

/** 默认设置（暗化默认 25%，参考 iOS 液态玻璃「低遮罩透色」的取向） */
export function defaultWallpaperSettings(): WallpaperSettings {
    return {
        selectedId: null,
        playing: true,
        effects: {
            wallpaperBlur: 0,
            brightness: 100,
            contrast: 100,
            saturate: 100,
            wallpaperOpacity: 0,
            dim: 0.25,
            border: 0.35,
            glassBlur: 16,
        },
        playback: {rate: 1, flip: false, objectFit: 'cover'},
        occlusion: {pauseOnHidden: true, pauseOnBlur: false, pauseOnBattery: false},
    };
}

/** 图片扩展名 → MIME */
const IMAGE_EXT: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};
/** 视频扩展名 → MIME */
const VIDEO_EXT: Record<string, string> = {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
};

/** id 合法性（防路径穿越） */
function isValidId(id: string): boolean {
    return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** 深合并 patch（仅一层嵌套对象，够用且可预测） */
function mergeSettings(base: WallpaperSettings, patch: Partial<WallpaperSettings>): WallpaperSettings {
    const out: WallpaperSettings = {
        ...base,
        ...patch,
        effects: {...base.effects, ...(patch.effects ?? {})},
        playback: {...base.playback, ...(patch.playback ?? {})},
        occlusion: {...base.occlusion, ...(patch.occlusion ?? {})},
    };
    // 数值夹取：滑杆拖出范围/手工 API 调用都不至于产生非法值
    const clamp = (v: number, min: number, max: number, fb: number) =>
        Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb;
    out.effects.wallpaperBlur = clamp(out.effects.wallpaperBlur, 0, 60, 0);
    out.effects.brightness = clamp(out.effects.brightness, 40, 160, 100);
    out.effects.contrast = clamp(out.effects.contrast, 40, 200, 100);
    out.effects.saturate = clamp(out.effects.saturate, 0, 200, 100);
    out.effects.wallpaperOpacity = clamp(out.effects.wallpaperOpacity, 0, 90, 0);
    out.effects.dim = clamp(out.effects.dim, 0, 0.9, 0.25);
    out.effects.border = clamp(out.effects.border, 0, 0.9, 0.35);
    out.effects.glassBlur = clamp(out.effects.glassBlur, 0, 60, 16);
    out.playback.rate = clamp(out.playback.rate, 0.5, 2, 1);
    if (!['cover', 'contain', 'center', 'fill'].includes(out.playback.objectFit)) {
        out.playback.objectFit = 'cover';
    }
    return out;
}

/**
 * 壁纸库存储服务
 */
export class WallpaperStoreService {
    private readonly rootDir: string;
    private readonly uploadsDir: string;
    private readonly thumbsDir: string;
    private readonly metaFile: string;
    private readonly settingsFile: string;

    constructor(rootDir?: string) {
        this.rootDir = rootDir ?? path.join(APP_DATA_DIR, 'wallpapers');
        this.uploadsDir = path.join(this.rootDir, 'uploads');
        this.thumbsDir = path.join(this.rootDir, 'thumbs');
        this.metaFile = path.join(this.rootDir, 'meta.json');
        this.settingsFile = path.join(this.rootDir, 'settings.json');
    }

    /** 确保目录结构存在 */
    private ensureDirs(): void {
        for (const dir of [this.rootDir, this.uploadsDir, this.thumbsDir]) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
        }
    }

    // ── 元数据 ──────────────────────────────────────────────────────────────

    private loadMeta(): WallpaperMeta[] {
        if (!fs.existsSync(this.metaFile)) return [];
        try {
            const parsed = JSON.parse(fs.readFileSync(this.metaFile, 'utf-8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    private saveMeta(items: WallpaperMeta[]): void {
        this.ensureDirs();
        fs.writeFileSync(this.metaFile, JSON.stringify(items, null, 2), 'utf-8');
    }

    /** 全量列表（按加入时间倒序） */
    list(): WallpaperMeta[] {
        return this.loadMeta().sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    }

    get(id: string): WallpaperMeta | undefined {
        if (!isValidId(id)) return undefined;
        return this.loadMeta().find(w => w.id === id);
    }

    // ── 上传 / 缩略图 ───────────────────────────────────────────────────────

    /**
     * 为流式上传准备临时文件路径。
     * 路由层把请求体直接管道到这里（不经内存 Buffer），收尾后调
     * {@link addFromStream} 改名登记。
     */
    tempUploadPath(): string {
        this.ensureDirs();
        return path.join(this.uploadsDir, `.incoming-${process.pid}-${Date.now()}.tmp`);
    }

    /**
     * 登记一个已落盘的上传文件（流式上传收尾）
     * @param tmpPath   tempUploadPath() 生成的临时文件（内部改名为正式存储名，失败时清理）
     * @param size      实际接收的字节数（路由层边收边计数）
     * @param title     显示名（缺省用文件名）
     * @param origName  原始文件名（推断类型与扩展名）
     * @returns 新建的元数据
     */
    addFromStream(tmpPath: string, size: number, title: string | undefined, origName: string): WallpaperMeta {
        this.ensureDirs();
        const ext = path.extname(origName || '').toLowerCase();
        const isImage = ext in IMAGE_EXT;
        const isVideo = ext in VIDEO_EXT;
        if (!isImage && !isVideo) {
            try {
                fs.rmSync(tmpPath, {force: true});
            } catch { /* ignore */ }
            throw new Error(`不支持的文件格式：${ext || '(无扩展名)'}，仅支持 JPG/PNG/WEBP/MP4/WEBM`);
        }
        if (size === 0) {
            try {
                fs.rmSync(tmpPath, {force: true});
            } catch { /* ignore */ }
            throw new Error('上传内容为空');
        }
        const id = `wp_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
        const fileName = `${id}${ext}`;
        try {
            fs.renameSync(tmpPath, path.join(this.uploadsDir, fileName));
        } catch (err) {
            try {
                fs.rmSync(tmpPath, {force: true});
            } catch { /* ignore */ }
            throw err;
        }
        const meta: WallpaperMeta = {
            id,
            title: (title && title.trim()) || path.basename(origName || fileName),
            type: isImage ? 'image' : 'video',
            fileName,
            mimeType: (isImage ? IMAGE_EXT : VIDEO_EXT)[ext],
            size,
            addedAt: new Date().toISOString(),
            hidden: false,
            hasThumb: false,
        };
        const items = this.loadMeta();
        items.push(meta);
        this.saveMeta(items);
        return meta;
    }

    /**
     * 保存客户端生成的缩略图（dataURL → 落盘 jpg/png）
     * 缩略图由前端 canvas 生成（图片降采样 / 视频抽帧），服务端零原生依赖。
     */
    saveThumb(id: string, dataUrl: string): boolean {
        const meta = this.get(id);
        if (!meta) return false;
        const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
        if (!m) throw new Error('缩略图必须是 image/* 的 dataURL');
        this.ensureDirs();
        const ext = m[1] === 'image/png' ? '.png' : m[1] === 'image/webp' ? '.webp' : '.jpg';
        // 统一命名为 <id><ext>，旧缩略图（扩展名不同）顺手清理
        for (const old of ['.jpg', '.png', '.webp']) {
            if (old !== ext) {
                const p = path.join(this.thumbsDir, id + old);
                if (fs.existsSync(p)) fs.unlinkSync(p);
            }
        }
        fs.writeFileSync(path.join(this.thumbsDir, id + ext), Buffer.from(m[2], 'base64'));
        const items = this.loadMeta();
        const idx = items.findIndex(w => w.id === id);
        if (idx >= 0) {
            items[idx].hasThumb = true;
            this.saveMeta(items);
        }
        return true;
    }

    /** 媒体文件绝对路径（不存在返回 null） */
    mediaPath(id: string): string | null {
        const meta = this.get(id);
        if (!meta) return null;
        const p = path.join(this.uploadsDir, meta.fileName);
        return fs.existsSync(p) ? p : null;
    }

    /** 缩略图绝对路径（未生成返回 null） */
    thumbPath(id: string): string | null {
        if (!isValidId(id)) return null;
        for (const ext of ['.jpg', '.png', '.webp']) {
            const p = path.join(this.thumbsDir, id + ext);
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    // ── 隐藏 / 删除 / 改名 ──────────────────────────────────────────────────

    /** 软删除：隐藏（不删源文件；隐藏当前播放中的壁纸不打断播放，由前端语义决定） */
    setHidden(id: string, hidden: boolean): WallpaperMeta | undefined {
        const items = this.loadMeta();
        const idx = items.findIndex(w => w.id === id);
        if (idx < 0) return undefined;
        items[idx].hidden = hidden;
        this.saveMeta(items);
        return items[idx];
    }

    /** 重命名 */
    rename(id: string, title: string): WallpaperMeta | undefined {
        const items = this.loadMeta();
        const idx = items.findIndex(w => w.id === id);
        if (idx < 0) return undefined;
        items[idx].title = title.trim() || items[idx].title;
        this.saveMeta(items);
        return items[idx];
    }

    /** 硬删除：移除文件 + 缩略图 + 元数据 */
    remove(id: string): boolean {
        const items = this.loadMeta();
        const idx = items.findIndex(w => w.id === id);
        if (idx < 0) return false;
        const [meta] = items.splice(idx, 1);
        this.saveMeta(items);
        for (const p of [
            path.join(this.uploadsDir, meta.fileName),
            path.join(this.thumbsDir, meta.id + '.jpg'),
            path.join(this.thumbsDir, meta.id + '.png'),
            path.join(this.thumbsDir, meta.id + '.webp'),
        ]) {
            try {
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch { /* Windows 文件占用时尽力而为 */ }
        }
        return true;
    }

    // ── 设置持久化 ──────────────────────────────────────────────────────────

    getSettings(): WallpaperSettings {
        const defaults = defaultWallpaperSettings();
        if (!fs.existsSync(this.settingsFile)) return defaults;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.settingsFile, 'utf-8'));
            // 文件损坏时回退默认值且不覆盖文件（与 WE 插件同一策略）
            return mergeSettings(defaults, typeof parsed === 'object' && parsed ? parsed : {});
        } catch {
            return defaults;
        }
    }

    saveSettings(patch: Partial<WallpaperSettings>): WallpaperSettings {
        const next = mergeSettings(this.getSettings(), patch);
        this.ensureDirs();
        fs.writeFileSync(this.settingsFile, JSON.stringify(next, null, 2), 'utf-8');
        return next;
    }
}
