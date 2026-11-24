/**
 * @file 应用入口模块
 * @description Aico的前端入口文件，负责初始化 React 应用、
 *              配置客户端路由并挂载根组件到 DOM。
 *              路由采用「顶层重定向 + Layout 内 keep-alive 常驻页面」方案：
 *              所有主页面常驻挂载、切换导航仅切可见性，页面状态不丢失。
 *
 *              启动时检查 CLI Provider 是否已配置，未配置时弹出引导弹窗。
 */

import React, {useEffect} from 'react';
import ReactDOM from 'react-dom/client';
import {BrowserRouter, Routes, Route, Navigate} from 'react-router-dom';
import './i18n';
import './index.css';
import Layout from './components/Layout';
import PetRoot from './components/mascot/PetRoot';
import {useAppStore} from './stores/app-store';
import {apiGet} from './api';

/** Provider 状态查询响应 */
interface ProviderStatusResponse {
    configured: boolean;
    active: string;
    detected?: Array<{
        id: string;
        label: string;
        available: boolean;
        capabilities?: Record<string, boolean>;
        defaultModelSettings?: Record<string, unknown>;
        meta?: Record<string, unknown>;
    }>;
}

/**
 * 根组件 - 定义应用的路由结构 + CLI Provider 引导流程
 */
function App() {
    const {setCliProvider, setShowSetupModal, refreshProviderCatalog} = useAppStore();

    // 启动时检查 CLI Provider 配置状态
    useEffect(() => {
        apiGet<ProviderStatusResponse>('/system/cli-provider/status')
            .then(async (data) => {
                setCliProvider(data.configured, data.active);
                // Provider 目录与 pi 元数据统一走 store action（供应商配置页保存后也复用同一刷新入口）
                await refreshProviderCatalog();
                if (!data.configured) {
                    setShowSetupModal(true);
                }
            })
            .catch(() => {
                // 查询失败时使用默认配置，不阻塞应用启动
            });
    }, [setCliProvider, setShowSetupModal, refreshProviderCatalog]);

    return (
        <BrowserRouter>
            <Routes>
                {/* 旧路由重定向（在 Layout 之外，优先匹配） */}
                <Route path="/skills" element={<Navigate to="/settings/skills" replace/>}/>
                <Route path="/mcp" element={<Navigate to="/settings/mcp" replace/>}/>
                <Route path="/model-providers" element={<Navigate to="/settings/model-providers" replace/>}/>
                {/* 其余全部交给 Layout：内部 keep-alive 常驻渲染所有主页面，切换导航不卸载 */}
                <Route path="*" element={<Layout/>}/>
            </Routes>
        </BrowserRouter>
    );
}

// 获取 HTML 中的根挂载节点，以严格模式渲染 React 应用
// 桌面宠物悬浮窗分支：Electron 透明小窗以 ?pet=1 加载轻量页面（不挂路由/主界面）；
// 隐藏 body 背景与溢出，交由 PetRoot 自绘透明内容（见 index.css body.pet-window）
const isPetWindow = new URLSearchParams(window.location.search).get('pet') === '1';
const root = ReactDOM.createRoot(document.getElementById('root')!);
if (isPetWindow) {
    document.body.classList.add('pet-window');
    document.title = 'Aico Pet';
    root.render(
        <React.StrictMode>
            <PetRoot/>
        </React.StrictMode>
    );
} else {
    root.render(
        <React.StrictMode>
            <App/>
        </React.StrictMode>
    );
}
