/**
 * @file 开发计划管理路由模块
 * @module routes/plan
 * @description 提供开发计划（Plan）相关的 RESTful API 路由，涵盖：
 *              - 基于需求自动生成开发计划（通过 Claude CLI 桥接）
 *              - 计划列表查询、状态查看、内容更新与删除
 *              - 计划生成过程中的多轮对话回复支持
 *              - 计划数据同时存储在内存缓存（快速访问）和文件持久化层（持久存储）
 *              - 支持从 Pipeline 配置中解析计划阶段所需的技能（Skills）
 */

import {Router} from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
import XLSX from 'xlsx';
import {CLIRunnerService} from '../services/cli-runner-service.js';
import {RequirementAgentFetchService} from '../services/requirement-agent-fetch.js';
import {MCPRegistryService} from '../services/mcp-registry-service.js';
import {PipelineService} from '../services/pipeline-service.js';
import {validateBody, validateWorkspacePath, validateOutputPath} from '../middleware/validation.js';
import {broadcast} from '../websocket.js';
import {PlanStoreService, type PersistedPlan} from '../services/plan-store-service.js';
import {RequirementStoreService} from '../services/requirement-store-service.js';
import {getPhaseSkills, getPhaseMcpServers, resolveMcpServerMap} from '../utils/skill-utils.js';
import type {McpServerMap} from '../services/cli-providers/types.js';
import type {MemoryService} from '../services/memory/memory-service.js';
import type {MinerUService} from '../services/mineru-service.js';
import type {AttachmentStore} from '../services/attachment-store.js';
import {formatAttachmentsBlock} from '../services/attachment-store.js';
import {enrichPrompt} from '../utils/prompt-enrichment.js';
import {renderPrompt} from '../utils/prompt-renderer.js';
import {PROMPTS} from '../prompts/index.js';
import {getErrorMessage} from '../utils/error-utils.js';
import {LruCache} from '../utils/lru-cache.js';
import {processToolOutput} from '../utils/tool-log.js';
import {extractJsonArray, extractJsonObject} from '../utils/structured-json.js';
import {validateShape, type FieldSpec, type ValidationResult} from '../utils/json-validator.js';
import {runBridgeJson, withOutputTimeout} from '../utils/bridge-json-runner.js';

/**
 * @type {PersistedPlan}
 * @description 向后兼容的类型别名，导出给 execution 路由模块使用。
 *              新代码应直接使用 PersistedPlan 类型。
 */
export type StoredPlan = PersistedPlan;

/** Bridge 无输出容忍时长（活动看门狗：有输出即重置，仅真正沉寂时中止） */
const BRIDGE_TIMEOUT_MS = 30 * 60 * 1000;

/** 任务导出 JSON 单行结构（技能输出） */
interface TaskExportRow {
    title?: string;
    description?: string;
    assignee?: string;
    workItemType?: string;
    priority?: string;
    estimatedHours?: number | string;
    startDate?: string;
    endDate?: string;
    taskType?: string;
    complexity?: string;
    taskId?: string;
    project?: string;
    product?: string;

    [k: string]: unknown;
}

/** 列名 → 枚举值数组 */
type DropdownMap = Record<string, string[]>;

/** 列名 → 数组下标的映射 */
const HEADER_ALIASES: Record<string, string[]> = {
    '需求号ID': ['requirementId', '需求号', '需求号ID'],
    '任务ID（如有）': ['taskId', '任务ID', '任务编号'],
    '标题': ['title', '标题', 'name'],
    '描述': ['description', '描述', 'desc', 'detail'],
    '负责人': ['assignee', '负责人', 'owner'],
    '状态': ['status', '状态'],
    '所属项目': ['project', '所属项目', 'projectName'],
    '所属产品': ['product', '所属产品', 'productName'],
    '工作项类型': ['workItemType', '工作项类型', 'type', 'itemType'],
    '优先级': ['priority', '优先级'],
    '预估工时（小时）': ['estimatedHours', '预估工时', 'hours', 'effort'],
    '计划开始日期': ['startDate', '计划开始日期', 'start'],
    '计划完成日期': ['endDate', '计划完成日期', 'end', 'due'],
    '任务拆解类型': ['taskType', '任务拆解类型', 'category'],
    '任务复杂度': ['complexity', '任务复杂度', 'difficulty'],
    '需求开发主程': ['devLead', '需求开发主程'],
    '需求测试主程': ['testLead', '需求测试主程'],
};

/**
 * 从 markdown 表格提取任务行。
 * 表头按 TaskExportRow 别名映射，单元格按列对齐。
 * 跳过分隔行（|---|---|）。
 */
function parseMarkdownTable(raw: string): TaskExportRow[] {
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.startsWith('|') && l.endsWith('|'));
    if (lines.length < 2) return [];

    // 反向索引：alias 值 → field key（中文表头也能匹配到 field）
    const aliasToField: Record<string, string> = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        aliasToField[field] = field;
        for (const a of aliases) aliasToField[a] = field;
    }

    // canonical "标题" field key（aliases 含 'title'）
    const titleFieldKey = Object.keys(HEADER_ALIASES).find(k => HEADER_ALIASES[k].includes('title'))!;
    const descFieldKey = Object.keys(HEADER_ALIASES).find(k => HEADER_ALIASES[k].includes('description'))!;

    // 找同时含"标题"+"描述"列的表头行
    let headerLineIdx = -1;
    let colIndex: Record<string, number> = {};
    for (let i = 0; i < lines.length; i++) {
        const cells = lines[i].split('|').slice(1, -1).map(c => c.trim());
        if (cells.every(c => /^[-:]+$/.test(c) || c === '')) continue;
        const fields = cells.map(c => aliasToField[c]).filter(Boolean);
        if (fields.includes(titleFieldKey) && fields.includes(descFieldKey)) {
            headerLineIdx = i;
            cells.forEach((h, idx) => {
                const f = aliasToField[h];
                if (f && colIndex[f] === undefined) colIndex[f] = idx;
            });
            break;
        }
    }

    if (headerLineIdx < 0) return [];

    const rows: TaskExportRow[] = [];
    for (let i = headerLineIdx + 1; i < lines.length; i++) {
        const cells = lines[i].split('|').slice(1, -1).map(c => c.trim());
        if (cells.every(c => /^[-:]+$/.test(c) || c === '')) continue;
        // 下一个表头行（含 title 列 + 5+ 匹配列）则停止
        if (cells.some(c => aliasToField[c] === titleFieldKey) && cells.filter(c => aliasToField[c]).length >= 5) {
            break;
        }

        const row: Record<string, unknown> = {};
        for (const [field, idx] of Object.entries(colIndex)) {
            const val = cells[idx];
            if (val !== undefined && val !== '' && val !== '—') {
                row[field] = val;
            }
        }
        // 有效行：标题或描述非空
        if (row[titleFieldKey] || row[descFieldKey]) {
            rows.push(row as TaskExportRow);
        }
    }
    return rows;
}

/**
 * 任务行 JSON 校验规格（title 必填，其余字段宽松）。
 * estimatedHours 有意不校验：buildExportRow 的 pick() 已兼容 number|string，避免类型校验误杀。
 */
