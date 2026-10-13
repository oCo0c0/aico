/**
 * @file pets.tsx
 * @description 吉祥物形象库 —— 轴伊 Joi 双衣装 + 轴芯鲸鱼娘（静态 2×2 精灵图，零运行时依赖）
 *
 * 素材来自开源主题项目 dsh-joi-channel-theme（github.com/tpmoonchefryan/dsh-joi-channel-theme），
 * 许可 CC BY-NC-SA 4.0（署名文件在 public/mascot/LICENSE-ASSETS.md / THIRD_PARTY_NOTICES.md）。
 * 每款形态一张 512×512 webp 四格精灵图（public/mascot/），格序与原主题一致：
 *   左上 [0,0]=待机 idle · 右上 [1,0]=开心 happy(success) · 左下 [0,1]=打字 typing(running) · 右下 [1,1]=难过 sad(error)
 *
 * 心情契约不变：mood: idle | typing | happy | sad（useAgentActivity 推导）；
 * 输入镜像仍走 paw-tap.ts 事件总线（onPetTap）→ 挤压/倾斜反馈动画。
 */
import {useEffect, useRef} from 'react';
import type {PetForm} from '../../stores/app-store';
import {onPetTap} from './paw-tap';

export type MascotMood = 'idle' | 'typing' | 'happy' | 'sad';

export const PET_FORMS: Array<{id: PetForm; labelKey: string}> = [
    {id: 'joi-flowers', labelKey: 'settings.mascot.formJoiFlowers'},
    {id: 'joi-library', labelKey: 'settings.mascot.formJoiLibrary'},
    {id: 'zhouxin', labelKey: 'settings.mascot.formZhouxin'},
];

/** 每款形态的 2×2 精灵图（public/mascot/ 下） */
const SHEET_OF: Record<PetForm, string> = {
    'joi-flowers': 'mascot/joi-flowers.webp',
    'joi-library': 'mascot/joi-library.webp',
    'zhouxin': 'mascot/zhouxin.webp',
};

/** 心情 → 精灵格（列, 行）——backgroundSize 200% 下 100% 恰好偏移一格 */
const CELL_OF: Record<MascotMood, [number, number]> = {
    idle: [0, 0],
    happy: [1, 0],
    typing: [0, 1],
    sad: [1, 1],
};

/**
 * 宠物形象统一入口（形态卡片预览 / Web 右下角组件 / 桌面悬浮窗共用）
 *
 * 渲染就是一个 div + background-position 换格：没有运行时、没有异步加载，
 * 图与代码同源静态资源，不存在「转圈加载不出来」的失败模式。
 */
export function PetAvatar({form, mood, width, className}: {
    form: PetForm;
    mood: MascotMood;
    width?: number;
    className?: string;
}) {
    const ref = useRef<HTMLDivElement>(null);

    // 输入镜像：敲击 → 摘/挂 class 重触发挤压动画（免 React 重渲染，快速输入不掉帧）
    useEffect(() => onPetTap((side) => {
        const el = ref.current;
        if (!el) return;
        el.classList.remove('joi-pet--tap-l', 'joi-pet--tap-r');
        void el.offsetWidth; // 强制 reflow 重启动画
        el.classList.add(side === 'left' ? 'joi-pet--tap-l' : 'joi-pet--tap-r');
    }), []);

    const [col, row] = CELL_OF[mood];
    return (
        <div
            ref={ref}
            className={`joi-pet${mood === 'typing' ? ' joi-pet--typing' : ''}${className ? ` ${className}` : ''}`}
            style={{
                width,
                height: width,
                backgroundImage: `url(${import.meta.env.BASE_URL}${SHEET_OF[form]})`,
                backgroundSize: '200% 200%',
                backgroundPosition: `${col * 100}% ${row * 100}%`,
            }}
        />
    );
}
