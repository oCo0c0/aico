/**
 * RequirementStoreService 路径安全回归测试
 *
 * 背景：reqDir(id) 曾是裸 path.join(rootDir, id)，`../` 类 id 可路径遍历
 * 读/写/删除任意目录。现在 resolve 后必须仍落在 rootDir 内，否则抛 HttpError(400)。
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {RequirementStoreService} from './requirement-store-service.js';
import {HttpError} from '../middleware/validation.js';

describe('RequirementStoreService 路径安全', () => {
    let rootDir: string;
    let store: RequirementStoreService;
    /** rootDir 之外的「人质」文件：遍历成功删除它即测试失败 */
    let outsideFile: string;

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-reqstore-'));
        store = new RequirementStoreService(rootDir);
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-reqstore-outside-'));
        outsideFile = path.join(outsideDir, 'hostage.txt');
        fs.writeFileSync(outsideFile, 'must survive');
    });

    afterEach(() => {
        fs.rmSync(rootDir, {recursive: true, force: true});
        fs.rmSync(path.dirname(outsideFile), {recursive: true, force: true});
    });

    it('正常 id 的 CRUD 不受影响', () => {
        const saved = store.upsert({
            id: 'CWXT-129290',
            title: 'demo',
            status: 'open',
            priority: 'P1',
            assignee: '',
            description: 'hello',
            attachments: [],
            relatedIssues: [],
            source: 'test',
        } as never);
        expect(saved.id).toBe('CWXT-129290');
        expect(store.get('CWXT-129290')?.description).toBe('hello');
        expect(store.delete('CWXT-129290')).toBe(true);
        expect(store.get('CWXT-129290')).toBeUndefined();
    });

    it.each([
        '../outside',
        '../../..',
        // 反斜杠分隔符仅在 Windows 上构成真实路径遍历（POSIX 下 '\' 是合法文件名字符，
        // 该 id 解析后仍在根目录内、不抛错是正确行为）——CI 在 ubuntu 上跑，此用例按平台启用
        ...(process.platform === 'win32' ? ['..\\..\\win-escape'] : []),
        'sub/../../escape',
        // 注：'..%2F..%2F' 字面量不含真实分隔符，只有经路由 URL 解码后才恶意，
        // 解码后的形态即 '../../' 已由上表覆盖
    ])('恶意 id "%s" 触发 HttpError(400) 且不删除目录外文件', (id) => {
        expect(() => store.delete(id)).toThrow(HttpError);
        expect(() => store.get(id)).toThrow(HttpError);
        expect(() => store.upsert({
            id,
            title: 'evil',
        } as never)).toThrow(HttpError);
        expect(fs.existsSync(outsideFile)).toBe(true);
    });

    it('rootDir 外的绝对路径 id 同样触发 HttpError(400)', () => {
        const absId = path.dirname(outsideFile);
        expect(() => store.delete(absId)).toThrow(HttpError);
        expect(fs.existsSync(outsideFile)).toBe(true);
    });
});