const TASK_ROW_SPEC: Record<string, FieldSpec> = {
    title: {type: 'string', required: true, minLength: 1},
    description: {type: 'string', required: false},
    assignee: {type: 'string', required: false},
    workItemType: {type: 'string', required: false},
    priority: {type: 'string', required: false},
    taskType: {type: 'string', required: false},
    complexity: {type: 'string', required: false},
    taskId: {type: 'string', required: false},
    project: {type: 'string', required: false},
    product: {type: 'string', required: false},
    status: {type: 'string', required: false},
    startDate: {type: 'string', required: false},
    endDate: {type: 'string', required: false},
    devLead: {type: 'string', required: false},
    testLead: {type: 'string', required: false},
};

/**
 * 过滤并校验 JSON 任务行数组。
 * 结构不匹配但含可识别内容的行（如旧数据中文 key）宽容保留并告警；
 * 非对象 / 空对象行丢弃（打 console.warn，不再静默）。
 */
function filterTaskRows(rows: unknown[]): TaskExportRow[] {
    const out: TaskExportRow[] = [];
    rows.forEach((row, i) => {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
            console.warn(`[plan:extractTasks] 任务行 ${i} 非对象，已丢弃`);
            return;
        }
        const rec = row as Record<string, unknown>;
        const vr = validateShape(row, TASK_ROW_SPEC);
        if (vr.ok) {
            out.push(rec as TaskExportRow);
            return;
        }
        // 宽容保留：含非空字符串/数字值即可（buildExportRow 按 HEADER_ALIASES 映射中文 key）
        const hasUsable = Object.keys(rec).some(k => {
            const v = rec[k];
            return (typeof v === 'string' && v.trim().length > 0) || typeof v === 'number';
        });
        if (hasUsable) {
            console.warn(`[plan:extractTasks] 任务行 ${i} 结构不匹配，宽容保留: ${vr.errors.join('; ')}`);
            out.push(rec as TaskExportRow);
        } else {
            console.warn(`[plan:extractTasks] 任务行 ${i} 无效，已丢弃: ${vr.errors.join('; ')}`);
        }
    });
    return out;
}

/**
 * 从 raw text 提取任务列表。
 * 优先 JSON（数组或 {tasks:[]}，逐行 schema 校验），降级 markdown 表格。
 */
function extractTasksFromOutput(raw: string): TaskExportRow[] | null {
    if (!raw) return null;

    // 1. JSON 数组
    const arr = extractJsonArray(raw);
    if (arr) {
        const rows = filterTaskRows(arr);
        if (rows.length) return rows;
    }

    // 2. JSON 对象 {tasks: [...]}
    const obj = extractJsonObject(raw);
    if (obj && Array.isArray(obj.tasks)) {
        const rows = filterTaskRows(obj.tasks);
        if (rows.length) return rows;
    }

    // 3. markdown 表格（技能默认输出格式，兼容存量数据）
    const mdTasks = parseMarkdownTable(raw);
    return mdTasks.length ? mdTasks : null;
}

/**
 * export-tasks 结构化输出校验器（runBridgeJson 用，松校验）：
 * 接受任务行数组或 {tasks:[...]}，每项须为含 title（或中文「标题」）的对象。
 */
function taskRowsValidator(value: unknown): ValidationResult {
    const obj = value as Record<string, unknown> | null;
    const rows: unknown[] | null = Array.isArray(value)
        ? (value as unknown[])
        : (obj && typeof obj === 'object' && Array.isArray(obj.tasks) ? (obj.tasks as unknown[]) : null);
    if (!rows) return {ok: false, errors: ['输出应为任务行数组或 {tasks: [...]}']};
    if (rows.length === 0) return {ok: false, errors: ['任务列表为空']};

    const errors: string[] = [];
    rows.forEach((row, i) => {
        if (typeof row !== 'object' || row === null) {
            errors.push(`tasks[${i}]: 应为对象`);
            return;
        }
        const rec = row as Record<string, unknown>;
        const hasTitle = typeof rec.title === 'string' && rec.title.trim() !== '';
        const hasCnTitle = typeof rec['标题'] === 'string' && rec['标题'].trim() !== '';
        if (!hasTitle && !hasCnTitle) errors.push(`tasks[${i}].title: 必填非空 string`);
    });
    return errors.length === 0
        ? {ok: true, value: value as Record<string, unknown>, errors: []}
        : {ok: false, errors};
}

/**
 * 解析「下拉字段」sheet，返回列名 → 枚举值数组。
 * 第 0 行是表头（列名），后续行是枚举值。
 */
function parseDropdowns(sheet: XLSX.WorkSheet): DropdownMap {
    if (!sheet) return {};
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {header: 1});
    if (!rows.length) return {};
    const headers = rows[0] as string[];
    const result: DropdownMap = {};
    for (let col = 0; col < headers.length; col++) {
        const name = headers[col]?.trim();
        if (!name) continue;
        const values: string[] = [];
        for (let r = 1; r < rows.length; r++) {
            const v = (rows[r] as unknown[])[col];
            if (typeof v === 'string' && v.trim()) values.push(v.trim());
            else if (typeof v === 'number') values.push(String(v));
        }
        result[name] = values;
    }
    return result;
}

/** 在枚举数组中找最接近的值（大小写不敏感包含匹配），找不到返回空字符串 */
function matchClosestEnum(value: string, enumValues: string[]): string {
    if (!value) return '';
    const lower = value.toLowerCase().trim();
    // 精确匹配
    const exact = enumValues.find(v => v.toLowerCase() === lower);
    if (exact) return exact;
    // 包含匹配
    const contains = enumValues.find(v => v.toLowerCase().includes(lower) || lower.includes(v.toLowerCase()));
    return contains ?? '';
}

/** 取字段值（按别名优先级） */
function pick(row: TaskExportRow, aliases: string[]): string {
    for (const a of aliases) {
        const v = (row as Record<string, unknown>)[a];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
    }
    return '';
}

/** 构造单行导出数据（按 headers 顺序，下拉列做枚举校验） */
function buildExportRow(
    task: TaskExportRow,
    index: number,
    headers: string[],
    dropdowns: DropdownMap,
    ctx: { requirementId: string; project: string; devLead: string; testLead: string },
): Record<string, unknown> {
    const rowObj: Record<string, unknown> = {};
    headers.forEach(h => {
        const aliases = HEADER_ALIASES[h] ?? [];
        let value = pick(task, aliases);

        // 上下文覆盖（任务的来源需求 = 新模板第1列，语义同需求号ID）
        if ((h === '需求号ID' || h === '任务的来源需求') && !value) value = ctx.requirementId;
        if (h === '所属项目' && !value) value = ctx.project;
        if (h === '需求开发主程' && !value) value = ctx.devLead;
        if (h === '需求测试主程' && !value) value = ctx.testLead;
        if (h === '任务ID（如有）' && !value) value = String(index);

        // 下拉列：必须用枚举值，不在则匹配最接近，仍找不到则留空
        if (dropdowns[h] && dropdowns[h].length > 0) {
            value = matchClosestEnum(value, dropdowns[h]);
        }

        // 工时转数字
        if (h === '预估工时（小时）' && value) {
            const n = Number(value);
            rowObj[h] = isNaN(n) ? value : n;
            return;
        }

        rowObj[h] = value;
    });
    return rowObj;
}

