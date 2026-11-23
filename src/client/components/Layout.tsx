/**
 * @file Layout.tsx
 * @description 应用主布局组件 —— 提供侧边栏导航 + 顶部工具栏 + 内容区域的经典三栏式布局结构。
 *
 * 职责包括：
 * - 侧边栏：展示导航菜单项、Logo 区域、WebSocket 连接状态指示器
 * - 顶部栏：页面标题、侧边栏折叠/展开切换按钮、语言切换、明暗主题切换按钮
 * - 内容区域：通过 React Router 的 <Outlet /> 渲染当前路由对应的子页面
 * - 响应式处理：窗口宽度小于 1024px 时自动折叠侧边栏
 * - 全局初始化：启动 WebSocket 连接、注册键盘快捷键
 */

import {Suspense, lazy, useEffect, useState, type ComponentType} from 'react';
import {NavLink, Navigate, useLocation} from 'react-router-dom';
import {useTranslation} from 'react-i18next';
import {useAppStore, syncUiPreferences} from '../stores/app-store';
import {useKeyboardShortcuts} from '../hooks/useKeyboardShortcuts';
import {useWebSocket} from '../hooks/useWebSocket';
import {useResizableWidth, ResizeHandle} from '../hooks/useResizableWidth';
import {ActivePagePathnameContext} from '../hooks/usePageActive';
import SetupWizard from './SetupWizard';
import {cn} from '../lib/utils';
// 页面按路由级懒加载：首访才拉对应 chunk，主包不再包含全部 9 个页面
// （此前单 JS 1.35MB）。keep-alive 语义不变——首次挂载后常驻。
const RequirementsPage = lazy(() => import('../pages/RequirementsPage'));
const WorkspacePage = lazy(() => import('../pages/WorkspacePage'));
const PipelineRunPage = lazy(() => import('../pages/PipelineRunPage'));
const TestsPage = lazy(() => import('../pages/TestsPage'));
const PipelinesPage = lazy(() => import('../pages/PipelinesPage'));
const MinerUPage = lazy(() => import('../pages/MinerUPage'));
const ProjectsPage = lazy(() => import('../pages/ProjectsPage'));
const AgentExecutionPage = lazy(() => import('../pages/AgentExecutionPage'));
const SettingsPage = lazy(() => import('../pages/SettingsPage'));
import {
    FileText,
    FolderOpen,
    Layers,
    TestTube,
    GitBranch,
    PanelLeftClose,
    PanelLeft,
    Palette,
    FileSearch,
    Languages,
    Bot,
    Terminal,
    Cpu,
    Sparkles,
    Settings,
} from 'lucide-react';
import {ProviderSetupModal} from './ProviderSetupModal';
import {ModelConfigModal} from './ModelConfigModal';
import WallpaperLayer from './wallpaper/WallpaperLayer';
import {useWallpaperStore} from '../stores/wallpaper-store';
import {FloatingSettingsPanel} from './quick-settings/FloatingSettingsPanel';
import {MascotWidget} from './mascot/MascotWidget';
import {UpdateNotice} from './UpdateNotice';
import {WindowControls} from './WindowControls';

/**
 * Keep-alive 常驻页面表：所有主页面一次性挂载，切换导航仅切换可见性，
 * 不卸载组件——切走再切回时页面保持原样（选中的需求/执行、滚动位置、输入内容都保留），
 * 运行中的任务轮询在后台继续，通知也能跨页面触发。
 */
const KEEP_ALIVE_PAGES: Array<{ key: string; match: (p: string) => boolean; component: ComponentType }> = [
    {key: '/', match: (p) => p === '/', component: RequirementsPage},
    {key: '/agent-execution', match: (p) => p === '/agent-execution', component: AgentExecutionPage},
    {key: '/pipeline-run', match: (p) => p === '/pipeline-run', component: PipelineRunPage},
    {key: '/tests', match: (p) => p === '/tests', component: TestsPage},
    {key: '/settings', match: (p) => p.startsWith('/settings'), component: SettingsPage},
    {key: '/pipelines', match: (p) => p === '/pipelines', component: PipelinesPage},
    {key: '/mineru', match: (p) => p === '/mineru', component: MinerUPage},
    {key: '/workspace', match: (p) => p === '/workspace', component: WorkspacePage},
    {key: '/projects', match: (p) => p === '/projects', component: ProjectsPage},
];

