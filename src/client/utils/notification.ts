/**
 * @file notification.ts
 * @description 任务结果通知：任务执行成功/失败时提示用户。
 *   优先走系统通知（Notification API）；权限被拒/不支持时降级为应用内 toast
 *   （右上角滑入，5s 自动消失），保证任何环境下都有可见反馈。
 *   开关读自 app-store 的 ui.notificationsEnabled（设置-外观内可切换）。
 */

import {useAppStore} from '../stores/app-store';

/** 任务结果通知状态映射 */
const STATUS_TITLE: Record<string, string> = {
    completed: '任务执行成功',
    failed: '任务执行失败',
    aborted: '任务已中止',
};

/** 状态对应的 toast 强调色 */
const STATUS_COLOR: Record<string, string> = {
    completed: '#10b981',
    failed: '#ef4444',
    aborted: '#f59e0b',
};

/** 系统通知：权限 granted 时弹出并点击聚焦；denied/不支持返回 false 走降级 */
function showSystemNotification(title: string, body?: string): boolean {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    const n = new Notification(title, {body});
    // 点击通知聚焦应用窗口并关闭气泡
    n.onclick = () => {
        window.focus();
        n.close();
    };
    return true;
}

/** 应用内 toast 降级：右上角滑入，5s 自动消失 */
function showToast(title: string, status: string): void {
    const host = document.createElement('div');
    host.style.cssText = [
        'position:fixed', 'top:16px', 'right:16px', 'z-index:9999',
        'display:flex', 'flex-direction:column', 'gap:8px', 'pointer-events:none',
    ].join(';');

    const accent = STATUS_COLOR[status] ?? '#71717a';
    const item = document.createElement('div');
    item.style.cssText = [
        'pointer-events:auto', 'cursor:pointer', 'min-width:240px', 'max-width:340px',
        'padding:12px 16px', 'border-radius:10px', 'font-size:13px', 'line-height:1.5',
        'background:rgba(24,24,27,0.92)', 'color:#fafafa',
        'border:1px solid rgba(255,255,255,0.12)', `border-left:3px solid ${accent}`,
        'box-shadow:0 8px 24px rgba(0,0,0,0.25)',
        'transform:translateX(24px)', 'opacity:0',
        'transition:transform .25s ease, opacity .25s ease',
    ].join(';');
    item.textContent = title;
    item.onclick = () => {
        window.focus();
        host.remove();
    };

    host.appendChild(item);
    document.body.appendChild(host);

    // 下一帧滑入
    requestAnimationFrame(() => {
        item.style.transform = 'translateX(0)';
        item.style.opacity = '1';
    });
    // 5s 后淡出移除
    setTimeout(() => {
        item.style.transform = 'translateX(24px)';
        item.style.opacity = '0';
        setTimeout(() => {
            host.remove();
        }, 300);
    }, 5000);
}

/**
 * 发送任务结果通知（开关关闭时静默跳过）
 * @param status - 任务结束状态（completed/failed/aborted）
 * @param taskName - 任务名称（通知正文）
 */
export function notifyTaskResult(status: string, taskName?: string): void {
    if (!useAppStore.getState().ui.notificationsEnabled) return;

    const title = taskName ? `${STATUS_TITLE[status] ?? '任务已结束'}：${taskName}` : (STATUS_TITLE[status] ?? '任务已结束');

    // Electron 下跳过系统通知：Windows 要求应用已安装（AppUserModelID + 开始菜单快捷方式）
    // 才能弹 toast，`electron .` 开发模式会被系统静默吞掉——直接用应用内 toast，稳定可见
    const isElectron = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);
    if (!isElectron && showSystemNotification(title)) return;
    showToast(title, status);
}

/**
 * 应用内错误提示（右上角 toast，5s 自动消失）。
 * 不受通知开关限制——操作失败的反馈必须可见，开关只管任务结果类通知。
 */
export function notifyError(message: string): void {
    showToast(message, 'failed');
}