/**
 * XML 注入器：直接改模板 sheet1.xml + sharedStrings.xml，保全部样式/下拉/主题。
 * 比 exceljs 稳 — exceljs 重排 style 索引导致样式丢失。
 *
 * @param templatePath - 模板 xlsx 路径
 * @param outputPath - 输出 xlsx 路径
 * @param headers - 表头列名（17 列，对应 A-Q）
 * @param rows - 数据行（key=列名，value=单元格值）
 */
function injectTasksToTemplate(
    templatePath: string,
    outputPath: string,
    headers: string[],
    rows: Record<string, unknown>[],
): void {
    // 1. 拷贝模板 → 输出
    fs.copyFileSync(templatePath, outputPath);
    const zip = new AdmZip(outputPath);

    // 2. 解析 sharedStrings，建立 text → index 反查
    const ssXml = zip.readAsText('xl/sharedStrings.xml');
    const ssMatch = ssXml.match(/<sst[^>]*count="(\d+)"\s+uniqueCount="(\d+)"/);
    const strings: string[] = [];
    const stringToIndex: Record<string, number> = {};
    const siRegex = /<si>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = siRegex.exec(ssXml)) !== null) {
        // 提取 <t>...</t> 文本（合并多段 <t>）
        const textParts = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
        const text = textParts.map(t => t.replace(/<t[^>]*>/, '').replace(/<\/t>/, '')).join('');
        strings.push(text);
        if (stringToIndex[text] === undefined) stringToIndex[text] = idx;
        idx++;
    }

    /** 取/创建 sharedString 索引 */
    const getOrAddString = (text: string): number => {
        if (stringToIndex[text] !== undefined) return stringToIndex[text];
        const i = strings.length;
        strings.push(text);
        stringToIndex[text] = i;
        return i;
    };

    /** 列号 → 字母（1 → A，17 → Q） */
    const colLetter = (n: number): string => {
        let s = '';
        while (n > 0) {
            const r = (n - 1) % 26;
            s = String.fromCharCode(65 + r) + s;
            n = Math.floor((n - 1) / 26);
        }
        return s;
    };

    /** XML 转义 */
    const escapeXml = (s: string): string => s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // 3. 生成数据行 XML
    const rowXmlArr: string[] = [];
    rows.forEach((row, rIdx) => {
        const rowNum = rIdx + 2; // 从第 2 行开始
        const cells: string[] = [];
        headers.forEach((h, cIdx) => {
            const colNum = cIdx + 1;
            const ref = `${colLetter(colNum)}${rowNum}`;
            const val = row[h];
            if (val === undefined || val === null || val === '') {
                // 空单元格不输出（保留下拉验证规则原样）
                return;
            }
            // 数字（工时）
            if (typeof val === 'number' || (/^-?\d+(\.\d+)?$/.test(String(val)) && h.includes('工时'))) {
                cells.push(`<c r="${ref}"><v>${Number(val)}</v></c>`);
                return;
            }
            // 字符串 → sharedString
            const str = String(val);
            const sIdx = getOrAddString(str);
            cells.push(`<c r="${ref}" t="s"><v>${sIdx}</v></c>`);
        });
        if (cells.length > 0) {
            rowXmlArr.push(`<row r="${rowNum}" spans="1:${headers.length}">${cells.join('')}</row>`);
        }
    });

    // 4. 替换 sheet1.xml 的 sheetData
    let sheetXml = zip.readAsText('xl/worksheets/sheet1.xml');
    const newData = `<sheetData><row r="1" ht="18" customHeight="1" spans="1:17">${/* 保留表头行原样 */ ''}</row>${rowXmlArr.join('')}</sheetData>`;
    // 提取原表头 row 1 完整内容
    const origRow1Match = sheetXml.match(/<row r="1"[^>]*>[\s\S]*?<\/row>/);
    const origRow1 = origRow1Match ? origRow1Match[0] : '';
    const finalSheetData = `<sheetData>${origRow1}${rowXmlArr.join('')}</sheetData>`;
    sheetXml = sheetXml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, finalSheetData);

    // 更新 dimension
    const lastRow = rows.length + 1;
    sheetXml = sheetXml.replace(/<dimension ref="[^"]*"/, `<dimension ref="A1:Q${lastRow}"`);

    zip.updateFile('xl/worksheets/sheet1.xml', Buffer.from(sheetXml, 'utf-8'));

    // 5. 更新 sharedStrings
    void ssMatch; // 保留原 count 字段引用
    const newUnique = strings.length;
    const newCount = strings.length; // 简化：count = uniqueCount
    const siBlocks = strings.map(s => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('');
    const newSs = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${newCount}" uniqueCount="${newUnique}">${siBlocks}</sst>`;
    zip.updateFile('xl/sharedStrings.xml', Buffer.from(newSs, 'utf-8'));

    // 6. 写出
    zip.writeZip(outputPath);
}

/**
 * 内存缓存，用于快速访问已生成的计划数据。
 * 数据源为文件持久化存储，缓存缺失时会从文件存储中加载并回填。
 */
const planCache = new LruCache<string, PersistedPlan>(50);

/**
 * 跟踪正在生成的 plan 的 AbortController，用于 pause/abort 控制。
 */
const activeGenerations = new Map<string, AbortController>();

/**
 * 获取计划内存缓存的引用。
 * 主要供 execution 路由模块访问计划数据。
 */
export function getPlanStore(): LruCache<string, PersistedPlan> {
    return planCache;
}

/**
 * 从缓存或文件存储中查找计划，缓存未命中时自动预热
 * @param taskId - 计划任务ID
 * @param planStore - 文件存储服务实例
 * @returns 计划数据，未找到返回 undefined
 */
function findPlan(taskId: string, planStore: PlanStoreService): PersistedPlan | undefined {
    let plan = planCache.get(taskId);
    if (!plan) {
        plan = planStore.get(taskId);
        if (plan) planCache.set(plan.id, plan);
    }
    return plan;
}

/**
 * 同步持久化计划数据到缓存和文件存储
 * @param plan - 计划数据
 * @param planStore - 文件存储服务实例
 */
function persistPlan(plan: PersistedPlan, planStore: PlanStoreService): void {
    planStore.upsert(plan);
    planCache.set(plan.id, plan);
}

/**
 * 标记计划为失败状态，持久化并广播
 * @param plan - 计划数据
 * @param error - 错误信息
 * @param planStore - 文件存储服务实例
 * @param extraBroadcast - 额外的错误广播消息前缀（可选）
 */
function failPlan(
    plan: PersistedPlan,
    error: string,
    planStore: PlanStoreService,
    extraBroadcast?: string,
): void {
    plan.status = 'failed';
    plan.error = error;
    plan.updatedAt = new Date().toISOString();
    persistPlan(plan, planStore);
    activeGenerations.delete(plan.id);
    broadcast({type: 'plan:complete', data: {taskId: plan.id, status: 'failed', error}});
    if (extraBroadcast) {
        broadcast({type: 'error', data: {message: `${extraBroadcast}: ${error}`}});
    }
}

/**
 * 处理 bridge 成功返回后的状态更新
 * @param plan - 计划数据
 * @param result - bridge 返回结果
 * @param accumulatedOutput - 累积输出文本
 * @param planStore - 文件存储服务实例
 */
