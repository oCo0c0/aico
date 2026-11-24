/**
 * @file MinerU 文档解析页面
 * @description 提供文件上传、解析配置、实时状态展示和结果预览的完整交互界面。
 *   解析结果自动持久化到 localStorage，支持查看历史和删除。
 */

import {useState, useEffect, useCallback, useRef} from 'react';
import {usePageActiveRef} from '../hooks/usePageActive';
import {useTranslation} from 'react-i18next';
import {Joyride} from 'react-joyride';
import {useGuide} from '../guides/useGuide';
import {cn} from '../lib/utils';
import {Button} from '../components/ui/button';
import {Card, CardContent, CardHeader, CardTitle} from '../components/ui/card';
import {MarkdownContent} from '../components/MarkdownContent';
import {
    Upload,
    FileText,
    Image as ImageIcon,
    Loader2,
    CheckCircle2,
    XCircle,
    Copy,
    Check,
    Trash2,
    Settings2,
    FileSearch,
    Save,
    History,
    ChevronLeft,
} from 'lucide-react';

// ========== 类型定义 ==========

type Backend = 'pipeline' | 'vlm-auto-engine' | 'vlm-http-client' | 'hybrid-auto-engine' | 'hybrid-http-client';

type TaskPhase = 'idle' | 'uploading' | 'submitting' | 'queued' | 'processing' | 'downloading' | 'completed' | 'failed';

interface ParseResult {
    success: boolean;
    markdown?: string;
    images?: string[];
    error?: string;
    raw?: unknown;
}

/** 持久化的解析记录 */
interface SavedResult {
    id: string;
    fileName: string;
    markdown: string;
    backend: string;
    createdAt: string;
}

interface TaskInfo {
    taskId: string;
    fileName: string;
}

// ========== 常量 ==========

const API_BASE = '/api';
const STORAGE_KEY = 'mineru-saved-results';

const BACKEND_OPTIONS: { value: Backend; labelKey: string; descKey: string }[] = [
    {value: 'hybrid-auto-engine', labelKey: 'mineru.backendHybrid', descKey: 'mineru.backendHybridDesc'},
    {value: 'pipeline', labelKey: 'mineru.backendPipeline', descKey: 'mineru.backendPipelineDesc'},
    {value: 'vlm-auto-engine', labelKey: 'mineru.backendVlm', descKey: 'mineru.backendVlmDesc'},
    {value: 'hybrid-http-client', labelKey: 'mineru.backendHybridRemote', descKey: 'mineru.backendHybridRemoteDesc'},
    {value: 'vlm-http-client', labelKey: 'mineru.backendVlmRemote', descKey: 'mineru.backendVlmRemoteDesc'},
];

const LANG_OPTIONS: { value: string; labelKey: string }[] = [
    {value: 'ch', labelKey: 'mineru.langChinese'},
    {value: 'en', labelKey: 'mineru.langEnglish'},
    {value: 'korean', labelKey: 'mineru.langKorean'},
    {value: 'japan', labelKey: 'mineru.langJapanese'},
    {value: 'chinese_cht', labelKey: 'mineru.langTraditionalChinese'},
    {value: 'latin', labelKey: 'mineru.langLatin'},
    {value: 'arabic', labelKey: 'mineru.langArabic'},
    {value: 'east_slavic', labelKey: 'mineru.langEastSlavic'},
    {value: 'cyrillic', labelKey: 'mineru.langCyrillic'},
    {value: 'devanagari', labelKey: 'mineru.langDevanagari'},
];

const ACCEPTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.docx', '.pptx', '.xlsx'];
const MAX_FILE_SIZE = 100 * 1024 * 1024;

// ========== 持久化工具 ==========

