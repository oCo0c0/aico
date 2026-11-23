/**
 * @file wallpaper-store.ts
 * @description 壁纸功能全局状态 —— 清单、设置、播放态、上传
 *
 * 持久化策略（参考 dsh-wallpaper-engine v0.4.0 的「宿主端文件 + 本地缓存」）：
 * - 设置的服务器事实源是 settings.json（经 /api/wallpapers/settings 读写），
 *   端口无关 —— 换端口/换浏览器/清缓存都不丢；
 * - localStorage 存一份缓存用于启动秒开回显，服务端响应后合并覆盖（服务端为准）；
 * - 每次修改 300ms 防抖合并写服务端。
 *
 * 效果应用：所有视觉参数走 CSS 变量（--wp-*）+ body[data-wallpaper-active] 属性，
 * 由 applyEffects 统一注入 —— 组件只读 store，不直接碰 DOM 样式。
 * identity 状态一律不设变量（transform: none / opacity 不建合成层），
 * 这是 dsh-wallpaper-engine 防整屏闪白的核心纪律。
 */
import {create} from 'zustand';
import {
    defaultWallpaperSettings,
    mergeWallpaperSettings,
    type WallpaperMeta,
    type WallpaperSettings,
    type WallpaperSettingsPatch,
} from '../types/wallpaper';
import {generateThumb, videoErrorText} from '../lib/wallpaper-media';

/** localStorage 缓存键（服务端合并前的秒开回显） */
const CACHE_KEY = 'ai-workbench-wallpaper-settings';
/** 服务端防抖保存延时 */
const PERSIST_DELAY = 300;
/** 上传大小上限（与路由层 2GB 对齐） */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

// ── 效果应用：store → CSS 变量 + body 属性 ───────────────────────────────────

/**
 * 把设置注入 DOM。组件树之外的全局副作用统一收口在这里，
 * 保证「一次修改 → 一处应用」，避免多处写变量互相覆盖。
 */
function applyEffects(s: WallpaperSettings): void {
    if (typeof document === 'undefined') return;
    const style = document.body.style;
    const e = s.effects;

    // 暗化 scrim（叠在壁纸之上、界面之下）
    style.setProperty('--wp-scrim', `rgba(0, 0, 0, ${e.dim})`);
    // 边框增强：壁纸模式下边框/分割线的可见度
    style.setProperty('--wp-border-alpha', String(e.border));
    // 玻璃：模糊半径与饱和度联动（iOS 液态玻璃配方 —— 0 模糊 → 无「融化」）
    style.setProperty('--wp-glass-blur', `${e.glassBlur}px`);
    style.setProperty('--wp-glass-saturate', String(1.15 + e.glassBlur * 0.028));

    // 壁纸媒体滤镜：未调的项不输出 —— 常驻 blur(0) 也会给视频每帧强加离屏
    // 滤镜层（Chromium 周期性合成毛病的来源之一）
    const terms: string[] = [];
    if (e.wallpaperBlur > 0) terms.push(`blur(${e.wallpaperBlur}px)`);
    if (e.brightness !== 100) terms.push(`brightness(${e.brightness}%)`);
    if (e.contrast !== 100) terms.push(`contrast(${e.contrast}%)`);
    if (e.saturate !== 100) terms.push(`saturate(${e.saturate}%)`);
    style.setProperty('--wp-media-filter', terms.length ? terms.join(' ') : 'none');

    // 单一 transform 变量：模糊边缘补偿 scale 与镜像 scaleX 合成；identity 时不设
    //（scale(1) 也强把全屏 <video> 拉进变换合成层 —— 多余的常驻层是闪白帮凶）
    const scale = (1 + e.wallpaperBlur * 0.006).toFixed(4);
    if (e.wallpaperBlur > 0 || s.playback.flip) {
        style.setProperty('--wp-transform', `scale(${scale}) scaleX(${s.playback.flip ? '-1' : '1'})`);
    } else {
        style.removeProperty('--wp-transform');
    }
    // 画面适配（.we-media--fit 消费）
    style.setProperty('--wp-object-fit', s.playback.objectFit);
    // 壁纸透明度：作用于整层 element opacity（视频/图片统一生效）；0% 不设变量
    if (e.wallpaperOpacity > 0) {
        style.setProperty('--wp-opacity', String((100 - e.wallpaperOpacity) / 100));
    } else {
        style.removeProperty('--wp-opacity');
    }

    // 激活属性：CSS 据此做内容面透明化 + 浅色文字对比度适配
    if (s.selectedId) document.body.setAttribute('data-wallpaper-active', 'on');
    else document.body.removeAttribute('data-wallpaper-active');

    // 缓存快照（服务端不可达时也不至于丢配置）
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// ── 服务端防抖保存 ──────────────────────────────────────────────────────────

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** 最近一次完整设置快照（防抖窗口内被连续修改时，只 PUT 最终值） */
let pendingSettings: WallpaperSettings | null = null;

function schedulePersist(settings: WallpaperSettings): void {
    pendingSettings = settings;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
        persistTimer = null;
        const payload = pendingSettings;
        pendingSettings = null;
        if (!payload) return;
        try {
            await fetch('/api/wallpapers/settings', {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload),
            });
        } catch { /* 服务端不可达：localStorage 缓存已兜底 */ }
    }, PERSIST_DELAY);
}