function finalizePlan(
    plan: PersistedPlan,
    result: { exitCode: number | null; stderr?: string; sessionId?: string },
    accumulatedOutput: string,
    planStore: PlanStoreService,
): void {
    plan.status = result.exitCode === 0 ? 'ready' : 'failed';
    plan.rawOutput = accumulatedOutput;
    plan.summary = accumulatedOutput.substring(0, 500);
    plan.updatedAt = new Date().toISOString();
    if (result.sessionId) plan.sessionId = result.sessionId;
    if (result.exitCode !== 0) {
        const stderr = result.stderr || '';
        // error_during_execution 多发于 resume 历史会话时 SDK 本地恢复失败
        // （上下文超长 / 会话状态损坏）。此时清掉失效 sessionId，下次对话自动开新会话，
        // 并给出业务化提示，避免前端只看到一句笼统的 "SDK error"。
        if (stderr.includes('error_during_execution') && plan.sessionId) {
            plan.sessionId = undefined;
            plan.error = '历史会话已失效（上下文过长或会话状态损坏），已自动重置。请重新发送消息，将以新会话继续。';
        } else {
            plan.error = stderr || 'Plan generation failed';
        }
    }
    persistPlan(plan, planStore);
    activeGenerations.delete(plan.id);
    broadcast({type: 'plan:complete', data: {taskId: plan.id, status: plan.status}});
}

/**
 * 从 Pipeline 配置中解析计划阶段的技能列表或Agent配置
 * @param pipelineId - 流水线ID
 * @param pipelineService - 流水线服务实例
 * @returns 技能列表、Agent配置对象，无配置时返回 undefined
 */
function resolvePlanSkills(
    pipelineId: string | undefined,
    pipelineService?: PipelineService,
): string[] | 'all' | undefined | { mode: 'agent'; agentId?: string } {
    if (!pipelineId || !pipelineService) return undefined;
    const pipeline = pipelineService.get(pipelineId);
    return pipeline?.steps ? getPhaseSkills(pipeline.steps, 'plan') : undefined;
}

/**
 * 从 Pipeline 配置中解析计划阶段的 MCP 服务器，转成 SDK 可用的 stdio map。
 * @returns mcpServers（undefined = 不注入，claude 走全局默认）+ missing（未找到的服务器名，调用方记 warning）
 */
function resolvePlanMcpServers(
    pipelineId: string | undefined,
    pipelineService: PipelineService | undefined,
    mcpConfigService: MCPRegistryService,
): { mcpServers: McpServerMap | undefined; missing: string[] } {
    if (!pipelineId || !pipelineService) return {mcpServers: undefined, missing: []};
    const pipeline = pipelineService.get(pipelineId);
    if (!pipeline?.steps) return {mcpServers: undefined, missing: []};
    const names = getPhaseMcpServers(pipeline.steps, 'plan');
    const {map, missing} = resolveMcpServerMap(names, mcpConfigService);
    return {mcpServers: map, missing};
}

/**
 * 解析 plan 阶段 MCP 配置并广播缺失服务器警告。返回 mcpServers map（undefined = 不注入）。
 */
function resolvePlanMcpWithWarn(
    plan: PersistedPlan,
    pipelineService: PipelineService | undefined,
    mcpConfigService: MCPRegistryService,
): McpServerMap | undefined {
    const {mcpServers, missing} = resolvePlanMcpServers(plan.pipelineId, pipelineService, mcpConfigService);
    if (missing.length > 0) {
        broadcast({type: 'error', data: {message: `MCP servers not found, skipped: ${missing.join(', ')}`}});
    }
    return mcpServers;
}

/**
 * 获取需求详情：优先从本地 store 读取已保存的版本，避免重新获取导致内容不一致
 * @param requirementId - 需求ID
 * @param reqStore - 本地需求存储服务
 * @param agentFetch - agent 中介需求拉取服务（fallback）
 * @returns 需求的 title 和 description
 */
async function getRequirementContent(
    requirementId: string,
    reqStore: RequirementStoreService,
    agentFetch: RequirementAgentFetchService,
): Promise<{ title: string; description: string }> {
    // 优先从本地已保存的需求中取（内容与 Requirements 页面展示一致；
    // 工作副本（编辑 + 解析合并的成果）优先于源描述）
    const saved = reqStore.get(requirementId);
    if (saved) {
        return {title: saved.title, description: saved.workingDescription ?? saved.description};
    }
    // 本地无缓存，fallback 到 agent 中介实时拉取
    const detail = await agentFetch.fetchByInput(requirementId);
    return {title: detail.title, description: detail.description};
}

/**
 * 执行带超时的 bridge 调用，统一处理 onOutput 回调和错误。
 */
async function runBridgeWithTimeout(
    plan: PersistedPlan,
    bridgeOptions: {
        cliRunner: CLIRunnerService;
        prompt: string;
        cwd: string;
        sessionId?: string;
        skills?: string[] | 'all';
        mcpServers?: McpServerMap;
        signal?: AbortSignal;
        accumulatedOutput?: string;
    },
    planStore: PlanStoreService,
    errorPrefix: string,
): Promise<void> {
    let accumulatedOutput = bridgeOptions.accumulatedOutput ?? '';

    // 统一推送一条日志：累积到 rawOutput 并广播 plan:progress
    const pushLog = (text: string) => {
        accumulatedOutput += text;
        plan.rawOutput = accumulatedOutput;
        plan.summary = accumulatedOutput.substring(0, 500);
        planCache.set(plan.id, {...plan});
        broadcast({type: 'plan:progress', data: {taskId: plan.id, content: text}});
    };

    const onOutput = (data: string, meta?: Record<string, unknown>) => {
        // 工具调用摘要化（Read 等结果全文静默），纯逻辑见 utils/tool-log
        const {silent, text} = processToolOutput(data, meta);
        if (!silent) pushLog(text);
    };

    try {
        // 活动看门狗：有输出即重置，只有真正沉寂满 30 分钟（疑似卡死）才中止
        const result = await withOutputTimeout(
            BRIDGE_TIMEOUT_MS,
            errorPrefix,
            bridgeOptions.signal,
            onOutput,
            (signal, wrappedOnOutput) =>
                bridgeOptions.cliRunner.runBridge(
                    {
                        prompt: bridgeOptions.prompt,
                        cwd: bridgeOptions.cwd,
                        sessionId: bridgeOptions.sessionId,
                        maxTurns: 20,
                        skills: bridgeOptions.skills,
                        mcpServers: bridgeOptions.mcpServers,
                    },
                    {
                        workspacePath: bridgeOptions.cwd,
                        signal,
                        onOutput: (data, meta) => wrappedOnOutput(data, meta),
                    }
                ),
        );

        finalizePlan(plan, result, accumulatedOutput, planStore);
    } catch (err) {
        failPlan(plan, getErrorMessage(err), planStore, errorPrefix);
    }
}

/**
 * 按技能顺序串行执行计划生成。
 * - skills 为数组时，依次执行每个技能；每完成一个进入 waiting_skill_confirm，等用户确认。
 * - skills 为 'all' / undefined / 空数组时，单次执行（兼容旧行为）。
 */
