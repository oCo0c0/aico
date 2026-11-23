/**
 * 桌面版自动更新（electron-updater + GitHub Releases 通道）
 *
 * 职责：
 * - 启动后延迟静默检查更新，此后每 6 小时轮询一次（发现新版自动下载）
 * - 下载完成后向前端推送状态（preload 的 onUpdateState），由 UpdateNotice
 *   悬浮条提示「重启安装」；用户不点也无所谓——quit 时 autoInstallOnAppQuit 兜底
 * - IPC：adw:update-check（设置中心手动检查）/ adw:update-install（立即重启安装）
 *
 * 通道：electron-builder.yml 的 publish 配置（github oCo0c0/aico）在打包时生成
 * app-update.yml 内置于应用；CI release.yml 把 latest.yml / *.blockmap 随安装包
 * 一起传到 Release 资产，运行时 electron-updater 据此比对/差量下载。
 *
 * 平台支持见 update-support.ts：win NSIS 安装版 + linux AppImage；
 * portable / 未签名 mac / 开发模式一律不启用（静默跳过，无副作用）。
 */

import {app, ipcMain, type BrowserWindow} from 'electron';
import {autoUpdater} from 'electron-updater';
import {isAutoUpdateSupported, normalizeUpdateError, type UpdateState} from './update-support';

/** 启动后首次检查的延迟（避开启动窗口的资源竞争高峰） */
const FIRST_CHECK_DELAY_MS = 10_000;
/** 后续轮询间隔 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 当前状态缓存（判断 install 请求是否处于 downloaded 态） */
let lastState: UpdateState | null = null;

/** 推送状态给主窗口（窗口不存在/已销毁时只缓存不发送） */
function pushState(state: UpdateState, getWindow: () => BrowserWindow | null): void {
    lastState = state;
    const win = getWindow();
    if (win && !win.isDestroyed()) {
        win.webContents.send('adw:update-state', state);
    }
}

/** 发起一次检查（结果经 autoUpdater 事件流推送；网络失败转 error 状态不抛出） */
async function checkNow(getWindow: () => BrowserWindow | null): Promise<void> {
    try {
        await autoUpdater.checkForUpdates();
    } catch (err) {
        pushState({status: 'error', message: normalizeUpdateError(err)}, getWindow);
    }
}

/**
 * 初始化自动更新（仅在支持的环境有实际效果，其余环境 no-op）
 *
 * @param opts.getWindow - 主窗口获取器（状态推送给主窗口渲染层）
 * @param opts.isDev - 开发模式覆盖（默认取 !app.isPackaged）
 */
export function setupUpdater(opts: {getWindow: () => BrowserWindow | null; isDev?: boolean}): void {
    const isDev = opts.isDev ?? !app.isPackaged;
    const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
    if (
        isDev ||
        !isAutoUpdateSupported({platform: process.platform, isPackaged: app.isPackaged, isPortable})
    ) {
        return;
    }

    // 发现新版即自动下载；装不装由用户点 UpdateNotice 决定，但退出时兜底装
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => pushState({status: 'checking'}, opts.getWindow));
    autoUpdater.on('update-available', (info) =>
        pushState({status: 'available', version: info.version}, opts.getWindow));
    autoUpdater.on('update-not-available', (info) =>
        pushState({status: 'not-available', version: info.version}, opts.getWindow));
    autoUpdater.on('download-progress', (progress) =>
        pushState({status: 'downloading', percent: Math.round(progress.percent)}, opts.getWindow));
    autoUpdater.on('update-downloaded', (info) =>
        pushState({status: 'downloaded', version: info.version}, opts.getWindow));
    autoUpdater.on('error', (err) =>
        pushState({status: 'error', message: normalizeUpdateError(err)}, opts.getWindow));

    // 手动检查 / 立即安装（设置中心「版本与更新」区驱动）
    ipcMain.on('adw:update-check', () => void checkNow(opts.getWindow));
    ipcMain.on('adw:update-install', () => {
        // 只在下载完成后响应；尚未就绪时忽略（前端按钮本就只在 downloaded 态出现）
        if (lastState?.status !== 'downloaded') return;
        // 退出并安装：走 app.quit 级联（will-quit 的服务端清理握手照常执行）
        autoUpdater.quitAndInstall();
    });

    // 启动延迟首查 + 定时轮询（定时器与主进程同寿，无需清理）
    setTimeout(() => {
        void checkNow(opts.getWindow);
        setInterval(() => void checkNow(opts.getWindow), CHECK_INTERVAL_MS);
    }, FIRST_CHECK_DELAY_MS);
}
