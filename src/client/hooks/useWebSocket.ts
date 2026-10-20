/**
 * @file WebSocket 通信 Hook
 * @description 提供 React Hook，管理与后端的 WebSocket 长连接。
 *              支持自动重连机制（指数退避策略，最多重试 5 次），
 *              并将接收到的各类服务端消息分发到全局状态管理（Zustand Store）中。
 *
 *              处理的消息类型包括:
 *                - plan:progress / plan:complete: 计划生成进度与完成通知
 *                - execution:output / execution:step_complete / execution:complete: 执行状态更新
 *                - test:output / test:complete: 测试输出与结果
 *                - agent:progress / agent:complete: Agent执行进度与完成通知
 *                - error: 服务端错误消息
 */

import {useEffect, useRef, useCallback} from 'react';
import {useAppStore} from '../stores/app-store';

/** 最大重连次数 */
const MAX_RETRIES = 5;
/** 基础重连延迟（毫秒），实际延迟 = BASE_DELAY * 2^attempt */
const BASE_DELAY = 1000; // 1 秒

/**
 * 计算指数退避延迟时间
 *
 * 采用指数退避算法，每次重试的等待时间翻倍，
 * 有效避免在网络故障时对服务端造成请求风暴。
 *
 * @param attempt - 当前重试次数（从 0 开始）
 * @param baseDelay - 基础延迟时间（毫秒），默认 1000ms
 * @returns 本次重试应等待的延迟时间（毫秒）
 *
 * @example
 * calculateBackoff(0) // => 1000  (1s)
 * calculateBackoff(1) // => 2000  (2s)
 * calculateBackoff(2) // => 4000  (4s)
 * calculateBackoff(3) // => 8000  (8s)
 */
export function calculateBackoff(attempt: number, baseDelay: number = BASE_DELAY): number {
    return baseDelay * Math.pow(2, attempt);
}


/**
 * WebSocket 连接管理 Hook
 *
 * 功能特性:
 *   - 组件挂载时自动建立 WebSocket 连接
 *   - 连接断开后按指数退避策略自动重连（最多 5 次）
 *   - 连接成功后重置重试计数器
 *   - 根据消息类型自动分发到对应的 Store action
 *   - 组件卸载时清理连接和定时器，防止内存泄漏
 *
 * @returns 包含 WebSocket 连接状态的对象
 */
