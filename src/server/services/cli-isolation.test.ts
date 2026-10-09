/**
 * cli-isolation 无头权限前提（applyClaudeHeadlessGrants）的确定性验证。
 *
 * 背景：隔离 claude home 新生，永远没有交互机会接受 bypass 免责声明，
 * 播种来的 permissions.allow 也可能是直连时代前缀（匹配不上平台聚合 server）——
 * 两者叠加导致无头拉需求时 MCP 工具调用被静默拒绝。详见 cli-isolation.ts。
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {applyClaudeHeadlessGrants} from './cli-isolation.js';

const PLATFORM_ALLOW = 'mcp__adw-platform__*';

let home: string;

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-claude-home-'));
});

afterEach(() => {
    fs.rmSync(home, {recursive: true, force: true});
});

const readJson = (rel: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(home, rel), 'utf-8')) as Record<string, unknown>;

describe('applyClaudeHeadlessGrants', () => {
    it('空 home：补写 .claude.json 的 bypassPermissionsModeAccepted，不动缺失的 settings.json', () => {
        const applied = applyClaudeHeadlessGrants(home);

        expect(applied).toEqual(['.claude.json:bypassPermissionsModeAccepted']);
        const config = readJson('.claude.json');
        expect(config.bypassPermissionsModeAccepted).toBe(true);
        expect(fs.existsSync(path.join(home, 'settings.json'))).toBe(false);
    });

    it('.claude.json 缺标志：补上且保留既有字段', () => {
        fs.writeFileSync(
            path.join(home, '.claude.json'),
            JSON.stringify({firstStartTime: '2026-09-29T01:57:04.945Z', userID: 'u1'}),
        );

        const applied = applyClaudeHeadlessGrants(home);

        expect(applied).toEqual(['.claude.json:bypassPermissionsModeAccepted']);
        const config = readJson('.claude.json');
        expect(config.bypassPermissionsModeAccepted).toBe(true);
        expect(config.firstStartTime).toBe('2026-09-29T01:57:04.945Z');
        expect(config.userID).toBe('u1');
    });

    it('.claude.json 已有标志：不再写入（幂等）', () => {
        fs.writeFileSync(
            path.join(home, '.claude.json'),
            JSON.stringify({bypassPermissionsModeAccepted: true}),
        );

        expect(applyClaudeHeadlessGrants(home)).toEqual([]);
    });

    it('settings.json 直连时代 allow 规则：并入平台聚合前缀，既有规则与其它字段保留', () => {
        fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({}));
        fs.writeFileSync(
            path.join(home, 'settings.json'),
            JSON.stringify({
                env: {ANTHROPIC_BASE_URL: 'https://example.com'},
                permissions: {allow: ['Bash', 'mcp__ones-api__*'], deny: []},
            }),
        );

        const applied = applyClaudeHeadlessGrants(home);

        expect(applied).toEqual([`.claude.json:bypassPermissionsModeAccepted`, `settings.json:permissions.allow+=${PLATFORM_ALLOW}`]);
        const settings = readJson('settings.json') as {permissions: {allow: string[]; deny: string[]}};
        expect(settings.permissions.allow).toContain(PLATFORM_ALLOW);
        expect(settings.permissions.allow).toContain('mcp__ones-api__*');
        expect(settings.permissions.allow).toContain('Bash');
        expect(settings.permissions.deny).toEqual([]);
        expect((settings.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe('https://example.com');
    });

    it('settings.json 已含平台规则：不重复添加', () => {
        fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({bypassPermissionsModeAccepted: true}));
        fs.writeFileSync(
            path.join(home, 'settings.json'),
            JSON.stringify({permissions: {allow: [PLATFORM_ALLOW]}}),
        );

        expect(applyClaudeHeadlessGrants(home)).toEqual([]);
        const settings = readJson('settings.json') as {permissions: {allow: string[]}};
        expect(settings.permissions.allow.filter((r) => r === PLATFORM_ALLOW)).toHaveLength(1);
    });

    it('settings.json 无 permissions 段：跳过，不创建结构', () => {
        fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({}));
        fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({theme: 'auto'}));

        const applied = applyClaudeHeadlessGrants(home);

        expect(applied).toEqual(['.claude.json:bypassPermissionsModeAccepted']);
        expect(readJson('settings.json')).toEqual({theme: 'auto'});
    });

    it('文件损坏：不抛异常，.claude.json 重建、settings.json 跳过', () => {
        fs.writeFileSync(path.join(home, '.claude.json'), '{broken json');
        fs.writeFileSync(path.join(home, 'settings.json'), '{also broken');

        expect(() => applyClaudeHeadlessGrants(home)).not.toThrow();
        expect(readJson('.claude.json').bypassPermissionsModeAccepted).toBe(true);
        // 损坏的 settings.json 不盲目重建（避免丢失用户不可恢复的内容），本次跳过
        expect(fs.readFileSync(path.join(home, 'settings.json'), 'utf-8')).toBe('{also broken');
    });
});
