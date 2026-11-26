/**
 * @file ChatInputBox.tsx
 * @description 统一聊天输入框组件 —— 四个流程页面（Agent 执行 / 经典执行 / 开发计划 / 项目空间）共用。
 *   - 输入卡片：Enter 发送；Shift+Enter / Ctrl+Enter 换行（textarea 默认行为）；中文输入法
 *     composition 期间 Enter 是选词，不发送。
 *   - 底部工具栏：左侧附件上传 / 语音输入 / 模型选择器 / 权限模式选择器 / 分支选择器（可选）；右侧提示词优化 /
 *     放大编辑 / 页面动作插槽（暂停、终止等）/ 发送按钮。
 *   - 放大编辑弹窗与提示词优化面板整体移植自 ExpandableTextarea（悬浮按钮改为工具栏常驻按钮）。
 *   纯受控组件：文本 value/onChange 由页面持有；onSend 时组件先快照并清空附件 chips，
 *   文本清空由页面在 onSend 内完成。
 */

import * as React from 'react';
import {useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {useTranslation} from 'react-i18next';
import {Loader2, Maximize2, Paperclip, Send, Sparkles, X} from 'lucide-react';
import {apiPost} from '../api';
import {cn} from '../lib/utils';
import {Button} from './ui/button';
import {AttachmentButton} from './input/AttachmentButton';
import {VoiceButton} from './input/VoiceButton';
import {ModelPicker} from './input/ModelPicker';
import {PermissionPicker} from './input/PermissionPicker';
import {BranchPicker} from './input/BranchPicker';
import {SlashMenu, flattenEntries} from './input/SlashMenu';
import {useCommandCatalog} from '../hooks/useCommandCatalog';
import {applySlashPick, detectSlashTrigger, filterCandidates} from '../lib/input-trigger';

/** 待发送附件（上传成功后经 AttachmentButton.onUploaded 回传，发送时随 onSend 交给页面） */
export interface PendingAttachment {
    attachmentId: string;
    fileName: string;
    chars: number;
}

interface ChatInputBoxProps {
    value: string;
    onChange: (v: string) => void;
    /** 发送（Enter 或点击发送按钮）。返回 false 或 reject 表示发送失败，组件恢复附件 chips（文本清空仍由页面负责） */
    onSend: (text: string, attachments: PendingAttachment[]) => boolean | void | Promise<boolean | void>;
    disabled?: boolean;
    placeholder?: string;
    rows?: number;
    /** 放大弹窗标题 */
    title?: string;
    /** 是否启用「提示词优化」按钮 */
    optimizable?: boolean;
    /** 优化用途（reply / requirement / plan），用于给模型提供优化上下文 */
    optimizePurpose?: string;
    /** 页面特定动作按钮（暂停/终止/重试/清空日志等），渲染于工具栏右侧 */
    actions?: React.ReactNode;
    sending?: boolean;
    /** 页面级禁用发送（如运行中排队按钮自己的 disabled 逻辑） */
    sendDisabled?: boolean;
    /** 允许空文本发送（AgentExecutionPage 的「开始执行」） */
    allowEmptySend?: boolean;
    showModelPicker?: boolean;
    showPermissionPicker?: boolean;
    /** 分支选择器目标工作区路径；不传则不渲染分支选择器 */
    branchWorkspacePath?: string;
    /** 分支选择器置灰（如任务运行中禁止切换分支） */
    branchDisabled?: boolean;
    showAttachments?: boolean;
    showVoice?: boolean;
    /** 紧凑模式（ProjectsPage 抽屉） */
    compact?: boolean;
    wrapperClassName?: string;
}

/** 附件字数紧凑显示（如 1.2k），避免 chip 过宽 */
function formatChars(chars: number): string {
    return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars);
}

