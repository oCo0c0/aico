/**
 * @file usePageActive
 * @description keep-alive 常驻页面的「是否活跃」感知。
 *
 * Layout 把全部主页面一次性挂载、切导航只切 visibility，页面不知道自己是
 * 否处于前台——各页的后台轮询因此永不停歇（9 个页面 1.5-2s 轮询同时在跑）。
 *
 * Layout 在每个 keep-alive 页的 wrapper 上用 PageActiveContext 广播**该页**
 * 的活跃布尔值（每页一个 Provider，值只在切进/切出该页时变化）；页面用本 hook
 * 拿一个 **ref 形式** 的活跃判定（读 ref 不需要进依赖数组，轮询回调内随手调用
 * 即可，不会产生过期闭包），同时叠加浏览器标签页整体隐藏（document.visibilityState）
 * 的暂停语义。
 *
 * 历史：最初广播的是全局 pathname（每次导航必变），7 个消费页在每次切 tab 时
 * 都被迫整体 re-render（重日志页 reconciler 全量白算一遍）。改为按页布尔值后，
 * 页面只在自己切进/切出的瞬间重渲染一次（ref 也借这次渲染更新到最新值）。
 *
 * 用法：
 *   const isActive = usePageActiveRef();
 *   // 轮询回调内：
 *   const poll = async () => {
 *     if (!isActive()) return;  // 非活跃页/隐藏标签页跳过本轮
 *     ...
 *   };
 */

import {createContext, useContext, useRef} from 'react';

/**
 * 当前页面是否处于前台（Layout 在每个 keep-alive 页 wrapper 上提供值；
 * 缺省 true 兼容未包裹 Provider 的场景——如 keep-alive 之外的旧路由页）。
 */
export const PageActiveContext = createContext<boolean>(true);

/**
 * 返回一个稳定的活跃判定函数（ref 语义，永远读到最新值）。
 * 活跃 = 所在 keep-alive 页处于前台 && 浏览器标签页可见。
 */
export function usePageActiveRef(): () => boolean {
    const active = useContext(PageActiveContext);
    const activeRef = useRef(active);
    activeRef.current = active;
    return () => activeRef.current && document.visibilityState !== 'hidden';
}
