/**
 * http-utils SSRF 防护回归测试
 *
 * downloadFile 对每个 URL（含重定向目标）做内网/回环/保留地址校验。
 * 各用例用一个不会真实联网的内部地址断言「被拦截」。
 */
import {describe, it, expect} from 'vitest';
import {downloadFile, isBlockedHostname} from './http-utils.js';

describe('downloadFile SSRF 防护', () => {
    const blocked = [
        'http://localhost/x.png',
        'http://localhost:3000/api/x',
        'http://127.0.0.1/x.png',
        'http://127.255.1.2/x.png',            // 127/8 整段
        'http://10.0.0.5/x.png',
        'http://172.16.0.9/x.png',
        'http://172.31.255.1/x.png',
        'http://192.168.1.1/x.png',
        'http://169.254.169.254/latest/meta-data', // 云 metadata
        'http://100.64.0.1/x.png',             // CGNAT
        'http://0.0.0.0/x.png',
        'http://2130706433/x.png',             // 十进制整数 = 127.0.0.1
        'http://0x7f000001/x.png',             // 十六进制编码
        'http://[::1]/x.png',                  // IPv6 回环
        'http://[::ffff:127.0.0.1]/x.png',     // IPv4 映射
        'http://[fc00::1]/x.png',              // ULA
        'http://[fe80::1]/x.png',              // 链路本地
        'file:///etc/passwd',
    ];

    it.each(blocked)('拦截 %s', async (url) => {
        await expect(downloadFile(url, 'unused-dest')).rejects.toThrow();
    });

    it('172 段的公网地址（172.0.x - 172.15.x）不在封锁范围', () => {
        // 172.0.0.0/12 - 172.15.255.255 是公网段，只有 172.16.0.0/12 才是私网
        expect(isBlockedHostname('172.1.2.3')).toBe(false);
        expect(isBlockedHostname('172.15.255.254')).toBe(false);
        expect(isBlockedHostname('172.16.0.1')).toBe(true);
    });

    it('公网域名不封锁', () => {
        expect(isBlockedHostname('example.com')).toBe(false);
        expect(isBlockedHostname('ones.example.cn')).toBe(false);
        expect(isBlockedHostname('127.0.0.1.example.com')).toBe(false); // 合法公网域名（DNS 由运行时处理）
    });
});
