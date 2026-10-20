/**
 * @file AgentExecutionPage.tsx
 * @description Agent自主执行页面 - 零配置，直接执行
 *
 * 核心功能：
 * - 左侧面板：Agent执行历史列表（按需求隔离，显示需求号+标题）
 * - 右侧面板：执行日志消息流（Think 折叠行 + 分类工具事件行 + 分组折叠日志）+ 底部输入条
 *   （原「思考过程 / 执行步骤」旁路面板已移除，thinking/tool 事件内联进日志流，
 *    对齐 DeepSeek Harness 的消息展示设计）
 * - 实时数据：bridge 透传 thinking/tool_use/tool_result → coordinator 解析写入 store
 * - WebSocket 推送：thought/subtask/status/log 事件实时更新
 */

import {useEffect, useRef, useState, useCallback, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {apiGet, apiPost, apiPut, apiDelete, pickFolder} from '../api';
import {notifyTaskResult} from '../utils/notification';
import {useAppStore} from '../stores/app-store';
import {cn, formatRelativeTime} from '../lib/utils';
import {
    Loader2,
    Send,
    MessageSquare,
    Clock,
    Terminal,
    Trash2,
    CheckCircle2,
    XCircle,
    AlertCircle,
    Pencil,
    Zap,
    Square,
    Sparkles,
    ChevronDown,
    ChevronUp,
    ChevronRight,
    FolderOpen,
    Folder,
    HardDrive,
    ArrowLeft,
    Check,
    Keyboard,
    X,
    FileText,
    Bot,
    Plus,
    FolderPlus,
    PanelRightOpen,
} from 'lucide-react';
import {Button} from '../components/ui/button';
import {Card, CardContent} from '../components/ui/card';
import {StatusIcon} from '../components/StatusIcon';
import ContextIndicator from '../components/ContextIndicator';
import {LogViewer} from '../components/LogViewer';
import {ChatInputBox} from '../components/ChatInputBox';
import WorkspacePanel from '../components/WorkspacePanel';
import {FloatingSidePanel} from '../components/FloatingSidePanel';
import {deliverableFilesFromMessages} from '../utils/agent-log-parse';
import {groupExecutionsByWorkspace} from '../utils/agent-workspace-groups';
import {dispatchChatCommand} from '../utils/command-dispatch';
import {useParsedLogs} from '../hooks/useParsedLogs';
import {useResizableWidth, ResizeHandle} from '../hooks/useResizableWidth';
import {DeliverablesCard} from '../components/DeliverablesCard';
import type {AgentExecutionSummary, AgentExecutionDetail, ExecutionStatus, AgentThought} from '../types/agent-types';

/** 已保存需求列表项（轻量，不需要完整 RequirementDetail） */
interface SavedRequirement {
    id: string;
    number?: string;
    title: string;
    description?: string;
}

/** 已保存工作区（轻量） */
interface SavedWorkspaceLite {
    id: string;
    path: string;
    name: string;
    projectType?: string;
}

/** 目录条目（文件夹选择器） */
interface DirectoryEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    size?: number;
    modifiedAt: string;
    extension?: string;
}

/** 工作空间下拉选项 */
interface WorkspaceOption {
    path: string;
    label: string;
    source: 'history' | 'saved' | 'manual';
}

/** 状态元数据映射 */
interface StatusMeta {
    label: string;
    icon: typeof CheckCircle2;
    colorClass: string;
}

const STATUS_META: Record<ExecutionStatus, StatusMeta> = {
    analyzing: {label: '分析中', icon: AlertCircle, colorClass: 'bg-amber-500/10 text-amber-500'},
    ready: {label: '就绪', icon: CheckCircle2, colorClass: 'bg-blue-500/10 text-blue-500'},
    running: {label: '执行中', icon: Loader2, colorClass: 'bg-blue-500/10 text-blue-500'},
    paused: {label: '已暂停', icon: Clock, colorClass: 'bg-amber-500/10 text-amber-500'},
    completed: {label: '已完成', icon: CheckCircle2, colorClass: 'bg-emerald-500/10 text-emerald-500'},
    failed: {label: '失败', icon: XCircle, colorClass: 'bg-destructive/10 text-destructive'},
    aborted: {label: '已中止', icon: XCircle, colorClass: 'bg-gray-500/10 text-gray-500'},
};

// === 辅助函数 ===

function statusIcon(status: string) {
    return <StatusIcon status={status}/>;
}

// 日志行解析与 tool_use/tool_result 配对：见 utils/agent-log-parse.ts（与执行页/计划页共用）

// === 主组件 ===

