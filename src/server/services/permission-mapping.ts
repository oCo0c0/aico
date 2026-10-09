/**
 * @file permission-mapping.ts
 * @description 全局权限模式到各引擎参数的映射（纯函数）。
 *   claude：confirm 需要确认 UI（onPermissionRequest）才能生效，否则退化为 acceptEdits；
 *   pi：只有 confirm/auto-allow 两档，acceptEdits 视作自动放行。
 */
export type PermissionMode = 'confirm' | 'acceptEdits' | 'bypassPermissions';

export function resolveClaudePermission(
    mode: PermissionMode,
    hasPermissionHandler: boolean,
): {permissionMode: string; permissionEnabled: boolean; allowDangerouslySkipPermissions?: boolean} {
    if (mode === 'bypassPermissions') {
        // 无头（--print）下 CLI 会把 bypassPermissions 降级为 default，除非显式
        // 接受免责声明：--allow-dangerously-skip-permissions（SDK 选项
        // allowDangerouslySkipPermissions）。缺了它 MCP 工具全部走到 ask 分支，
        // 无头自动拒绝（"you haven't granted it yet"）——2026-10-08 二进制逆向确认。
        return {permissionMode: 'bypassPermissions', permissionEnabled: false, allowDangerouslySkipPermissions: true};
    }
    if (mode === 'confirm') {
        // confirm 档映射到 Claude CLI 的 default（询问）；无确认 UI 时退化为 acceptEdits
        return hasPermissionHandler
            ? {permissionMode: 'default', permissionEnabled: true}
            : {permissionMode: 'acceptEdits', permissionEnabled: false};
    }
    return {permissionMode: mode, permissionEnabled: hasPermissionHandler};
}

export function resolvePiPermissionMode(mode: PermissionMode, hasPermissionHandler: boolean): 'confirm' | 'auto-allow' {
    return mode === 'confirm' && hasPermissionHandler ? 'confirm' : 'auto-allow';
}
