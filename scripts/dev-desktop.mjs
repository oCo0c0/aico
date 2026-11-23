#!/usr/bin/env node
/**
 * 桌面版开发模式入口（pnpm dev:desktop）
 *
 * 流程：
 * 1. 编译 Electron 主进程 → dist-electron/
 * 2. 启动 Vite dev server（5173）并等待就绪
 * 3. 以开发模式启动 Electron：
 *    - 窗口加载 http://localhost:5173（ADW_DEV_SERVER_URL 可覆盖）
 *    - 后端子进程经 tsx 直跑 src/cli 源码，固定 3000 端口（Vite 代理目标）
 * Ctrl+C / Electron 退出时级联清理 Vite 与 Electron。
 */

import {spawn, spawnSync} from 'node:child_process';
import http from 'node:http';

const ELECTRON_ENV = {...process.env, ADW_ELECTRON_DEV: '1'};

function run(cmd, args, env = process.env) {
    // shell: true —— Windows 上解析 .cmd 垫片（pnpm/vite/electron）
    return spawn(cmd, args, {stdio: 'inherit', shell: true, env});
}

/**
 * 结束进程及其子进程树。
 * Windows 上 spawn 起的是 cmd 垫片，kill() 只杀垫片本身，真正的 node/electron
 * 子进程会残留（表现为下次启动端口占用）——用 taskkill /T 连树一起收。
 */
function killTree(proc) {
    if (!proc.pid || proc.exitCode !== null) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {stdio: 'ignore'});
    } else {
        proc.kill();
    }
}

console.log('[dev:desktop] compiling electron main ...');
const tsc = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.electron.json'], {
    stdio: 'inherit',
    shell: true,
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

console.log('[dev:desktop] starting vite dev server ...');
const vite = run('pnpm', ['exec', 'vite']);

function waitFor(url, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const req = http.get(url, (res) => {
                res.resume();
                resolve();
            });
            req.on('error', (err) => {
                if (Date.now() - started > timeoutMs) reject(err);
                else setTimeout(attempt, 300);
            });
        };
        attempt();
    });
}

try {
    await waitFor('http://localhost:5173/', 30_000);
} catch (err) {
    console.error('[dev:desktop] vite dev server 启动超时:', err.message);
    vite.kill();
    process.exit(1);
}

console.log('[dev:desktop] launching electron ...');
const electron = run('pnpm', ['exec', 'electron', '.'], ELECTRON_ENV);

const cleanup = () => {
    killTree(electron);
    killTree(vite);
};
electron.on('exit', (code) => {
    killTree(vite);
    process.exit(code ?? 0);
});
process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
});
process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
});