/** 旧路由 → 新路由重定向（原 main.tsx 内的路由重定向移到布局层处理） */
const REDIRECTS: Record<string, string> = {
    '/mcp': '/settings/mcp',
    '/skills': '/settings/skills',
    '/model-providers': '/settings/model-providers',
};

/**
 * 侧边栏导航菜单项配置数组
 */
const navItems = [
    {path: '/', labelKey: 'nav.requirements', icon: FileText},
    // 工作区/项目空间已改造：工作区改为各页面内嵌预览侧边栏，项目空间下线；
    // 路由与页面代码保留，仅不再在侧边栏展示
    // {path: '/workspace', labelKey: 'nav.workspace', icon: FolderOpen},
    {path: '/agent-execution', labelKey: 'nav.agentExecution', icon: Bot},
    {path: '/pipelines', labelKey: 'nav.pipelines', icon: GitBranch},
    // 开发计划 + 代码执行已合并为「计划与执行」合页
    {path: '/pipeline-run', labelKey: 'nav.pipelineRun', icon: Layers},
    {path: '/tests', labelKey: 'nav.tests', icon: TestTube},
    // 模型供应商 / MCP / Skills 三项已迁入设置中心（侧边栏底部设置按钮 → /settings）
    // {path: '/projects', labelKey: 'nav.projects', icon: FolderKanban},
    {path: '/mineru', labelKey: 'nav.mineru', icon: FileSearch},
];

/**
 * 页面路由路径到 i18n key 的映射表
 */
const pageTitleKeys: Record<string, string> = {
    '/': 'pageTitle.requirements',
    '/projects': 'pageTitle.projects',
    '/workspace': 'pageTitle.workspace',
    '/agent-execution': 'pageTitle.agentExecution',
    '/pipeline-run': 'pageTitle.pipelineRun',
    '/tests': 'pageTitle.tests',
    '/settings': 'pageTitle.settings',
    '/pipelines': 'pageTitle.pipelines',
    '/mineru': 'pageTitle.mineru',
};

/**
 * 主题切换器选项（id 对应 Theme 类型；swatch 为色块预览色）
 * 注：完整外观调节已迁至悬浮快捷设置面板（FloatingSettingsPanel），
 * 顶栏调色按钮直达面板；此处仅保留主题明暗语义供类型引用。
 */

/**
 * 主布局组件
 */
