/**
 * @file tabs-appearance.tsx
 * @description 快捷设置面板 · 外观/字体/吉祥物 三个页签（app-store 偏好）
 *
 * 外观页签对齐 dsh-wallpaper-engine 的「外观」分区：配色（6 预设 + 自定义取色）、
 * 玻璃颜色（6 预设 + 自定义 + 跟随主题）、主题、玻璃透明度、背景照片（经典）、语言。
 */
import {useMemo, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import {ImagePlus, Trash2} from 'lucide-react';
import {cn} from '../../lib/utils';
import {
    ACCENT_PRESETS,
    CODE_THEME_PRESETS,
    GLASS_COLOR_PRESETS,
    lightenHex,
} from '../../lib/appearance';
import {
    CUSTOM_FONT_VALUE,
    DEFAULT_FONT_EN,
    DEFAULT_FONT_SIZE,
    DEFAULT_FONT_ZH,
    EN_FONT_OPTIONS,
    ZH_FONT_OPTIONS,
    firstQuotedFamily,
    isFontInstalled,
} from '../../lib/font-options';
import {PET_FORMS, PetAvatar} from '../mascot/pets';
import {DEFAULT_OPACITY, useAppStore} from '../../stores/app-store';
import {Input} from '../ui/input';
import {Row, SectionTitle, SegmentedControl, SliderRow, Toggle} from './controls';

/** 下拉控件样式（沿用项目既有表单写法） */
const SELECT_CLASS = 'flex h-8 w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/** 色板按钮（选中态描边 + 对勾位置感） */
function Swatch({hex, active, title, onClick}: {
    hex: string;
    active: boolean;
    title: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            title={title}
            onClick={onClick}
            className={cn(
                'h-7 w-7 rounded-full border border-border/60 shadow-sm transition-transform hover:scale-110',
                active && 'ring-2 ring-ring ring-offset-2 ring-offset-background'
            )}
            style={{background: hex}}
        />
    );
}

/** 外观页签：配色 / 玻璃颜色 / 主题 / 透明度 / 背景照片 / 语言 */
export function AppearanceTab() {
    const {t, i18n} = useTranslation();
    const theme = useAppStore(s => s.ui.theme);
    const setTheme = useAppStore(s => s.setTheme);
    const locale = useAppStore(s => s.ui.locale);
    const setLocale = useAppStore(s => s.setLocale);
    const accent = useAppStore(s => s.ui.accent);
    const setAccent = useAppStore(s => s.setAccent);
    const glassColor = useAppStore(s => s.ui.glassColor);
    const setGlassColor = useAppStore(s => s.setGlassColor);
    const codeTheme = useAppStore(s => s.ui.codeTheme);
    const setCodeTheme = useAppStore(s => s.setCodeTheme);
    const opacity = useAppStore(s => s.ui.opacity);
    const setOpacity = useAppStore(s => s.setOpacity);
    const bgImage = useAppStore(s => s.ui.bgImage);
    const setBgImage = useAppStore(s => s.setBgImage);
    const bgFileRef = useRef<HTMLInputElement>(null);

    const activeAccentId = accent
        ? ACCENT_PRESETS.find(p => p.from.toLowerCase() === accent.from.toLowerCase())?.id ?? 'custom'
        : 'classic';

    const handleLocaleChange = (next: 'zh' | 'en') => {
        if (next === locale) return;
        setLocale(next);
        i18n.changeLanguage(next);
    };

    const handleBgFile = (file: File | undefined) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => setBgImage(String(reader.result));
        reader.readAsDataURL(file);
    };

    return (
        <div className="space-y-5">
            <section>
                <SectionTitle title={t('settings.qs.accent')} desc={t('settings.qs.accentDesc')}/>
                <div className="flex items-center gap-2">
                    {ACCENT_PRESETS.map(p => (
                        <Swatch
                            key={p.id}
                            hex={p.from}
                            active={activeAccentId === p.id}
                            title={t(`settings.qs.accent_${p.id}`)}
                            onClick={() => setAccent({from: p.from, to: p.to})}
                        />
                    ))}
                    <label
                        className={cn(
                            'relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-border/60 shadow-sm transition-transform hover:scale-110',
                            activeAccentId === 'custom' && 'ring-2 ring-ring ring-offset-2 ring-offset-background'
                        )}
                        title={t('settings.qs.accentCustom')}
                        style={activeAccentId === 'custom' && accent ? {background: accent.from} : {
                            background: 'conic-gradient(#ef4444,#eab308,#22c55e,#3b82f6,#8b5cf6,#ec4899,#ef4444)'
                        }}
                    >
                        <input
                            type="color"
                            className="absolute inset-0 cursor-pointer opacity-0"
                            onChange={(e) => {
                                const from = e.target.value;
                                setAccent({from, to: lightenHex(from, 12)});
                            }}
                        />
                    </label>
                    {accent && (
                        <button
                            type="button"
                            className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                            onClick={() => setAccent(null)}
                        >
                            {t('settings.qs.resetAccent')}
                        </button>
                    )}
                </div>
            </section>

            <section>
                <SectionTitle title={t('settings.qs.glassColor')} desc={t('settings.qs.glassColorDesc')}/>
                <div className="flex items-center gap-2">
                    {GLASS_COLOR_PRESETS.map(p => (
                        <Swatch
                            key={p.id}
                            hex={p.hex}
                            active={glassColor?.toLowerCase() === p.hex.toLowerCase()}
                            title={t(`settings.qs.glass_${p.id}`)}
                            onClick={() => setGlassColor(p.hex)}
                        />
                    ))}
                    <label
                        className={cn(
                            'relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-border/60 shadow-sm transition-transform hover:scale-110',
                            glassColor && !GLASS_COLOR_PRESETS.some(p => p.hex.toLowerCase() === glassColor.toLowerCase())
                            && 'ring-2 ring-ring ring-offset-2 ring-offset-background'
                        )}
                        title={t('settings.qs.glassCustom')}
                        style={glassColor ? {background: glassColor} : {
                            background: 'conic-gradient(#ffffff,#9ca3af,#374151,#ffffff)'
                        }}
                    >
                        <input
                            type="color"
                            className="absolute inset-0 cursor-pointer opacity-0"
                            onChange={(e) => setGlassColor(e.target.value)}
                        />
                    </label>
                    {glassColor && (
                        <button
                            type="button"
                            className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                            onClick={() => setGlassColor(null)}
                        >
                            {t('settings.qs.followTheme')}
                        </button>
                    )}
                </div>
            </section>

            <section>
                <SectionTitle title={t('settings.qs.codeTheme')} desc={t('settings.qs.codeThemeDesc')}/>
                <div className="flex flex-wrap items-center gap-2">
                    {CODE_THEME_PRESETS.map(p => {
                        const active = codeTheme === p.id;
                        // auto（跟随主题）用主题 token 呈现，其余用预设自身的底色/前景色
                        return (
                            <button
                                key={p.id}
                                type="button"
                                title={t(`settings.qs.code_${p.id}`)}
                                onClick={() => setCodeTheme(p.id)}
                                className={cn(
                                    'flex h-9 w-16 items-center justify-center rounded-md border border-border/60 text-[11px] font-mono shadow-sm transition-transform hover:scale-105',
                                    !p.bg && 'bg-muted/60 text-muted-foreground',
                                    active && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
                                )}
                                style={p.bg ? {background: p.bg, color: p.fg} : undefined}
                            >
                                {'</>'}
                            </button>
                        );
                    })}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                    {t(`settings.qs.code_${codeTheme}`)}
                </p>
            </section>

            <section>
                <SectionTitle title={t('settings.appearance.theme')}/>
                <SegmentedControl
                    value={theme}
                    options={[
                        {value: 'light', label: t('settings.appearance.themeLight')},
                        {value: 'dark', label: t('settings.appearance.themeDark')},
                    ]}
                    onChange={setTheme}
                />
            </section>

            <section>
                <SectionTitle title={t('settings.appearance.opacity')} desc={t('settings.appearance.opacityHint')}/>
                <SliderRow
                    label={t('settings.appearance.opacityGlobal')}
                    min={0.3} max={1} step={0.05} value={opacity.global}
                    onChange={(v) => setOpacity({global: v})}
                    format={(v) => `${Math.round(v * 100)}%`}
                />
                <SliderRow
                    label={t('settings.appearance.opacitySidebar')}
                    min={0.3} max={1} step={0.05} value={opacity.sidebar}
                    onChange={(v) => setOpacity({sidebar: v})}
                    format={(v) => `${Math.round(v * 100)}%`}
                />
                <SliderRow
                    label={t('settings.appearance.opacityInput')}
                    min={0.3} max={1} step={0.05} value={opacity.input}
                    onChange={(v) => setOpacity({input: v})}
                    format={(v) => `${Math.round(v * 100)}%`}
                />
            </section>

            <section>
                <SectionTitle title={t('settings.qs.legacyBg')} desc={t('settings.qs.legacyBgDesc')}/>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                        onClick={() => bgFileRef.current?.click()}
                    >
                        <ImagePlus className="h-3.5 w-3.5"/>
                        {t('settings.qs.legacyBgUpload')}
                    </button>
                    <input
                        ref={bgFileRef}
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={(e) => {
                            handleBgFile(e.target.files?.[0]);
                            e.target.value = '';
                        }}
                    />
                    {bgImage && (
                        <button
                            type="button"
                            className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            onClick={() => setBgImage(null)}
                        >
                            <Trash2 className="h-3.5 w-3.5"/>
                            {t('settings.qs.legacyBgClear')}
                        </button>
                    )}
                </div>
            </section>

            <section>
                <SectionTitle title={t('settings.appearance.language')}/>
                <SegmentedControl
                    value={locale}
                    options={[
                        {value: 'zh', label: t('settings.appearance.langZh')},
                        {value: 'en', label: t('settings.appearance.langEn')},
                    ]}
                    onChange={handleLocaleChange}
                />
            </section>
        </div>
    );
}

