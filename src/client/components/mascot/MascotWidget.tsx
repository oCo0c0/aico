/**
 * @file MascotWidget.tsx
 * @description 应用内吉祥物悬浮组件（**仅 Web 模式**降级宿主）
 *
 * - 桌面端（Electron）不渲染 —— 宠物只保留独立透明悬浮窗（PetRoot），避免双份；
 * - Web 模式为**可拖动悬浮球**：按住拖到页面任意位置（中心点视口百分比记忆，
 *   localStorage + /api/ui-preferences 双路持久化），双击复位默认角落；
 *   默认位置悬在输入框上方（bottom-40），不再遮挡发送/放大等按钮；
 * - 两路敲击：agent 活动流 + 用户输入镜像（键盘/鼠标直改 class）；
 * - 状态气泡 + 形象/大小/气泡偏好来自 app-store 的 ui.mascot。
 */
import {useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {useAppStore} from '../../stores/app-store';
import {useAgentActivity} from '../../hooks/useAgentActivity';
import {isModifierOnly, pawSideOfCode} from '../../lib/paw-side';
import {PetAvatar} from './pets';
import {tapPaw} from './paw-tap';

/** 双击复位判定窗口（ms） */
const DOUBLE_TAP_MS = 350;
/** 拖动触发阈值（px）：按下-抬起位移小于此值视为点击（敲击动画照旧） */
const DRAG_THRESHOLD = 4;

/** 中心点百分比夹取：保证容器（spanPx）整体留在视口内 */
function clampCenterPct(pct: number, spanPx: number, viewportPx: number): number {
    if (viewportPx <= 0) return pct;
    const half = Math.min(spanPx / 2 / viewportPx * 100, 50);
    return Math.min(100 - half, Math.max(half, pct));
}

export function MascotWidget() {
    const {t} = useTranslation();
    const enabled = useAppStore(s => s.ui.mascot.enabled);
    const size = useAppStore(s => s.ui.mascot.size);
    const bubble = useAppStore(s => s.ui.mascot.bubble);
    const form = useAppStore(s => s.ui.mascot.form);
    const position = useAppStore(s => s.ui.mascot.position);
    const setMascot = useAppStore(s => s.setMascot);
    const activity = useAgentActivity();
    const containerRef = useRef<HTMLDivElement>(null);
    const parityRef = useRef(false);
    /** 拖动中的实时位置（中心点百分比）；null = 未在拖动，渲染 store 的 position */
    const [dragPos, setDragPos] = useState<{xPct: number; yPct: number} | null>(null);
    const dragPosRef = useRef<{xPct: number; yPct: number} | null>(null);
    const lastTapRef = useRef(0);

    // 桌面端只保留独立悬浮窗（用户要求：应用内不再出现第二只）；Web 才降级显示
    const isDesktop = typeof window !== 'undefined' && Boolean(window.adwDesktop);
    const showWidget = enabled && !isDesktop;

    // Web：用户输入镜像（应用内键盘/鼠标直接监听；hook 无条件调用满足规则）
    useEffect(() => {
        if (!showWidget) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.isComposing || isModifierOnly(e.code)) return;
            parityRef.current = !parityRef.current;
            tapPaw(containerRef.current, pawSideOfCode(e.code, parityRef.current));
        };
        const onMouseDown = () => {
            parityRef.current = !parityRef.current;
            tapPaw(containerRef.current, parityRef.current ? 'left' : 'right');
        };
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('mousedown', onMouseDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('mousedown', onMouseDown, true);
        };
    }, [showWidget]);

    if (!showWidget) return null;

    const width = 150 * size;
    const dragging = dragPos != null;

    // 位置渲染：拖动实时值 > 记忆值（百分比 + 出视口夹取） > 默认右下角（bottom-56 彻底让开输入框工具栏）
    const eff = dragPos ?? position;
    const posStyle: CSSProperties = eff
        ? {
            left: `${clampCenterPct(eff.xPct, width + 8, window.innerWidth)}%`,
            top: `${clampCenterPct(eff.yPct, width / 2 + 44, window.innerHeight)}%`,
            right: 'auto',
            bottom: 'auto',
            transform: 'translate(-50%, -50%)',
        }
        : {};

    // 按住拖动（pointer 统一鼠标/触摸）：基点取按下时容器 rect 的实际中心，
    // 默认定位（right/bottom）与百分比定位统一换算成百分比；保持抓取偏移手感
    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        // 双击：复位到默认角落
        const now = Date.now();
        if (now - lastTapRef.current < DOUBLE_TAP_MS) {
            lastTapRef.current = 0;
            dragPosRef.current = null;
            setDragPos(null);
            setMascot({position: null});
            return;
        }
        lastTapRef.current = now;
        e.preventDefault(); // 阻止拖动时选中页面文本（不影响 mousedown 派发，tapPaw 照常）
        const startX = e.clientX;
        const startY = e.clientY;
        const baseXPct = (rect.left + rect.width / 2) / window.innerWidth * 100;
        const baseYPct = (rect.top + rect.height / 2) / window.innerHeight * 100;
        const grabDx = startX - (rect.left + rect.width / 2);
        const grabDy = startY - (rect.top + rect.height / 2);
        let moved = false;
        const onMove = (ev: globalThis.PointerEvent) => {
            if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
            moved = true;
            const next = {
                xPct: clampCenterPct(baseXPct + (ev.clientX - grabDx) / window.innerWidth * 100, rect.width, window.innerWidth),
                yPct: clampCenterPct(baseYPct + (ev.clientY - grabDy) / window.innerHeight * 100, rect.height, window.innerHeight),
            };
            dragPosRef.current = next;
            setDragPos(next);
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            if (moved) {
                // 松手提交：位置记忆走 app-store（localStorage + ui-preferences 同步自动跟随）
                setMascot({position: dragPosRef.current});
            }
            dragPosRef.current = null;
            setDragPos(null);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    };

    return (
        <div
            ref={containerRef}
            className={`fixed right-4 bottom-56 z-[90] flex flex-col items-center gap-1 select-none
                ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            style={{width, touchAction: 'none', ...posStyle}}
            onPointerDown={onPointerDown}
            title={t('settings.mascot.dragHint')}
        >
            {bubble && activity.labelKey && (
                <div
                    className="glass-card max-w-full truncate rounded-xl px-3 py-1.5 text-xs font-medium shadow-apple"
                    title={t(activity.labelKey)}
                >
                    {t(activity.labelKey)}
                </div>
            )}
            <PetAvatar form={form} mood={activity.mood} width={width} className="drop-shadow-apple"/>
        </div>
    );
}
