/**
 * @file RequirementFetchActivity.tsx
 * @description 需求 agent 拉取过程活动面板：实时渲染 agent 中介拉取/搜索的过程事件
 *              （工具调用与结果、思考/正文增量、契约重试、最终成败）。
 *              数据链路：服务端 `requirement:fetch_progress` WebSocket 消息 →
 *              useWebSocket 分发 CustomEvent `requirement:fetch-progress` →
 *              页面折叠成活动行 → 本组件展示（运行中自动滚动到底部）。
 */
import {useEffect, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import {
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Info,
    Loader2,
    Sparkles,
    Wrench,
    XCircle,
} from 'lucide-react';
import {cn} from '../lib/utils';

/** 服务端过程事件（与服务端 AgentFetchProgress 同构，附 source 来源标记） */
export interface RequirementFetchProgressEvent {
    kind: 'started' | 'tool_use' | 'tool_result' | 'thinking' | 'text'
    | 'attempt_retry' | 'parse_failed' | 'done' | 'failed';
    /** 第几次尝试（0 起） */
    attempt?: number;
    /** 工具名（tool_use） */
    toolName?: string;
    /** 工具参数摘要（tool_use） */
    toolInput?: string;
    /** 工具调用配对 ID（tool_use/tool_result 同 id 配对） */
    toolUseId?: string;
    /** 工具是否失败（tool_result） */
    isError?: boolean;
    /** 思考/正文文本增量 */
    text?: string;
    /** 人类可读说明 */
    message?: string;
    /** 事件来源 */
    source?: 'fetch' | 'search' | 'detail';
}

/** 面板行数据模型（页面把事件流折叠/配对成行） */
export interface FetchActivityItem {
    id: number;
    kind: 'info' | 'tool' | 'thought' | 'text' | 'retry' | 'error' | 'success';
    /** 主文本（工具名 / 说明消息） */
    label: string;
    /** 次要文本（工具参数 / 思考正文增量，连续同类事件会合并） */
    detail?: string;
    /** 工具行状态（running 等待结果 → ok / error） */
    status?: 'running' | 'ok' | 'error';
}

interface RequirementFetchActivityProps {
    /** 活动行（时间正序） */
    items: FetchActivityItem[];
    /** agent 是否仍在执行（头部转圈 + 空态提示） */
    running: boolean;
    /** 当前活动来源（决定标题：拉取过程 / 搜索过程） */
    mode: 'fetch' | 'search';
    /** 面板是否展开 */
    open: boolean;
    /** 展开/收起切换 */
    onToggle: () => void;
}

/** 单行渲染 */
function ActivityRow({item}: { item: FetchActivityItem }): JSX.Element {
    const {t} = useTranslation();

    // 工具行：专属扳手图标 + 参数摘要 + 状态（running 转圈 → ok ✓ / error ✗）
    if (item.kind === 'tool') {
        return (
            <div className="flex items-start gap-2 text-xs">
                <span className="mt-0.5 shrink-0" title={item.status === 'error' ? t('requirements.toolFailed') : undefined}>
                    {item.status === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary"/>}
                    {item.status === 'ok' && <CheckCircle2 className="h-3.5 w-3.5 text-green-500"/>}
                    {item.status === 'error' && <XCircle className="h-3.5 w-3.5 text-destructive"/>}
                </span>
                <div className="min-w-0 flex-1">
                    <span className="break-all font-medium text-foreground">{item.label}</span>
                    {item.detail && (
                        <pre
                            className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground/80"
                            title={item.detail}
                        >{item.detail}</pre>
                    )}
                </div>
            </div>
        );
    }

    // 思考行：斜体弱化（连续增量已合并为一行，只保留尾部内容）
    if (item.kind === 'thought') {
        return (
            <div className="flex items-start gap-2 text-[11px] italic text-muted-foreground/70">
                <Sparkles className="mt-0.5 h-3 w-3 shrink-0"/>
                <span className="break-all">{item.detail}</span>
            </div>
        );
    }

    // 正文行：弱化但非斜体（引擎最终叙述文本）
    if (item.kind === 'text') {
        return (
            <div className="flex items-start gap-2 text-[11px] text-muted-foreground/70">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50"/>
                <span className="break-all">{item.detail}</span>
            </div>
        );
    }

    // info / retry / error / success：图标 + 说明文本
    return (
        <div className={cn(
            'flex items-start gap-2 text-xs',
            item.kind === 'info' && 'text-muted-foreground',
            item.kind === 'retry' && 'text-amber-500',
            item.kind === 'error' && 'text-destructive',
            item.kind === 'success' && 'text-green-600 dark:text-green-500',
        )}>
            {item.kind === 'retry' && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0"/>}
            {item.kind === 'error' && <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0"/>}
            {item.kind === 'success' && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0"/>}
            {item.kind === 'info' && <Info className="mt-0.5 h-3.5 w-3.5 shrink-0"/>}
            <span className="break-all whitespace-pre-wrap">{item.label}</span>
        </div>
    );
}

/**
 * 需求 agent 拉取过程活动面板
 *
 * @example
 * ```tsx
 * <RequirementFetchActivity items={activity} running={activityRunning}
 *     mode="fetch" open={activityOpen} onToggle={() => setActivityOpen(o => !o)}/>
 * ```
 */
export function RequirementFetchActivity({items, running, mode, open, onToggle}: RequirementFetchActivityProps): JSX.Element {
    const {t} = useTranslation();
    const scrollRef = useRef<HTMLDivElement | null>(null);

    // 新事件到达且展开时，自动滚动到底部（始终看最新动作）
    useEffect(() => {
        if (open && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [items, open]);

    const lastKind = items.length > 0 ? items[items.length - 1].kind : undefined;
    const hasError = lastKind === 'error';

    return (
        <div className="mt-3 rounded-lg border border-border bg-muted/30">
            {/* 头部：状态图标 + 标题 + 行数 + 展开/收起 */}
            <button
                type="button"
                onClick={onToggle}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                title={open ? t('requirements.hideActivity') : t('requirements.showActivity')}
            >
                {running ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"/>
                ) : hasError ? (
                    <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive"/>
                ) : lastKind === 'success' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500"/>
                ) : (
                    <Wrench className="h-3.5 w-3.5 shrink-0"/>
                )}
                <span className="shrink-0 font-medium">
                    {mode === 'search' ? t('requirements.searchActivity') : t('requirements.fetchActivity')}
                </span>
                {running && <span className="truncate text-primary/80">{t('requirements.activityRunning')}</span>}
                {items.length > 0 && <span className="shrink-0 opacity-60">({items.length})</span>}
                <span className="flex-1"/>
                {open ? <ChevronUp className="h-3.5 w-3.5 shrink-0"/> : <ChevronDown className="h-3.5 w-3.5 shrink-0"/>}
            </button>

            {/* 过程行列表（限高滚动；空态给等待提示） */}
            {open && (
                <div
                    ref={scrollRef}
                    className="max-h-56 space-y-1.5 overflow-y-auto border-t border-border/60 px-3 py-2"
                >
                    {items.length === 0 && (
                        <p className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                            {running && <Loader2 className="h-3 w-3 animate-spin"/>}
                            {t('requirements.activityWaiting')}
                        </p>
                    )}
                    {items.map(item => <ActivityRow key={item.id} item={item}/>)}
                </div>
            )}
        </div>
    );
}
