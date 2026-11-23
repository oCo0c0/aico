/**
 * @file usePageActive
 * @description keep-alive 常驻页面的「是否活跃」感知。
 *
 * Layout 把全部主页面一次性挂载、切导航只切 visibility，页面不知道自己是
 * 否处于前台——各页的后台轮询因此永不停歇（9 个页面 1.5-2s 轮询同时在跑）。
 * Layout 通过 ActivePagePathnameContext 广播当前路由；页面用本 hook 拿一个
 * **ref 形式** 的活跃判定（读 ref 不需要进依赖数组，轮询回调内随手调用即可，
 * 不会产生过期闭包），同时叠加浏览器标签页整体隐藏（document.visibilityState）
 * 的暂停语义。
 *
 * 用法：
 *   const isActive = usePageActiveRef((p) => p === '/tests');
 *   // 轮询回调内：
 *   const poll = async () => {
 *     if (!isActive()) return;  // 非活跃页/隐藏标签页跳过本轮
 *     ...
 *   };
 */

import {createContext, useContext, useRef} from 'react';

/** 当前活跃路由 pathname（Layout 提供值） */
export const ActivePagePathnameContext = createContext<string>(
    typeof window !== 'undefined' ? window.location.pathname : '/',
);

/**
 * 返回一个稳定的活跃判定函数（ref 语义，永远读到最新值）。
 * 活跃 = 页面路由命中 && 浏览器标签页可见。
 *
 * @param match - 页面的路由匹配规则（与 Layout KEEP_ALIVE_PAGES 的 match 一致）
 */
export function usePageActiveRef(match: (pathname: string) => boolean): () => boolean {
    const pathname = useContext(ActivePagePathnameContext);
    const activeRef = useRef(match(pathname));
    activeRef.current = match(pathname);
    return () => activeRef.current && document.visibilityState !== 'hidden';
}
