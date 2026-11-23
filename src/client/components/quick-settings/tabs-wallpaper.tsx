/**
 * @file tabs-wallpaper.tsx
 * @description 快捷设置面板 · 壁纸/效果/高级 三个页签（wallpaper-store）
 *
 * 内容自原设置中心「壁纸」分区拆分（对齐 dsh-wallpaper-engine 的分区思路）：
 * - 壁纸：当前壁纸卡片（黑胶 + 选择/暂停/关闭）；
 * - 效果：八滑杆（壁纸模糊/亮度/对比度/饱和度/透明度/暗化/边框/玻璃）；
 * - 高级：倍速 / 水平翻转 / 画面适配 / 遮挡暂停三档。
 */
import {useTranslation} from 'react-i18next';
import {Film, Image as ImageIcon, Pause, Play, RefreshCw, X} from 'lucide-react';
import {cn} from '../../lib/utils';
import {useDesktopUpdate} from '../../hooks/useDesktopUpdate';
import {useWallpaperStore} from '../../stores/wallpaper-store';
import {Vinyl} from '../wallpaper/Vinyl';
import {Row, SectionTitle, SliderRow, Toggle} from './controls';

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** 壁纸页签：当前壁纸卡片 + 壁纸库入口 */
export function WallpaperTab() {
    const {t} = useTranslation();
    const settings = useWallpaperStore(s => s.settings);
    const select = useWallpaperStore(s => s.select);
    const setPlaying = useWallpaperStore(s => s.setPlaying);
    const setPickerOpen = useWallpaperStore(s => s.setPickerOpen);
    const list = useWallpaperStore(s => s.list);
    const videoPlaying = useWallpaperStore(s => s.videoPlaying);
    const videoError = useWallpaperStore(s => s.videoError);

    const current = list.find(w => w.id === settings.selectedId) ?? null;
    const hasWallpaper = Boolean(current);

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-4 rounded-xl border border-border/40 bg-secondary/30 p-3">
                <Vinyl
                    thumbUrl={current?.hasThumb ? `/api/wallpapers/${current.id}/thumb` : null}
                    fallbackIcon={current?.type === 'video'
                        ? <Film className="h-6 w-6 text-muted-foreground"/>
                        : <ImageIcon className="h-6 w-6 text-muted-foreground"/>}
                    playing={hasWallpaper && settings.playing && videoPlaying}
                    title={current?.title ?? t('settings.wallpaper.noneSelected')}
                />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                        {current?.title ?? t('settings.wallpaper.noneSelected')}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {current
                            ? (current.type === 'video'
                                ? t('settings.wallpaper.currentVideo')
                                : t('settings.wallpaper.currentImage'))
                            : t('settings.wallpaper.noneHint')}
                    </p>
                    {videoError && hasWallpaper && (
                        <p className="mt-1 text-xs text-destructive">{videoError}</p>
                    )}
                </div>
            </div>
            <div className="flex items-center justify-end gap-1.5">
                {hasWallpaper && (
                    <>
                        <button
                            type="button"
                            className="flex items-center gap-1 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                            onClick={() => setPlaying(!settings.playing)}
                        >
                            {settings.playing ? <Pause className="h-3.5 w-3.5"/> : <Play className="h-3.5 w-3.5"/>}
                            {settings.playing ? t('settings.wallpaper.pause') : t('settings.wallpaper.play')}
                        </button>
                        <button
                            type="button"
                            className="flex items-center gap-1 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                            onClick={() => select(null)}
                        >
                            <X className="h-3.5 w-3.5"/>
                            {t('settings.wallpaper.clear')}
                        </button>
                    </>
                )}
                <button
                    type="button"
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                    onClick={() => setPickerOpen(true)}
                >
                    {t('settings.wallpaper.pick')}
                </button>
            </div>
            <p className="rounded-lg bg-secondary/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                {t('settings.qs.wallpaperHint')}
            </p>
        </div>
    );
}

