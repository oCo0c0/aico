/**
 * Electron 主进程（桌面版入口）
 *
 * 职责：
 * 1. 修复 GUI 启动缺失的用户 PATH（macOS/Linux 命门：claude/codex/pi/npx 等依赖 CLI）
 * 2. 以子进程方式启动既有 Node 服务端：
 *    - ELECTRON_RUN_AS_NODE=1 把 Electron 二进制当 Node 运行时（无需打包 node.exe）
 *    - 崩溃隔离：窗口崩溃不影响进行中的执行；服务端崩溃弹窗提示并退出
 *    - 复用 CLI 既有 SIGTERM 优雅清理（bridge / pi RPC / MCP servers / Daytona 沙箱）
 * 3. HTTP 轮询就绪后创建窗口：生产加载服务端静态页，开发加载 Vite dev server
 * 4. 单实例锁 + 退出级联清理
 *
 * 打包要求 asar: false —— resources/pi-extensions 等需被孙进程按真实文件路径读取。
 */

import {app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, Tray} from 'electron';
import {ChildProcess, execSync, spawn, type StdioOptions} from 'child_process';
import http from 'http';
import path from 'path';
import {fixPath} from './fix-path';
import {buildServerStdio} from './server-stdio';
import {overlayColorsFor} from './titlebar-theme';
import {loadCloseBehavior, saveCloseBehavior} from './tray-settings';
import {setupUpdater} from './updater';
import {findAvailablePort} from '../cli/port-finder';
import {APP_DATA_DIR} from '../shared/app-data-dir';

const isDev = process.env.ADW_ELECTRON_DEV === '1';
/** 开发模式后端固定 3000（vite.config.ts 代理硬编码目标） */
const DEV_SERVER_PORT = 3000;
/** 服务端就绪探测超时 */
const SERVER_READY_TIMEOUT_MS = 60_000;

let serverProc: ChildProcess | null = null;
let win: BrowserWindow | null = null;
/** 桌面宠物悬浮窗（透明置顶小窗，Bongo Cat；见 createPetWindow） */
let petWin: BrowserWindow | null = null;
/** 主窗口加载的应用 URL（宠物窗口复用同一来源，附加 ?pet=1 进入轻量页面分支） */
let appUrl = '';
/** 是否正在主动退出（区分服务端异常退出与正常关闭；托盘「退出」也置位） */
let quitting = false;
/** will-quit 已发起优雅关闭握手（防二次触发重入） */
let shutdownHandshakeStarted = false;
/** 主窗口当前是否隐藏到托盘（跨平台恢复入口的判定依据） */
let windowHiddenToTray = false;
/** 系统托盘（Windows；Tray 无引用会被 GC 回收，须模块级持有） */
let tray: Tray | null = null;
/** 桌面壳设置目录（Electron userData） */
let settingsDir = '';

/** 应用根目录（开发 = 仓库根；打包 = app 目录，asar 已关闭） */
function appRoot(): string {
    return app.getAppPath();
}

/**
 * 启动后端服务子进程
 *
 * 生产模式日志落盘 ~/.aico/logs/desktop-server.log；
 * 开发模式直接继承控制台输出。
 */
function spawnServer(port: number): ChildProcess {
    const bootstrapPath = path.join(appRoot(), 'dist-electron', 'electron', 'server-bootstrap.js');
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ADW_PORT: String(port),
        ADW_ELECTRON_DEV: isDev ? '1' : '',
        ADW_DESKTOP: '1',
    };

    // 生产模式日志落盘 fd（详见 server-stdio.ts：不能传未打开的 WriteStream）
    // APP_DATA_DIR 在模块加载时已解析并完成旧版目录 → ~/.aico 的一次性迁移
    // 追加第 4 路 'ipc' 通道：Windows 退出时经其发送优雅关闭握手（见 will-quit），
    // 服务端 process.on('message') 收到后走与 SIGTERM 相同的清理路径
    const baseStdio = buildServerStdio(isDev, path.join(APP_DATA_DIR, 'logs'));
    const stdio: StdioOptions = Array.isArray(baseStdio)
        ? [...baseStdio, 'ipc']
        : ['inherit', 'inherit', 'inherit', 'ipc'];

    const proc = spawn(process.execPath, [bootstrapPath], {env, stdio});
    proc.on('exit', (code) => {
        if (!quitting) {
            dialog.showErrorBox(
                'Aico',
                `后端服务进程异常退出（code=${code}）。\n` +
                '日志文件：~/.aico/logs/desktop-server.log',
            );
            app.quit();
        }
    });
    return proc;
}