export function useWebSocket() {
    /** WebSocket 实例引用 */
    const wsRef = useRef<WebSocket | null>(null);
    /** 当前已重试次数 */
    const retriesRef = useRef(0);
    /** 重连定时器引用，用于组件卸载时清除 */
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 从全局 Store 中获取所需的 action 方法
    const setWsConnected = useAppStore((s) => s.setWsConnected);
    const addExecutionLog = useAppStore((s) => s.addExecutionLog);
    const setExecutionStatus = useAppStore((s) => s.setExecutionStatus);
    const setExecutionId = useAppStore((s) => s.setExecutionId);
    const setTestResults = useAppStore((s) => s.setTestResults);
    const setTestRunning = useAppStore((s) => s.setTestRunning);
    const setTestPhase = useAppStore((s) => s.setTestPhase);
    const setPlanStatus = useAppStore((s) => s.setPlanStatus);
    const addPlanLog = useAppStore((s) => s.addPlanLog);
    const setAgentExecutions = useAppStore((s) => s.setAgentExecutions);
    const setActiveAgentExecution = useAppStore((s) => s.setActiveAgentExecution);
    const addAgentLog = useAppStore((s) => s.addAgentLog);
    const addAgentLogToExecution = useAppStore((s) => s.addAgentLogToExecution);

    /**
     * WebSocket 消息处理回调
     *
     * 接收服务端推送的 JSON 消息，根据消息类型（type 字段）执行相应的业务逻辑，
     * 更新全局状态。非 JSON 格式的消息将被静默忽略。
     */
    const handleMessage = useCallback(
        (event: MessageEvent) => {
            try {
                const message = JSON.parse(event.data);

                switch (message.type) {
                    // 计划生成进度：更新状态为"生成中"并追加流式日志
                    case 'plan:progress':
                        setPlanStatus('generating');
                        if (message.data?.content) {
                            addPlanLog(message.data.content);
                        }
                        break;

                    // 计划生成完成：根据结果状态切换为"就绪"、"暂停"、"空闲"或"失败"
                    case 'plan:complete':
                        if (message.data?.status === 'ready') {
                            setPlanStatus('ready');
                        } else if (message.data?.status === 'paused') {
                            setPlanStatus('paused');
                        } else if (message.data?.status === 'failed') {
                            setPlanStatus('idle');
                            if (message.data?.error) {
                                addPlanLog(`\n[ERROR] ${message.data.error}`);
                            }
                        } else {
                            setPlanStatus('idle');
                        }
                        break;

                    // 执行输出：将实时输出追加到执行日志
                    case 'execution:output':
                        addExecutionLog({
                            timestamp: new Date().toISOString(),
                            stepIndex: message.data.stepIndex ?? 0,
                            type: 'output',
                            content: message.data.content,
                        });
                        // 同步更新当前执行 ID，用于追踪执行上下文
                        if (message.data.executionId) {
                            setExecutionId(message.data.executionId);
                        }
                        break;

                    // 执行步骤完成：记录步骤状态（成功/失败）到日志
                    case 'execution:step_complete':
                        addExecutionLog({
                            timestamp: new Date().toISOString(),
                            stepIndex: message.data.stepIndex ?? 0,
                            type: message.data.status === 'success' ? 'info' : 'error',
                            content: `Step ${message.data.stepIndex} ${message.data.status}`,
                        });
                        break;

                    // 执行全部完成：更新执行状态为"已完成"或"已失败"
                    case 'execution:complete':
                        setExecutionStatus({
                            executionId: message.data.executionId || '',
                            planId: '',
                            currentStep: message.data.stepsCompleted || 0,
                            totalSteps: message.data.stepsCompleted || 0,
                            status: message.data.status === 'completed' ? 'completed' : 'failed',
                            startedAt: '',
                            completedAt: new Date().toISOString(),
                        });
                        if (message.data.executionId) {
                            setExecutionId(message.data.executionId);
                        }
                        break;

                    // 测试输出：将测试过程的实时输出追加到执行日志
                    case 'test:output':
                        addExecutionLog({
                            timestamp: new Date().toISOString(),
                            stepIndex: 0,
                            type: 'output',
                            content: message.data.content,
                        });
                        break;

                    // 沙箱测试阶段变更
                    case 'test:phase_change':
                        setTestPhase(message.data.phase, message.data.label);
                        break;

                    // 测试完成：保存测试结果并标记测试运行结束
                    case 'test:complete':
                        setTestResults(message.data);
                        setTestRunning(false);
                        setTestPhase(null, null);
                        break;

                    // 服务端错误：将错误信息记录到执行日志，并退出 generating 状态
                    case 'error':
                        addExecutionLog({
                            timestamp: new Date().toISOString(),
                            stepIndex: 0,
                            type: 'error',
                            content: message.data.message,
                        });
                        // 如果当前正在生成计划，强制退出 generating 状态
                        if (message.data.message?.includes('Plan generation failed')) {
                            setPlanStatus('idle');
                            addPlanLog(`\n[ERROR] ${message.data.message}`);
                        }
                        break;

                    // 多任务状态变更：分发 custom event 给 ProjectsPage
                    case 'task:status_change':
                    case 'task:log':
                        window.dispatchEvent(new CustomEvent('ws-message', {detail: message}));
                        break;

                    // 需求更新（图片下载完成后 description 中 URL 被重写）
                    case 'requirement:updated':
                        window.dispatchEvent(new CustomEvent('requirement:updated', {detail: message.data}));
                        break;

                    // 需求拉取过程（agent 工具调用/思考/重试），分发给需求页活动面板实时渲染
                    case 'requirement:fetch_progress':
                        window.dispatchEvent(new CustomEvent('requirement:fetch-progress', {detail: message.data}));
                        break;

                    // Agent决策过程：展示Think-Act-Observe-Reflect循环
                    case 'agent:progress':
                        const {
                            step,
                            message: progressMessage,
                            logType,
                            timestamp,
                            subtaskId,
                            subtaskStatus,
                            tokensUsed,
                            duration
                        } = message.data as any;

                        // 根据logType添加不同的前缀
                        let prefix = '';
                        if (logType === 'tool') {
                            prefix = '🔧 **Tool:** ';
                        } else if (logType === 'file') {
                            prefix = '📄 **File:** ';
                        } else if (logType === 'shell') {
                            prefix = '💻 **Shell:** ';
                        } else if (logType === 'error') {
                            prefix = '❌ **Error:** ';
                        } else if (logType === 'user') {
                            prefix = '👤 **User:** ';
                        } else if (logType === 'system') {
                            prefix = '⚙️ **System:** ';
                        }

                        // 处理步骤消息
                        if (step === 'start') {
                            addAgentLog(`🚀 ${prefix}${progressMessage || '开始执行...'}`, {
                                timestamp,
                                type: logType || 'system',
                                taskId: subtaskId,
                                subtaskStatus: subtaskStatus || 'processing',
                                tokensUsed,
                                duration
                            });
                        } else if (step === 'resume') {
                            addAgentLog(`▶️ ${prefix}${progressMessage || '恢复执行...'}`, {
                                timestamp,
                                type: logType || 'system',
                                taskId: subtaskId,
                                subtaskStatus: subtaskStatus || 'processing',
                                tokensUsed,
                                duration
                            });
                        } else {
                            // 通用消息
                            addAgentLog(`${prefix}${progressMessage || ''}`, {
                                timestamp,
                                type: logType || 'output',
                                taskId: subtaskId,
                                subtaskStatus: subtaskStatus,
                                tokensUsed,
                                duration
                            });
                        }
                        break;

                    // Agent步骤进度更新
                    case 'agent:step-progress':
                        const stepData = message.data?.step;
                        if (stepData) {
                            const statusMap: Record<string, string> = {
                                'running': '执行中',
                                'completed': '完成',
                                'failed': '失败',
                                'pending': '待执行'
                            };
                            const statusText = statusMap[stepData.status as string] || stepData.status;

                            addAgentLog(`  [步骤${stepData.order}] ${stepData.agentName}: ${statusText}`);
                            if (stepData.reasoning && stepData.status === 'running') {
                                addAgentLog(`    └─ ${stepData.reasoning}`);
                            }

                            // 刷新执行列表以更新状态（每隔几个步骤刷新一次，避免过于频繁）
                            if (stepData.status === 'running' || stepData.status === 'completed') {
                                setActiveAgentExecution(null);
                            }
                        }
                        break;

                    // Agent暂停执行
                    case 'agent:paused':
                        addAgentLog('⏸️ 执行已暂停');
                        break;

                    // Agent向用户提问
                    case 'agent:question':
                        const question = message.data?.question;
                        if (question) {
                            addAgentLog(`❓ Agent提问: ${question}`);
                            // 触发自定义事件，供页面组件处理
                            window.dispatchEvent(new CustomEvent('agent:question', {
                                detail: {executionId: message.data.executionId, question}
                            }));
                        }
                        break;

                    // 用户回答已发送确认
                    case 'agent:answer_received':
                        addAgentLog('✅ 回答已接收，继续执行...');
                        // 刷新执行列表以更新状态
                        setActiveAgentExecution(null);
                        break;

                    // Agent执行完成：更新执行状态并刷新执行列表
                    case 'agent:complete':
                        if (message.data?.status === 'completed') {
                            addAgentLog('✅ 执行完成！');
                        } else if (message.data?.status === 'aborted') {
                            addAgentLog('⚠️ 执行已中止');
                        } else if (message.data?.status === 'failed') {
                            addAgentLog(`❌ 执行失败: ${message.data?.error || 'Unknown error'}`);
                        }
                        // 刷新执行列表（通过重新获取历史）
                        setActiveAgentExecution(null);
                        break;

                    // Agent执行页 - 思考过程
                    case 'agent-execution:thought':
                        const thought = message.data?.thought;
                        if (thought) {
                            const icon = thought.type === 'analysis' ? '🔍' :
                                thought.type === 'planning' ? '📋' :
                                    thought.type === 'decision' ? '🤔' :
                                        thought.type === 'tool_selection' ? '🔧' : '💭';
                            // 日志写入该 execution 自己的分桶（多 Agent 并行隔离）
                            if (typeof message.data?.executionId === 'string') {
                                addAgentLogToExecution(message.data.executionId, `${icon} ${thought.content}`);
                            }
                            window.dispatchEvent(new CustomEvent('agent-execution:update', {
                                detail: {type: 'thought', executionId: message.data?.executionId, thought}
                            }));
                        }
                        break;

                    // Agent执行页 - 执行计划
                    case 'agent-execution:plan':
                        const subTasks = message.data?.subTasks;
                        if (subTasks && Array.isArray(subTasks) && typeof message.data?.executionId === 'string') {
                            addAgentLogToExecution(message.data.executionId, `📋 执行计划已生成，包含 ${subTasks.length} 个子任务`);
                        }
                        break;

                    // Agent执行页 - 子任务/步骤状态
                    // 注意：不再把「[✅ 完成] X」写入执行日志 —— 工具执行细节由「执行步骤」面板展示
                    case 'agent-execution:subtask':
                        const subTaskMsg = message.data;
                        if (subTaskMsg) {
                            window.dispatchEvent(new CustomEvent('agent-execution:update', {
                                detail: {
                                    type: 'subtask',
                                    executionId: message.data?.executionId,
                                    subTaskId: subTaskMsg.subTaskId,
                                    title: subTaskMsg.title,
                                    status: subTaskMsg.status,
                                    completedAt: subTaskMsg.completedAt,
                                }
                            }));
                        }
                        break;

                    // Agent执行页 - 状态变更
                    // 状态由页面徽章展示，不再写「🚀 状态: xxx」日志行（避免冗余刷屏）
                    case 'agent-execution:status':
                        const execStatus = message.data?.status;
                        if (execStatus) {
                            window.dispatchEvent(new CustomEvent('agent-execution:update', {
                                detail: {type: 'status', executionId: message.data?.executionId, status: execStatus}
                            }));
                        }
                        break;

                    // Agent执行页 - 排队消息状态（入队/已被消费）
                    // 消费（queued:false）在 drain 完成即广播，页面据此即时清排队条，
                    // 不等 1.5s 轮询（此前队列变化只能靠轮询/loadDetail）
                    case 'agent-execution:queued_update':
                        window.dispatchEvent(new CustomEvent('agent-execution:update', {
                            detail: {
                                type: 'queued_update',
                                executionId: message.data?.executionId,
                                queued: message.data?.queued,
                            }
                        }));
                        break;

                    // Agent执行页 - 完成通知
                    // 正常完成不打日志（状态徽章已表达）；仅中止/失败保留一条可追溯提示
                    case 'agent-execution:complete':
                        const completeStatus = message.data?.status;
                        if (typeof message.data?.executionId === 'string') {
                            const completeNote = completeStatus === 'aborted' ? '⏹️ Agent执行已中止' :
                                completeStatus === 'failed' ? '❌ Agent执行失败' : '';
                            if (completeNote) {
                                addAgentLogToExecution(message.data.executionId, completeNote);
                            }
                        }
                        if (message.data?.executionId && message.data?.status) {
                            window.dispatchEvent(new CustomEvent('agent-execution:update', {
                                detail: {
                                    type: 'status',
                                    executionId: message.data.executionId,
                                    status: message.data.status
                                }
                            }));
                        }
                        break;

                    // Agent执行页 - 日志消息
                    case 'agent-execution:log':
                        const logMsg = message.data?.log;
                        if (logMsg) {
                            if (typeof message.data?.executionId === 'string') {
                                addAgentLogToExecution(message.data.executionId, logMsg);
                            }
                            window.dispatchEvent(new CustomEvent('agent-execution:update', {
                                detail: {type: 'log', executionId: message.data?.executionId, log: logMsg}
                            }));
                        }
                        break;

                    // Agent执行页 - 步骤级日志（不写入全局日志，只追加到步骤详情）
                    case 'agent-execution:stepLog':
                        const stepLogData = message.data;
                        if (stepLogData?.stepId && stepLogData?.log) {
                            window.dispatchEvent(new CustomEvent('agent-execution:update', {
                                detail: {
                                    type: 'stepLog',
                                    executionId: stepLogData.executionId,
                                    stepId: stepLogData.stepId,
                                    log: stepLogData.log,
                                }
                            }));
                        }
                        break;

                    // Agent执行页 - 工具权限请求（需用户确认）
                    case 'agent-execution:permission_request': {
                        const pr = message.data;
                        if (pr?.permissionRequestId) {
                            if (typeof pr.executionId === 'string') {
                                addAgentLogToExecution(pr.executionId, `⏸ 请求确认工具：${pr.toolName || ''}`);
                            }
                            window.dispatchEvent(new CustomEvent('agent-execution:update', {
                                detail: {
                                    type: 'permission_request',
                                    executionId: pr.executionId,
                                    permissionRequestId: pr.permissionRequestId,
                                    toolName: pr.toolName,
                                    toolInput: pr.toolInput,
                                    title: pr.title,
                                    displayName: pr.displayName,
                                }
                            }));
                        }
                        break;
                    }
                }
            } catch {
                // 非标准 JSON 消息，静默忽略（如心跳帧等）
            }
        },
        [addExecutionLog, addPlanLog, setExecutionId, setExecutionStatus, setPlanStatus, setTestResults, setTestRunning, setTestPhase, setAgentExecutions, setActiveAgentExecution, addAgentLog, addAgentLogToExecution]
    );

    /**
     * 建立 WebSocket 连接
     *
     * 根据当前页面协议自动选择 ws: 或 wss: 协议，
     * 连接成功后重置重试计数器，连接断开后启动指数退避重连。
     */
    const connect = useCallback(() => {
        // 根据当前页面协议自动判断使用 ws 还是 wss
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        // 连接建立成功：更新连接状态并重置重试计数
        ws.onopen = () => {
            setWsConnected(true);
            retriesRef.current = 0; // 重置重试计数器，以便下次断开时从 0 开始
        };

        // 接收消息：委托给 handleMessage 处理
        ws.onmessage = handleMessage;

        // 连接关闭：清理引用并在未超过最大重试次数时启动退避重连
        ws.onclose = () => {
            setWsConnected(false);
            wsRef.current = null;

            // 未超过最大重试次数时，按指数退避延迟后尝试重连
            if (retriesRef.current < MAX_RETRIES) {
                const delay = calculateBackoff(retriesRef.current);
                reconnectTimerRef.current = setTimeout(() => {
                    retriesRef.current++;
                    connect();
                }, delay);
            }
        };

        // 连接出错：主动关闭连接（会触发 onclose，在那里处理重连逻辑）
        ws.onerror = () => {
            // onclose 会在 onerror 之后被调用，重连逻辑统一在 onclose 中处理
            ws.close();
        };
    }, [handleMessage, setWsConnected]);

    // 组件挂载时建立连接，卸载时清理资源
    useEffect(() => {
        connect();

        return () => {
            // 清理：取消待执行的重连定时器
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
            }
            // 清理：关闭活跃的 WebSocket 连接
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
    }, [connect]);

    return {
        /** 当前 WebSocket 连接是否处于已连接状态 */
        connected: useAppStore((s) => s.ws.connected),
    };
}