/** 效果页签：八滑杆 */
export function EffectsTab() {
    const {t} = useTranslation();
    const effects = useWallpaperStore(s => s.settings.effects);
    const patchSettings = useWallpaperStore(s => s.patchSettings);
    const e = effects;

    return (
        <div>
            <SectionTitle title={t('settings.wallpaper.sectionEffects')} desc={t('settings.wallpaper.effectsDesc')}/>
            <SliderRow
                label={t('settings.wallpaper.fxWallpaperBlur')}
                min={0} max={60} step={1} value={e.wallpaperBlur}
                onChange={(v) => patchSettings({effects: {wallpaperBlur: v}})}
                format={(v) => `${v}px`}
            />
            <SliderRow
                label={t('settings.wallpaper.fxBrightness')}
                min={40} max={160} step={5} value={e.brightness}
                onChange={(v) => patchSettings({effects: {brightness: v}})}
                format={(v) => `${v}%`}
            />
            <SliderRow
                label={t('settings.wallpaper.fxContrast')}
                min={40} max={200} step={5} value={e.contrast}
                onChange={(v) => patchSettings({effects: {contrast: v}})}
                format={(v) => `${v}%`}
            />
            <SliderRow
                label={t('settings.wallpaper.fxSaturate')}
                min={0} max={200} step={5} value={e.saturate}
                onChange={(v) => patchSettings({effects: {saturate: v}})}
                format={(v) => `${v}%`}
            />
            <SliderRow
                label={t('settings.wallpaper.fxOpacity')}
                hint={t('settings.wallpaper.fxOpacityHint')}
                min={0} max={90} step={5} value={e.wallpaperOpacity}
                onChange={(v) => patchSettings({effects: {wallpaperOpacity: v}})}
                format={(v) => `${v}%`}
            />
            <SliderRow
                label={t('settings.wallpaper.fxDim')}
                min={0} max={90} step={5} value={Math.round(e.dim * 100)}
                onChange={(v) => patchSettings({effects: {dim: v / 100}})}
                format={(v) => `${v}%`}
            />
            <SliderRow
                label={t('settings.wallpaper.fxBorder')}
                min={0} max={90} step={5} value={Math.round(e.border * 100)}
                onChange={(v) => patchSettings({effects: {border: v / 100}})}
                format={(v) => `${v}%`}
            />
            <SliderRow
                label={t('settings.wallpaper.fxGlass')}
                hint={t('settings.wallpaper.fxGlassHint')}
                min={0} max={60} step={1} value={e.glassBlur}
                onChange={(v) => patchSettings({effects: {glassBlur: v}})}
                format={(v) => `${v}px`}
            />
        </div>
    );
}

