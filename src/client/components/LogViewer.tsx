/**
 * @file LogViewer.tsx
 * @description 统一的日志/消息面板组件 —— 开发计划 / 代码执行 / Agent 执行三页日志流共用。
 *
 *   展示逻辑：
 *     1. 所有消息按时间顺序渲染，不做分区隔离
 *     2. 连续的 output 消息按 15 条一组折叠展示（最新组始终展开；工具栏可「展开全部输出」）
 *     3. user / assistant / error / warning 始终可见，内联渲染（assistant = 最终答复，
 *        服务端在执行终态写入，刷新后仍以「答复」形态存在）
 *     4. thinking 渲染为 Think 折叠行、tool 渲染为分类工具行（图标/摘要/可展开 IN-OUT，
 *        对齐 DeepSeek Harness 的消息流设计）；未配对的旧 tool_use / tool_result 行不展示
 *
 *   工具栏：标题 / 实时绿点 / 消息计数 / 复制全部 / 清空
 *   智能自动滚动（stick-to-bottom）：贴底跟随；向上滚暂停并浮出「回到底部」按钮；
 *   向下滚立即重新跟随（流式输出下内容增长快于手动滚动，靠“滚回底部”恢复必失败）
 *   快速跳转栏（showJumpBar）：每条用户消息一个锚点节点，点击定位、滚动联动高亮
 */

import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Copy, Check, Trash2, Terminal, ChevronDown, ChevronUp, ArrowDown} from 'lucide-react';
import {cn} from '../lib/utils';
import {LogMessage, type LogMessageData} from './LogMessage';
import {MessageJumpBar, type JumpAnchor} from './MessageJumpBar';
import {railRightFor} from '../lib/jumpbar-geometry';
import {useStickToBottom} from '../hooks/useStickToBottom';

const OUTPUT_PER_GROUP = 15;

// ── 渲染段：单条消息 ｜ 输出组 ──
type Segment =
    | { type: 'single'; message: LogMessageData; index: number }
    | { type: 'outputGroup'; messages: LogMessageData[]; start: number };

// ── Props ──
interface LogViewerProps {
    messages: LogMessageData[];
    emptyText?: string;
    onClear?: () => void;
    title?: string;
    isStreaming?: boolean;
    className?: string;
    /** 显示用户消息快速跳转栏（默认关闭） */
    showJumpBar?: boolean;
    /** 跳转栏可见的页面路径前缀：keep-alive 下隐藏页面的 Portal 内容不会随祖先隐藏，
     *  必须按路径显式限定，否则跳转栏会出现在所有页面上 */
    jumpBarPaths?: string[];
    /** 日志滚动区底部内边距（px）：输入框悬浮在日志区上方时，让最后一条消息能滚出悬浮层遮挡 */
    bottomInset?: number;
}