export const ChatInputBox = React.forwardRef<HTMLTextAreaElement, ChatInputBoxProps>((props, ref) => {
    const {
        value, onChange, onSend, disabled, placeholder, rows = 2, title,
        optimizable, optimizePurpose, actions, sending, sendDisabled, allowEmptySend,
        showModelPicker = true, showPermissionPicker = true, showAttachments = true, showVoice = true,
        branchWorkspacePath, branchDisabled,
        compact, wrapperClassName = '',
    } = props;
    const {t} = useTranslation();

    const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
    const [expanded, setExpanded] = useState(false);
    // 提示词优化状态（移植自 ExpandableTextarea）
    const [optimizing, setOptimizing] = useState(false);
    const [optimizeResult, setOptimizeResult] = useState<string | null>(null);
    const [optimizeError, setOptimizeError] = useState<string | null>(null);
    const modalRef = useRef<HTMLTextAreaElement>(null);

    // ── 斜杠命令 / 技能菜单（对齐 DSH 的输入触发）──
    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    const {groups: catalogGroups} = useCommandCatalog();
    const [slash, setSlash] = useState<{query: string; start: number; end: number} | null>(null);
    const [slashActive, setSlashActive] = useState(0);
    const [slashDismissed, setSlashDismissed] = useState(false);

    const menuGroups = useMemo(() => {
        if (!slash || slashDismissed) return [];
        return catalogGroups
            .map(g => ({source: g.source, items: filterCandidates(g.items, slash.query)}))
            .filter(g => g.items.length > 0);
    }, [catalogGroups, slash, slashDismissed]);
    const menuEntries = useMemo(() => flattenEntries(menuGroups), [menuGroups]);
    const menuOpen = menuEntries.length > 0;

    /** 依据光标位置重算触发词 */
    const syncSlashTrigger = (el: HTMLTextAreaElement | null) => {
        if (!el) return;
        const hit = detectSlashTrigger(el.value, el.selectionStart ?? 0);
        setSlash(hit);
        setSlashActive(0);
        setSlashDismissed(false);
    };

    /** 选中候选项：把触发区间替换为 `/name `（与手打结果一致，确定性在服务端） */
    const pickSlashCandidate = (name: string) => {
        if (!slash) return;
        const el = innerRef.current;
        const next = applySlashPick(value, slash, name);
        onChange(next.draft);
        setSlash(null);
        setSlashDismissed(true);
        requestAnimationFrame(() => {
            el?.focus();
            el?.setSelectionRange(next.caret, next.caret);
        });
    };

    /** 合并外部 ref 与内部 ref（触发检测需要读取 textarea） */
    const setTextareaRef = (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    };

    const canSend = !disabled && !sending && !sendDisabled
        && (value.trim().length > 0 || attachments.length > 0 || !!allowEmptySend);

    // 打开放大弹窗后自动聚焦到弹窗内的 textarea
    useEffect(() => {
        if (expanded) {
            requestAnimationFrame(() => modalRef.current?.focus());
        }
    }, [expanded]);

    // 支持 Esc 关闭放大弹窗
    useEffect(() => {
        if (!expanded) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setExpanded(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [expanded]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // 菜单打开时优先接管导航键（IME 合成期间一律放行）
        if (menuOpen && !e.nativeEvent.isComposing) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const delta = e.key === 'ArrowDown' ? 1 : -1;
                setSlashActive(prev => (prev + delta + menuEntries.length) % menuEntries.length);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const pick = menuEntries[slashActive];
                if (pick) pickSlashCandidate(pick.name);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setSlashDismissed(true);
                setSlash(null);
                return;
            }
        }

        if (e.key !== 'Enter') return;
        // 中文输入法 composition 期间 Enter 是选词，不发送
        if (e.nativeEvent.isComposing) return;
        // Ctrl/Cmd+Enter 与 Shift+Enter 换行：走 textarea 默认行为
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (!canSend) return;
        e.preventDefault();
        void submit();
    };

    const submit = async () => {
        if (!canSend) return;
        const atts = attachments;
        setAttachments([]); // 乐观清空；onSend 返回 false（发送失败）时恢复
        try {
            const ok = await onSend(value, atts);
            if (ok === false) setAttachments(atts);
        } catch (err) {
            // 错误提示由页面在 onSend 内负责；这里兜底避免未处理的 Promise 拒绝
            console.error('ChatInputBox: onSend failed', err);
            setAttachments(atts);
        }
    };
    // 注意：props.onChange('') 由页面在 onSend 内完成（保持页面现有清空逻辑）

    /** 提示词优化：调后端润色，结果展示给用户自行决定是否采纳（移植自 ExpandableTextarea） */
    const handleOptimize = async () => {
        const text = value.trim();
        if (!text || optimizing) return;

        setOptimizing(true);
        setOptimizeError(null);
        setOptimizeResult(null);
        try {
            const res = await apiPost<{optimized: string}>('/prompts/optimize', {
                text,
                purpose: optimizePurpose,
            });
            setOptimizeResult(res.optimized);
        } catch (err) {
            setOptimizeError(err instanceof Error ? err.message : String(err));
        } finally {
            setOptimizing(false);
        }
    };

    const adoptOptimized = () => {
        if (optimizeResult == null) return;
        onChange(optimizeResult);
        setOptimizeResult(null);
        setOptimizeError(null);
    };

    const discardOptimized = () => {
        setOptimizeResult(null);
        setOptimizeError(null);
    };

    const removeAttachment = (id: string) => {
        setAttachments(prev => prev.filter(a => a.attachmentId !== id));
    };

    return (
        <div className={cn('relative min-w-0', wrapperClassName)}>
            {/* 附件 chips 行 */}
            {showAttachments && attachments.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                    {attachments.map(att => (
                        <span key={att.attachmentId}
                            className="inline-flex max-w-60 items-center gap-1 rounded-md border border-border bg-popover/70 px-2 py-1 text-[11px] text-muted-foreground">
                            <Paperclip className="h-3 w-3 shrink-0"/>
                            <span className="truncate" title={att.fileName}>{att.fileName}</span>
                            <span className="shrink-0 text-[10px] text-muted-foreground/70">{formatChars(att.chars)}</span>
                            <button type="button" onClick={() => removeAttachment(att.attachmentId)}
                                title={t('common.chatInput.removeAttachment')}
                                aria-label={t('common.chatInput.removeAttachment')}
                                className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground">
                                <X className="h-3 w-3"/>
                            </button>
                        </span>
                    ))}
                </div>
            )}

            {/* 输入卡片（容器 relative：斜杠菜单锚定在其上方） */}
            <div className="relative">
            {/* 斜杠命令 / 技能菜单 */}
            {menuOpen && (
                <SlashMenu
                    groups={menuGroups}
                    activeIndex={slashActive}
                    onActiveIndexChange={setSlashActive}
                    onPick={(entry) => pickSlashCandidate(entry.name)}
                    query={slash?.query ?? ''}
                />
            )}
            <div className={cn(
                'rounded-xl border border-border bg-background/80 shadow-sm transition-all',
                'focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15',
                disabled && 'opacity-60',
            )}>
                <textarea
                    ref={setTextareaRef}
                    value={value}
                    onChange={(e) => {
                        onChange(e.target.value);
                        syncSlashTrigger(e.target);
                    }}
                    onKeyDown={handleKeyDown}
                    onKeyUp={(e) => {
                        // 光标移动（左右键/Home/End）后重算触发词
                        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) syncSlashTrigger(e.currentTarget);
                    }}
                    onClick={(e) => syncSlashTrigger(e.currentTarget)}
                    disabled={disabled}
                    placeholder={placeholder}
                    rows={compact ? 1 : rows}
                    className="w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-relaxed
                        focus:outline-none placeholder:text-muted-foreground/60"
                />
                {/* 底部工具栏：左（附件/语音/模型/权限） 右（优化/放大/actions 插槽/发送） */}
                <div className="flex items-center gap-1 px-2 pb-2 pt-0.5 flex-wrap">
                    <div className="flex items-center gap-1 min-w-0 flex-wrap">
                        {showAttachments && (
                            <AttachmentButton
                                disabled={disabled}
                                onUploaded={(att) => setAttachments(prev => [...prev, att])}
                            />
                        )}
                        {showVoice && (
                            <VoiceButton
                                disabled={disabled}
                                onText={(txt) => onChange(value ? `${value} ${txt}` : txt)}
                            />
                        )}
                        {showModelPicker && <ModelPicker/>}
                        {showPermissionPicker && <PermissionPicker/>}
                        {branchWorkspacePath && (
                            <BranchPicker
                                workspacePath={branchWorkspacePath}
                                disabled={branchDisabled || disabled}
                            />
                        )}
                    </div>
                    <div className="ml-auto flex items-center gap-1">
                        {optimizable && (
                            <button
                                type="button"
                                onClick={handleOptimize}
                                disabled={optimizing || !value.trim()}
                                title={t('common.chatInput.optimize')}
                                aria-label={t('common.chatInput.optimize')}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none"
                            >
                                {optimizing
                                    ? <Loader2 className="h-4 w-4 animate-spin"/>
                                    : <Sparkles className="h-4 w-4"/>}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setExpanded(true)}
                            title={t('common.chatInput.zoom')}
                            aria-label={t('common.chatInput.zoom')}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        >
                            <Maximize2 className="h-4 w-4"/>
                        </button>
                        {actions}
                        {/* 发送按钮 */}
                        <button
                            type="button"
                            onClick={() => void submit()}
                            disabled={!canSend}
                            title={t('common.chatInput.send')}
                            aria-label={t('common.chatInput.send')}
                            className="ml-0.5 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground
                                shadow-sm transition-all hover:bg-primary/90 disabled:opacity-40 disabled:pointer-events-none
                                active:scale-95"
                        >
                            {sending ? <Loader2 className="h-4 w-4 animate-spin"/> : <Send className="h-4 w-4"/>}
                        </button>
                    </div>
                </div>
            </div>
            </div>

            {/* 优化结果面板：展示优化后的文本，用户决定是否采纳（移植自 ExpandableTextarea） */}
            {(optimizing || optimizeResult != null || optimizeError != null) && (
                <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
                    <div className="flex items-center gap-1.5 mb-2">
                        <Sparkles className="h-3.5 w-3.5 text-primary"/>
                        <span className="text-xs font-medium">{t('common.chatInput.optimizeTitle')}</span>
                    </div>

                    {optimizing ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
                            <Loader2 className="h-3.5 w-3.5 animate-spin"/>
                            {t('common.chatInput.optimizing')}
                        </div>
                    ) : optimizeError != null ? (
                        <div className="space-y-2">
                            <p className="text-xs text-destructive">{optimizeError}</p>
                            <Button size="sm" variant="outline" onClick={handleOptimize}>
                                {t('common.chatInput.optimizeRetry')}
                            </Button>
                        </div>
                    ) : (
                        <>
                            <div className="text-sm whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto bg-background/70 rounded-md p-3 border border-border/60">
                                {optimizeResult}
                            </div>
                            <div className="flex items-center gap-2 mt-2.5">
                                <Button size="sm" onClick={adoptOptimized}>{t('common.chatInput.adopt')}</Button>
                                <Button size="sm" variant="outline" onClick={handleOptimize} disabled={optimizing}>
                                    {t('common.chatInput.regenerate')}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={discardOptimized}>{t('common.chatInput.discard')}</Button>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* 放大编辑弹窗（portal + Esc 关闭 + 自动聚焦；弹窗内 textarea 同样绑定键盘行为） */}
            {expanded && createPortal(
                <div className="fixed inset-0 z-[10000] flex items-center justify-center">
                    <div
                        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                        onClick={() => setExpanded(false)}
                    />
                    <div className="relative z-10 w-full max-w-5xl mx-4 glass-panel rounded-xl shadow-2xl flex flex-col h-[85vh]">
                        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                            <span className="text-sm font-medium">{title || t('common.chatInput.zoom')}</span>
                            <button
                                type="button"
                                onClick={() => setExpanded(false)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                                title={t('common.close')}
                                aria-label={t('common.close')}
                            >
                                <X className="h-4 w-4"/>
                            </button>
                        </div>
                        <textarea
                            ref={modalRef}
                            value={value}
                            onChange={(e) => onChange(e.target.value)}
                            onKeyDown={handleKeyDown}
                            disabled={disabled}
                            placeholder={placeholder}
                            className="flex-1 min-h-0 w-full bg-transparent resize-none focus:outline-none p-4 text-sm font-mono leading-relaxed"
                        />
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
});
ChatInputBox.displayName = 'ChatInputBox';
