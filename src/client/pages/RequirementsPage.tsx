/**
 * @file RequirementsPage.tsx
 * @description 需求管理页面组件
 *
 * 该页面用于从 ONES 项目管理平台获取、搜索和保存需求（Requirements）。
 * 支持以下核心功能：
 * 1. 通过需求 ID 直接获取并保存需求到本地存储
 * 2. 通过 MCP（Model Context Protocol）搜索 ONES 中的需求
 * 3. 查看已保存需求的详细信息（描述、验收标准、附件、关联缺陷等）
 * 4. 管理本地需求列表（选择、删除）
 *
 * 已保存的需求可在 Pipeline 运行时使用，实现需求驱动的开发流程。
 */
import {useState, useEffect, useCallback, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import {Joyride} from 'react-joyride';
import {useGuide} from '../guides/useGuide';
import {apiGet, apiPost, apiPut, apiDelete, ApiError} from '../api';
import {useAppStore} from '../stores/app-store';
import {cn} from '../lib/utils';
import {Badge} from '../components/ui/badge';
import {Button} from '../components/ui/button';
import {Input} from '../components/ui/input';
import {MarkdownContent} from '../components/MarkdownContent';
import {RequirementSourceSelector} from '../components/RequirementSourceSelector';
import {Card, CardContent} from '../components/ui/card';
import {RequirementFetchActivity} from '../components/RequirementFetchActivity';
import type {FetchActivityItem, RequirementFetchProgressEvent} from '../components/RequirementFetchActivity';
import {
    Search,
    X,
    CheckCircle2,
    AlertCircle,
    User,
    Link2,
    FileText,
    Loader2,
    Plus,
    Trash2,
    Download,
    BookOpen,
    Clock,
    Pencil,
    Save,
    Upload,
    FileUp,
    RotateCcw,
    ScanSearch,
    GitMerge,
    Copy,
    Square,
} from 'lucide-react';

/**
 * @interface Requirement
 * @description 需求基本信息接口
 * 用于列表展示和搜索结果，仅包含核心字段
 */interface Requirement {
    /** 需求唯一标识符 */
    id: string;
    /** 需求编号（如 #91086） */
    number?: string;
    /** 需求标题 */
    title: string;
    /** 需求状态（如：待处理、进行中、已完成等） */
    status: string;
    /** 需求优先级（如：高、中、低） */
    priority: string;
    /** 需求负责人 */
    assignee: string;
    /** 最后更新时间（ISO 格式） */
    updatedAt: string;
}

/**
 * @interface StoredRequirement
 * @extends Requirement
 * @description 已保存需求的完整信息接口
 * 包含从 ONES 获取并保存到本地后的所有详细信息
 */
interface StoredRequirement extends Requirement {
    /** 需求详细描述 */
    description: string;
    /** 验收标准列表 */
    acceptanceCriteria: string[];
    /** 附件列表（文件名、URL、类型） */
    attachments: { name: string; url: string; type: string }[];
    /** 关联的缺陷/问题列表 */
    relatedIssues: { id: string; title: string; status: string }[];
    /** 本地保存时间（ISO 格式） */
    savedAt: string;
    /** 需求来源标识（如 ONES 系统名） */
    source: string;
    /** 附件解析结果，按附件名索引（服务端持久化） */
    parsedAttachments?: Record<string, { markdown: string; backend: string; parsedAt: string }>;
    /** 文档工作副本（编辑 + 解析合并写入）；未设置时展示/执行均用源 description */
    workingDescription?: string;
    /** 工作副本最后写入时间（ISO 格式） */
    workingUpdatedAt?: string;
}

/**
 * @function RequirementsPage
 * @description 需求管理页面主组件
 *
 * 页面布局采用左右分栏结构：
 * - 左侧：已保存需求列表，支持选择和删除操作
 * - 右侧：选中需求的详细信息展示
 * - 顶部：需求获取（按 ID）和搜索功能区域
 *
 * @returns {JSX.Element} 需求管理页面的 React 组件
 */
export default function RequirementsPage(): JSX.Element {
    const {t} = useTranslation();
    const {run: guideRun, steps: guideSteps, handleJoyrideEvent} = useGuide('requirements');
    const [saved, setSaved] = useState<StoredRequirement[]>([]);
    const [selected, setSelected] = useState<StoredRequirement | null>(null);
    const [loadingSaved, setLoadingSaved] = useState(false);

    const [fetchId, setFetchId] = useState('');
    const [fetching, setFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [parseDocuments, setParseDocuments] = useState(false);

    /** 选中的需求源（MCP server 名），空 = 后端默认源 */
    const [selectedSource, setSelectedSource] = useState('');

    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<Requirement[]>([]);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [showSearch, setShowSearch] = useState(false);

    /** agent 拉取/搜索过程活动行（WS requirement:fetch_progress → CustomEvent 驱动） */
    const [activity, setActivity] = useState<FetchActivityItem[]>([]);
    const [activityRunning, setActivityRunning] = useState(false);
    const [activityOpen, setActivityOpen] = useState(false);
    /** 当前活动来源（决定面板标题与挂载位置） */
    const [activityMode, setActivityMode] = useState<'fetch' | 'search'>('fetch');
    /** 活动行自增 id */
    const activitySeq = useRef(0);
    /** 事件流真身（ref 镜像：工具配对等可变操作在 updater 外完成，setState 只做替换） */
    const activityRef = useRef<FetchActivityItem[]>([]);
    /** toolUseId → 活动行 id（tool_result 回填状态用） */
    const toolItemIds = useRef(new Map<string, number>());

    const [editing, setEditing] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [saving, setSaving] = useState(false);

    const [showCreate, setShowCreate] = useState(false);
    const [createNumber, setCreateNumber] = useState('');
    const [createTitle, setCreateTitle] = useState('');
    const [createDesc, setCreateDesc] = useState('');
    const [createFiles, setCreateFiles] = useState<File[]>([]);
    const [creating, setCreating] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [duplicate, setDuplicate] = useState<{ number: string; existingTitle: string } | null>(null);

    // 编辑模式文件上传
    const [editFiles, setEditFiles] = useState<File[]>([]);
    const [editParsing, setEditParsing] = useState(false);
    const editFileInputRef = useRef<HTMLInputElement>(null);

    /** 从全局状态获取设置选中需求的方法 */
    const setSelectedRequirement = useAppStore((s) => s.setSelectedRequirement);

    // ── 附件解析闭环（与 dsh-adw 插件同语义） ─────────────────────────────
    /** 瞬态解析态（loading/error），按附件名索引；done 态读服务端 selected.parsedAttachments */
    const [attTransient, setAttTransient] = useState<Record<string, { status: 'loading' } | { status: 'error'; error: string }>>({});
    /** 批量解析进度（顺序执行，可取消） */
    const [attProgress, setAttProgress] = useState<{ done: number; total: number; current: string } | null>(null);
    const attCancelRef = useRef(false);
    const [copiedAtt, setCopiedAtt] = useState('');

    const applyUpdated = useCallback((updated: StoredRequirement) => {
        setSelected(updated);
        setSelectedRequirement(updated);
        setSaved(prev => prev.map(r => r.id === updated.id ? updated : r));
    }, [setSelectedRequirement]);

    /** 解析一份附件：服务端解析 + 落盘，然后刷新需求 */
    const parseOne = useCallback(async (id: string, name: string): Promise<boolean> => {
        setAttTransient(prev => ({ ...prev, [name]: { status: 'loading' } }));
        try {
            const r = await apiPost<{ success: boolean; markdown?: string; error?: string; requirement?: StoredRequirement }>(
                `/requirements/saved/${id}/attachments/parse`, { name });
            if (!r.success) throw new Error(r.error ?? 'parse failed');
            if (r.requirement) applyUpdated(r.requirement);
            setAttTransient(prev => { const next = { ...prev }; delete next[name]; return next; });
            return true;
        } catch (err) {
            setAttTransient(prev => ({ ...prev, [name]: { status: 'error', error: err instanceof Error ? err.message : String(err) } }));
            return false;
        }
    }, [applyUpdated]);

    /** 批量解析全部「未解析」附件（顺序，可取消） */
    const parseAll = useCallback(async () => {
        if (!selected || attProgress) return;
        const pending = selected.attachments.filter(a => selected.parsedAttachments?.[a.name] === undefined);
        if (pending.length === 0) return;
        attCancelRef.current = false;
        for (let i = 0; i < pending.length; i++) {
            if (attCancelRef.current) break;
            setAttProgress({ done: i, total: pending.length, current: pending[i].name });
            await parseOne(selected.id, pending[i].name);
        }
        setAttProgress(null);
    }, [selected, attProgress, parseOne]);

    /** 合并全部解析结果进文档工作副本（幂等） */
    const mergeParses = useCallback(async () => {
        if (!selected) return;
        try {
            const updated = await apiPost<StoredRequirement>(`/requirements/saved/${selected.id}/merge`, {});
            applyUpdated(updated);
        } catch { /* 400 = 没有可合并项 */ }
    }, [selected, applyUpdated]);

    /** 还原文档工作副本（回到源描述） */
    const revertWorking = useCallback(async () => {
        if (!selected) return;
        try {
            const updated = await apiDelete<StoredRequirement>(`/requirements/saved/${selected.id}/working-description`);
            applyUpdated(updated);
        } catch { /* ignore */ }
    }, [selected, applyUpdated]);

    /** 复制一份解析结果的 Markdown 源码（保表格结构） */
    const copyAttMarkdown = useCallback((name: string, markdown: string) => {
        void navigator.clipboard?.writeText(markdown).then(() => {
            setCopiedAtt(name);
            setTimeout(() => setCopiedAtt(''), 1500);
        });
    }, []);

    /** 删除一份附件（移出列表 + 清解析 + 剥工作副本标记块） */
    const removeAttachment = useCallback(async (name: string) => {
        if (!selected) return;
        try {
            const updated = await apiDelete<StoredRequirement>(
                `/requirements/saved/${selected.id}/attachments/${encodeURIComponent(name)}`);
            applyUpdated(updated);
        } catch { /* ignore */ }
    }, [selected, applyUpdated]);

    /**
     * 加载已保存的需求列表
     * 从后端 API 获取所有已保存的需求数据
     */
    const loadSaved = useCallback(async () => {
        setLoadingSaved(true);
        try {
            const data = await apiGet<StoredRequirement[]>('/requirements/saved');
            setSaved(data);
        } catch {
            // 静默处理加载失败，保持现有数据不变
        } finally {
            setLoadingSaved(false);
        }
    }, []);

    /** 手动创建需求（描述已包含预解析的 Markdown）。mode: undefined/overwrite/merge */
    const handleCreate = useCallback(async (mode?: 'overwrite' | 'merge') => {
        if (!createTitle.trim() || !createNumber.trim() || creating) return;
        setCreating(true);
        setFetchError(null);
        try {
            const saved = await apiPost<StoredRequirement>('/requirements/create', {
                number: createNumber.trim(),
                title: createTitle.trim(),
                description: createDesc.trim(),
                mode,
            });

            await loadSaved();
            setSelected(saved);
            setSelectedRequirement(saved);
            setShowCreate(false);
            setCreateNumber('');
            setCreateTitle('');
            setCreateDesc('');
            setCreateFiles([]);
            setDuplicate(null);
        } catch (err) {
            // 409 重复 → 弹窗让用户选
            if (err instanceof ApiError && err.status === 409 && err.body.code === 'DUPLICATE_NUMBER') {
                setDuplicate({
                    number: createNumber.trim(),
                    existingTitle: (err.body.existingTitle as string) ?? '',
                });
            } else if (err instanceof ApiError) {
                setFetchError((err.body.message as string) || 'Create failed');
            } else {
                setFetchError(err instanceof Error ? err.message : 'Create failed');
            }
        } finally {
            setCreating(false);
        }
    }, [createNumber, createTitle, createDesc, creating, loadSaved, setSelectedRequirement]);

    /** 解析已选文件，将 MinerU 结果追加到描述 */
    const handleParseFiles = useCallback(async () => {
        if (!createFiles.length) return;
        setCreating(true);
        try {
            let combined = '';
            for (const file of createFiles) {
                const formData = new FormData();
                formData.append('files', file);
                const res = await fetch('/api/mineru/parse', {method: 'POST', body: formData});
                if (!res.ok) continue;
                const data = await res.json() as { results?: { markdown?: string }[] };
                const md = data.results?.[0]?.markdown;
                if (md) {
                    combined += `\n\n---\n\n## ${file.name}\n\n${md}`;
                }
            }
            if (combined) {
                setCreateDesc(prev => prev + combined);
            }
            setCreateFiles([]);
        } catch (err) {
            setFetchError(err instanceof Error ? err.message : 'Parse failed');
        } finally {
            setCreating(false);
        }
    }, [createFiles]);

    /** 编辑模式：解析文件并追加到描述 */
    const handleEditParseFiles = useCallback(async () => {
        if (!editFiles.length) return;
        setEditParsing(true);
        try {
            let combined = '';
            for (const file of editFiles) {
                const formData = new FormData();
                formData.append('files', file);
                const res = await fetch('/api/mineru/parse', {method: 'POST', body: formData});
                if (!res.ok) continue;
                const data = await res.json() as { results?: { markdown?: string }[] };
                const md = data.results?.[0]?.markdown;
                if (md) {
                    combined += `\n\n---\n\n## ${file.name}\n\n${md}`;
                }
            }
            if (combined) {
                setEditDescription(prev => prev + combined);
            }
            setEditFiles([]);
        } catch { /* silent */
        } finally {
            setEditParsing(false);
        }
    }, [editFiles]);

    // 组件挂载时自动加载已保存的需求列表
    useEffect(() => {
        loadSaved();
    }, [loadSaved]);

    /** 恢复上次选择的需求源（目录加载由 RequirementSourceSelector 自管） */
    useEffect(() => {
        const stored = localStorage.getItem('requirement-source-server');
        if (stored) setSelectedSource(stored);
    }, []);

    /** 切换需求源并持久化 */
    const handleSourceChange = (name: string) => {
        setSelectedSource(name);
        if (name) {
            localStorage.setItem('requirement-source-server', name);
        } else {
            localStorage.removeItem('requirement-source-server');
        }
    };

    /** 开始一轮新的 agent 活动：清空过程行、打开面板并标记运行中 */
    const startActivity = (mode: 'fetch' | 'search') => {
        activityRef.current = [];
        toolItemIds.current.clear();
        setActivity([]);
        setActivityMode(mode);
        setActivityRunning(true);
        setActivityOpen(true);
    };

    /** 结束活动（成功/失败都停掉头部转圈） */
    const finishActivity = () => setActivityRunning(false);

    /**
     * 把过程事件折叠进活动行：工具行按 toolUseId 配对状态（running → ok/error），
     * 思考/正文连续增量合并进同一行（只保留尾部 1500 字），上限 400 行。
     */
    const applyActivityEvent = useCallback((ev: RequirementFetchProgressEvent) => {
        const rows = activityRef.current;
        const push = (item: Omit<FetchActivityItem, 'id'>) => {
            rows.push({...item, id: ++activitySeq.current});
        };
        const coalesce = (kind: FetchActivityItem['kind'], text: string) => {
            const last = rows[rows.length - 1];
            if (last && last.kind === kind) {
                last.detail = `${last.detail ?? ''}${text}`.slice(-1500);
            } else {
                push({kind, label: '', detail: text});
            }
        };
        switch (ev.kind) {
            case 'started':
                push({kind: 'info', label: ev.message || ''});
                break;
            case 'tool_use': {
                const item: FetchActivityItem = {
                    id: ++activitySeq.current,
                    kind: 'tool',
                    label: ev.toolName || '(unknown)',
                    detail: ev.toolInput || '',
                    status: 'running',
                };
                rows.push(item);
                if (ev.toolUseId) toolItemIds.current.set(ev.toolUseId, item.id);
                break;
            }
            case 'tool_result': {
                const itemId = ev.toolUseId ? toolItemIds.current.get(ev.toolUseId) : undefined;
                const row = itemId !== undefined ? rows.find(r => r.id === itemId) : undefined;
                if (row) row.status = ev.isError ? 'error' : 'ok';
                break;
            }
            case 'thinking':
                if (ev.text) coalesce('thought', ev.text);
                break;
            case 'text':
                if (ev.text) coalesce('text', ev.text);
                break;
            case 'attempt_retry':
            case 'parse_failed':
                push({kind: 'retry', label: ev.message || ''});
                break;
            case 'done':
            case 'failed':
                // 收尾：不再有结果的工具行停止转圈
                for (const row of rows) {
                    if (row.kind === 'tool' && row.status === 'running') row.status = 'ok';
                }
                push(ev.kind === 'done'
                    ? {kind: 'success', label: ev.message || ''}
                    : {kind: 'error', label: ev.message || ''});
                break;
        }
        if (rows.length > 400) activityRef.current = rows.slice(rows.length - 400);
        setActivity([...activityRef.current]);
    }, []);

    // 监听后端图片下载完成事件，刷新需求描述（图片 URL 从远程变为本地路径）
    useEffect(() => {
        const handler = (e: Event) => {
            const updated = (e as CustomEvent).detail;
            if (!updated) return;
            // 更新列表
            setSaved(prev => prev.map(r => r.id === updated.id ? updated : r));
            // 更新当前选中
            setSelected(prev => prev?.id === updated.id ? updated : prev);
            setSelectedRequirement(updated.id === selected?.id ? updated : null);
        };
        window.addEventListener('requirement:updated', handler);
        return () => window.removeEventListener('requirement:updated', handler);
    }, [selected?.id]);

    // 监听 agent 拉取过程事件（requirement:fetch_progress → requirement:fetch-progress）
    useEffect(() => {
        const handler = (e: Event) => {
            const ev = (e as CustomEvent<RequirementFetchProgressEvent>).detail;
            if (ev) applyActivityEvent(ev);
        };
        window.addEventListener('requirement:fetch-progress', handler);
        return () => window.removeEventListener('requirement:fetch-progress', handler);
    }, [applyActivityEvent]);

    /**
     * 通过 ID 从 MCP 获取需求并保存到本地
     * 获取成功后自动更新列表、选中该需求并同步到全局状态
     */
    const handleFetch = async () => {
        if (!fetchId.trim()) return;
        setFetching(true);
        setFetchError(null);
        startActivity('fetch');
        try {
            const req = await apiPost<StoredRequirement>('/requirements/fetch', {
                id: fetchId.trim(),
                parseDocuments,
                ...(selectedSource ? {mcpServerName: selectedSource} : {}),
            });
            // 去重后插入到列表头部（最新的排在前面）
            setSaved(prev => {
                const filtered = prev.filter(r => r.id !== req.id);
                return [req, ...filtered];
            });
            setSelected(req);
            setSelectedRequirement(req);
            setFetchId('');
        } catch (err) {
            setFetchError(err instanceof Error ? err.message : 'Failed to fetch requirement');
        } finally {
            setFetching(false);
            finishActivity();
        }
    };

    /**
     * 通过 MCP 搜索需求
     * 注意：搜索结果不会自动保存，用户需要手动点击保存按钮
     */
    const handleSearch = async () => {
        if (!searchQuery.trim()) return;
        setSearching(true);
        setSearchError(null);
        startActivity('search');
        try {
            const results = await apiGet<Requirement[]>(
                `/requirements/search?q=${encodeURIComponent(searchQuery)}` +
                (selectedSource ? `&server=${encodeURIComponent(selectedSource)}` : '')
            );
            setSearchResults(results);
        } catch (err) {
            setSearchError(err instanceof Error ? err.message : 'Search failed');
        } finally {
            setSearching(false);
            finishActivity();
        }
    };

    /**
     * 将搜索结果中的某个需求保存到本地存储
     * 调用与按 ID 获取相同的接口，确保获取完整信息
     */
    const handleSaveFromSearch = async (req: Requirement) => {
        startActivity('fetch');
        try {
            const saved = await apiPost<StoredRequirement>('/requirements/fetch', {
                id: req.id,
                parseDocuments,
                ...(selectedSource ? {mcpServerName: selectedSource} : {}),
            });
            setSaved(prev => {
                const filtered = prev.filter(r => r.id !== saved.id);
                return [saved, ...filtered];
            });
            setSelected(saved);
            setSelectedRequirement(saved);
        } catch (err) {
            setFetchError(err instanceof Error ? err.message : 'Failed to save requirement');
        } finally {
            finishActivity();
        }
    };

    /**
     * 删除已保存的需求
     * 如果删除的是当前选中的需求，同时清空选中状态和全局状态
     */
    const handleDelete = async (id: string) => {
        try {
            await apiDelete(`/requirements/saved/${id}`);
            setSaved(prev => prev.filter(r => r.id !== id));
            if (selected?.id === id) {
                setSelected(null);
                setSelectedRequirement(null);
            }
        } catch {
            // 静默处理删除失败
        }
    };

    /**
     * 选中一个已保存的需求
     * 同时更新本地状态和全局状态（供 Pipeline 使用）
     */
    const handleSelect = (req: StoredRequirement) => {
        setSelected(req);
        setSelectedRequirement(req);
        setEditing(false);
    };

    /**
     * 进入编辑模式
     * 用当前选中需求的数据初始化编辑表单（工作副本优先）
     */
    const startEdit = () => {
        if (!selected) return;
        setEditTitle(selected.title);
        setEditDescription(selected.workingDescription ?? selected.description);
        setEditing(true);
    };

    /**
     * 取消编辑，恢复原始数据
     */
    const cancelEdit = () => {
        setEditing(false);
    };

    /**
     * 保存编辑后的需求
     * 标题走 PUT；描述保存为工作副本（POST working-description）——源描述不动，
     * 展示与执行 prompt 优先用工作副本
     */
    const saveEdit = async () => {
        if (!selected) return;
        setSaving(true);
        try {
            if (editTitle.trim() !== selected.title) {
                const retitled = await apiPut<StoredRequirement>(`/requirements/saved/${selected.id}`, {title: editTitle});
                applyUpdated(retitled);
            }
            const updated = await apiPost<StoredRequirement>(`/requirements/saved/${selected.id}/working-description`, {
                description: editDescription,
            });
            applyUpdated(updated);
            setEditing(false); // 退出编辑模式，用户可以重新进入查看新值
        } catch {
            // 静默处理保存失败
        } finally {
            setSaving(false);
        }
    };

    /**
     * 根据优先级返回对应的样式类名
     * 用于 Badge 组件的颜色区分
     */
    const priorityColor = (p: string) => {
        switch (p.toLowerCase()) {
            case 'high':
                return 'text-red-500 bg-red-500/10';
            case 'medium':
                return 'text-yellow-500 bg-yellow-500/10';
            case 'low':
                return 'text-green-500 bg-green-500/10';
            default:
                return 'text-muted-foreground bg-muted';
        }
    };

    /**
     * 根据状态返回对应的样式类名
     * 用于 Badge 组件的颜色区分
     */
    const statusColor = (s: string) => {
        switch (s.toLowerCase()) {
            case 'done':
            case 'completed':
                return 'text-green-500 bg-green-500/10';
            case 'in_progress':
            case 'in progress':
                return 'text-blue-500 bg-blue-500/10';
            default:
                return 'text-muted-foreground bg-muted';
        }
    };

    return (
        <div className="flex h-full flex-col">
            {/* === 顶部区域：页面标题、需求获取和搜索 === */}
            <div className="border-b border-border px-6 py-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-xl font-semibold brand-gradient-text">{t('pageTitle.requirements')}</h1>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                            {t('requirements.subtitle')}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                                setShowCreate(!showCreate);
                                setShowSearch(false);
                            }}
                        >
                            <Plus className="h-4 w-4 mr-1.5"/>
                            {t('requirements.manualCreate')}
                        </Button>
                        {/* 切换 MCP 搜索面板的按钮 */}
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setShowSearch(!showSearch)}
                            data-tour="req-search-btn"
                        >
                            <Search className="h-4 w-4 mr-1.5"/>
                            {t('requirements.searchMcp')}
                        </Button>
                    </div>
                </div>

                {/* 通过 ID 获取需求的输入区域（源选择 + 输入 + 按钮） */}
                <div className="mt-4 flex gap-2" data-tour="req-fetch-input">
                    {/* 需求源选择器：适配器目录驱动，未配置的源可直接一键安装 */}
                    <RequirementSourceSelector
                        value={selectedSource}
                        onChange={handleSourceChange}
                        className="rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring max-w-[240px]"
                    />
                    <div className="relative flex-1">
                        <BookOpen className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"/>
                        <Input
                            value={fetchId}
                            onChange={(e) => setFetchId(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleFetch()}
                            placeholder={t('requirements.fetchPlaceholder')}
                            className="pl-9"
                        />
                    </div>
                    {/* 获取并保存按钮，输入为空时禁用 */}
                    <Button onClick={handleFetch} disabled={fetching || !fetchId.trim()}>
                        {fetching ? <Loader2 className="h-4 w-4 animate-spin"/> :
                            <Download className="h-4 w-4 mr-1.5"/>}
                        {fetching ? t('requirements.fetching') : t('requirements.fetch')}
                    </Button>
                </div>

                {/* 文档解析开关 */}
                <label className="flex items-center gap-2 text-xs text-muted-foreground mt-2 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={parseDocuments}
                        onChange={(e) => setParseDocuments(e.target.checked)}
                        className="rounded border-input"
                    />
                    {t('requirements.parseDocuments')}
                </label>

                {/* agent 拉取过程活动面板（工具调用/思考/重试实时展示） */}
                <RequirementFetchActivity
                    items={activity}
                    running={activityRunning}
                    mode={activityMode}
                    open={activityOpen && activityMode === 'fetch'}
                    onToggle={() => setActivityOpen(!activityOpen)}
                />

                {/* 获取失败的错误提示（多行详情：原因 + 输出首尾摘录，等宽字体保留排版） */}
                {fetchError && (
                    <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                        <div className="flex items-center gap-2 font-medium">
                            <AlertCircle className="h-4 w-4 shrink-0"/>
                            {t('requirements.fetchFailedTitle')}
                        </div>
                        <pre
                            className="mt-1 break-all whitespace-pre-wrap pl-6 font-mono text-xs leading-relaxed text-destructive/90"
                        >{fetchError}</pre>
                    </div>
                )}

                {/* 手动创建需求表单 */}
                {showCreate && (
                    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                        <h3 className="text-sm font-semibold">{t('requirements.createTitle')}</h3>

                        {/* 需求号 */}
                        <div>
                            <label
                                className="text-xs text-muted-foreground">{t('requirements.createNumberLabel')}</label>
                            <Input
                                value={createNumber}
                                onChange={(e) => setCreateNumber(e.target.value)}
                                placeholder={t('requirements.createNumberPlaceholder')}
                                className="mt-1"
                            />
                        </div>

                        {/* 标题 */}
                        <div>
                            <label
                                className="text-xs text-muted-foreground">{t('requirements.createTitleLabel')}</label>
                            <Input
                                value={createTitle}
                                onChange={(e) => setCreateTitle(e.target.value)}
                                placeholder={t('requirements.createTitlePlaceholder')}
                                className="mt-1"
                            />
                        </div>

                        {/* 描述 */}
                        <div>
                            <label className="text-xs text-muted-foreground">{t('requirements.createDescLabel')}</label>
                            <textarea
                                value={createDesc}
                                onChange={(e) => setCreateDesc(e.target.value)}
                                placeholder={t('requirements.createDescPlaceholder')}
                                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-y min-h-[80px]"
                                rows={3}
                            />
                        </div>

                        {/* 文件上传 */}
                        <div>
                            <label className="text-xs text-muted-foreground">{t('requirements.uploadFiles')}</label>
                            <p className="text-xs text-muted-foreground/70 mb-1">{t('requirements.uploadHint')}</p>
                            <div className="flex items-center gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <FileUp className="h-4 w-4 mr-1.5"/>
                                    {t('requirements.uploadFiles')}
                                </Button>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    multiple
                                    accept=".pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg"
                                    className="hidden"
                                    onChange={(e) => {
                                        const newFiles = Array.from(e.target.files ?? []);
                                        setCreateFiles(prev => [...prev, ...newFiles]);
                                        e.target.value = '';
                                    }}
                                />
                            </div>
                            {/* 已选文件列表 */}
                            {createFiles.length > 0 && (
                                <div className="mt-2 space-y-1">
                                    {createFiles.map((f, i) => (
                                        <div key={i}
                                             className="flex items-center gap-2 text-xs text-muted-foreground bg-background rounded px-2 py-1">
                                            <FileText className="h-3.5 w-3.5 shrink-0"/>
                                            <span className="truncate flex-1">{f.name}</span>
                                            <button
                                                onClick={() => setCreateFiles(prev => prev.filter((_, idx) => idx !== i))}
                                                className="text-destructive hover:text-destructive/80">
                                                <X className="h-3.5 w-3.5"/>
                                            </button>
                                        </div>
                                    ))}
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="mt-1"
                                        disabled={creating}
                                        onClick={handleParseFiles}
                                    >
                                        {creating ? <Loader2 className="h-4 w-4 animate-spin mr-1.5"/> :
                                            <Upload className="h-4 w-4 mr-1.5"/>}
                                        {creating ? t('requirements.creating') : t('requirements.parseWithMinerU')}
                                    </Button>
                                </div>
                            )}
                        </div>

                        {/* 操作按钮 */}
                        <div className="flex items-center gap-2 pt-1">
                            <Button
                                size="sm"
                                onClick={() => handleCreate()}
                                disabled={creating || !createTitle.trim() || !createNumber.trim()}
                            >
                                {creating ? <Loader2 className="h-4 w-4 animate-spin mr-1.5"/> :
                                    <Plus className="h-4 w-4 mr-1.5"/>}
                                {creating ? t('requirements.creating') : t('requirements.create')}
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    setShowCreate(false);
                                    setCreateNumber('');
                                    setCreateTitle('');
                                    setCreateDesc('');
                                    setCreateFiles([]);
                                }}
                            >
                                {t('requirements.cancelCreate')}
                            </Button>
                        </div>
                    </div>
                )}

                {/* 重复需求处理弹窗 */}
                {duplicate && (
                    <div className="mt-3 rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-4 space-y-3">
                        <div className="flex items-center gap-2 text-sm">
                            <AlertCircle className="h-4 w-4 text-yellow-500"/>
                            <span className="font-medium">需求号 {duplicate.number} 已存在</span>
                        </div>
                        <p className="text-xs text-muted-foreground">已存在标题：{duplicate.existingTitle || '(无)'}</p>
                        <div className="flex items-center gap-2">
                            <Button size="sm" onClick={() => handleCreate('overwrite')}>
                                {creating ? <Loader2 className="h-4 w-4 animate-spin mr-1.5"/> : null}
                                覆盖
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => handleCreate('merge')}>
                                合并描述
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setDuplicate(null)}>
                                取消
                            </Button>
                        </div>
                    </div>
                )}

                {/* MCP 搜索面板（可折叠） */}
                {showSearch && (
                    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
                        <div className="flex gap-2">
                            <Input
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                placeholder={t('requirements.searchPlaceholder')}
                                className="flex-1"
                            />
                            <Button onClick={handleSearch} disabled={searching} size="sm">
                                {searching ? <Loader2 className="h-4 w-4 animate-spin"/> :
                                    <Search className="h-4 w-4"/>}
                            </Button>
                            {/* 关闭搜索面板按钮，同时清空搜索结果 */}
                            <Button variant="ghost" size="sm" onClick={() => {
                                setShowSearch(false);
                                setSearchResults([]);
                            }}>
                                <X className="h-4 w-4"/>
                            </Button>
                        </div>
                        {/* agent 搜索过程活动面板 */}
                        <RequirementFetchActivity
                            items={activity}
                            running={activityRunning}
                            mode={activityMode}
                            open={activityOpen && activityMode === 'search'}
                            onToggle={() => setActivityOpen(!activityOpen)}
                        />

                        {/* 搜索失败的错误提示（多行详情） */}
                        {searchError && (
                            <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                                <div className="flex items-center gap-2 font-medium">
                                    <AlertCircle className="h-4 w-4 shrink-0"/>
                                    {t('requirements.searchFailedTitle')}
                                </div>
                                <pre
                                    className="mt-1 break-all whitespace-pre-wrap pl-6 font-mono text-xs leading-relaxed text-destructive/90"
                                >{searchError}</pre>
                            </div>
                        )}
                        {/* 搜索结果列表，每个结果可单独保存 */}
                        {searchResults.length > 0 && (
                            <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                                {searchResults.map(r => (
                                    <div key={r.id}
                                         className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent text-sm">
                                        <span
                                            className="flex-1 truncate">{r.number ? `${r.number} ` : ''}{r.title}</span>
                                        <span
                                            className={cn('text-xs px-1.5 py-0.5 rounded', statusColor(r.status))}>{r.status}</span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 px-2 text-xs"
                                            onClick={() => handleSaveFromSearch(r)}
                                        >
                                            <Plus className="h-3 w-3 mr-1"/>
                                            {t('common.save')}
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* === 主内容区域：左右分栏布局 === */}
            <div className="flex flex-1 min-h-0">
                {/* 左侧：已保存需求列表 */}
                <div className="w-80 flex flex-col border-r border-border" data-tour="req-saved-list">
                    <div className="px-4 py-2 border-b border-border bg-muted/20">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            {t('requirements.savedLabel', {count: saved.length})}
                        </p>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {/* 加载中的旋转指示器 */}
                        {loadingSaved && (
                            <div className="flex justify-center py-8">
                                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground"/>
                            </div>
                        )}
                        {/* 空状态提示 */}
                        {!loadingSaved && saved.length === 0 && (
                            <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-2">
                                <FileText className="h-8 w-8 text-muted-foreground/30"/>
                                <p className="text-sm text-muted-foreground">{t('requirements.emptyTitle')}</p>
                                <p className="text-xs text-muted-foreground/60">
                                    {t('requirements.emptySubtitle')}
                                </p>
                            </div>
                        )}
                        {/* 需求列表项，选中项高亮显示 */}
                        {saved.map(req => (
                            <div
                                key={req.id}
                                onClick={() => handleSelect(req)}
                                className={cn(
                                    'flex items-start gap-3 px-4 py-3 border-b border-border/50 cursor-pointer transition-colors group',
                                    selected?.id === req.id
                                        ? 'bg-primary/5 border-l-2 border-l-primary'
                                        : 'hover:bg-accent/50'
                                )}
                            >
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate">{req.number ? `${req.number} ` : ''}{req.title}</p>
                                    <div className="mt-1 flex items-center gap-2">
                    <span className={cn('text-xs px-1.5 py-0.5 rounded', statusColor(req.status))}>
                      {req.status}
                    </span>
                                        <span
                                            className={cn('text-xs px-1.5 py-0.5 rounded', priorityColor(req.priority))}>
                      {req.priority}
                    </span>
                                    </div>
                                    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground/60">
                                        <Clock className="h-3 w-3"/>
                                        {new Date(req.savedAt).toLocaleDateString()}
                                    </div>
                                </div>
                                {/* 删除按钮：鼠标悬停时显示，阻止冒泡避免触发选中 */}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleDelete(req.id);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-all"
                                >
                                    <Trash2 className="h-3.5 w-3.5"/>
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                {/* 右侧：需求详情面板 */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    {selected ? (
                        <>
                            {/* 固定头部：标题、编辑按钮、元信息 */}
                            <div className="flex-shrink-0 border-b border-border glass px-6 py-4 space-y-3">
                                {/* 标题栏 */}
                                <div className="flex items-start justify-between gap-4">
                                    {editing ? (
                                        <Input
                                            value={editTitle}
                                            onChange={(e) => setEditTitle(e.target.value)}
                                            className="text-lg font-semibold border-primary/50 focus:border-primary"
                                            placeholder={t('requirements.titlePlaceholder')}
                                        />
                                    ) : (
                                        <h2 className="text-lg font-semibold leading-tight text-foreground">
                                            {selected.number ? <span className="text-muted-foreground">{selected.number} </span> : ''}
                                            {selected.title}
                                        </h2>
                                    )}
                                    <div className="flex items-center gap-1">
                                        {!editing && selected.workingDescription !== undefined && (
                                            <span className="text-xs px-2 py-0.5 rounded-full border border-amber-500/40 text-amber-600 dark:text-amber-400">
                                                {t('requirements.editedBadge')}
                                            </span>
                                        )}
                                        {!editing && selected.workingDescription !== undefined && (
                                            <Button
                                                onClick={revertWorking}
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 rounded-lg hover:bg-amber-500/10 hover:text-amber-600 transition-colors"
                                                title={t('requirements.revertWorking')}
                                            >
                                                <RotateCcw className="h-4 w-4"/>
                                            </Button>
                                        )}
                                        {!editing && (
                                            <Button
                                                onClick={startEdit}
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors"
                                                title={t('common.edit')}
                                            >
                                                <Pencil className="h-4 w-4"/>
                                            </Button>
                                        )}
                                        <Button
                                            onClick={() => setSelected(null)}
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors"
                                        >
                                            <X className="h-4 w-4"/>
                                        </Button>
                                    </div>
                                </div>

                                {/* 编辑模式：保存/取消按钮 */}
                                {editing && (
                                    <div className="flex items-center gap-2">
                                        <Button size="sm" onClick={saveEdit} disabled={saving} className="gap-1.5">
                                            {saving ? <Loader2 className="h-4 w-4 animate-spin"/> :
                                                <Save className="h-4 w-4"/>}
                                            {saving ? t('requirements.saving') : t('common.save')}
                                        </Button>
                                        <Button size="sm" variant="outline" onClick={cancelEdit} disabled={saving}>
                                            {t('common.cancel')}
                                        </Button>
                                    </div>
                                )}

                                {/* 元信息标签 */}
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className={cn('text-xs px-2.5 py-1 rounded-full font-medium border', statusColor(selected.status))}>
                                        {selected.status}
                                    </span>
                                    <span className={cn('text-xs px-2.5 py-1 rounded-full font-medium border', priorityColor(selected.priority))}>
                                        {selected.priority}
                                    </span>
                                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                        <User className="h-3.5 w-3.5"/>
                                        {selected.assignee || t('requirements.unassigned')}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {t('requirements.source')} <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">{selected.source}</code>
                                    </span>
                                </div>
                            </div>

                            {/* 可滚动内容区域：描述、验收标准、关联问题（半透明底保证文档可读） */}
                            <div className="flex-1 overflow-y-auto bg-background/85 backdrop-blur-sm">
                                <div className="p-6">
                                    {/* 需求描述 */}
                                    {editing ? (
                                        <div className="space-y-3">
                                            <textarea
                                                value={editDescription}
                                                onChange={(e) => setEditDescription(e.target.value)}
                                                className="w-full min-h-[400px] p-4 rounded-xl border border-border bg-background/50 text-sm font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-shadow"
                                                placeholder={t('requirements.descriptionPlaceholder')}
                                            />
                                            {/* 编辑模式：上传文件解析 */}
                                            <div className="space-y-2">
                                                <div className="flex items-center gap-2">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => editFileInputRef.current?.click()}
                                                        className="gap-1.5"
                                                    >
                                                        <FileUp className="h-4 w-4"/>
                                                        {t('requirements.uploadFiles')}
                                                    </Button>
                                                    <input
                                                        ref={editFileInputRef}
                                                        type="file"
                                                        multiple
                                                        accept=".pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg"
                                                        className="hidden"
                                                        onChange={(e) => {
                                                            const newFiles = Array.from(e.target.files ?? []);
                                                            setEditFiles(prev => [...prev, ...newFiles]);
                                                            e.target.value = '';
                                                        }}
                                                    />
                                                </div>
                                                {editFiles.map((f, i) => (
                                                    <div key={i}
                                                         className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-2">
                                                        <FileText className="h-3.5 w-3.5 shrink-0"/>
                                                        <span className="truncate flex-1">{f.name}</span>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="h-5 w-5 rounded"
                                                            onClick={() => setEditFiles(prev => prev.filter((_, idx) => idx !== i))}
                                                        >
                                                            <X className="h-3 w-3"/>
                                                        </Button>
                                                    </div>
                                                ))}
                                                {editFiles.length > 0 && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        disabled={editParsing}
                                                        onClick={handleEditParseFiles}
                                                        className="gap-1.5"
                                                    >
                                                        {editParsing ? <Loader2 className="h-4 w-4 animate-spin"/> :
                                                            <Upload className="h-4 w-4"/>}
                                                        {t('requirements.parseWithMinerU')}
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    ) : (selected.workingDescription ?? selected.description) ? (
                                        <div className="prose prose-sm max-w-none dark:prose-invert">
                                            <MarkdownContent
                                                content={selected.workingDescription ?? selected.description}
                                                imageBasePath={selected.id ? `/api/requirements/images/${selected.id}` : undefined}
                                            />
                                        </div>
                                    ) : null}

                                    {/* 验收标准 */}
                                    {selected.acceptanceCriteria.length > 0 && (
                                        <div className="mt-6 rounded-xl border border-border bg-muted/20 p-4 space-y-3">
                                            <h4 className="text-sm font-semibold flex items-center gap-2">
                                                <CheckCircle2 className="h-4 w-4 text-emerald-500"/>
                                                {t('requirements.acceptanceCriteria')}
                                            </h4>
                                            <ul className="space-y-2">
                                                {selected.acceptanceCriteria.map((ac, i) => (
                                                    <li key={i} className="flex items-start gap-2 text-sm">
                                                        <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-primary mt-1.5"/>
                                                        <span className="text-muted-foreground">{ac}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}

                                    {/* 附件（解析闭环：解析全部 / 合并到文档 / 复制源码） */}
                                    {selected.attachments.length > 0 && (
                                        <div className="mt-6 rounded-xl border border-border bg-muted/20 p-4 space-y-3">
                                            <h4 className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                                                <ScanSearch className="h-4 w-4"/>
                                                {t('requirements.attachmentsTitle')}
                                                <span className="text-xs font-normal text-muted-foreground">
                                                    {t('requirements.parsedCount', {
                                                        parsed: Object.keys(selected.parsedAttachments ?? {}).length,
                                                        total: selected.attachments.length,
                                                    })}
                                                </span>
                                                <span className="flex-1"/>
                                                {attProgress ? (
                                                    <>
                                                        <span className="text-xs text-muted-foreground">
                                                            {attProgress.done + 1}/{attProgress.total} · {attProgress.current}
                                                        </span>
                                                        <Button variant="outline" size="sm" className="h-7 gap-1"
                                                                onClick={() => { attCancelRef.current = true; }}>
                                                            <Square className="h-3 w-3"/>
                                                            {t('requirements.parseStop')}
                                                        </Button>
                                                    </>
                                                ) : (
                                                    <>
                                                        {Object.keys(selected.parsedAttachments ?? {}).length > 0 && (
                                                            <Button size="sm" className="h-7 gap-1" onClick={mergeParses}>
                                                                <GitMerge className="h-3.5 w-3.5"/>
                                                                {t('requirements.mergeToDoc')}
                                                            </Button>
                                                        )}
                                                        {selected.attachments.some(a => selected.parsedAttachments?.[a.name] === undefined) && (
                                                            <Button variant="outline" size="sm" className="h-7 gap-1" onClick={parseAll}>
                                                                <ScanSearch className="h-3.5 w-3.5"/>
                                                                {t('requirements.parseAll')}
                                                            </Button>
                                                        )}
                                                    </>
                                                )}
                                            </h4>
                                            <div className="space-y-3">
                                                {selected.attachments.map(att => {
                                                    const transient = attTransient[att.name];
                                                    const done = selected.parsedAttachments?.[att.name];
                                                    const status = transient?.status === 'loading' ? 'loading'
                                                        : transient?.status === 'error' ? 'error'
                                                            : done ? 'done' : undefined;
                                                    const mergedIn = selected.workingDescription?.includes(`<!--adw-parse:${att.name}-->`) ?? false;
                                                    return (
                                                        <div key={att.name}
                                                             className="rounded-lg border border-border/60 bg-background/60 p-3 space-y-2">
                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0"/>
                                                                <a href={att.url} target="_blank" rel="noreferrer"
                                                                   className="text-sm text-primary hover:underline truncate max-w-[16rem]">
                                                                    {att.name}
                                                                </a>
                                                                {mergedIn && (
                                                                    <span className="text-[11px] px-2 py-0.5 rounded-full border border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                                                                        {t('requirements.mergedBadge')}
                                                                    </span>
                                                                )}
                                                                <span className="flex-1"/>
                                                                {status === 'done' && (
                                                                    <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs"
                                                                            onClick={() => copyAttMarkdown(att.name, done!.markdown)}>
                                                                        <Copy className="h-3 w-3"/>
                                                                        {copiedAtt === att.name ? t('requirements.copied') : t('requirements.copySource')}
                                                                    </Button>
                                                                )}
                                                                <Button variant="outline" size="sm" className="h-7 gap-1 text-xs"
                                                                        disabled={status === 'loading'}
                                                                        onClick={() => void parseOne(selected.id, att.name)}>
                                                                    {status === 'loading'
                                                                        ? <Loader2 className="h-3 w-3 animate-spin"/>
                                                                        : <ScanSearch className="h-3 w-3"/>}
                                                                    {status === 'loading' ? t('requirements.parsing')
                                                                        : status === 'done' ? t('requirements.reparse')
                                                                            : t('requirements.parse')}
                                                                </Button>
                                                                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg hover:bg-destructive/10 hover:text-destructive"
                                                                        title={t('requirements.removeAttachment')}
                                                                        disabled={status === 'loading'}
                                                                        onClick={() => {
                                                                            if (window.confirm(t('requirements.removeAttachmentConfirm', {name: att.name}))) {
                                                                                void removeAttachment(att.name);
                                                                            }
                                                                        }}>
                                                                    <Trash2 className="h-3.5 w-3.5"/>
                                                                </Button>
                                                            </div>
                                                            {status === 'done' && (
                                                                <div className="text-xs rounded-md border border-dashed border-border bg-muted/30 p-2.5">
                                                                    <div className="text-[11px] text-muted-foreground mb-1">
                                                                        {done!.backend} · {new Date(done!.parsedAt).toLocaleString()}
                                                                    </div>
                                                                    <div className="prose prose-sm max-w-none dark:prose-invert">
                                                                        <MarkdownContent
                                                                            content={done!.markdown}
                                                                            imageBasePath={selected.id ? `/api/requirements/images/${selected.id}` : undefined}
                                                                        />
                                                                    </div>
                                                                </div>
                                                            )}
                                                            {status === 'error' && (
                                                                <div className="text-xs text-destructive">
                                                                    {t('requirements.parseFailed')}: {transient!.status === 'error' ? transient.error : ''}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* 关联问题 */}
                                    {selected.relatedIssues.length > 0 && (
                                        <div className="mt-6 rounded-xl border border-border bg-muted/20 p-4 space-y-3">
                                            <h4 className="text-sm font-semibold flex items-center gap-2">
                                                <Link2 className="h-4 w-4"/>
                                                {t('requirements.relatedIssues')}
                                            </h4>
                                            <ul className="space-y-2">
                                                {selected.relatedIssues.map(issue => (
                                                    <li key={issue.id} className="flex items-center gap-2 text-sm">
                                                        <Link2 className="h-3.5 w-3.5 text-muted-foreground"/>
                                                        <span className={cn('text-xs px-2 py-0.5 rounded-md border', statusColor(issue.status))}>
                                                            {issue.status}
                                                        </span>
                                                        <span className="text-muted-foreground">{issue.title}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </>
                    ) : (
                        /* 未选中需求时的空状态提示 */
                        <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                            <FileText className="h-12 w-12 opacity-20"/>
                            <p className="text-sm">{t('requirements.noSelectionTitle')}</p>
                            <p className="text-xs opacity-60">{t('requirements.noSelectionSubtitle')}</p>
                        </div>
                    )}
                </div>
            </div>
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
