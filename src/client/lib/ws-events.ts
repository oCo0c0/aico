/**
 * @file ws-events.ts
 * @description WebSocket → 页面 的类型化事件总线。
 *
 * 背景：服务端事件经 useWebSocket 分发到 Zustand store 之外，还有一部分
 * 「页面级」事件此前用 window.dispatchEvent(new CustomEvent(...)) 裸分发，
 * 消费方各自裸 addEventListener + as 断言——事件名拼错、payload 形状变化
 * 都没有编译期保护。
 *
 * 本模块把事件名与 payload 形状收敛到 WsEventMap 一张表：
 * - 发布：emitWsEvent('agent-execution:update', {...})——payload 形状由
 *   union 类型校验，多写/漏写字段编译报错；
 * - 订阅：onWsEvent 返回带类型的 handler 与退订函数，消灭 e as CustomEvent 断言。
 */

import type {RequirementFetchProgressEvent} from '../components/RequirementFetchActivity';
import type {StoredRequirement} from '../pages/RequirementsPage';

/** 服务端 WS 消息的宽松形状（useWebSocket 解析后的原始消息） */
export interface WsMessage {
    type: string;
    data?: unknown;
    [key: string]: unknown;
}

/**
 * agent-execution:update 的载荷（按 type 判别的开放 union——
 * 新增 type 时在此登记即获得两端类型保护）
 */
export interface AgentExecutionUpdateEvent {
    /** 事件子类型：thought / status / log / subtask / queued_update / stepLog / permission_request */
    type: string;
    executionId?: string;
    /** thought（AgentThought 对象，消费方自行解析） */
    thought?: unknown;
    /** status */
    status?: string;
    /** log / stepLog */
    log?: string;
    /** subtask（原派发端字段名 subTaskId） */
    subTaskId?: string;
    /** subtask */
    title?: string;
    /** subtask */
    completedAt?: string;
    /** queued_update */
    queued?: boolean;
    /** stepLog */
    stepId?: string;
    /** permission_request */
    permissionRequestId?: string;
    toolName?: string;
    /** permission_request（参数对象，形状随工具而变） */
    toolInput?: unknown;
    displayName?: string;
    [key: string]: unknown;
}

/** requirement:updated 的载荷（服务端更新后的完整需求对象，消费方按 id 对齐） */
export type RequirementUpdatedEvent = StoredRequirement;

/** agent:question 的载荷 */
export interface AgentQuestionEvent {
    executionId?: string;
    question: string;
    [key: string]: unknown;
}

/** 事件名 → 载荷类型对照表 */
export interface WsEventMap {
    /** 原始 WS 消息（ProjectsPage 按 type 二次过滤） */
    'ws-message': WsMessage;
    'requirement:updated': RequirementUpdatedEvent;
    'requirement:fetch-progress': RequirementFetchProgressEvent;
    'agent:question': AgentQuestionEvent;
    'agent-execution:update': AgentExecutionUpdateEvent;
}

/**
 * 发布一个类型化事件
 * @param type - WsEventMap 中登记的事件名
 * @param detail - 对应的载荷（形状由编译器校验）
 */
export function emitWsEvent<K extends keyof WsEventMap>(type: K, detail: WsEventMap[K]): void {
    window.dispatchEvent(new CustomEvent(type, {detail}));
}

/**
 * 订阅一个类型化事件
 * @param type - WsEventMap 中登记的事件名
 * @param handler - 收到已解包载荷的回调（无需再处理 CustomEvent/断言）
 * @returns 退订函数（useEffect cleanup 直接 return）
 *
 * @example
 * useEffect(() => onWsEvent('agent-execution:update', (ev) => {
 *     if (ev.type === 'status') applyStatus(ev);
 * }), []);
 */
export function onWsEvent<K extends keyof WsEventMap>(
    type: K,
    handler: (detail: WsEventMap[K]) => void,
): () => void {
    const listener = (e: Event): void => {
        handler((e as CustomEvent<WsEventMap[K]>).detail);
    };
    window.addEventListener(type, listener);
    return () => window.removeEventListener(type, listener);
}