/** 字体页签：字体族/字号 + 字体颜色/字重/光标（对齐 dsh-wallpaper-engine「字体」页签） */
export function FontTab() {
    const {t} = useTranslation();
    const fontFamilyZh = useAppStore(s => s.ui.fontFamilyZh);
    const fontFamilyEn = useAppStore(s => s.ui.fontFamilyEn);
    const fontSize = useAppStore(s => s.ui.fontSize);
    const setFontFamily = useAppStore(s => s.setFontFamily);
    const setFontSize = useAppStore(s => s.setFontSize);
    const fontColor = useAppStore(s => s.ui.fontColor);
    const setFontColor = useAppStore(s => s.setFontColor);

    // 当前字体栈命中内置选项时取该选项，否则视为自定义（下拉显示"自定义"）
    const zhMatch = ZH_FONT_OPTIONS.find(o => o.value === fontFamilyZh);
    const enMatch = EN_FONT_OPTIONS.find(o => o.value === fontFamilyEn);
    /** 各内置字体栈的本机可用性（挂载时检测一次） */
    const zhInstalled = useMemo(() => ZH_FONT_OPTIONS.map(o => isFontInstalled(firstQuotedFamily(o.value) ?? '')), []);
    const enInstalled = useMemo(() => EN_FONT_OPTIONS.map(o => isFontInstalled(firstQuotedFamily(o.value) ?? '')), []);

    return (
        <div className="space-y-4">
            <section>
                <SectionTitle title={t('settings.appearance.fontZh')}/>
                <select
                    value={zhMatch ? zhMatch.value : CUSTOM_FONT_VALUE}
                    onChange={(e) => {
                        if (e.target.value !== CUSTOM_FONT_VALUE) setFontFamily(e.target.value, fontFamilyEn);
                    }}
                    className={SELECT_CLASS}
                >
                    {ZH_FONT_OPTIONS.map((opt, i) => (
                        <option
                            key={opt.value}
                            value={opt.value}
                            disabled={!zhInstalled[i] && opt.labelKey !== 'settings.appearance.fontSystemDefault'}
                        >
                            {t(opt.labelKey)}{!zhInstalled[i] ? t('settings.appearance.fontNotInstalled') : ''}
                        </option>
                    ))}
                    <option value={CUSTOM_FONT_VALUE}>{t('settings.appearance.fontCustom')}</option>
                </select>
                {/* 自定义字体栈输入：始终显示（内置选中时为空占位，直接输入即切换自定义） */}
                <Input
                    className="mt-2"
                    value={zhMatch ? '' : fontFamilyZh}
                    placeholder={t('settings.appearance.fontCustomPlaceholder')}
                    onChange={(e) => {
                        if (e.target.value.trim()) setFontFamily(e.target.value, fontFamilyEn);
                    }}
                />
            </section>

            <section>
                <SectionTitle title={t('settings.appearance.fontEn')}/>
                <select
                    value={enMatch ? enMatch.value : CUSTOM_FONT_VALUE}
                    onChange={(e) => {
                        if (e.target.value !== CUSTOM_FONT_VALUE) setFontFamily(fontFamilyZh, e.target.value);
                    }}
                    className={SELECT_CLASS}
                >
                    {EN_FONT_OPTIONS.map((opt, i) => (
                        <option
                            key={opt.value}
                            value={opt.value}
                            disabled={!enInstalled[i] && opt.labelKey !== 'settings.appearance.fontSystemUi'}
                        >
                            {t(opt.labelKey)}{!enInstalled[i] ? t('settings.appearance.fontNotInstalled') : ''}
                        </option>
                    ))}
                    <option value={CUSTOM_FONT_VALUE}>{t('settings.appearance.fontCustom')}</option>
                </select>
                <Input
                    className="mt-2"
                    value={enMatch ? '' : fontFamilyEn}
                    placeholder={t('settings.appearance.fontCustomPlaceholder')}
                    onChange={(e) => {
                        if (e.target.value.trim()) setFontFamily(fontFamilyZh, e.target.value);
                    }}
                />
            </section>

            <SliderRow
                label={t('settings.appearance.fontSize')}
                min={12} max={18} step={1} value={fontSize}
                onChange={setFontSize}
                format={(v) => `${v}px`}
            />

            {/* 字体颜色 / 字重（总开关，关闭 = 一键恢复主题文字外观） */}
            <section className="rounded-xl border border-border/40 p-3">
                <Row label={t('settings.qs.fontCustom')} hint={t('settings.qs.fontCustomHint')}>
                    <Toggle
                        checked={fontColor.enabled}
                        onChange={(v) => setFontColor({enabled: v})}
                        label={t('settings.qs.fontCustom')}
                    />
                </Row>
                {fontColor.enabled && (
                    <>
                        <Row label={t('settings.qs.fontColor')} hint={t('settings.qs.fontColorHint')}>
                            <label
                                className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-border/60 shadow-sm"
                                title={t('settings.qs.fontColor')}
                                style={{background: fontColor.color}}
                            >
                                <input
                                    type="color"
                                    className="absolute inset-0 cursor-pointer opacity-0"
                                    value={fontColor.color}
                                    onChange={(e) => setFontColor({color: e.target.value})}
                                />
                            </label>
                        </Row>
                        <SliderRow
                            label={t('settings.qs.fontWeight')}
                            min={100} max={900} step={50} value={fontColor.weight}
                            onChange={(v) => setFontColor({weight: v})}
                            format={(v) => String(v)}
                        />
                        {/* 实时预览（内联着色）：取色器选中即所见 */}
                        <p
                            className="mt-1 rounded-lg bg-secondary/50 px-3 py-2 text-sm"
                            style={{color: fontColor.color, fontWeight: fontColor.weight}}
                        >
                            {t('settings.appearance.fontPreview')}
                        </p>
                    </>
                )}
            </section>

            {/* 输入光标颜色：独立于总开关（与壁纸/玻璃颜色相近看不清时单独调） */}
            <section className="rounded-xl border border-border/40 p-3">
                <Row label={t('settings.qs.caretColor')} hint={t('settings.qs.caretColorHint')}>
                    <div className="flex items-center gap-2">
                        {fontColor.caretColor && (
                            <button
                                type="button"
                                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                                onClick={() => setFontColor({caretColor: null})}
                            >
                                {t('settings.qs.caretAuto')}
                            </button>
                        )}
                        <label
                            className={cn(
                                'relative block h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-border/60 shadow-sm',
                                !fontColor.caretColor && 'opacity-50'
                            )}
                            title={t('settings.qs.caretColor')}
                            style={{background: fontColor.caretColor ?? 'conic-gradient(#ffffff,#111111,#ffffff)'}}
                        >
                            <input
                                type="color"
                                className="absolute inset-0 cursor-pointer opacity-0"
                                value={fontColor.caretColor ?? '#ffffff'}
                                onChange={(e) => setFontColor({caretColor: e.target.value})}
                            />
                        </label>
                    </div>
                </Row>
            </section>

            <button
                type="button"
                className="w-full rounded-lg border border-border/60 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => {
                    setFontFamily(DEFAULT_FONT_ZH, DEFAULT_FONT_EN);
                    setFontSize(DEFAULT_FONT_SIZE);
                }}
            >
                {t('settings.qs.resetFont')}
            </button>
        </div>
    );
}

