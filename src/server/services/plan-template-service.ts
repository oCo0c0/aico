/**
 * @file plan-template-service.ts
 * @description 任务拆分工时评估模板（xlsx）导出服务 —— 从 routes/plan.ts 下沉的
 *              纯业务逻辑，路由层只留参数校验与调度。
 *
 * 职责链（对应 POST /api/plan/:id/export-tasks）：
 *   1. readTemplateSheet   —— 用 SheetJS 读模板的「下拉字段」sheet（下拉枚举）
 *                             与「任务拆解表模版」sheet（17 列表头）
 *   2. buildExportRow      —— 任务行 → 按表头列名组织的数据行（别名映射、
 *                             上下文回填、下拉列枚举校验、工时转数字）
 *   3. injectTasksToTemplate —— XML 注入器：直接改模板 sheet1.xml +
 *                             sharedStrings.xml，保全部样式/下拉/主题。
 *                             比 exceljs 稳——exceljs 重排 style 索引导致样式丢失。
 */
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import XLSX from 'xlsx';

/** 导出任务行（宽松结构：中英字段别名都可能出现，未知键保留） */
export interface TaskExportRow {
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
export type DropdownMap = Record<string, string[]>;

/** 业务字段 → 模板列名（中文）的别名表：导出构造与 Markdown 表格解析共用 */
export const HEADER_ALIASES: Record<string, string[]> = {
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

/** 导出上下文：任务来源需求号等回填值 */
export interface ExportContext {
    requirementId: string;
    project: string;
    devLead: string;
    testLead: string;
}

/**
 * 读取模板的下拉枚举与表头
 *
 * @param templatePath - 模板 xlsx 路径
 * @returns dropdowns（「下拉字段」sheet 解析结果）+ headers（「任务拆解表模版」表头 17 列）
 */
export function readTemplateSheet(templatePath: string): {dropdowns: DropdownMap; headers: string[]} {
    const wbRaw = XLSX.readFile(templatePath);
    const dropdowns = parseDropdowns(wbRaw.Sheets['下拉字段']);
    const headerRow = XLSX.utils.sheet_to_json<string[]>(wbRaw.Sheets['任务拆解表模版'], {header: 1})[0] as string[];
    const headers = headerRow.map(h => h?.trim() ?? '');
    return {dropdowns, headers};
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
export function buildExportRow(
    task: TaskExportRow,
    index: number,
    headers: string[],
    dropdowns: DropdownMap,
    ctx: ExportContext,
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
export function injectTasksToTemplate(
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
    const siRegex = /<si>([\s\S]*?)<\/si>/g;
    const strings: string[] = [];
    const stringToIndex: Record<string, number> = {};
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

    // 4. 替换 sheet1.xml 的 sheetData（保留原表头 row 1 完整内容）
    let sheetXml = zip.readAsText('xl/worksheets/sheet1.xml');
    const origRow1Match = sheetXml.match(/<row r="1"[^>]*>[\s\S]*?<\/row>/);
    const origRow1 = origRow1Match ? origRow1Match[0] : '';
    const finalSheetData = `<sheetData>${origRow1}${rowXmlArr.join('')}</sheetData>`;
    sheetXml = sheetXml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, finalSheetData);

    // 更新 dimension
    const lastRow = rows.length + 1;
    sheetXml = sheetXml.replace(/<dimension ref="[^"]*"/, `<dimension ref="A1:Q${lastRow}"`);

    zip.updateFile('xl/worksheets/sheet1.xml', Buffer.from(sheetXml, 'utf-8'));

    // 5. 更新 sharedStrings（简化：count = uniqueCount）
    const newUnique = strings.length;
    const newCount = strings.length;
    const siBlocks = strings.map(s => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('');
    const newSs = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${newCount}" uniqueCount="${newUnique}">${siBlocks}</sst>`;
    zip.updateFile('xl/sharedStrings.xml', Buffer.from(newSs, 'utf-8'));

    // 6. 写出
    zip.writeZip(outputPath);
}
