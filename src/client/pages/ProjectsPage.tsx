/**
 * @module ProjectsPage
 * @description 项目空间页面 — 看板式多任务并行管理
 *
 * 布局：左侧项目列表(w-72) + 右侧项目详情(看板+任务详情面板)
 * 看板三列：运行中 / 排队中 / 已完成
 */

import {useState, useEffect, useCallback} from 'react';
import {onWsEvent} from '../lib/ws-events';
import {useTranslation} from 'react-i18next';
import {motion, AnimatePresence} from 'framer-motion';
import {
    FolderKanban, Plus, Play, Pause, Square, ChevronRight, GitBranch,
    Clock, CheckCircle, AlertCircle, Loader2, RefreshCw, X,
    Trash2, Settings2,
} from 'lucide-react';
import {useAppStore} from '../stores/app-store';
import {apiGet, apiPost, apiDelete} from '../api';
import {ChatInputBox} from '../components/ChatInputBox';
import {Joyride} from 'react-joyride';
import {useGuide} from '../guides/useGuide';

// === 类型（与 app-store 对齐） ===

type TaskStatus = 'pending' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
type TaskPhase = 'plan' | 'waiting_plan_confirm' | 'execution' | 'waiting_execution_confirm' | 'test' | 'idle';

interface TaskLog {
    timestamp: string;
    phase: TaskPhase;
    logType: 'info' | 'output' | 'error' | 'warning';
    content: string;
}

interface TaskInfo {
    id: string;
    name: string;
    workspaceId: string;
    requirementId: string;
    pipelineId: string;
    branch: string;
    workspacePath: string;
    worktreePath?: string;
    dependsOn: string[];
    baseBranch: string;
    status: TaskStatus;
    phase: TaskPhase;
    sessionId?: string;
    logs: TaskLog[];
    createdAt: string;
    updatedAt: string;
}

interface WorkspaceItem {
    id: string;
    path: string;
    name: string;
    projectType: 'node' | 'python' | 'java' | 'rust' | 'unknown';
    addedAt: string;
    baseBranch?: string;
    defaultPipelineId?: string;
}

// === 状态图标 ===

function StatusIcon({status}: { status: TaskStatus }) {
    switch (status) {
        case 'running':
            return <Loader2 className="w-4 h-4 text-blue-400 animate-spin"/>;
        case 'queued':
            return <Clock className="w-4 h-4 text-yellow-400"/>;
        case 'paused':
            return <Pause className="w-4 h-4 text-yellow-400"/>;
        case 'completed':
            return <CheckCircle className="w-4 h-4 text-green-400"/>;
        case 'failed':
            return <AlertCircle className="w-4 h-4 text-red-400"/>;
        case 'aborted':
            return <Square className="w-4 h-4 text-gray-400"/>;
        default:
            return <Clock className="w-4 h-4 text-gray-400"/>;
    }
}

function PhaseLabel({phase}: { phase: TaskPhase }) {
    const {t} = useTranslation();
    const labels: Record<TaskPhase, string> = {
        plan: t('projects.phasePlan'), waiting_plan_confirm: t('projects.phaseWaitingPlanConfirm'),
        execution: t('projects.phaseExecution'), waiting_execution_confirm: t('projects.phaseWaitingExecConfirm'),
        test: t('projects.phaseTest'), idle: t('projects.phaseIdle'),
    };
    const colors: Record<TaskPhase, string> = {
        plan: 'bg-red-500/20 text-red-300',
        waiting_plan_confirm: 'bg-orange-500/20 text-orange-300',
        execution: 'bg-blue-500/20 text-blue-300',
        waiting_execution_confirm: 'bg-orange-500/20 text-orange-300',
        test: 'bg-green-500/20 text-green-300',
        idle: 'bg-gray-500/20 text-gray-400',
    };
    return (
        <span className={`px-2 py-0.5 rounded text-xs ${colors[phase]}`}>
      [{labels[phase]}]
    </span>
    );
}

// === 任务卡片 ===

