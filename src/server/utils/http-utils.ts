/**
 * @module http-utils
 * @description HTTP 工具函数
 */
import fs from 'fs';
import https from 'https';
import http from 'http';
import {URL} from 'url';
import {TIMEOUTS} from './constants.js';

/** 禁止访问的 URL scheme */
const DISALLOWED_SCHEMES = ['file', 'ftp', 'data', 'javascript', 'vbscript'];

/** 重定向跟随次数上限（每次跳转都重新校验目标 URL） */
const MAX_REDIRECT_DEPTH = 5;

/** 判断点分十进制 IPv4 是否指向内网/保留地址段 */
function isPrivateIPv4(parts: number[]): boolean {
    const [a, b] = parts;
    return (
        a === 0 ||                              // 0.0.0.0/8（「本机」别名）
        a === 10 ||                             // 10.0.0.0/8 私网
        a === 127 ||                            // 127.0.0.0/8 回环
        (a === 100 && b >= 64 && b <= 127) ||   // 100.64.0.0/10 CGNAT
        (a === 169 && b === 254) ||             // 169.254.0.0/16 链路本地（含云 metadata 169.254.169.254）
        (a === 172 && b >= 16 && b <= 31) ||    // 172.16.0.0/12 私网
        (a === 192 && b === 168) ||             // 192.168.0.0/16 私网
        a >= 224                                // 组播/保留段
    );
}

/**
 * 判断主机名是否指向内网/回环/保留地址。
 * 覆盖：localhost 及其子域、IPv6 回环/ULA/链路本地/IPv4 映射、
 * 十进制/十六进制整数型 IP 编码（如 http://2130706433/ = 127.0.0.1）、点分十进制。
 * 注：不做 DNS 解析期校验（DNS rebinding 需连接期 IP pin，超出本工具职责）。
 */
/** @internal 导出仅供单测（isBlockedHostname 覆盖表） */
export function isBlockedHostname(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host.startsWith('[')) {
        const bare = host.slice(1, -1);
        if (bare === '::' || bare === '::1') return true;
        // IPv4 映射地址 ::ffff:a.b.c.d → 校验内嵌 IPv4
        const mapped = bare.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
        if (mapped) return isPrivateIPv4(mapped[1].split('.').map(Number));
        // fc00::/7 ULA、fe80::/10 链路本地
        return /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare);
    }
    // 非点分十进制的纯数字/0x 编码一律拒绝（getaddrinfo 平台相关，行为不可信）
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return true;
    const dotted = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (dotted) {
        const parts = dotted.slice(1).map(Number);
        if (parts.some((p) => p > 255)) return true; // 非法地址（inet_aton 变体编码），直接拦
        return isPrivateIPv4(parts);
    }
    return false;
}

/**
 * 校验下载 URL 是否安全。
 * 仅允许 http/https，禁止内网/回环/保留地址，降低 SSRF 风险。
 *
 * @param url - 待校验的 URL 字符串
 * @throws 当 URL 不合法或不被允许时抛出错误
 */
function validateDownloadUrl(url: string): void {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid URL: ${url}`);
    }

    if (DISALLOWED_SCHEMES.includes(parsed.protocol.replace(':', ''))) {
        throw new Error(`URL scheme not allowed: ${parsed.protocol}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`URL scheme not allowed: ${parsed.protocol}`);
    }

    if (isBlockedHostname(parsed.hostname)) {
        throw new Error('URL points to internal address which is not allowed');
    }
}

/**
 * 下载远程文件到本地
 *
 * @param url - 远程文件 URL
 * @param destPath - 本地保存路径
 * @param timeoutMs - 超时时间（默认 HTTP_DOWNLOAD）
 */
export async function downloadFile(url: string, destPath: string, timeoutMs: number = TIMEOUTS.HTTP_DOWNLOAD, headers?: Record<string, string>, depth: number = 0): Promise<void> {
    // async 函数体内的同步 throw 会转为 Promise rejection（校验失败与网络失败对调用方同语义）
    validateDownloadUrl(url);
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, {timeout: timeoutMs, headers: headers ?? {}}, (res) => {
            // 处理重定向（限深，每次跳转重新过 SSRF 校验，防公网 302 跳内网）
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (depth >= MAX_REDIRECT_DEPTH) {
                    res.resume();
                    reject(new Error(`Too many redirects (>${MAX_REDIRECT_DEPTH})`));
                    return;
                }
                downloadFile(res.headers.location, destPath, timeoutMs, headers, depth + 1).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const stream = fs.createWriteStream(destPath);
            res.pipe(stream);
            stream.on('finish', () => {
                stream.close();
                resolve();
            });
            stream.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * 从 URL 中提取图片文件名
 */
export function urlToImageFilename(url: string): string {
    try {
        const pathname = new URL(url).pathname;
        const base = pathname.split('/').pop() ?? '';
        if (base && /\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(base)) return base;
    } catch { /* fallback */ }
    return `image-${Date.now()}.png`;
}