export function LogViewer({
                              messages,
                              emptyText = '暂无日志',
                              onClear,
                              title = '日志',
                              isStreaming = false,
                              className,
                              showJumpBar = false,
                              jumpBarPaths,
                              bottomInset = 0,
                          }: LogViewerProps) {
    const [copiedAll, setCopiedAll] = useState(false);

    // ── 智能自动滚动（stick-to-bottom）：贴底跟随；向上滚暂停并浮出「回到底部」；
    // 向下滚立即重新跟随（实现与语义见 hooks/useStickToBottom.ts）──
    const {containerRef, showResume, pinnedRef, handlers, scrollToBottom, pin} = useStickToBottom<HTMLDivElement>(80);

    /**
     * 跳转栏右缘实测：竖条贴日志面板右缘内侧，需要「视口右侧到面板右缘」的距离。
     * 用实测而不是写死：左侧菜单栏与列表都能拖拽调宽，右侧工作区面板还能开合，
     * 任何常量都会错位。ResizeObserver 跟随尺寸变化，window resize 覆盖窗口缩放。
     */
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [jumpRailRight, setJumpRailRight] = useState(12);
    useLayoutEffect(() => {
        if (!showJumpBar) return;
        const measure = () => {
            const el = rootRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            // 竖条落在面板右内边距里（日志内容已有 pr-9 = 36px 预留），不遮正文
            const next = railRightFor(window.innerWidth, rect.right);
            setJumpRailRight((prev) => (prev === next ? prev : next));
        };
        measure();
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
        if (observer && rootRef.current) observer.observe(rootRef.current);
        window.addEventListener('resize', measure);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [showJumpBar]);

    // ── 快速跳转栏：用户消息锚点 ──
    const userAnchors = useMemo<JumpAnchor[]>(() => {
        return messages
            .map((m, index) => ({m, index}))
            .filter(({m}) => m.kind === 'user')
            .map(({m, index}) => ({index, content: m.content, timestamp: m.timestamp}));
    }, [messages]);

    const [activeAnchor, setActiveAnchor] = useState<number | null>(null);
    /** 悬停跳转栏节点时对应的日志区目标消息（同步高亮预览） */
    const [hoveredAnchor, setHoveredAnchor] = useState<number | null>(null);
    /** 点击跳转后短暂闪烁的目标消息（定位确认） */
    const [flashAnchor, setFlashAnchor] = useState<number | null>(null);
    const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    /** 计算当前可视区所在段的锚点（视口中线以上最近的用户消息） */
    const updateActiveAnchor = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        const anchors = el.querySelectorAll<HTMLElement>('[data-jump-anchor]');
        if (anchors.length === 0) {
            setActiveAnchor(null);
            return;
        }
        const pivot = el.scrollTop + el.clientHeight / 2;
        let current: number | null = null;
        anchors.forEach((node) => {
            if (node.offsetTop <= pivot) {
                current = Number(node.dataset.jumpAnchor);
            }
        });
        // 视口在第一条锚点之前（会话开头）时不高亮任何节点
        setActiveAnchor(current);
    }, []);

    const handleScroll = useCallback(() => {
        handlers.onScroll();
        if (showJumpBar) updateActiveAnchor();
    }, [handlers, showJumpBar, updateActiveAnchor]);

    // 消息更新时重算高亮（无滚动的静态场景，如历史加载）
    useEffect(() => {
        if (showJumpBar) updateActiveAnchor();
    }, [messages, showJumpBar, updateActiveAnchor]);

    /** 点击跳转：平滑滚动到目标用户消息，并在到达后短暂高亮（定位确认） */
    const jumpToAnchor = useCallback((index: number) => {
        const el = containerRef.current;
        if (!el) return;
        const target = el.querySelector<HTMLElement>(`[data-jump-anchor="${index}"]`);
        target?.scrollIntoView({behavior: 'smooth', block: 'center'});
        setActiveAnchor(index);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        setFlashAnchor(index);
        flashTimerRef.current = setTimeout(() => {
            setFlashAnchor(null);
            flashTimerRef.current = null;
        }, 1600);
    }, []);

    // 新消息到达且处于跟随状态时置底（唯一的滚动触发点）
    useEffect(() => {
        if (pinnedRef.current) scrollToBottom();
    }, [messages, pinnedRef, scrollToBottom]);

    // 内容高度任意变化（流式追加 / 输出组展开折叠 / Markdown 图片加载）时贴底跟随。
    // 仅靠 messages 引用变化触发会漏掉「高度变了但数组没变」的场景，导致输出阶段中途停滚。
    // 依赖 messages.length：空态 ↔ 内容切换时子元素变化需重新 observe。
    useEffect(() => {
        const el = containerRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            if (pinnedRef.current) scrollToBottom();
        });
        for (const child of Array.from(el.children)) observer.observe(child);
        return () => observer.disconnect();
    }, [pinnedRef, scrollToBottom, messages.length]);

    useEffect(() => {
        return () => {
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        };
    }, []);

    // ── 消息分段：连续的 output 合并为输出组 ──
    // tool_use / tool_result 直接跳过 —— 工具执行结果已在执行步骤面板中体现
    const segments = useMemo<Segment[]>(() => {
        const result: Segment[] = [];
        let i = 0;
        while (i < messages.length) {
            const m = messages[i];
            // 跳过工具执行日志（已在执行步骤面板中展示）
            if (m.kind === 'tool_use' || m.kind === 'tool_result') {
                i++;
                continue;
            }
            // output 归入连续输出组
            if (m.kind === 'output') {
                const run: LogMessageData[] = [];
                while (i < messages.length && messages[i].kind === 'output') {
                    run.push(messages[i]);
                    i++;
                }
                for (let g = 0; g < run.length; g += OUTPUT_PER_GROUP) {
                    result.push({
                        type: 'outputGroup',
                        messages: run.slice(g, g + OUTPUT_PER_GROUP),
                        start: g,
                    });
                }
            } else {
                result.push({type: 'single', message: m, index: i});
                i++;
            }
        }
        return result;
    }, [messages]);

    // 输出组的展开/折叠状态（最新一组始终展开）
    const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
    /** 用户手动「全部展开」后：新组出现时保留既有展开（不再自动收起旧组） */
    const expandAllRef = useRef(false);
    const outputGroupIndices = useMemo(() => {
        const indices: number[] = [];
        segments.forEach((seg, si) => {
            if (seg.type === 'outputGroup') indices.push(si);
        });
        return indices;
    }, [segments]);

    useEffect(() => {
        if (outputGroupIndices.length === 0) return;
        const last = outputGroupIndices[outputGroupIndices.length - 1];
        setExpandedGroups((prev) => {
            // 手动全开后：只追加展开新组，历史组保持不动（流式期间不再反复折叠）
            if (expandAllRef.current) {
                if (prev.has(last)) return prev;
                const next = new Set(prev);
                next.add(last);
                return next;
            }
            // 最新组始终展开；新组出现时旧组自动收起 —— 只增不收会让流式输出期间
            // 全部组保持展开，高度失控 + 全量 Markdown 重渲染，拖垮滚动
            if (prev.size === 1 && prev.has(last)) return prev;
            return new Set([last]);
        });
    }, [outputGroupIndices]);

    const toggleGroup = (segIdx: number) => {
        setExpandedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(segIdx)) next.delete(segIdx);
            else next.add(segIdx);
            return next;
        });
    };

    /** 全部展开 / 恢复只展开最新组（工具栏按钮；切换后流式行为随 expandAllRef 走） */
    const toggleExpandAll = () => {
        expandAllRef.current = !expandAllRef.current;
        if (expandAllRef.current) {
            setExpandedGroups(new Set(outputGroupIndices));
        } else if (outputGroupIndices.length > 0) {
            setExpandedGroups(new Set([outputGroupIndices[outputGroupIndices.length - 1]]));
        }
    };

    // ── 复制全部 ──
    const handleCopyAll = async () => {
        try {
            await navigator.clipboard.writeText(messages.map((m) => m.content).join('\n\n'));
            setCopiedAll(true);
            setTimeout(() => setCopiedAll(false), 1500);
        } catch { /* 忽略 */
        }
    };

    // ── 统计 ──
    const hasContent = messages.length > 0;

    return (
        <div
            ref={rootRef}
            className={cn('relative flex flex-col overflow-hidden rounded-lg border border-border/60 glass-card', className)}
        >
            {/* ═══ 工具栏 ═══ */}
            <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 shrink-0">
                <Terminal
                    className={cn('h-3.5 w-3.5 shrink-0', isStreaming ? 'text-emerald-500' : 'text-muted-foreground')}/>
                <span
                    className={cn('text-xs font-medium', isStreaming ? 'text-emerald-500 font-mono' : 'text-foreground')}>
                    {title}
                </span>
                {isStreaming && (
                    <span className="relative flex h-2 w-2 shrink-0">
                        <span
                            className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"/>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"/>
                    </span>
                )}
                <span className="text-[10px] text-muted-foreground">{messages.length} 条</span>
                <div className="ml-auto flex items-center gap-1">
                    {outputGroupIndices.length > 0 && (
                        <button onClick={toggleExpandAll}
                                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                                title={expandAllRef.current ? '恢复只展开最新输出组' : '展开全部输出组（历史叙述可能被工具行切碎成多组）'}>
                            {expandAllRef.current
                                ? <ChevronUp className="h-3 w-3"/>
                                : <ChevronDown className="h-3 w-3"/>}
                            {expandAllRef.current ? '收起输出' : '展开全部输出'}
                        </button>
                    )}
                    <button onClick={handleCopyAll}
                            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                        {copiedAll ? <Check className="h-3 w-3 text-emerald-500"/> : <Copy className="h-3 w-3"/>}
                        {copiedAll ? '已复制' : '复制全部'}
                    </button>
                    {onClear && (
                        <button onClick={onClear}
                                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors">
                            <Trash2 className="h-3 w-3"/> 清空
                        </button>
                    )}
                </div>
            </div>

            {/* ═══ 日志内容（时间顺序；跳转栏开启时右侧预留竖条空间）═══ */}
            <div
                ref={containerRef}
                className={cn(
                    'flex-1 overflow-y-auto min-h-[120px]',
                    showJumpBar && userAnchors.length > 0 ? 'py-3 pl-3 pr-9' : 'p-3',
                )}
                style={bottomInset > 0 ? {paddingBottom: bottomInset} : undefined}
                onScroll={handleScroll}
                onWheel={handlers.onWheel}
                onTouchStart={handlers.onTouchStart}
                onTouchMove={handlers.onTouchMove}
            >
                {!hasContent ? (
                    <div className="text-muted-foreground text-center py-8 text-xs">{emptyText}</div>
                ) : (
                    <div className="space-y-1.5">
                        {segments.map((seg, si) => {
                            if (seg.type === 'single') {
                                // 用户消息包一层锚点容器，供快速跳转栏定位
                                // （key/锚点索引与原始数组下标同源，消息无业务 id）。
                                // 悬停跳转栏节点或点击跳转后，目标消息高亮预览/闪烁确认
                                const anchorIndex = seg.message.kind === 'user' ? seg.index : undefined;
                                const isAnchorHighlighted =
                                    anchorIndex !== undefined &&
                                    (hoveredAnchor === anchorIndex || flashAnchor === anchorIndex);
                                return (
                                    <div
                                        key={`msg-${seg.index}`}
                                        data-jump-anchor={anchorIndex}
                                        className={cn(
                                            'rounded-xl transition-all',
                                            isAnchorHighlighted &&
                                                'ring-2 ring-blue-500/70 ring-offset-2 ring-offset-background',
                                        )}
                                    >
                                        <LogMessage message={seg.message}/>
                                    </div>
                                );
                            }
                            // 输出组
                            const isOpen = expandedGroups.has(si);
                            const groupLabel = seg.messages.length === 1
                                ? `输出 ${seg.start + 1}`
                                : `输出 ${seg.start + 1}-${seg.start + seg.messages.length}`;
                            return (
                                <div key={`out-${si}`}>
                                    <button
                                        onClick={() => toggleGroup(si)}
                                        className={cn(
                                            'w-full py-1 px-2.5 rounded text-[10px] font-medium transition-colors flex items-center justify-between',
                                            isOpen
                                                ? 'bg-blue-500/10 border border-blue-500/20 text-blue-400'
                                                : 'bg-muted/30 border border-border/50 text-muted-foreground hover:bg-muted/50',
                                        )}
                                    >
                                        <span className="flex items-center gap-1.5">
                                            {isOpen ? <ChevronUp className="h-3 w-3"/> :
                                                <ChevronDown className="h-3 w-3"/>}
                                            {groupLabel}
                                        </span>
                                        <span className="opacity-60">{seg.messages.length} 条</span>
                                    </button>
                                    {isOpen && (
                                        <div className="space-y-2 mt-1.5">
                                            {seg.messages.map((msg, mi) => (
                                                <LogMessage key={`out-${si}-${mi}`} message={msg}/>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ═══ 回到底部悬浮按钮：脱离底部（翻阅历史）时出现，点击重新跟随 ═══ */}
            {showResume && (
                <button
                    onClick={pin}
                    className="absolute bottom-3 right-6 z-10 flex items-center gap-1.5 rounded-full border border-border/60 bg-popover/90 px-3 py-1.5 text-xs font-medium shadow-apple-lg backdrop-blur-sm transition-colors hover:bg-popover"
                >
                    <ArrowDown className="h-3.5 w-3.5"/>
                    回到底部
                </button>
            )}

            {/* ═══ 快速跳转栏：贴本面板右缘的悬浮竖条 ═══
                组件内部 Portal 到 document.body 并以 fixed 定位（垂直居中），
                不随日志滚动、也不随页面滚动移动；水平位置由 jumpRailRight 实测传入
                （左侧菜单/列表可拖拽调宽，写死左边距必然错位）。
                注意不能改为容器内 absolute/fixed：glass-card 的 backdrop-filter
                会劫持 fixed 定位基准，且页面滚动会把容器带出视口。 */}
            {showJumpBar && (
                <MessageJumpBar
                    anchors={userAnchors}
                    activeIndex={activeAnchor}
                    onJump={jumpToAnchor}
                    onHoverAnchor={setHoveredAnchor}
                    visiblePaths={jumpBarPaths}
                    railRight={jumpRailRight}
                />
            )}
        </div>
    );
}
