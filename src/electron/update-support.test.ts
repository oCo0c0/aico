import {describe, expect, it} from 'vitest';
import {isAutoUpdateSupported, normalizeUpdateError, type UpdateEnv} from './update-support';

/** 快速构造环境输入（测试里只覆写关心的字段） */
const env = (overrides: Partial<UpdateEnv> = {}): UpdateEnv => ({
    platform: 'win32',
    isPackaged: true,
    isPortable: false,
    ...overrides,
});

describe('isAutoUpdateSupported', () => {
    it('win32/linux 打包安装版：支持', () => {
        expect(isAutoUpdateSupported(env())).toBe(true);
        expect(isAutoUpdateSupported(env({platform: 'linux'}))).toBe(true);
    });

    it('开发模式（未打包）：不支持（无 app-update.yml）', () => {
        expect(isAutoUpdateSupported(env({isPackaged: false}))).toBe(false);
    });

    it('portable 绿色版：不支持（覆盖安装语义不成立）', () => {
        expect(isAutoUpdateSupported(env({isPortable: true}))).toBe(false);
    });

    it('macOS：不支持（产物未签名，mac 更新通道强制要求签名）', () => {
        expect(isAutoUpdateSupported(env({platform: 'darwin'}))).toBe(false);
        expect(isAutoUpdateSupported(env({platform: 'darwin', isPortable: true}))).toBe(false);
    });
});

describe('normalizeUpdateError', () => {
    it('Error 实例取 message', () => {
        expect(normalizeUpdateError(new Error('ENOTFOUND'))).toBe('ENOTFOUND');
    });

    it('非 Error 值转字符串', () => {
        expect(normalizeUpdateError('boom')).toBe('boom');
        expect(normalizeUpdateError(42)).toBe('42');
    });

    it('超长消息截断到 200 字符并带省略号', () => {
        const long = 'x'.repeat(300);
        const out = normalizeUpdateError(long);
        expect(out.length).toBe(201); // 200 + 省略号
        expect(out.endsWith('…')).toBe(true);
    });
});