// ── 遮挡暂停：电池信号 ──────────────────────────────────────────────────────

let batteryManager: BatteryManagerLike | null = null;
interface BatteryManagerLike extends EventTarget {
    charging: boolean;
}
function watchBattery(onChange: () => void): void {
    if (batteryManager) return;
    const nav = navigator as Navigator & {getBattery?: () => Promise<BatteryManagerLike>};
    if (typeof nav.getBattery !== 'function') return;
    nav.getBattery()
        .then((b) => {
            batteryManager = b;
            b.addEventListener('chargingchange', onChange);
        })
        .catch(() => { /* 不支持则该档无操作 */ });
}

// init 幂等守卫：StrictMode 双挂载 / Layout 重复挂载时，全局监听与 store 订阅只挂一次
let initStarted = false;

// ── Store ──────────────────────────────────────────────────────────────────

interface WallpaperState {
    /** 壁纸清单（含隐藏项，UI 自行过滤） */
    list: WallpaperMeta[];
    /** 清单是否已加载过 */
    listLoaded: boolean;
    /** 全部设置（服务端持久化 + localStorage 缓存） */
    settings: WallpaperSettings;
    /** 服务端设置是否已合并（避免首帧闪默认值） */
    hostLoaded: boolean;
    /** 选择器弹窗开关 */
    pickerOpen: boolean;
    /** 上传中 */
    uploading: boolean;
    /** 上传错误 */
    uploadError: string;
    /** 视频元素真实播放态（与用户意图 playing 区分） */
    videoPlaying: boolean;
    /** 视频失败原因（人话） */
    videoError: string;
    /** 遮挡态快照（hidden/失焦/电池），WallpaperLayer 订阅判定是否暂停 */
    occluded: boolean;

    init: () => Promise<void>;
    refreshList: () => Promise<void>;
    setPickerOpen: (open: boolean) => void;
    /** 修改设置（本地立即生效 + 防抖服务端持久化） */
    patchSettings: (patch: WallpaperSettingsPatch) => void;
    /** 选择/清除壁纸 */
    select: (id: string | null) => void;
    /** 用户播放意图 */
    setPlaying: (playing: boolean) => void;
    /** 视频元素真实态回写（仅变化时更新，避免整树重渲染风暴） */
    syncVideoState: (video: HTMLVideoElement | null) => void;
    /** 上传壁纸（含缩略图生成，成功后自动选中） */
    upload: (file: File) => Promise<boolean>;
    setHidden: (id: string, hidden: boolean) => Promise<void>;
    remove: (id: string) => Promise<void>;
}

