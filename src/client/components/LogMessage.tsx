/**
 * @file LogMessage.tsx
 * @description 统一的日志/消息气泡组件 —— 开发计划 / 代码执行 / Agent 执行三页日志流共用。
 *   user / output / error / warning 渲染为类型徽标气泡（颜色编码 + 时间戳 + Markdown）；
 *   thinking 渲染为 Think 折叠行；tool 渲染为工具事件行（分类图标/摘要/状态，
 *   对齐 DeepSeek Harness 的 ToolRow 设计，见 ToolEventRow.tsx）。
 *   仅负责渲染展示，不涉及日志数据存储与流式逻辑。
 */

import {memo, useState} from 'react';
import {type LucideIcon, User, Brain, Wrench, Terminal, XCircle, AlertTriangle, Copy, Check, Layers, Clock, ChevronDown, MessageSquareQuote} from 'lucide-react';
import {cn} from '../lib/utils';
import {MarkdownContent} from './MarkdownContent';
import {ToolEventRow, type ToolEventInfo} from './ToolEventRow';

/** 统一日志消息类型 */
export type LogKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'tool_use' | 'tool_result' | 'output' | 'error' | 'warning';

/** 统一日志消息数据 */
export interface LogMessageData {
    kind: LogKind;
    content: string;
    /** ISO 时间戳（可选） */
    timestamp?: string;
    /** 关联步骤号（可选） */
    stepIndex?: number;
    /** 工具事件元数据（kind === 'tool' 时存在，渲染为工具事件行） */
    tool?: ToolEventInfo;
}

interface KindMeta {
    label: string;
    icon: LucideIcon;
    dot: string;
    badge: string;
    bubble: string;
}

const KIND_META: Record<LogKind, KindMeta> = {
    user: {
        label: 'You',
        icon: User,
        dot: 'bg-blue-500',
        badge: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
        bubble: 'bg-gradient-to-br from-blue-500/15 to-blue-600/5 border-blue-500/25',
    },
    // 最终答复：执行终态由服务端把最后一段叙述提升为显式答复行（刷新后仍可见）
    assistant: {
        label: '答复',
        icon: MessageSquareQuote,
        dot: 'bg-emerald-500',
        badge: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        bubble: 'bg-gradient-to-br from-emerald-500/15 to-emerald-600/5 border-emerald-500/25',
    },
    thinking: {
        label: '思考',
        icon: Brain,
        dot: 'bg-amber-500',
        badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        bubble: 'bg-amber-500/10 border-amber-500/25',
    },
    tool: {
        label: '工具',
        icon: Wrench,
        dot: 'bg-cyan-500',
        badge: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
        bubble: 'bg-cyan-500/10 border-cyan-500/25',
    },
    // 旧数据兼容：未配对的独立 tool_use / tool_result 行（正常路径已在 toLogMessages 合并为 'tool'）
    tool_use: {
        label: '工具',
        icon: Wrench,
        dot: 'bg-cyan-500',
        badge: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
        bubble: 'bg-cyan-500/10 border-cyan-500/25',
    },
    tool_result: {
        label: '结果',
        icon: Terminal,
        dot: 'bg-gray-400',
        badge: 'bg-gray-500/15 text-gray-600 dark:text-gray-400',
        bubble: 'bg-gray-500/10 border-gray-500/25',
    },
    output: {
        label: '输出',
        icon: Terminal,
        dot: 'bg-primary',
        badge: 'bg-primary/15 text-primary',
        bubble: 'bg-muted/40 border-border/50',
    },
    error: {
        label: '错误',
        icon: XCircle,
        dot: 'bg-red-500',
        badge: 'bg-red-500/15 text-red-600 dark:text-red-400',
        bubble: 'bg-red-500/10 border-red-500/25',
    },
    warning: {
        label: '警告',
        icon: AlertTriangle,
        dot: 'bg-orange-500',
        badge: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
        bubble: 'bg-orange-500/10 border-orange-500/25',
    },
};

interface LogMessageProps {
    message: LogMessageData;
}

