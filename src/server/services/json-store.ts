/**
 * @module json-store
 * @description JSON 文件存储通用基类
 *
 * 提供基于 JSON 文件的记录数组持久化存储的通用实现。
 * 所有记录必须包含 `id: string` 字段用于唯一标识。
 *
 * 内置功能：
 * - 目录自动创建（ensureDir）
 * - 容错加载（文件缺失/JSON 损坏时返回空数组）
 * - 保存时排序 + 截断（防止文件无限增长）
 * - 标准 CRUD：list / get / upsert / delete
 *
 * 子类继承后只需声明数据接口和存储配置即可获得完整 CRUD 能力。
 * 可通过覆盖 protected 方法实现自定义排序、upsert 自动填充等行为。
 */
import fs from 'fs';
import path from 'path';
import {writeFileAtomic} from '../utils/fs-utils.js';

/** JSON 存储配置 */
export interface JsonStoreConfig {
    /** 存储文件默认路径 */
    defaultPath: string;
    /** 最大记录数，Infinity 表示不限制 */
    maxRecords: number;
    /** 排序字段（日期类型字段名），留空则不排序 */
    sortField?: string;
}

/**
 * JSON 文件存储基类
 *
 * 封装了 JSON 文件持久化的通用逻辑：目录创建、容错读取、排序截断写入和 CRUD 操作。
 * 子类通过构造函数传入配置（文件路径、记录上限、排序字段）即可复用全部能力。
 *
 * @typeParam T - 记录类型，必须包含 `id: string` 字段
 *
 * @example
 * ```typescript
 * interface MyItem { id: string; name: string; createdAt: string }
 *
 * class MyStore extends JsonStore<MyItem> {
 *   constructor(file?: string) {
 *     super({ defaultPath: '/path/to/items.json', maxRecords: 50, sortField: 'createdAt' }, file);
 *   }
 * }
 * ```
 */
export class JsonStore<T extends { id: string }> {
    protected readonly storeFile: string;
    private readonly maxRecords: number;
    private readonly sortField: string | undefined;

    constructor(config: JsonStoreConfig, storeFile?: string) {
        this.storeFile = storeFile ?? config.defaultPath;
        this.maxRecords = config.maxRecords;
        this.sortField = config.sortField;
    }

    /** 确保存储目录存在，不存在则递归创建 */
    protected ensureDir(): void {
        const dir = path.dirname(this.storeFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, {recursive: true});
        }
    }

    /**
     * 从磁盘加载记录数组（容错处理）
     *
     * 容错策略：
     * - 文件不存在时返回空数组
     * - JSON 解析失败时静默返回空数组
     * - 解析结果不是数组时返回空数组
     */
    protected load(): T[] {
        if (!fs.existsSync(this.storeFile)) return [];
        try {
            const raw = fs.readFileSync(this.storeFile, 'utf-8');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    /**
     * 保存记录数组到磁盘
     *
     * 保存前自动按配置的 sortField 倒序排列，并截断到 maxRecords 条。
     * 原子写（tmp + rename）：进程内所有 CRUD 均为同步操作天然串行，这里
     * 防的是写盘中途崩溃/被并发读到的撕裂 JSON（详见 utils/fs-utils.ts）。
     * 子类可覆盖此方法实现自定义保存逻辑。
     */
    protected save(items: T[]): void {
        this.ensureDir();
        const sorted = this.sortByField(items);
        const trimmed = this.maxRecords < Infinity
            ? sorted.slice(0, this.maxRecords)
            : sorted;
        writeFileAtomic(this.storeFile, JSON.stringify(trimmed, null, 2));
    }

    /** 按 sortField 倒序排列（原地排序） */
    private sortByField(items: T[]): T[] {
        if (!this.sortField) return items;
        return items.sort((a, b) => {
            const aVal = (a as Record<string, unknown>)[this.sortField!] as string;
            const bVal = (b as Record<string, unknown>)[this.sortField!] as string;
            return new Date(bVal).getTime() - new Date(aVal).getTime();
        });
    }

    /**
     * 列出所有记录（按 sortField 倒序）
     * @param limit - 可选，限制返回数量
     */
    list(limit?: number): T[] {
        const sorted = this.sortByField(this.load());
        return limit ? sorted.slice(0, limit) : sorted;
    }

    /** 根据 ID 获取单条记录 */
    get(id: string): T | undefined {
        return this.load().find(item => item.id === id);
    }

    /** 创建或更新记录（Upsert 语义） */
    upsert(item: T): T {
        const items = this.load();
        const idx = items.findIndex(i => i.id === item.id);
        if (idx >= 0) {
            items[idx] = item;
        } else {
            items.push(item);
        }
        this.save(items);
        return item;
    }

    /** 根据 ID 删除记录 */
    delete(id: string): boolean {
        const items = this.load();
        const idx = items.findIndex(i => i.id === id);
        if (idx < 0) return false;
        items.splice(idx, 1);
        this.save(items);
        return true;
    }
}
