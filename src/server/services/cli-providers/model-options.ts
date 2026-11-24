/**
 * @file model-options.ts
 * @description 模型选项合并的共享工具——把 models.json 中某引擎记录的模型并入档位列表。
 * claude 与 codex 两个 Provider 的 loadModelOptions 共用（pi 走 RPC 子进程自行合并）。
 */

/**
 * 将自有模型供应商配置（models.json 的对应引擎记录）中的模型合并进档位下拉。
 *
 * settings/config.toml 已有的条目保持原样置前；记录里的 models 追加在后，
 * value=label=model=具体模型名（引擎的 model 参数可直接解析，运行时下发）。
 * defaultModel 置顶；与已有条目实际模型重名或列表内重复的项跳过。
 *
 * @returns 新的 tiers 数组（不修改入参）
 */
export function mergeOwnModelsIntoTiers(
    tiers: Array<{value: string; label: string; model: string}>,
    record: {models?: string[]; defaultModel?: string} | undefined | null,
): Array<{value: string; label: string; model: string}> {
    if (!record || (record.models === undefined && !record.defaultModel)) return tiers;
    const result = [...tiers];
    const known = new Set(result.map((t) => t.model));
    const seen = new Set<string>();

    // defaultModel 置顶
    const models = [...(record.models ?? [])];
    if (record.defaultModel) {
        const idx = models.indexOf(record.defaultModel);
        if (idx > 0) models.splice(idx, 1);
        if (idx !== 0) models.unshift(record.defaultModel);
    }

    for (const m of models) {
        if (!m || seen.has(m) || known.has(m) || result.some((t) => t.value === m)) continue;
        seen.add(m);
        result.push({value: m, label: m, model: m});
    }
    return result;
}