async function runPlanSkillsSequentially(
    plan: PersistedPlan,
    opts: {
        cliRunner: CLIRunnerService;
        prompt: string;
        cwd: string;
        skills?: string[] | 'all';
        mcpServers?: McpServerMap;
        signal?: AbortSignal;
    },
    planStore: PlanStoreService,
): Promise<void> {
    const {cliRunner, prompt, cwd, skills, mcpServers, signal} = opts;

    // 非数组或空数组：单次执行（保持旧行为）
    if (!Array.isArray(skills) || skills.length === 0) {
        await runBridgeWithTimeout(
            plan,
            {cliRunner, prompt, cwd, skills, mcpServers, signal},
            planStore,
            'Plan generation',
        );
        return;
    }

    // 数组：初始化技能队列
    plan.pendingSkills = [...skills];
    plan.executedSkills = [];
    persistPlan(plan, planStore);

    await runNextPlanSkill(plan, {cliRunner, prompt, cwd, mcpServers, signal}, planStore);
}

/**
 * 执行队列中下一个技能。队列空 → 完成。
 * 完成 1 个技能后进入 waiting_skill_confirm，等用户 continue-skill 路由触发下一个。
 */
async function runNextPlanSkill(
    plan: PersistedPlan,
    opts: {
        cliRunner: CLIRunnerService;
        prompt: string;
        cwd: string;
        mcpServers?: McpServerMap;
        signal?: AbortSignal;
    },
    planStore: PlanStoreService,
): Promise<void> {
    const {cliRunner, prompt, cwd, mcpServers, signal} = opts;
    const pending = plan.pendingSkills ?? [];

    if (pending.length === 0) {
        // 全部技能执行完，标记 ready
        plan.status = 'ready';
        plan.currentSkill = undefined;
        plan.updatedAt = new Date().toISOString();
        persistPlan(plan, planStore);
        activeGenerations.delete(plan.id);
        broadcast({type: 'plan:complete', data: {taskId: plan.id, status: plan.status}});
        return;
    }

    // 取出下一个技能
    const skill = pending[0];
    plan.pendingSkills = pending.slice(1);
    plan.currentSkill = skill;
    plan.status = 'generating';
    plan.updatedAt = new Date().toISOString();
    persistPlan(plan, planStore);

    const accumulated = plan.rawOutput ?? '';

    try {
        // 活动看门狗：有输出即重置，只有真正沉寂满 30 分钟（疑似卡死）才中止
        const result = await withOutputTimeout(
            BRIDGE_TIMEOUT_MS,
            `计划技能 "${skill}"`,
            signal,
            undefined,
            (innerSignal, onOutput) =>
                cliRunner.runBridge(
                    {
                        prompt,
                        cwd,
                        sessionId: plan.sessionId,
                        maxTurns: 20,
                        skills: [skill],
                        mcpServers,
                    },
                    {
                        workspacePath: cwd,
                        signal: innerSignal,
                        onOutput: (data: string) => {
                            onOutput(data);
                            plan.rawOutput = (plan.rawOutput ?? '') + data;
                            plan.summary = (plan.rawOutput ?? '').substring(0, 500);
                            planCache.set(plan.id, {...plan});
                            broadcast({type: 'plan:progress', data: {taskId: plan.id, content: data}});
                        },
                    }
                ),
        );

        if (result.sessionId) plan.sessionId = result.sessionId;

        // 当前技能完成 → 加入已执行列表
        plan.executedSkills = [...(plan.executedSkills ?? []), skill];
        plan.currentSkill = undefined;

        if (plan.pendingSkills && plan.pendingSkills.length > 0) {
            // 还有下一个技能 → 等用户确认
            plan.status = 'waiting_skill_confirm';
            plan.updatedAt = new Date().toISOString();
            persistPlan(plan, planStore);
            broadcast({
                type: 'plan:skill_complete',
                data: {
                    taskId: plan.id,
                    completedSkill: skill,
                    nextSkill: plan.pendingSkills[0],
                    pendingCount: plan.pendingSkills.length,
                },
            });
        } else {
            // 最后一个技能完成 → ready
            plan.status = 'ready';
            plan.updatedAt = new Date().toISOString();
            persistPlan(plan, planStore);
            activeGenerations.delete(plan.id);
            broadcast({type: 'plan:complete', data: {taskId: plan.id, status: plan.status}});
        }
    } catch (err) {
        failPlan(plan, getErrorMessage(err), planStore, `Plan skill "${skill}"`);
    }
}

/**
 * 创建开发计划管理路由
 */
