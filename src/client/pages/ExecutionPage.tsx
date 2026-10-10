/**
 * @file ExecutionPage.tsx
 * @description 执行监控页面 - 用于实时查看和管理 AI 代理（Claude）执行计划的过程。
 *
 * 主要功能：
 * - 左侧面板：显示历史执行记录列表，支持选择和删除
 * - 右侧面板：显示当前选中执行的详细信息，包括进度条、控制按钮、回复输入框和实时日志输出
 * - 支持暂停、重试、跳过、中止等执行控制操作
 * - 支持在执行过程中向 Claude 发送回复消息（当 Claude 需要用户确认或提问时）
 * - 通过轮询机制（每1.5秒）实时更新执行状态和日志
 * - 与全局状态管理（Zustand store）集成，支持从计划页面触发的实时执行同步
 */

import {useEffect, useRef, useState, useCallback, useMemo} from 'react';
import {useNavigate} from 'react-router-dom';
import {useTranslation} from 'react-i18next';
import {apiGet, apiPost} from '../api';
import {useAppStore} from '../stores/app-store';
import type {ExecutionLogEntry} from '../stores/app-store';
import {cn, formatRelativeTime} from '../lib/utils';
import {
    Pause,
    RotateCcw,
    SkipForward,
    Square,
    Trash2,
    CheckCircle2,
    XCircle,
    AlertCircle,
    Loader2,
    Terminal,
    MessageSquare,
    Play,
    Clock,
    Layers,
    User,
    FolderOpen,
    ChevronDown,
    ChevronUp,
    TestTube,
} from 'lucide-react';
import {Button} from '../components/ui/button';
import {Card, CardContent} from '../components/ui/card';
import {StatusIcon} from '../components/StatusIcon';
import ContextIndicator from '../components/ContextIndicator';
import {LogViewer} from '../components/LogViewer';
import {useParsedLogs} from '../hooks/useParsedLogs';
import {deliverableFilesFromMessages} from '../utils/agent-log-parse';
import {DeliverablesCard} from '../components/DeliverablesCard';
import {ChatInputBox} from '../components/ChatInputBox';
import {Joyride} from 'react-joyride';
import {useGuide} from '../guides/useGuide';
// === 类型定义 ===

/**
 * 执行记录摘要接口
 * @description 用于列表展示的精简执行信息，包含基本状态和元数据
 */
interface ExecutionSummary {
    /** 执行记录唯一标识 */
    id: string;
    /** 关联的计划 ID */
    planId: string;
    /** 关联需求标题 */
    requirementTitle?: string;
    /** 关联需求编号（如 #125975） */
    requirementNumber?: string;
    /** 执行状态：运行中、已暂停、已完成、已失败、已中止 */
    status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted' | 'waiting_skill_confirm';
    /** 当前执行的步骤编号 */
    currentStep: number;
    /** 总步骤数 */
    totalSteps: number;
    /** 执行开始时间（ISO 格式字符串） */
    startedAt: string;
    /** 执行完成时间（ISO 格式字符串），未完成时为 undefined */
    completedAt?: string;
    /** 工作区路径 */
    workspacePath?: string;
    /** 日志条目数量 */
    logCount: number;
}

/**
 * 执行详情接口
 * @description 继承 ExecutionSummary，额外包含完整日志列表和会话 ID
 */
interface ExecutionDetail extends ExecutionSummary {
    /** 完整的日志输出列表，每条可以是字符串或结构化日志对象 */
    logs: string[];
    /** Claude 会话 ID，用于标识与 Claude 的交互会话 */
    sessionId?: string;
}

// === 辅助函数 ===

/**
 * 根据执行状态返回对应的图标组件
 * @param status - 执行状态字符串
 * @returns 对应的 React 图标元素
 */
function statusIcon(status: string) {
    return <StatusIcon status={status}/>;
}

// === 主组件 ===

/**
 * 执行监控页面组件
 *
 * @description 提供执行过程的完整监控界面，包括：
 * - 执行历史列表的加载与展示
 * - 实时轮询当前执行状态（1.5秒间隔）
 * - 执行控制操作（暂停/重试/跳过/中止）
 * - 与 Claude 的交互式回复功能
 * - 日志的实时滚动展示
 * - 执行完成后的摘要信息和测试跳转
 *
 * @component
 * @example
 * // 在路由中使用
 * <Route path="/execution" element={<ExecutionPage />} />
 */