function loadSavedResults(): SavedResult[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveSavedResults(results: SavedResult[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(results));
}

// ========== 页面组件 ==========

export default function MinerUPage() {
    const {t} = useTranslation();
    const {run: guideRun, steps: guideSteps, handleJoyrideEvent} = useGuide('mineru');

    // 文件状态
    const [files, setFiles] = useState<File[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 解析选项
    const [backend, setBackend] = useState<Backend>('hybrid-auto-engine');
    const [langList, setLangList] = useState<string[]>(['ch']);
    const [formulaEnable, setFormulaEnable] = useState(true);
    const [tableEnable, setTableEnable] = useState(true);
    const [imageAnalysis, setimageAnalysis] = useState(true);
    const [showOptions, setShowOptions] = useState(false);

    // 任务状态
    const [phase, setPhase] = useState<TaskPhase>('idle');
    const [statusText, setStatusText] = useState('');
    const [currentTask, setCurrentTask] = useState<TaskInfo | null>(null);
    const [parseResult, setParseResult] = useState<ParseResult | null>(null);
    const [elapsed, setElapsed] = useState(0);

    // 持久化结果
    const [savedResults, setSavedResults] = useState<SavedResult[]>(loadSavedResults);
    const [viewingSaved, setViewingSaved] = useState<SavedResult | null>(null);
    const [showHistory, setShowHistory] = useState(false);

    // UI 状态
    const [activeTab, setActiveTab] = useState<'rendered' | 'raw'>('rendered');
    const [copied, setCopied] = useState(false);

    // 计时器
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // 页面活跃判定（ref 语义）：keep-alive 隐藏页/隐藏标签页暂停后台轮询
    const isPageActive = usePageActiveRef();

    useEffect(() => {
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    // ========== 文件处理 ==========

    const validateFile = useCallback((file: File): string | null => {
        const ext = '.' + file.name.split('.').pop()?.toLowerCase();
        if (!ACCEPTED_EXTENSIONS.includes(ext)) return t('mineru.errorUnsupportedFile', {ext});
        if (file.size > MAX_FILE_SIZE) return t('mineru.errorFileTooLarge', {size: (file.size / 1024 / 1024).toFixed(1)});
        return null;
    }, [t]);

    /** 新文件替换旧文件（单文件模式） */
    const addFiles = useCallback((newFiles: FileList | File[]) => {
        for (const f of Array.from(newFiles)) {
            const err = validateFile(f);
            if (err) {
                setStatusText(err);
                continue;
            }
            // 替换为新文件
            setFiles([f]);
            setStatusText('');
            break; // 只取第一个有效文件
        }
    }, [validateFile]);

    const clearFile = useCallback(() => {
        setFiles([]);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, []);

    const clearAll = useCallback(() => {
        clearFile();
        setPhase('idle');
        setStatusText('');
        setParseResult(null);
        setCurrentTask(null);
        setElapsed(0);
        setViewingSaved(null);
        if (timerRef.current) clearInterval(timerRef.current);
        if (pollRef.current) clearInterval(pollRef.current);
    }, [clearFile]);

    // ========== 拖拽处理 ==========

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    }, [addFiles]);

    // ========== 解析流程 ==========

    const startParse = useCallback(async () => {
        if (files.length === 0) return;

        setParseResult(null);
        setViewingSaved(null);
        setPhase('uploading');
        setStatusText(t('mineru.statusUploading'));
        setElapsed(0);

        timerRef.current = setInterval(() => setElapsed(prev => prev + 1), 1000);

        try {
            const formData = new FormData();
            formData.append('files', files[0]);
            formData.append('backend', backend);
            formData.append('parseMethod', 'auto');
            formData.append('formulaEnable', String(formulaEnable));
            formData.append('tableEnable', String(tableEnable));
            formData.append('imageAnalysis', String(imageAnalysis));
            formData.append('returnMd', 'true');
            formData.append('returnImages', 'true');
            formData.append('returnContentList', 'true');
            for (const lang of langList) formData.append('langList', lang);

            setPhase('submitting');
            setStatusText(t('mineru.statusSubmitting'));

            const submitRes = await fetch(`${API_BASE}/mineru/tasks`, {method: 'POST', body: formData});
            if (!submitRes.ok) {
                const errData = await submitRes.json().catch(() => ({message: t('mineru.errorSubmitFailed')}));
                throw new Error(errData.message || t('mineru.errorSubmitTaskFailed'));
            }

            const submitData = await submitRes.json();
            const taskId = submitData.tasks?.[0]?.task_id;
            if (!taskId) throw new Error(submitData.tasks?.[0]?.error || t('mineru.errorNoTaskId'));

            setCurrentTask({taskId, fileName: files[0].name});
            setPhase('queued');
            setStatusText(t('mineru.statusQueued', {taskId: taskId.slice(0, 8)}));

            pollRef.current = setInterval(async () => {
                if (!isPageActive()) return; // 非活跃页/隐藏标签页跳过本轮
                try {
                    const statusRes = await fetch(`${API_BASE}/mineru/tasks/${taskId}`);
                    const statusData = await statusRes.json();
                    const st = (statusData.status || '').toLowerCase();

                    if (st === 'completed' || st === 'done' || st === 'success' || st === 'finished') {
                        if (pollRef.current) clearInterval(pollRef.current);
                        setPhase('downloading');
                        setStatusText(t('mineru.statusDownloading'));

                        try {
                            const resultRes = await fetch(`${API_BASE}/mineru/tasks/${taskId}/result`);
                            const resultData = await resultRes.json();
                            if (timerRef.current) clearInterval(timerRef.current);
                            setParseResult(resultData);
                            setPhase('completed');
                            setStatusText(t('mineru.statusCompleted'));
                        } catch {
                            if (timerRef.current) clearInterval(timerRef.current);
                            setParseResult({
                                success: true,
                                markdown: statusData.md_content || statusData.markdown || '',
                                raw: statusData
                            });
                            setPhase('completed');
                            setStatusText(t('mineru.statusCompleted'));
                        }
                    } else if (st === 'failed' || st === 'error') {
                        if (pollRef.current) clearInterval(pollRef.current);
                        if (timerRef.current) clearInterval(timerRef.current);
                        setPhase('failed');
                        setStatusText(statusData.message || statusData.error || t('mineru.statusFailedGeneric'));
                    } else if (st === 'processing' || st === 'running') {
                        setPhase('processing');
                        setStatusText(t('mineru.statusParsing', {seconds: elapsed}));
                    } else {
                        setPhase('queued');
                        setStatusText(t('mineru.statusQueuing', {seconds: elapsed}));
                    }
                } catch (err) {
                    console.error('Poll error:', err);
                }
            }, 2000);
        } catch (err) {
            if (timerRef.current) clearInterval(timerRef.current);
            setPhase('failed');
            setStatusText(err instanceof Error ? err.message : t('mineru.errorUnknown'));
        }
    }, [files, backend, langList, formulaEnable, tableEnable, imageAnalysis, elapsed, t]);

    // ========== 结果持久化 ==========

    /** 固化当前结果到 localStorage */
    const saveResult = useCallback(() => {
        if (!parseResult?.markdown || !currentTask) return;
        const record: SavedResult = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            fileName: currentTask.fileName,
            markdown: parseResult.markdown,
            backend,
            createdAt: new Date().toISOString(),
        };
        const updated = [record, ...savedResults];
        setSavedResults(updated);
        saveSavedResults(updated);
        setViewingSaved(record);
    }, [parseResult, currentTask, backend, savedResults]);

    /** 删除已保存结果 */
    const deleteSavedResult = useCallback((id: string) => {
        const updated = savedResults.filter(r => r.id !== id);
        setSavedResults(updated);
        saveSavedResults(updated);
        if (viewingSaved?.id === id) setViewingSaved(null);
    }, [savedResults, viewingSaved]);

    /** 查看已保存结果 */
    const viewSaved = useCallback((result: SavedResult) => {
        setViewingSaved(result);
        setParseResult({success: true, markdown: result.markdown});
        setPhase('completed');
        setStatusText('');
    }, []);

    // 复制 Markdown
    const copyMarkdown = useCallback(async () => {
        const md = parseResult?.markdown || viewingSaved?.markdown;
        if (!md) return;
        await navigator.clipboard.writeText(md);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [parseResult, viewingSaved]);

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    // 当前展示的 markdown
    const displayMarkdown = parseResult?.markdown || viewingSaved?.markdown || '';
    const isParsing = phase === 'uploading' || phase === 'submitting' || phase === 'queued' || phase === 'processing' || phase === 'downloading';

    // ========== 渲染 ==========

    return (
        <div className="flex h-full">
            {/* ===== 左侧面板：上传 + 配置 + 历史 ===== */}
            <div className="w-[420px] border-r border-border/50 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                    {/* 文件上传区域 */}
                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="text-sm flex items-center gap-2">
                                <Upload className="h-4 w-4"/>
                                {t('mineru.fileUpload')}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={handleDrop}
                                onClick={() => fileInputRef.current?.click()}
                                data-tour="mineru-upload"
                                className={cn(
                                    'border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors',
                                    isDragging
                                        ? 'border-primary bg-primary/5'
                                        : 'border-border hover:border-primary/50 hover:bg-accent/30',
                                )}
                            >
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept={ACCEPTED_EXTENSIONS.join(',')}
                                    className="hidden"
                                    onChange={(e) => {
                                        if (e.target.files) addFiles(e.target.files);
                                        // 重置 input value 以便同一文件可再次选择
                                        e.target.value = '';
                                    }}
                                />
                                <FileSearch className="h-8 w-8 mx-auto mb-2 text-muted-foreground"/>
                                <p className="text-sm text-muted-foreground">
                                    {t('mineru.dragDropHint')}
                                </p>
                                <p className="text-xs text-muted-foreground/60 mt-1">
                                    {t('mineru.supportedFormats')}
                                </p>
                            </div>

                            {/* 已选文件 */}
                            {files.length > 0 && (
                                <div className="mt-3 flex items-center gap-2 text-sm bg-accent/30 rounded-lg px-3 py-2">
                                    {files[0].type.startsWith('image/') ? (
                                        <ImageIcon className="h-3.5 w-3.5 text-blue-400 shrink-0"/>
                                    ) : (
                                        <FileText className="h-3.5 w-3.5 text-orange-400 shrink-0"/>
                                    )}
                                    <span className="truncate flex-1">{files[0].name}</span>
                                    <span className="text-xs text-muted-foreground shrink-0">
                                        {(files[0].size / 1024).toFixed(0)}KB
                                    </span>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            clearFile();
                                        }}
                                        className="text-muted-foreground hover:text-destructive shrink-0"
                                        title={t('mineru.removeFile')}
                                    >
                                        <XCircle className="h-3.5 w-3.5"/>
                                    </button>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {/* 解析配置 */}
                    <Card>
                        <CardHeader className="pb-3">
                            <div
                                className="flex items-center justify-between cursor-pointer"
                                onClick={() => setShowOptions(!showOptions)}
                            >
                                <CardTitle className="text-sm flex items-center gap-2">
                                    <Settings2 className="h-4 w-4"/>
                                    {t('mineru.parseConfig')}
                                </CardTitle>
                                <span className="text-xs text-muted-foreground">
                                    {showOptions ? t('mineru.collapse') : t('mineru.expand')}
                                </span>
                            </div>
                        </CardHeader>
                        {showOptions && (
                            <CardContent className="space-y-3">
                                <div>
                                    <label
                                        className="text-xs text-muted-foreground mb-1 block">{t('mineru.backend')}</label>
                                    <div className="space-y-1">
                                        {BACKEND_OPTIONS.map(opt => (
                                            <label
                                                key={opt.value}
                                                className={cn(
                                                    'flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer text-xs transition-colors',
                                                    backend === opt.value
                                                        ? 'bg-primary/10 text-primary border border-primary/20'
                                                        : 'hover:bg-accent/50 border border-transparent',
                                                )}
                                            >
                                                <input
                                                    type="radio"
                                                    name="backend"
                                                    value={opt.value}
                                                    checked={backend === opt.value}
                                                    onChange={() => setBackend(opt.value)}
                                                    className="sr-only"
                                                />
                                                <span className="font-medium">{t(opt.labelKey)}</span>
                                                <span className="text-muted-foreground">{t(opt.descKey)}</span>
                                            </label>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <label
                                        className="text-xs text-muted-foreground mb-1 block">{t('mineru.ocrLanguage')}</label>
                                    <select
                                        value={langList[0]}
                                        onChange={(e) => setLangList([e.target.value])}
                                        className="w-full bg-card border border-border rounded-lg px-3 py-1.5 text-sm"
                                    >
                                        {LANG_OPTIONS.map(opt => (
                                            <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="space-y-2">
                                    <ToggleOption label={t('mineru.toggleFormula')} checked={formulaEnable}
                                                  onChange={setFormulaEnable}/>
                                    <ToggleOption label={t('mineru.toggleTable')} checked={tableEnable}
                                                  onChange={setTableEnable}/>
                                    <ToggleOption label={t('mineru.toggleImageAnalysis')} checked={imageAnalysis}
                                                  onChange={setimageAnalysis}/>
                                </div>
                            </CardContent>
                        )}
                    </Card>

                    {/* 操作按钮 */}
                    <div className="flex gap-2">
                        <Button
                            onClick={startParse}
                            disabled={files.length === 0 || isParsing}
                            className="flex-1"
                            data-tour="mineru-parse-btn"
                        >
                            {isParsing ? (
                                <><Loader2 className="h-4 w-4 mr-2 animate-spin"/>{t('mineru.parsing')}</>
                            ) : (
                                <><FileSearch className="h-4 w-4 mr-2"/>{t('mineru.parse')}</>
                            )}
                        </Button>
                        {phase === 'completed' && parseResult?.markdown && !viewingSaved && (
                            <Button variant="outline" onClick={saveResult} title={t('mineru.saveResult')}>
                                <Save className="h-4 w-4"/>
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            onClick={clearAll}
                            disabled={isParsing}
                        >
                            <Trash2 className="h-4 w-4"/>
                        </Button>
                    </div>

                    {/* 状态信息 */}
                    {phase !== 'idle' && phase !== 'completed' && (
                        <div className={cn(
                            'flex items-center gap-2 px-3 py-2 rounded-lg text-sm',
                            phase === 'failed' && 'bg-red-500/10 text-red-400',
                            phase !== 'failed' && 'bg-primary/10 text-primary',
                        )}>
                            {phase === 'failed' ? (
                                <XCircle className="h-4 w-4 shrink-0"/>
                            ) : (
                                <Loader2 className="h-4 w-4 shrink-0 animate-spin"/>
                            )}
                            <span className="flex-1">{statusText}</span>
                            {isParsing && <span className="text-xs opacity-60">{formatTime(elapsed)}</span>}
                        </div>
                    )}
                    {phase === 'completed' && currentTask && !viewingSaved && (
                        <div
                            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-emerald-500/10 text-emerald-400">
                            <CheckCircle2 className="h-4 w-4 shrink-0"/>
                            <span
                                className="flex-1">{t('mineru.statusCompletedWithFile', {fileName: currentTask.fileName})}</span>
                        </div>
                    )}

                    {/* 历史记录 */}
                    {savedResults.length > 0 && (
                        <Card>
                            <CardHeader className="pb-2">
                                <div
                                    className="flex items-center justify-between cursor-pointer"
                                    onClick={() => setShowHistory(!showHistory)}
                                >
                                    <CardTitle className="text-sm flex items-center gap-2">
                                        <History className="h-4 w-4"/>
                                        {t('mineru.savedRecords', {count: savedResults.length})}
                                    </CardTitle>
                                    <span className="text-xs text-muted-foreground">
                                        {showHistory ? t('mineru.collapse') : t('mineru.expand')}
                                    </span>
                                </div>
                            </CardHeader>
                            {showHistory && (
                                <CardContent className="space-y-1.5">
                                    {savedResults.map(result => (
                                        <div
                                            key={result.id}
                                            className={cn(
                                                'flex items-center gap-2 text-sm rounded-lg px-3 py-2 cursor-pointer transition-colors group',
                                                viewingSaved?.id === result.id
                                                    ? 'bg-primary/10 text-primary'
                                                    : 'hover:bg-accent/50',
                                            )}
                                            onClick={() => viewSaved(result)}
                                        >
                                            <FileText className="h-3.5 w-3.5 shrink-0"/>
                                            <div className="flex-1 min-w-0">
                                                <p className="truncate text-xs font-medium">{result.fileName}</p>
                                                <p className="text-[10px] text-muted-foreground">
                                                    {new Date(result.createdAt).toLocaleString('zh-CN')}
                                                </p>
                                            </div>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    deleteSavedResult(result.id);
                                                }}
                                                className="text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                                title={t('mineru.deleteSaved')}
                                            >
                                                <Trash2 className="h-3 w-3"/>
                                            </button>
                                        </div>
                                    ))}
                                </CardContent>
                            )}
                        </Card>
                    )}
                </div>
            </div>

            {/* ===== 右侧面板：结果展示 ===== */}
            <div className="flex-1 flex flex-col overflow-hidden" data-tour="mineru-results">
                {(displayMarkdown || parseResult?.error) ? (
                    <>
                        {/* 结果标签页 */}
                        <div className="flex items-center gap-1 px-5 pt-4 pb-2 border-b border-border/50">
                            {/* 查看历史记录时显示返回按钮 */}
                            {viewingSaved && (
                                <button
                                    onClick={() => {
                                        setViewingSaved(null);
                                        setParseResult(null);
                                        setPhase('idle');
                                    }}
                                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mr-2"
                                >
                                    <ChevronLeft className="h-3.5 w-3.5"/>
                                    {t('common.back')}
                                </button>
                            )}
                            <button
                                className={cn(
                                    'px-3 py-1.5 text-sm rounded-lg transition-colors',
                                    activeTab === 'rendered'
                                        ? 'bg-primary/10 text-primary font-medium'
                                        : 'text-muted-foreground hover:text-foreground',
                                )}
                                onClick={() => setActiveTab('rendered')}
                            >
                                {t('mineru.renderedTab')}
                            </button>
                            <button
                                className={cn(
                                    'px-3 py-1.5 text-sm rounded-lg transition-colors',
                                    activeTab === 'raw'
                                        ? 'bg-primary/10 text-primary font-medium'
                                        : 'text-muted-foreground hover:text-foreground',
                                )}
                                onClick={() => setActiveTab('raw')}
                            >
                                {t('mineru.rawTab')}
                            </button>
                            <div className="flex-1"/>
                            {viewingSaved && (
                                <span className="text-xs text-muted-foreground mr-2">
                                    {viewingSaved.fileName}
                                </span>
                            )}
                            <Button variant="ghost" size="sm" onClick={copyMarkdown} className="text-xs">
                                {copied ? <Check className="h-3.5 w-3.5 mr-1"/> : <Copy className="h-3.5 w-3.5 mr-1"/>}
                                {copied ? t('common.copied') : t('common.copy')}
                            </Button>
                        </div>

                        {/* 结果内容 */}
                        <div className="flex-1 overflow-y-auto p-5">
                            {parseResult?.error ? (
                                <div className="bg-red-500/10 text-red-400 rounded-lg p-4 text-sm">
                                    <p className="font-medium mb-1">{t('mineru.parseErrorTitle')}</p>
                                    <p className="text-red-300">{parseResult.error}</p>
                                </div>
                            ) : activeTab === 'rendered' ? (
                                <MarkdownContent content={displayMarkdown} className="min-h-0"/>
                            ) : (
                                <pre
                                    className="text-sm bg-muted/30 border border-border rounded-lg p-4 whitespace-pre-wrap break-words font-mono leading-relaxed">
                                    {displayMarkdown}
                                </pre>
                            )}

                            {parseResult?.images && parseResult.images.length > 0 && (
                                <div className="mt-6">
                                    <h3 className="text-sm font-medium mb-3 text-muted-foreground">
                                        {t('mineru.extractedImages', {count: parseResult.images.length})}
                                    </h3>
                                    <div className="grid grid-cols-2 gap-3">
                                        {parseResult.images.map((img, i) => (
                                            <div key={i} className="rounded-lg border border-border overflow-hidden">
                                                <img
                                                    src={img.startsWith('data:') ? img : `data:image/png;base64,${img}`}
                                                    alt={`Image ${i + 1}`}
                                                    className="w-full h-auto"
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center">
                        <div className="text-center text-muted-foreground">
                            <FileSearch className="h-12 w-12 mx-auto mb-3 opacity-30"/>
                            <p className="text-sm">{t('mineru.emptyTitle')}</p>
                            <p className="text-xs mt-1 opacity-60">
                                {t('mineru.emptySubtitle')}
                            </p>
                        </div>
                    </div>
                )}
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

// ========== 子组件 ==========

function ToggleOption({label, checked, onChange}: {
    label: string;
    checked: boolean;
    onChange: (val: boolean) => void;
}) {
    return (
        <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm">{label}</span>
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                onClick={() => onChange(!checked)}
                className={cn(
                    'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                    checked ? 'bg-primary' : 'bg-muted',
                )}
            >
                <span
                    className={cn(
                        'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
                        checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
                    )}
                />
            </button>
        </label>
    );
}
