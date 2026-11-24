/**
 * @file ModelProvidersPage.tsx
 * @description 模型供应商配置管理页面
 *
 * 本项目自有的模型供应商配置体系前端入口，提供以下能力：
 * - 查看所有已配置供应商（脱敏视图，API Key 仅显示掩码）
 * - 检测本地 Claude / Codex / Pi CLI 的外部配置源
 * - 一键导入外部配置（增量叠加、高优先级覆盖低优先级）
 * - 手动新增 / 编辑 / 删除供应商
 * - 连通性测试（复用 POST /model-providers/models/fetch，只探测不写任何配置）
 * - 默认模型标记（复用 defaultModel 字段，ModelPicker 下拉置顶展示）
 *
 * 布局：顶部操作栏（主操作实心/次操作 ghost）+ 左侧供应商卡片列表 + 右侧分节卡片表单。
 * 注：外部 CLI 配置的检测/导入已移除（CLI 侧配置由各引擎隔离层在首次使用时播种一次）。
 */

import {useState, useEffect, useCallback} from 'react';
import {useTranslation} from 'react-i18next';
import {apiGet, apiPost, apiDelete} from '../api';
import {useAppStore} from '../stores/app-store';
import {cn} from '../lib/utils';
import {Button} from '../components/ui/button';
import {Input} from '../components/ui/input';
import {Card, CardContent} from '../components/ui/card';
import {Badge} from '../components/ui/badge';
import {
    Plus,
    Trash2,
    RefreshCw,
    Loader2,
    Save,
    X,
    AlertCircle,
    Download,
    Bot,
    Terminal,
    Sparkles,
    Cpu,
    Server,
    KeyRound,
    Globe,
    Star,
    PlugZap,
} from 'lucide-react';
import type {
    SafeModelProviderRecord,
    ExternalSourceStatus,
    ModelProviderKind,
    ModelProviderSource,
    ModelProvidersListResponse,
    DetectResponse,
    ImportResponse,
    UpsertResponse,
} from '../types/model-provider-types';

/** 供应商种类对应的图标组件 */
const KIND_ICONS: Record<ModelProviderKind, typeof Bot> = {
    claude: Bot,
    codex: Terminal,
    pi: Sparkles,
    custom: Cpu,
};

/** 来源徽章配置 */
const SOURCE_BADGE: Record<ModelProviderSource, { variant: 'default' | 'secondary' | 'outline'; labelKey: string }> = {
    external: {variant: 'outline', labelKey: 'modelProviders.sourceExternal'},
    manual: {variant: 'default', labelKey: 'modelProviders.sourceManual'},
    builtin: {variant: 'secondary', labelKey: 'modelProviders.sourceBuiltin'},
};

/** 供应商类型选项 */
const KIND_OPTIONS: { value: ModelProviderKind; label: string }[] = [
    {value: 'claude', label: 'Claude'},
    {value: 'codex', label: 'Codex'},
    {value: 'pi', label: 'Pi'},
    {value: 'custom', label: 'Custom'},
];

/** 新增/编辑表单的初始状态 */
function emptyForm() {
    return {
        id: '',
        kind: 'custom' as ModelProviderKind,
        label: '',
        enabled: true,
        apiKey: '',
        baseUrl: '',
        defaultModel: '',
        models: '',
        env: '',
    };
}

/**
 * 模型供应商配置管理页面
 */
