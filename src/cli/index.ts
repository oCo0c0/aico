#!/usr/bin/env node
/**
 * CLI 入口模块
 *
 * Aico 命令行入口。负责：
 * 1. 加载用户配置（~/.aico/config.json）
 * 2. 查找可用端口
 * 3. 启动 HTTP/WebSocket 服务
 * 4. 注册优雅关闭处理（SIGINT/SIGTERM）
 */

import {findAvailablePort, resolvePreferredPort} from './port-finder.js';
import {printBanner} from './banner.js';
import {createServer} from '../server';
import {APP_DATA_DIR} from '../shared/app-data-dir.js';
import fs from 'fs';
import path from 'path';

/** 应用配置接口 */
interface AppConfig {
    server?: {
        /** 服务监听端口 */
        port?: number;
        /** 服务监听主机地址 */
        host?: string;
    };
}

/** 配置目录路径（`~/.aico`，旧版目录由 app-data-dir 自动迁移） */
const CONFIG_DIR = APP_DATA_DIR;
/** 配置文件路径 */
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * 加载用户配置文件
 *
 * 从 ~/.aico/config.json 读取配置。
 * 文件不存在或解析失败时返回空配置。
 *
 * @returns 解析后的应用配置对象
 */
function loadConfig(): AppConfig {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
            return JSON.parse(raw);
        }
    } catch {
        // 解析失败时忽略，使用默认配置
    }
    return {};
}

/**
 * 确保配置目录存在
 *
 * 若 ~/.aico 目录不存在则递归创建。
 */
function ensureConfigDir(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, {recursive: true});
    }
}

/**
 * 获取应用版本号
 *
 * 从 package.json 读取版本字段，读取失败时返回默认值 '0.1.0'。
 *
 * @returns 应用版本号字符串
 */
function getVersion(): string {
    try {
        const pkgPath = path.resolve(__dirname, '../../package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '0.1.0';
    } catch {
        return '0.1.0';
    }
}

/**
 * 启动 CLI 主流程
 *
 * 执行顺序：确保配置目录 → 加载配置 → 查找端口 → 创建服务 → 打印横幅 → 注册关闭信号
 */
async function startCLI(): Promise<void> {
    ensureConfigDir();

    const config = loadConfig();
    // ADW_PORT 环境变量优先（桌面版由 Electron 主进程注入），其次配置文件
    const preferredPort = resolvePreferredPort(process.env.ADW_PORT, config.server?.port);

    const {port} = await findAvailablePort({preferredPort});
    const version = getVersion();

    const server = await createServer(port);

    printBanner(port, version);

    // 优雅关闭由 createServer 内部统一注册（SIGINT/SIGTERM/桌面壳 IPC 握手），
    // 这里不再重复注册 —— 双注册会让两套清理逻辑竞速 exit，server.close 永远走不完。
    void server;
}

startCLI().catch((err) => {
    console.error('Failed to start Aico:', err.message);
    process.exit(1);
});
