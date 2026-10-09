import {describe, it, expect} from 'vitest';
import {resolveClaudePermission, resolvePiPermissionMode} from './permission-mapping.js';

describe('resolveClaudePermission', () => {
    it('bypass：完全放行，不注入确认回调，且携带无头免责声明 flag', () => {
        expect(resolveClaudePermission('bypassPermissions', true))
            .toEqual({permissionMode: 'bypassPermissions', permissionEnabled: false, allowDangerouslySkipPermissions: true});
    });
    it('confirm + 有确认 UI：default + 启用回调', () => {
        expect(resolveClaudePermission('confirm', true))
            .toEqual({permissionMode: 'default', permissionEnabled: true});
    });
    it('confirm + 无确认 UI（经典流程）：退化为 acceptEdits，不启用回调', () => {
        expect(resolveClaudePermission('confirm', false))
            .toEqual({permissionMode: 'acceptEdits', permissionEnabled: false});
    });
    it('acceptEdits：接受编辑，回调按调用方决定', () => {
        expect(resolveClaudePermission('acceptEdits', true))
            .toEqual({permissionMode: 'acceptEdits', permissionEnabled: true});
        expect(resolveClaudePermission('acceptEdits', false))
            .toEqual({permissionMode: 'acceptEdits', permissionEnabled: false});
    });
});

describe('resolvePiPermissionMode', () => {
    it('confirm + 有确认 UI 才用 confirm，否则 auto-allow', () => {
        expect(resolvePiPermissionMode('confirm', true)).toBe('confirm');
        expect(resolvePiPermissionMode('confirm', false)).toBe('auto-allow');
        expect(resolvePiPermissionMode('acceptEdits', true)).toBe('auto-allow');
        expect(resolvePiPermissionMode('bypassPermissions', false)).toBe('auto-allow');
    });
});