export default function Layout() {
    const {t, i18n} = useTranslation();
    const sidebarCollapsed = useAppStore((s) => s.ui.sidebarCollapsed);
    const toggleSidebar = useAppStore((s) => s.toggleSidebar);
    const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
    // 菜单宽度可拖拽：默认比原先（220）更窄，把宽度留给消息输出区
    const {
        width: sidebarWidth,
        dragging: draggingSidebar,
        onHandlePointerDown: onSidebarHandleDown,
        reset: resetSidebarWidth,
    } = useResizableWidth('adw.sidebar.width', 176, {min: 140, max: 320});
    const locale = useAppStore((s) => s.ui.locale);
    const setLocale = useAppStore((s) => s.setLocale);
    const mascotEnabled = useAppStore((s) => s.ui.mascot.enabled);
    const quickSettingsOpen = useAppStore((s) => s.ui.quickSettings.open);
    const setQuickSettingsOpen = useAppStore((s) => s.setQuickSettingsOpen);
    const wsConnected = useAppStore((s) => s.ws.connected);
    const cliProvider = useAppStore((s) => s.cliProvider);
    const setCliProvider = useAppStore((s) => s.setCliProvider);
    const setShowSetupModal = useAppStore((s) => s.setShowSetupModal);
    const setShowModelConfigModal = useAppStore((s) => s.setShowModelConfigModal);
    const fetchModelConfig = useAppStore((s) => s.fetchModelConfig);
    const fetchAvailableModels = useAppStore((s) => s.fetchAvailableModels);
    const providerCatalog = useAppStore((s) => s.providerCatalog);
    const availableModels = useAppStore((s) => s.availableModels);

    const location = useLocation();

    // keep-alive 首访挂载：已访问过的页面 key 集合（初始含当前路由所在页）
    const [mountedKeys, setMountedKeys] = useState<Set<string>>(
        () => new Set(KEEP_ALIVE_PAGES.filter(({match}) => match(location.pathname)).map(({key}) => key)),
    );
    useEffect(() => {
        setMountedKeys((prev) => {
            const next = KEEP_ALIVE_PAGES.filter(({match}) => match(location.pathname)).map(({key}) => key);
            const missing = next.filter((k) => !prev.has(k));
            if (missing.length === 0) return prev;
            const merged = new Set(prev);
            missing.forEach((k) => merged.add(k));
            return merged;
        });
    }, [location.pathname]);

    useWebSocket();
    useKeyboardShortcuts();

    // 壁纸层：启动初始化（localStorage 缓存先行回显 → 服务端设置合并）。
    // init 内部幂等，StrictMode 双挂载安全。
    const initWallpaper = useWallpaperStore(s => s.init);
    useEffect(() => {
        void initWallpaper();
    }, [initWallpaper]);

    // 吉祥物：偏好开关 → 桌面宠物悬浮窗显隐（Electron；Web 端由 MascotWidget 自行消费）
    useEffect(() => {
        window.adwDesktop?.setPetVisible?.(mascotEnabled);
    }, [mascotEnabled]);

    // 吉祥物输入镜像：鼠标点击上报给宠物窗（键盘由主进程 before-input-event 直接捕获）
    useEffect(() => {
        if (!mascotEnabled) return;
        const onMouseDown = () => window.adwDesktop?.notifyInputActivity?.('mouse');
        window.addEventListener('mousedown', onMouseDown, true);
        return () => window.removeEventListener('mousedown', onMouseDown, true);
    }, [mascotEnabled]);

    // UI 偏好跨来源同步：localStorage 秒开 → 服务端为准合并 → 变更防抖回写。
    // 解决 dev(5173)/生产 electron(随机端口)/浏览器(3000) 各自 localStorage 隔离
    // 导致「设置不一致/换端口设置丢失」的问题
    useEffect(() => {
        syncUiPreferences();
    }, []);

    // 应用启动时加载模型配置和可用模型列表（串行避免覆盖）
    useEffect(() => {
        (async () => {
            await fetchModelConfig();
            await fetchAvailableModels();
        })();
    }, [fetchModelConfig, fetchAvailableModels]);

    useEffect(() => {
        function handleResize() {
            if (window.innerWidth < 1024) {
                setSidebarCollapsed(true);
            }
        }

        handleResize();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [setSidebarCollapsed]);

    // 顶栏标题：优先精确匹配路由；/settings/:section（含未知 section）统一显示设置标题
    const currentTitle = t(
        pageTitleKeys[location.pathname]
        ?? (location.pathname.startsWith('/settings/') ? pageTitleKeys['/settings'] : undefined)
        ?? 'common.appTitle'
    );

    const handleToggleLocale = () => {
        const next = locale === 'zh' ? 'en' : 'zh';
        setLocale(next);
        i18n.changeLanguage(next);
    };

    // 旧路由（/mcp /skills /model-providers 等）重定向到设置页对应分类
    const redirectTo = REDIRECTS[location.pathname];
    if (redirectTo) {
        return <Navigate to={redirectTo} replace/>;
    }

    return (
        <div className="flex h-screen overflow-hidden bg-transparent text-foreground">
            <SetupWizard/>
            {/* 壁纸层：界面后方的固定图层（z -2 壁纸 + z -1 遮罩），portal 到 body */}
            <WallpaperLayer/>

            {/* 侧边栏：宽度可拖拽（默认更窄，把空间留给消息输出区） */}
            <aside
                className={cn(
                    'relative flex flex-col border-r border-border/50 glass-sidebar',
                    !draggingSidebar && 'transition-[width] duration-200 ease-out',
                    sidebarCollapsed ? 'w-[52px]' : ''
                )}
                style={sidebarCollapsed ? undefined : {width: sidebarWidth}}
            >
                {!sidebarCollapsed && (
                    <ResizeHandle
                        dragging={draggingSidebar}
                        onPointerDown={onSidebarHandleDown}
                        onDoubleClick={resetSidebarWidth}
                        title="拖动调整菜单宽度（双击恢复默认）"
                    />
                )}
                <div className="flex h-11 items-center border-b border-border/50 px-3 app-drag app-titlebar">
                    {!sidebarCollapsed && (
                        <div className="flex items-center gap-2">
                            <img
                                src="/logo.png"
                                alt="logo"
                                className="h-7 w-7 rounded-xl object-cover shrink-0 ring-2 ring-primary/40 shadow-md shadow-primary/20"
                            />
                            <span className="text-sm font-semibold tracking-tight">{t('common.appTitle')}</span>
                        </div>
                    )}
                    {sidebarCollapsed && (
                        <img
                            src="/logo.png"
                            alt="logo"
                            className="h-7 w-7 rounded-xl object-cover mx-auto"
                        />
                    )}
                </div>

                <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
                    {navItems.map((item) => {
                        const Icon = item.icon;
                        const label = t(item.labelKey);
                        return (
                            <NavLink
                                key={item.path}
                                to={item.path}
                                end={item.path === '/'}
                                className={({isActive}) =>
                                    cn(
                                        'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200',
                                        isActive
                                            ? 'brand-gradient-soft text-primary'
                                            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                                    )
                                }
                                title={sidebarCollapsed ? label : undefined}
                            >
                                {({isActive}) => (
                                    <>
                                        {isActive && (
                                            <span
                                                className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-r-full brand-gradient"/>
                                        )}
                                        <Icon
                                            className={cn('h-4 w-4 flex-shrink-0 transition-colors', isActive && 'text-primary')}/>
                                        {!sidebarCollapsed && <span className="truncate">{label}</span>}
                                    </>
                                )}
                            </NavLink>
                        );
                    })}
                </nav>

                <div className="border-t border-border/50 p-3 space-y-2">
                    {/* 设置中心入口（模型供应商/MCP/Skills 已迁入 /settings） */}
                    <NavLink
                        to="/settings"
                        className={({isActive}) =>
                            cn(
                                'flex items-center rounded-lg py-2 text-sm font-medium transition-all duration-200',
                                sidebarCollapsed ? 'justify-center' : 'gap-3 px-3',
                                isActive
                                    ? 'brand-gradient-soft text-primary'
                                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                            )
                        }
                        title={t('nav.settings')}
                    >
                        {({isActive}) => (
                            <>
                                <Settings
                                    className={cn('h-4 w-4 shrink-0 transition-colors', isActive && 'text-primary')}
                                />
                                {!sidebarCollapsed && <span className="truncate">{t('nav.settings')}</span>}
                            </>
                        )}
                    </NavLink>
                    <div className="flex items-center justify-center gap-2">
                        <span
                            className={cn(
                                'h-2 w-2 rounded-full',
                                wsConnected ? 'bg-emerald-500' : 'bg-red-500'
                            )}
                        />
                        {!sidebarCollapsed && (
                            <span className="text-xs text-muted-foreground">
                                {wsConnected ? t('common.connected') : t('common.disconnected')}
                            </span>
                        )}
                    </div>
                </div>
            </aside>

            {/* 主内容区域 */}
            <div className="flex flex-1 flex-col overflow-hidden">
                <header
                    className="relative z-50 flex h-11 items-center justify-between border-b border-border/50 glass px-3 app-drag app-titlebar">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={toggleSidebar}
                            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-all duration-200 app-no-drag"
                            title={sidebarCollapsed ? t('common.expandSidebar') : t('common.collapseSidebar')}
                        >
                            {sidebarCollapsed ? (
                                <PanelLeft className="h-4 w-4"/>
                            ) : (
                                <PanelLeftClose className="h-4 w-4"/>
                            )}
                        </button>
                        <div className="h-4 w-px bg-border"/>
                        <h1 className="text-sm font-semibold brand-gradient-text">{currentTitle}</h1>
                    </div>
                    <div className="flex items-center gap-2 titlebar-safe-right">
                        {/* CLI Provider 切换 */}
                        <button
                            onClick={() => setShowSetupModal(true)}
                            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-all duration-200 text-xs font-medium app-no-drag"
                            title={t('common.switchProvider')}
                        >
                            {cliProvider.active === 'codex'
                                ? <Terminal className="h-4 w-4"/>
                                : cliProvider.active === 'pi'
                                    ? <Sparkles className="h-4 w-4"/>
                                    : <Bot className="h-4 w-4"/>
                            }
                            <span className="hidden sm:inline">
                                {providerCatalog.find(p => p.id === cliProvider.active)?.label ?? cliProvider.active}
                            </span>
                        </button>
                        {/* 模型配置 */}
                        <button
                            onClick={() => setShowModelConfigModal(true)}
                            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-all duration-200 text-xs font-medium app-no-drag"
                            title="模型配置"
                        >
                            <Cpu className="h-4 w-4"/>
                            <span className="hidden md:inline">
                                {(() => {
                                    const rawModel = cliProvider.modelConfig[cliProvider.active]?.model || '未配置';
                                    // 档位别名解析为实际模型名（有 tiers 的 Provider 才有别名）
                                    const tier = availableModels[cliProvider.active]?.tiers?.find(
                                        t => t.value === rawModel
                                    );
                                    return tier ? tier.model : rawModel;
                                })()}
                            </span>
                        </button>
                        {/* 语言切换 */}
                        <button
                            onClick={handleToggleLocale}
                            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-all duration-200 text-xs font-medium app-no-drag"
                            title={locale === 'zh' ? 'Switch to English' : '切换到中文'}
                        >
                            <Languages className="h-4 w-4"/>
                        </button>
                        {/* 快捷设置（外观/壁纸/字体/吉祥物/效果/高级 悬浮面板）：
                            toggle 语义 —— 面板开着时点按即收起（外点关闭的触发按钮例外） */}
                        <button
                            onClick={() => setQuickSettingsOpen(!quickSettingsOpen)}
                            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-all duration-200 app-no-drag"
                            title={t('settings.qs.title')}
                        >
                            <Palette className="h-4 w-4"/>
                        </button>
                        {/* 自绘窗口控制按钮（仅桌面端渲染；替代不透明的原生覆盖层，
                            让顶栏毛玻璃/壁纸透明效果不被盖死） */}
                        <WindowControls/>
                    </div>
                </header>

                {/* ====== 内容区：keep-alive 常驻页面，切换导航只切可见性不卸载 ======
                    各页面 wrapper 为绝对定位铺满，非活跃页 visibility:hidden 保留 DOM
                    与滚动位置；旧路由重定向在组件树顶部处理。
                    首访挂载：未访问过的页面不挂载也不拉 chunk（配合路由级 lazy，
                    首屏只加载当前页）；访问过即常驻，keep-alive 语义不变。
                    活跃路由经 Context 广播，供各页轮询做暂停判定。 */}
                <div className="relative flex-1 min-h-0">
                    <ActivePagePathnameContext.Provider value={location.pathname}>
                        {KEEP_ALIVE_PAGES.map(({key, match, component: Page}) => {
                            const active = match(location.pathname);
                            if (!mountedKeys.has(key)) return null;
                            return (
                                <div
                                    key={key}
                                    className="absolute inset-0 flex flex-col overflow-hidden"
                                    style={{
                                        visibility: active ? 'visible' : 'hidden',
                                        pointerEvents: active ? 'auto' : 'none'
                                    }}
                                    aria-hidden={!active}
                                >
                                    <Suspense fallback={
                                        <div
                                            className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                                            Loading…
                                        </div>
                                    }>
                                        <Page/>
                                    </Suspense>
                                </div>
                            );
                        })}
                    </ActivePagePathnameContext.Provider>
                </div>
            </div>

            {/* CLI Provider 切换弹窗 */}
            <ProviderSetupModal
                open={cliProvider.showSetupModal}
                onClose={() => setShowSetupModal(false)}
                onSelected={(providerId) => {
                    setCliProvider(true, providerId);
                    setShowSetupModal(false);
                }}
                firstRun={!cliProvider.configured}
            />

            {/* 模型配置弹窗 */}
            <ModelConfigModal
                open={cliProvider.showModelConfigModal}
                onClose={() => setShowModelConfigModal(false)}
            />

            {/* 悬浮快捷设置面板（壁纸/外观/字体/吉祥物/效果/高级） */}
            <FloatingSettingsPanel/>

            {/* 桌面版自动更新提示（下载进度/安装就绪，仅 Electron 环境渲染） */}
            <UpdateNotice/>

            {/* 吉祥物：Web 端应用内右下角 Bongo Cat（桌面端另有独立悬浮窗） */}
            <MascotWidget/>
        </div>
    );
}