export default function ExecutionPage() {
    const navigate = useNavigate();
    const {t} = useTranslation();

    // 从全局状态管理（Zustand store）中获取和设置执行相关的状态
    // 这些状态用于与计划页面触发的实时执行保持同步
    const {run: guideRun, steps: guideSteps, handleJoyrideEvent} = useGuide('execution');
    const storeExecutionId = useAppStore((s) => s.execution.executionId);
    const storeStatus = useAppStore((s) => s.execution.status);
    const storeLogs = useAppStore((s) => s.execution.logs);
    const setExecutionStatus = useAppStore((s) => s.setExecutionStatus);
    const addExecutionLog = useAppStore((s) => s.addExecutionLog);
    const clearExecutionLogs = useAppStore((s) => s.clearExecutionLogs);
    const setExecutionId = useAppStore((s) => s.setExecutionId);
    const theme = useAppStore((s) => s.ui.theme); // 获取当前主题

    // 执行历史列表相关状态
    const [history, setHistory] = useState<ExecutionSummary[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

    // 当前活跃执行的详情状态
    // activeId 可以来自历史记录点击或从 store 同步的实时执行 ID
    const [activeId, setActiveId] = useState<string | null>(storeExecutionId);
    const [detail, setDetail] = useState<ExecutionDetail | null>(null);
    const [replyText, setReplyText] = useState('');
    const [replying, setReplying] = useState(false);
    const [skillConfirm, setSkillConfirm] = useState<{
        open: boolean;
        nextSkill?: string;
        completedSkill?: string
    }>({open: false});
    // DOM 引用：用于轮询清理和回复输入框聚焦
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // 当前执行的已知全量日志（增量累积）：首次 logsFrom=0 全量，之后只拉新增段拼接，
    // 修复「刷新后只剩服务端尾部 200 条」的截断（与 ExecutionPanel 同一机制）
    const fullLogsRef = useRef<string[] | null>(null);
    const replyInputRef = useRef<HTMLTextAreaElement>(null);
    const [pollKey, setPollKey] = useState(0); // 递增以重启轮询

    // 根据详情数据和 store 状态派生当前的执行状态
    // 优先使用 detail 中的状态，回退到 store 中的实时状态
    const execStatus = detail?.status ?? storeStatus?.status ?? 'idle';
    const isRunning = execStatus === 'running';
    const isPaused = execStatus === 'paused';
    const isCompleted = execStatus === 'completed';
    const isFailed = execStatus === 'failed';
    const isAborted = execStatus === 'aborted';
    const isDone = isCompleted || isFailed || isAborted;

    // 合并日志来源：WebSocket 推送的实时日志 + 轮询返回的历史日志
    // 优先使用 detail.logs 作为基础，追加 storeLogs 中的新增内容
    // 支持折叠功能：超过阈值自动折叠，可手动展开/折叠
    const displayLogs = useMemo(() => {
        const baseLogs = detail?.logs ?? [];

        // 如果是实时执行且有 WebSocket 推送，合并日志
        let combined: Array<string | ExecutionLogEntry> = [...baseLogs];
        if (activeId === storeExecutionId && storeLogs.length > 0) {
            // 去重合并：避免重复显示（通过内容比对）
            for (const newLog of storeLogs) {
                const newContent = (newLog as ExecutionLogEntry).content;
                const exists = combined.some(existing => {
                    const existingContent = typeof existing === 'string' ? existing : (existing as ExecutionLogEntry).content;
                    return existingContent === newContent;
                });
                if (!exists) {
                    combined.push(newLog);
                }
            }
        }

        // 不截断：返回所有消息（用于分组折叠显示）
        return combined;
    }, [detail?.logs, storeLogs, activeId, storeExecutionId]);

    // 日志消息（displayLogs → LogMessageData[]，增量解析：Think 折叠行 / 分类工具行配对渲染）
    const logMessages = useParsedLogs(displayLogs, {finalizeRunning: isDone});

    // 本次产出：写类工具（Write/Edit/MultiEdit/NotebookEdit）成功变更的文件（执行结束后展示）
    const deliverables = useMemo(() => deliverableFilesFromMessages(logMessages), [logMessages]);

    /**
     * 加载执行历史列表
     * 从后端 API 获取所有执行记录的摘要信息
     */
    const loadHistory = useCallback(async () => {
        setLoadingHistory(true);
        try {
            const data = await apiGet<ExecutionSummary[]>('/execution/list');
            setHistory(data);
        } catch {
            // 忽略加载错误，保持现有历史列表不变
        } finally {
            setLoadingHistory(false);
        }
    }, []);

    // 组件挂载时加载执行历史
    useEffect(() => {
        loadHistory();
    }, [loadHistory]);

    /**
     * 加载指定执行记录的详细信息
     * @param id - 执行记录 ID
     */
    /**
     * 用 /status 响应更新 detail：与已知全量拼接（logsFrom 分段语义）后再落 state，
     * 避免一次性刷新点（retry/skip 等）用服务端尾部窗口覆盖本地全量历史
     */
    const applyDetail = useCallback((data: ExecutionDetail) => {
        const known = fullLogsRef.current;
        const incoming = data.logs ?? [];
        const merged = (!known || data.totalLogs < known.length) ? incoming : [...known, ...incoming];
        fullLogsRef.current = merged;
        data.logs = merged;
        setDetail(data);
    }, []);

    const loadDetail = useCallback(async (id: string) => {
        try {
            fullLogsRef.current = null; // 切换执行：重新全量加载
            const data = await apiGet<ExecutionDetail>(`/execution/${id}/status?logsFrom=0`);
            applyDetail(data);
            setActiveId(id);
        } catch {
            // 忽略加载错误
        }
    }, [applyDetail]);

    // 当 storeExecutionId 变化时（即从计划页面触发新执行），自动切换到该执行
    useEffect(() => {
        if (!storeExecutionId) return;
        setActiveId(storeExecutionId);
        setDetail(null); // 清空旧详情，等待轮询填充新数据
    }, [storeExecutionId]);

    // 轮询当前活跃执行的状态和日志
    // 每 1.5 秒请求一次后端，实时更新执行进度和日志输出
    useEffect(() => {
        if (!activeId) return;

        const poll = async () => {
            try {
                // 增量拉取：首次全量（logsFrom=0），之后从已知长度只取新增段拼接全量视图；
                // 服务端日志被重置（totalLogs 变小）时回退全量重新对齐
                const known = fullLogsRef.current;
                const from = known ? known.length : 0;
                const data = await apiGet<ExecutionDetail>(`/execution/${activeId}/status?logsFrom=${from}`);
                applyDetail(data);

                // 如果当前活跃执行就是 store 中的实时执行，则同步更新 store 状态
                if (activeId === storeExecutionId) {
                    setExecutionStatus({
                        executionId: data.id,
                        planId: data.planId,
                        currentStep: data.currentStep,
                        totalSteps: data.totalSteps,
                        status: data.status as 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted' | 'waiting_skill_confirm',
                        startedAt: data.startedAt,
                        completedAt: data.completedAt,
                    });

                    // 日志不在此追加——实时日志由 WebSocket execution:output 推送（useWebSocket → addExecutionLog）。
                    // poll 只更新 detail（执行状态 + 历史日志），避免与 WebSocket 双源重复追加导致回复显示两遍。
                }

                // 执行结束时停止轮询，刷新历史列表，并自动聚焦回复输入框
                if (['completed', 'failed', 'aborted'].includes(data.status)) {
                    if (pollRef.current) clearInterval(pollRef.current);
                    loadHistory();
                    setTimeout(() => replyInputRef.current?.focus(), 100);
                }
                // 技能执行完成，等待用户确认
                if (data.status === 'waiting_skill_confirm') {
                    if (pollRef.current) clearInterval(pollRef.current);
                    setSkillConfirm({
                        open: true,
                        nextSkill: (data as { pendingSkills?: string[] }).pendingSkills?.[0],
                        completedSkill: (data as { executedSkills?: string[] }).executedSkills?.slice(-1)[0],
                    });
                }
            } catch {
                // 轮询请求失败时保持轮询，不中断
            }
        };

        // 立即执行一次，然后设置定时轮询
        poll();
        pollRef.current = setInterval(poll, 1500);

        // 组件卸载或依赖变化时清理轮询定时器
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [activeId, storeExecutionId, setExecutionStatus, loadHistory, pollKey, applyDetail]);

    // 组件卸载时确保清理轮询定时器，防止内存泄漏
    useEffect(() => {
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    // 当没有活跃执行但有历史记录时，自动选中最近的一条执行记录
    useEffect(() => {
        if (!activeId && history.length > 0) {
            loadDetail(history[0].id);
        }
    }, [activeId, history, loadDetail]);

    // === 操作处理函数 ===

    /** 暂停当前正在运行的执行 */
    const handlePause = async () => {
        if (!activeId) return;
        // 乐观更新：立即在本地反映暂停状态
        if (detail) setDetail({...detail, status: 'paused'});
        try {
            await apiPost(`/execution/${activeId}/pause`);
            // 刷新历史列表以更新状态标识
            await loadHistory();
        } catch { /* 通过轮询处理状态更新 */
        }
    };

    /** 重试当前失败或暂停的步骤 */
    const handleRetry = async () => {
        if (!activeId) return;
        // 乐观更新：立即在本地反映运行中状态
        if (detail) setDetail({...detail, status: 'running'});
        try {
            await apiPost(`/execution/${activeId}/retry-step`);
            // 立即刷新状态并重启轮询
            const data = await apiGet<ExecutionDetail>(`/execution/${activeId}/status`);
            applyDetail(data);
            setPollKey(k => k + 1);
            // 刷新历史列表以更新状态标识
            loadHistory();
        } catch { /* 通过轮询处理状态更新 */
        }
    };

    /** 跳过当前暂停或失败的步骤，继续执行下一步 */
    const handleSkip = async () => {
        if (!activeId) return;
        // 乐观更新：立即在本地反映运行中状态
        if (detail) setDetail({...detail, status: 'running'});
        try {
            await apiPost(`/execution/${activeId}/skip-step`);
            // 立即刷新状态并重启轮询
            const data = await apiGet<ExecutionDetail>(`/execution/${activeId}/status`);
            applyDetail(data);
            setPollKey(k => k + 1);
            // 刷新历史列表以更新状态标识
            loadHistory();
        } catch { /* 通过轮询处理状态更新 */
        }
    };

    /** 中止当前执行，不再继续后续步骤 */
    const handleAbort = async () => {
        if (!activeId) return;
        // 乐观更新：立即在本地反映中止状态
        if (detail) setDetail({...detail, status: 'aborted'});
        try {
            await apiPost(`/execution/${activeId}/abort`);
            // 刷新历史列表以更新状态标识
            await loadHistory();
        } catch { /* 通过轮询处理状态更新 */
        }
    };

    /** 确认继续下一个技能 */
    const handleContinueSkill = async () => {
        if (!activeId) return;
        setSkillConfirm({open: false});
        if (detail) setDetail({...detail, status: 'running'});
        try {
            await apiPost(`/execution/${activeId}/continue-skill`);
            // 重启轮询
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = setInterval(async () => {
                try {
                    if (!activeId) return;
                    const data = await apiGet<ExecutionDetail>(`/execution/${activeId}/status`);
                    applyDetail(data);
                    if (['completed', 'failed', 'aborted'].includes(data.status)) {
                        if (pollRef.current) clearInterval(pollRef.current);
                        loadHistory();
                    } else if (data.status === 'waiting_skill_confirm') {
                        if (pollRef.current) clearInterval(pollRef.current);
                        setSkillConfirm({
                            open: true,
                            nextSkill: (data as { pendingSkills?: string[] }).pendingSkills?.[0],
                            completedSkill: (data as { executedSkills?: string[] }).executedSkills?.slice(-1)[0],
                        });
                    }
                } catch { /* continue */
                }
            }, 2000);
        } catch (err) {
            console.error('Continue skill failed:', err);
        }
    };

    /** 跳过下一个技能 */
    const handleSkipSkill = async () => {
        if (!activeId) return;
        setSkillConfirm({open: false});
        if (detail) setDetail({...detail, status: 'running'});
        try {
            const res = await apiPost<{ completed?: boolean }>(`/execution/${activeId}/skip-skill`);
            if (res.completed) {
                const data = await apiGet<ExecutionDetail>(`/execution/${activeId}/status`);
                applyDetail(data);
                loadHistory();
                return;
            }
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = setInterval(async () => {
                try {
                    if (!activeId) return;
                    const data = await apiGet<ExecutionDetail>(`/execution/${activeId}/status`);
                    applyDetail(data);
                    if (['completed', 'failed', 'aborted'].includes(data.status)) {
                        if (pollRef.current) clearInterval(pollRef.current);
                        loadHistory();
                    } else if (data.status === 'waiting_skill_confirm') {
                        if (pollRef.current) clearInterval(pollRef.current);
                        setSkillConfirm({
                            open: true,
                            nextSkill: (data as { pendingSkills?: string[] }).pendingSkills?.[0],
                            completedSkill: (data as { executedSkills?: string[] }).executedSkills?.slice(-1)[0],
                        });
                    }
                } catch { /* continue */
                }
            }, 2000);
        } catch (err) {
            console.error('Skip skill failed:', err);
        }
    };

    /**
     * 删除指定的执行记录
     * @param id - 要删除的执行记录 ID
     * @param e - 鼠标事件，用于阻止事件冒泡（避免触发选中操作）
     */
    const handleDelete = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation(); // 阻止点击事件冒泡到父级元素（避免触发选中该执行记录）
        try {
            const res = await fetch(`/api/execution/${id}`, {method: 'DELETE'});
            if (!res.ok) throw new Error(t('execution.deleteFailed'));
            // 重新加载列表
            await loadHistory();
            // 如果删除的是当前选中的记录，则清空详情和选中状态
            if (activeId === id) {
                setDetail(null);
                setActiveId(null);
                setExecutionId(null);
            }
        } catch {
            // 忽略删除错误
        }
    };

    /**
     * 开始新会话（清空后端上下文，保留前端历史显示）
     * 当上下文即将满时（>80%）调用，避免 529 错误
     */
    const handleNewSession = async () => {
        if (!activeId) return;

        try {
            await apiPost(`/execution/${activeId}/new-session`, {});
            // 新会话创建成功，历史消息仍保留在 displayLogs 中
            // 下次发送消息时将使用新 sessionId
        } catch (err) {
            console.error('新会话创建失败:', err);
        }
    };

    /**
     * 向当前执行中的 Claude 发送回复消息
     * 当 Claude 在执行过程中需要用户确认或提出问题时使用
     * 发送后 Claude 将根据回复内容继续执行；附件以 attachmentIds 旁路传递
     */
    const handleReplyWithAttachments = async (text: string, attachmentIds: string[]) => {
        if (!activeId || !text.trim() || replying) return;
        const message = text.trim();
        setReplying(true);
        setReplyText(''); // 清空输入框

        // 乐观更新：detail / history / store 三处都置为 running，让 UI 立即反映。
        // 注意 execStatus 优先读 detail.status，故必须更新 detail，否则徽章/按钮不变。
        if (detail) setDetail({...detail, status: 'running'});
        setHistory(prev => prev.map(item =>
            item.id === activeId
                ? {...item, status: 'running' as const}
                : item
        ));

        // 设置全局状态为 running（图标转动）
        setExecutionStatus({
            executionId: activeId,
            planId: detail?.planId,
            currentStep: detail?.currentStep ?? 0,
            totalSteps: detail?.totalSteps ?? 1,
            status: 'running',
            startedAt: detail?.startedAt,
        });

        // WebSocket 会自动推送 execution:output，轮询会更新 detail.logs
        // 这样可以保留完整的历史日志，新内容追加显示

        try {
            await apiPost(`/execution/${activeId}/reply`, {
                message,
                attachmentIds: attachmentIds.length ? attachmentIds : undefined,
            });
            // 重启轮询：执行曾进入终态（completed/failed/aborted/waiting_skill_confirm）时
            // 轮询已被停止，reply 把状态恢复为 running 后必须重建轮询，否则后端状态变更
            // 无法同步到前端，出现"发消息不实时变更、需刷新页面才生效"的问题。
            setPollKey(k => k + 1);
            // 刷新历史列表以同步最新状态
            await loadHistory();
        } catch (err) {
            // 回复失败时将错误信息添加到日志中，便于用户了解失败原因
            addExecutionLog({
                timestamp: new Date().toISOString(),
                stepIndex: 0,
                type: 'error',
                content: t('execution.replyFailed', {error: err instanceof Error ? err.message : 'Unknown error'}),
            });
            // 失败时回滚乐观更新
            if (detail) setDetail({...detail, status: 'idle'});
            setHistory(prev => prev.map(item =>
                item.id === activeId
                    ? {...item, status: 'idle' as const}
                    : item
            ));
            // 恢复全局状态为 idle
            setExecutionStatus({
                executionId: activeId,
                planId: detail?.planId,
                currentStep: detail?.currentStep ?? 0,
                totalSteps: detail?.totalSteps ?? 1,
                status: 'idle',
                startedAt: detail?.startedAt,
            });
        } finally {
            setReplying(false);
        }
    };

    /**
     * 重新执行当前计划
     * 导航回计划页面，用户可以在那里重新确认并执行
     */
    const handleReExecute = () => {
        if (!detail?.planId) return;
        // 导航到计划页面，store 中已有 planId 上下文
        navigate('/plan');
    };

    // 执行状态对应的显示配置（标签文本、颜色类名）
    const statusConfig = {
        idle: {label: t('execution.statusIdle'), color: 'text-muted-foreground', bg: 'bg-muted'},
        running: {label: t('execution.statusRunning'), color: 'text-blue-500', bg: 'bg-blue-500/10'},
        paused: {label: t('execution.statusPaused'), color: 'text-yellow-500', bg: 'bg-yellow-500/10'},
        completed: {label: t('execution.statusCompleted'), color: 'text-emerald-500', bg: 'bg-emerald-500/10'},
        failed: {label: t('execution.statusFailed'), color: 'text-destructive', bg: 'bg-destructive/10'},
        aborted: {label: t('execution.statusAborted'), color: 'text-muted-foreground', bg: 'bg-muted'},
        waiting_skill_confirm: {
            label: t('execution.statusSkillConfirm'),
            color: 'text-red-500',
            bg: 'bg-red-500/10'
        },
    };

    const cfg = statusConfig[execStatus] ?? statusConfig.idle;

    /**
     * 根据日志类型返回对应的颜色类名
     * @param type - 日志类型：error（错误）、warning（警告）、info（信息）、output（普通输出）
     * @returns Tailwind CSS 文字颜色类名
     */
    const logTypeColor = (type: string) => {
        switch (type) {
            case 'error':
                return 'text-red-400';
            case 'warning':
                return 'text-yellow-400';
            case 'info':
                return 'text-blue-400';
            default:
                return 'text-gray-300';
        }
    };

    return (
        <div className="flex h-full">
            {/* 左侧面板：执行历史记录列表 */}
            <div className="w-64 flex flex-col border-r border-border bg-muted/10 shrink-0">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t('execution.historyTitle')}
          </span>
                    {loadingHistory && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground"/>}
                </div>

                <div className="flex-1 overflow-y-auto">
                    {/* 空状态：暂无执行记录 */}
                    {history.length === 0 && !loadingHistory && (
                        <div className="flex flex-col items-center justify-center py-8 px-4 text-center gap-2">
                            <Terminal className="h-7 w-7 text-muted-foreground/30"/>
                            <p className="text-xs text-muted-foreground">{t('execution.noExecutions')}</p>
                        </div>
                    )}

                    {/* 渲染每条执行历史记录 */}
                    {history.map((exec) => (
                        <div
                            key={exec.id}
                            onClick={() => loadDetail(exec.id)}
                            className={cn(
                                'group flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-border/50 transition-colors',
                                activeId === exec.id
                                    ? 'bg-primary/5 border-l-2 border-l-primary'  // 当前选中项高亮样式
                                    : 'hover:bg-accent/50'  // 悬停效果
                            )}
                        >
                            {/* 状态图标 */}
                            <div className="mt-0.5 shrink-0">{statusIcon(exec.status)}</div>
                            <div className="flex-1 min-w-0">
                                {/* 需求号 + 描述 */}
                                <p className="text-xs font-medium truncate text-foreground">
                                    {exec.requirementNumber ? `${exec.requirementNumber} ` : ''}{exec.requirementTitle || t('execution.unnamed')}
                                </p>
                                {/* 显示相对时间 */}
                                <div className="flex items-center gap-1.5 mt-0.5">
                                    <Clock className="h-3 w-3 text-muted-foreground/50"/>
                                    <span className="text-xs text-muted-foreground/60">
                    {formatRelativeTime(exec.startedAt)}
                  </span>
                                </div>
                                {/* 显示工作区目录名 */}
                                {exec.workspacePath && (
                                    <div className="flex items-center gap-1 mt-0.5">
                                        <FolderOpen className="h-3 w-3 text-muted-foreground/40"/>
                                        <span className="text-xs text-muted-foreground/40 truncate font-mono">
                      {exec.workspacePath.split(/[/\\]/).pop()}
                    </span>
                                    </div>
                                )}
                            </div>
                            {/* 删除按钮：仅悬停时显示 */}
                            <button
                                onClick={(e) => handleDelete(exec.id, e)}
                                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 hover:text-destructive transition-all shrink-0"
                            >
                                <Trash2 className="h-3.5 w-3.5"/>
                            </button>
                        </div>
                    ))}
                </div>
            </div>

            {/* 右侧面板：执行详情展示区域 */}
            <div className="flex-1 flex flex-col min-w-0">
                {/* 页面头部：标题和状态徽章 */}
                <div className="border-b border-border px-6 py-4 shrink-0">
                    <div className="flex items-center justify-between">
                        <div>
                            <h1 className="text-xl font-semibold brand-gradient-text">{t('pageTitle.execution')}</h1>
                            <p className="mt-0.5 text-sm text-muted-foreground">
                                {isRunning ? t('execution.subtitleRunning') :
                                    isDone ? t('execution.subtitleDone', {status: execStatus}) :
                                        activeId ? t('execution.subtitleActive') :
                                            t('execution.subtitleIdle')}
                            </p>
                        </div>

                        {/* 状态徽章：显示当前执行状态和对应颜色 */}
                        {activeId && (
                            <div
                                className={cn('flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium', cfg.bg, cfg.color)}>
                                {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin"/>}
                                {isCompleted && <CheckCircle2 className="h-3.5 w-3.5"/>}
                                {isFailed && <XCircle className="h-3.5 w-3.5"/>}
                                {isPaused && <AlertCircle className="h-3.5 w-3.5"/>}
                                {cfg.label}
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex-1 flex flex-col min-h-0 p-6 gap-4">
                    {/* 空状态：未选中任何执行记录 */}
                    {!activeId && (
                        <Card>
                            <CardContent className="p-6 flex flex-col items-center gap-3 text-center">
                                <Terminal className="h-10 w-10 text-muted-foreground/30"/>
                                <p className="text-sm text-muted-foreground">{t('execution.noSelectionTitle')}</p>
                                <p className="text-xs text-muted-foreground/60">
                                    {t('execution.noSelectionSubtitle')}
                                </p>
                            </CardContent>
                        </Card>
                    )}

                    {/* 进度条：显示当前步骤和总步骤 */}
                    {activeId && detail && (
                        <Card>
                            <CardContent className="p-4">
                                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">
                    {t('execution.stepProgress', {current: detail.currentStep, total: detail.totalSteps || '?'})}
                  </span>
                                    {detail.totalSteps > 1 && (
                                        <span className="text-sm text-muted-foreground">
                      {Math.round((detail.currentStep / detail.totalSteps) * 100)}%
                    </span>
                                    )}
                                </div>
                                {detail.totalSteps > 1 && (
                                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                                        <div
                                            className={cn(
                                                'h-full rounded-full transition-all duration-500',
                                                isCompleted ? 'bg-emend-500' : isFailed ? 'bg-destructive' : 'bg-primary'
                                            )}
                                            style={{
                                                width: `${(detail.currentStep / detail.totalSteps) * 100}%`,
                                            }}
                                        />
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    {/* 控制按钮已收敛到下方回复输入框区域（data-tour 保留供引导定位） */}
                    <div data-tour="exec-controls" className="hidden"/>

                    {/* 回复输入区域：向 Claude 发送交互消息 */}
                    {activeId && (
                        <Card className="border-primary/20 bg-primary/5" data-tour="exec-reply">
                            <CardContent className="p-3">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                        <MessageSquare className="h-4 w-4 text-primary"/>
                                        <span className="text-sm font-semibold">{t('execution.replyTitle')}</span>
                                        <span className="text-xs text-muted-foreground">
                        {t('execution.replySubtitle')}
                      </span>
                                    </div>
                                    {/* 上下文指示器 */}
                                    <ContextIndicator
                                        logs={displayLogs.map(l => typeof l === 'string' ? l : JSON.stringify(l))}
                                        onSuggestNewSession={handleNewSession}
                                    />
                                </div>
                                {/* 统一输入框（收敛自顶部控制栏）：运行中 = 暂停/中止；
                                    暂停或失败 = 重试/跳过/中止；完成 = 重新执行；清空日志 */}
                                <ChatInputBox
                                    ref={replyInputRef}
                                    value={replyText}
                                    onChange={setReplyText}
                                    onSend={(text, atts) => handleReplyWithAttachments(text.trim(), atts.map(a => a.attachmentId))}
                                    placeholder={t('execution.replyPlaceholder')}
                                    rows={2}
                                    disabled={isRunning} // Claude 运行时禁用回复输入
                                    title={t('execution.replyTitle')}
                                    optimizable
                                    optimizePurpose="reply"
                                    sending={replying}
                                    branchWorkspacePath={detail?.workspacePath}
                                    branchDisabled={isRunning}
                                    actions={
                                        <>
                                            {isRunning && (
                                                <>
                                                    <Button
                                                        onClick={handlePause}
                                                        variant="outline"
                                                        size="icon"
                                                        className="shrink-0"
                                                        title={t('execution.pause')}
                                                        aria-label={t('execution.pause')}
                                                    >
                                                        <Pause className="h-4 w-4"/>
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        onClick={handleAbort}
                                                        size="icon"
                                                        className="shrink-0 text-destructive hover:text-destructive"
                                                        title={t('execution.abort')}
                                                        aria-label={t('execution.abort')}
                                                    >
                                                        <Square className="h-4 w-4"/>
                                                    </Button>
                                                </>
                                            )}
                                            {!isRunning && (isPaused || isFailed) && (
                                                <>
                                                    <Button
                                                        variant="outline"
                                                        onClick={handleRetry}
                                                        size="icon"
                                                        className="shrink-0"
                                                        title={t('execution.retry')}
                                                        aria-label={t('execution.retry')}
                                                    >
                                                        <RotateCcw className="h-4 w-4"/>
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        onClick={handleSkip}
                                                        size="icon"
                                                        className="shrink-0"
                                                        title={t('execution.skip')}
                                                        aria-label={t('execution.skip')}
                                                    >
                                                        <SkipForward className="h-4 w-4"/>
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        onClick={handleAbort}
                                                        size="icon"
                                                        className="shrink-0 text-destructive hover:text-destructive"
                                                        title={t('execution.abort')}
                                                        aria-label={t('execution.abort')}
                                                    >
                                                        <Square className="h-4 w-4"/>
                                                    </Button>
                                                </>
                                            )}
                                            {!isRunning && isDone && detail?.planId && (
                                                <Button
                                                    variant="outline"
                                                    onClick={handleReExecute}
                                                    size="icon"
                                                    className="shrink-0"
                                                    title={t('execution.reExecute')}
                                                    aria-label={t('execution.reExecute')}
                                                >
                                                    <Play className="h-4 w-4"/>
                                                </Button>
                                            )}
                                            {!isRunning && (
                                                <Button
                                                    variant="ghost"
                                                    onClick={clearExecutionLogs}
                                                    size="icon"
                                                    className="shrink-0 text-muted-foreground"
                                                    title={t('execution.clear')}
                                                    aria-label={t('execution.clear')}
                                                >
                                                    <Trash2 className="h-4 w-4"/>
                                                </Button>
                                            )}
                                        </>
                                    }
                                />
                                {/* 无会话时显示提示信息 */}
                                {!detail?.sessionId && !isRunning && (
                                    <p className="text-xs text-muted-foreground mt-1">
                                        {t('execution.noSessionHint')}
                                    </p>
                                )}
                                {/* Claude 运行时显示提示信息 */}
                                {isRunning && (
                                    <p className="text-xs text-muted-foreground mt-1">
                                        {t('execution.claudeRunningHint')}
                                    </p>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    {/* 日志输出终端：统一 LogViewer（分组折叠 / 工具栏 / Markdown / 自动滚动） */}
                    {activeId && (
                        <div data-tour="exec-output" className="flex-1 min-h-0 overflow-hidden">
                            <LogViewer
                                key={activeId}
                                className="h-full"
                                messages={logMessages}
                                title={t('execution.output')}
                                isStreaming={isRunning}
                                emptyText={activeId ? t('execution.waitingOutput') : t('execution.noOutput')}
                                onClear={clearExecutionLogs}
                                showJumpBar
                            />
                        </div>
                    )}

                    {/* 本次产出：执行结束后列出写类工具变更的文件 */}
                    {isDone && deliverables.length > 0 && (
                        <DeliverablesCard files={deliverables} className="shrink-0"/>
                    )}

                    {/* 执行完成摘要卡片：显示执行统计信息和后续操作 */}
                    {isDone && detail && (
                        <Card className={cn(
                            'border',
                            isCompleted ? 'border-emerald-500/30 bg-emerald-500/5' :
                                isFailed ? 'border-destructive/30 bg-destructive/5' :
                                    'border-border'
                        )}>
                            <CardContent className="p-4">
                                <div className="flex items-center gap-2 mb-3">
                                    {isCompleted ? (
                                        <CheckCircle2 className="h-4 w-4 text-emerald-500"/>
                                    ) : isFailed ? (
                                        <XCircle className="h-4 w-4 text-destructive"/>
                                    ) : (
                                        <AlertCircle className="h-4 w-4 text-muted-foreground"/>
                                    )}
                                    <h3 className="text-sm font-semibold">
                                        {isCompleted ? t('execution.summaryCompleted') : isFailed ? t('execution.summaryFailed') : t('execution.summaryAborted')}
                                    </h3>
                                </div>
                                {/* 执行统计信息：步骤数、开始时间、完成时间 */}
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                        <p className="text-xs text-muted-foreground">{t('execution.started')}</p>
                                        <p className="font-medium text-xs">
                                            {new Date(detail.startedAt).toLocaleTimeString()}
                                        </p>
                                    </div>
                                    {detail.completedAt && (
                                        <div>
                                            <p className="text-xs text-muted-foreground">{t('execution.completed')}</p>
                                            <p className="font-medium text-xs">
                                                {new Date(detail.completedAt).toLocaleTimeString()}
                                            </p>
                                        </div>
                                    )}
                                </div>
                                {/* 执行成功后提供跳转到测试页面的入口 */}
                                {isCompleted && (
                                    <div className="mt-3 pt-3 border-t border-border/50">
                                        <Button
                                            size="sm"
                                            className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                            onClick={() => navigate(`/tests?executionId=${detail.id}`)}
                                        >
                                            <TestTube className="h-4 w-4 mr-1.5"/>
                                            {t('execution.runTests')}
                                        </Button>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
            {/* 技能确认弹窗 */}
            {skillConfirm.open && (
                <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="glass-panel rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
                        <h3 className="text-base font-semibold mb-2">技能执行确认</h3>
                        <p className="text-sm text-muted-foreground mb-1">
                            已完成技能：<span
                            className="font-medium text-foreground">{skillConfirm.completedSkill}</span>
                        </p>
                        <p className="text-sm text-muted-foreground mb-4">
                            下一个技能：<span className="font-medium text-foreground">{skillConfirm.nextSkill}</span>
                        </p>
                        <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={handleSkipSkill}>
                                跳过
                            </Button>
                            <Button size="sm" onClick={handleContinueSkill}>
                                继续执行
                            </Button>
                        </div>
                    </div>
                </div>
            )}
            <Joyride
                steps={guideSteps}
                run={guideRun}
                onEvent={handleJoyrideEvent}
                continuous
                options={{
                    showProgress: true,
                    skipBeacon: true,
                    primaryColor: '#f87171',
                    buttons: ['back', 'close', 'primary', 'skip'],
                    zIndex: 10000
                }}
            />
        </div>
    );
}
