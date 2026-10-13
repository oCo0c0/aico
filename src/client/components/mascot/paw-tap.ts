/**
 * @file paw-tap.ts
 * @description 吉祥物「输入镜像敲击」的命令式触发 —— 事件总线直连渲染运行时，
 * 免去每次按键的 React 重渲染（快速输入时每秒可达 20+ 次敲击）。
 *
 * 历史：原自绘 SVG 形态用 .bongo-cat__paw--l/--r class 摘/挂重触发 CSS 动画；
 * 现形态（Joi 精灵图）没有左右爪 DOM 钩子，onPetTap 总线 → PetAvatar 挤压反馈动画。
 */

type PetTapListener = (side: 'left' | 'right') => void;

const listeners = new Set<PetTapListener>();

/** 订阅输入镜像敲击（PetAvatar 挂载时注册；返回退订函数） */
export function onPetTap(fn: PetTapListener): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

/**
 * 让吉祥物对指定侧的输入做出敲击反应
 * @param root 包含吉祥物的容器元素（保留参数兼容既有调用点；总线模式下不再需要）
 * @param side 左 / 右（由 paw-side.ts 的物理键盘分区或鼠标奇偶决定）
 */
export function tapPaw(root: HTMLElement | null, side: 'left' | 'right'): void {
    void root;
    for (const fn of listeners) {
        try {
            fn(side);
        } catch { /* 单个监听器异常不影响其他 */ }
    }
}