function TaskCard({
                      task,
                      isSelected,
                      onClick,
                      onPause,
                      onAbort,
                  }: {
    task: TaskInfo;
    isSelected: boolean;
    onClick: () => void;
    onPause: () => void;
    onAbort: () => void;
}) {
    const {t} = useTranslation();
    return (
        <motion.div
            layout
            initial={{opacity: 0, y: 8}}
            animate={{opacity: 1, y: 0}}
            exit={{opacity: 0, y: -8}}
            onClick={onClick}
            className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/50 bg-card'
            }`}
        >
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                    <StatusIcon status={task.status}/>
                    <span className="text-sm font-medium truncate">{task.name}</span>
                </div>
                <PhaseLabel phase={task.phase}/>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                <GitBranch className="w-3 h-3"/>
                <span className="truncate">{task.branch}</span>
            </div>
            <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                    {new Date(task.createdAt).toLocaleString('zh-CN', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    })}
                </span>
                {task.status === 'running' && (
                    <div className="flex gap-1">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onPause();
                            }}
                            className="p-1 rounded hover:bg-yellow-500/20 text-yellow-400"
                            title={t('projects.tooltipPause')}
                        >
                            <Pause className="w-3.5 h-3.5"/>
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onAbort();
                            }}
                            className="p-1 rounded hover:bg-red-500/20 text-red-400"
                            title={t('projects.tooltipAbort')}
                        >
                            <Square className="w-3.5 h-3.5"/>
                        </button>
                    </div>
                )}
            </div>
        </motion.div>
    );
}

// === 看板列 ===

function KanbanColumn({
                          title,
                          tasks,
                          activeTaskId,
                          onSelectTask,
                          onPauseTask,
                          onAbortTask,
                          icon,
                      }: {
    title: string;
    tasks: TaskInfo[];
    activeTaskId: string | null;
    onSelectTask: (id: string) => void;
    onPauseTask: (id: string) => void;
    onAbortTask: (id: string) => void;
    icon: React.ReactNode;
}) {
    const {t} = useTranslation();
    return (
        <div className="flex-1 min-w-[200px]">
            <div className="flex items-center gap-2 mb-3 px-1">
                {icon}
                <span className="text-sm font-medium">{title}</span>
                <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
          {tasks.length}
        </span>
            </div>
            <div className="space-y-2">
                <AnimatePresence>
                    {tasks.map(task => (
                        <TaskCard
                            key={task.id}
                            task={task}
                            isSelected={task.id === activeTaskId}
                            onClick={() => onSelectTask(task.id)}
                            onPause={() => onPauseTask(task.id)}
                            onAbort={() => onAbortTask(task.id)}
                        />
                    ))}
                </AnimatePresence>
                {tasks.length === 0 && (
                    <div className="text-xs text-muted-foreground text-center py-6 opacity-50">
                        {t('projects.emptyTasks')}
                    </div>
                )}
            </div>
        </div>
    );
}

// === 任务详情面板 ===

function TaskDetailPanel({
                             task,
                             logs,
                             onClose,
                             onPause,
                             onResume,
                             onAbort,
                             onConfirm,
                         }: {
    task: TaskInfo;
    logs: TaskLog[];
    onClose: () => void;
    onPause: () => void;
    onResume: () => void;
    onAbort: () => void;
    onConfirm: () => void;
}) {
    const {t} = useTranslation();
    const [replyText, setReplyText] = useState('');

    const handleReply = async (text: string, attachmentIds: string[]) => {
        if (!text.trim()) return;
        try {
            await apiPost(`/tasks/${task.id}/reply`, {
                message: text,
                attachmentIds: attachmentIds.length ? attachmentIds : undefined,
            });
            setReplyText('');
        } catch (err) {
            console.error('Reply failed:', err);
        }
    };

    return (
        <motion.div
            initial={{x: '100%'}}
            animate={{x: 0}}
            exit={{x: '100%'}}
            transition={{type: 'spring', damping: 25, stiffness: 300}}
            className="absolute inset-y-0 right-0 w-[500px] bg-card border-l border-border flex flex-col z-10"
        >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
                <div className="flex items-center gap-2">
                    <button onClick={onClose} className="p-1 rounded hover:bg-muted">
                        <ChevronRight className="w-4 h-4"/>
                    </button>
                    <StatusIcon status={task.status}/>
                    <span className="font-medium">{task.name}</span>
                </div>
            </div>

            {/* Meta */}
            <div className="p-4 border-b border-border space-y-2 text-sm">
                <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-muted-foreground"/>
                    <span className="font-mono text-xs">{task.branch}</span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{t('projects.labelRequirement')}:</span>
                    <span className="text-xs">{task.requirementId}</span>
                </div>
                <div className="flex items-center gap-4">
                    {/* Phase progress */}
                    {(['plan', 'execution', 'test'] as const).map(p => {
                        const phaseOrder = {plan: 0, execution: 1, test: 2};
                        const confirmPhases: TaskPhase[] = [`waiting_${p}_confirm` as TaskPhase];
                        const isActive = task.phase === p || confirmPhases.includes(task.phase);
                        const isDone = phaseOrder[task.phase as keyof typeof phaseOrder] > phaseOrder[p]
                            || task.phase === 'waiting_execution_confirm' && p === 'plan';
                        return (
                            <div key={p} className={`flex items-center gap-1 text-xs ${
                                isActive ? 'text-primary font-medium' : isDone ? 'text-green-400' : 'text-muted-foreground'
                            }`}>
                                {isActive ? '●' : isDone ? '✓' : '○'}
                                {p === 'plan' ? t('projects.phasePlan') : p === 'execution' ? t('projects.phaseExecution') : t('projects.phaseTest')}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Logs */}
            <div className="flex-1 overflow-y-auto p-4 bg-black/20">
                <div className="font-mono text-xs space-y-0.5">
                    {logs.length === 0 && (
                        <div className="text-muted-foreground">{t('projects.emptyLogs')}</div>
                    )}
                    {logs.map((log, i) => (
                        <div key={i} className={`${
                            log.logType === 'error' ? 'text-red-400' :
                                log.logType === 'warning' ? 'text-yellow-400' :
                                    log.logType === 'output' ? 'text-green-300' : 'text-gray-400'
                        }`}>
                            <span className="text-gray-600">[{new Date(log.timestamp).toLocaleTimeString()}]</span>{' '}
                            {log.content}
                        </div>
                    ))}
                </div>
            </div>

            {/* Actions */}
            <div className="p-4 border-t border-border space-y-3">
                {/* Reply input：紧凑统一输入框（抽屉空间有限，不显示模型/权限选择器） */}
                {task.status === 'running' && (
                    <ChatInputBox
                        value={replyText}
                        onChange={setReplyText}
                        onSend={(text, atts) => handleReply(text.trim(), atts.map(a => a.attachmentId))}
                        placeholder={t('projects.replyPlaceholder')}
                        rows={1}
                        compact
                        showModelPicker={false}
                        showPermissionPicker={false}
                        branchWorkspacePath={task.workspacePath}
                        branchDisabled={true}
                    />
                )}
                {/* Control buttons */}
                <div className="flex gap-2">
                    {/* 确认按钮：计划/执行确认阶段 */}
                    {(task.phase === 'waiting_plan_confirm' || task.phase === 'waiting_execution_confirm') && (
                        <button
                            onClick={onConfirm}
                            className="flex items-center gap-1 px-4 py-2 rounded bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
                        >
                            <CheckCircle className="w-4 h-4"/>
                            {task.phase === 'waiting_plan_confirm' ? t('projects.confirmPlan') : t('projects.confirmExecution')}
                        </button>
                    )}
                    {task.status === 'running' && (
                        <>
                            <button onClick={onPause}
                                    className="flex items-center gap-1 px-3 py-1.5 rounded bg-yellow-500/20 text-yellow-400 text-sm hover:bg-yellow-500/30">
                                <Pause className="w-3.5 h-3.5"/> {t('projects.buttonPause')}
                            </button>
                            <button onClick={onAbort}
                                    className="flex items-center gap-1 px-3 py-1.5 rounded bg-red-500/20 text-red-400 text-sm hover:bg-red-500/30">
                                <Square className="w-3.5 h-3.5"/> {t('projects.buttonAbort')}
                            </button>
                        </>
                    )}
                    {task.status === 'paused' && (
                        <>
                            <button onClick={onResume}
                                    className="flex items-center gap-1 px-3 py-1.5 rounded bg-green-500/20 text-green-400 text-sm hover:bg-green-500/30">
                                <Play className="w-3.5 h-3.5"/> {t('projects.buttonResume')}
                            </button>
                            <button onClick={onAbort}
                                    className="flex items-center gap-1 px-3 py-1.5 rounded bg-red-500/20 text-red-400 text-sm hover:bg-red-500/30">
                                <Square className="w-3.5 h-3.5"/> {t('projects.buttonAbort')}
                            </button>
                        </>
                    )}
                    {task.status === 'failed' && (
                        <button onClick={onResume}
                                className="flex items-center gap-1 px-3 py-1.5 rounded bg-blue-500/20 text-blue-400 text-sm hover:bg-blue-500/30">
                            <RefreshCw className="w-3.5 h-3.5"/> {t('projects.buttonRetry')}
                        </button>
                    )}
                </div>
            </div>
        </motion.div>
    );
}

// === 创建任务向导 ===

function CreateTaskModal({
                             workspaceId,
                             existingTasks,
                             onClose,
                             onCreated,
                         }: {
    workspaceId: string;
    existingTasks: TaskInfo[];
    onClose: () => void;
    onCreated: () => void;
}) {
    const {t} = useTranslation();
    const [name, setName] = useState('');
    const [requirementId, setRequirementId] = useState('');
    const [pipelineId, setPipelineId] = useState('');
    const [loading, setLoading] = useState(false);
    const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
    const [requirements, setRequirements] = useState<{ id: string; title: string }[]>([]);
    const [branches, setBranches] = useState<string[]>([]);
    const [baseBranch, setBaseBranch] = useState('');
    const [loadingBranches, setLoadingBranches] = useState(false);
    const [selectedDeps, setSelectedDeps] = useState<string[]>([]);

    useEffect(() => {
        apiGet('/pipelines').then((data: any) => setPipelines(data)).catch(() => {
        });
        apiGet('/requirements/saved').then((data: any) => setRequirements(data)).catch(() => {
        });
        // 拉取远程分支
        setLoadingBranches(true);
        apiGet<string[]>(`/workspace/${workspaceId}/remote-branches`)
            .then(list => {
                setBranches(list);
                if (list.length > 0 && !list.includes('main')) setBaseBranch(list[0]);
                else setBaseBranch('main');
            })
            .catch(() => setBranches([]))
            .finally(() => setLoadingBranches(false));
    }, [workspaceId]);

    const handleCreate = async () => {
        if (!requirementId) return;
        setLoading(true);
        try {
            const task: any = await apiPost(`/tasks/workspace/${workspaceId}`, {
                name: name || undefined,
                requirementId,
                pipelineId: pipelineId || undefined,
                baseBranch: baseBranch || undefined,
                dependsOn: selectedDeps.length > 0 ? selectedDeps : undefined,
            });

            // 启动任务 — TaskScheduler 内部编排 plan→execution→test
            await apiPost(`/tasks/${task.id}/start`);

            onCreated();
            onClose();
        } catch (err) {
            console.error('Create task failed:', err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
            <motion.div
                initial={{opacity: 0, scale: 0.95}}
                animate={{opacity: 1, scale: 1}}
                className="glass-panel rounded-xl w-[480px] max-h-[80vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h3 className="font-medium">{t('projects.modalTitle')}</h3>
                    <button onClick={onClose} className="p-1 rounded hover:bg-muted">
                        <X className="w-4 h-4"/>
                    </button>
                </div>
                <div className="p-4 space-y-4">
                    {/* 任务名 */}
                    <div>
                        <label
                            className="text-sm text-muted-foreground mb-1 block">{t('projects.labelTaskName')}</label>
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t('projects.placeholderTaskName')}
                            className="w-full bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-primary"
                        />
                    </div>

                    {/* 选择需求 */}
                    <div>
                        <label
                            className="text-sm text-muted-foreground mb-1 block">{t('projects.labelRequirement')} *</label>
                        <select
                            value={requirementId}
                            onChange={(e) => setRequirementId(e.target.value)}
                            className="w-full bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-primary"
                        >
                            <option value="">{t('projects.optionSelectRequirement')}</option>
                            {requirements.map(r => (
                                <option key={r.id} value={r.id}>{r.title}</option>
                            ))}
                        </select>
                    </div>

                    {/* 选择流水线 */}
                    <div>
                        <label
                            className="text-sm text-muted-foreground mb-1 block">{t('projects.labelPipeline')}</label>
                        <select
                            value={pipelineId}
                            onChange={(e) => setPipelineId(e.target.value)}
                            className="w-full bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-primary"
                        >
                            <option value="">{t('projects.optionDefaultPipeline')}</option>
                            {pipelines.map(p => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                        </select>
                    </div>

                    {/* 选择基础分支 */}
                    <div>
                        <label className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                            <GitBranch className="w-3 h-3"/> {t('projects.labelBaseBranch')}
                        </label>
                        {loadingBranches ? (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                                <Loader2 className="w-3 h-3 animate-spin"/> {t('projects.loadingBranches')}
                            </div>
                        ) : (
                            <select
                                value={baseBranch}
                                onChange={(e) => setBaseBranch(e.target.value)}
                                className="w-full bg-input border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-primary"
                            >
                                {branches.length === 0 && <option value="main">main</option>}
                                {branches.map(b => (
                                    <option key={b} value={b}>{b}</option>
                                ))}
                            </select>
                        )}
                    </div>

                    {/* 前置任务 */}
                    {existingTasks.length > 0 && (
                        <div>
                            <label
                                className="text-sm text-muted-foreground mb-1 block">{t('projects.labelDependsOn')}</label>
                            <div className="max-h-32 overflow-y-auto border border-border rounded p-2 space-y-1">
                                {existingTasks.map(t => (
                                    <label key={t.id}
                                           className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 px-1 py-0.5 rounded">
                                        <input
                                            type="checkbox"
                                            checked={selectedDeps.includes(t.id)}
                                            onChange={(e) => {
                                                setSelectedDeps(prev =>
                                                    e.target.checked ? [...prev, t.id] : prev.filter(id => id !== t.id)
                                                );
                                            }}
                                            className="rounded"
                                        />
                                        <span className="truncate">{t.name}</span>
                                        <span className="ml-auto text-xs text-muted-foreground">{t.status}</span>
                                    </label>
                                ))}
                            </div>
                            {selectedDeps.length > 0 && (
                                <p className="text-xs text-muted-foreground mt-1">
                                    {t('projects.hintDependsOn')}
                                </p>
                            )}
                        </div>
                    )}

                    <button
                        onClick={handleCreate}
                        disabled={!requirementId || loading}
                        className="w-full py-2 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {loading && <Loader2 className="w-4 h-4 animate-spin"/>}
                        {t('projects.createAndStart')}
                    </button>
                </div>
            </motion.div>
        </div>
    );
}

// === 主页面 ===

export default function ProjectsPage() {
    const {t} = useTranslation();
    const {run: guideRun, steps: guideSteps, handleJoyrideEvent} = useGuide('projects');
    const [tasks, setTasks] = useState<TaskInfo[]>([]);
    const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
    const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
    const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
    const [showCreateTask, setShowCreateTask] = useState(false);
    const [taskLogs, setTaskLogs] = useState<Record<string, TaskLog[]>>({});

    // 加载工作区列表
    const loadWorkspaces = useCallback(async () => {
        try {
            const data = await apiGet<WorkspaceItem[]>('/workspace/saved');
            setWorkspaces(data);
        } catch (err) {
            console.error('Load workspaces failed:', err);
        }
    }, []);

    // 加载任务列表
    const loadTasks = useCallback(async () => {
        if (!activeWorkspaceId) return;
        try {
            const data = await apiGet<TaskInfo[]>(`/tasks/workspace/${activeWorkspaceId}`);
            setTasks(data);
        } catch (err) {
            console.error('Load tasks failed:', err);
        }
    }, [activeWorkspaceId]);

    useEffect(() => {
        loadWorkspaces();
    }, [loadWorkspaces]);
    useEffect(() => {
        loadTasks();
    }, [loadTasks]);

    // WebSocket 事件处理（经类型化事件总线，由 useWebSocket 转发）
    useEffect(() => onWsEvent('ws-message', (msg) => {
        const d = msg.data as Record<string, Record<string, unknown> | undefined> | undefined;
        const taskId = d?.taskId as string | undefined;
        if (msg.type === 'task:status_change' && taskId) {
            setTasks(prev => prev.map(t =>
                t.id === taskId
                    ? {...t, status: d?.status as unknown as TaskInfo['status'], phase: d?.phase as unknown as TaskInfo['phase']}
                    : t
            ));
        }
        if (msg.type === 'task:log' && taskId) {
            const logSource = d?.log as Record<string, string | undefined> | undefined;
            const log: TaskLog = {
                timestamp: logSource?.timestamp || new Date().toISOString(),
                phase: (logSource?.phase || 'idle') as TaskLog['phase'],
                logType: (logSource?.logType || 'info') as TaskLog['logType'],
                content: logSource?.content || '',
            };
            setTaskLogs(prev => ({
                ...prev,
                [taskId]: [...(prev[taskId] || []), log],
            }));
        }
    }), []);

    // 任务操作
    const handlePauseTask = async (taskId: string) => {
        try {
            await apiPost(`/tasks/${taskId}/pause`);
            loadTasks();
        } catch {
        }
    };
    const handleAbortTask = async (taskId: string) => {
        try {
            await apiPost(`/tasks/${taskId}/abort`);
            loadTasks();
        } catch {
        }
    };
    const handleResumeTask = async (taskId: string) => {
        try {
            await apiPost(`/tasks/${taskId}/resume`);
            loadTasks();
        } catch {
        }
    };
    const handleDeleteTask = async (taskId: string) => {
        try {
            await apiDelete(`/tasks/${taskId}`);
            if (activeTaskId === taskId) setActiveTaskId(null);
            loadTasks();
        } catch {
        }
    };
    const handleConfirmTask = async (taskId: string) => {
        try {
            await apiPost(`/tasks/${taskId}/confirm`);
        } catch (err) {
            console.error('Confirm task failed:', err);
        }
    };

    // 分类任务
    const waitingTasks = tasks.filter(t => t.status === 'pending' && t.dependsOn?.length > 0);
    const runningTasks = tasks.filter(t => t.status === 'running' || t.status === 'paused');
    const queuedTasks = tasks.filter(t => t.status === 'queued' || (t.status === 'pending' && (!t.dependsOn || t.dependsOn.length === 0)));
    const completedTasks = tasks.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'aborted');

    const activeTask = tasks.find(t => t.id === activeTaskId);

    return (
        <div className="flex h-full">
            {/* 左侧工作区列表 */}
            <div className="w-72 border-r border-border flex flex-col" data-tour="proj-workspace-list">
                <div className="p-3 border-b border-border">
                    <div className="text-xs text-muted-foreground text-center py-1">
                        {t('projects.workspaceHint')}
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {workspaces.map(ws => (
                        <div
                            key={ws.id}
                            onClick={() => {
                                setActiveWorkspaceId(ws.id);
                                setActiveTaskId(null);
                            }}
                            className={`p-3 border-b border-border cursor-pointer hover:bg-muted/50 transition-colors ${
                                activeWorkspaceId === ws.id ? 'bg-primary/5 border-l-2 border-l-primary' : ''
                            }`}
                        >
                            <div className="flex items-center gap-2 mb-1">
                                <FolderKanban className="w-4 h-4 text-primary shrink-0"/>
                                <span className="text-sm font-medium truncate">{ws.name}</span>
                            </div>
                            <div className="text-xs text-muted-foreground truncate ml-6">{ws.path}</div>
                            <div className="flex items-center gap-2 mt-1 ml-6 text-xs text-muted-foreground">
                                <GitBranch className="w-3 h-3"/>
                                <span>{ws.baseBranch || 'main'}</span>
                            </div>
                        </div>
                    ))}
                    {workspaces.length === 0 && (
                        <div className="p-6 text-center text-sm text-muted-foreground">
                            {t('projects.emptyWorkspaces')}
                        </div>
                    )}
                </div>
            </div>

            {/* 右侧内容区 */}
            <div className="flex-1 flex flex-col relative overflow-hidden">
                {activeWorkspaceId ? (
                    <>
                        {/* 项目头部 */}
                        <div className="p-4 border-b border-border flex items-center justify-between">
                            <div>
                                <h2 className="text-lg font-medium">
                                    {workspaces.find(p => p.id === activeWorkspaceId)?.name}
                                </h2>
                                <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
                                    <span>{workspaces.find(ws => ws.id === activeWorkspaceId)?.path}</span>
                                    <span>·</span>
                                    <span className="flex items-center gap-1">
                                        <GitBranch className="w-3 h-3"/>
                                        {workspaces.find(ws => ws.id === activeWorkspaceId)?.baseBranch || 'main'}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">
                                    {t('projects.parallelLabel')} {runningTasks.length}/{3}
                                </span>
                                <button
                                    onClick={() => setShowCreateTask(true)}
                                    className="flex items-center gap-1 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm"
                                    data-tour="proj-new-task-btn"
                                >
                                    <Plus className="w-4 h-4"/> {t('projects.newTask')}
                                </button>
                            </div>
                        </div>

                        {/* 看板区域 */}
                        <div className="flex-1 overflow-y-auto p-4">
                            <div className="flex gap-4" data-tour="proj-kanban">
                                <KanbanColumn
                                    title={t('projects.columnRunning')}
                                    tasks={runningTasks}
                                    activeTaskId={activeTaskId}
                                    onSelectTask={setActiveTaskId}
                                    onPauseTask={handlePauseTask}
                                    onAbortTask={handleAbortTask}
                                    icon={<Loader2 className="w-4 h-4 text-blue-400"/>}
                                />
                                <KanbanColumn
                                    title={t('projects.columnQueued')}
                                    tasks={queuedTasks}
                                    activeTaskId={activeTaskId}
                                    onSelectTask={setActiveTaskId}
                                    onPauseTask={handlePauseTask}
                                    onAbortTask={handleAbortTask}
                                    icon={<Clock className="w-4 h-4 text-yellow-400"/>}
                                />
                                {waitingTasks.length > 0 && (
                                    <KanbanColumn
                                        title={t('projects.columnWaitingDeps')}
                                        tasks={waitingTasks}
                                        activeTaskId={activeTaskId}
                                        onSelectTask={setActiveTaskId}
                                        onPauseTask={handlePauseTask}
                                        onAbortTask={handleAbortTask}
                                        icon={<AlertCircle className="w-4 h-4 text-orange-400"/>}
                                    />
                                )}
                                <KanbanColumn
                                    title={t('projects.columnCompleted')}
                                    tasks={completedTasks}
                                    activeTaskId={activeTaskId}
                                    onSelectTask={setActiveTaskId}
                                    onPauseTask={handlePauseTask}
                                    onAbortTask={handleAbortTask}
                                    icon={<CheckCircle className="w-4 h-4 text-green-400"/>}
                                />
                            </div>
                        </div>

                        {/* 任务详情面板 */}
                        <AnimatePresence>
                            {activeTask && (
                                <TaskDetailPanel
                                    task={activeTask}
                                    logs={taskLogs[activeTask.id] || activeTask.logs || []}
                                    onClose={() => setActiveTaskId(null)}
                                    onPause={() => handlePauseTask(activeTask.id)}
                                    onResume={() => handleResumeTask(activeTask.id)}
                                    onAbort={() => handleAbortTask(activeTask.id)}
                                    onConfirm={() => handleConfirmTask(activeTask.id)}
                                />
                            )}
                        </AnimatePresence>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                        <div className="text-center">
                            <FolderKanban className="w-12 h-12 mx-auto mb-3 opacity-30"/>
                            <p className="text-sm">{t('projects.emptySelectProject')}</p>
                        </div>
                    </div>
                )}
            </div>

            {/* 弹窗 */}
            {showCreateTask && activeWorkspaceId && (
                <CreateTaskModal
                    workspaceId={activeWorkspaceId}
                    existingTasks={tasks}
                    onClose={() => setShowCreateTask(false)}
                    onCreated={loadTasks}
                />
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