/**
 * 轮询探测服务端就绪（任意 HTTP 响应即视为就绪）
 *
 * 服务端在全部服务初始化完成后才开始 listen，TCP 可连即代表 API 可用。
 * 用 localhost 而非 127.0.0.1：host 为 "localhost" 时 Node 可能仅绑 IPv6 ::1。
 */
function waitForServer(port: number, timeoutMs: number): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const onError = (err: Error): void => {
            if (Date.now() - started > timeoutMs) {
                reject(err);
                return;
            }
            setTimeout(attempt, 300);
        };
        const attempt = (): void => {
            const req = http.get({host: 'localhost', port, path: '/', timeout: 2000}, (res) => {
                res.resume();
                resolve();
            });
            req.on('error', onError);
            req.on('timeout', () => {
                req.destroy();
                onError(new Error('request timeout'));
            });
        };
        attempt();
    });
}

/** 创建主窗口 */
function createWindow(url: string): void {
    const isWindows = process.platform === 'win32';
    win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 960,
        minHeight: 600,
        show: false,
        title: 'Aico',
        // 与应用深色主题主背景（hsl(203 50% 16%)）一致，避免启动白闪
        backgroundColor: '#142d3c',
        // Windows/Linux 任务栏图标（macOS 使用应用包内图标）
        icon: path.join(appRoot(), 'resources', 'app-icon.png'),
        autoHideMenuBar: true,
        ...(isWindows
            ? {
                  // Windows：隐藏系统标题栏；窗口控制按钮（最小化/最大化/关闭）由前端
                  // 在玻璃顶栏内自绘（WindowControls 组件 + adw:window-control IPC），
                  // 不用 titleBarOverlay —— 原生覆盖层会画一条不透明实色条，把顶栏的
                  // 毛玻璃/壁纸透明效果整条盖死。双击拖拽区（app-drag）默认可切换
                  // 最大化；Win11 原生吸附布局弹层随之不可用（自绘按钮的已知取舍）。
                  titleBarStyle: 'hidden' as const,
              }
            : {}),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    win.once('ready-to-show', () => win?.show());
    win.on('closed', () => {
        win = null;
    });
    // 最大化状态推送给前端（自绘最大化/还原图标切换）
    win.on('maximize', () => win?.webContents.send('adw:maximize-changed', true));
    win.on('unmaximize', () => win?.webContents.send('adw:maximize-changed', false));
    // Bongo Cat 输入镜像：主窗口键盘输入（main 进程 before-input-event 捕获，
    // 不干扰正常输入、无系统级钩子）。IME 组合期与纯修饰键跳过。
    win.webContents.on('before-input-event', (_event, input) => {
        if (input.type !== 'keyDown') return;
        if (input.isComposing || !input.code) return;
        if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(input.code)) return;
        forwardPetInput({kind: 'key', side: pawSideOfCode(input.code)});
    });
    // 关闭行为：tray=隐藏到托盘 / quit=直接退出 / ask=首次弹询问框（可记住选择）
    win.on('close', (e) => {
        if (quitting) return;
        const behavior = loadCloseBehavior(settingsDir);
        if (behavior === 'tray') {
            e.preventDefault();
            hideToTray();
            return;
        }
        if (behavior === 'quit') return;
        // ask：同步阻止默认关闭，再异步询问
        e.preventDefault();
        void (async () => {
            if (!win || win.isDestroyed()) return;
            const choice = await dialog.showMessageBox(win, {
                type: 'question',
                title: '关闭 Aico',
                message: '要直接退出，还是最小化到系统托盘继续运行？',
                detail: '最小化到托盘后，进行中的引擎任务不会被中断。',
                buttons: ['最小化到托盘', '直接退出'],
                defaultId: 0,
                cancelId: 1,
                noLink: true,
                checkboxLabel: '记住我的选择（之后不再询问）',
            });
            if (choice.response === 0) {
                if (choice.checkboxChecked) saveCloseBehavior(settingsDir, 'tray');
                hideToTray();
            } else {
                if (choice.checkboxChecked) saveCloseBehavior(settingsDir, 'quit');
                quitting = true;
                app.quit();
            }
        })();
    });
    void win.loadURL(url);
}