export default function ModelProvidersPage() {
    const {t} = useTranslation();
    // pi 引擎的原生检测结果（启动时 detect 拉取）：供应商/凭证由 pi 体系自管
    const piMeta = useAppStore((s) => s.piMeta);
    // 保存/删除后同步刷新全局 Provider 目录与档位缓存：新加的模型在模型选择器/顶栏即时可见
    const refreshProviderCatalog = useAppStore((s) => s.refreshProviderCatalog);
    const fetchAvailableModels = useAppStore((s) => s.fetchAvailableModels);

    // 列表状态（外部配置导入已移除：CLI 侧配置由各引擎隔离层首次使用时播种）
    const [providers, setProviders] = useState<SafeModelProviderRecord[]>([]);
    const [configFile, setConfigFile] = useState<string>('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // 编辑状态
    const [editing, setEditing] = useState<SafeModelProviderRecord | null>(null);
    const [creating, setCreating] = useState(false);
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState(emptyForm());

    // 模型拉取状态（候选只供挑选，不自动写配置）
    const [fetchingModels, setFetchingModels] = useState(false);
    const [modelCandidates, setModelCandidates] = useState<string[]>([]);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [modelInput, setModelInput] = useState('');

    // 连通性测试状态（复用 POST /model-providers/models/fetch，只探测不写任何配置）
    const [testingForm, setTestingForm] = useState(false); // 表单“测试连接”进行中
    const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
    const [testingId, setTestingId] = useState<string | null>(null); // 列表项测试中的供应商 id

    /** 拉取供应商列表 */
    const fetchProviders = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await apiGet<ModelProvidersListResponse>('/model-providers');
            setProviders(data.providers);
            setConfigFile(data.file);
            // 同步刷新全局 Provider 目录与档位/模型列表：此前 providerCatalog 只在应用启动
            // 拉一次，这里保存的新模型对模型选择器不可见直到刷新页面
            await refreshProviderCatalog();
            await fetchAvailableModels();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch providers');
        } finally {
            setLoading(false);
        }
    }, [refreshProviderCatalog, fetchAvailableModels]);

    // 首次加载：拉取供应商列表（不再检测/导入外部 CLI 配置）
    useEffect(() => {
        fetchProviders();
    }, [fetchProviders]);

    /** 进入新增模式 */
    const startCreate = () => {
        setCreating(true);
        setEditing(null);
        setForm(emptyForm());
    };

    /** 进入编辑模式 */
    const startEdit = (provider: SafeModelProviderRecord) => {
        setCreating(false);
        setEditing(provider);
        setForm({
            id: provider.id,
            kind: provider.kind,
            label: provider.label,
            enabled: provider.enabled,
            apiKey: '', // 编辑时留空 = 不修改
            baseUrl: provider.baseUrl ?? '',
            defaultModel: provider.defaultModel ?? '',
            models: (provider.models ?? []).join('\n'),
            env: Object.entries(provider.env ?? {})
                .map(([k, v]) => `${k}=${v}`)
                .join('\n'),
        });
    };

    /** 取消编辑/新增 */
    const cancelForm = () => {
        setCreating(false);
        setEditing(null);
        setForm(emptyForm());
        setModelCandidates([]);
        setFetchError(null);
        setModelInput('');
        setTestResult(null);
    };

    /** 更新表单单个字段 */
    const setField = <K extends keyof ReturnType<typeof emptyForm>>(
        key: K,
        value: ReturnType<typeof emptyForm>[K],
    ) => {
        setForm((prev) => ({...prev, [key]: value}));
    };

    /** 解析 env 文本（每行 KEY=VALUE） */
    const parseEnv = (envStr: string): Record<string, string> => {
        const env: Record<string, string> = {};
        envStr.split('\n').filter(Boolean).forEach((line) => {
            const idx = line.indexOf('=');
            if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        });
        return env;
    };

    // --- 模型列表（chip 编辑 + 端点拉取） ---
    const modelsList = form.models.split('\n').map((m) => m.trim()).filter(Boolean);
    const setModels = (list: string[]) => setField('models', list.join('\n'));
    const addModel = (id: string) => {
        const v = id.trim();
        if (v && !modelsList.includes(v)) setModels([...modelsList, v]);
    };
    const removeModel = (id: string) => {
        if (form.defaultModel === id) setField('defaultModel', ''); // 移除的是默认模型时清空标记，避免悬空引用
        setModels(modelsList.filter((m) => m !== id));
    };
    /** 点击星标切换“设为默认模型”（单选语义：再次点击取消） */
    const toggleDefaultModel = (id: string) => {
        setField('defaultModel', form.defaultModel === id ? '' : id);
    };

    /** 切换类型时预填 id/label（仅新增且用户未自定义时） */
    const handleKindChange = (kind: ModelProviderKind) => {
        setField('kind', kind);
        if (creating) {
            const opt = KIND_OPTIONS.find((k) => k.value === kind);
            if (!form.id.trim()) setField('id', kind);
            if (!form.label.trim() && opt) setField('label', opt.label);
        }
    };

    /** 用表单当前凭据（未保存也可）向端点拉取模型清单；失败就地展示，可手填 */
    const fetchModels = async () => {
        setFetchingModels(true);
        setFetchError(null);
        try {
            const resp = await apiPost<{ models: string[] }>('/model-providers/models/fetch', {
                apiKey: form.apiKey.trim() || undefined,
                baseUrl: form.baseUrl.trim() || undefined,
                kind: form.kind,
                id: editing?.id,
            });
            setModelCandidates(resp.models ?? []);
            if ((resp.models ?? []).length === 0) setFetchError(t('modelProviders.fetchEmpty'));
        } catch (err) {
            setFetchError(err instanceof Error ? err.message : 'Failed to fetch');
            setModelCandidates([]);
        } finally {
            setFetchingModels(false);
        }
    };

    /** 用表单当前凭据（未保存也可）测试连通性：复用 models/fetch 端点，只探测不写配置 */
    const testConnection = async () => {
        setTestingForm(true);
        setTestResult(null);
        try {
            const resp = await apiPost<{ models: string[] }>('/model-providers/models/fetch', {
                apiKey: form.apiKey.trim() || undefined,
                baseUrl: form.baseUrl.trim() || undefined,
                kind: form.kind,
                id: editing?.id,
            });
            setTestResult({
                ok: true,
                message: t('modelProviders.testOk', {count: resp.models?.length ?? 0}),
            });
        } catch (err) {
            setTestResult({
                ok: false,
                message: err instanceof Error ? err.message : t('modelProviders.testFail'),
            });
        } finally {
            setTestingForm(false);
        }
    };

    /** 用已保存配置的凭据测试列表中某个供应商：不传 key，由后端回退到已存凭据 */
    const testProvider = async (provider: SafeModelProviderRecord) => {
        setTestingId(provider.id);
        setError(null);
        setNotice(null);
        try {
            const resp = await apiPost<{ models: string[] }>('/model-providers/models/fetch', {
                baseUrl: provider.baseUrl || undefined,
                kind: provider.kind,
                id: provider.id,
            });
            setNotice(
                t('modelProviders.testOkNamed', {name: provider.label, count: resp.models?.length ?? 0}),
            );
        } catch (err) {
            setError(
                t('modelProviders.testFailNamed', {
                    name: provider.label,
                    message: err instanceof Error ? err.message : t('modelProviders.testFail'),
                }),
            );
        } finally {
            setTestingId(null);
        }
    };

    /** 保存（新增/编辑） */
    const handleSave = async () => {
        const id = form.id.trim();
        if (!id) {
            setError(t('modelProviders.idRequired'));
            return;
        }

        setSaving(true);
        setError(null);
        try {
            const payload = {
                id,
                kind: form.kind,
                label: form.label.trim() || id,
                enabled: form.enabled,
                apiKey: form.apiKey.trim() || undefined,
                baseUrl: form.baseUrl.trim() || undefined,
                defaultModel: form.defaultModel.trim() || undefined,
                models: form.models
                    .split('\n')
                    .map((m) => m.trim())
                    .filter(Boolean),
                env: parseEnv(form.env),
                // 经页面保存 = 手动维护：source 置为 manual，
                // 避免重启时 auto-import 把 ~/.claude/settings.json 等外部配置覆盖回用户修改前的值
                source: 'manual',
            };
            await apiPost<UpsertResponse>('/model-providers', payload);
            cancelForm();
            await fetchProviders();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    /** 删除供应商 */
    const handleDelete = async (provider: SafeModelProviderRecord) => {
        if (!confirm(t('modelProviders.deleteConfirm', {name: provider.label}))) return;
        try {
            await apiDelete(`/model-providers/${encodeURIComponent(provider.id)}`);
            if (editing?.id === provider.id) cancelForm();
            await fetchProviders();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete');
        }
    };

    return (
        <div className="p-6 h-full flex flex-col">
            {/* 错误横幅 */}
            {error && (
                <div
                    className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                    <AlertCircle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0"/>
                    <p className="text-sm text-destructive">{error}</p>
                </div>
            )}

            {/* 提示横幅 */}
            {notice && (
                <div
                    className="mb-4 flex items-start gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">
                    <span className="h-4 w-4 mt-0.5 flex-shrink-0 text-emerald-500">✓</span>
                    <p className="text-sm text-emerald-600">{notice}</p>
                </div>
            )}

            {/* 顶部操作栏 */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
                <div className="mr-auto">
                    <h2 className="text-base font-semibold text-foreground">{t('pageTitle.modelProviders')}</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('modelProviders.subtitle')}</p>
                </div>
                {/* 次操作归组为 ghost，主操作「新增」保持实心 */}
                <Button variant="ghost" size="sm" onClick={fetchProviders} disabled={loading}
                        title={t('common.refresh')}>
                    {loading ? <Loader2 className="h-4 w-4 animate-spin"/> : <RefreshCw className="h-4 w-4"/>}
                </Button>
                <Button size="sm" onClick={startCreate}>
                    <Plus className="h-4 w-4 mr-1"/>
                    {t('modelProviders.add')}
                </Button>
            </div>

            {/* Pi 原生供应商区（只读）：pi 引擎的供应商/凭证由 pi 体系自管，
                此处仅展示检测结果，引导用户在 pi 侧完成配置 */}
            <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                    <Sparkles className="h-3.5 w-3.5 text-muted-foreground"/>
                    <span className="text-xs font-medium text-muted-foreground">
                        {t('modelProviders.piNativeTitle')}
                    </span>
                    <span className="text-[11px] text-muted-foreground/70">
                        {t('modelProviders.piNativeHint')}
                    </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    {(piMeta?.availableProviders || []).length === 0 ? (
                        <div className="w-full rounded-lg border border-border/50 px-3 py-2 text-xs text-muted-foreground">
                            {t('modelProviders.piNativeNone')}
                        </div>
                    ) : (
                        piMeta!.availableProviders.map((p) => (
                            <span
                                key={p}
                                className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-mono text-emerald-600"
                                title="~/.pi/agent/auth.json 或环境变量已配置"
                            >
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"/>
                                {p}
                            </span>
                        ))
                    )}
                </div>
            </div>

            {/* 主体：列表 + 表单 */}
            <div className="flex-1 flex gap-4 min-h-0">
                {/* 左侧供应商列表 */}
                <div className="w-80 flex flex-col flex-shrink-0">
                    <div className="flex items-center justify-between mb-2">
                        <span
                            className="text-xs font-medium text-muted-foreground">{t('modelProviders.providers')}</span>
                        <span className="text-[11px] text-muted-foreground/70" title={configFile}>
                            {configFile ? t('modelProviders.configFileLabel') : ''}
                        </span>
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                        {loading && (
                            <div className="flex items-center justify-center py-8">
                                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground"/>
                            </div>
                        )}
                        {!loading && providers.length === 0 && (
                            <div className="flex flex-col items-center justify-center py-8 gap-2">
                                <Server className="h-8 w-8 text-muted-foreground/50"/>
                                <p className="text-xs text-muted-foreground text-center">{t('modelProviders.noProviders')}</p>
                            </div>
                        )}
                        {providers.map((provider) => {
                            const Icon = KIND_ICONS[provider.kind] ?? Cpu;
                            const sourceBadge = SOURCE_BADGE[provider.source] ?? SOURCE_BADGE.manual;
                            return (
                                <Card
                                    key={provider.id}
                                    className={cn(
                                        'cursor-pointer transition-all duration-150 hover:border-primary/50',
                                        editing?.id === provider.id && 'border-primary ring-1 ring-primary/20',
                                    )}
                                    onClick={() => startEdit(provider)}
                                >
                                    <CardContent className="p-3">
                                        {/* 标题行：图标 + 名称 + 启用状态点 */}
                                        <div className="flex items-center gap-2">
                                            <Icon className="h-4 w-4 text-primary flex-shrink-0"/>
                                            <span
                                                className="text-sm font-medium flex-1 truncate">{provider.label}</span>
                                            <span
                                                className={cn(
                                                    'h-2.5 w-2.5 rounded-full flex-shrink-0',
                                                    provider.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30',
                                                )}
                                                title={provider.enabled ? t('modelProviders.on') : t('modelProviders.off')}
                                            />
                                        </div>
                                        {/* 徽标行：来源 + 模型数 + 默认模型 + pi 兼容 */}
                                        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                                            <Badge variant={sourceBadge.variant} className="text-[10px]">
                                                {t(sourceBadge.labelKey)}
                                            </Badge>
                                            <Badge variant="outline" className="text-[10px]">
                                                {t('modelProviders.modelCount', {count: provider.models.length})}
                                            </Badge>
                                            {provider.defaultModel && (
                                                <Badge
                                                    variant="outline"
                                                    className="text-[10px] gap-0.5 border-amber-500/40 text-amber-600"
                                                    title={provider.defaultModel}
                                                >
                                                    <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400"/>
                                                    {t('modelProviders.defaultBadge')}
                                                </Badge>
                                            )}
                                            {/* pi 类型记录：兼容模式徽标（运行时注入 key，建议迁移 pi 原生配置） */}
                                            {provider.kind === 'pi' && (
                                                <Badge
                                                    variant="outline"
                                                    className="text-[10px] border-amber-500/40 text-amber-600"
                                                    title={t('modelProviders.piCompatHint')}
                                                >
                                                    {t('modelProviders.piCompatBadge')}
                                                </Badge>
                                            )}
                                            <span
                                                className="text-[11px] text-muted-foreground truncate font-mono">{provider.id}</span>
                                        </div>
                                        <div className="flex items-center gap-2 mt-2 text-[11px] text-muted-foreground">
                                            <KeyRound className="h-3 w-3 flex-shrink-0"/>
                                            {provider.hasApiKey
                                                ? <span className="font-mono">{provider.apiKeyMasked}</span>
                                                : <span>{t('modelProviders.noApiKey')}</span>
                                            }
                                        </div>
                                        {provider.baseUrl && (
                                            <p className="text-[11px] text-muted-foreground/80 mt-1 truncate font-mono">
                                                {provider.baseUrl}
                                            </p>
                                        )}
                                        <p className="text-[11px] text-muted-foreground/70 mt-1 truncate">
                                            {provider.models.length > 0
                                                ? provider.models.join(', ')
                                                : t('modelProviders.noModels')}
                                        </p>
                                        {/* 操作行：测试连接（已存凭据）/ 删除 */}
                                        <div className="mt-2.5 flex items-center gap-1">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-7 w-7"
                                                title={t('modelProviders.testConnection')}
                                                disabled={testingId === provider.id}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    testProvider(provider);
                                                }}
                                            >
                                                {testingId === provider.id
                                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin"/>
                                                    : <PlugZap className="h-3.5 w-3.5"/>}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-7 w-7 text-destructive hover:text-destructive"
                                                title={t('common.delete')}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleDelete(provider);
                                                }}
                                            >
                                                <Trash2 className="h-3.5 w-3.5"/>
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>
                </div>

                {/* 右侧表单 */}
                {(creating || editing) ? (
                    <Card className="flex-1 overflow-y-auto">
                        <div className="p-4">
                            <h3 className="text-sm font-medium mb-4">
                                {creating
                                    ? t('modelProviders.addTitle')
                                    : t('modelProviders.editTitle', {name: editing?.label ?? editing?.id})}
                            </h3>
                            <div className="space-y-5">
                                {/* ── 分区：基础信息（卡片化，glass 风格同 Card 组件） ── */}
                                <section className="space-y-3 rounded-xl glass-card p-4">
                                    <div>
                                        <h4 className="text-sm font-medium">
                                            {t('modelProviders.sectionBasic')}
                                        </h4>
                                        <p className="text-xs text-muted-foreground mt-0.5">
                                            {t('modelProviders.sectionBasicHint')}
                                        </p>
                                    </div>
                                    {/* 类型：按钮组（视觉选择器） */}
                                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                                        {KIND_OPTIONS.map((k) => {
                                            const KindIcon = KIND_ICONS[k.value];
                                            const active = form.kind === k.value;
                                            return (
                                                <button
                                                    key={k.value}
                                                    type="button"
                                                    onClick={() => handleKindChange(k.value)}
                                                    className={cn(
                                                        'flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 text-xs transition-colors',
                                                        active
                                                            ? 'border-primary bg-primary/10 font-medium text-primary'
                                                            : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
                                                    )}
                                                >
                                                    <KindIcon className="h-4 w-4"/>
                                                    {k.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    {/* pi 类型引导：供应商与凭证以 pi 原生体系为准 */}
                                    {form.kind === 'pi' && (
                                        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600">
                                            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0"/>
                                            <p>{t('modelProviders.piCompatHint')}</p>
                                        </div>
                                    )}
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div>
                                            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                                                {t('modelProviders.id')}
                                            </label>
                                            <Input
                                                value={form.id}
                                                onChange={(e) => setField('id', e.target.value)}
                                                disabled={!!editing}
                                                placeholder="my-provider"
                                                className="font-mono"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                                                {t('modelProviders.label')}
                                            </label>
                                            <Input
                                                value={form.label}
                                                onChange={(e) => setField('label', e.target.value)}
                                                placeholder={t('modelProviders.labelPlaceholder')}
                                            />
                                        </div>
                                    </div>
                                </section>

                                {/* ── 分区：连接（卡片化；测试连接按钮与结果也在此就近展示） ── */}
                                <section className="space-y-3 rounded-xl glass-card p-4">
                                    <div>
                                        <h4 className="text-sm font-medium">
                                            {t('modelProviders.sectionConnection')}
                                        </h4>
                                        <p className="text-xs text-muted-foreground mt-0.5">
                                            {t('modelProviders.sectionConnectionHint')}
                                        </p>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div>
                                            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                                                {t('modelProviders.apiKey')}
                                            </label>
                                            <Input
                                                type="password"
                                                value={form.apiKey}
                                                onChange={(e) => setField('apiKey', e.target.value)}
                                                placeholder={editing
                                                    ? t('modelProviders.apiKeyEditPlaceholder')
                                                    : t('modelProviders.apiKeyPlaceholder')}
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                                                {t('modelProviders.baseUrl')}
                                                <span className="ml-1 font-normal text-muted-foreground/60">
                                                    ({t('modelProviders.optional')})
                                                </span>
                                            </label>
                                            <Input
                                                value={form.baseUrl}
                                                onChange={(e) => setField('baseUrl', e.target.value)}
                                                placeholder="https://api.deepseek.com"
                                            />
                                        </div>
                                    </div>
                                </section>

                                {/* ── 分区：模型（卡片化） ── */}
                                <section className="space-y-3 rounded-xl glass-card p-4">
                                    <div className="flex items-center gap-2">
                                        <div className="mr-auto">
                                            <h4 className="text-sm font-medium">
                                                {t('modelProviders.sectionModels')}
                                            </h4>
                                            <p className="text-xs text-muted-foreground mt-0.5">
                                                {t('modelProviders.sectionModelsHint')}
                                            </p>
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={fetchModels}
                                            disabled={fetchingModels}
                                        >
                                            {fetchingModels
                                                ? <Loader2 className="h-4 w-4 mr-1 animate-spin"/>
                                                : <Sparkles className="h-4 w-4 mr-1"/>}
                                            {fetchingModels
                                                ? t('modelProviders.fetchingModels')
                                                : t('modelProviders.fetchModels')}
                                        </Button>
                                    </div>
                                    {fetchError && (
                                        <p className="text-xs text-destructive">{fetchError}</p>
                                    )}
                                    {/* 候选模型（端点返回，点击切换选中） */}
                                    {modelCandidates.length > 0 && (
                                        <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                                            <p className="text-[11px] text-muted-foreground mb-1.5">
                                                {t('modelProviders.candidatesHint')}
                                            </p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {modelCandidates.map((m) => {
                                                    const picked = modelsList.includes(m);
                                                    return (
                                                        <button
                                                            key={m}
                                                            type="button"
                                                            onClick={() => (picked ? removeModel(m) : addModel(m))}
                                                            className={cn(
                                                                'rounded-full border px-2.5 py-1 font-mono text-xs transition-colors',
                                                                picked
                                                                    ? 'border-primary bg-primary/10 text-primary'
                                                                    : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
                                                            )}
                                                        >
                                                            {m}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                    {/* 已选模型 chips */}
                                    <div className="flex flex-wrap items-center gap-1.5 min-h-[2rem]">
                                        {modelsList.length === 0 && (
                                            <span className="text-xs text-muted-foreground/60">
                                                {t('modelProviders.noModelsSelected')}
                                            </span>
                                        )}
                                        {modelsList.map((m) => (
                                            <span
                                                key={m}
                                                className={cn(
                                                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-xs',
                                                    form.defaultModel === m
                                                        ? 'border-amber-500/50 bg-amber-500/10'
                                                        : 'border-primary/40 bg-primary/5',
                                                )}
                                            >
                                                {m}
                                                {/* 星标 = 设为默认模型（单选语义，写入 defaultModel 字段） */}
                                                <button
                                                    type="button"
                                                    onClick={() => toggleDefaultModel(m)}
                                                    className={cn(
                                                        'transition-colors',
                                                        form.defaultModel === m
                                                            ? 'text-amber-500'
                                                            : 'text-muted-foreground/40 hover:text-amber-500',
                                                    )}
                                                    title={form.defaultModel === m
                                                        ? t('modelProviders.unsetDefault')
                                                        : t('modelProviders.setDefault')}
                                                >
                                                    <Star
                                                        className={cn('h-3 w-3', form.defaultModel === m && 'fill-current')}/>
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => removeModel(m)}
                                                    className="text-muted-foreground hover:text-destructive"
                                                    title={t('modelProviders.removeModel')}
                                                >
                                                    <X className="h-3 w-3"/>
                                                </button>
                                            </span>
                                        ))}
                                    </div>
                                    {/* 手动添加 */}
                                    <Input
                                        value={modelInput}
                                        onChange={(e) => setModelInput(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                addModel(modelInput);
                                                setModelInput('');
                                            }
                                        }}
                                        placeholder={t('modelProviders.addModelPlaceholder')}
                                        className="font-mono"
                                    />
                                    {/* 默认模型 */}
                                    <div>
                                        <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                                            {t('modelProviders.defaultModel')}
                                            <span className="ml-2 font-normal text-muted-foreground/60">
                                                {t('modelProviders.defaultModelHint')}
                                            </span>
                                        </label>
                                        {modelsList.length > 0 ? (
                                            <select
                                                value={form.defaultModel}
                                                onChange={(e) => setField('defaultModel', e.target.value)}
                                                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                            >
                                                <option value="">{t('modelProviders.defaultModelNone')}</option>
                                                {modelsList.map((m) => (
                                                    <option key={m} value={m}>{m}</option>
                                                ))}
                                            </select>
                                        ) : (
                                            <Input
                                                value={form.defaultModel}
                                                onChange={(e) => setField('defaultModel', e.target.value)}
                                                placeholder="deepseek-chat / …"
                                                className="font-mono"
                                            />
                                        )}
                                    </div>
                                </section>

                                {/* ── 分区：高级（折叠，默认收起；卡片化与其他分区一致） ── */}
                                <details className="rounded-xl glass-card">
                                    <summary
                                        className="cursor-pointer select-none px-4 py-2.5 text-xs font-medium text-muted-foreground">
                                        {t('modelProviders.sectionAdvanced')}
                                    </summary>
                                    <div className="px-4 pb-4">
                                        <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                                            {t('modelProviders.env')}
                                        </label>
                                        <textarea
                                            value={form.env}
                                            onChange={(e) => setField('env', e.target.value)}
                                            placeholder={t('modelProviders.envPlaceholder')}
                                            rows={3}
                                            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                                        />
                                    </div>
                                </details>

                                {/* ── 测试连接结果（绿色成功 / 红色失败） ── */}
                                {testResult && (
                                    <div
                                        className={cn(
                                            'flex items-start gap-2 rounded-lg border p-2.5 text-xs',
                                            testResult.ok
                                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
                                                : 'border-destructive/50 bg-destructive/10 text-destructive',
                                        )}
                                    >
                                        {testResult.ok
                                            ? <span className="mt-px flex-shrink-0">✓</span>
                                            : <AlertCircle className="h-3.5 w-3.5 mt-px flex-shrink-0"/>}
                                        <p>{testResult.message}</p>
                                    </div>
                                )}

                                {/* ── 底部操作 ── */}
                                <div className="flex items-center gap-2 border-t border-border/60 pt-3">
                                    <input
                                        type="checkbox"
                                        checked={form.enabled}
                                        onChange={(e) => setField('enabled', e.target.checked)}
                                        className="rounded border-input"
                                        id="provider-enabled-check"
                                    />
                                    <label htmlFor="provider-enabled-check" className="text-sm">
                                        {t('modelProviders.enabled')}
                                    </label>
                                    <div className="ml-auto flex gap-2">
                                        {/* 测试连接：用表单当前凭据探测，不落盘 */}
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={testConnection}
                                            disabled={testingForm}
                                        >
                                            {testingForm
                                                ? <Loader2 className="h-4 w-4 mr-1 animate-spin"/>
                                                : <PlugZap className="h-4 w-4 mr-1"/>}
                                            {testingForm
                                                ? t('modelProviders.testing')
                                                : t('modelProviders.testConnection')}
                                        </Button>
                                        <Button onClick={handleSave} size="sm" disabled={saving}>
                                            {saving
                                                ? <Loader2 className="h-4 w-4 mr-1 animate-spin"/>
                                                : <Save className="h-4 w-4 mr-1"/>}
                                            {creating ? t('common.create') : t('common.save')}
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={cancelForm}>
                                            <X className="h-4 w-4 mr-1"/>
                                            {t('common.cancel')}
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </Card>
                ) : (
                    <Card className="flex-1 flex items-center justify-center">
                        <div className="flex flex-col items-center gap-3">
                            <Cpu className="h-10 w-10 text-muted-foreground/30"/>
                            <p className="text-sm text-muted-foreground">{t('modelProviders.emptyState')}</p>
                        </div>
                    </Card>
                )}
            </div>
        </div>
    );
}
