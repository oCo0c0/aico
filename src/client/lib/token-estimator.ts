/**
 * @file token-estimator.ts
 * @description Token 使用量估算工具
 *
 * 提供简单快速的 token 估算功能，用于上下文窗口指示器
 */

/**
 * 估算文本的 token 数量
 *
 * 规则（基于 Claude tokenizer 特性）：
 * - 中文字符：约 1.5 tokens/字符
 * - 英文单词：约 0.25 tokens/单词（约 4 chars/token）
 * - 代码 token：约 0.3 tokens/token
 * - 标点/符号：约 0.5 tokens/个
 *
 * @param text - 要估算的文本
 * @returns 估算的 token 数量
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;

    let tokens = 0;
    const charCount = 0;
    const wordCount = 0;

    // 检测中文字符
    const chineseChars = text.match(/[一-龥]/g);
    const chineseCount = chineseChars?.length || 0;

    // 检测英文单词
    const englishWords = text.match(/[a-zA-Z]+/g);
    const englishCount = englishWords?.length || 0;

    // 检测代码关键字（简化）
    const codeKeywords = text.match(/\b(function|const|let|var|if|else|return|import|export|class|interface|type|async|await)\b/g);
    const codeCount = codeKeywords?.length || 0;

    // 计算
    tokens += chineseCount * 1.5;           // 中文
    tokens += englishCount * 0.25;         // 英文
    tokens += codeCount * 0.3;             // 代码
    tokens += (text.length - chineseCount - (englishCount * 5)) * 0.1; // 其他字符（平均）

    return Math.ceil(tokens);
}

/**
 * 计算上下文使用百分比
 *
 * @param usedTokens - 已使用的 token 数量
 * @param maxTokens - 最大 token 容量（默认 300K）
 * @returns 使用百分比（0-100，保留 1 位小数）
 */
export function calculateUsagePercentage(usedTokens: number, maxTokens: number = 300000): number {
    if (maxTokens <= 0) return 0;
    const pct = (usedTokens / maxTokens) * 100;
    return Math.min(100, Math.max(0, pct));
}

/**
 * 获取使用状态对应的颜色主题
 *
 * @param percentage - 使用百分比
 * @returns 颜色主题对象
 */
export function getUsageTheme(percentage: number) {
    if (percentage < 70) {
        return {
            color: 'text-emerald-500',
            bg: 'bg-emerald-500/10',
            border: 'border-emerald-500/20',
            status: 'safe'
        };
    } else if (percentage < 85) {
        return {
            color: 'text-yellow-500',
            bg: 'bg-yellow-500/10',
            border: 'border-yellow-500/20',
            status: 'warning'
        };
    } else {
        return {
            color: 'text-red-500',
            bg: 'bg-red-500/10',
            border: 'border-red-500/20',
            status: 'critical'
        };
    }
}

/**
 * 格式化 token 数量显示
 *
 * @param tokens - token 数量
 * @returns 格式化字符串（如 "420K" 或 "1.2M"）
 */
export function formatTokenCount(tokens: number): string {
    if (tokens >= 1000000) {
        return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(0)}K`;
    }
    return tokens.toString();
}
