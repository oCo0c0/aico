/**
 * 请求验证与错误处理中间件
 *
 * 提供 Express 请求体验证和全局错误处理功能：
 * - validateBody：基于字段规则校验请求体
 * - errorHandler：捕获未处理异常并返回标准错误响应
 */

import {Request, Response, NextFunction} from 'express';
import path from 'path';

/** 禁止出现在可执行命令/参数中的 shell 元字符 */
const SHELL_METACHARACTERS = /[;|&$()<>`"']/;

/**
 * 校验字符串是否不含 shell 元字符，防止通过命令字符串拼接触发命令注入。
 * 允许空格、引号外的普通字符（引号在完整命令解析中可能合法，但这里由调用方自行处理）。
 *
 * @param value - 待校验字符串
 * @param fieldName - 字段名，用于错误信息
 */
export function validateShellSafeInput(value: unknown, fieldName: string): string {
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }
    if (SHELL_METACHARACTERS.test(value)) {
        throw new Error(`${fieldName} contains invalid shell characters`);
    }
    return value;
}

export interface APIError {
    /** 错误码（如 VALIDATION_ERROR、INTERNAL_ERROR） */
    code: string;
    /** 错误描述信息 */
    message: string;
    /** 错误详情（可选） */
    details?: unknown;
    /** 修复建议（可选） */
    suggestion?: string;
}

/**
 * 带 HTTP 状态码的错误：服务层抛出后由全局 errorHandler 转换为对应状态响应
 * （默认仍回 500；输入不合法类错误应抛 400，避免把用户错误当服务器故障）
 */
export class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = 'HttpError';
    }
}

/** 字段验证规则 */
export interface FieldRule {
    /** 字段名（对应 req.body 中的键） */
    field: string;
    /** 是否必填 */
    required?: boolean;
    /** 期望的类型 */
    type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
}

/**
 * 请求体验证中间件工厂
 *
 * 根据字段规则数组创建验证中间件。遍历所有规则检查：
 * - 必填字段是否存在（非 undefined/null/空字符串）
 * - 字段类型是否匹配（支持 array 类型检测）
 *
 * 验证失败返回 400 状态码和错误详情数组。
 *
 * @param rules - 字段验证规则数组
 * @returns Express 中间件函数
 *
 * @example
 * app.post('/api/items', validateBody([
 *   { field: 'name', required: true, type: 'string' },
 *   { field: 'count', type: 'number' }
 * ]), handler);
 */
export function validateBody(rules: FieldRule[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const errors: string[] = [];

        for (const rule of rules) {
            const value = req.body?.[rule.field];

            if (rule.required && (value === undefined || value === null || value === '')) {
                errors.push(`Field "${rule.field}" is required`);
                continue;
            }

            if (value !== undefined && value !== null && rule.type) {
                const actualType = Array.isArray(value) ? 'array' : typeof value;
                if (actualType !== rule.type) {
                    errors.push(`Field "${rule.field}" must be of type ${rule.type}, got ${actualType}`);
                }
            }
        }

        if (errors.length > 0) {
            const apiError: APIError = {
                code: 'VALIDATION_ERROR',
                message: 'Request validation failed',
                details: errors,
            };
            res.status(400).json(apiError);
            return;
        }

        next();
    };
}

/**
 * 全局错误处理中间件
 *
 * 捕获路由处理中未捕获的异常，返回标准化的 500 错误响应。
 * 必须注册在所有路由之后。
 *
 * @param err - 捕获的错误对象
 * @param _req - Express 请求对象（未使用）
 * @param res - Express 响应对象
 * @param _next - 下一个中间件函数（未使用，Express 签名要求）
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
    // HttpError：调用方主动抛出的预期错误（输入不合法等），按携带的状态码返回
    if (err instanceof HttpError) {
        res.status(err.status).json({
            code: err.status === 400 ? 'VALIDATION_ERROR' : 'REQUEST_ERROR',
            message: err.message,
        } satisfies APIError);
        return;
    }
    // 非预期错误：记录完整错误便于排查，只把消息回给客户端（避免堆栈外泄）
    console.error('[error]', err);
    const apiError: APIError = {
        code: 'INTERNAL_ERROR',
        message: err.message || 'An unexpected error occurred',
    };
    res.status(500).json(apiError);
}

/**
 * 清理路径中的非法组件：移除路径分隔符和路径遍历片段。
 * 用于文件名、需求 ID 等不可信片段，避免其跳出目录。
 *
 * @param name - 待清理的原始名称
 * @returns 清理后的名称
 */
export function sanitizePathComponent(name: string): string {
    return name
        .replace(/[\\/]/g, '-')
        .replace(/\.{2,}/g, '')
        .replace(/^[.]+/, '');
}

/**
 * 判断目标路径是否落在任意一个允许根目录内。
 * 用于限制文件浏览、写入等操作只能发生在白名单目录。
 *
 * @param target - 待校验的目标路径
 * @param roots - 允许的根目录列表
 * @returns 是否落在允许范围内
 */
export function isPathWithinRoots(target: string, roots: string[]): boolean {
    const resolvedTarget = path.resolve(target);
    return roots.some(root => {
        const resolvedRoot = path.resolve(root);
        if (resolvedTarget === resolvedRoot) return true;
        return resolvedTarget.startsWith(resolvedRoot + path.sep);
    });
}

/**
 * workspace 路径安全校验
 *
 * 防止路径遍历攻击，确保路径不是绝对路径或包含 .. 跳转。
 * 若提供 allowedRoots，还会校验路径是否落在白名单目录内。
 * Daytona 沙箱模式下，路径会在沙箱内解析，此处仅做基本格式校验。
 *
 * @param workspacePath - 待校验的工作区路径
 * @param allowedRoots - 可选的允许根目录白名单
 * @returns 校验结果，valid 为 true 时 path 为规范化后的路径
 */
export function validateWorkspacePath(
    workspacePath: string,
    allowedRoots?: string[]
): { valid: boolean; path?: string; error?: string } {
    if (!workspacePath) {
        return {valid: false, error: 'workspacePath is required'};
    }

    const trimmed = workspacePath.trim();

    // 防止路径遍历
    if (trimmed.includes('..')) {
        return {valid: false, error: 'workspacePath must not contain path traversal (..)'};
    }

    // 规范化路径
    let resolved: string;
    try {
        resolved = path.resolve(trimmed);
    } catch {
        return {valid: false, error: 'workspacePath is not a valid path'};
    }

    if (allowedRoots && allowedRoots.length > 0 && !isPathWithinRoots(resolved, allowedRoots)) {
        return {valid: false, error: 'workspacePath is outside allowed directories'};
    }

    return {valid: true, path: resolved};
}

/**
 * 校验输出文件路径是否允许写入。
 * 要求路径必须落在白名单根目录内，且不能是目录、不能包含路径遍历。
 *
 * @param outputPath - 请求传入的输出路径
 * @param allowedRoots - 允许写入的根目录（如 homedir、workspacePath）
 * @returns 校验结果，valid 为 true 时 path 为规范化后的路径
 */
export function validateOutputPath(
    outputPath: string,
    allowedRoots: string[]
): { valid: boolean; path?: string; error?: string } {
    if (!outputPath) {
        return {valid: false, error: 'outputPath is required'};
    }

    const trimmed = outputPath.trim();
    if (trimmed.includes('..')) {
        return {valid: false, error: 'outputPath must not contain path traversal (..)'};
    }

    let resolved: string;
    try {
        resolved = path.resolve(trimmed);
    } catch {
        return {valid: false, error: 'outputPath is not a valid path'};
    }

    if (!isPathWithinRoots(resolved, allowedRoots)) {
        return {valid: false, error: 'outputPath is outside allowed directories'};
    }

    return {valid: true, path: resolved};
}