/**
 * 创建桌面宠物悬浮窗（Bongo Cat 打字猫）
 *
 * 特性：
 * - 透明 + 无边框 + 无阴影：只有猫和气泡浮在桌面上；
 * - screen-saver 层级置顶 + 不进任务栏 + 不可聚焦（点击不会抢走正在敲码的焦点）；
 * - 内容加载 `appUrl?pet=1`（主 SPA 的轻量分支，自持 /ws 连接实时反映 agent 动态）；
 * - 整窗可拖拽（页面内 -webkit-app-region: drag），位置不持久化（重启回右下角）。
 * 主窗口最小化到托盘后宠物窗口继续存在 —— 桌面悬浮宠物的核心场景。
 */
function createPetWindow(): void {
    if (petWin && !petWin.isDestroyed()) return;
    const width = 260;
    const height = 220;
    const workArea = screen.getPrimaryDisplay().workArea;
    petWin = new BrowserWindow({
        width,
        height,
        x: workArea.x + workArea.width - width - 24,
        y: workArea.y + workArea.height - height - 24,
        transparent: true,
        frame: false,
        hasShadow: false,
        resizable: false,
        movable: true,
        skipTaskbar: true,
        show: false,
        focusable: false,
        alwaysOnTop: true,
        title: 'Aico Pet',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            // 复用主窗口 preload：宠物页需要 onPetInput 桥接收输入镜像事件
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    // screen-saver 层级：盖过普通置顶窗口，仍在全屏应用之下
    petWin.setAlwaysOnTop(true, 'screen-saver');
    petWin.once('ready-to-show', () => petWin?.show());
    petWin.on('closed', () => {
        petWin = null;
    });
    const base = appUrl.endsWith('/') ? appUrl.slice(0, -1) : appUrl;
    void petWin.loadURL(`${base}/?pet=1`);
}

/** 关闭并释放宠物悬浮窗 */
function destroyPetWindow(): void {
    if (!petWin || petWin.isDestroyed()) {
        petWin = null;
        return;
    }
    petWin.destroy();
    petWin = null;
}

/** 输入镜像：未知键位的左右爪交替开关 */
let pawParity = false;

/**
 * 键位 → 猫爪左右分区（与 client 的 lib/paw-side.ts 保持同一逻辑，
 * 主进程不能 import client 代码，故此处持有一份副本）
 */
function pawSideOfCode(code: string): 'left' | 'right' {
    const LEFT_ZONE = /^(Digit[1-5]|Key[QWERTASDFGZXCB]|ShiftLeft|ControlLeft|AltLeft|MetaLeft|Backquote|Tab|CapsLock|F[1-6])$/;
    pawParity = !pawParity;
    if (code === 'Space' || !(code.startsWith('Key') || code.startsWith('Digit'))) {
        return pawParity ? 'left' : 'right';
    }
    return LEFT_ZONE.test(code) ? 'left' : 'right';
}

/** 把一次输入敲击转发给宠物窗口（镜像不存在时静默跳过） */
function forwardPetInput(input: {kind: 'key' | 'mouse'; side: 'left' | 'right'}): void {
    if (!petWin || petWin.isDestroyed()) return;
    petWin.webContents.send('adw:pet-input', input);
}

/**
 * 隐藏主窗口到系统托盘并气泡提示去向（气泡仅 Windows）
 *
 * 平台差异：托盘图标在 win32 + macOS 创建；Linux 桌面环境托盘可用性参差，
 * 不创建——隐藏后通过「再次启动应用」（second-instance）或 Dock/任务栏恢复。
 */
function hideToTray(): void {
    if (!win) return;
    win.hide();
    windowHiddenToTray = true;
    if (tray && process.platform === 'win32') {
        try {
            tray.displayBalloon({
                title: 'Aico',
                content: '已最小化到系统托盘，引擎任务继续运行。点击托盘图标可恢复窗口。',
            });
        } catch {
            // 气泡失败不影响隐藏
        }
    }
}

/** 恢复并聚焦主窗口 */
function showMainWindow(): void {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    windowHiddenToTray = false;
}

/**
 * 创建系统托盘（win32 + macOS；Linux 桌面托盘可用性参差，不创建，
 * 隐藏窗口经「再次启动应用」或任务栏恢复）
 * 左键/click 恢复窗口，右键菜单 打开/退出
 */
function createTray(): void {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    const icon = nativeImage
        .createFromPath(path.join(appRoot(), 'resources', 'app-icon.png'))
        .resize({width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16});
    tray = new Tray(icon);
    tray.setToolTip('Aico');
    tray.setContextMenu(
        Menu.buildFromTemplate([
            {label: '打开 Aico', click: () => showMainWindow()},
            {type: 'separator'},
            {
                label: '退出',
                click: () => {
                    quitting = true;
                    app.quit();
                },
            },
        ]),
    );
    // Windows 惯例：左键点击托盘图标即恢复窗口（macOS 左键默认弹菜单）
    if (process.platform === 'win32') {
        tray.on('click', () => showMainWindow());
    }
}

// ---- 生命周期 ----

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        // 再次启动应用 → 恢复既有实例窗口（含隐藏到托盘的场景：Linux 无托盘
        // 图标，重新打开应用是主要恢复入口）
        if (win && !win.isDestroyed()) {
            showMainWindow();
        }
    });

    app.whenReady().then(async () => {
        try {
            // 渲染进程主题变化 → 运行时更新窗口控制按钮覆盖层配色（仅 Windows 生效）
            ipcMain.on('adw:set-window-controls-theme', (_event, mode: 'light' | 'dark') => {
                if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
                try {
                    win.setTitleBarOverlay(overlayColorsFor(mode));
                } catch {
                    // 非 overlay 模式（未启用 titleBarOverlay 的平台/状态）忽略
                }
            });

            // 吉祥物开关 → 桌面宠物悬浮窗的显隐（悬浮面板「吉祥物」页签 / 偏好恢复）
            ipcMain.on('adw:set-pet-visible', (_event, visible: boolean) => {
                if (visible) createPetWindow();
                else destroyPetWindow();
            });

            // 自绘窗口控制按钮（titleBarStyle hidden 无覆盖层；close 走既有关闭行为询问）
            ipcMain.on('adw:window-control', (_event, action: 'minimize' | 'toggle-maximize' | 'close') => {
                if (!win || win.isDestroyed()) return;
                if (action === 'minimize') {
                    win.minimize();
                } else if (action === 'toggle-maximize') {
                    if (win.isMaximized()) win.unmaximize();
                    else win.maximize();
                } else {
                    win.close();
                }
            });

            // 主窗口鼠标点击 → 宠物镜像（键盘走 before-input-event，无需渲染进程上报）
            ipcMain.on('adw:input-activity', (_event, kind: 'mouse') => {
                pawParity = !pawParity;
                forwardPetInput({kind, side: pawParity ? 'left' : 'right'});
            });

            // 必须在任何子进程派生之前修复 PATH（子进程继承主进程环境）
            fixPath();

            let port: number;
            if (isDev) {
                port = DEV_SERVER_PORT;
            } else {
                port = (await findAvailablePort()).port;
            }

            serverProc = spawnServer(port);
            try {
                await waitForServer(port, SERVER_READY_TIMEOUT_MS);
            } catch (err) {
                dialog.showErrorBox(
                    'Aico',
                    `后端服务启动超时：${err instanceof Error ? err.message : err}\n` +
                    '日志文件：~/.aico/logs/desktop-server.log',
                );
                app.quit();
                return;
            }

            const url = isDev
                ? (process.env.ADW_DEV_SERVER_URL ?? 'http://localhost:5173')
                : `http://localhost:${port}`;
            console.log(`[desktop] ready at ${url}`);
            appUrl = url;
            settingsDir = app.getPath('userData');
            createWindow(url);
            createTray();
            // 自动更新（electron-updater + GitHub Releases；不支持的环境内部 no-op）
            setupUpdater({
                getWindow: () => win,
                beforeInstall: () => {
                    // quitAndInstall 先拉起 NSIS 安装器再退出应用，而 will-quit 的优雅
                    // 关闭握手最长要 5 秒——安装器抢先检测到存活进程就弹「无法关闭」。
                    // 且服务端子进程与 pi RPC 孙进程都是 aico.exe（ELECTRON_RUN_AS_NODE），
                    // 对 NSIS 而言都是「Aico 在运行」。安装路径不等握手：Windows 下整棵
                    // 进程树强杀（/T 连带 bridge/MCP/pi 孙进程），应用随后毫秒级退出。
                    // 正常退出路径（关窗/托盘退出）的优雅握手不受影响。
                    if (
                        process.platform === 'win32'
                        && serverProc?.pid
                        && serverProc.exitCode === null
                    ) {
                        try {
                            execSync(`taskkill /F /T /PID ${serverProc.pid}`, {stdio: 'ignore', timeout: 5000});
                        } catch { /* 进程树已退出等 */ }
                        serverProc = null;
                    }
                },
            });

            app.on('activate', () => {
                // macOS Dock 点击：窗口已存在（含隐藏到托盘）→ 恢复；否则新建
                if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
                else showMainWindow();
            });
        } catch (err) {
            // 同步启动错误（如 spawn 参数异常）以弹窗呈现而非静默 unhandled rejection
            dialog.showErrorBox(
                'Aico',
                `启动失败：${err instanceof Error ? err.message : String(err)}`,
            );
            app.quit();
        }
    });

    app.on('before-quit', () => {
        quitting = true;
    });

    app.on('will-quit', (event) => {
        destroyPetWindow();
        tray?.destroy();
        tray = null;

        if (!serverProc || serverProc.exitCode !== null) return;

        // POSIX: SIGTERM → 服务端既有优雅清理（dispose 沙箱/子进程后自行退出）
        if (process.platform !== 'win32') {
            serverProc.kill();
            return;
        }

        // Windows: kill() 是 TerminateProcess 强杀，服务端的信号清理逻辑不会运行，
        // bridge / pi RPC / MCP servers 等孙进程会孤儿化。改为 IPC 关闭握手：
        // 发送 shutdown 消息 → 服务端走与 SIGTERM 相同的清理路径 → 退出；
        // 兜底 5 秒超时强杀（服务端崩溃未建立 IPC、消息丢失等）。
        if (!shutdownHandshakeStarted) {
            shutdownHandshakeStarted = true;
            event.preventDefault();
            const forceKill = setTimeout(() => {
                serverProc?.kill();
                app.quit();
            }, 5000);
            serverProc.once('exit', () => {
                clearTimeout(forceKill);
                app.quit();
            });
            try {
                serverProc.send?.('adw:shutdown');
            } catch {
                // IPC 通道未建立（服务端启动即崩溃）→ 直接强杀
                clearTimeout(forceKill);
                serverProc.kill();
                app.quit();
            }
            return;
        }

        // 握手已发起过（超时强杀/服务端退出引发的二次 will-quit）→ 兜底强杀
        serverProc.kill();
    });

    app.on('window-all-closed', () => {
        app.quit();
    });
}
