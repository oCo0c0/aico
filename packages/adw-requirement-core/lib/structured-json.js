/**
 * @module structured-json
 * @description 从 LLM 自由文本输出中稳健提取 JSON（纯函数，无副作用）。
 *
 * 替代旧的贪婪正则（如 /\[[\s\S]*\]/）：对「叙述文字 + JSON + 后续解释」的输出鲁棒，
 * 配平括号避免吞掉上下文。优先级：
 *   1. ```json fenced block
 *   2. 首个 { / [ 起，括号配平截取（跳过字符串内的括号）
 *   3. 全部失败 → undefined
 */
function parseBalanced(raw) {
    const start = raw.search(/[\[{]/);
    if (start < 0)
        return undefined;
    const openChar = raw[start];
    const closeChar = openChar === '[' ? ']' : '}';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (inString) {
            if (escape) {
                escape = false;
            }
            else if (ch === '\\') {
                escape = true;
            }
            else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === openChar)
            depth++;
        else if (ch === closeChar) {
            depth--;
            if (depth === 0) {
                const candidate = raw.slice(start, i + 1);
                try {
                    return JSON.parse(candidate);
                }
                catch {
                    return undefined;
                }
            }
        }
    }
    return undefined;
}
/**
 * 从文本中提取任意 JSON 值（对象 / 数组 / 标量）。
 * 优先 ```json fenced block，再尝试括号配平扫描。
 * @returns 解析出的值；全部失败返回 undefined
 */
export function extractJsonValue(raw) {
    if (typeof raw !== 'string' || !raw)
        return undefined;
    // 1. fenced block：```json ... ```
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
        try {
            return JSON.parse(fence[1].trim());
        }
        catch {
            // 落到括号扫描
        }
    }
    // 2. 括号配平扫描（首个 { 或 [）
    return parseBalanced(raw);
}
/** 提取 JSON 对象；不是对象返回 undefined */
export function extractJsonObject(raw) {
    const value = extractJsonValue(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
/** 提取 JSON 数组；不是数组返回 undefined */
export function extractJsonArray(raw) {
    const value = extractJsonValue(raw);
    return Array.isArray(value) ? value : undefined;
}
/**
 * 解析 markdown front-matter（`---\nkey: value\n---` 开头）。
 * @returns key → value 映射；无 front-matter 返回空对象
 */
export function parseFrontMatter(content) {
    const result = {};
    if (typeof content !== 'string')
        return result;
    const match = content.match(/^﻿?---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (!match)
        return result;
    for (const line of match[1].split('\n')) {
        const idx = line.indexOf(':');
        if (idx <= 0)
            continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (key)
            result[key] = value;
    }
    return result;
}
// ─── 多候选提取（引擎输出被思考/叙述污染时的鲁棒解析） ────────────────────
// 单候选提取的缺陷：thinking/叙述文本里的杂 `{`（如 {"step": 1}、{"error": "草稿"}）
// 会截取到垃圾片段导致解析失败或解析出错误对象。多候选方案：扫描全部起点 →
// 配平+parse → 按业务评分挑最优；同分取更靠后（最终答案通常在结尾）。
/** JSON.parse 失败时剥掉尾部逗号（`,}` / `,]`）再试一次 */
function tryParseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        try {
            return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
        }
        catch {
            return undefined;
        }
    }
}
/** 从 from 起做括号配平，返回平衡片段；未配平返回 undefined（字符串内的括号/引号跳过） */
function balancedSpanAt(raw, from) {
    const open = raw[from];
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = from; i < raw.length; i++) {
        const ch = raw[i];
        if (inString) {
            if (escape)
                escape = false;
            else if (ch === '\\')
                escape = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === open)
            depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0)
                return raw.slice(from, i + 1);
        }
    }
    return undefined;
}
/**
 * 扫描字符串外每个 `{` / `[` 起点，逐个尝试配平+parse，返回全部成功候选（按出现顺序）。
 * 成功消费的 span 整体跳过（嵌套对象不重复产出）；失败 span 的内部起点仍会逐个尝试。
 */
export function extractJsonCandidates(raw) {
    const candidates = [];
    if (typeof raw !== 'string' || !raw)
        return candidates;
    let inString = false;
    let escape = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (inString) {
            if (escape)
                escape = false;
            else if (ch === '\\')
                escape = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch !== '{' && ch !== '[')
            continue;
        const span = balancedSpanAt(raw, i);
        if (!span)
            continue;
        const value = tryParseJson(span);
        if (value !== undefined) {
            candidates.push({ value, index: i });
            i += span.length - 1;
        }
    }
    return candidates;
}
/**
 * 按评分挑选最佳 JSON 对象候选；同分取更靠后（最终答案通常在结尾）。
 * 评分函数抛错视为该候选 0 分。无候选返回 undefined。
 */
export function extractBestJsonObject(raw, score) {
    let best;
    for (const c of extractJsonCandidates(raw)) {
        if (!c.value || typeof c.value !== 'object' || Array.isArray(c.value))
            continue;
        const obj = c.value;
        let s = 0;
        try {
            s = score(obj);
        }
        catch {
            s = 0;
        }
        if (!best || s >= best.score)
            best = { value: obj, index: c.index, score: s };
    }
    return best ? { value: best.value, index: best.index } : undefined;
}
/** 挑选最佳 JSON 数组候选（元素多者优先；同分取更靠后）。无候选返回 undefined。 */
export function extractBestJsonArray(raw) {
    let best;
    for (const c of extractJsonCandidates(raw)) {
        if (!Array.isArray(c.value))
            continue;
        const s = c.value.length;
        if (!best || s >= best.score)
            best = { value: c.value, index: c.index, score: s };
    }
    return best ? { value: best.value, index: best.index } : undefined;
}
//# sourceMappingURL=structured-json.js.map