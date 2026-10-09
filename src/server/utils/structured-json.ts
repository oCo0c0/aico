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

function parseBalanced(raw: string): unknown | undefined {
    const start = raw.search(/[\[{]/);
    if (start < 0) return undefined;
    const span = balancedSpanAt(raw, start);
    return span?.value;
}

/**
 * 从指定起点做括号配平截取并 JSON.parse（跳过字符串内的括号）。
 * @returns 解析值 + 结束索引（end = 闭合括号位置）；任一失败返回 undefined
 */
function balancedSpanAt(raw: string, start: number): { value: unknown; end: number } | undefined {
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
            } else if (ch === '\\') {
                escape = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === openChar) depth++;
        else if (ch === closeChar) {
            depth--;
            if (depth === 0) {
                const candidate = raw.slice(start, i + 1);
                const value = tryParseJson(candidate);
                return value === undefined ? undefined : {value, end: i};
            }
        }
    }
    return undefined;
}

/** JSON.parse 宽容版：失败时先剥掉字符串值之间的尾逗号再试一次 */
function tryParseJson(text: string): unknown | undefined {
    try {
        return JSON.parse(text);
    } catch {
        // 继续尝试
    }
    try {
        return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
        return undefined;
    }
}

/**
 * 扫描文本中所有可解析的顶层 JSON 对象候选：每个不在字符串内的 `{` 起点做括号配平 + JSON.parse。
 *
 * 为什么不用单候选：LLM 输出常是「思考/叙述 + JSON」，前置文本里可能有杂 `{`
 * （如示例、伪代码），单候选首个 `{` 会被截胡得到垃圾片段；这里穷举全部候选交给调用方评分。
 * 已成功解析的对象内部不再回扫（跳到闭合括号之后），避免嵌套重复候选。
 */
export function extractJsonObjectCandidates(raw: string): Array<Record<string, unknown>> {
    const objects: Array<Record<string, unknown>> = [];
    if (!raw) return objects;

    let inString = false;
    let escape = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (inString) {
            if (escape) {
                escape = false;
            } else if (ch === '\\') {
                escape = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') {
            const span = balancedSpanAt(raw, i);
            if (span && span.value && typeof span.value === 'object' && !Array.isArray(span.value)) {
                objects.push(span.value as Record<string, unknown>);
                i = span.end; // 跳过已消费对象（嵌套 `{` 不重复作为候选）
            }
        }
    }
    return objects;
}

/**
 * 在全部 JSON 对象候选中按评分取最优；同分取更靠后的候选
 * （LLM 的最终答案通常在输出末尾，前面的多为思考中的示例）。
 * @param raw 任意文本输出
 * @param score 可选评分函数；缺省时取最后一个可解析对象
 */
export function extractBestJsonObject(
    raw: string,
    score?: (obj: Record<string, unknown>) => number,
): Record<string, unknown> | undefined {
    const candidates = extractJsonObjectCandidates(raw);
    if (candidates.length === 0) return undefined;

    let best: Record<string, unknown> | undefined;
    let bestScore = -Infinity;
    for (const obj of candidates) {
        const s = score ? score(obj) : 0;
        if (s >= bestScore) {
            bestScore = s;
            best = obj;
        }
    }
    return best;
}

/**
 * 从文本中提取任意 JSON 值（对象 / 数组 / 标量）。
 * 优先 ```json fenced block，再尝试括号配平扫描。
 * @returns 解析出的值；全部失败返回 undefined
 */
export function extractJsonValue(raw: string): unknown | undefined {
    if (!raw) return undefined;

    // 1. fenced block：```json ... ```
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
        try {
            return JSON.parse(fence[1].trim());
        } catch {
            // 落到括号扫描
        }
    }

    // 2. 括号配平扫描（首个 { 或 [）
    return parseBalanced(raw);
}

/** 提取 JSON 对象；不是对象返回 undefined */
export function extractJsonObject(raw: string): Record<string, unknown> | undefined {
    const value = extractJsonValue(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** 提取 JSON 数组；不是数组返回 undefined */
export function extractJsonArray(raw: string): unknown[] | undefined {
    const value = extractJsonValue(raw);
    return Array.isArray(value) ? (value as unknown[]) : undefined;
}

/**
 * 解析 markdown front-matter（`---\nkey: value\n---` 开头）。
 * @returns key → value 映射；无 front-matter 返回空对象
 */
export function parseFrontMatter(content: string): Record<string, string> {
    const result: Record<string, string> = {};

    const match = content.match(/^﻿?---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (!match) return result;

    for (const line of match[1].split('\n')) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (key) result[key] = value;
    }
    return result;
}
