/**
 * @file appearance.ts
 * @description 外观引擎 —— 配色（accent）/ 玻璃底色（glassColor）/ 字体颜色的主题感知注入
 *
 * ⚠️ 实现要点（v2，修复「明暗切换失效」回归）：
 * 早期版本用 <html> 内联样式覆盖 CSS 变量 —— 内联优先级高于一切选择器，
 * 会把 :root（浅色）与 .dark（深色）两套主题值同时压死，导致切换主题时
 * 文字/主色/玻璃底色不再跟随。现改为注入一张主题感知样式表
 *（<style id="adw-appearance-patch">）：每个特性一段规则，:root 写浅色档、
 * .dark 写自动派生的深色档（文字/主色提亮、玻璃底色压暗），明暗切换完整保留。
 */

/** 品牌配色对（from→to 渐变两端，hex） */
export interface AccentPair {
    from: string;
    to: string;
}

/** 内置配色预设（6 种，参考插件「6 预设 + 自定义取色」） */
export const ACCENT_PRESETS: Array<{id: string; from: string; to: string}> = [
    {id: 'classic', from: '#ed4545', to: '#f8788d'},   // 经典红（应用默认）
    {id: 'ocean', from: '#3b82f6', to: '#60a5fa'},     // 冰蓝
    {id: 'midnight', from: '#0ea5e9', to: '#38bdf8'},  // 深海蓝
    {id: 'violet', from: '#8b5cf6', to: '#a78bfa'},    // 紫罗兰
    {id: 'emerald', from: '#10b981', to: '#34d399'},   // 翠绿
    {id: 'sunset', from: '#f97316', to: '#fb923c'},    // 暖橙
];

/** 内置玻璃底色预设（6 种；null = 跟随主题） */
export const GLASS_COLOR_PRESETS: Array<{id: string; hex: string}> = [
    {id: 'white', hex: '#ffffff'},
    {id: 'nightblue', hex: '#1e2735'},
    {id: 'warmgray', hex: '#f5f2ee'},
    {id: 'mint', hex: '#eef7f2'},
    {id: 'sakura', hex: '#fdf1f5'},
    {id: 'graphite', hex: '#2a2a2e'},
];

/**
 * 代码块配色预设。
 * - auto：跟随主题（由 index.css 的 --code-* 默认值给出，浅/深各一档），不注入补丁段
 * - 其余为固定配色（代码区域自带底色，明暗主题下都保持所选观感，如 VS Code 的做法）
 */
export interface CodeThemePreset {
    id: string;
    label: string;
    /** 代码区底色（hex；auto 为 null） */
    bg: string | null;
    /** 正文前景色（hex） */
    fg: string;
    /** 行号/注释等次要文字（hex） */
    muted: string;
    /** 边框色（hex） */
    border: string;
}

export const CODE_THEME_PRESETS: CodeThemePreset[] = [
    {id: 'auto', label: '跟随主题', bg: null, fg: '', muted: '', border: ''},
    {id: 'github-dark', label: 'GitHub 深色', bg: '#0d1117', fg: '#c9d1d9', muted: '#8b949e', border: '#30363d'},
    {id: 'one-dark', label: 'One Dark', bg: '#282c34', fg: '#abb2bf', muted: '#7f848e', border: '#3e4451'},
    {id: 'nord', label: 'Nord', bg: '#2e3440', fg: '#d8dee9', muted: '#7b88a1', border: '#434c5e'},
    {id: 'github-light', label: 'GitHub 浅色', bg: '#f6f8fa', fg: '#24292f', muted: '#6e7781', border: '#d0d7de'},
    {id: 'high-contrast', label: '高对比', bg: '#000000', fg: '#f5f5f5', muted: '#a3a3a3', border: '#404040'},
];

/** 代码配色 id → 预设（未知 id 归为跟随主题） */
export function codeThemePreset(id: string | null | undefined): CodeThemePreset {
    return CODE_THEME_PRESETS.find(p => p.id === id) ?? CODE_THEME_PRESETS[0];
}

