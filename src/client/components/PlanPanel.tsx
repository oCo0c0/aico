/**
 * @file PlanPanel.tsx
 * @description 开发计划面板（由 PlanPage 抽取，嵌入 PipelineRunPage 的 tab 中）
 *
 * 职责：生成/查看/编辑计划、对话式交互、确认后启动执行。
 * 历史列表由外层页面统一展示（按项目分组），本面板通过
 * loadTarget 接收外部选中的计划、通过 onDataChanged 通知外层刷新列表。
 */
import {useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle} from 'react';
import {usePageActiveRef} from '../hooks/usePageActive';
import {useTranslation} from 'react-i18next';
import {apiGet, apiPost, apiPut, pickFolder} from '../api';
import {useAppStore} from '../stores/app-store';
import {cn} from '../lib/utils';
import {Button} from '../components/ui/button';
import {Card, CardContent} from '../components/ui/card';
import {MarkdownContent} from '../components/MarkdownContent';
import {ExpandableContent} from '../components/ExpandableContent';
import {LogViewer} from '../components/LogViewer';
import {useParsedLogs} from '../hooks/useParsedLogs';
import type {PanelHandle, PanelInputState} from './PanelInput';
import {
    Sparkles,
    Pencil,
    RefreshCw,
    Save,
    X,
    AlertTriangle,
    Loader2,
    Play,
    MessageSquare,
    FileText,
    CheckCircle2,
    XCircle,
    Pause,
    RotateCcw,
    Download,
    ChevronDown,
    ChevronUp,
} from 'lucide-react';

/**
 * @interface PlanSummary
 * @description 计划摘要信息
 *
 * 用于计划历史列表的轻量级数据结构，
 * 不包含完整的计划输出内容，仅展示基本信息。
 */
interface PlanSummary {
    /** 计划唯一标识符 */
    id: string;
    /** 关联的需求ID */
    requirementId: string;
    /** 关联需求标题 */
    requirementTitle?: string;
    /** 关联需求编号（如 #125975） */
    requirementNumber?: string;
    /** 工作空间路径 */
    workspacePath: string;
    /** 计划状态 */
    status: 'generating' | 'paused' | 'ready' | 'failed' | 'waiting_input' | 'waiting_skill_confirm';
    /** 计划摘要文本（截取前段用于列表展示） */
    summary?: string;
    /** 创建时间（ISO 8601格式） */
    createdAt: string;
    /** 更新时间（ISO 8601格式） */
    updatedAt: string;
    /** 关联的流水线ID */
    pipelineId?: string;
}

/**
 * @interface StoredPlan
 * @description 完整的存储计划信息
 *
 * 继承PlanSummary，增加了Claude的完整输出内容和错误信息，
 * 用于计划详情页面的完整展示。
 */
interface StoredPlan extends PlanSummary {
    /** Claude生成的原始输出文本（Markdown格式） */
    rawOutput?: string;
    /** 生成失败时的错误信息 */
    error?: string;
    /** Claude会话ID，用于对话上下文关联 */
    sessionId?: string;
    /** 待执行技能队列（顺序敏感） */
    pendingSkills?: string[];
    /** 已执行完成的技能列表 */
    executedSkills?: string[];
    /** 当前执行中的技能名 */
    currentSkill?: string;
    /** 任务拆分结果（独立存储） */
    taskBreakdown?: string;
}

/**
 * @function PlanPage
 * @description 开发计划页面主组件（默认导出）
 *
 * 本组件实现了计划管理的完整生命周期：
 * 1. **计划生成**：调用/plan/generate API启动Claude生成计划，通过轮询跟踪进度
 * 2. **计划查看**：展示Claude的生成过程和最终结果，支持Markdown格式渲染
 * 3. **计划编辑**：支持手动编辑计划内容并保存
 * 4. **对话交互**：通过/plan/:id/reply API与Claude对话，获取补充信息或回答问题
 * 5. **执行启动**：确认计划后调用/execution/start API启动执行，跳转到执行页面
 * 6. **历史管理**：加载和浏览历史计划记录，支持删除操作
 *
 * 状态管理要点：
 * - 全局状态（app-store）：taskId、planLogs、selectedRequirement、currentWorkspace
 * - 本地状态：planHistory、activePlanId、plan、generating、editing等
 * - 轮询机制：每2秒检查一次计划状态，直到ready或failed
 */
export interface PlanPanelProps {
    /** 外部（历史列表）请求加载的计划：{id, seq}，seq 变化即重新加载 */
    loadTarget?: { id: string; seq: number } | null;
    /** 确认执行成功后回调（外层切换到执行 tab） */
    onExecutionStarted?: () => void;
    /** 数据变更后通知外层刷新历史列表 */
    onDataChanged?: () => void;
    /** 当前计划数据变化时回调（外层用于工作区侧边栏跟随） */
    onPlanChange?: (plan: StoredPlan | null) => void;
    /** 向外层上报共用输入框状态 */
    onInputState?: (state: PanelInputState) => void;
}

