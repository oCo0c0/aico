/**
 * 桌面版（Electron）注入的全局 API 类型声明
 *
 * 由 src/electron/preload.ts 经 contextBridge 暴露；
 * 浏览器环境该对象不存在，业务代码应以 window.adwDesktop?. 形式访问。
 */

export {};

declare global {
    interface Window {
        adwDesktop?: {
            /** 同步窗口控制按钮覆盖层配色（已弃用覆盖层，保留为 no-op） */
            setWindowControlsTheme: (mode: 'light' | 'dark') => void;
            /** 显示/隐藏桌面宠物悬浮窗（透明置顶小窗；非桌面端为 no-op） */
            setPetVisible: (visible: boolean) => void;
            /** 自绘窗口控制按钮：最小化 / 最大化切换 / 关闭（走既有关闭行为询问） */
            windowControl: (action: 'minimize' | 'toggle-maximize' | 'close') => void;
            /** 订阅主窗口最大化状态变化，返回取消订阅函数 */
            onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
            /** 上报主窗口输入活动（鼠标点击；键盘由主进程直接捕获） */
            notifyInputActivity: (kind: 'mouse') => void;
            /** 宠物窗口订阅输入镜像事件（Bongo Cat 敲击），返回取消订阅函数 */
            onPetInput: (callback: (input: { kind: 'key' | 'mouse'; side: 'left' | 'right' }) => void) => () => void;
            /** 订阅自动更新状态推送（主进程静默检查 + 6h 轮询），返回取消订阅函数 */
            onUpdateState: (callback: (state: UpdateState) => void) => () => void;
            /** 手动触发检查更新（结果同样经 onUpdateState 推送） */
            checkForUpdate: () => void;
            /** 安装已下载的更新（退出并启动安装器；仅 downloaded 状态下生效） */
            installUpdate: () => void;
        };
    }

    /**
     * 自动更新状态（与 src/electron/update-support.ts 的 UpdateState 同构副本——
     * 本声明文件属 client 编译范围，不直接 import electron 侧模块；改形状时两边同步）
     */
    interface UpdateState {
        status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
        /** 相关版本号（available/not-available/downloaded 时携带） */
        version?: string;
        /** 下载进度百分比（downloading 时携带） */
        percent?: number;
        /** 错误摘要（error 时携带） */
        message?: string;
    }
}
