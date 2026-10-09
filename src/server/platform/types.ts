/**
 * @module platform/types
 * @description 平台内核类型定义（引擎无关）
 *
 * 平台化的核心原则：这里定义的类型不依赖任何具体引擎（Claude/Codex/Pi）。
 * 各引擎的专属概念（如 Claude 的 canUseTool、pi 的 ToolDefinition）由各
 * Provider 适配层翻译，平台内核只认本文件定义的中立形状。
 *
 * 事件流说明：引擎事件仍沿 CLIProviderOptions.onOutput(data, meta) 通道
 * 传递（meta.type: 'thinking' | 'tool_use' | 'tool_result'），
 * 该形状由各 Provider 归一化后输出，编排层（plan/execution/agent-coordinator）
 * 只消费归一化事件，不感知引擎差异。
 */

/**
 * 工具分类
 * @description 平台对"工具做什么"的中立分类。编排层按分类决策
 * （如步骤面板只记录写类工具），不硬编码任何引擎的工具名集合。
 */
export type ToolCategory =
    | 'write'      // 修改文件系统（Write/Edit/NotebookEdit 等）
    | 'shell'      // 执行命令（Bash/PowerShell 等）
    | 'read'       // 只读查询（Read/Grep/Glob/Ls 等）
    | 'task'       // 任务/计划管理（TaskCreate/Workflow 等）
    | 'schedule'   // 定时任务（Cron 系列等）
    | 'mcp';       // MCP 工具（mcp__ 前缀）与平台注册的自定义工具

/**
 * 平台工具的参数 schema
 * @description 标准 JSON Schema 对象（type: 'object'）。
 * 各引擎投影层负责适配：pi 的 TypeBox schema 本身即 JSON Schema 兼容形状，
 * MCP 的 inputSchema 直接透传，Claude 经平台 MCP 网关暴露时原样下发。
 */
export interface PlatformToolSchema {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
}

/**
 * 平台工具执行结果
 * @description 与引擎无关的最小结果形状：给模型的文本 + 是否出错。
 */
export interface PlatformToolResult {
    /** 返回给模型的文本内容 */
    text: string;
    /** 是否为错误结果（引擎会把错误结果标记后回喂模型） */
    isError?: boolean;
}

/**
 * 平台工具执行上下文
 */
export interface PlatformToolContext {
    /** 调用中止信号（引擎透传） */
    signal?: AbortSignal;
    /** 发起调用的引擎 id（claude/codex/pi），供观测与权限策略区分来源 */
    source: string;
}

/**
 * 平台工具定义（中立形状）
 * @description 平台原生工具与 MCP 网关转发工具统一描述。
 * 投影层负责转换为各引擎的工具类型：
 * - pi: customTools（ToolDefinition）
 * - claude: 平台 MCP 网关聚合暴露（低层 Server 显式 handler，inputSchema 原样透传）
 */
export interface PlatformToolDefinition {
    /** 工具名（全局唯一；MCP 转发工具为 <server>__<tool> 格式） */
    name: string;
    /** 人类可读标签（UI 展示） */
    label: string;
    /** 给模型的工具描述 */
    description: string;
    /** 工具分类（编排层决策用） */
    category: ToolCategory;
    /** 参数 schema（标准 JSON Schema） */
    inputSchema: PlatformToolSchema;
    /** 执行工具。失败应返回 isError 结果或抛出（投影层会兜底转错误结果） */
    execute(args: Record<string, unknown>, ctx: PlatformToolContext): Promise<PlatformToolResult>;
}