export function createPlanRoutes(
    cliRunnerService: CLIRunnerService,
    agentFetchService: RequirementAgentFetchService,
    pipelineService?: PipelineService,
    memoryService?: MemoryService,
    mineruService?: MinerUService,
    attachmentStore?: AttachmentStore,
): Router {
    const planStore = new PlanStoreService();
    const reqStore = new RequirementStoreService();
    const mcpConfigService = new MCPRegistryService();
    const router = Router();

    // POST /api/plan/generate - 基于需求生成开发计划
    router.post('/generate', validateBody([
        {field: 'requirementId', required: false, type: 'string'},  // 改为可选：支持 requirementText 时无需 ID
        {field: 'workspacePath', required: true, type: 'string'},
    ]), async (req, res) => {
        const {
            requirementId,
            workspacePath,
            pipelineId,
            requirementTitle,
            requirementNumber,
            requirementDescription
        } = req.body;

        const wsCheck = validateWorkspacePath(workspacePath);
        if (!wsCheck.valid) {
            res.status(400).json({code: 'VALIDATION_ERROR', message: wsCheck.error});
            return;
        }

        const taskId = crypto.randomUUID();
        const planSkills = resolvePlanSkills(pipelineId, pipelineService);

        const plan: PersistedPlan = {
            id: taskId,
            requirementId,
            requirementTitle,
            requirementNumber,
            workspacePath,
            status: 'generating',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            pipelineId,
        };
        persistPlan(plan, planStore);

        res.json({taskId});

        const abortController = new AbortController();
        activeGenerations.set(taskId, abortController);

        // 异步生成
        try {
            // 优先使用前端传递的需求快照（避免重复从 ONES 获取）
            let title = requirementTitle || '';
            let description = requirementDescription || '';

            if (!title || !description) {
                // 如果没有提供快照，从本地 store 或 MCP 获取
                const content = await getRequirementContent(requirementId, reqStore, agentFetchService);
                title = title || content.title;
                description = description || content.description;
            }

            // 如果 Pipeline 配置了额外文件路径，通过 MinerU 解析后追加到 description
            let enrichedDescription = description;
            if (pipelineId && mineruService?.isEnabled()) {
                const pipeline = pipelineService?.get(pipelineId);
                const docParsing = pipeline?.steps?.documentParsing;
                if (docParsing?.extraPaths && docParsing.extraPaths.length > 0) {
                    const extraMdParts: string[] = [];
                    for (const relPath of docParsing.extraPaths) {
                        const fullPath = path.resolve(workspacePath, relPath);
                        try {
                            const result = await mineruService.parseFile(fullPath);
                            if (result.success && result.markdown) {
                                extraMdParts.push(`### ${relPath}\n\n${result.markdown}`);
                            }
                        } catch { /* 跳过解析失败的文件 */
                        }
                    }
                    if (extraMdParts.length > 0) {
                        enrichedDescription += '\n\n---\n\n## 参考文档\n\n' + extraMdParts.join('\n\n---\n\n');
                    }
                }
            }

            const promptText = renderPrompt(PROMPTS.plan, {title, description: enrichedDescription});

            // 检查pipeline级别的Agent模式
            const pipeline = plan.pipelineId ? pipelineService?.get(plan.pipelineId) : undefined;
            const isPipelineAgentMode = pipeline?.agentMode === true;

            const planMcpServers = resolvePlanMcpWithWarn(plan, pipelineService, mcpConfigService);

            // Agent模式已移除，直接使用传统技能模式
            if (false) {
                // Agent模式分支已禁用
                return;
            }

            // 传统技能模式
            await runPlanSkillsSequentially(
                plan,
                {
                    cliRunner: cliRunnerService,
                    prompt: enrichPrompt(promptText, memoryService, workspacePath),
                    cwd: workspacePath,
                    skills: (planSkills && typeof planSkills === 'object' && 'mode' in planSkills && planSkills.mode === 'agent') ? undefined : planSkills as string[] | 'all' | undefined,
                    mcpServers: planMcpServers,
                    signal: abortController.signal,
                },
                planStore,
            );
        } catch (err) {
            failPlan(plan, getErrorMessage(err), planStore, 'Plan generation');
        }
    });

    // GET /api/plan/list - 获取计划列表
    router.get('/list', async (_req, res) => {
        try {
            const plans = (await planStore.list()).map(p => {
                // 迁移：旧 plan 没有 requirementTitle，从 requirement store 补数据
                if (!p.requirementTitle) {
                    try {
                        const req = reqStore.get(p.requirementId);
                        if (req) {
                            p.requirementTitle = req.title;
                            p.requirementNumber = req.number;
                            planStore.upsert(p);
                        }
                    } catch { /* 补数据失败不影响列表返回 */
                    }
                }
                return {
                    id: p.id,
                    requirementId: p.requirementId,
                    requirementTitle: p.requirementTitle,
                    requirementNumber: p.requirementNumber,
                    workspacePath: p.workspacePath,
                    status: p.status,
                    summary: p.summary?.substring(0, 200),
                    createdAt: p.createdAt,
                    updatedAt: p.updatedAt,
                };
            });
            res.json(plans);
        } catch (err) {
            res.status(500).json({code: 'STORE_ERROR', message: getErrorMessage(err)});
        }
    });

    // GET /api/plan/:taskId - 获取计划详情
    router.get('/:taskId', (req, res) => {
        const plan = findPlan(req.params.taskId, planStore);
        if (!plan) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
            return;
        }
        // 补数据：缺 requirementNumber 时从 reqStore 查
        if (!plan.requirementNumber && plan.requirementId) {
            try {
                const req = reqStore.get(plan.requirementId);
                if (req) {
                    plan.requirementNumber = req.number;
                    plan.requirementTitle = plan.requirementTitle ?? req.title;
                    planStore.upsert(plan);
                    planCache.set(plan.id, {...plan});
                }
            } catch { /* 补数据失败不影响返回 */
            }
        }
        res.json(plan);
    });

    // PUT /api/plan/:taskId - 更新计划内容
    router.put('/:taskId', (req, res) => {
        const plan = planCache.get(req.params.taskId) ?? planStore.get(req.params.taskId);
        if (!plan) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
            return;
        }

        if (req.body.summary !== undefined) plan.summary = req.body.summary;
        if (req.body.rawOutput !== undefined) plan.rawOutput = req.body.rawOutput;
        plan.updatedAt = new Date().toISOString();
        persistPlan(plan, planStore);
        res.json(plan);
    });

    // DELETE /api/plan/:taskId - 删除计划
    router.delete('/:taskId', (req, res) => {
        const deleted = planStore.delete(req.params.taskId);
        planCache.delete(req.params.taskId);
        res.json({success: deleted});
    });

    // POST /api/plan/:taskId/reply - 多轮对话回复
    router.post('/:taskId/reply', async (req, res) => {
        const plan = planCache.get(req.params.taskId) ?? planStore.get(req.params.taskId);
        if (!plan) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
            return;
        }

        const {message} = req.body as { message: string };
        if (!message?.trim()) {
            res.status(400).json({code: 'VALIDATION_ERROR', message: 'message is required'});
            return;
        }

        // 聊天附件：一次性取出（取出即删），全文只拼进发给引擎的 prompt；
        // 广播给 UI 的只落 stub 行，不落全文
        const docs = attachmentStore?.drain((req.body?.attachmentIds ?? []) as string[]) ?? [];
        const fullMessage = message + formatAttachmentsBlock(docs);

        // 如果没有活跃会话（用户调用了 /new-session），创建新会话
        const isNewSession = !plan.sessionId;
        if (isNewSession) {
            console.log(`[plan] 创建新会话: taskId=${req.params.taskId}`);
        }

        res.json({ok: true, isNewSession});

        plan.status = 'generating';
        plan.updatedAt = new Date().toISOString();
        persistPlan(plan, planStore);
        broadcast({type: 'plan:progress', data: {taskId: plan.id, content: `\n\n**User:** ${message}\n\n`}});
        if (docs.length > 0) {
            broadcast({
                type: 'plan:progress',
                data: {taskId: plan.id, content: `\n\n📎 已附加文档：${docs.map(d => `${d.fileName}（${d.chars} 字）`).join('、')}\n\n`}
            });
        }

        const replyMcpServers = resolvePlanMcpWithWarn(plan, pipelineService, mcpConfigService);

        // 继续对话：如果有 sessionId 则复用（旧会话），否则创建新会话
        const bridgeOptions: any = {
            cliRunner: cliRunnerService,
            prompt: enrichPrompt(fullMessage, memoryService, plan.workspacePath),
            cwd: plan.workspacePath,
            mcpServers: replyMcpServers,
        };

        // 仅在有 sessionId 时传递（继续旧会话）
        if (plan.sessionId) {
            bridgeOptions.sessionId = plan.sessionId;
        }

        await runBridgeWithTimeout(
            plan,
            bridgeOptions,
            planStore,
            'Reply',
        );
    });

    // POST /api/plan/:taskId/new-session
    // 开始新会话（保留历史显示，清空后端上下文）
    router.post('/:taskId/new-session', async (req, res) => {
        const plan = planCache.get(req.params.taskId) ?? planStore.get(req.params.taskId);
        if (!plan) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
            return;
        }

        // 清空 sessionId，下次 /reply 调用时将创建新会话
        const oldSessionId = plan.sessionId;
        plan.sessionId = undefined;
        plan.updatedAt = new Date().toISOString();

        // 持久化更新
        persistPlan(plan, planStore);
        if (planCache.get(plan.id)) {
            planCache.set(plan.id, {...plan});
        }

        console.log(`[plan] 新会话: taskId=${plan.id}, oldSessionId=${oldSessionId?.slice(0, 8)}...`);

        res.json({
            ok: true,
            message: '新会话已创建，历史消息保留在页面显示中'
        });
    });

    // POST /api/plan/:taskId/abort - 取消生成
    router.post('/:taskId/abort', (req, res) => {
        const plan = planCache.get(req.params.taskId) ?? planStore.get(req.params.taskId);
        if (!plan) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
            return;
        }

        const ac = activeGenerations.get(req.params.taskId);
        if (!ac) {
            failPlan(plan, 'Generation cancelled by user', planStore);
            res.json({ok: true});
            return;
        }

        ac.abort();
        activeGenerations.delete(req.params.taskId);
        res.json({ok: true});
    });

    // POST /api/plan/:taskId/pause - 暂停生成
    router.post('/:taskId/pause', (req, res) => {
        const plan = planCache.get(req.params.taskId) ?? planStore.get(req.params.taskId);
        if (!plan) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
            return;
        }

        const ac = activeGenerations.get(req.params.taskId);
        if (!ac) {
            res.status(400).json({code: 'INVALID_STATE', message: 'No active generation to pause'});
            return;
        }

        res.json({ok: true});
        ac.abort();
        activeGenerations.delete(req.params.taskId);

        plan.status = 'paused';
        plan.updatedAt = new Date().toISOString();
        persistPlan(plan, planStore);
        broadcast({type: 'plan:complete', data: {taskId: plan.id, status: 'paused'}});
    });

    // POST /api/plan/:taskId/resume - 恢复生成
    router.post('/:taskId/resume', async (req, res) => {
        const plan = findPlan(req.params.taskId, planStore);
        if (!plan) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
            return;
        }

        if (plan.status !== 'paused') {
            res.status(400).json({code: 'INVALID_STATE', message: 'Plan is not paused'});
            return;
        }
        if (!plan.sessionId) {
            res.status(400).json({code: 'INVALID_STATE', message: 'No session ID available for resume'});
            return;
        }

        const abortController = new AbortController();
        activeGenerations.set(plan.id, abortController);

        plan.status = 'generating';
        plan.updatedAt = new Date().toISOString();
        persistPlan(plan, planStore);
        broadcast({type: 'plan:progress', data: {taskId: plan.id, content: '\n\n[Resuming generation...]\n\n'}});

        res.json({ok: true});

        const resumeMcpServers = resolvePlanMcpWithWarn(plan, pipelineService, mcpConfigService);
        await runBridgeWithTimeout(
            plan,
            {
                cliRunner: cliRunnerService,
                prompt: renderPrompt(PROMPTS.planResume, {}),
                cwd: plan.workspacePath,
                sessionId: plan.sessionId,
                mcpServers: resumeMcpServers,
                signal: abortController.signal,
                accumulatedOutput: plan.rawOutput || '',
            },
            planStore,
            'Resume',
        );
    });

    // POST /api/plan/:taskId/regenerate - 在原 plan 上重新生成
    router.post('/:taskId/regenerate', async (req, res) => {
        const taskId = req.params.taskId;
        const plan = planCache.get(taskId) ?? planStore.get(taskId);
        if (!plan) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
            return;
        }

        if (activeGenerations.has(taskId)) {
            res.status(409).json({code: 'CONFLICT', message: 'Plan is already generating'});
            return;
        }

        const planSkills = resolvePlanSkills(plan.pipelineId, pipelineService);
        const planMcpServers = resolvePlanMcpWithWarn(plan, pipelineService, mcpConfigService);

        // 检查pipeline级别的Agent模式
        const pipeline = plan.pipelineId ? pipelineService?.get(plan.pipelineId) : undefined;
        const isPipelineAgentMode = pipeline?.agentMode === true;

        // 重置状态
        plan.status = 'generating';
        plan.rawOutput = undefined;
        plan.summary = undefined;
        plan.error = undefined;
        plan.sessionId = undefined;
        plan.updatedAt = new Date().toISOString();
        persistPlan(plan, planStore);

        res.json({taskId});

        const abortController = new AbortController();
        activeGenerations.set(taskId, abortController);

        try {
            const {title, description} = await getRequirementContent(plan.requirementId, reqStore, agentFetchService);

            // 传统技能模式
            const promptText = renderPrompt(PROMPTS.plan, {title, description});

            await runBridgeWithTimeout(
                plan,
                {
                    cliRunner: cliRunnerService,
                    prompt: enrichPrompt(promptText, memoryService, plan.workspacePath),
                    cwd: plan.workspacePath,
                    skills: planSkills as string[] | 'all' | undefined,
                    mcpServers: planMcpServers,
                    signal: abortController.signal,
                },
                planStore,
                'Plan regeneration',
            );
        } catch (err) {
            failPlan(plan, getErrorMessage(err), planStore, 'Plan regeneration');
        }
    });

    /**
     * POST /api/plan/:taskId/export-tasks
     * 导出任务拆分 + 工时评估 xlsx。
     * 流程：rawOutput 无 JSON → 先跑 task-breakdown-estimator 技能 → 解析 → 模板填充。
     * @body outputPath - 保存路径（绝对路径），不传则用桌面
     */
    router.post('/:taskId/export-tasks', async (req, res) => {
        try {
            const plan = planCache.get(req.params.taskId) ?? planStore.get(req.params.taskId);
            if (!plan) {
                res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
                return;
            }

            // 0. 优先检查 taskBreakdown 字段，其次检查 rawOutput
            let tasks = extractTasksFromOutput(plan.taskBreakdown ?? '') || extractTasksFromOutput(plan.rawOutput ?? '');

            if (!tasks || tasks.length === 0) {
                // 无任务数据，触发 task-breakdown-estimator 技能
                const skillName = 'task-breakdown-estimator';
                const abortController = new AbortController();
                activeGenerations.set(plan.id, abortController);

                // 保存原始开发计划，防止技能输出污染 rawOutput
                const originalRawOutput = plan.rawOutput ?? '';
                const originalSummary = plan.summary ?? '';

                plan.status = 'generating';
                plan.currentSkill = skillName;
                plan.updatedAt = new Date().toISOString();
                persistPlan(plan, planStore);

                try {
                    const {
                        title,
                        description
                    } = await getRequirementContent(plan.requirementId, reqStore, agentFetchService);

                    // 给齐技能所需输入（避免技能因追问卡住）
                    const reqId = plan.requirementNumber ?? plan.requirementId;
                    const planContent = plan.rawOutput ?? plan.summary ?? description ?? '';
                    const skillPrompt = renderPrompt(PROMPTS.taskBreakdown, {
                        skillName,
                        reqId,
                        title,
                        description: description ?? '',
                        planContent,
                    });
                    // 任务拆分使用空输出开始，不污染rawOutput（onOutput 直接累积到 plan.rawOutput）
                    plan.rawOutput = '';
                    const exportMcpServers = resolvePlanMcpWithWarn(plan, pipelineService, mcpConfigService);

                    // JSON 优先：技能输出须含 json fenced block；校验失败用 raw 走表格/宽容兜底
                    const jsonResult = await runBridgeJson<TaskExportRow[] | {tasks: TaskExportRow[]}>({
                        cliRunner: cliRunnerService,
                        prompt: enrichPrompt(skillPrompt, memoryService, plan.workspacePath),
                        cwd: plan.workspacePath,
                        sessionId: plan.sessionId,
                        skills: [skillName],
                        mcpServers: exportMcpServers,
                        signal: abortController.signal,
                        maxRetries: 2,
                        validator: taskRowsValidator,
                        onOutput: (data, meta) => {
                            const {silent, text} = processToolOutput(data, meta);
                            if (!silent) {
                                plan.rawOutput = (plan.rawOutput ?? '') + text;
                                plan.summary = plan.rawOutput.substring(0, 500);
                                planCache.set(plan.id, {...plan});
                                broadcast({type: 'plan:progress', data: {taskId: plan.id, content: text}});
                            }
                        },
                    });

                    if (!jsonResult.ok) {
                        // 校验失败/超时/中止：raw 可能仍含 markdown 表格或部分 JSON，交由 extract 兜底
                        console.warn(`[plan:export-tasks] 技能输出未通过 JSON 校验（${jsonResult.validationErrors?.join('; ') || jsonResult.error}），尝试兜底解析`);
                    }

                    // 技能输出挪到 taskBreakdown；校验通过时存干净的 JSON，失败则存原始输出
                    plan.taskBreakdown = jsonResult.ok ? JSON.stringify(jsonResult.data) : (jsonResult.raw ?? '');
                    // 恢复原始开发计划，保持开发计划与任务拆分彻底分离
                    plan.rawOutput = originalRawOutput;
                    plan.summary = originalSummary;
                    plan.status = 'ready';
                    plan.currentSkill = undefined;
                    plan.updatedAt = new Date().toISOString();
                    persistPlan(plan, planStore);
                } catch (err) {
                    failPlan(plan, getErrorMessage(err), planStore, 'Task export skill');
                    res.status(500).json({code: 'SKILL_FAILED', message: `技能执行失败: ${getErrorMessage(err)}`});
                    return;
                }

                tasks = extractTasksFromOutput(plan.taskBreakdown ?? '');
            }

            // 1. 仍无任务数据
            if (!tasks || tasks.length === 0) {
                res.status(400).json({code: 'NO_TASKS', message: '技能执行后仍未找到任务数据（JSON 或 markdown 表格）'});
                return;
            }

            // 2. 解析模板路径：workspace/templates/ → 内置模板
            const workspaceTemplate = plan.workspacePath
                ? path.join(plan.workspacePath, 'templates', 'task-split-effort-template.xlsx')
                : null;
            const builtinTemplate = path.resolve(__dirname, '..', '..', '..', 'templates', 'task-split-effort-template.xlsx');
            const templatePath = (workspaceTemplate && fs.existsSync(workspaceTemplate)) ? workspaceTemplate : builtinTemplate;

            if (!fs.existsSync(templatePath)) {
                res.status(500).json({code: 'TEMPLATE_MISSING', message: `模板不存在: ${templatePath}`});
                return;
            }

            // 3. 用 SheetJS 读下拉枚举（下拉 sheet 无需保样式）
            const wbRaw = XLSX.readFile(templatePath);
            const dropdowns = parseDropdowns(wbRaw.Sheets['下拉字段']);
            const headerRow = XLSX.utils.sheet_to_json<string[]>(wbRaw.Sheets['任务拆解表模版'], {header: 1})[0] as string[];
            const headers = headerRow.map(h => h?.trim() ?? '');

            const ctx = {
                requirementId: plan.requirementNumber ?? plan.requirementId,
                project: '',
                devLead: '',
                testLead: '',
            };
            const rows: Record<string, unknown>[] = tasks.map((t, idx) => buildExportRow(t, idx + 1, headers, dropdowns, ctx));

            // 4. 直接 XML 注入到模板（保样式 + 下拉 + 主题）
            const allowedRoots = [os.homedir()];
            if (plan.workspacePath) {
                allowedRoots.push(plan.workspacePath);
            }
            const requestedOutputPath = (req.body.outputPath as string)?.trim();
            let outputPath: string;
            if (requestedOutputPath) {
                const outputCheck = validateOutputPath(requestedOutputPath, allowedRoots);
                if (!outputCheck.valid) {
                    res.status(400).json({code: 'VALIDATION_ERROR', message: outputCheck.error});
                    return;
                }
                outputPath = outputCheck.path!;
            } else {
                outputPath = path.join(os.homedir(), 'Desktop', `tasks-${plan.id.substring(0, 8)}.xlsx`);
            }
            injectTasksToTemplate(templatePath, outputPath, headers, rows);

            res.json({success: true, path: outputPath, count: rows.length});
        } catch (err) {
            res.status(500).json({code: 'EXPORT_ERROR', message: getErrorMessage(err)});
        }
    });

    /**
     * POST /api/plan/:taskId/continue-skill
     * 确认继续执行下一个技能（仅 waiting_skill_confirm 状态可用）
     */
    router.post('/:taskId/continue-skill', async (req, res) => {
        const plan = planCache.get(req.params.taskId) ?? planStore.get(req.params.taskId);
        if (!plan) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
            return;
        }
        if (plan.status !== 'waiting_skill_confirm') {
            res.status(400).json({code: 'INVALID_STATE', message: 'Plan is not waiting for skill confirmation'});
            return;
        }
        if (!plan.pendingSkills || plan.pendingSkills.length === 0) {
            res.status(400).json({code: 'INVALID_STATE', message: 'No pending skills'});
            return;
        }

        res.json({ok: true});

        // 重建 AbortController
        const abortController = new AbortController();
        activeGenerations.set(plan.id, abortController);

        try {
            const {title, description} = await getRequirementContent(plan.requirementId, reqStore, agentFetchService);
            const promptText = renderPrompt(PROMPTS.plan, {title, description});

            const continueMcpServers = resolvePlanMcpWithWarn(plan, pipelineService, mcpConfigService);
            await runNextPlanSkill(
                plan,
                {
                    cliRunner: cliRunnerService,
                    prompt: enrichPrompt(promptText, memoryService, plan.workspacePath),
                    cwd: plan.workspacePath,
                    mcpServers: continueMcpServers,
                    signal: abortController.signal,
                },
                planStore,
            );
        } catch (err) {
            failPlan(plan, getErrorMessage(err), planStore, 'Continue skill');
        }
    });

    /**
     * POST /api/plan/:taskId/skip-skill
     * 跳过下一个待执行技能
     */
    router.post('/:taskId/skip-skill', async (req, res) => {
        const plan = planCache.get(req.params.taskId) ?? planStore.get(req.params.taskId);
        if (!plan) {
            res.status(404).json({code: 'NOT_FOUND', message: 'Plan not found'});
            return;
        }
        if (plan.status !== 'waiting_skill_confirm') {
            res.status(400).json({code: 'INVALID_STATE', message: 'Plan is not waiting for skill confirmation'});
            return;
        }

        // 弹出下一个待执行技能，记录为"已跳过"
        const skipped = plan.pendingSkills?.shift();
        if (skipped) {
            plan.executedSkills = [...(plan.executedSkills ?? []), `${skipped}(skipped)`];
        }

        // 还有剩余技能 → 继续执行下一个；否则完成
        if (plan.pendingSkills && plan.pendingSkills.length > 0) {
            res.json({ok: true, skipped});
            const abortController = new AbortController();
            activeGenerations.set(plan.id, abortController);
            try {
                const {
                    title,
                    description
                } = await getRequirementContent(plan.requirementId, reqStore, agentFetchService);
                const promptText = renderPrompt(PROMPTS.plan, {title, description});
                const skipMcpServers = resolvePlanMcpWithWarn(plan, pipelineService, mcpConfigService);
                await runNextPlanSkill(
                    plan,
                    {
                        cliRunner: cliRunnerService,
                        prompt: enrichPrompt(promptText, memoryService, plan.workspacePath),
                        cwd: plan.workspacePath,
                        mcpServers: skipMcpServers,
                        signal: abortController.signal,
                    },
                    planStore,
                );
            } catch (err) {
                failPlan(plan, getErrorMessage(err), planStore, 'Skip skill');
            }
        } else {
            plan.status = 'ready';
            plan.updatedAt = new Date().toISOString();
            persistPlan(plan, planStore);
            activeGenerations.delete(plan.id);
            broadcast({type: 'plan:complete', data: {taskId: plan.id, status: plan.status}});
            res.json({ok: true, skipped, completed: true});
        }
    });

    return router;
}
