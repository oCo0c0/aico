/**
 * 自动更新支持性判定（纯函数，无 Electron 依赖，可单测）
 *
 * electron-updater 的能力边界决定了三类环境必须排除：
 * - 开发模式（未打包）：没有 app-update.yml，检查必然报错
 * - portable.exe 绿色版：解压到临时目录运行，覆盖安装语义不成立
 * - macOS 未签名：mac 更新通道强制要求代码签名，未签名包装不上
 * 支持平台：Windows NSIS 安装版 + Linux AppImage。
 */

/** 环境判定输入（从主进程收集，纯函数只做判断） */
export interface UpdateEnv {
    /** 当前平台（process.platform） */
    platform: NodeJS.Platform;
    /** 是否已打包（app.isPackaged） */
    isPackaged: boolean;
    /** 是否 portable 绿色版（存在 PORTABLE_EXECUTABLE_DIR 环境变量） */
    isPortable: boolean;
}

/**
 * 判定当前环境是否支持应用内自动更新
 *
 * @returns true = 可启用 electron-updater 的静默检查/下载/安装
 */
export function isAutoUpdateSupported(env: UpdateEnv): boolean {
    if (!env.isPackaged) return false;
    if (env.isPortable) return false;
    return env.platform === 'win32' || env.platform === 'linux';
}

/**
 * 更新状态（主进程 → 渲染进程单向推送，见 preload 的 onUpdateState）
 */
export interface UpdateState {
    status:
        | 'checking'        // 正在检查
        | 'available'       // 发现新版本（随后自动开始下载）
        | 'not-available'   // 已是最新
        | 'downloading'     // 下载中（percent 0-100）
        | 'downloaded'      // 下载完成，可安装
        | 'error';          // 出错（message 为摘要）
    /** 相关版本号（available/not-available/downloaded 时携带） */
    version?: string;
    /** 下载进度百分比（downloading 时携带） */
    percent?: number;
    /** 错误摘要（error 时携带，已截断） */
    message?: string;
}

/** 错误消息截断上限（避免把堆栈整段推给渲染进程） */
const ERROR_MESSAGE_MAX = 200;

/** 归一化错误消息：截断到可读长度，undefined 安全 */
export function normalizeUpdateError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.length > ERROR_MESSAGE_MAX ? `${raw.slice(0, ERROR_MESSAGE_MAX)}…` : raw;
}