/** 吉祥物页签：形态卡片 / 显示开关 / 大小 / 状态气泡（桌面端 = 独立悬浮窗，Web = 应用内右下角） */
export function MascotTab() {
    const {t} = useTranslation();
    const mascot = useAppStore(s => s.ui.mascot);
    const setMascot = useAppStore(s => s.setMascot);

    return (
        <div className="space-y-4">
            <section>
                <SectionTitle title={t('settings.mascot.form')} desc={t('settings.mascot.formDesc')}/>
                <div className="grid grid-cols-3 gap-2">
                    {PET_FORMS.map(form => (
                        <button
                            key={form.id}
                            type="button"
                            className={cn(
                                'flex flex-col items-center gap-1 rounded-xl border bg-secondary/30 px-2 py-3 transition-all',
                                mascot.form === form.id
                                    ? 'border-primary ring-2 ring-primary/30'
                                    : 'border-border/50 hover:border-primary/40'
                            )}
                            onClick={() => setMascot({form: form.id})}
                        >
                            <PetAvatar form={form.id} mood="idle" width={78}/>
                            <span className={cn(
                                'text-xs font-medium',
                                mascot.form === form.id ? 'text-primary' : 'text-muted-foreground'
                            )}>
                                {t(form.labelKey)}
                            </span>
                        </button>
                    ))}
                </div>
            </section>
            <div className="divide-y divide-border/40">
                <Row label={t('settings.mascot.show')} hint={t('settings.mascot.showHint')}>
                    <Toggle
                        checked={mascot.enabled}
                        onChange={(v) => setMascot({enabled: v})}
                        label={t('settings.mascot.show')}
                    />
                </Row>
                <Row label={t('settings.mascot.bubble')} hint={t('settings.mascot.bubbleHint')}>
                    <Toggle
                        checked={mascot.bubble}
                        onChange={(v) => setMascot({bubble: v})}
                        label={t('settings.mascot.bubble')}
                    />
                </Row>
                <Row label={t('settings.mascot.position')} hint={t('settings.mascot.positionHint')}>
                    <button
                        type="button"
                        disabled={!mascot.position}
                        onClick={() => setMascot({position: null})}
                        className="rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors
                            hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                    >
                        {t('settings.mascot.resetPosition')}
                    </button>
                </Row>
            </div>
            <SliderRow
                label={t('settings.mascot.size')}
                min={0.5} max={2.5} step={0.1} value={mascot.size}
                onChange={(v) => setMascot({size: v})}
                format={(v) => `${v.toFixed(1)}x`}
            />
            <p className="rounded-lg bg-secondary/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                {t('settings.mascot.desktopHint')}
            </p>
        </div>
    );
}
