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
/**
 * 从文本中提取任意 JSON 值（对象 / 数组 / 标量）。
 * 优先 ```json fenced block，再尝试括号配平扫描。
 * @returns 解析出的值；全部失败返回 undefined
 */
export declare function extractJsonValue(raw: string): unknown | undefined;
/** 提取 JSON 对象；不是对象返回 undefined */
export declare function extractJsonObject(raw: string): Record<string, unknown> | undefined;
/** 提取 JSON 数组；不是数组返回 undefined */
export declare function extractJsonArray(raw: string): unknown[] | undefined;
/**
 * 解析 markdown front-matter（`---\nkey: value\n---` 开头）。
 * @returns key → value 映射；无 front-matter 返回空对象
 */
export declare function parseFrontMatter(content: string): Record<string, string>;
/**
 * 扫描字符串外每个 `{` / `[` 起点，逐个尝试配平+parse，返回全部成功候选（按出现顺序）。
 * 成功消费的 span 整体跳过（嵌套对象不重复产出）；失败 span 的内部起点仍会逐个尝试。
 */
export declare function extractJsonCandidates(raw: string): Array<{
    value: unknown;
    index: number;
}>;
/**
 * 按评分挑选最佳 JSON 对象候选；同分取更靠后（最终答案通常在结尾）。
 * 评分函数抛错视为该候选 0 分。无候选返回 undefined。
 */
export declare function extractBestJsonObject(raw: string, score: (obj: Record<string, unknown>) => number): {
    value: Record<string, unknown>;
    index: number;
} | undefined;
/** 挑选最佳 JSON 数组候选（元素多者优先；同分取更靠后）。无候选返回 undefined。 */
export declare function extractBestJsonArray(raw: string): {
    value: unknown[];
    index: number;
} | undefined;
//# sourceMappingURL=structured-json.d.ts.map