/**
 * @module fs-utils
 * @description 文件系统原子写工具
 */
import fs from 'fs';
import path from 'path';

/** rename 瞬时错误码：Windows 杀软/索引服务刚落盘即锁文件时的 EPERM/EBUSY */
const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 4;
const RENAME_BASE_DELAY_MS = 30;

/**
 * 原子写文件：先写同目录临时文件再 rename 覆盖。
 *
 * 直接 writeFileSync 目标文件时，写一半进程崩溃/被并发读会留下截断的 JSON
 *（「Unexpected end of JSON input」）。tmp + rename 让读者要么看到旧内容、
 * 要么看到完整新内容，不存在中间态。
 *
 * rename 对 Windows 上的瞬时文件锁做有限次指数退避重试（30/60/120ms）。
 *
 * @param filePath - 目标文件路径
 * @param content - 写入内容（utf-8）
 */
export function writeFileAtomic(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
        try {
            fs.renameSync(tmpPath, filePath);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            const retryable = typeof code === 'string' && RETRYABLE_RENAME_ERRORS.has(code);
            if (!retryable || attempt === RENAME_MAX_ATTEMPTS) {
                // 清理残留 tmp，避免垃圾文件累积；重试耗尽的原始错误继续抛
                try {
                    fs.rmSync(tmpPath, {force: true});
                } catch { /* ignore */ }
                throw err;
            }
            const delay = RENAME_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        }
    }
}
