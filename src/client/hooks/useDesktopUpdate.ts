/**
 * 桌面版自动更新状态 Hook
 *
 * 订阅主进程推送的更新状态（启动静默检查 + 6h 轮询 + 手动检查），
 * 返回当前状态与手动动作。浏览器/Web 模式下 window.adwDesktop 不存在，
 * 返回固定 idle 状态且动作为 no-op —— 调用方据此隐藏更新 UI。
 *
 * isManualCheck 标记最近一次检查是否用户手动触发（check() 置位，任何非 error
 * 状态流转复位）——静默轮询的失败不该打扰用户，只有手动检查的错误才浮出展示。
 *
 * 用途：UpdateNotice 悬浮条（下载完成提示重启）+ 设置中心「版本与更新」区。
 */

import {useCallback, useEffect, useState} from 'react';
// UpdateState 由 types/desktop.d.ts 的 declare global 提供（全局环境类型，无需 import）

/** Web 模式 / 无更新信息时的空闲占位 */
const IDLE_STATE: UpdateState = {status: 'not-available'};

export interface DesktopUpdateApi {
    /** 当前更新状态（desktop 下来自主进程；web 下恒为 not-available） */
    state: UpdateState;
    /** 是否桌面环境（决定更新 UI 显隐） */
    isDesktop: boolean;
    /** 最近一次检查是否用户手动触发（决定 error 状态是否展示） */
    isManualCheck: boolean;
    /** 手动触发检查更新（置位 isManualCheck） */
    check: () => void;
    /** 重启并安装已下载的更新 */
    install: () => void;
}

export function useDesktopUpdate(): DesktopUpdateApi {
    const [state, setState] = useState<UpdateState>(IDLE_STATE);
    const [isManualCheck, setIsManualCheck] = useState(false);
    const isDesktop = typeof window !== 'undefined' && Boolean(window.adwDesktop);

    useEffect(() => {
        const unsubscribe = window.adwDesktop?.onUpdateState((next) => {
            setState(next);
            // 任何非 error 状态流转都说明一次检查有了正常结果，手动标记复位
            if (next.status !== 'error') setIsManualCheck(false);
        });
        return () => unsubscribe?.();
    }, []);

    const check = useCallback(() => {
        setIsManualCheck(true);
        window.adwDesktop?.checkForUpdate();
    }, []);
    const install = useCallback(() => window.adwDesktop?.installUpdate(), []);

    return {state, isDesktop, isManualCheck, check, install};
}