/**
 * 单条日志/消息气泡（thinking / tool 分流到折叠行渲染）。
 * memo：增量解析（useParsedLogs）复用未变消息的对象身份，历史消息跳过 reconciliation ——
 * 流式长日志下这是 CPU 占用的关键闸门。
 */
export const LogMessage = memo(function LogMessage({message}: LogMessageProps) {
    // 工具事件：渲染为单行工具行（分类图标 + 摘要 + 可展开 IN/OUT）
    if (message.kind === 'tool' && message.tool) {
        return <ToolEventRow tool={message.tool}/>;
    }
    // 思考：渲染为 Think 折叠行（默认只显示首行摘要，点击展开全文）
    if (message.kind === 'thinking') {
        return <ThinkingRow text={message.content}/>;
    }
    const meta = KIND_META[message.kind] ?? KIND_META.output;
    const Icon = meta.icon;
    const isUser = message.kind === 'user';
    // 最终答复：左侧竖条强调（同 user 消息机制，绿色系），让汇总在流里一眼可辨
    const isAssistant = message.kind === 'assistant';
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(message.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // 剪贴板不可用时静默
        }
    };

    return (
        <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
            <div className={cn(
                'group relative rounded-xl border px-3.5 py-2.5 w-full shadow-sm',
                'animate-in fade-in slide-in-from-bottom-1 duration-200',
                meta.bubble
            )}>
                {/* 用户/最终答复消息左侧竖条装饰 */}
                {isUser && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-blue-500/70"/>}
                {isAssistant && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-emerald-500/70"/>}

                {/* 头部：类型徽标 + 时间戳/步骤 + 复制 */}
                <div className="flex items-center gap-2 mb-1">
                    <span className={cn('flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium', meta.badge)}>
                        <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)}/>
                        <Icon className="h-2.5 w-2.5"/>
                        {meta.label}
                    </span>
                    {message.stepIndex != null && message.stepIndex > 0 && (
                        <span className="flex items-center gap-1 text-[10px] text-muted-foreground select-none">
                            <Layers className="h-2.5 w-2.5"/>
                            Step {message.stepIndex}
                        </span>
                    )}
                    {message.timestamp && (
                        <span className="flex items-center gap-1 text-[10px] text-muted-foreground select-none">
                            <Clock className="h-2.5 w-2.5"/>
                            {new Date(message.timestamp).toLocaleTimeString()}
                        </span>
                    )}
                    <button
                        onClick={handleCopy}
                        className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent hover:text-foreground"
                        title="复制本条消息"
                    >
                        {copied ? <Check className="h-2.5 w-2.5 text-emerald-500"/> : <Copy className="h-2.5 w-2.5"/>}
                        {copied ? '已复制' : '复制'}
                    </button>
                </div>

                {/* 内容：Markdown 渲染（紧凑样式见 index.css .log-message） */}
                <div className="log-message">
                    <MarkdownContent content={message.content}/>
                </div>
            </div>
        </div>
    );
});

/**
 * Think 折叠行（对齐 DeepSeek Harness 的 ReasoningRow）：
 * 折叠时「思考 · 首行摘要」，点击展开全文（限高内滚），避免长思考接管消息流
 */
function ThinkingRow({text}: { text: string }) {
    const [expanded, setExpanded] = useState(false);
    const firstLine = text.split('\n')[0] || '';
    return (
        <div>
            <button
                type="button"
                onClick={() => setExpanded(v => !v)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 text-left transition-colors"
            >
                <Brain className="h-3.5 w-3.5 shrink-0 text-amber-500"/>
                <span className="shrink-0 text-[11px] font-semibold text-amber-600 dark:text-amber-400">思考</span>
                <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/40 shrink-0" aria-hidden/>
                <span className="flex-1 min-w-0 truncate text-[11px] text-muted-foreground">
                    {expanded ? `共 ${text.length} 字` : firstLine}
                </span>
                <ChevronDown
                    className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')}
                />
            </button>
            {expanded && (
                <div className="mx-1 mt-1 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 max-h-72 overflow-y-auto">
                    <pre className="text-[11px] font-sans whitespace-pre-wrap break-words text-foreground/80 leading-relaxed">
                        {text}
                    </pre>
                </div>
            )}
        </div>
    );
}