export const useWallpaperStore = create<WallpaperState>((set, get) => ({
    list: [],
    listLoaded: false,
    settings: defaultWallpaperSettings(),
    hostLoaded: false,
    pickerOpen: false,
    uploading: false,
    uploadError: '',
    videoPlaying: false,
    videoError: '',
    occluded: false,

    init: async () => {
        if (initStarted) return;
        initStarted = true;

        // 1. localStorage 缓存先行：启动瞬间就恢复上次外观（无网络等待）
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const parsed = mergeWallpaperSettings(defaultWallpaperSettings(), JSON.parse(cached));
                applyEffects(parsed);
                set({settings: parsed});
            } else {
                applyEffects(get().settings);
            }
        } catch {
            applyEffects(get().settings);
        }

        // 2. 服务端事实源合并（服务端为准）
        try {
            const [settingsRes, listRes] = await Promise.all([
                fetch('/api/wallpapers/settings').then(async (r) => (r.ok ? r.json() : null)),
                fetch('/api/wallpapers').then(async (r) => (r.ok ? r.json() : null)),
            ]);
            const merged = mergeWallpaperSettings(defaultWallpaperSettings(), settingsRes ?? {});
            applyEffects(merged);
            set({
                settings: merged,
                hostLoaded: true,
                list: (listRes?.wallpapers ?? []) as WallpaperMeta[],
                listLoaded: true,
            });
        } catch {
            set({hostLoaded: true, listLoaded: true});
        }

        // 3. 电池信号（遮挡暂停第三档）
        const syncOcclusion = () => {
            const s = get().settings;
            const hidden = typeof document !== 'undefined' && document.hidden;
            const blurred = typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus();
            const onBattery = batteryManager ? !batteryManager.charging : false;
            const occluded =
                (s.occlusion.pauseOnHidden && hidden) ||
                (s.occlusion.pauseOnBlur && blurred) ||
                (s.occlusion.pauseOnBattery && onBattery);
            if (get().occluded !== occluded) set({occluded});
        };
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', syncOcclusion);
            window.addEventListener('focus', syncOcclusion);
            window.addEventListener('blur', syncOcclusion);
        }
        watchBattery(syncOcclusion);
        // occlusion 开关变化也要立即重估（否则切开关后要等下一次事件）
        let lastOcclusionFlags = '';
        useWallpaperStore.subscribe((state) => {
            const flags = `${state.settings.occlusion.pauseOnHidden}|${state.settings.occlusion.pauseOnBlur}|${state.settings.occlusion.pauseOnBattery}`;
            if (flags !== lastOcclusionFlags) {
                lastOcclusionFlags = flags;
                syncOcclusion();
            }
        });
    },

    refreshList: async () => {
        try {
            const res = await fetch('/api/wallpapers').then(r => r.json());
            set({list: (res?.wallpapers ?? []) as WallpaperMeta[], listLoaded: true});
        } catch { /* 保留旧清单 */ }
    },

    setPickerOpen: (open) => set({pickerOpen: open, uploadError: ''}),

    patchSettings: (patch) => {
        const next = mergeWallpaperSettings(get().settings, patch);
        applyEffects(next);
        schedulePersist(next);
        set({settings: next});
    },

    select: (id) => {
        // 清除错误态：换壁纸后旧失败原因不再属于当前媒体
        set({videoError: '', videoPlaying: false});
        get().patchSettings({selectedId: id, playing: true});
    },

    setPlaying: (playing) => get().patchSettings({playing}),

    syncVideoState: (video) => {
        const playing = video != null && !video.paused && !video.ended && !video.error;
        const error = videoErrorText(video);
        if (get().videoPlaying !== playing || get().videoError !== error) {
            set({videoPlaying: playing, videoError: error});
        }
    },

    upload: async (file) => {
        if (file.size > MAX_UPLOAD_BYTES) {
            set({uploadError: '文件超过 2GB 上限'});
            return false;
        }
        set({uploading: true, uploadError: ''});
        try {
            // 1. 缩略图先行生成（与上传并行会抢编解码资源，串行更稳）
            const thumb = await generateThumb(file);
            // 2. 原始字节流上传
            const res = await fetch(`/api/wallpapers/upload?title=${encodeURIComponent(file.name)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-File-Name': encodeURIComponent(file.name),
                },
                body: file,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
            const meta = data.wallpaper as WallpaperMeta;
            // 3. 缩略图落服务端（失败不回滚上传 —— 播放不受影响）
            if (thumb) {
                await fetch(`/api/wallpapers/${meta.id}/thumb`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({dataUrl: thumb}),
                }).catch(() => undefined);
            }
            await get().refreshList();
            // 4. 自动选中（开箱即用）
            get().select(meta.id);
            return true;
        } catch (err) {
            set({uploadError: err instanceof Error ? err.message : String(err)});
            return false;
        } finally {
            set({uploading: false});
        }
    },

    setHidden: async (id, hidden) => {
        try {
            await fetch(`/api/wallpapers/${id}`, {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({hidden}),
            });
            await get().refreshList();
        } catch { /* ignore */ }
    },

    remove: async (id) => {
        try {
            await fetch(`/api/wallpapers/${id}`, {method: 'DELETE'});
            // 删除的是当前壁纸：先清除选中（服务端 settings.selectedId 也要清）
            if (get().settings.selectedId === id) get().select(null);
            await get().refreshList();
        } catch { /* ignore */ }
    },
}));