export default function AgentExecutionPage() {
    const {t} = useTranslation();

    const logsByExecution = useAppStore((s) => s.agents.logsByExecution);
    const setAgentExecutionLogs = useAppStore((s) => s.setAgentExecutionLogs);
    const removeAgentExecutionLogs = useAppStore((s) => s.removeAgentExecutionLogs);
    const setActiveAgentExecution = useAppStore((s) => s.setActiveAgentExecution);

    // 历史列表
    const [history, setHistory] = useState<AgentExecutionSummary[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

    // 当前执行
    const [activeId, setActiveId] = useState<string | null>(null);
    const [detail, setDetail] = useState<AgentExecutionDetail | null>(null);

    // 需求选择
    const [reqMode, setReqMode] = useState<'saved' | 'manual'>('saved');
    const [savedRequirements, setSavedRequirements] = useState<SavedRequirement[]>([]);
    const [selectedRequirement, setSelectedRequirement] = useState<SavedRequirement | null>(null);
    const [manualRequirementText, setManualRequirementText] = useState('');
    const [workspacePath, setWorkspacePath] = useState('');
    const [workspaceHistory, setWorkspaceHistory] = useState<string[]>([]);
    const [savedWorkspaces, setSavedWorkspaces] = useState<SavedWorkspaceLite[]>([]);

    // 工作空间选择 UI（下拉 / 文件夹浏览 / 手动输入）
    const [wsDropdownOpen, setWsDropdownOpen] = useState(false);
    const [wsBrowserOpen, setWsBrowserOpen] = useState(false);
    const [wsManualOpen, setWsManualOpen] = useState(false);
    const [manualWorkspacePath, setManualWorkspacePath] = useState('');
    const wsDropdownRef = useRef<HTMLDivElement>(null);

    // 回复
    const [replyText, setReplyText] = useState('');
    const [replying, setReplying] = useState(false);

    // 创建弹窗
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const dialogRef = useRef<HTMLDialogElement>(null);

    // 工作区预览侧边栏（内嵌 WorkspacePanel，跟随当前任务的项目空间）
    const [showWsPanel, setShowWsPanel] = useState(false);
    // 「本次产出」卡片 → 侧边栏打开文件信号（seq 递增保证重复打开同一文件也触发）
    const [wsOpenSignal, setWsOpenSignal] = useState<{path: string; seq: number} | null>(null);
    const openSeqRef = useRef(0);
    const handleOpenDeliverable = (p: string) => {
        setShowWsPanel(true);
        openSeqRef.current += 1;
        setWsOpenSignal({path: p, seq: openSeqRef.current});
    };
    // 悬浮工作区面板宽度（可拖拽调整；FloatingSidePanel 负责拖拽与夹取）
    const [wsPanelWidth, setWsPanelWidth] = useState(720);

    // 历史列表分组折叠（key 为 workspacePath，undefined 表示无工作空间组）
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    // 添加工作空间失败提示（成功由左侧新分组自证，无需提示）
    const [wsNotice, setWsNotice] = useState<string | null>(null);

    // 工具权限确认队列（agent 执行中 canUseTool 触发）。
    // 队列化：并行工具会连续产生多个权限请求，单弹窗 state 会互相覆盖导致
    // 请求丢失（后端挂着等确认 → 任务"无声卡死"）；逐个出队确认。
    // 每项携带自己的 executionId：后台任务的权限请求也允许确认，不受当前激活项限制。
    const [permQueue, setPermQueue] = useState<Array<{
        executionId: string;
        permissionRequestId: string;
        toolName?: string;
        toolInput?: Record<string, unknown>;
        title?: string;
    }>>([]);

    // AskUserQuestion 答案收集
    const [askUserAnswers, setAskUserAnswers] = useState<Record<string, string>>({});

    // 创建对话框：附加文档路径（相对工作区）
    const [docPaths, setDocPaths] = useState<string[]>([]);
    const [docInput, setDocInput] = useState('');

    // 运行中的排队消息（服务端 pendingReplies 为准：发送即排队，消费（自动续跑/
    // 立即处理）时才落日志上屏；轮询 detail 自动同步增减）
    const [processingNow, setProcessingNow] = useState(false);
    // 排队消息编辑态：正在编辑的下标 + 草稿（一次编辑一条；删除后索引位移，编辑态随之关闭）
    const [editingReplyIndex, setEditingReplyIndex] = useState<number | null>(null);
    const [editingReplyText, setEditingReplyText] = useState('');
    const [replyMutating, setReplyMutating] = useState(false);

    // DOM 引用
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // 本次任务期间是否见到过运行中状态（ref 跨 effect 重建保持，局部变量会因依赖抖动被重置）
    const sawRunningRef = useRef(false);

    // 派生状态（基于 STATUS_META，新增状态无需改 UI 代码）
    const execStatus = detail?.status ?? 'idle';
    const statusMeta = execStatus !== 'idle' ? STATUS_META[execStatus] : null;
    const isRunning = execStatus === 'running';
    const isDone = execStatus === 'completed' || execStatus === 'failed' || execStatus === 'aborted';
    const canStart = execStatus === 'ready';
    const canAbort = isRunning;

    const loadHistory = useCallback(async () => {
        setLoadingHistory(true);
        try {
            const data = await apiGet<AgentExecutionSummary[]>('/agent-execution/list');
            setHistory(data);
        } catch (err) {
            console.error('[AgentExec] loadHistory error:', err);
        } finally {
            setLoadingHistory(false);
        }
    }, []);

    useEffect(() => {
        loadHistory();
        loadSavedRequirements();
        loadWorkspaceHistory();
    }, []);

    const loadWorkspaceHistory = useCallback(async () => {
        try {
            // 同时加载历史记录与已保存工作区，保证下拉选项完整
            const [history, saved] = await Promise.all([
                apiGet<string[]>('/workspace/history'),
                apiGet<SavedWorkspaceLite[]>('/workspace/saved'),
            ]);
            setWorkspaceHistory(history || []);
            setSavedWorkspaces(saved || []);
        } catch (err) {
            console.error('[AgentExec] loadWorkspaceHistory error:', err);
        }
    }, []);

    const loadSavedRequirements = useCallback(async () => {
        try {
            const data = await apiGet<SavedRequirement[]>('/requirements/saved');
            setSavedRequirements(data);
        } catch (err) {
            console.error('[AgentExec] loadSavedRequirements error:', err);
        }
    }, []);

    const loadDetail = useCallback(async (id: string) => {
        try {
            const data = await apiGet<AgentExecutionDetail>(`/agent-execution/${id}/detail`);
            setDetail(data);
            setActiveId(id);
            setWorkspacePath(data.workspacePath);
            // 用历史日志初始化该执行的分桶（多 Agent 隔离：每个任务只读自己的桶）
            setAgentExecutionLogs(id, data.logs || []);
            // 记录当前活跃执行
            setActiveAgentExecution(id);
        } catch (err) {
            console.error('[AgentExec] loadDetail error:', err);
        }
    }, [setAgentExecutionLogs, setActiveAgentExecution]);

    /** 添加工作空间：系统文件夹选择器 → 保存 → 刷新工作区数据（供分组名/侧边栏使用） */
    const handleAddWorkspace = async () => {
        const picked = await pickFolder(t('workspace.selectFolder'));
        if (!picked) return;
        try {
            await apiPost('/workspace/saved', {path: picked});
            setWsNotice(null);
            // 保存成功后刷新：新工作空间会立刻以空分组出现在左侧列表（可见即成功）
            await loadWorkspaceHistory();
        } catch (err) {
            console.error('[AgentExec] 添加工作空间失败:', err);
            // 失败时给出可见反馈（此前只在 console，界面上看起来像"点了没反应"）
            setWsNotice(err instanceof Error ? err.message : '添加工作空间失败');
            setTimeout(() => setWsNotice(null), 5000);
        }
    };

    const openCreateDialog = (presetWorkspacePath?: string) => {
        setSelectedRequirement(null);
        setManualRequirementText('');
        setReqMode('saved');
        // 重置工作空间选择 UI
        setWsDropdownOpen(false);
        setWsBrowserOpen(false);
        setWsManualOpen(false);
        setManualWorkspacePath('');
        if (presetWorkspacePath) setWorkspacePath(presetWorkspacePath);
        setShowCreateDialog(true);
        // 延迟调用 showModal，确保 DOM 已渲染
        requestAnimationFrame(() => dialogRef.current?.showModal());
    };

    const closeCreateDialog = () => {
        dialogRef.current?.close();
        setShowCreateDialog(false);
        setWsDropdownOpen(false);
        setWsBrowserOpen(false);
        setWsManualOpen(false);
    };

    // 合并历史 + 已保存工作区为下拉选项（去重，最近使用的历史优先）
    const workspaceOptions = useMemo<WorkspaceOption[]>(() => {
        const map = new Map<string, WorkspaceOption>();
        for (const p of workspaceHistory) {
            if (p && !map.has(p)) map.set(p, {path: p, label: p, source: 'history'});
        }
        for (const ws of savedWorkspaces) {
            if (ws?.path && !map.has(ws.path)) {
                map.set(ws.path, {
                    path: ws.path,
                    label: ws.name && ws.name !== ws.path.split(/[\\/]/).pop()
                        ? `${ws.name} (${ws.path})`
                        : ws.path,
                    source: 'saved',
                });
            }
        }
        return [...map.values()];
    }, [workspaceHistory, savedWorkspaces]);

    // 历史列表按工作空间（项目）分组：见 utils/agent-workspace-groups.ts
    // （已保存但无执行记录的工作空间也会成空组列出，保证「添加工作空间」立即可见）
    const groupedHistory = useMemo(
        () => groupExecutionsByWorkspace(history, savedWorkspaces),
        [history, savedWorkspaces],
    );

    const toggleGroup = (key: string) => {
        setCollapsedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    // 点击空白处关闭工作空间下拉
    useEffect(() => {
        if (!wsDropdownOpen) return;
        const handler = (e: MouseEvent) => {
            if (wsDropdownRef.current && !wsDropdownRef.current.contains(e.target as Node)) {
                setWsDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [wsDropdownOpen]);

    const handleCreate = async () => {
        if (!workspacePath) return;

        let requirementText = '';
        let requirementId = '';
        let requirementNumber = '';
        let requirementTitle = '';

        if (reqMode === 'saved' && selectedRequirement) {
            requirementText = selectedRequirement.description || '';
            requirementId = selectedRequirement.id;
            requirementNumber = selectedRequirement.number || '';
            requirementTitle = selectedRequirement.title || '';
        } else if (reqMode === 'manual') {
            requirementText = manualRequirementText;
        }
        // 需求可选：无需求时用占位文本，用户后续通过回复补充

        try {
            const res = await apiPost<{ executionId: string }>('/agent-execution/create', {
                requirementText: requirementText || '（待补充需求）',
                requirementId: requirementId || undefined,
                requirementNumber: requirementNumber || undefined,
                requirementTitle: requirementTitle || undefined,
                workspacePath,
                documentPaths: docPaths.length > 0 ? docPaths : undefined,
            });
            closeCreateDialog();
            setDocPaths([]);
            setDocInput('');
            await loadDetail(res.executionId);
            loadHistory();
            loadWorkspaceHistory();
        } catch (err) {
            console.error('创建失败:', err);
        }
    };

    /** 开始执行（canStart 时由输入框发送触发；允许空文案，附件一并带给 /start） */
    const handleStart = async (text: string, attachmentIds: string[]) => {
        if (!activeId) return;
        try {
            // 将输入框中的详细内容一并发送（用户可能输入了细节但未点「发送」）
            const message = text.trim() || undefined;
            setReplyText('');
            await apiPost(`/agent-execution/${activeId}/start`, {
                message,
                attachmentIds: attachmentIds.length ? attachmentIds : undefined,
            });
            loadDetail(activeId);
            loadHistory();
        } catch (err) {
            console.error('[AgentExec] 启动失败:', err);
        }
    };

    const handleAbort = async () => {
        if (!activeId) return;
        try {
            await apiPost(`/agent-execution/${activeId}/abort`);
            loadDetail(activeId);
            loadHistory();
        } catch (err) {
            console.error('中止失败:', err);
        }
    };

    /** 回复 / 排队：isRunning 时消息进服务端 pendingReplies；附件以 attachmentIds 旁路传递 */
    const handleReplyWithAttachments = async (text: string, attachmentIds: string[]) => {
        if (!activeId || !text.trim() || replying) return;
        setReplying(true);
        setReplyText('');
        try {
            // queued=true 时消息进服务端 pendingReplies（不落日志，不上屏），
            // 队列条与消费时机均以 detail.pendingReplies 为准
            await apiPost<{queued?: boolean}>(`/agent-execution/${activeId}/reply`, {
                message: text.trim(),
                attachmentIds: attachmentIds.length ? attachmentIds : undefined,
            });
            loadDetail(activeId);
        } catch (err) {
            console.error('回复失败:', err);
        } finally {
            setReplying(false);
        }
    };

    /** 立即处理排队消息：中止当前轮，自动带新消息续跑 */
    const handleProcessNow = async () => {
        if (!activeId || processingNow) return;
        setProcessingNow(true);
        try {
            await apiPost(`/agent-execution/${activeId}/process-now`, {});
            // 立即同步详情：排队条以服务端 drain 后的状态为准
            //（drain 发生在 abort 完成后，queued_update 事件 + 轮询双兜底最终一致）
            await loadDetail(activeId);
        } catch (err) {
            console.error('立即处理失败:', err);
        } finally {
            setProcessingNow(false);
        }
    };

    /** 编辑排队消息（按下标 PUT；成功/失败都刷新 detail 同步列表 —— 索引可能已被消费位移） */
    const handleEditQueuedReply = async (index: number, message: string) => {
        if (!activeId || replyMutating || !message.trim()) return;
        setReplyMutating(true);
        try {
            await apiPut(`/agent-execution/${activeId}/replies/${index}`, {message: message.trim()});
            setEditingReplyIndex(null);
        } catch (err) {
            console.error('[AgentExec] 编辑排队消息失败:', err);
        } finally {
            await loadDetail(activeId);
            setReplyMutating(false);
        }
    };

    /** 删除排队消息（不想让执行的内容直接移出队列；删除后索引位移，关闭编辑态） */
    const handleDeleteQueuedReply = async (index: number) => {
        if (!activeId || replyMutating) return;
        setReplyMutating(true);
        try {
            await apiDelete(`/agent-execution/${activeId}/replies/${index}`);
            setEditingReplyIndex(null);
        } catch (err) {
            console.error('[AgentExec] 删除排队消息失败:', err);
        } finally {
            await loadDetail(activeId);
            setReplyMutating(false);
        }
    };

    // 确认工具权限：decision=allow/deny，remember 仅 allow 时生效（本次执行内同类工具自动放行）。
    // 处理队首请求并出队，确认发往该请求所属的 executionId（不依赖当前激活项）
    const handleConfirmTool = async (decision: 'allow' | 'deny', remember = false, modifiedInput?: Record<string, unknown>) => {
        const head = permQueue[0];
        if (!head) return;
        const permissionRequestId = head.permissionRequestId;
        setPermQueue((q) => q.slice(1));
        setAskUserAnswers({});
        try {
            await apiPost(`/agent-execution/${head.executionId}/confirm-tool`, {
                permissionRequestId,
                decision,
                remember,
                ...(modifiedInput ? {modifiedInput} : {}),
            });
        } catch (err) {
            console.error('工具确认失败:', err);
        }
    };

    const handleDelete = async (id: string, status: ExecutionStatus, e: React.MouseEvent) => {
        e.stopPropagation();

        // 运行中的执行不允许直接删除
        if (status === 'running') return;

        if (!confirm('确定删除此执行记录？删除后不可恢复。')) return;

        try {
            await apiDelete(`/agent-execution/${id}`);
            await loadHistory();
            // 清理该执行的分桶日志，避免内存残留
            removeAgentExecutionLogs(id);
            if (activeId === id) {
                setDetail(null);
                setActiveId(null);
                setActiveAgentExecution(null);
            }
        } catch (err) {
            console.error('[AgentExec] delete error:', err);
        }
    };

    const handleNewSession = async () => {
        if (!activeId) return;
        try {
            await apiPost(`/agent-execution/${activeId}/new-session`, {});
            // 刷新详情以反映新会话状态
            await loadDetail(activeId);
        } catch (err) {
            console.error('新会话创建失败:', err);
        }
    };

    // 监听 WebSocket CustomEvent，实时更新 detail 状态（不依赖轮询）
    useEffect(() => {
        if (!activeId) return;

        const handler = (e: Event) => {
            const {type, executionId, ...data} = (e as CustomEvent).detail;

            // 工具权限请求：入确认队列（在 activeId 过滤之前处理——
            // 后台执行的任务同样需要确认，否则弹窗被吞、后端挂到超时）
            if (type === 'permission_request') {
                const permissionRequestId = data.permissionRequestId as string;
                if (permissionRequestId) {
                    setPermQueue((q) =>
                        q.some((p) => p.permissionRequestId === permissionRequestId)
                            ? q
                            : [...q, {
                                executionId: executionId as string,
                                permissionRequestId,
                                toolName: data.toolName as string,
                                toolInput: data.toolInput as Record<string, unknown>,
                                title: (data.title as string) || (data.displayName as string) || '',
                            }],
                    );
                }
                return;
            }

            // 侧边栏列表状态：**任何**执行的状态变化都要实时落进 history。
            // 此前 history 只在创建/启动/完成时各拉一次，而 /start 是异步的
            // （POST 返回时服务端可能还是 ready），于是列表要切换任务或刷新页面才更新。
            if (type === 'status' && typeof executionId === 'string' && typeof data.status === 'string') {
                const nextStatus = data.status as ExecutionStatus;
                setHistory(prev => {
                    const i = prev.findIndex(h => h.id === executionId);
                    if (i < 0 || prev[i].status === nextStatus) return prev;
                    const next = [...prev];
                    next[i] = {...next[i], status: nextStatus};
                    return next;
                });
                // 终态：再向服务端要一次列表（补 updatedAt / 新增项 / 排序）
                if (nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'aborted') {
                    loadHistory();
                }
            }

            if (executionId !== activeId) return;

            // 排队消息已被服务端消费（drain 完成即广播）：本地队列立即清空，
            // 排队条即时消失——不等下一次轮询（轮询异常停摆时这是唯一的清队信号）
            if (type === 'queued_update' && data.queued === false) {
                setDetail(prev => prev ? {...prev, pendingReplies: []} : prev);
                return;
            }

            setDetail(prev => {
                if (!prev) return prev;
                switch (type) {
                    case 'status':
                        return {...prev, status: data.status as AgentExecutionDetail['status']};
                    case 'log':
                        return {...prev, logs: [...prev.logs, data.log as string]};
                    case 'thought':
                        return {...prev, thoughts: [...prev.thoughts, data.thought as AgentThought]};
                    case 'subtask': {
                        const subTaskId = data.subTaskId as string;
                        const stepIdx = prev.steps.findIndex(s => s.id === subTaskId);
                        if (stepIdx >= 0) {
                            const steps = [...prev.steps];
                            const newStatus = data.status as AgentExecutionDetail['steps'][0]['status'];
                            steps[stepIdx] = {
                                ...steps[stepIdx],
                                status: newStatus,
                                // 完成或失败时记录结束时间
                                ...(newStatus === 'completed' || newStatus === 'failed'
                                    ? {completedAt: new Date().toISOString()}
                                    : {}),
                            };
                            return {...prev, steps};
                        }
                        // 新 step（running 状态）
                        if (data.status === 'running') {
                            return {
                                ...prev, steps: [...prev.steps, {
                                    id: subTaskId,
                                    title: (data.title as string) || 'Tool',
                                    status: 'running' as const,
                                    startedAt: new Date().toISOString(),
                                    logs: [],
                                }]
                            };
                        }
                        return prev;
                    }
                    case 'stepLog': {
                        // 步骤级日志：追加到对应步骤的 logs 数组
                        const stepId = data.stepId as string;
                        const logText = data.log as string;
                        if (!stepId || !logText) return prev;
                        const stepIdx = prev.steps.findIndex(s => s.id === stepId);
                        if (stepIdx < 0) return prev;
                        const steps = [...prev.steps];
                        steps[stepIdx] = {
                            ...steps[stepIdx],
                            logs: [...steps[stepIdx].logs, logText],
                        };
                        return {...prev, steps};
                    }
                    default:
                        return prev;
                }
            });
        };

        window.addEventListener('agent-execution:update', handler);
        return () => window.removeEventListener('agent-execution:update', handler);
    }, [activeId, loadHistory]);

    // 轮询当前执行状态（不再被 isRunning 阻断，避免 ready→running 竞态）。
    // 终态不再「停死」轮询：降为 10s 低频兜底，重新执行恢复 1.5s 高频——
    // 此前终态直接 clearInterval，一旦轮询恰好落在瞬时终态窗口（如中断续跑），
    // 页面从此拿不到新数据（排队条永久滞留的帮凶之一）
    useEffect(() => {
        if (!activeId) return;

        let cancelled = false;
        let fast = true; // 当前轮询频率：running 1.5s / 非 running 10s
        sawRunningRef.current = false;

        const poll = async () => {
            try {
                const data = await apiGet<AgentExecutionDetail>(`/agent-execution/${activeId}/detail`);
                if (cancelled) return;
                setDetail(data);
                if (data.status === 'running') {
                    sawRunningRef.current = true;
                }
                const wantFast = data.status === 'running';
                if (wantFast !== fast) {
                    fast = wantFast;
                    if (!wantFast) {
                        // 进入终态：刷新一次列表；通知只在「本轮见过 running」后发一次
                        if (sawRunningRef.current) {
                            sawRunningRef.current = false;
                            notifyTaskResult(data.status, data.requirementTitle);
                        }
                        loadHistory();
                    }
                    if (pollRef.current) clearInterval(pollRef.current);
                    pollRef.current = setInterval(poll, fast ? 1500 : 10_000);
                }
            } catch {
                // 继续轮询
            }
        };

        poll();
        pollRef.current = setInterval(poll, 1500);

        return () => {
            cancelled = true;
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [activeId, loadHistory]);

    useEffect(() => {
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
            // 离开页面时清除活跃执行标记，避免后台事件继续写入全局日志缓冲
            setActiveAgentExecution(null);
        };
    }, [setActiveAgentExecution]);

    // 日志消息（当前执行分桶 → LogMessageData[]，供 LogViewer 渲染；多 Agent 并行互不混入）
    const currentLogs = activeId ? (logsByExecution[activeId] || []) : [];
    const logMessages = useParsedLogs(currentLogs, {finalizeRunning: isDone});
    // 本次产出：写类工具（Write/Edit/MultiEdit/NotebookEdit）成功变更的文件（执行结束后展示）
    const deliverables = useMemo(() => deliverableFilesFromMessages(logMessages), [logMessages]);
    // 排队消息（服务端为准）：仅运行中显示，消费后自动清空
    const pendingReplies = isRunning ? (detail?.pendingReplies ?? []) : [];

    // 左侧执行列表宽度可拖拽（默认比原先 256 更窄，把宽度留给消息输出区）
    const {
        width: listWidth,
        dragging: draggingList,
        onHandlePointerDown: onListHandleDown,
        reset: resetListWidth,
    } = useResizableWidth('adw.agentExec.listWidth', 208, {min: 150, max: 420});

    return (
        <div className="flex h-full">
            {/* ====== 左侧面板：执行历史列表（宽度可拖拽，默认更窄） ====== */}
            <div
                className={cn(
                    'relative flex flex-col border-r border-border bg-muted/10 shrink-0',
                    !draggingList && 'transition-[width] duration-200 ease-out',
                )}
                style={{width: listWidth}}
            >
                <ResizeHandle
                    dragging={draggingList}
                    onPointerDown={onListHandleDown}
                    onDoubleClick={resetListWidth}
                    title="拖动调整列表宽度（双击恢复默认）"
                />
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                    <span className="label-strong text-xs uppercase tracking-wide">
                        执行历史
                    </span>
                    <div className="flex items-center gap-1.5">
                        <button
                            onClick={handleAddWorkspace}
                            className="p-1 rounded-md hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
                            title="添加工作空间"
                        >
                            <FolderPlus className="h-4 w-4"/>
                        </button>
                        {loadingHistory && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground"/>}
                    </div>
                </div>

                {wsNotice && (
                    <div
                        className="px-3 py-1.5 text-[11px] text-destructive bg-destructive/10 border-b border-destructive/20 break-all">
                        {wsNotice}
                    </div>
                )}

                <div className="flex-1 overflow-y-auto">
                    {groupedHistory.length === 0 && !loadingHistory && (
                        <div className="flex flex-col items-center justify-center py-8 px-4 text-center gap-2">
                            <Terminal className="h-7 w-7 text-muted-foreground/30"/>
                            <p className="text-xs text-muted-foreground">暂无执行记录</p>
                        </div>
                    )}

                    {groupedHistory.map((group) => {
                        const groupKey = group.path || '__none__';
                        const collapsed = collapsedGroups.has(groupKey);
                        return (
                            <div key={groupKey}>
                                {/* 分组头：项目名 + 数量 + 折叠 + 新建（预填该项目空间） */}
                                <div
                                    onClick={() => toggleGroup(groupKey)}
                                    className="group sticky top-0 z-10 flex items-center gap-1.5 px-3 py-1.5 bg-muted/40 border-b border-border/60 cursor-pointer select-none hover:bg-muted/70 transition-colors"
                                    title={group.path || ''}
                                >
                                    <ChevronRight className={cn(
                                        'h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform',
                                        !collapsed && 'rotate-90',
                                    )}/>
                                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-400"/>
                                    <span className="text-xs font-semibold truncate flex-1 min-w-0">{group.label}</span>
                                    <span className="text-[10px] text-muted-foreground/60 shrink-0">{group.items.length}</span>
                                    {group.path && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                openCreateDialog(group.path);
                                            }}
                                            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-primary/10 hover:text-primary transition-all shrink-0"
                                            title={`在 ${group.label} 中新建执行`}
                                        >
                                            <Plus className="h-3.5 w-3.5"/>
                                        </button>
                                    )}
                                </div>

                                {!collapsed && group.items.length === 0 && (
                                    <div className="px-3 py-2 text-[11px] text-muted-foreground/70">
                                        暂无执行记录 —— 悬停分组头点「+」可在此项目空间新建执行
                                    </div>
                                )}

                                {!collapsed && group.items.map((exec) => (
                                    <div
                                        key={exec.id}
                                        onClick={() => loadDetail(exec.id)}
                                        className={cn(
                                            'group flex items-start gap-2 px-3 py-2.5 pl-5 cursor-pointer border-b border-border/50 transition-colors',
                                            activeId === exec.id
                                                ? 'bg-primary/5 border-l-2 border-l-primary'
                                                : 'hover:bg-accent/50'
                                        )}
                                    >
                                        <div className="mt-0.5 shrink-0">{statusIcon(exec.status)}</div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-medium truncate text-foreground">
                                                {exec.requirementNumber ? `${exec.requirementNumber} ` : ''}{exec.requirementTitle || '未命名需求'}
                                            </p>
                                            <div className="flex items-center gap-1.5 mt-0.5">
                                                <Clock className="h-3 w-3 text-muted-foreground/50"/>
                                                <span className="text-xs text-muted-foreground/60">
                                                    {formatRelativeTime(exec.createdAt)}
                                                </span>
                                            </div>
                                        </div>
                                        {exec.status !== 'running' && (
                                            <button
                                                onClick={(e) => handleDelete(exec.id, exec.status, e)}
                                                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 hover:text-destructive transition-all shrink-0"
                                                title="删除"
                                            >
                                                <Trash2 className="h-3.5 w-3.5"/>
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ====== 右侧面板 ====== */}
            <div className="relative flex-1 flex flex-col min-w-0">
                {/* 页面头部：压缩为单行（高度让给消息输出区） */}
                <div className="border-b border-border px-4 py-2 shrink-0">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-baseline gap-2 min-w-0">
                            <h1 className="text-base font-semibold brand-gradient-text shrink-0">
                                Agent 执行
                            </h1>
                            <p className="hidden lg:block text-[11px] text-muted-foreground truncate">选择需求，Agent自主完成开发</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs btn-key border-primary/40"
                                onClick={() => openCreateDialog()}
                            >
                                <Plus className="h-3.5 w-3.5 mr-1"/>
                                新建执行
                            </Button>
                            {!showWsPanel && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs btn-key border-primary/40"
                                    onClick={() => setShowWsPanel(true)}
                                    title="工作区预览"
                                >
                                    <PanelRightOpen className="h-3.5 w-3.5 mr-1"/>
                                    工作区
                                </Button>
                            )}
                            {activeId && statusMeta && (
                                <div className={cn(
                                    'flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium transition-colors',
                                    statusMeta.colorClass,
                                )}>
                                    {isRunning && <Loader2 className="h-3 w-3 animate-spin"/>}
                                    {!isRunning && <statusMeta.icon className="h-3 w-3"/>}
                                    {statusMeta.label}
                                </div>
                            )}
                            {canStart && (
                                <span className="text-[11px] text-muted-foreground">在下方输入框描述任务后点击「开始执行」</span>
                            )}
                        </div>
                    </div>
                </div>

                {/* 右侧内容区（未选择 / 已选择）：日志区 flex 填满剩余高度（不固定视口高度，避免面板下方留空） */}
                {/* 消息输出区：内边距压紧，把空间尽量留给输出 */}
                <div className="flex-1 min-h-0 px-3 pt-2 flex flex-col">

                    {/* ====== 未选择执行：空状态提示 ====== */}
                    {!activeId && (
                        <div className="flex items-center justify-center h-full">
                            <div className="flex flex-col items-center gap-3">
                                <Terminal className="h-10 w-10 text-muted-foreground/30"/>
                                <p className="text-sm text-muted-foreground">点击右上角「新建执行」开始</p>
                            </div>
                        </div>
                    )}

                    {/* ====== 已选择执行：详情面板 ======
                         实时日志面板（统一 LogViewer：分组折叠 / 工具栏 / Think 与工具事件行 / 贴底自动滚动）。
                         flex 填满剩余高度使内部滚动生效（stick-to-bottom 挂在内部滚动容器上，
                         固定视口高度会在内容不足时下方留大片空白，无界增长则内部永不溢出、自动滚动失效） */}
                    {activeId && detail && (
                        <div className="flex-1 min-h-0 flex flex-col">
                            <LogViewer
                                key={activeId}
                                className="h-full"
                                messages={logMessages}
                                title="执行日志"
                                isStreaming={isRunning}
                                emptyText={isRunning ? 'Agent正在执行...' : '等待执行...'}
                                onClear={() => activeId && setAgentExecutionLogs(activeId, [])}
                                showJumpBar
                                jumpBarPaths={['/agent-execution']}
                            />
                        </div>
                    )}

                    {/* 本次产出：执行结束后列出写类工具变更的文件（点击在右侧工作区预览打开） */}
                    {isDone && deliverables.length > 0 && (
                        <DeliverablesCard
                            files={deliverables}
                            onOpenFile={handleOpenDeliverable}
                            className="mt-3 shrink-0"
                        />
                    )}
                </div>

                {/* --- 底部消息输入：压缩为紧凑底条（把高度让给消息输出区） --- */}
                {activeId && detail && (
                    <div className="shrink-0 px-3 pb-2.5 pt-1">
                        <div className="floating-input-card w-full rounded-xl border border-primary/25 shadow-xl">
                            <div className="p-2">
                                <div className="flex items-center justify-between mb-1.5">
                                    <div className="flex items-center gap-1.5">
                                        <MessageSquare className="h-3.5 w-3.5 text-primary"/>
                                        <span className="text-xs font-semibold">发送消息给 Agent</span>
                                    </div>
                                    <ContextIndicator
                                        logs={currentLogs}
                                        onSuggestNewSession={handleNewSession}
                                    />
                                </div>
                                    {/* 排队消息列表：运行中发送的消息在服务端排队（不上屏），消费时才进对话流。
                                        每条支持编辑/删除（服务端按下标操作，轮询与操作后刷新自动同步） */}
                                    {pendingReplies.length > 0 && (
                                        <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-1.5 text-xs text-amber-600 min-w-0">
                                                    <Clock className="h-3.5 w-3.5 shrink-0"/>
                                                    <span className="shrink-0">{pendingReplies.length} 条消息排队中</span>
                                                    <span className="truncate text-amber-600/70">
                                                        （当前轮结束后自动处理：{pendingReplies[pendingReplies.length - 1].slice(0, 40)}）
                                                    </span>
                                                </div>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={handleProcessNow}
                                                    disabled={processingNow}
                                                    className="h-6 shrink-0 text-[11px] border-amber-500/50 text-amber-600 hover:bg-amber-500/10"
                                                >
                                                    {processingNow ? <Loader2 className="h-3 w-3 animate-spin"/> : <Zap className="h-3 w-3 mr-1"/>}
                                                    立即处理
                                                </Button>
                                            </div>
                                            <ul className="mt-2 space-y-1">
                                                {pendingReplies.map((text, index) => (
                                                    editingReplyIndex === index ? (
                                                        <li key={index} className="rounded border border-amber-500/40 bg-background/60 p-2">
                                                            <textarea
                                                                value={editingReplyText}
                                                                onChange={(e) => setEditingReplyText(e.target.value)}
                                                                rows={3}
                                                                autoFocus
                                                                aria-label={t('common.edit')}
                                                                className="w-full resize-none rounded border border-border/60 bg-transparent p-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                                                            />
                                                            <div className="mt-1.5 flex justify-end gap-1.5">
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    className="h-6 px-2 text-[11px]"
                                                                    onClick={() => setEditingReplyIndex(null)}
                                                                >
                                                                    {t('common.cancel')}
                                                                </Button>
                                                                <Button
                                                                    size="sm"
                                                                    className="h-6 px-2 text-[11px]"
                                                                    disabled={replyMutating || !editingReplyText.trim()}
                                                                    onClick={() => void handleEditQueuedReply(index, editingReplyText)}
                                                                >
                                                                    {replyMutating ? <Loader2 className="h-3 w-3 animate-spin"/> : <Check className="h-3 w-3 mr-1"/>}
                                                                    {t('common.save')}
                                                                </Button>
                                                            </div>
                                                        </li>
                                                    ) : (
                                                        <li
                                                            key={index}
                                                            className="group flex items-start gap-2 rounded px-1.5 py-1 transition-colors hover:bg-amber-500/10"
                                                        >
                                                            <span className="mt-0.5 shrink-0 rounded bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                                                                {index + 1}
                                                            </span>
                                                            <span className="min-w-0 flex-1 break-all text-xs text-foreground/85" title={text}>
                                                                {text}
                                                            </span>
                                                            <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                                                <button
                                                                    type="button"
                                                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                                                    title={t('common.edit')}
                                                                    disabled={replyMutating}
                                                                    onClick={() => {
                                                                        setEditingReplyIndex(index);
                                                                        setEditingReplyText(text);
                                                                    }}
                                                                >
                                                                    <Pencil className="h-3 w-3"/>
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                                                    title={t('common.delete')}
                                                                    disabled={replyMutating}
                                                                    onClick={() => void handleDeleteQueuedReply(index)}
                                                                >
                                                                    <Trash2 className="h-3 w-3"/>
                                                                </button>
                                                            </div>
                                                        </li>
                                                    )
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                    {/* 统一输入框：就绪=发送即开始执行（允许空文案）；运行中=发送即排队；其余=发送即回复 */}
                                    <ChatInputBox
                                        value={replyText}
                                        onChange={setReplyText}
                                        onSend={async (text, atts) => {
                                            const attachmentIds = atts.map(a => a.attachmentId);
                                            // 斜杠命令 / 技能：先交服务端分发（命令不下发给模型）
                                            const outcome = await dispatchChatCommand(text, {
                                                executionId: activeId ?? undefined,
                                                workspacePath: detail?.workspacePath,
                                            });
                                            if (outcome) {
                                                setReplyText('');
                                                if (outcome.name === 'clear') {
                                                    if (activeId) setAgentExecutionLogs(activeId, []);
                                                }
                                                if (outcome.handled) {
                                                    // 结果已由服务端写入日志流；刷新一次详情同步状态
                                                    if (activeId) await loadDetail(activeId);
                                                    return;
                                                }
                                                // 技能/自定义命令：用展开后的模板替代原文发给模型
                                                text = outcome.sendText ?? text;
                                            }
                                            if (canStart) {
                                                await handleStart(text, attachmentIds);
                                            } else {
                                                await handleReplyWithAttachments(text.trim(), attachmentIds);
                                            }
                                        }}
                                        placeholder={
                                            canStart
                                                ? t('agents.inputStartPlaceholder')
                                                : isRunning
                                                    ? t('agents.inputQueuePlaceholder')
                                                    : t('agents.inputReplyPlaceholder')
                                        }
                                        rows={2}
                                        title="发送消息给 Agent"
                                        optimizable
                                        optimizePurpose="reply"
                                        allowEmptySend={canStart && !!activeId}
                                        sending={replying}
                                        branchWorkspacePath={detail?.workspacePath}
                                        branchDisabled={isRunning}
                                        actions={
                                            isRunning ? (
                                                <Button
                                                    onClick={handleAbort}
                                                    variant="outline"
                                                    size="icon"
                                                    className="shrink-0 text-destructive hover:text-destructive"
                                                    title="终止"
                                                    aria-label="终止"
                                                >
                                                    <Square className="h-4 w-4"/>
                                                </Button>
                                            ) : undefined
                                        }
                                    />
                                </div>
                        </div>
                    </div>
                )}
            </div>

            {/* ====== 右侧悬浮工作区预览（Portal 到 body，覆盖在内容之上，不挤压主页面）====== */}
            <FloatingSidePanel
                open={showWsPanel}
                title="工作区预览"
                width={wsPanelWidth}
                onWidthChange={setWsPanelWidth}
                onClose={() => setShowWsPanel(false)}
            >
                <WorkspacePanel
                    defaultWorkspacePath={detail?.workspacePath}
                    showWorkspaceList={false}
                    openFileSignal={wsOpenSignal}
                />
            </FloatingSidePanel>

            {/* ====== 新建执行弹窗 ====== */}
            <dialog
                ref={dialogRef}
                onClose={() => setShowCreateDialog(false)}
                className="backdrop:bg-black/50 bg-transparent p-0 m-auto"
            >
                <div className="bg-background border border-border rounded-lg shadow-xl w-[480px] p-6 space-y-4 max-h-[85vh] overflow-y-auto">
                    <h2 className="text-sm font-semibold">新建 Agent 执行</h2>

                    {/* 工作空间（必选） */}
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                            工作空间 <span className="text-destructive">*</span>
                        </label>

                        {/* 自定义下拉：历史 + 已保存工作区（避免原生 select 在 dialog 内被裁剪） */}
                        <div className="relative" ref={wsDropdownRef}>
                            <button
                                type="button"
                                onClick={() => setWsDropdownOpen(o => !o)}
                                className={cn(
                                    'w-full h-9 flex items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                    !workspacePath && 'text-muted-foreground',
                                )}
                            >
                                <span className="truncate font-mono text-xs">
                                    {workspacePath || '选择工作空间...'}
                                </span>
                                <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', wsDropdownOpen && 'rotate-180')}/>
                            </button>

                            {wsDropdownOpen && (
                                <div className="absolute z-30 mt-1 w-full rounded-md border border-border bg-background shadow-xl max-h-48 overflow-y-auto">
                                    {workspaceOptions.length === 0 && (
                                        <p className="text-xs text-muted-foreground p-3 text-center">
                                            暂无历史工作空间，可通过下方「浏览文件夹」选择
                                        </p>
                                    )}
                                    {workspaceOptions.map((opt) => (
                                        <button
                                            key={opt.path}
                                            type="button"
                                            onClick={() => {
                                                setWorkspacePath(opt.path);
                                                setWsDropdownOpen(false);
                                            }}
                                            className={cn(
                                                'w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors border-b border-border/50 last:border-0',
                                                workspacePath === opt.path && 'bg-primary/5',
                                            )}
                                        >
                                            {opt.source === 'saved'
                                                ? <FolderOpen className="h-3.5 w-3.5 text-blue-400 shrink-0"/>
                                                : <Folder className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0"/>}
                                            <span className="flex-1 min-w-0">
                                                <span className="block text-xs font-medium truncate">{opt.label}</span>
                                                <span className="block text-[10px] text-muted-foreground/60 truncate font-mono">{opt.path}</span>
                                            </span>
                                            {workspacePath === opt.path && (
                                                <Check className="h-3.5 w-3.5 text-primary shrink-0"/>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* 选择方式：浏览文件夹 / 手动输入 */}
                        <div className="flex items-center gap-2 mt-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    setWsBrowserOpen(o => !o);
                                    setWsManualOpen(false);
                                }}
                            >
                                <HardDrive className="h-3.5 w-3.5 mr-1.5"/>
                                浏览文件夹
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    setWsManualOpen(o => !o);
                                    setWsBrowserOpen(false);
                                }}
                            >
                                <Keyboard className="h-3.5 w-3.5 mr-1.5"/>
                                手动输入
                            </Button>
                            {workspacePath && (
                                <span className="text-[10px] text-muted-foreground truncate flex-1 text-right font-mono">
                                    {workspacePath}
                                </span>
                            )}
                        </div>

                        {/* 文件夹浏览器（从系统盘符开始） */}
                        {wsBrowserOpen && (
                            <FolderBrowser
                                currentPath={workspacePath}
                                onPick={(p) => {
                                    setWorkspacePath(p);
                                    setWsBrowserOpen(false);
                                }}
                                onClose={() => setWsBrowserOpen(false)}
                            />
                        )}

                        {/* 手动输入路径 */}
                        {wsManualOpen && (
                            <div className="flex gap-2 mt-2">
                                <input
                                    type="text"
                                    value={manualWorkspacePath}
                                    onChange={(e) => setManualWorkspacePath(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const v = manualWorkspacePath.trim();
                                            if (v) {
                                                setWorkspacePath(v);
                                                setWsManualOpen(false);
                                            }
                                        }
                                    }}
                                    placeholder="例如 D:\\projects\\my-app"
                                    className="flex-1 h-9 rounded-md border border-input bg-transparent px-3 py-1 text-xs font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                />
                                <Button
                                    size="sm"
                                    onClick={() => {
                                        const v = manualWorkspacePath.trim();
                                        if (v) {
                                            setWorkspacePath(v);
                                            setWsManualOpen(false);
                                        }
                                    }}
                                    disabled={!manualWorkspacePath.trim()}
                                >
                                    应用
                                </Button>
                            </div>
                        )}
                    </div>

                    {/* 需求（可选） */}
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                            需求文档 <span
                            className="text-muted-foreground/60">（可选，也可创建后在下方消息框补充详细信息）</span>
                        </label>
                        <div className="grid grid-cols-2 gap-2 mb-2">
                            <button
                                onClick={() => setReqMode('saved')}
                                className={cn(
                                    'flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-all',
                                    reqMode === 'saved'
                                        ? 'border-primary bg-primary/10 text-primary'
                                        : 'border-border text-muted-foreground hover:bg-accent/30'
                                )}
                            >
                                <FolderOpen className="h-3 w-3"/>
                                已保存需求
                            </button>
                            <button
                                onClick={() => setReqMode('manual')}
                                className={cn(
                                    'flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-all',
                                    reqMode === 'manual'
                                        ? 'border-primary bg-primary/10 text-primary'
                                        : 'border-border text-muted-foreground hover:bg-accent/30'
                                )}
                            >
                                <FileText className="h-3 w-3"/>
                                手动输入
                            </button>
                        </div>

                        {reqMode === 'saved' && (
                            <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                                {savedRequirements.length === 0 ? (
                                    <p className="text-xs text-muted-foreground p-3 text-center">暂无已保存的需求</p>
                                ) : (
                                    savedRequirements.map((req) => (
                                        <div
                                            key={req.id}
                                            onClick={() => setSelectedRequirement(req)}
                                            className={cn(
                                                'flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors border-b border-border/50 last:border-0',
                                                selectedRequirement?.id === req.id ? 'bg-primary/5' : 'hover:bg-accent/30'
                                            )}
                                        >
                                            <div className={cn(
                                                'w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center',
                                                selectedRequirement?.id === req.id
                                                    ? 'border-primary bg-primary'
                                                    : 'border-muted-foreground/40'
                                            )}>
                                                {selectedRequirement?.id === req.id &&
                                                    <div className="w-1 h-1 rounded-full bg-primary-foreground"/>}
                                            </div>
                                            <p className="text-xs truncate">{req.number ? `${req.number} ` : ''}{req.title}</p>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}

                        {reqMode === 'manual' && (
                            <div>
                                <input
                                    type="text"
                                    value={manualRequirementText}
                                    onChange={(e) => setManualRequirementText(e.target.value)}
                                    placeholder="输入任务标题，创建后在下方消息框补充详细需求..."
                                    className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                />
                                <p className="text-[10px] text-muted-foreground mt-1">
                                    💡 提示：创建后在下方输入框中描述具体任务详情，点击「开始」时将自动发送并开始执行
                                </p>
                            </div>
                        )}

                        {/* 附加文档：内容解析后进入执行需求（模型直接看到，无需自己找文件） */}
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                                附加文档 <span className="text-muted-foreground/60">
                                    （可选，相对工作区的文件路径；md/txt 直读，docx/xlsx/pdf 需启用 MinerU）
                                </span>
                            </label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={docInput}
                                    onChange={(e) => setDocInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            const v = docInput.trim();
                                            if (v && !docPaths.includes(v)) {
                                                setDocPaths([...docPaths, v]);
                                            }
                                            setDocInput('');
                                        }
                                    }}
                                    placeholder="例如 docs/需求说明.docx（回车添加，最多 5 个）"
                                    className="flex-1 h-8 rounded-md border border-input bg-transparent px-3 py-1 text-xs font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8"
                                    onClick={() => {
                                        const v = docInput.trim();
                                        if (v && !docPaths.includes(v) && docPaths.length < 5) {
                                            setDocPaths([...docPaths, v]);
                                        }
                                        setDocInput('');
                                    }}
                                >
                                    添加
                                </Button>
                            </div>
                            {docPaths.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-1.5">
                                    {docPaths.map((p) => (
                                        <span
                                            key={p}
                                            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/30 px-2 py-0.5 text-[11px] font-mono"
                                        >
                                            <FileText className="h-3 w-3 text-muted-foreground"/>
                                            {p}
                                            <button
                                                type="button"
                                                onClick={() => setDocPaths(docPaths.filter((x) => x !== p))}
                                                className="text-muted-foreground hover:text-destructive"
                                                aria-label={`移除 ${p}`}
                                            >
                                                ×
                                            </button>
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex justify-end gap-2 pt-1">
                        <Button variant="outline" size="sm" onClick={closeCreateDialog}>取消</Button>
                        <Button
                            size="sm"
                            onClick={handleCreate}
                            disabled={!workspacePath}
                        >
                            <Sparkles className="h-3.5 w-3.5 mr-1.5"/>
                            创建
                        </Button>
                    </div>
                </div>
            </dialog>

            {/* 工具权限确认弹框（agent 执行中 canUseTool 触发）——队列逐个确认。
                注意：旧实现的"仅关闭不决策"会让后端挂到超时，关闭按钮现在等价于拒绝 */}
            {permQueue.length > 0 && (
                <PermissionDialog
                    permConfirm={{
                        open: true,
                        permissionRequestId: permQueue[0].permissionRequestId,
                        toolName: permQueue[0].toolName,
                        toolInput: permQueue[0].toolInput,
                        title: permQueue.length > 1
                            ? `${permQueue[0].title || ''}（其后还有 ${permQueue.length - 1} 个待确认）`
                            : permQueue[0].title,
                    }}
                    askUserAnswers={askUserAnswers}
                    setAskUserAnswers={setAskUserAnswers}
                    onConfirm={handleConfirmTool}
                    onClose={() => {
                        // 关闭即拒绝（防止后端永久等待）
                        handleConfirmTool('deny');
                    }}
                />
            )}
        </div>
    );
}

// === 子组件 ===

// === 文件夹选择器组件 ===

/**
 * 文件夹选择器：从系统盘符（Windows C:\ D:\ 等，macOS/Linux 为 /）开始浏览，
 * 选择任意目录作为工作空间。
 * - 顶部：盘符/根目录切换
 * - 中部：面包屑导航 + 返回上级
 * - 列表：仅展示目录（工作空间必须是目录）
 * - 底部：当前路径 + 「使用此目录」确认
 */
function FolderBrowser({currentPath, onPick, onClose}: {
    currentPath: string;
    onPick: (path: string) => void;
    onClose: () => void;
}) {
    const [drives, setDrives] = useState<string[]>([]);
    const [dir, setDir] = useState<string | null>(null);
    const [entries, setEntries] = useState<DirectoryEntry[]>([]);
    const [stack, setStack] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 加载系统盘符
    useEffect(() => {
        apiGet<string[]>('/workspace/drives')
            .then((d) => setDrives(d || []))
            .catch((err) => setError(`无法读取系统盘符: ${err instanceof Error ? err.message : String(err)}`));
    }, []);

    // 浏览指定目录
    const browse = useCallback(async (path: string, push = true) => {
        setLoading(true);
        setError(null);
        try {
            const data = await apiGet<DirectoryEntry[]>('/workspace/picker-browse?path=' + encodeURIComponent(path));
            // 目录优先 + 名称排序
            const sorted = [...(data || [])].sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name, 'zh-CN');
            });
            setDir(path);
            setEntries(sorted.filter(e => e.isDirectory));
            if (push) setStack(prev => [...prev, path]);
        } catch (err) {
            setError(`无法访问该目录: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setLoading(false);
        }
    }, []);

    // 默认浏览第一个盘符
    useEffect(() => {
        if (drives.length > 0 && !dir && !loading) {
            browse(drives[0], false);
        }
    }, [drives, dir, loading, browse]);

    const goBack = () => {
        const next = stack.slice(0, -1);
        setStack(next);
        const prevDir = next[next.length - 1] || null;
        if (prevDir) browse(prevDir, false);
        else setDir(null);
    };

    // 面包屑（Windows 盘符风格 C:\Users\xxx / Unix /home/user）
    const crumbs = useMemo(() => {
        if (!dir) return [] as string[];
        if (/^[A-Za-z]:/.test(dir)) {
            const parts = dir.split(/[\\/]+/).filter(Boolean);
            const list: string[] = [];
            let acc = '';
            for (const p of parts) {
                acc = /^[A-Za-z]:$/.test(p) ? p + '\\' : acc + p + '\\';
                list.push(acc);
            }
            return list;
        }
        const parts = dir.split('/').filter(Boolean);
        const list: string[] = [];
        let acc = '/';
        for (const p of parts) {
            acc += p + '/';
            list.push(acc);
        }
        return list;
    }, [dir]);

    const goToCrumb = (idx: number) => {
        const target = crumbs[idx];
        setStack(crumbs.slice(0, idx + 1));
        if (target) browse(target, false);
    };

    return (
        <div className="mt-2 rounded-md border border-border bg-muted/20 overflow-hidden">
            {/* 头部：盘符切换 + 返回 + 关闭 */}
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/60 bg-muted/40">
                {drives.length > 1 ? (
                    <div className="flex items-center gap-1 flex-wrap">
                        {drives.map((d) => (
                            <button
                                key={d}
                                type="button"
                                onClick={() => {
                                    setStack([d]);
                                    browse(d, false);
                                }}
                                className={cn(
                                    'flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border transition-colors',
                                    dir === d
                                        ? 'border-primary bg-primary/10 text-primary'
                                        : 'border-border text-muted-foreground hover:bg-accent/50',
                                )}
                                title={`盘符 ${d}`}
                            >
                                <HardDrive className="h-3 w-3"/>
                                {d}
                            </button>
                        ))}
                    </div>
                ) : (
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <HardDrive className="h-3 w-3"/>
                        {drives[0] || '...'}
                    </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                    <button
                        type="button"
                        onClick={goBack}
                        disabled={!dir}
                        className="p-1 rounded hover:bg-accent/50 text-muted-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                        title="返回上级"
                    >
                        <ArrowLeft className="h-3.5 w-3.5"/>
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1 rounded hover:bg-accent/50 text-muted-foreground"
                        title="关闭"
                    >
                        <X className="h-3.5 w-3.5"/>
                    </button>
                </div>
            </div>

            {/* 面包屑 */}
            {dir && crumbs.length > 0 && (
                <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border/40 overflow-x-auto whitespace-nowrap">
                    {crumbs.map((c, i) => (
                        <span key={c} className="flex items-center gap-0.5">
                            {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0"/>}
                            <button
                                type="button"
                                onClick={() => goToCrumb(i)}
                                className="text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent/40 rounded px-1 py-0.5 transition-colors"
                            >
                                {c}
                            </button>
                        </span>
                    ))}
                </div>
            )}

            {/* 目录列表 */}
            <div className="max-h-40 overflow-y-auto">
                {error && (
                    <p className="text-[10px] text-destructive p-2">{error}</p>
                )}
                {loading && (
                    <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground p-2">
                        <Loader2 className="h-3 w-3 animate-spin"/> 加载中...
                    </p>
                )}
                {!loading && !error && entries.length === 0 && (
                    <p className="text-[10px] text-muted-foreground p-2 text-center">此目录下没有子文件夹</p>
                )}
                {!loading && entries.map((entry) => (
                    <button
                        key={entry.path}
                        type="button"
                        onClick={() => browse(entry.path, true)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-accent/40 transition-colors border-b border-border/30 last:border-0"
                        title={entry.path}
                    >
                        <Folder className="h-3.5 w-3.5 text-blue-400 shrink-0"/>
                        <span className="text-xs truncate">{entry.name}</span>
                        {currentPath === entry.path && <Check className="h-3 w-3 text-primary ml-auto shrink-0"/>}
                    </button>
                ))}
            </div>

            {/* 底部：当前路径 + 确认 */}
            {dir && (
                <div className="flex items-center gap-2 px-2 py-1.5 border-t border-border/60 bg-muted/40">
                    <span className="flex-1 min-w-0 truncate text-[10px] font-mono text-muted-foreground">{dir}</span>
                    <Button
                        type="button"
                        size="sm"
                        className="shrink-0"
                        onClick={() => onPick(dir)}
                    >
                        <Check className="h-3 w-3 mr-1"/>
                        使用此目录
                    </Button>
                </div>
            )}
        </div>
    );
}

// === 工具权限确认弹框组件 ===

interface AskUserQuestionDef {
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
}

interface PermissionDialogProps {
    permConfirm: {
        open: boolean;
        permissionRequestId?: string;
        toolName?: string;
        toolInput?: Record<string, unknown>;
        title?: string;
    };
    askUserAnswers: Record<string, string>;
    setAskUserAnswers: (v: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => void;
    onConfirm: (decision: 'allow' | 'deny', remember?: boolean, modifiedInput?: Record<string, unknown>) => void;
    onClose: () => void;
}

function PermissionDialog({permConfirm, askUserAnswers, setAskUserAnswers, onConfirm, onClose}: PermissionDialogProps) {
    // 结构性检测 AskUserQuestion（支持 MCP 前缀如 mcp__server__AskUserQuestion）
    const isAskUser = useMemo(() => {
        if (!permConfirm.toolInput) return false;
        // Case 1: 有 questions 数组，且首项含 question + options
        const qs = permConfirm.toolInput.questions;
        if (Array.isArray(qs) && qs.length > 0) {
            const first = qs[0] as Record<string, unknown>;
            if (typeof first.question === 'string' && Array.isArray(first.options)) return true;
        }
        // Case 2: 顶层 options 数组（简化 AskUser 模式）
        const opts = permConfirm.toolInput.options;
        if (Array.isArray(opts) && opts.length > 0
            && typeof (opts[0] as Record<string, unknown>)?.label === 'string') {
            return true;
        }
        return false;
    }, [permConfirm.toolInput]);

    const questions: AskUserQuestionDef[] = useMemo(() => {
        if (!isAskUser || !permConfirm.toolInput) return [];
        // Case 1: 标准 questions 数组
        const raw = permConfirm.toolInput.questions;
        if (Array.isArray(raw)) return raw as AskUserQuestionDef[];
        // Case 2: 顶层 options → 合成单个问题
        const topOpts = permConfirm.toolInput.options;
        if (Array.isArray(topOpts)) {
            return [{
                question: (permConfirm.toolInput.question as string) || '请选择',
                header: (permConfirm.toolInput.header as string) || '选项',
                options: topOpts as Array<{ label: string; description: string }>,
                multiSelect: (permConfirm.toolInput.multiSelect as boolean) || false,
            }];
        }
        return [];
    }, [isAskUser, permConfirm.toolInput]);

    const allAnswered = useMemo(() => {
        if (questions.length === 0) return true;
        return questions.every(q => askUserAnswers[q.question] != null && askUserAnswers[q.question] !== '');
    }, [questions, askUserAnswers]);

    const selectOption = (questionText: string, optionLabel: string, multiSelect: boolean | undefined) => {
        setAskUserAnswers(prev => {
            if (multiSelect) {
                // 多选：逗号分隔追加/移除
                const current = (prev[questionText] || '').split(',').filter(Boolean);
                const idx = current.indexOf(optionLabel);
                if (idx >= 0) current.splice(idx, 1);
                else current.push(optionLabel);
                return {...prev, [questionText]: current.join(',')};
            }
            // 单选
            return {...prev, [questionText]: optionLabel};
        });
    };

    // 非 AskUserQuestion：展示标准权限确认 + JSON 输入预览
    if (!isAskUser || questions.length === 0) {
        return (
            <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                <div className="glass-panel rounded-xl shadow-xl p-6 max-w-lg w-full mx-4 max-h-[85vh] overflow-y-auto">
                    <h3 className="text-base font-semibold mb-1">工具权限确认</h3>
                    <p className="text-sm text-muted-foreground mb-3">
                        {permConfirm.title || 'Agent 请求使用工具'}
                    </p>
                    <div className="bg-muted/50 border border-border rounded-md p-3 mb-4">
                        <div className="text-xs text-muted-foreground mb-1">工具：{permConfirm.toolName}</div>
                        {permConfirm.toolInput && (
                            <pre
                                className="text-xs font-mono whitespace-pre-wrap break-all text-foreground/90 max-h-40 overflow-y-auto">
                                {permConfirm.toolInput.command
                                    ? String(permConfirm.toolInput.command)
                                    : JSON.stringify(permConfirm.toolInput, null, 2)}
                            </pre>
                        )}
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => onConfirm('deny')}>
                            拒绝
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => onConfirm('allow', true)}>
                            允许并记住
                        </Button>
                        <Button size="sm" onClick={() => onConfirm('allow')}>
                            允许
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    // AskUserQuestion：渲染问题与选项
    return (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="glass-panel rounded-xl shadow-xl p-6 max-w-lg w-full mx-4 max-h-[85vh] overflow-y-auto">
                <h3 className="text-base font-semibold mb-1">
                    {permConfirm.title || 'Agent 向您提问'}
                </h3>
                <p className="text-xs text-muted-foreground mb-4">
                    请回答以下问题，帮助 Agent 更好地完成任务
                </p>

                <div className="space-y-4 mb-4">
                    {questions.map((q, qi) => (
                        <div key={qi} className="bg-muted/30 border border-border rounded-lg p-3">
                            <div className="flex items-center gap-1.5 mb-2">
                                <span
                                    className="text-[10px] font-medium text-muted-foreground uppercase bg-muted-foreground/10 px-1.5 py-0.5 rounded">
                                    {q.header || `问题 ${qi + 1}`}
                                </span>
                            </div>
                            <p className="text-sm font-medium mb-2">{q.question}</p>
                            <div className="space-y-1">
                                {q.options.map((opt, oi) => {
                                    const isSelected = q.multiSelect
                                        ? (askUserAnswers[q.question] || '').split(',').includes(opt.label)
                                        : askUserAnswers[q.question] === opt.label;
                                    return (
                                        <button
                                            key={oi}
                                            onClick={() => selectOption(q.question, opt.label, q.multiSelect)}
                                            className={cn(
                                                'w-full text-left rounded-md border px-3 py-2 text-xs transition-all',
                                                isSelected
                                                    ? 'border-primary bg-primary/10 text-primary'
                                                    : 'border-border hover:bg-accent/30 text-foreground/80',
                                            )}
                                        >
                                            <div className="flex items-center gap-2">
                                                <span className={cn(
                                                    'w-3.5 h-3.5 rounded border-2 shrink-0 flex items-center justify-center transition-colors',
                                                    q.multiSelect ? 'rounded' : 'rounded-full',
                                                    isSelected
                                                        ? 'border-primary bg-primary'
                                                        : 'border-muted-foreground/40',
                                                )}>
                                                    {isSelected && (
                                                        <CheckCircle2 className="h-2.5 w-2.5 text-primary-foreground"/>
                                                    )}
                                                </span>
                                                <span className="font-medium">{opt.label}</span>
                                            </div>
                                            {opt.description && (
                                                <p className="text-[10px] text-muted-foreground mt-1 ml-5.5">
                                                    {opt.description}
                                                </p>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => onConfirm('deny')}>
                        拒绝
                    </Button>
                    <Button
                        size="sm"
                        disabled={!allAnswered}
                        onClick={() => {
                            // 将答案编码后传给 bridge（SDK 的 PermissionResult 认 updatedInput 字段）
                            const answersMap: Record<string, string> = {};
                            questions.forEach(q => {
                                answersMap[q.question] = askUserAnswers[q.question] || '';
                            });
                            // updatedInput 会替换工具输入，需同时带上原始 questions 和用户 answers
                            onConfirm('allow', false, {
                                ...(permConfirm.toolInput?.questions ? {questions: permConfirm.toolInput.questions} : {}),
                                answers: answersMap,
                            });
                        }}
                    >
                        <Send className="h-3.5 w-3.5 mr-1.5"/>
                        提交回答
                    </Button>
                </div>
            </div>
        </div>
    );
}
