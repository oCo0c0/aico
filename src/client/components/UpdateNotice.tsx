/**
 * 桌面版更新提示条（仅 Electron 环境渲染）
 *
 * 状态驱动的左下角玻璃悬浮条：
 * - downloading：小胶囊显示进度百分比（不打扰，无按钮）
 * - downloaded：完整卡片「新版本已就绪」——立即重启安装 / 稍后（稍后不消失状态
 *   也不会丢：主进程 autoInstallOnAppQuit 兜底，退出时自动装）
 * - error：仅手动检查后的失败浮出，可关闭；静默轮询失败一律安静
 * 其余状态（checking/available/not-available）不渲染任何东西。
 * 安装动作走 adw:update-install IPC → 主进程 quitAndInstall（退出级联清理照常）。
 */

import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Download, RefreshCw, X} from 'lucide-react';
import {useDesktopUpdate} from '../hooks/useDesktopUpdate';

export function UpdateNotice() {
    const {t} = useTranslation();
    const {state, isDesktop, isManualCheck, install} = useDesktopUpdate();
    /** 「稍后」已点过：本会话不再弹安装卡片（状态不丢，退出时兜底安装） */
    const [dismissed, setDismissed] = useState(false);
    /** 手动检查的错误条是否被用户关掉 */
    const [errorClosed, setErrorClosed] = useState(false);

    if (!isDesktop) return null;

    // 下载中：轻量进度胶囊
    if (state.status === 'downloading') {
        return (
            <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full border border-border/60 bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur">
                <Download className="h-3.5 w-3.5 animate-pulse text-primary"/>
                <span>{t('update.downloading', {percent: state.percent ?? 0})}</span>
            </div>
        );
    }

    // 下载完成：可安装卡片（点「稍后」后收起，不阻塞退出时的自动安装兜底）
    if (state.status === 'downloaded' && !dismissed) {
        return (
            <div className="fixed bottom-4 left-4 z-50 flex items-center gap-3 rounded-xl border border-border/60 bg-card/95 px-4 py-3 shadow-xl backdrop-blur">
                <Download className="h-4 w-4 shrink-0 text-primary"/>
                <div className="text-sm">
                    <div className="font-medium text-foreground">
                        {t('update.readyTitle', {version: state.version ?? ''})}
                    </div>
                    <div className="text-xs text-muted-foreground">{t('update.readyDesc')}</div>
                </div>
                <button
                    type="button"
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    onClick={install}
                >
                    {t('update.installNow')}
                </button>
                <button
                    type="button"
                    className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => setDismissed(true)}
                >
                    {t('update.later')}
                </button>
            </div>
        );
    }

    // 手动检查失败：可关闭的错误条（静默轮询失败 isManualCheck=false，不进这里）
    if (state.status === 'error' && isManualCheck && !errorClosed) {
        return (
            <div className="fixed bottom-4 left-4 z-50 flex max-w-sm items-center gap-2 rounded-xl border border-destructive/40 bg-card/95 px-4 py-3 text-xs text-muted-foreground shadow-xl backdrop-blur">
                <RefreshCw className="h-3.5 w-3.5 shrink-0 text-destructive"/>
                <span className="break-all">{t('update.error', {message: state.message ?? ''})}</span>
                <button type="button" onClick={() => setErrorClosed(true)} className="shrink-0 text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5"/>
                </button>
            </div>
        );
    }

    return null;
}