/** 高级页签：版本与更新 / 倍速 / 翻转 / 适配 / 遮挡暂停三档 */
export function AdvancedTab() {
    const {t} = useTranslation();
    const settings = useWallpaperStore(s => s.settings);
    const patchSettings = useWallpaperStore(s => s.patchSettings);
    const p = settings.playback;
    const o = settings.occlusion;
    const list = useWallpaperStore(s => s.list);
    const isVideo = list.some(w => w.id === settings.selectedId && w.type === 'video');

    return (
        <div className="space-y-4">
            {/* 版本与更新（仅桌面环境渲染；自动检查由主进程静默进行，这里提供手动入口） */}
            <UpdateSection/>

            <section>
                <SectionTitle title={t('settings.wallpaper.sectionPlayback')}/>
                <div className="divide-y divide-border/40">
                    <Row
                        label={t('settings.wallpaper.rate')}
                        hint={isVideo ? undefined : t('settings.wallpaper.rateVideoOnly')}
                    >
                        <div className="flex flex-wrap justify-end gap-1">
                            {RATE_OPTIONS.map(rate => (
                                <button
                                    key={rate}
                                    type="button"
                                    className={cn(
                                        'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                                        p.rate === rate
                                            ? 'brand-gradient-soft text-primary'
                                            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                                    )}
                                    onClick={() => patchSettings({playback: {rate}})}
                                >
                                    {rate}x
                                </button>
                            ))}
                        </div>
                    </Row>
                    <Row label={t('settings.wallpaper.flip')} hint={t('settings.wallpaper.flipHint')}>
                        <Toggle
                            checked={p.flip}
                            onChange={(v) => patchSettings({playback: {flip: v}})}
                            label={t('settings.wallpaper.flip')}
                        />
                    </Row>
                    <Row label={t('settings.wallpaper.fit')} hint={t('settings.wallpaper.fitHint')}>
                        <select
                            className="h-8 rounded-lg border border-border/60 bg-transparent px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                            value={p.objectFit}
                            onChange={(ev) => patchSettings({playback: {objectFit: ev.target.value as typeof p.objectFit}})}
                        >
                            <option value="cover">{t('settings.wallpaper.fitCover')}</option>
                            <option value="contain">{t('settings.wallpaper.fitContain')}</option>
                            <option value="center">{t('settings.wallpaper.fitCenter')}</option>
                            <option value="fill">{t('settings.wallpaper.fitFill')}</option>
                        </select>
                    </Row>
                </div>
            </section>

            <section>
                <SectionTitle title={t('settings.wallpaper.sectionOcclusion')} desc={t('settings.wallpaper.occlusionDesc')}/>
                <div className="divide-y divide-border/40">
                    <Row label={t('settings.wallpaper.pauseOnHidden')}>
                        <Toggle
                            checked={o.pauseOnHidden}
                            onChange={(v) => patchSettings({occlusion: {pauseOnHidden: v}})}
                            label={t('settings.wallpaper.pauseOnHidden')}
                        />
                    </Row>
                    <Row label={t('settings.wallpaper.pauseOnBlur')}>
                        <Toggle
                            checked={o.pauseOnBlur}
                            onChange={(v) => patchSettings({occlusion: {pauseOnBlur: v}})}
                            label={t('settings.wallpaper.pauseOnBlur')}
                        />
                    </Row>
                    <Row label={t('settings.wallpaper.pauseOnBattery')} hint={t('settings.wallpaper.pauseOnBatteryHint')}>
                        <Toggle
                            checked={o.pauseOnBattery}
                            onChange={(v) => patchSettings({occlusion: {pauseOnBattery: v}})}
                            label={t('settings.wallpaper.pauseOnBattery')}
                        />
                    </Row>
                </div>
            </section>
        </div>
    );
}

/**
 * 「版本与更新」区（仅桌面环境渲染；Web 端无 window.adwDesktop 直接跳过）
 *
 * 展示当前版本（构建期由 vite define 注入 __APP_VERSION__）+ 手动检查按钮 +
 * 状态行。自动检查/下载由主进程静默完成（UpdateNotice 负责打扰式提示），
 * 这里只做「用户主动想看看有没有新版」的入口与结果反馈。
 */
function UpdateSection() {
    const {t} = useTranslation();
    const {state, isDesktop, isManualCheck, check, install} = useDesktopUpdate();
    if (!isDesktop) return null;

    // 状态行文案：优先展示明确状态，checking 时区分手动/自动
    const statusText = (() => {
        switch (state.status) {
            case 'checking': return t(isManualCheck ? 'update.checking' : 'update.autoChecking');
            case 'downloading': return t('update.downloading', {percent: state.percent ?? 0});
            case 'downloaded': return t('update.downloaded', {version: state.version ?? ''});
            case 'available': return t('update.available', {version: state.version ?? ''});
            case 'error': return t('update.errorShort', {message: state.message ?? ''});
            default: return t('update.upToDate');
        }
    })();

    return (
        <section>
            <SectionTitle title={t('update.sectionTitle')} desc={t('update.sectionDesc')}/>
            <div className="divide-y divide-border/40">
                <Row label={t('update.currentVersion', {version: __APP_VERSION__})}>
                    {state.status === 'downloaded' ? (
                        <button
                            type="button"
                            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                            onClick={install}
                        >
                            {t('update.installNow')}
                        </button>
                    ) : (
                        <button
                            type="button"
                            disabled={state.status === 'checking' || state.status === 'downloading'}
                            className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={check}
                        >
                            <RefreshCw className={cn('h-3.5 w-3.5', state.status === 'checking' && 'animate-spin')}/>
                            {t('update.check')}
                        </button>
                    )}
                </Row>
                <Row label={t('update.status')}>
                    <span className="max-w-[220px] break-all text-right text-xs text-muted-foreground">{statusText}</span>
                </Row>
            </div>
        </section>
    );
}