const PlanPanel = forwardRef<PanelHandle, PlanPanelProps>(function PlanPanel(
    {loadTarget, onExecutionStarted, onDataChanged, onPlanChange, onInputState},
    ref,
) {
    const {t} = useTranslation();

    // ─── 从全局状态（Zustand store）获取数据和更新方法 ───
    const taskId = useAppStore((s) => s.plan.taskId);                         // 当前计划任务ID（从流水线执行或localStorage恢复）
    const planLogs = useAppStore((s) => s.plan.logs);                         // Claude实时输出日志（WebSocket推送）
    const selectedRequirement = useAppStore((s) => s.requirements.selected);   // 当前选中的需求
    const requirementList = useAppStore((s) => s.requirements.list);           // 已保存需求列表
    const currentWorkspace = useAppStore((s) => s.workspace.current);          // 当前工作空间
    const setPlanStatus = useAppStore((s) => s.setPlanStatus);                // 设置计划状态
    const theme = useAppStore((s) => s.ui.theme);                           // 获取当前主题
    const planPhase = useAppStore((s) => s.plan.status);                      // 当前计划阶段状态
    const setPlanTaskId = useAppStore((s) => s.setPlanTaskId);                // 设置计划任务ID
    const setExecutionId = useAppStore((s) => s.setExecutionId);              // 设置执行ID（用于执行页面）
    const clearExecutionLogs = useAppStore((s) => s.clearExecutionLogs);      // 清除执行日志
    const clearPlanLogs = useAppStore((s) => s.clearPlanLogs);                // 清除计划日志

    // ─── 当前计划状态 ───
    const [activePlanId, setActivePlanId] = useState<string | null>(taskId);  // 当前查看的计划ID
    const [plan, setPlan] = useState<StoredPlan | null>(null);                // 当前计划的完整数据
    const [generating, setGenerating] = useState(false);                      // 是否正在生成中
    const [generatingElapsed, setGeneratingElapsed] = useState(0);            // 生成已耗时（秒）
    const [editing, setEditing] = useState(false);                            // 是否处于编辑模式
    const [editedSummary, setEditedSummary] = useState('');                   // 编辑中的计划内容
    // 计划摘要折叠状态
    const [isSummaryExpanded, setIsSummaryExpanded] = useState(false);
    // 任务拆分卡片折叠状态（默认折叠，避免挤占日志区）
    const [isTaskBreakdownExpanded, setIsTaskBreakdownExpanded] = useState(false);
    const SUMMARY_PREVIEW_LINES = 20; // 默认显示20行
    const [error, setError] = useState<string | null>(null);                  // 错误信息
    const [executing, setExecuting] = useState(false);                        // 是否正在启动执行
    const [replying, setReplying] = useState(false);                          // 是否正在发送回复
    const [skillConfirm, setSkillConfirm] = useState<{
        open: boolean;
        nextSkill?: string;
        completedSkill?: string
    }>({open: false});
    const [exporting, setExporting] = useState(false);

    // ─── 引用 ───
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // 页面活跃判定（ref 语义）：keep-alive 隐藏页/隐藏标签页暂停后台轮询
    const isPageActive = usePageActiveRef();      // 轮询定时器引用

    // 对外暴露 send()：共用输入框发送时调用（原内置输入框的 onSend 逻辑）
    useImperativeHandle(ref, () => ({
        send: (text: string, attachmentIds: string[]) => handleReply(text, attachmentIds),
    }));

    // 计划数据统一出口：setPlan 的同时通知外层（工作区侧边栏跟随）。
    // 内容签名未变化时跳过更新——轮询每 2s 返回新对象引用，
    // 不加此守卫会导致整面板（含大文档 Markdown）每 2s 无谓重解析，滚动卡死
    const onPlanChangeRef = useRef(onPlanChange);
    onPlanChangeRef.current = onPlanChange;
    const planSigRef = useRef<string | null>(null);
    const planSig = (p: StoredPlan | null) =>
        p ? [p.status, p.summary, p.rawOutput, p.taskBreakdown, p.error, p.currentSkill].join('\u0001') : 'null';
    const updatePlan = useCallback((p: StoredPlan | null) => {
        const sig = planSig(p);
        if (planSigRef.current === sig) return;
        planSigRef.current = sig;
        setPlan(p);
        onPlanChangeRef.current?.(p);
    }, []);

    // 计算是否可以生成计划：需要已选择需求、已设置工作空间、且当前未在生成中
    const canGenerate = selectedRequirement && currentWorkspace && !generating;

    // 日志消息（planLogs → LogMessageData[]，增量解析：Think 折叠行 / 分类工具行配对渲染）
    const logMessages = useParsedLogs(planLogs, {finalizeRunning: !generating});

    /**
     * 加载计划历史列表
     * 从后端获取所有计划的摘要信息，用于左侧历史面板展示
     */
    // 通知外层刷新统一历史列表（原面板内历史列表已上移至合页）
    const loadHistory = useCallback(() => {
        onDataChanged?.();
    }, [onDataChanged]);

    // 外部历史列表点击 → 加载对应计划
    useEffect(() => {
        if (loadTarget) loadPlan(loadTarget.id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadTarget?.seq]);

    /**
     * 加载指定计划的完整数据
     * 根据计划状态设置生成中标志
     *
     * @param id - 计划ID
     */
    const loadPlan = useCallback(async (id: string) => {
        setError(null);
        try {
            const data = await apiGet<StoredPlan>(`/plan/${id}`);
            updatePlan(data);
            setActivePlanId(id);
            if (data.status === 'generating') {
                setGenerating(true);
            } else {
                setGenerating(false);
            }
        } catch {
            // 加载失败时静默处理
        }
    }, []);

    /**
     * 当taskId变化时自动加载对应计划
     *
     * taskId可能来自：
     * - 流水线执行向导跳转（通过全局状态传递）
     * - localStorage持久化恢复（页面刷新后）
     *
     * 加载后根据计划状态决定是否启动轮询
     */
    useEffect(() => {
        if (!taskId) return;
        setActivePlanId(taskId);
        setError(null);
        clearPlanLogs();
        // 尝试立即加载计划数据；只有当计划确实还在生成中时才设置generating标志
        apiGet<StoredPlan>(`/plan/${taskId}`).then((data) => {
            updatePlan(data);
            if (data.status === 'generating') {
                setGenerating(true);
            } else {
                setGenerating(false);
            }
        }).catch(() => {
            // 计划不存在或请求失败——忽略，轮询机制会处理后续状态
        });
    }, [taskId, clearPlanLogs]);

    /**
     * 轮询活跃计划的状态
     *
     * 当存在活跃计划ID时，每2秒请求一次最新状态：
     * - ready：更新计划数据，停止生成状态，刷新历史列表
     * - failed：显示错误信息，停止生成状态
     * - generating：持续更新计划数据以显示最新内容
     *
     * 组件卸载或activePlanId变化时清理轮询定时器
     */
    useEffect(() => {
        if (!activePlanId) return;

        const poll = async () => {
            if (!isPageActive()) return; // 非活跃页/隐藏标签页跳过本轮
            try {
                const result = await apiGet<StoredPlan>(`/plan/${activePlanId}`);
                if (result.status === 'ready') {
                    updatePlan(result);
                    setGenerating(false);
                    setPlanStatus('ready');
                    loadHistory();
                    if (pollRef.current) clearInterval(pollRef.current);
                } else if (result.status === 'failed') {
                    updatePlan(result);
                    setGenerating(false);
                    setPlanStatus('idle');
                    if (pollRef.current) clearInterval(pollRef.current);
                } else if (result.status === 'paused') {
                    updatePlan(result);
                    setGenerating(false);
                    setPlanStatus('paused');
                    if (pollRef.current) clearInterval(pollRef.current);
                } else if (result.status === 'waiting_skill_confirm') {
                    updatePlan(result);
                    setGenerating(false);
                    setPlanStatus('idle');
                    setSkillConfirm({
                        open: true,
                        nextSkill: result.pendingSkills?.[0],
                        completedSkill: result.executedSkills?.[result.executedSkills.length - 1]
                    });
                    if (pollRef.current) clearInterval(pollRef.current);
                } else {
                    updatePlan(result);
                }
            } catch {
                // 请求失败时继续轮询，不中断
            }
        };

        // 立即执行一次轮询，然后设置定时器
        poll();
        pollRef.current = setInterval(poll, 2000);

        // 清理函数：组件卸载或依赖变化时清除定时器
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [activePlanId, setPlanStatus, loadHistory]);

    // ─── 生成超时计时器 ───
    useEffect(() => {
        if (!generating) {
            setGeneratingElapsed(0);
            return;
        }
        const timer = setInterval(() => {
            setGeneratingElapsed((s) => s + 1);
        }, 1000);
        return () => clearInterval(timer);
    }, [generating]);

    /**
     * 生成新的开发计划
     *
     * 调用/plan/generate API启动Claude计划生成流程，
     * 成功后将taskId存入全局状态，轮询机制会自动跟踪进度。
     *
     * @param overrideRequirementId - 可选的需求ID覆盖（重新生成时使用 plan 自带的需求ID）
     * @param overrideWorkspacePath - 可选的工作空间路径覆盖
     */
    const generatePlan = async (overrideRequirementId?: string, overrideWorkspacePath?: string) => {
        const requirementId = overrideRequirementId || selectedRequirement?.id;
        const workspacePath = overrideWorkspacePath || currentWorkspace?.path;
        if (!requirementId || !workspacePath) return;

        // 从已选需求或全局列表中查找需求信息
        const reqInfo = overrideRequirementId
            ? requirementList.find(r => r.id === overrideRequirementId)
            : selectedRequirement;

        setGenerating(true);
        setError(null);
        updatePlan(null);
        clearPlanLogs();
        try {
            const {taskId: newTaskId} = await apiPost<{ taskId: string }>('/plan/generate', {
                requirementId,
                workspacePath,
                pipelineId: plan?.pipelineId,
                requirementTitle: reqInfo?.title,
                requirementNumber: reqInfo?.number,
            });
            // 将新任务ID存入全局状态，触发轮询effect
            setPlanTaskId(newTaskId);
            setActivePlanId(newTaskId);
            setPlanStatus('generating');
        } catch (err) {
            setError(err instanceof Error ? err.message : t('plan.failedGenerate'));
            setGenerating(false);
        }
    };

    /**
     * 保存编辑后的计划内容
     * 调用PUT API更新计划的summary和rawOutput字段
     */
    const savePlan = async () => {
        if (!plan || !activePlanId) return;
        try {
            const updated = await apiPut<StoredPlan>(`/plan/${activePlanId}`, {
                summary: editedSummary,
                rawOutput: editedSummary,
            });
            updatePlan(updated);
            setEditing(false);
            loadHistory(); // 保存后刷新历史列表
        } catch (err) {
            setError(err instanceof Error ? err.message : t('plan.failedSave'));
        }
    };

    /**
     * 向Claude发送回复消息
     *
     * 在计划生成完成或生成过程中，用户可以回复Claude的提问或提供额外信息。
     * 发送后会重启轮询机制（因为activePlanId不变，需要手动重启），
     * 等待Claude处理回复并更新计划。
     *
     * 流程：
     * 1. 验证输入非空且不在发送中
     * 2. 调用/plan/:id/reply API发送消息
     * 3. 清除旧轮询，启动新轮询跟踪Claude的回复处理
     * 4. 回复完成后自动恢复焦点到输入框
     */
    /** 确认继续下一个技能 */
    const handleContinueSkill = async () => {
        if (!activePlanId) return;
        setSkillConfirm({open: false});
        setGenerating(true);
        try {
            await apiPost(`/plan/${activePlanId}/continue-skill`);
            // 重启轮询
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = setInterval(async () => {
                try {
                    const result = await apiGet<StoredPlan>(`/plan/${activePlanId}`);
                    updatePlan(result);
                    if (result.status === 'ready' || result.status === 'failed' || result.status === 'paused') {
                        setGenerating(false);
                        if (pollRef.current) clearInterval(pollRef.current);
                    } else if (result.status === 'waiting_skill_confirm') {
                        setGenerating(false);
                        setSkillConfirm({
                            open: true,
                            nextSkill: result.pendingSkills?.[0],
                            completedSkill: result.executedSkills?.[result.executedSkills.length - 1]
                        });
                        if (pollRef.current) clearInterval(pollRef.current);
                    }
                } catch { /* continue polling */
                }
            }, 2000);
        } catch (err) {
            setGenerating(false);
            setError(err instanceof Error ? err.message : 'Continue skill failed');
        }
    };

    /** 跳过下一个技能 */
    const handleSkipSkill = async () => {
        if (!activePlanId) return;
        setSkillConfirm({open: false});
        setGenerating(true);
        try {
            const res = await apiPost<{ completed?: boolean }>(`/plan/${activePlanId}/skip-skill`);
            if (res.completed) {
                // 全部完成，刷新
                const result = await apiGet<StoredPlan>(`/plan/${activePlanId}`);
                updatePlan(result);
                setGenerating(false);
                setPlanStatus('ready');
                loadHistory();
                return;
            }
            // 重启轮询
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = setInterval(async () => {
                try {
                    const result = await apiGet<StoredPlan>(`/plan/${activePlanId}`);
                    updatePlan(result);
                    if (result.status === 'ready' || result.status === 'failed') {
                        setGenerating(false);
                        if (pollRef.current) clearInterval(pollRef.current);
                    } else if (result.status === 'waiting_skill_confirm') {
                        setGenerating(false);
                        setSkillConfirm({
                            open: true,
                            nextSkill: result.pendingSkills?.[0],
                            completedSkill: result.executedSkills?.[result.executedSkills.length - 1]
                        });
                        if (pollRef.current) clearInterval(pollRef.current);
                    }
                } catch { /* continue */
                }
            }, 2000);
        } catch (err) {
            setGenerating(false);
            setError(err instanceof Error ? err.message : 'Skip skill failed');
        }
    };

    /** 导出任务拆分 + 工时评估 xlsx（rawOutput 无 JSON 时自动先跑 task-breakdown-estimator 技能） */
    const handleExportTasks = async () => {
        if (!activePlanId) return;
        setExporting(true);
        setError(null);
        try {
            const folder = await pickFolder('选择导出目录');
            const fileBase = plan?.requirementNumber || activePlanId.substring(0, 8);
            const outputPath = folder
                ? `${folder}/${fileBase}.xlsx`
                : undefined;
            const res = await apiPost<{ success: boolean; path: string; count: number; message?: string }>(
                `/plan/${activePlanId}/export-tasks`,
                outputPath ? {outputPath} : {},
            );
            if (res.success) {
                // 导出成功后刷新 plan（技能执行可能已更新 rawOutput）
                const refreshed = await apiGet<StoredPlan>(`/plan/${activePlanId}`);
                updatePlan(refreshed);
            } else {
                setError(res.message ?? '导出失败');
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : '导出失败';
            setError(msg);
        } finally {
            setExporting(false);
        }
    };

    /**
     * 开始新会话（清空后端上下文，保留前端历史显示）
     * 当上下文即将满时（>80%）调用，避免 529 错误
     */
    const handleNewSession = async () => {
        if (!activePlanId) return;

        try {
            await apiPost(`/plan/${activePlanId}/new-session`, {});
            // 新会话创建成功，历史消息仍保留在 planLogs 中
            // 下次发送消息时将使用新 sessionId
        } catch (err) {
            console.error('新会话创建失败:', err);
        }
    };

    const handleReply = async (text: string, attachmentIds: string[]) => {
        if (!text.trim() || !activePlanId || replying) return;
        const message = text.trim();
        setReplying(true);
        setGenerating(true);
        setPlanStatus('generating'); // 立即更新全局状态（图标转动）
        // 移除 clearPlanLogs() - 保留历史对话，新内容追加而非覆盖

        try {
            // 发送回复消息到Claude（附件以 attachmentIds 旁路传递）
            await apiPost(`/plan/${activePlanId}/reply`, {
                message,
                attachmentIds: attachmentIds.length ? attachmentIds : undefined,
            });

            // 由于activePlanId未改变，需要手动重启轮询机制
            if (pollRef.current) clearInterval(pollRef.current);
            const poll = async () => {
                if (!isPageActive()) return; // 非活跃页跳过本轮
                try {
                    const result = await apiGet<StoredPlan>(`/plan/${activePlanId}`);
                    if (result.status === 'ready') {
                        // Claude回复处理完成
                        updatePlan(result);
                        setGenerating(false);
                        setPlanStatus('ready');
                        loadHistory();
                        if (pollRef.current) clearInterval(pollRef.current);
                    } else if (result.status === 'failed') {
                        // Claude回复处理失败
                        updatePlan(result);
                        setError(result.error || t('plan.replyFailed'));
                        setGenerating(false);
                        setPlanStatus('idle');
                        if (pollRef.current) clearInterval(pollRef.current);
                    } else if (result.status === 'generating') {
                        // 正在生成中——确保 UI 状态正确
                        updatePlan(result);
                        setGenerating(true);
                        setPlanStatus('generating');
                    } else {
                        // 其他状态（如 paused）——仅在有新输出时更新计划数据
                        updatePlan(result);
                    }
                } catch {
                    // 请求失败时继续轮询
                }
            };
            poll();
            pollRef.current = setInterval(poll, 2000);

        } catch (err) {
            setError(err instanceof Error ? err.message : t('plan.failedSendReply'));
            setGenerating(false);
            setPlanStatus('idle'); // 错误时恢复状态
        } finally {
            setReplying(false);
        }
    };

    /**
     * 确认计划并启动执行
     *
     * 调用/execution/start API启动执行流程，
     * 成功后将executionId存入全局状态并跳转到执行页面。
     * 执行前会清除旧的执行日志，确保页面干净。
     */
    const handleConfirmAndExecute = async () => {
        if (!plan || !activePlanId) return;
        setExecuting(true);
        setError(null);
        clearExecutionLogs();
        try {
            const result = await apiPost<{ executionId: string }>('/execution/start', {
                planId: activePlanId,
            });
            setExecutionId(result.executionId);
            // 合页内切换：通知外层切到执行 tab
            onExecutionStarted?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('plan.failedStartExecution'));
            setExecuting(false);
        }
    };

    // 组件卸载时清理轮询定时器，防止内存泄漏
    useEffect(() => {
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    /**
     * 根据计划状态返回对应的状态图标
     * 用于历史列表中的状态可视化标识
     *
     * @param status - 计划状态字符串
     * @returns 对应的React图标元素
     */
    const statusIcon = (status: string) => {
        switch (status) {
            case 'ready':
                return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500"/>;
            case 'failed':
                return <XCircle className="h-3.5 w-3.5 text-destructive"/>;
            case 'generating':
                return <Loader2 className="h-3.5 w-3.5 text-primary animate-spin"/>;
            default:
                return <FileText className="h-3.5 w-3.5 text-muted-foreground"/>;
        }
    };

    // 向外层上报共用输入框状态（动作按钮随生成/暂停状态切换）
    useEffect(() => {
        onInputState?.({
            placeholder: t('plan.replyPlaceholder'),
            disabled: generating,
            sending: replying,
            branchWorkspacePath: plan?.workspacePath,
            branchDisabled: generating,
            contextLogs: planLogs.map(l => typeof l === 'string' ? l : JSON.stringify(l)),
            onSuggestNewSession: handleNewSession,
            actions: generating ? (
                <>
                    <Button
                        onClick={async () => {
                            if (!activePlanId) return;
                            try {
                                await apiPost(`/plan/${activePlanId}/pause`, {});
                                setGenerating(false);
                                setPlanStatus('paused');
                                loadHistory();
                            } catch (err) {
                                setError(err instanceof Error ? err.message : t('plan.failedPause'));
                            }
                        }}
                        variant="outline"
                        size="icon"
                        className="shrink-0"
                        title={t('plan.pause')}
                        aria-label={t('plan.pause')}
                    >
                        <Pause className="h-4 w-4"/>
                    </Button>
                    <Button
                        variant="outline"
                        onClick={async () => {
                            if (!activePlanId) return;
                            try {
                                await apiPost(`/plan/${activePlanId}/abort`, {});
                                setGenerating(false);
                                setPlanStatus('failed');
                                setError(t('plan.generationCancelled'));
                                loadHistory();
                            } catch (err) {
                                setError(err instanceof Error ? err.message : t('plan.failedAbort'));
                            }
                        }}
                        size="icon"
                        className="shrink-0 text-destructive hover:text-destructive"
                        title={t('common.cancel')}
                        aria-label={t('common.cancel')}
                    >
                        <XCircle className="h-4 w-4"/>
                    </Button>
                </>
            ) : planPhase === 'paused' ? (
                <>
                    <Button
                        onClick={async () => {
                            if (!activePlanId) return;
                            try {
                                await apiPost(`/plan/${activePlanId}/resume`, {});
                                setGenerating(true);
                                setGeneratingElapsed(0);
                                setPlanStatus('generating');
                            } catch (err) {
                                setError(err instanceof Error ? err.message : t('plan.failedResume'));
                            }
                        }}
                        variant="outline"
                        size="icon"
                        className="shrink-0"
                        title={t('plan.resume')}
                        aria-label={t('plan.resume')}
                    >
                        <Play className="h-4 w-4"/>
                    </Button>
                    <Button
                        variant="outline"
                        onClick={async () => {
                            if (!activePlanId) return;
                            try {
                                await apiPost(`/plan/${activePlanId}/abort`, {});
                                setPlanStatus('idle');
                                setError(t('plan.generationCancelled'));
                            } catch (err) {
                                setError(err instanceof Error ? err.message : t('plan.failedAbort'));
                            }
                        }}
                        size="icon"
                        className="shrink-0 text-destructive hover:text-destructive"
                        title={t('common.cancel')}
                        aria-label={t('common.cancel')}
                    >
                        <XCircle className="h-4 w-4"/>
                    </Button>
                </>
            ) : undefined,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [t, generating, replying, planPhase, plan, planLogs, activePlanId]);

    return (
        <div className="flex flex-col h-full min-w-0">
            {/* ─── 面板头部：状态描述和操作按钮（标题由合页 tab 提供） ─── */}
            <div className="border-b border-border px-6 py-3 shrink-0">
                <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                        {generating ? t('plan.generating') :
                            plan ? t('plan.ready') :
                                t('plan.idle')}
                    </p>

                        {/* 操作按钮组：根据计划状态动态显示 */}
                        <div className="flex items-center gap-2">
                            {/* 无计划且未生成时：显示"生成计划"按钮 */}
                            {!plan && !generating && (
                                <Button onClick={() => generatePlan()} disabled={!canGenerate}
                                        data-tour="plan-generate-btn">
                                    <Sparkles className="h-4 w-4 mr-2"/>
                                    {t('plan.generate')}
                                </Button>
                            )}

                            {/* === failed 状态：重新生成 + 重新执行 === */}
                            {plan && plan.status === 'failed' && !editing && !generating && (
                                <>
                                    <Button variant="outline" size="sm" onClick={async () => {
                                        try {
                                            setGenerating(true);
                                            setError(null);
                                            clearPlanLogs();
                                            await apiPost(`/plan/${activePlanId}/regenerate`, {});
                                            setPlanStatus('generating');
                                        } catch (err) {
                                            setError(err instanceof Error ? err.message : t('plan.failedRegenerate'));
                                            setGenerating(false);
                                        }
                                    }}>
                                        <RefreshCw className="h-4 w-4 mr-1.5"/>
                                        {t('plan.regenerate')}
                                    </Button>
                                    {(plan.rawOutput || plan.summary) && (
                                        <Button
                                            size="sm"
                                            className="bg-amber-600 hover:bg-amber-700 text-white"
                                            onClick={handleConfirmAndExecute}
                                            disabled={executing}
                                        >
                                            {executing ? (
                                                <Loader2 className="h-4 w-4 mr-1.5 animate-spin"/>
                                            ) : (
                                                <RotateCcw className="h-4 w-4 mr-1.5"/>
                                            )}
                                            {executing ? t('plan.starting') : t('plan.retryExecute')}
                                        </Button>
                                    )}
                                </>
                            )}

                            {/* paused 状态的控制（恢复/取消）已收敛到下方输入框旁 */}

                            {/* === ready 状态：编辑 + 重新生成 + 确认执行 === */}
                            {plan && plan.status === 'ready' && !editing && !generating && (
                                <>
                                    <Button variant="outline" size="sm" onClick={() => {
                                        setEditing(true);
                                        setEditedSummary(plan.rawOutput || plan.summary || '');
                                    }}>
                                        <Pencil className="h-4 w-4 mr-1.5"/>
                                        {t('common.edit')}
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => generatePlan()}
                                            disabled={!canGenerate}>
                                        <RefreshCw className="h-4 w-4 mr-1.5"/>
                                        {t('plan.newPlan')}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleExportTasks}
                                        disabled={exporting}
                                    >
                                        {exporting ? (
                                            <Loader2 className="h-4 w-4 mr-1.5 animate-spin"/>
                                        ) : (
                                            <Download className="h-4 w-4 mr-1.5"/>
                                        )}
                                        {exporting ? '导出中...' : '导出任务表'}
                                    </Button>
                                    <Button
                                        size="sm"
                                        className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                        onClick={handleConfirmAndExecute}
                                        disabled={executing}
                                        data-tour="plan-confirm-btn"
                                    >
                                        {executing ? (
                                            <Loader2 className="h-4 w-4 mr-1.5 animate-spin"/>
                                        ) : (
                                            <Play className="h-4 w-4 mr-1.5"/>
                                        )}
                                        {executing ? t('plan.starting') : t('plan.confirmExecute')}
                                    </Button>
                                </>
                            )}

                            {/* 编辑模式下：显示保存和取消按钮 */}
                            {editing && (
                                <>
                                    <Button size="sm" onClick={savePlan}>
                                        <Save className="h-4 w-4 mr-1.5"/>
                                        {t('common.save')}
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                                        <X className="h-4 w-4 mr-1.5"/>
                                        {t('common.cancel')}
                                    </Button>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                {/* 主内容区域：根据状态条件渲染不同的内容区块 */}
                <div className="flex-1 min-h-0 overflow-y-auto p-6">
                    {/* 空状态：无计划选中时显示提示信息 */}
                    {!activePlanId && !generating && (
                        <Card>
                            <CardContent className="p-6 flex flex-col items-center gap-3 text-center">
                                <FileText className="h-10 w-10 text-muted-foreground/30"/>
                                <p className="text-sm text-muted-foreground">
                                    {t('plan.emptyNoHistory')}
                                </p>
                                {/* 未选择需求时显示提示 */}
                                {!canGenerate && !selectedRequirement && (
                                    <p className="text-xs text-muted-foreground/60">
                                        {t('plan.selectRequirementHint')}
                                    </p>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    {/* 生成中指示器：显示进度条和Claude实时输出 */}
                    {generating && (
                        <Card className="mb-4">
                            <CardContent className="p-5">
                                {/* 生成状态标题和加载动画 */}
                                <div className="flex items-center gap-3 mb-3">
                                    <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0"/>
                                    <span
                                        className="text-sm font-medium">{t('plan.generatingTitle')}</span>
                                </div>
                                {/* 进度条（脉冲动画模拟进度） */}
                                <div className="h-1.5 bg-muted rounded-full overflow-hidden mb-3">
                                    <div className="h-full bg-primary rounded-full animate-pulse w-2/3"/>
                                </div>

                                {/* Claude实时输出日志面板（统一 LogViewer：分组折叠 / 工具栏 / Think 折叠行 / 贴底自动滚动） */}
                                {planLogs.length > 0 && (
                                    <LogViewer
                                        messages={logMessages}
                                        title={t('plan.claudeOutput')}
                                        isStreaming
                                        className="max-h-96"
                                        showJumpBar
                                        jumpBarPaths={['/pipeline-run']}
                                    />
                                )}

                                {/* 生成控制区域：等待/Paused/Pause/Cancel/Resume */}
                                {generating && (
                                    <div className="space-y-2">
                                        {planLogs.length === 0 ? (
                                            <p className="text-xs text-muted-foreground">
                                                {t('plan.waitingStart')}
                                            </p>
                                        ) : (
                                            <p className="text-xs text-muted-foreground">
                                                {t('plan.claudeGenerating')}
                                                ({Math.floor(generatingElapsed / 60)}m {generatingElapsed % 60}s)
                                            </p>
                                        )}
                                        {generatingElapsed > 120 && planLogs.length === 0 && (
                                            <p className="text-xs text-amber-500">
                                                {t('plan.takingLonger')}
                                            </p>
                                        )}
                                        {/* 控制按钮已收敛到下方输入框旁 */}
                                    </div>
                                )}

                                {/* Paused 状态提示（控制按钮已收敛到下方输入框旁） */}
                                {planPhase === 'paused' && (
                                    <div
                                        className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                                        <Pause className="h-3.5 w-3.5 text-amber-500"/>
                                        <span className="text-xs text-amber-500 font-medium">
                                            {t('plan.generationPaused')}
                                        </span>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    {/* 错误信息提示条：操作错误（启动执行/保存失败等）或计划本身的失败 */}
                    {(error || (plan?.status === 'failed' && plan.error)) && (
                        <div
                            className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
                            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0"/>
                            <div>
                                <p className="text-sm font-medium text-destructive">{t('plan.error')}</p>
                                <p className="text-sm text-muted-foreground mt-1">{error || plan?.error}</p>
                            </div>
                        </div>
                    )}

                    {/* 计划详情内容：仅在计划数据加载后显示 */}
                    {plan && (
                        <div className="space-y-4">
                            {/* 上下文信息卡片：关联的需求、工作空间和创建时间 */}
                            <Card>
                                <CardContent className="p-4">
                                    <div className="flex items-center gap-2 text-sm">
                                        <span className="text-muted-foreground">{t('plan.requirement')}</span>
                                        <span className="font-medium">
                      {plan.requirementNumber ? `${plan.requirementNumber} ` : ''}{plan.requirementTitle || plan.requirementId.substring(0, 8)}
                    </span>
                                    </div>
                                    <div className="flex items-center gap-2 text-sm mt-1">
                                        <span className="text-muted-foreground">{t('plan.workspace')}</span>
                                        <span className="font-mono text-xs">{plan.workspacePath}</span>
                                    </div>
                                    <div className="flex items-center gap-2 text-sm mt-1">
                                        <span className="text-muted-foreground">{t('plan.created')}</span>
                                        <span className="text-xs text-muted-foreground">
                      {new Date(plan.createdAt).toLocaleString()}
                    </span>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* 计划输出内容卡片：编辑模式显示textarea，查看模式显示格式化文本 */}
                            <Card>
                                <CardContent className="p-4">
                                    <div className="flex items-center justify-between mb-3">
                                        <h3 className="text-sm font-semibold">{t('plan.generatedPlan')}</h3>
                                        {/* 折叠控制按钮：内容超过20行时显示 */}
                                        {!editing && (plan.rawOutput || plan.summary) && (plan.rawOutput || plan.summary || '').split('\n').length > SUMMARY_PREVIEW_LINES && (
                                            <button
                                                onClick={() => setIsSummaryExpanded(!isSummaryExpanded)}
                                                className="text-xs text-primary hover:underline flex items-center gap-1"
                                            >
                                                {isSummaryExpanded ? (
                                                    <>
                                                        <ChevronUp className="h-3 w-3"/>
                                                        折叠
                                                    </>
                                                ) : (
                                                    <>
                                                        <ChevronDown className="h-3 w-3"/>
                                                        展开全部
                                                    </>
                                                )}
                                            </button>
                                        )}
                                    </div>
                                    {editing ? (
                                        /* 编辑模式：可编辑的文本区域 */
                                        <textarea
                                            value={editedSummary}
                                            onChange={(e) => setEditedSummary(e.target.value)}
                                            aria-label={t('plan.generatedPlan')}
                                            className="w-full min-h-[400px] bg-muted/30 border border-input rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                                        />
                                    ) : (
                                        /* 查看模式：Markdown 渲染 + 折叠功能 */
                                        <div className="relative">
                                            <ExpandableContent title={t('plan.generatedPlan')}>
                                                <div
                                                    className={cn(
                                                        "text-sm leading-relaxed bg-muted/20 rounded-md p-4 overflow-x-auto transition-all duration-200",
                                                        !isSummaryExpanded && "max-h-96 overflow-y-auto"
                                                    )}
                                                    data-tour="plan-content"
                                                >
                                                    <MarkdownContent
                                                        content={plan.rawOutput || plan.summary || (generating && planLogs.length > 0 ? planLogs.join('') : t('plan.noPlanContent'))}
                                                    />
                                                </div>
                                            </ExpandableContent>
                                            {/* 折叠提示遮罩：未展开时显示渐变遮罩，覆盖在内容底部 */}
                                            {!isSummaryExpanded && (plan.rawOutput || plan.summary || '').split('\n').length > SUMMARY_PREVIEW_LINES && (
                                                <div
                                                    className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-background via-background/80 to-transparent pointer-events-none rounded-b-md"/>
                                            )}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            {/* 任务拆分独立卡片：taskBreakdown 存在时展示，默认折叠，点击标题展开 */}
                            {!editing && plan.taskBreakdown && (
                                <Card className="border-emerald-500/20 bg-emerald-500/5">
                                    <CardContent className="p-4">
                                        <button
                                            type="button"
                                            onClick={() => setIsTaskBreakdownExpanded(!isTaskBreakdownExpanded)}
                                            className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity"
                                        >
                                            <Download className="h-4 w-4 text-emerald-600 shrink-0"/>
                                            <h3 className="text-sm font-semibold text-emerald-700">
                                                任务拆分与工时评估
                                            </h3>
                                            <span className="text-xs text-muted-foreground hidden sm:inline">
                                                （独立于开发计划，可多次导出）
                                            </span>
                                            {isTaskBreakdownExpanded
                                                ? <ChevronUp className="h-4 w-4 text-muted-foreground ml-auto"/>
                                                : <ChevronDown className="h-4 w-4 text-muted-foreground ml-auto"/>}
                                        </button>
                                        {isTaskBreakdownExpanded && (
                                            <ExpandableContent title="任务拆分与工时评估" className="mt-3">
                                                <div className="text-sm leading-relaxed bg-muted/20 rounded-md p-4 overflow-x-auto max-h-96 overflow-y-auto">
                                                    <MarkdownContent content={plan.taskBreakdown}/>
                                                </div>
                                            </ExpandableContent>
                                        )}
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    )}
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
        </div>
    );
});

export default PlanPanel;