/** hex (#rgb/#rrggbb) → HSL（h: 0-360, s/l: 0-100） */
export function hexToHsl(hex: string): {h: number; s: number; l: number} {
    let cleaned = hex.replace(/^#/, '').trim();
    if (cleaned.length === 3) {
        cleaned = cleaned.split('').map((c) => c + c).join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return {h: 0, s: 82, l: 60};
    const r = parseInt(cleaned.slice(0, 2), 16) / 255;
    const g = parseInt(cleaned.slice(2, 4), 16) / 255;
    const b = parseInt(cleaned.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return {h: 0, s: 0, l: Math.round(l * 100)};
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return {
        h: Math.round(h * 60),
        s: Math.round(s * 100),
        l: Math.round(l * 100),
    };
}

/** HSL 三元组 → Tailwind token 字符串（"H S% L%"） */
function triplet(hex: string): string {
    const {h, s, l} = hexToHsl(hex);
    return `${h} ${s}% ${l}%`;
}

/** 深色主题变体：同色相，压暗降饱和（玻璃底色用） */
function darkVariant(hex: string, l = 16, satScale = 0.6): string {
    const {h, s} = hexToHsl(hex);
    return `${h} ${Math.round(s * satScale)}% ${l}%`;
}

/** 提亮 hex 颜色（l + amount，0-100 夹取）→ hex，用于从自定义主色派生渐变亮端 */
export function lightenHex(hex: string, amount: number): string {
    const {h, s, l} = hexToHsl(hex);
    const nl = Math.min(100, l + amount);
    const sn = s / 100;
    const ln = nl / 100;
    const c = (1 - Math.abs(2 * ln - 1)) * sn;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = ln - c / 2;
    let r: number, g: number, b: number; // if/else-if 链含收尾 else，所有路径必有赋值
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const to255 = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${to255(r)}${to255(g)}${to255(b)}`;
}

// ── 主题感知样式表注入引擎 ─────────────────────────────────────────────────

const PATCH_STYLE_ID = 'adw-appearance-patch';
/** 各特性自己的规则段（accent / glass / text / code），重建样式表时按序拼接 */
const patchSegments: Partial<Record<'accent' | 'glass' | 'text' | 'code', string>> = {};

function flushPatchStyle(): void {
    if (typeof document === 'undefined') return;
    const css = Object.values(patchSegments).filter(Boolean).join('\n');
    let el = document.getElementById(PATCH_STYLE_ID) as HTMLStyleElement | null;
    if (!css) {
        el?.remove();
        return;
    }
    if (!el) {
        el = document.createElement('style');
        el.id = PATCH_STYLE_ID;
        document.head.appendChild(el);
    }
    el.textContent = css;
}

/**
 * 应用配色（主题感知）：:root 浅色档 + .dark 深色档（主色/渐变提亮一档，
 * 光晕 alpha 恢复浅深各自的设计值）。pair = null 清除段，恢复样式表主题默认。
 * 所有变量声明带 !important：对加载顺序/HMR 插入的样式表时序免疫。
 */
export function applyAccent(pair: AccentPair | null): void {
    if (typeof document === 'undefined') return;
    if (!pair) {
        delete patchSegments.accent;
        flushPatchStyle();
        return;
    }
    const fromL = triplet(pair.from);
    const toL = triplet(pair.to);
    const fromD = triplet(lightenHex(pair.from, 12));
    const toD = triplet(lightenHex(pair.to, 8));
    patchSegments.accent = [
        `:root{--brand-from:${fromL} !important;--brand-to:${toL} !important;--primary:${fromL} !important;--ring:${fromL} !important;` +
        `--bg-glow-1:${fromL}/0.20 !important;--bg-glow-2:${toL}/0.15 !important;--bg-glow-3:${fromL}/0.14 !important}`,
        `.dark{--brand-from:${fromD} !important;--brand-to:${toD} !important;--primary:${fromD} !important;--ring:${fromD} !important;` +
        `--bg-glow-1:${fromD}/0.32 !important;--bg-glow-2:${toD}/0.26 !important;--bg-glow-3:${fromD}/0.18 !important}`,
    ].join('\n');
    flushPatchStyle();
}

/**
 * 应用玻璃底色（主题感知）：浅色用所选色，深色自动派生同色相压暗档，
 * 深色模式玻璃不再被浅色底色糊成一片。hex = null 清除段恢复「跟随主题」。
 */
export function applyGlassColor(hex: string | null): void {
    if (typeof document === 'undefined') return;
    if (!hex) {
        delete patchSegments.glass;
        flushPatchStyle();
        return;
    }
    const light = triplet(hex);
    const dark = darkVariant(hex, 16, 0.6);
    const vars = ['--glass-bar-bg', '--glass-card-bg', '--glass-panel-bg'];
    const set = (v: string) => vars.map(name => `${name}:${v} !important`).join(';');
    patchSegments.glass = `:root{${set(light)}}.dark{${set(dark)}}`;
    flushPatchStyle();
}

/**
 * 应用字体颜色（主题感知）：同时着色主文字（--foreground）与次级文字
 * （--muted-foreground，应用内大量说明文字用这个 token，只改主文字几乎看不出），
 * 深色主题自动提亮一档保证可读。hex = null 清除段恢复主题默认。
 */
export function applyFontColorPatch(hex: string | null): void {
    if (typeof document === 'undefined') return;
    if (!hex) {
        delete patchSegments.text;
        flushPatchStyle();
        return;
    }
    const {h, s} = hexToHsl(hex);
    const light = triplet(hex);
    const lightMuted = `${h} ${Math.round(s * 0.55)}% 42%`;
    const dark = triplet(lightenHex(hex, 35));
    const darkMuted = `${h} ${Math.round(s * 0.35)}% 68%`;
    patchSegments.text = [
        `:root{--foreground:${light} !important;--muted-foreground:${lightMuted} !important}`,
        `.dark{--foreground:${dark} !important;--muted-foreground:${darkMuted} !important}`,
    ].join('\n');
    flushPatchStyle();
}

/**
 * 应用代码块配色（代码区/差异视图/终端输出的底色与文字）。
 *
 * - 'auto' / null：清除补丁段，回落到 index.css 里 --code-* 的主题默认值（跟随主题）；
 * - 其余预设为固定配色（hex → HSL 三元组），浅深主题下都用所选观感。
 *
 * 相关变量：--code-bg（底色）/ --code-fg（正文）/ --code-muted（行号·注释）/
 * --code-border（分隔线）；终端卡与差异行另有 --code-add-xxx 与 --code-del-xxx 由预设派生。
 */
export function applyCodeTheme(id: string | null): void {
    if (typeof document === 'undefined') return;
    const preset = CODE_THEME_PRESETS.find(p => p.id === id);
    if (!preset || preset.bg === null) {
        delete patchSegments.code;
        flushPatchStyle();
        return;
    }
    const bg = triplet(preset.bg);
    const fg = triplet(preset.fg);
    const muted = triplet(preset.muted);
    const border = triplet(preset.border);
    // 差异行底色/文字：以底色为基准轻微着色，保证在任何预设下都可读
    const {h: addH, s: addS} = hexToHsl('#10b981');
    const {h: delH, s: delS} = hexToHsl('#ef4444');
    const addBg = `${addH} ${Math.round(addS * 0.35)}% ${Math.max(14, hexToHsl(preset.bg).l + 6)}%`;
    const delBg = `${delH} ${Math.round(delS * 0.35)}% ${Math.max(14, hexToHsl(preset.bg).l + 6)}%`;
    const addFg = `${addH} ${Math.round(addS * 0.7)}% ${Math.min(88, hexToHsl(preset.fg).l + 8)}%`;
    const delFg = `${delH} ${Math.round(delS * 0.7)}% ${Math.min(88, hexToHsl(preset.fg).l + 8)}%`;
    const vars = `--code-bg:${bg} !important;--code-fg:${fg} !important;--code-muted:${muted} !important;` +
        `--code-border:${border} !important;--code-add-bg:${addBg} !important;--code-add-fg:${addFg} !important;` +
        `--code-del-bg:${delBg} !important;--code-del-fg:${delFg} !important`;
    // 固定配色：浅深主题同值（所选代码主题不随界面明暗变化）
    patchSegments.code = `:root{${vars}}\n.dark{${vars}}`;
    flushPatchStyle();
}
