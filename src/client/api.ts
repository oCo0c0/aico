/**
 * @file API 请求封装模块
 * @description 封装与后端 REST API 通信的通用 HTTP 请求函数。
 *              所有请求均以 `/api` 为基础路径，提供 GET / POST / PUT / DELETE
 *              四种标准方法的类型安全封装，并统一处理错误响应：
 *              非 2xx 一律抛 `ApiError`（携带状态码与后端响应体，响应体非 JSON
 *              时 body 为空对象，不吞真实 HTTP 状态）。四个方法均支持可选的
 *              AbortSignal（组件卸载/竞态场景中止请求）。
 *              此外还包含一个调用系统原生文件夹选择对话框的特殊接口。
 */

/** 后端 API 基础路径前缀 */
const API_BASE = '/api';

/** HTTP 错误，携带状态码 + 后端响应体 */
export class ApiError extends Error {
    status: number;
    body: Record<string, unknown>;

    constructor(status: number, body: Record<string, unknown>) {
        super((body.message as string) || `HTTP ${status}`);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
}

/** 读取错误响应体：非 JSON（如代理返回的 HTML 错误页）时回退空对象 */
async function readErrorBody(res: Response): Promise<Record<string, unknown>> {
    try {
        const body = await res.json();
        return body && typeof body === 'object' ? body as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

/** fetch 附加选项（各方法通用） */
export interface ApiOptions {
    /** 中止信号（组件卸载/超时/竞态控制） */
    signal?: AbortSignal;
}

/** 组合 query init 与本次请求的 signal */
function mergeInit(init: RequestInit, options?: ApiOptions): RequestInit {
    return options?.signal ? {...init, signal: options.signal} : init;
}

/**
 * 发送 GET 请求
 * @template T - 响应数据的类型
 * @param path - 请求路径（相对于 API_BASE）
 * @param options - 可选的 AbortSignal 等附加选项
 * @returns 解析后的 JSON 响应数据
 * @throws 当 HTTP 状态码非 2xx 时抛出 ApiError
 */
export async function apiGet<T>(path: string, options?: ApiOptions): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, mergeInit({}, options));
    if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
    return res.json();
}

/**
 * 发送 POST 请求
 * @template T - 响应数据的类型
 * @param path - 请求路径（相对于 API_BASE）
 * @param body - 可选的请求体数据，为 undefined 时不发送 body
 * @param options - 可选的 AbortSignal 等附加选项
 * @returns 解析后的 JSON 响应数据
 * @throws 当 HTTP 状态码非 2xx 时抛出 ApiError
 */
export async function apiPost<T>(path: string, body?: unknown, options?: ApiOptions): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, mergeInit({
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: body ? JSON.stringify(body) : undefined,
    }, options));
    if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
    return res.json();
}

/**
 * 发送 POST 请求（multipart/form-data）
 * @template T - 响应数据的类型
 * @param path - 请求路径（相对于 API_BASE）
 * @param form - FormData 请求体
 * @returns 解析后的 JSON 响应数据
 * @throws 当 HTTP 状态码非 2xx 时抛出 ApiError
 */
export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {method: 'POST', body: form});
    if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
    return res.json();
}

/**
 * 发送 PUT 请求
 * @template T - 响应数据的类型
 * @param path - 请求路径（相对于 API_BASE）
 * @param body - 请求体数据（必填）
 * @param options - 可选的 AbortSignal 等附加选项
 * @returns 解析后的 JSON 响应数据
 * @throws 当 HTTP 状态码非 2xx 时抛出 ApiError
 */
export async function apiPut<T>(path: string, body: unknown, options?: ApiOptions): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, mergeInit({
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    }, options));
    if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
    return res.json();
}

/**
 * 发送 DELETE 请求
 * @param path - 请求路径（相对于 API_BASE）
 * @param options - 可选的 AbortSignal 等附加选项
 * @throws 当 HTTP 状态码非 2xx 时抛出 ApiError
 */
export async function apiDelete<T>(path: string, options?: ApiOptions): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, mergeInit({method: 'DELETE'}, options));
    if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
    return res.json();
}

/**
 * 通过后端打开系统原生的文件夹选择对话框
 *
 * 该接口将请求转发至 Electron/Tauri 等桌面框架或后端服务，
 * 调用操作系统的文件夹选取 API，返回用户选择的路径。
 *
 * @param title - 可选的对话框标题，默认为 "Select Folder"
 * @returns 用户选择的文件夹路径；若用户取消选择则返回 null
 */
export async function pickFolder(title?: string): Promise<string | null> {
    const res = await fetch('/api/workspace/pick', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({title: title || 'Select Folder'}),
    });
    // 请求失败（如用户取消）时返回 null，而非抛出异常
    if (!res.ok) return null;
    const data = await res.json();
    return data.path ?? null;
}
