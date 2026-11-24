/**
 * @file ModelPicker.tsx
 * @description 输入框工具栏的引擎/模型精简选择器（弹层向上展开，适配页面底部的输入区）。
 *   - 引擎区：来自 providerCatalog，切换调 POST /system/cli-provider/select，
 *     成功后同步 store 并刷新模型配置与档位数据；
 *   - 模型区（按引擎区分优先级）：
 *       pi     → piMeta.availableModels（按当前 modelProvider 过滤）；
 *       custom → providerCatalog 条目的 meta.models；
 *       其余   → availableModels[active].tiers（label 显示「档位 → 实际模型名」）；
 *   - 底部「高级配置…」打开 Layout 常驻挂载的 ModelConfigModal（经 store 的
 *     cliProvider.showModelConfigModal 驱动）。
 *   - custom 引擎若在供应商配置中标记了默认模型（meta.defaultModel），
 *     该模型在下拉中置顶并带星标 + 「默认」徽标。
 *   按钮显示「引擎Label · 模型Label」；模型显示名解析镜像 Layout 顶栏（档位别名 → 实际模型名）。
 */

import {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {AnimatePresence, motion} from 'framer-motion';
import {Check, ChevronDown, Cpu, Loader2, Settings2, Star} from 'lucide-react';
import {apiPost} from '../../api';
import {cn} from '../../lib/utils';
import {useAppStore} from '../../stores/app-store';

export function ModelPicker() {
    const {t} = useTranslation();
    const active = useAppStore(s => s.cliProvider.active);
    const modelConfig = useAppStore(s => s.cliProvider.modelConfig);
    const providerCatalog = useAppStore(s => s.providerCatalog);
    const availableModels = useAppStore(s => s.availableModels);
    const piMeta = useAppStore(s => s.piMeta);
    const setCliProvider = useAppStore(s => s.setCliProvider);
    const setModelConfig = useAppStore(s => s.setModelConfig);
    const saveModelConfig = useAppStore(s => s.saveModelConfig);
    const fetchAvailableModels = useAppStore(s => s.fetchAvailableModels);
    const fetchModelConfig = useAppStore(s => s.fetchModelConfig);
    const setShowModelConfigModal = useAppStore(s => s.setShowModelConfigModal);

    const [open, setOpen] = useState(false);
    const [switching, setSwitching] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // 点击外部关闭（镜像 Layout 主题菜单的 ref + mousedown 模式）
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    // 每次打开都重新拉取档位/模型列表：后端实时读 models.json，供应商页新增的模型
    // 即时可见（此前只在无缓存时拉一次，拉过之后新增模型永远不出现在下拉里）
    useEffect(() => {
        if (open) void fetchAvailableModels();
    }, [open, fetchAvailableModels]);

    const entry = providerCatalog.find(p => p.id === active);
    const config = modelConfig[active] ?? {};
    const tiers = availableModels[active]?.tiers;

    // custom 引擎的模型列表在 meta.models（store 中 meta 为 unknown，做安全收窄）；
    // meta.defaultModel 来自供应商配置（供应商页「设为默认」），用于置顶标注
    const meta = entry?.meta as {kind?: unknown; models?: unknown; defaultModel?: unknown} | undefined;
    const rawModels = Array.isArray(meta?.models) ? meta.models : [];
    const customModels = rawModels.filter((m): m is string => typeof m === 'string');
    const defaultModel = typeof meta?.defaultModel === 'string' && meta.defaultModel ? meta.defaultModel : undefined;

    // 模型显示名：档位别名 → 实际模型名（镜像 Layout 顶栏解析）；pi 引擎用 piMeta 匹配 name
    const rawModel = config.model ?? '';
    const tier = tiers?.find(item => item.value === rawModel);
    const piModel = entry?.id === 'pi'
        ? (piMeta?.availableModels ?? []).find(m => m.id === rawModel)
        : undefined;
    const modelLabel = tier?.model ?? piModel?.name ?? rawModel;

    const modelOptions: Array<{value: string; label: string}> =
        entry?.id === 'pi'
            ? (piMeta?.availableModels ?? [])
                .filter(m => m.provider === config.modelProvider)
                .map(m => ({value: m.id, label: m.name || m.id}))
            : meta?.kind === 'custom'
                ? customModels.map(m => ({value: m, label: m}))
                : (tiers ?? []).map(item => ({
                    value: item.value,
                    // 具体模型名（来自模型供应商页）value === model，只显示模型名；档位别名显示「档位 → 实际模型」
                    label: item.value === item.model ? item.model : `${item.label} → ${item.model}`,
                }));

    // 默认模型置顶（稳定排序，其余保持原顺序）
    const orderedModels: Array<{value: string; label: string}> = defaultModel
        ? [...modelOptions].sort(
            (a, b) => Number(b.value === defaultModel) - Number(a.value === defaultModel),
        )
        : modelOptions;

    /** 切换引擎：后端选择成功后同步 store 并刷新模型配置与档位；期间禁用整个选择器 */
    const selectProvider = async (id: string) => {
        if (id === active || switching) return;
        setSwitching(true);
        try {
            await apiPost('/system/cli-provider/select', {providerId: id});
            setCliProvider(true, id);
            await fetchModelConfig();
            await fetchAvailableModels();
        } catch (err) {
            console.error('ModelPicker: switch provider failed', err);
        } finally {
            setSwitching(false);
        }
    };

    /** 选择模型：乐观写 store，再持久化到后端 */
    const selectModel = async (model: string) => {
        setModelConfig(active, {model});
        try {
            await saveModelConfig(active, {...config, model});
        } catch (err) {
            console.error('ModelPicker: save model failed', err);
        }
        setOpen(false);
    };

    return (
        <div className="relative" ref={rootRef}>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                disabled={switching}
                title={`${entry?.label ?? active} · ${modelLabel || '—'}`}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-popover/60 px-2 text-[11px]
                    font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors max-w-44
                    disabled:opacity-50"
            >
                <Cpu className="h-3.5 w-3.5 shrink-0"/>
                <span className="truncate">{entry?.label ?? active} · {modelLabel || '—'}</span>
                {switching
                    ? <Loader2 className="h-3 w-3 shrink-0 animate-spin"/>
                    : <ChevronDown className="h-3 w-3 shrink-0"/>}
            </button>
            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{opacity: 0, y: 4}}
                        animate={{opacity: 1, y: 0}}
                        exit={{opacity: 0, y: 4}}
                        transition={{duration: 0.15}}
                        className="absolute bottom-full mb-2 left-0 z-[500] w-64 rounded-lg border border-border bg-popover p-1 shadow-apple-lg"
                    >
                        <p className="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {t('common.chatInput.engine')}
                        </p>
                        {providerCatalog.map(p => (
                            <button
                                key={p.id}
                                type="button"
                                onClick={() => void selectProvider(p.id)}
                                disabled={switching}
                                className={cn(
                                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors disabled:opacity-50',
                                    p.id === active
                                        ? 'bg-accent text-foreground font-medium'
                                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                                )}
                            >
                                {p.id === active ? <Check className="h-3.5 w-3.5"/> : <span className="w-3.5"/>}
                                <span className="truncate">{p.label}</span>
                                {!p.available && (
                                    <span className="ml-auto text-[10px] text-amber-500">{t('common.chatInput.notDetected')}</span>
                                )}
                            </button>
                        ))}
                        {modelOptions.length > 0 && (
                            <>
                                <div className="my-1 h-px bg-border/60"/>
                                <p className="px-2 pt-0.5 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {t('common.chatInput.model')}
                                </p>
                                <div className="max-h-56 overflow-y-auto">
                                    {orderedModels.map(m => (
                                        <button
                                            key={m.value}
                                            type="button"
                                            onClick={() => void selectModel(m.value)}
                                            className={cn(
                                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                                                m.value === config.model
                                                    ? 'bg-accent text-foreground font-medium'
                                                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                                            )}
                                        >
                                            {m.value === config.model ? <Check className="h-3.5 w-3.5"/> : <span className="w-3.5"/>}
                                            <span className="truncate">{m.label}</span>
                                            {/* 默认模型标注：星标 + 徽标（该模型已置顶） */}
                                            {m.value === defaultModel && (
                                                <span
                                                    className="ml-auto inline-flex flex-shrink-0 items-center gap-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] text-amber-500"
                                                >
                                                    <Star className="h-2.5 w-2.5 fill-current"/>
                                                    {t('common.chatInput.defaultModelBadge')}
                                                </span>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                        <div className="my-1 h-px bg-border/60"/>
                        <button
                            type="button"
                            onClick={() => { setOpen(false); setShowModelConfigModal(true); }}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        >
                            <Settings2 className="h-3.5 w-3.5"/>
                            {t('common.chatInput.openModelConfig')}
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
