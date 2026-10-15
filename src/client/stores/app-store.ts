/**
 * @file 全局应用状态管理 Store
 * @description 基于 Zustand 的全局状态管理模块，集中管理 Aico的所有业务状态。
 *              涵盖需求管理、工作空间、开发计划、执行监控、测试结果、
 *              工作流管道、WebSocket 连接状态及 UI 偏好设置等模块。
 *
 *              状态持久化策略:
 *                - 主题偏好（dark/light）持久化到 localStorage
 *                - 字体/字号偏好持久化到 localStorage（key: ai-workbench-font）
 *                - 当前计划关联的任务 ID 持久化到 localStorage（页面刷新后可恢复）
 *
 *              使用方式:
 *                在组件中通过 `useAppStore(selector)` 订阅所需的状态切片，
 *                Zustand 会自动处理组件重渲染优化，仅在实际使用的状态变化时触发更新。
 */

import {create} from 'zustand';
import type {AgentExecutionSummary} from '../types/agent-types';
import {apiPut} from '../api';
import {applyAccent, applyCodeTheme, applyFontColorPatch, applyGlassColor, CODE_THEME_PRESETS, type AccentPair} from '../lib/appearance';

// === 数据模型接口定义 ===

/**
 * 需求条目（列表项）
 * @description 需求列表中展示的精简信息，不含详细描述和附件
 */
interface Requirement {
    /** 需求唯一标识（= 需求号，如 CWXT-130341） */
    id: string;
    /** 需求号（与 id 一致，全局唯一） */
    number?: string;
    /** 需求标题 */
    title: string;
    /** 需求状态 */
    status: string;
    /** 优先级 */
    priority: string;
    /** 负责人 */
    assignee: string;
    /** 最后更新时间（ISO 格式） */
    updatedAt: string;
}

/**
 * 需求详情
 * @description 继承 Requirement，包含完整的需求描述、验收标准、附件和关联问题
 */
interface RequirementDetail extends Requirement {
    /** 需求详细描述 */
    description: string;
    /** 验收标准列表 */
    acceptanceCriteria: string[];
    /** 附件列表 */
    attachments: { name: string; url: string; type: string }[];
    /** 关联的其他问题/缺陷 */
    relatedIssues: { id: string; title: string; status: string }[];
}

/**
 * 工作空间信息
 * @description 描述当前打开的项目工作空间的元数据
 */
interface WorkspaceInfo {
    /** 工作空间（项目）的文件系统路径 */
    path: string;
    /** 项目类型 */
    projectType: 'node' | 'python' | 'java' | 'rust' | 'unknown';
    /** 上下文文件列表（AI 分析用的关键文件） */
    contextFiles: string[];
    /** 是否存在 CLAUDE.md 配置文件 */
    hasClaudeMd: boolean;
    /** Git 仓库状态 */
    gitStatus: 'clean' | 'dirty' | 'not_git';
}

/**
 * 开发计划
 * @description AI 生成的完整开发计划，包含风险评估和分步骤实施细节
 */
interface DevelopmentPlan {
    /** 计划唯一标识 */
    id: string;
    /** 关联的需求 ID */
    requirementId: string;
    /** 工作空间路径 */
    workspacePath: string;
    /** 计划摘要 */
    summary: string;
    /** 复杂度评估 */
    complexity: 'low' | 'medium' | 'high';
    /** 风险点列表 */
    risks: string[];
    /** 计划步骤列表 */
    steps: PlanStep[];
    /** 创建时间（ISO 格式） */
    createdAt: string;
    /** 计划状态 */
    status: 'draft' | 'confirmed' | 'executing' | 'completed' | 'failed';
}

/**
 * 计划步骤
 * @description 开发计划中的单个执行步骤
 */
interface PlanStep {
    /** 步骤序号（从 0 开始） */
    index: number;
    /** 步骤标题 */
    title: string;
    /** 步骤详细描述 */
    description: string;
    /** 涉及的目标文件列表 */
    targetFiles: string[];
    /** 操作类型 */
    action: 'create' | 'modify' | 'delete';
    /** 预估工作量 */
    estimatedEffort: string;
}

/**
 * 执行状态
 * @description 当前计划执行的实时状态信息
 */
interface ExecutionStatus {
    /** 执行实例唯一标识 */
    executionId: string;
    /** 关联的计划 ID（可能为空） */
    planId?: string;
    /** 当前正在执行的步骤索引 */
    currentStep: number;
    /** 总步骤数 */
    totalSteps: number;
    /** 执行状态 */
    status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted' | 'waiting_skill_confirm';
    /** 开始时间（ISO 格式） */
    startedAt?: string;
    /** 完成时间（ISO 格式），执行未完成时为 undefined */
    completedAt?: string;
}

/**
 * 执行日志条目
 * @description 执行过程中产生的单条日志记录
 */
export interface ExecutionLogEntry {
    /** 日志时间戳（ISO 格式） */
    timestamp: string;
    /** 关联的步骤索引 */
    stepIndex: number;
    /** 日志类型 */
    type: 'info' | 'output' | 'error' | 'warning';
    /** 日志内容 */
    content: string;
}

/**
 * 测试结果
 * @description 测试运行完成后的汇总结果，包含通过/失败/跳过统计及覆盖率
 */
interface TestResults {
    /** 测试框架名称（如 vitest, jest 等） */
    framework: string;
    /** 总测试用例数 */
    totalTests: number;
    /** 通过数 */
    passed: number;
    /** 失败数 */
    failed: number;
    /** 跳过数 */
    skipped: number;
    /** 总耗时（毫秒） */
    duration: number;
    /** 代码覆盖率百分比（可选） */
    coverage?: number;
    /** 测试套件列表 */
    suites: TestSuite[];
}

/**
 * 测试套件
 * @description 一个测试文件或测试分组，包含多个测试用例
 */
interface TestSuite {
    /** 套件名称 */
    name: string;
    /** 套件内的测试用例列表 */
    tests: TestCase[];
}

/**
 * 测试用例
 * @description 单个测试用例的执行结果
 */
interface TestCase {
    /** 用例名称 */
    name: string;
    /** 用例执行状态 */
    status: 'passed' | 'failed' | 'skipped';
    /** 执行耗时（毫秒） */
    duration: number;
    /** 失败时的错误信息 */
    error?: string;
    /** 失败时的截图（Base64 编码，可选） */
    screenshot?: string;
}

/**
 * 工作流管道
 * @description 预定义的自动化工作流配置
 */
interface WorkflowPipeline {
    /** 管道唯一标识 */
    id: string;
    /** 管道名称 */
    name: string;
    /** 管道描述 */
    description: string;
    /** 是否为默认管道 */
    isDefault: boolean;
    /** 创建时间（ISO 格式） */
    createdAt: string;
    /** 最后更新时间（ISO 格式） */
    updatedAt: string;
}

// === 多任务模型 ===

/** 任务日志 */
interface TaskLog {
    timestamp: string;
    phase: 'plan' | 'execution' | 'test' | 'idle';
    logType: 'info' | 'output' | 'error' | 'warning';
    content: string;
}

/** 任务信息 */
interface TaskInfo {
    id: string;
    name: string;
    projectId: string;
    requirementId: string;
    pipelineId: string;
    branch: string;
    workspacePath: string;
    status: 'pending' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
    phase: 'plan' | 'execution' | 'test' | 'idle';
    sessionId?: string;
    logs: TaskLog[];
    createdAt: string;
    updatedAt: string;
}

// === Agent 模型 ===
// AgentExecution和AgentExecutionSummary现在从shared types导入

/** 项目空间 */
interface ProjectSpace {
    id: string;
    name: string;
    workspacePath: string;
    baseBranch: string;
    defaultPipelineId?: string;
    taskCount?: number;
    runningCount?: number;
    createdAt: string;
    updatedAt: string;
}

/** 调度器状态 */
interface SchedulerStatus {
    maxConcurrent: number;
    runningCount: number;
    queueLength: number;
}

// === 应用状态接口 ===

/**
 * 单个 Provider 的模型运行配置（与后端 cliProvider.models[id] 镜像）
 * 哪些字段生效由该 Provider 的 capabilities 决定
 */
interface ProviderModelSettings {
    model?: string;
    streaming?: boolean;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    extendedThinking?: boolean;
    maxTokens?: number;
    /** 底层 LLM 提供商（如 pi 的 'anthropic' | 'openai' 等） */
    modelProvider?: string;
}

/** Provider 能力声明（与后端 CLIProviderCapabilities 镜像，控制配置 UI 字段可见性） */
interface ProviderCapabilities {
    supportsPermission: boolean;
    supportsRuntimeSkills: boolean;
    supportsRuntimeMcp: boolean;
    supportsMaxTurns: boolean;
    supportsReasoningEffort: boolean;
    supportsExtendedThinking: boolean;
    supportsCustomEndpoint: boolean;
}

/** Provider 目录条目（来自后端 /system/cli-provider/status 的 detected 列表） */
interface ProviderCatalogEntry {
    id: string;
    label: string;
    available: boolean;
    capabilities?: ProviderCapabilities;
    defaultModelSettings?: ProviderModelSettings;
    meta?: Record<string, unknown>;
}

/** 各 Provider 本地可提供的模型选项（来自后端 /system/available-models） */
interface AvailableModelsEntry {
    tiers?: Array<{ value: string; label: string; model: string }>;
    current?: string | null;
}

/**
 * 全局应用状态接口
 * @description 定义整个应用的完整状态树及所有 action 方法。
 *              状态按业务模块划分为：需求、工作空间、计划、执行、测试、管道、WebSocket、UI。
 */
interface AppState {
    // --- 需求管理 ---
    /** 需求相关状态 */
    requirements: {
        /** 需求列表 */
        list: Requirement[];
        /** 当前选中的需求详情 */
        selected: RequirementDetail | null;
        /** 列表是否正在加载 */
        loading: boolean;
    };

    // --- 工作空间 ---
    /** 工作空间相关状态 */
    workspace: {
        /** 当前打开的工作空间信息 */
        current: WorkspaceInfo | null;
        /** 历史打开的工作空间路径列表 */
        history: string[];
    };

    // --- 开发计划 ---
    /** 计划相关状态 */
    plan: {
        /** 当前开发计划 */
        current: DevelopmentPlan | null;
        /** 计划生成/编辑状态 */
        status: 'idle' | 'generating' | 'paused' | 'ready' | 'editing' | 'failed';
        /** 当前计划关联的需求任务 ID（持久化到 localStorage） */
        taskId: string | null;
        /** 计划生成过程中的流式日志输出 */
        logs: string[];
    };

    // --- 执行监控 ---
    /** 执行相关状态 */
    execution: {
        /** 当前执行状态 */
        status: ExecutionStatus | null;
        /** 执行日志列表 */
        logs: ExecutionLogEntry[];
        /** 当前执行实例 ID */
        executionId: string | null;
    };

    // --- 测试 ---
    /** 测试相关状态 */
    tests: {
        /** 最近一次测试结果 */
        results: TestResults | null;
        /** 测试是否正在运行 */
        running: boolean;
        /** 当前沙箱测试阶段 */
        phase: string | null;
        /** 阶段描述标签 */
        phaseLabel: string | null;
    };

    // --- 工作流管道 ---
    /** 管道相关状态 */
    pipelines: {
        /** 管道列表 */
        list: WorkflowPipeline[];
        /** 当前激活的管道 */
        active: WorkflowPipeline | null;
    };

    // --- WebSocket ---
    /** WebSocket 连接状态 */
    ws: {
        /** 是否已连接 */
        connected: boolean;
    };

    // --- UI 偏好 ---
    /** UI 相关状态 */
    ui: {
        /** 主题（浅色/深色 + 多主题，见 Theme 类型）*/
        theme: Theme;
        /** 侧边栏是否折叠 */
        sidebarCollapsed: boolean;
        /** 语言偏好 */
        locale: 'zh' | 'en';
        /** 自定义背景照片（dataURL，持久化到 localStorage） */
        bgImage: string | null;
        /** 中文字体栈（中文/标点优先使用，持久化到 localStorage） */
        fontFamilyZh: string;
        /** 西文字体栈（英文/数字优先使用，中文字符自动回落到中文字体栈） */
        fontFamilyEn: string;
        /** 基准字号（px，范围 12-18，默认 14，持久化到 localStorage） */
        fontSize: number;
        /** 任务结果系统通知开关（执行成功/失败时通知，默认开启） */
        notificationsEnabled: boolean;
        /** 界面透明度设置（0.3-1：全局玻璃卡片 / 菜单栏与顶栏 / 悬浮输入框） */
        opacity: OpacitySettings;
        /** 品牌配色（null = 跟随主题经典红；持久化 localStorage） */
        accent: AccentPair | null;
        /** 玻璃面板底色（null = 跟随主题；持久化 localStorage） */
        glassColor: string | null;
        /** 代码块配色预设 id（'auto' = 跟随主题；持久化 localStorage + 服务端同步） */
        codeTheme: string;
        /** 字体颜色/字重/光标设置（持久化 localStorage） */
        fontColor: FontColorSettings;
        /** 吉祥物（Bongo Cat）设置 */
        mascot: MascotSettings;
        /** 悬浮快捷设置面板开关与页签（面板位置不持久化，页签持久化） */
        quickSettings: {open: boolean; tab: QuickSettingsTab};
    };

    // --- CLI Provider ---
    /** Provider 目录（后端检测到的所有 Provider：id/label/能力/默认配置） */
    providerCatalog: ProviderCatalogEntry[];
    /** 各 Provider 本地可提供的模型选项（id → tiers/current） */
    availableModels: Record<string, AvailableModelsEntry>;
    /** Pi 检测到的元数据（可用 LLM 提供商和模型列表） */
    piMeta: {
        availableProviders: string[];
        availableModels: Array<{ provider: string; id: string; name: string }>;
    } | null;
    /** CLI Provider 相关状态 */
    cliProvider: {
        /** 是否已完成首次引导 */
        configured: boolean;
        /** 当前激活的 Provider ID */
        active: string;
        /** 显示引导弹窗 */
        showSetupModal: boolean;
        /** 显示模型配置弹窗 */
        showModelConfigModal: boolean;
        /** 各 Provider 的模型配置（开放 map，key 为 Provider id） */
        modelConfig: Record<string, ProviderModelSettings>;
        /** 全局工具权限模式：confirm=询问确认；acceptEdits=自动接受文件编辑；bypassPermissions=完全放行 */
        permissionMode: 'confirm' | 'acceptEdits' | 'bypassPermissions';
    };

    // --- 项目空间 & 多任务 ---
    /** 项目空间相关状态 */
    projects: {
        /** 项目空间列表 */
        list: ProjectSpace[];
        /** 当前选中的项目空间 */
        active: ProjectSpace | null;
        /** 是否正在加载 */
        loading: boolean;
    };

    /** 多任务相关状态 */
    tasks: {
        /** 当前项目下的任务列表 */
        list: TaskInfo[];
        /** 当前查看/操作的任务 ID */
        activeTaskId: string | null;
        /** 按任务 ID 索引的日志 Map */
        logsByTask: Record<string, TaskLog[]>;
        /** 调度器状态 */
        scheduler: SchedulerStatus | null;
    };

    // --- Agent ---
    /** Agent相关状态 */
    agents: {
        /** Agent执行列表 */
        executions: AgentExecutionSummary[];
        /** 当前活跃的Agent执行ID */
        activeExecutionId: string | null;
        /** Agent执行日志（全局缓冲，兼容保留，页面不再直接使用） */
        logs: string[];
        /** 按执行ID分桶的日志（多 Agent 并行隔离：每个任务的日志只进自己的桶） */
        logsByExecution: Record<string, string[]>;
    };

    // === Action 方法 ===

    // 需求管理 actions
    /** 设置需求列表 */
    setRequirements: (list: Requirement[]) => void;
    /** 设置当前选中的需求详情 */
    setSelectedRequirement: (req: RequirementDetail | null) => void;
    /** 设置需求列表加载状态 */
    setRequirementsLoading: (loading: boolean) => void;

    // 工作空间 actions
    /** 设置当前工作空间信息 */
    setCurrentWorkspace: (workspace: WorkspaceInfo | null) => void;
    /** 设置工作空间历史路径列表 */
    setWorkspaceHistory: (history: string[]) => void;

    // 计划 actions
    /** 设置当前开发计划 */
    setCurrentPlan: (plan: DevelopmentPlan | null) => void;
    /** 设置计划状态（idle/generating/paused/ready/editing/failed） */
    setPlanStatus: (status: 'idle' | 'generating' | 'paused' | 'ready' | 'editing' | 'failed') => void;
    /** 设置计划关联的任务 ID（同时持久化到 localStorage） */
    setPlanTaskId: (taskId: string | null) => void;
    /** 追加一条计划生成日志 */
    addPlanLog: (content: string) => void;
    /** 清空计划生成日志 */
    clearPlanLogs: () => void;

    // 执行 actions
    /** 设置执行状态 */
    setExecutionStatus: (status: ExecutionStatus | null) => void;
    /** 设置当前执行实例 ID */
    setExecutionId: (id: string | null) => void;
    /** 追加一条执行日志 */
    addExecutionLog: (entry: ExecutionLogEntry) => void;
    /** 清空执行日志 */
    clearExecutionLogs: () => void;

    // 测试 actions
    /** 设置测试结果 */
    setTestResults: (results: TestResults | null) => void;
    /** 设置测试运行状态 */
    setTestRunning: (running: boolean) => void;
    /** 设置当前沙箱测试阶段 */
    setTestPhase: (phase: string | null, label: string | null) => void;

    // 管道 actions
    /** 设置管道列表 */
    setPipelines: (list: WorkflowPipeline[]) => void;
    /** 设置当前激活的管道 */
    setActivePipeline: (pipeline: WorkflowPipeline | null) => void;

    // WebSocket actions
    /** 设置 WebSocket 连接状态 */
    setWsConnected: (connected: boolean) => void;

    // UI actions
    /** 切换明暗主题 */
    toggleTheme: () => void;
    /** 切换侧边栏折叠状态 */
    toggleSidebar: () => void;
    /** 设置侧边栏折叠状态 */
    setSidebarCollapsed: (collapsed: boolean) => void;
    /** 直接设置主题 */
    setTheme: (theme: Theme) => void;
    /** 设置自定义背景照片（null 表示清除，恢复默认渐变） */
    setBgImage: (img: string | null) => void;
    /** 设置语言偏好 */
    setLocale: (locale: 'zh' | 'en') => void;
    /** 设置中英文字体栈（持久化到 localStorage 并立即生效到 CSS 变量） */
    setFontFamily: (zh: string, en: string) => void;
    /** 设置基准字号 px（持久化到 localStorage 并立即生效到 CSS 变量） */
    setFontSize: (size: number) => void;
    /** 设置任务结果通知开关（持久化 localStorage） */
    setNotificationsEnabled: (enabled: boolean) => void;
    /** 设置界面透明度（部分更新，持久化 localStorage 并立即生效到 CSS 变量） */
    setOpacity: (patch: Partial<OpacitySettings>) => void;
    /** 设置品牌配色（null = 恢复主题默认；持久化 localStorage 并立即生效到 CSS 变量） */
    setAccent: (pair: AccentPair | null) => void;
    /** 设置玻璃面板底色（null = 跟随主题；持久化 localStorage 并立即生效到 CSS 变量） */
    setGlassColor: (hex: string | null) => void;
    /** 设置代码配色预设（'auto' = 跟随主题；持久化 localStorage 并立即生效到 CSS 变量） */
    setCodeTheme: (id: string) => void;
    /** 设置吉祥物偏好（部分更新，持久化 localStorage；桌面端同步开关宠物悬浮窗） */
    setMascot: (patch: Partial<MascotSettings>) => void;
    /** 打开/关闭悬浮快捷设置面板 */
    setQuickSettingsOpen: (open: boolean) => void;
    /** 切换悬浮快捷设置面板页签（持久化 localStorage，下次打开回到上次页签） */
    setQuickSettingsTab: (tab: QuickSettingsTab) => void;
    /** 设置字体颜色/字重/光标（部分更新，持久化 localStorage 并立即生效） */
    setFontColor: (patch: Partial<FontColorSettings>) => void;

    // CLI Provider actions
    /** 设置 CLI Provider 配置状态 */
    setCliProvider: (configured: boolean, active: string) => void;
    /** 设置 Provider 目录（后端检测结果） */
    setProviderCatalog: (catalog: ProviderCatalogEntry[]) => void;
    /** 显示/隐藏引导弹窗 */
    setShowSetupModal: (show: boolean) => void;
    /** 显示/隐藏模型配置弹窗 */
    setShowModelConfigModal: (show: boolean) => void;
    /** 更新指定 Provider 的模型配置（局部合并，provider 为任意已注册 id） */
    setModelConfig: (provider: string, config: Partial<ProviderModelSettings>) => void;
    /** 从后端加载模型配置 */
    fetchModelConfig: () => Promise<void>;
    /** 保存模型配置到后端 */
    saveModelConfig: (provider: string, config: ProviderModelSettings) => Promise<void>;
    /** 设置全局权限模式（乐观更新，保存失败回滚） */
    setPermissionMode: (mode: 'confirm' | 'acceptEdits' | 'bypassPermissions') => Promise<void>;
    /** 从后端读取各 Provider 可用的模型选项 */
    fetchAvailableModels: () => Promise<void>;
    /** 保存 pi 检测到的元数据 */
    setPiMeta: (meta: AppState['piMeta']) => void;

    // 项目空间 actions
    /** 设置项目空间列表 */
    setProjects: (list: ProjectSpace[]) => void;
    /** 设置当前选中的项目空间 */
    setActiveProject: (project: ProjectSpace | null) => void;
    /** 设置项目加载状态 */
    setProjectsLoading: (loading: boolean) => void;

    // 多任务 actions
    /** 设置任务列表 */
    setTasks: (list: TaskInfo[]) => void;
    /** 设置当前活跃任务 ID */
    setActiveTaskId: (taskId: string | null) => void;
    /** 追加任务日志 */
    addTaskLog: (taskId: string, log: TaskLog) => void;
    /** 更新单个任务状态 */
    updateTask: (taskId: string, updates: Partial<TaskInfo>) => void;
    /** 设置调度器状态 */
    setSchedulerStatus: (status: SchedulerStatus | null) => void;

    // Agent actions
    /** 设置Agent执行列表 */
    setAgentExecutions: (executions: AgentExecutionSummary[]) => void;
    /** 设置当前活跃的Agent执行ID */
    setActiveAgentExecution: (executionId: string | null) => void;
    /** 添加Agent执行日志 */
    addAgentLog: (content: string, metadata?: {
        timestamp?: string;
        type?: 'output' | 'error' | 'warning' | 'user' | 'system' | 'tool' | 'file' | 'shell';
        taskId?: string;
        subtaskStatus?: 'reading' | 'fetching' | 'generating' | 'processing';
        tokensUsed?: number;
        duration?: number;
    }) => void;
    /** 清空Agent日志 */
    setAgentLogs: (logs: string[]) => void;
    clearAgentLogs: () => void;
    /** 追加日志到指定执行的分桶（多 Agent 隔离：实时日志只进自己任务的桶） */
    addAgentLogToExecution: (executionId: string, content: string) => void;
    /** 覆盖指定执行的分桶日志（loadDetail 时用历史日志初始化） */
    setAgentExecutionLogs: (executionId: string, logs: string[]) => void;
    /** 删除指定执行的分桶日志（删除任务时清理） */
    removeAgentExecutionLogs: (executionId: string) => void;
}

// === 辅助函数：主题持久化 ===

/**
 * 可用主题（浅色 + 深色两档），通过顶栏主题切换器选择。
 */
export type Theme = 'light' | 'dark';

/** 每个主题所属的明暗模式（决定挂 .light 还是 .dark class，从而控制 tailwind dark: 是否生效） */
const THEME_MODES: Record<Theme, 'light' | 'dark'> = {
    'light': 'light',
    'dark': 'dark',
};

/**
 * 从 localStorage 加载保存的主题设置
 * @returns 保存的主题值，若未保存或非法则默认返回 'dark'
 */
function loadTheme(): Theme {
    // SSR 环境下 localStorage 不可用，返回默认主题
    if (typeof window === 'undefined') return 'dark';
    const stored = localStorage.getItem('ai-workbench-theme') as Theme | null;
    // 校验合法 Theme 值（兼容旧 'dark'/'light' 与非法值）
    if (stored && stored in THEME_MODES) return stored;
    return 'dark';
}

/**
 * 将主题应用到 DOM 并持久化到 localStorage
 *
 * 通过在 <html> 元素上添加/移除 'dark' 和 'light' CSS 类来控制主题，
 * 同时将选择保存到 localStorage 以便下次加载时恢复。
 *
 * @param theme - 要应用的主题模式
 */
function applyTheme(theme: Theme) {
    // SSR 环境下 document 不可用，跳过 DOM 操作
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    // 按主题明暗模式挂 .light/.dark class（tailwind darkMode:'class' 据此生效）
    const mode = THEME_MODES[theme] ?? 'dark';
    if (mode === 'dark') {
        html.classList.add('dark');
        html.classList.remove('light');
    } else {
        html.classList.add('light');
        html.classList.remove('dark');
    }
    localStorage.setItem('ai-workbench-theme', theme);
    // 桌面版：窗口控制按钮已改为玻璃顶栏内自绘（WindowControls + adw:window-control），
    // 不再使用不透明的原生 titleBarOverlay 覆盖层，顶栏毛玻璃/壁纸透明效果不受限。
    // 保留主题模式通知（旧 IPC 通道，主进程侧对无覆盖层窗口为无害 no-op）。
    if (window.adwDesktop) {
        window.adwDesktop.setWindowControlsTheme(mode);
    }
}

/** 自定义背景照片 localStorage key */
const BG_IMAGE_KEY = 'ai-workbench-bg';

/**
 * 从 localStorage 加载自定义背景照片
 * @returns dataURL 或 URL；未设置返回 null
 */
function loadBgImage(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(BG_IMAGE_KEY);
}

/**
 * 将自定义背景照片应用到 <body>
 *
 * 有照片时在 <body> 挂 has-bg class 并注入 --user-bg（照片 url），
 * 由 CSS 的 body.has-bg 规则叠加主题色遮罩保证文字可读；
 * 无照片时移除，恢复默认多光晕渐变背景。
 *
 * @param img - 背景照片 dataURL/URL；null 表示清除
 */
function applyBgImage(img: string | null) {
    if (typeof document === 'undefined') return;
    const body = document.body;
    if (img) {
        body.classList.add('has-bg');
        body.style.setProperty('--user-bg', `url("${img}")`);
    } else {
        body.classList.remove('has-bg');
        body.style.removeProperty('--user-bg');
    }
}

// === 辅助函数：字体设置持久化 ===

/** 字体设置 localStorage key（JSON 对象：fontFamilyZh/fontFamilyEn/fontSize） */
const FONT_KEY = 'ai-workbench-font';

/** 默认中文字体栈（中文/标点优先命中，缺失字符回落 sans-serif） */
const DEFAULT_FONT_ZH = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

/** 默认西文字体栈（英文/数字优先命中，中文字符自动回落到中文字体栈） */
const DEFAULT_FONT_EN = "'Inter', -apple-system, 'Segoe UI', sans-serif";

/** 默认基准字号（px） */
const DEFAULT_FONT_SIZE = 14;

/** 字体设置持久化结构（中文字体栈/西文字体栈/基准字号） */
interface FontSettings {
    fontFamilyZh: string;
    fontFamilyEn: string;
    fontSize: number;
}

/** 界面透明度设置（各系数 0.3-1，作用于对应玻璃层） */
export interface OpacitySettings {
    /** 全局：玻璃卡片/面板 */
    global: number;
    /** 菜单栏与顶栏 */
    sidebar: number;
    /** 悬浮输入框 */
    input: number;
}

const OPACITY_KEY = 'ai-workbench-opacity';

/** 透明度默认值（外观面板"恢复默认"使用） */
export const DEFAULT_OPACITY: OpacitySettings = {global: 1, sidebar: 1, input: 0.8};

/**
 * 从 localStorage 加载透明度设置
 * @returns 保存的设置；未保存、解析失败或字段缺失时以默认值补齐
 */
function loadOpacitySettings(): OpacitySettings {
    if (typeof window === 'undefined') return {...DEFAULT_OPACITY};
    try {
        const stored = localStorage.getItem(OPACITY_KEY);
        if (!stored) return {...DEFAULT_OPACITY};
        const parsed = JSON.parse(stored) as Partial<OpacitySettings>;
        const clamp = (v: unknown, fallback: number) =>
            typeof v === 'number' && v >= 0.3 && v <= 1 ? v : fallback;
        return {
            global: clamp(parsed.global, DEFAULT_OPACITY.global),
            sidebar: clamp(parsed.sidebar, DEFAULT_OPACITY.sidebar),
            input: clamp(parsed.input, DEFAULT_OPACITY.input),
        };
    } catch {
        return {...DEFAULT_OPACITY};
    }
}

/**
 * 将透明度设置应用到 <html> 的 CSS 变量（index.css 的玻璃层消费）
 *
 * 透明度语义（v2，越大越透）：设置值为 0.3-1 的「透明度」，换算为玻璃底色的
 * alpha 系数 factor = clamp(1.15 - v, 0.12, 1) —— 拉满时玻璃底色只剩 ~12-15%
 * （配合 backdrop blur 文字仍可读），拉到最低则接近原始实色。
 * 旧版直接把设置值当系数（max=1 等于不衰减），顶栏/侧栏基础 alpha 高（0.62/0.85）
 * 导致调满也不透 —— 这就是「透明度调到最大还不透」的根因。
 */
function applyOpacitySettings(settings: OpacitySettings): void {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    const factor = (v: number): string => Math.max(0.35, Math.min(1, 1.15 - v)).toFixed(3);
    html.style.setProperty('--app-opacity-global', factor(settings.global));
    html.style.setProperty('--app-opacity-sidebar', factor(settings.sidebar));
    html.style.setProperty('--app-opacity-input', factor(settings.input));
}

/**
 * 从 localStorage 加载保存的字体设置
 * @returns 保存的字体设置；未保存、JSON 解析失败或字段缺失时以默认值补齐
 */
function loadFontSettings(): FontSettings {
    const defaults: FontSettings = {
        fontFamilyZh: DEFAULT_FONT_ZH,
        fontFamilyEn: DEFAULT_FONT_EN,
        fontSize: DEFAULT_FONT_SIZE,
    };
    // SSR 环境下 localStorage 不可用，返回默认字体
    if (typeof window === 'undefined') return defaults;
    try {
        const stored = localStorage.getItem(FONT_KEY);
        if (!stored) return defaults;
        return {...defaults, ...JSON.parse(stored)};
    } catch {
        // 存量数据损坏时按默认值处理，避免阻塞启动
        return defaults;
    }
}

/** CSS 泛型/系统字体族关键字——它们能命中所有字符(含汉字)，必须排在中文字体栈之后 */
const GENERIC_FAMILIES = new Set([
    'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
    'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
    '-apple-system', 'blinkmacsystemfont',
]);

/**
 * 合成西文字体栈：具体字体在前，中文字体栈居中，泛型族最后兜底。
 *
 * 西文栈若直接拼接在中文字体栈之前(如 "'JetBrains Mono', monospace")，
 * 泛型族 monospace 能命中汉字，导致中文字体设置永远不生效；
 * 故将泛型族摘出移到末尾，让汉字优先命中中文字体栈。
 */
export function composeEnFontFamily(fontFamilyEn: string, fontFamilyZh: string): string {
    const parts = fontFamilyEn.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
    const named = parts.filter((p) => !GENERIC_FAMILIES.has(p));
    const generics = parts.filter((p) => GENERIC_FAMILIES.has(p));
    const zhParts = fontFamilyZh.split(',').map((p) => p.trim()).filter(Boolean);
    return [...named, ...zhParts, ...generics].join(', ');
}

/**
 * 将字体设置应用到 <html> 的 CSS 变量上
 *
 * 通过 --app-font-zh/--app-font-en/--app-font-size 三个变量供全局 CSS 消费
 * （index.css 的 body font-family/font-size 读取）。本函数只负责 DOM 即时生效，
 * localStorage 持久化由各 set action 自行写入（与 applyBgImage 同模式）。
 *
 * @param settings - 要应用的字体设置
 */
function applyFontSettings(settings: FontSettings) {
    // SSR 环境下 document 不可用，跳过 DOM 操作
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    html.style.setProperty('--app-font-zh', settings.fontFamilyZh);
    html.style.setProperty('--app-font-en', composeEnFontFamily(settings.fontFamilyEn, settings.fontFamilyZh));
    // 字号必须挂到根元素(html)：Tailwind 的 text-sm 等按 rem(相对根字号)计算，
    // 挂在 body 上会被组件的显式字号类覆盖而失效。
    // UI 按 16px 根字号设计，故按比例换算：fontSize=14(基准) → 根字号 16px
    html.style.setProperty('--app-font-size', `${(settings.fontSize / DEFAULT_FONT_SIZE * 16).toFixed(2)}px`);
}

// === 辅助函数：配色 / 玻璃颜色 / 吉祥物 / 快捷面板页签 持久化 ===

/** 品牌配色 localStorage key（JSON：AccentPair） */
const ACCENT_KEY = 'ai-workbench-accent';

/** 玻璃底色 localStorage key（hex 字符串） */
const GLASS_COLOR_KEY = 'ai-workbench-glass-color';

/** 代码配色 localStorage key（预设 id 字符串，'auto' = 跟随主题） */
const CODE_THEME_KEY = 'ai-workbench-code-theme';

/** 吉祥物偏好 localStorage key */
const MASCOT_KEY = 'ai-workbench-mascot';

/** 快捷面板页签 localStorage key */
const QS_TAB_KEY = 'ai-workbench-qs-tab';

/** 宠物形象（轴伊 Joi 双衣装 + 轴芯鲸鱼娘，素材见 components/mascot/pets.tsx 与 public/mascot/） */
export type PetForm = 'joi-flowers' | 'joi-library' | 'zhouxin';

const PET_FORMS: PetForm[] = ['joi-flowers', 'joi-library', 'zhouxin'];

/** 吉祥物设置 */
export interface MascotSettings {
    /** 是否显示（桌面端 = 宠物悬浮窗；Web = 应用内可拖动悬浮球） */
    enabled: boolean;
    /** 缩放 0.5-2.5 */
    size: number;
    /** 是否显示状态气泡 */
    bubble: boolean;
    /** 宠物形象 */
    form: PetForm;
    /** Web 端悬浮球位置（中心点视口百分比 0-100）；null = 默认右下角（悬在输入框上方，不挡按钮） */
    position: {xPct: number; yPct: number} | null;
}

const DEFAULT_MASCOT: MascotSettings = {enabled: true, size: 1, bubble: true, form: 'joi-flowers', position: null};

/** 校验并收敛吉祥物悬浮位置（中心点视口百分比），非法值回落 null（默认角落） */
function sanitizeMascotPosition(value: unknown): {xPct: number; yPct: number} | null {
    if (!value || typeof value !== 'object') return null;
    const p = value as {xPct?: unknown; yPct?: unknown};
    const x = p.xPct, y = p.yPct;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (x < 0 || x > 100 || y < 0 || y > 100 || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {xPct: x, yPct: y};
}

/** 悬浮快捷面板页签（六页签，对齐 dsh-wallpaper-engine 的分区） */
export type QuickSettingsTab = 'wallpaper' | 'appearance' | 'font' | 'mascot' | 'effects' | 'advanced';

const QS_TABS: QuickSettingsTab[] = ['wallpaper', 'appearance', 'font', 'mascot', 'effects', 'advanced'];

function loadAccent(): AccentPair | null {
    if (typeof window === 'undefined') return null;
    try {
        const stored = localStorage.getItem(ACCENT_KEY);
        if (!stored) return null;
        const parsed = JSON.parse(stored) as Partial<AccentPair>;
        if (typeof parsed.from === 'string' && typeof parsed.to === 'string') {
            return {from: parsed.from, to: parsed.to};
        }
    } catch { /* ignore */ }
    return null;
}

function loadGlassColor(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(GLASS_COLOR_KEY);
}

/** 读取代码配色预设 id（缺省 'auto' = 跟随主题） */
function loadCodeTheme(): string {
    if (typeof window === 'undefined') return 'auto';
    return localStorage.getItem(CODE_THEME_KEY) || 'auto';
}

function loadMascotSettings(): MascotSettings {
    if (typeof window === 'undefined') return {...DEFAULT_MASCOT};
    try {
        const stored = localStorage.getItem(MASCOT_KEY);
        if (!stored) return {...DEFAULT_MASCOT};
        const parsed = JSON.parse(stored) as Partial<MascotSettings>;
        const size = typeof parsed.size === 'number' && parsed.size >= 0.5 && parsed.size <= 2.5
            ? parsed.size : DEFAULT_MASCOT.size;
        return {
            enabled: parsed.enabled !== false,
            size,
            bubble: parsed.bubble !== false,
            form: parsed.form && PET_FORMS.includes(parsed.form) ? parsed.form : DEFAULT_MASCOT.form,
            position: sanitizeMascotPosition(parsed.position),
        };
    } catch {
        return {...DEFAULT_MASCOT};
    }
}

function loadQuickSettingsTab(): QuickSettingsTab {
    if (typeof window === 'undefined') return 'wallpaper';
    const stored = localStorage.getItem(QS_TAB_KEY) as QuickSettingsTab | null;
    return stored && QS_TABS.includes(stored) ? stored : 'wallpaper';
}

// === 辅助函数：字体颜色 / 字重 / 光标颜色 ===

/** 字体颜色设置 localStorage key */
const FONT_COLOR_KEY = 'ai-workbench-font-color';

/** 字体颜色/字重/光标设置 */
export interface FontColorSettings {
    /** 总开关：关闭 = 完全恢复主题文字外观（字体颜色与字重一并失效） */
    enabled: boolean;
    /** 全局主文字颜色（hex，覆盖 --foreground token） */
    color: string;
    /** 全局字重 100-900（继承生效，组件显式字重不受影响） */
    weight: number;
    /** 输入光标颜色（null = 自动跟随主题；独立于总开关） */
    caretColor: string | null;
}

/** 默认开启即可见（蓝 600，与两套主题默认字色都有明显区分）；旧默认 #3a3f4a 与浅色主题字色过于接近，曾让功能看起来「没反应」 */
const DEFAULT_FONT_COLOR: FontColorSettings = {enabled: false, color: '#2563eb', weight: 400, caretColor: null};

function loadFontColorSettings(): FontColorSettings {
    if (typeof window === 'undefined') return {...DEFAULT_FONT_COLOR};
    try {
        const stored = localStorage.getItem(FONT_COLOR_KEY);
        if (!stored) return {...DEFAULT_FONT_COLOR};
        const parsed = JSON.parse(stored) as Partial<FontColorSettings>;
        const weight = typeof parsed.weight === 'number' && parsed.weight >= 100 && parsed.weight <= 900
            ? Math.round(parsed.weight / 50) * 50 : DEFAULT_FONT_COLOR.weight;
        return {
            enabled: parsed.enabled === true,
            color: typeof parsed.color === 'string' ? parsed.color : DEFAULT_FONT_COLOR.color,
            weight,
            caretColor: typeof parsed.caretColor === 'string' ? parsed.caretColor : null,
        };
    } catch {
        return {...DEFAULT_FONT_COLOR};
    }
}

/**
 * 将字体颜色/字重/光标设置应用到 <html>
 *
 * - 字体颜色走主题感知补丁样式表（浅/深各一档，见 lib/appearance.ts）——
 *   不能用内联样式：内联会把 :root 与 .dark 两套主题值同时压死（明暗切换失效回归）；
 * - 字重挂 html 的 font-weight（继承生效，不影响按钮/标题等显式字重）；
 * - 光标颜色 caret-color 为继承属性，挂 html 全局生效，null = 自动。
 */
function applyFontColorSettings(s: FontColorSettings): void {
    if (typeof document === 'undefined') return;
    applyFontColorPatch(s.enabled && s.color ? s.color : null);
    const style = document.documentElement.style;
    if (s.enabled) style.setProperty('--app-font-weight', String(s.weight));
    else style.removeProperty('--app-font-weight');
    if (s.caretColor) style.setProperty('caret-color', s.caretColor);
    else style.removeProperty('caret-color');
}

// === Zustand Store 实例 ===

/**
 * 全局应用状态 Store
 *
 * 使用 Zustand 的 `create` 方法创建，所有状态和 action 集中管理。
 * Store 创建时会自动从 localStorage 恢复主题和任务 ID 等持久化数据。
 */
export const useAppStore = create<AppState>((set, get) => {
    const initialTheme = loadTheme();
    const initialBgImage = loadBgImage();
    const initialFont = loadFontSettings();
    const initialAccent = loadAccent();
    const initialGlassColor = loadGlassColor();
    const initialCodeTheme = loadCodeTheme();
    const initialFontColor = loadFontColorSettings();
    // Store 初始化时立即应用主题、背景与字体，避免页面闪烁
    applyTheme(initialTheme);
    applyBgImage(initialBgImage);
    applyFontSettings(initialFont);
    applyOpacitySettings(loadOpacitySettings());
    // 配色与玻璃底色（null = 跟随主题，apply 内部做 removeProperty 幂等处理）
    applyAccent(initialAccent);
    applyGlassColor(initialGlassColor);
    applyCodeTheme(initialCodeTheme);
    applyFontColorSettings(initialFontColor);

    return {
        // === 初始状态 ===
        requirements: {list: [], selected: null, loading: false},
        workspace: {current: null, history: []},
        plan: {
            current: null,
            status: 'idle',
            // 从 localStorage 恢复上次关联的任务 ID，页面刷新后可继续上下文
            taskId: typeof window !== 'undefined' ? localStorage.getItem('ai-workbench-plan-taskid') : null,
            logs: [],
        },
        execution: {status: null, logs: [], executionId: null},
        tests: {results: null, running: false, phase: null, phaseLabel: null},
        pipelines: {list: [], active: null},
        ws: {connected: false},
        ui: {
            theme: initialTheme,
            sidebarCollapsed: false,
            locale: (localStorage.getItem('locale') as 'zh' | 'en') || 'zh',
            bgImage: initialBgImage,
            fontFamilyZh: initialFont.fontFamilyZh,
            fontFamilyEn: initialFont.fontFamilyEn,
            fontSize: initialFont.fontSize,
            notificationsEnabled: localStorage.getItem('ai-workbench-notifications') !== '0',
            opacity: loadOpacitySettings(),
            accent: initialAccent,
            glassColor: initialGlassColor,
            codeTheme: initialCodeTheme,
            fontColor: initialFontColor,
            mascot: loadMascotSettings(),
            quickSettings: {open: false, tab: loadQuickSettingsTab()},
        },
        providerCatalog: [],
        availableModels: {},
        piMeta: null,
        cliProvider: {
            configured: false,
            active: 'claude',
            showSetupModal: false,
            showModelConfigModal: false,
            // 各 Provider 的默认值由后端 Provider 自带（defaultModelSettings），fetchModelConfig 时填充
            modelConfig: {},
            // 权限模式默认询问确认，真实值由 fetchModelConfig 从后端同步
            permissionMode: 'confirm',
        },
        projects: {list: [], active: null, loading: false},
        tasks: {list: [], activeTaskId: null, logsByTask: {}, scheduler: null},
        agents: {executions: [], activeExecutionId: null, logs: [], logsByExecution: {}},

        // === 需求管理 Actions ===
        setRequirements: (list) =>
            set((state) => ({requirements: {...state.requirements, list}})),
        setSelectedRequirement: (selected) =>
            set((state) => ({requirements: {...state.requirements, selected}})),
        setRequirementsLoading: (loading) =>
            set((state) => ({requirements: {...state.requirements, loading}})),

        // === 工作空间 Actions ===
        setCurrentWorkspace: (current) =>
            set((state) => ({workspace: {...state.workspace, current}})),
        setWorkspaceHistory: (history) =>
            set((state) => ({workspace: {...state.workspace, history}})),

        // === 计划 Actions ===
        setCurrentPlan: (current) =>
            set((state) => ({plan: {...state.plan, current}})),
        setPlanStatus: (status) =>
            set((state) => ({plan: {...state.plan, status}})),
        setPlanTaskId: (taskId) => {
            // 同步持久化任务 ID 到 localStorage，确保页面刷新后可恢复关联
            if (taskId) {
                localStorage.setItem('ai-workbench-plan-taskid', taskId);
            } else {
                localStorage.removeItem('ai-workbench-plan-taskid');
            }
            return set((state) => ({plan: {...state.plan, taskId}}));
        },
        addPlanLog: (content) =>
            set((state) => ({plan: {...state.plan, logs: [...state.plan.logs, content]}})),
        clearPlanLogs: () =>
            set((state) => ({plan: {...state.plan, logs: []}})),

        // === 执行 Actions ===
        setExecutionStatus: (status) =>
            set((state) => ({execution: {...state.execution, status}})),
        setExecutionId: (executionId) =>
            set((state) => ({execution: {...state.execution, executionId}})),
        addExecutionLog: (entry) =>
            set((state) => ({
                execution: {...state.execution, logs: [...state.execution.logs, entry]},
            })),
        clearExecutionLogs: () =>
            set((state) => ({execution: {...state.execution, logs: []}})),

        // === 测试 Actions ===
        setTestResults: (results) =>
            set((state) => ({tests: {...state.tests, results, phase: null, phaseLabel: null}})),
        setTestRunning: (running) =>
            set((state) => ({tests: {...state.tests, running}})),
        setTestPhase: (phase, label) =>
            set((state) => ({tests: {...state.tests, phase, phaseLabel: label}})),

        // === 管道 Actions ===
        setPipelines: (list) =>
            set((state) => ({pipelines: {...state.pipelines, list}})),
        setActivePipeline: (active) =>
            set((state) => ({pipelines: {...state.pipelines, active}})),

        // === WebSocket Actions ===
        setWsConnected: (connected) => set({ws: {connected}}),

        // === UI Actions ===
        toggleTheme: () =>
            set((state) => {
                // 快捷明暗切换：当前是浅色系 → 切默认深色；否则切浅色
                const newTheme: Theme = THEME_MODES[state.ui.theme] === 'light' ? 'dark' : 'light';
                applyTheme(newTheme);
                return {ui: {...state.ui, theme: newTheme}};
            }),
        toggleSidebar: () =>
            set((state) => ({
                ui: {...state.ui, sidebarCollapsed: !state.ui.sidebarCollapsed},
            })),
        setSidebarCollapsed: (collapsed) =>
            set((state) => ({
                ui: {...state.ui, sidebarCollapsed: collapsed},
            })),
        setTheme: (theme) => {
            applyTheme(theme);
            return set((state) => ({ui: {...state.ui, theme}}));
        },
        setBgImage: (img) => {
            applyBgImage(img);
            if (img) localStorage.setItem(BG_IMAGE_KEY, img);
            else localStorage.removeItem(BG_IMAGE_KEY);
            return set((state) => ({ui: {...state.ui, bgImage: img}}));
        },
        setLocale: (locale) => {
            localStorage.setItem('locale', locale);
            return set((state) => ({ui: {...state.ui, locale}}));
        },
        setFontFamily: (zh, en) => {
            // 与当前字号合成完整设置后统一持久化并生效，避免覆盖丢失字号
            const settings: FontSettings = {
                fontFamilyZh: zh,
                fontFamilyEn: en,
                fontSize: get().ui.fontSize,
            };
            localStorage.setItem(FONT_KEY, JSON.stringify(settings));
            applyFontSettings(settings);
            return set((state) => ({ui: {...state.ui, fontFamilyZh: zh, fontFamilyEn: en}}));
        },
        setFontSize: (size) => {
            // 与当前字体合成完整设置后统一持久化并生效，避免覆盖丢失字体栈
            const settings: FontSettings = {
                fontFamilyZh: get().ui.fontFamilyZh,
                fontFamilyEn: get().ui.fontFamilyEn,
                fontSize: size,
            };
            localStorage.setItem(FONT_KEY, JSON.stringify(settings));
            applyFontSettings(settings);
            return set((state) => ({ui: {...state.ui, fontSize: size}}));
        },
        setNotificationsEnabled: (enabled) => {
            localStorage.setItem('ai-workbench-notifications', enabled ? '1' : '0');
            set((state) => ({ui: {...state.ui, notificationsEnabled: enabled}}));
        },
        setOpacity: (patch) => {
            const opacity = {...get().ui.opacity, ...patch};
            localStorage.setItem(OPACITY_KEY, JSON.stringify(opacity));
            applyOpacitySettings(opacity);
            set((state) => ({ui: {...state.ui, opacity}}));
        },
        setAccent: (pair) => {
            applyAccent(pair);
            if (pair) localStorage.setItem(ACCENT_KEY, JSON.stringify(pair));
            else localStorage.removeItem(ACCENT_KEY);
            set((state) => ({ui: {...state.ui, accent: pair}}));
        },
        setGlassColor: (hex) => {
            applyGlassColor(hex);
            if (hex) localStorage.setItem(GLASS_COLOR_KEY, hex);
            else localStorage.removeItem(GLASS_COLOR_KEY);
            set((state) => ({ui: {...state.ui, glassColor: hex}}));
        },
        setCodeTheme: (id) => {
            applyCodeTheme(id);
            localStorage.setItem(CODE_THEME_KEY, id);
            set((state) => ({ui: {...state.ui, codeTheme: id}}));
        },
        setMascot: (patch) => {
            const mascot = {...get().ui.mascot, ...patch};
            localStorage.setItem(MASCOT_KEY, JSON.stringify(mascot));
            set((state) => ({ui: {...state.ui, mascot}}));
        },
        setQuickSettingsOpen: (open) =>
            set((state) => ({ui: {...state.ui, quickSettings: {...state.ui.quickSettings, open}}})),
        setQuickSettingsTab: (tab) => {
            localStorage.setItem(QS_TAB_KEY, tab);
            set((state) => ({ui: {...state.ui, quickSettings: {...state.ui.quickSettings, tab}}}));
        },
        setFontColor: (patch) => {
            const fontColor = {...get().ui.fontColor, ...patch};
            localStorage.setItem(FONT_COLOR_KEY, JSON.stringify(fontColor));
            applyFontColorSettings(fontColor);
            set((state) => ({ui: {...state.ui, fontColor}}));
        },

        // === CLI Provider Actions ===
        setCliProvider: (configured, active) =>
            set((state) => ({cliProvider: {...state.cliProvider, configured, active}})),
        setProviderCatalog: (catalog) => set({providerCatalog: catalog}),
        setShowSetupModal: (show) =>
            set((state) => ({cliProvider: {...state.cliProvider, showSetupModal: show}})),
        setShowModelConfigModal: (show) =>
            set((state) => ({cliProvider: {...state.cliProvider, showModelConfigModal: show}})),
        setModelConfig: (provider, config) =>
            set((state) => ({
                cliProvider: {
                    ...state.cliProvider,
                    modelConfig: {
                        ...state.cliProvider.modelConfig,
                        [provider]: {...state.cliProvider.modelConfig[provider], ...config},
                    },
                },
            })),
        fetchModelConfig: async () => {
            set((state) => ({cliProvider: {...state.cliProvider, loading: true}}));
            try {
                const response = await fetch('/api/system/model-config');
                if (!response.ok) throw new Error('Failed to fetch model config');
                const data = await response.json() as {
                    activeProvider?: string;
                    models?: Record<string, ProviderModelSettings>;
                    permissionMode?: string;
                };
                // 权限模式：仅接受后端三档合法值，缺省/非法时保持现值
                const permissionMode = (['confirm', 'acceptEdits', 'bypassPermissions'] as const)
                    .find(m => m === data.permissionMode);
                set((state) => ({
                    cliProvider: {
                        ...state.cliProvider,
                        modelConfig: {...state.cliProvider.modelConfig, ...data.models},
                        ...(permissionMode ? {permissionMode} : {}),
                    },
                }));
            } catch (err) {
                console.error('Failed to load model config:', err);
            } finally {
                set((state) => ({cliProvider: {...state.cliProvider, loading: false}}));
            }
        },
        saveModelConfig: async (provider, config) => {
            set((state) => ({cliProvider: {...state.cliProvider, saving: true}}));
            try {
                const response = await fetch('/api/system/model-config', {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({models: {[provider]: config}}),
                });
                if (!response.ok) throw new Error('Failed to save model config');
                // 保存成功后直接更新本地状态，避免循环依赖
                set((state) => ({
                    cliProvider: {
                        ...state.cliProvider,
                        modelConfig: {
                            ...state.cliProvider.modelConfig,
                            [provider]: {...state.cliProvider.modelConfig[provider], ...config},
                        },
                    },
                }));
            } catch (err) {
                console.error('Failed to save model config:', err);
                throw err;
            } finally {
                set((state) => ({cliProvider: {...state.cliProvider, saving: false}}));
            }
        },
        setPermissionMode: async (mode) => {
            // 乐观更新：先切 UI，保存失败再回滚到原值
            const prev = get().cliProvider.permissionMode;
            set((state) => ({cliProvider: {...state.cliProvider, permissionMode: mode}}));
            try {
                await apiPut('/system/model-config', {permissionMode: mode});
            } catch (err) {
                set((state) => ({cliProvider: {...state.cliProvider, permissionMode: prev}}));
                console.error('Failed to save permission mode:', err);
                throw new Error('权限模式保存失败');
            }
        },
        setPiMeta: (meta) => set({piMeta: meta}),

        fetchAvailableModels: async () => {
            try {
                const response = await fetch('/api/system/available-models');
                if (!response.ok) throw new Error('Failed to fetch available models');
                const data = await response.json() as {
                    providers?: Record<string, AvailableModelsEntry>;
                };
                const providers = data.providers ?? {};

                set((state) => {
                    // 通用校正：对提供 tiers 的 Provider，若当前 model 不在档位列表则回落
                    //（档位别名由 SDK 解析，非法值会导致运行时模型解析失败）
                    const corrections: Record<string, ProviderModelSettings> = {};
                    for (const [id, entry] of Object.entries(providers)) {
                        const tiers = entry.tiers ?? [];
                        if (tiers.length === 0) continue;
                        const current = state.cliProvider.modelConfig[id];
                        const values = tiers.map(t => t.value);
                        const isValid = current?.model !== undefined && values.includes(current.model);
                        const fallback = values.includes('sonnet') ? 'sonnet' : values[0];
                        if (!isValid && fallback && current) {
                            corrections[id] = {...current, model: fallback};
                        }
                    }
                    return {
                        availableModels: providers,
                        ...(Object.keys(corrections).length > 0 ? {
                            cliProvider: {
                                ...state.cliProvider,
                                modelConfig: {...state.cliProvider.modelConfig, ...corrections},
                            },
                        } : {}),
                    };
                });
            } catch (err) {
                console.error('Failed to load available models:', err);
            }
        },

        // === 项目空间 Actions ===
        setProjects: (list) =>
            set((state) => ({projects: {...state.projects, list}})),
        setActiveProject: (active) =>
            set((state) => ({projects: {...state.projects, active}})),
        setProjectsLoading: (loading) =>
            set((state) => ({projects: {...state.projects, loading}})),

        // === 多任务 Actions ===
        setTasks: (list) =>
            set((state) => ({tasks: {...state.tasks, list}})),
        setActiveTaskId: (taskId) =>
            set((state) => ({tasks: {...state.tasks, activeTaskId: taskId}})),
        addTaskLog: (taskId, log) =>
            set((state) => ({
                tasks: {
                    ...state.tasks,
                    logsByTask: {
                        ...state.tasks.logsByTask,
                        [taskId]: [...(state.tasks.logsByTask[taskId] || []), log],
                    },
                },
            })),
        updateTask: (taskId, updates) =>
            set((state) => ({
                tasks: {
                    ...state.tasks,
                    list: state.tasks.list.map(t => t.id === taskId ? {...t, ...updates} : t),
                },
            })),
        setSchedulerStatus: (status) =>
            set((state) => ({tasks: {...state.tasks, scheduler: status}})),

        // Agent actions
        setAgentExecutions: (executions) =>
            set((state) => ({agents: {...state.agents, executions}})),
        setActiveAgentExecution: (executionId) =>
            set((state) => ({agents: {...state.agents, activeExecutionId: executionId}})),
        addAgentLog: (content, metadata?: {
            timestamp?: string;
            type?: 'output' | 'error' | 'warning' | 'user' | 'system' | 'tool' | 'file' | 'shell';
            taskId?: string;
            subtaskStatus?: 'reading' | 'fetching' | 'generating' | 'processing';
            tokensUsed?: number;
            duration?: number;
        }) =>
            set((state) => {
                // 如果是对象格式，直接添加
                if (typeof content === 'object') {
                    return {agents: {...state.agents, logs: [...state.agents.logs, JSON.stringify(content)]}};
                }
                // 如果是字符串格式，添加元数据
                if (metadata && Object.keys(metadata).length > 0) {
                    const logEntry = {
                        content: String(content),
                        ...metadata
                    };
                    return {agents: {...state.agents, logs: [...state.agents.logs, JSON.stringify(logEntry)]}};
                }
                // 简单字符串格式
                return {agents: {...state.agents, logs: [...state.agents.logs, content]}};
            }),
        setAgentLogs: (logs: string[]) =>
            set((state) => ({agents: {...state.agents, logs}})),
        clearAgentLogs: () =>
            set((state) => ({agents: {...state.agents, logs: []}})),
        addAgentLogToExecution: (executionId, content) =>
            set((state) => ({
                agents: {
                    ...state.agents,
                    logsByExecution: {
                        ...state.agents.logsByExecution,
                        [executionId]: [...(state.agents.logsByExecution[executionId] || []), content],
                    },
                },
            })),
        setAgentExecutionLogs: (executionId, logs) =>
            set((state) => ({
                agents: {
                    ...state.agents,
                    logsByExecution: {...state.agents.logsByExecution, [executionId]: logs},
                },
            })),
        removeAgentExecutionLogs: (executionId) =>
            set((state) => {
                const next = {...state.agents.logsByExecution};
                delete next[executionId];
                return {agents: {...state.agents, logsByExecution: next}};
            })
    };
});

// === UI 偏好跨来源同步（服务端持久化，端口无关）===
//
// localStorage 按 origin 隔离：dev:desktop(5173)、生产 electron(随机端口)、
// 浏览器(3000) 是互不相通的存储空间 —— 这就是「两种方式启动设置不一致」的根因。
// 同步策略（与 wallpaper-store 同款）：localStorage 秒开回显 → 启动时 GET
// /api/ui-preferences 以服务端为准合并 → 之后本机变更 400ms 防抖 PUT 回服务端。

const PREFS_URL = '/api/ui-preferences';
const PREFS_PUT_DELAY = 400;

let prefsSyncStarted = false;
let lastSyncedSnapshot = '';
let prefsPutTimer: ReturnType<typeof setTimeout> | null = null;

type UiSlice = AppState['ui'];

/** 收集需要跨来源同步的偏好子集（quickSettings.open 等会话态不进同步） */
function collectPreferences(ui: UiSlice): Record<string, unknown> {
    return {
        theme: ui.theme,
        locale: ui.locale,
        fontFamilyZh: ui.fontFamilyZh,
        fontFamilyEn: ui.fontFamilyEn,
        fontSize: ui.fontSize,
        notificationsEnabled: ui.notificationsEnabled,
        opacity: ui.opacity,
        accent: ui.accent,
        glassColor: ui.glassColor,
        codeTheme: ui.codeTheme,
        fontColor: ui.fontColor,
        mascot: ui.mascot,
        bgImage: ui.bgImage,
    };
}

function preferencesSnapshot(ui: UiSlice): string {
    try {
        return JSON.stringify(collectPreferences(ui));
    } catch {
        return '';
    }
}

/** 把服务端下发的偏好补丁应用进 store（校验 + 走各 applier 立即生效） */
function applyPreferencePatch(patch: Record<string, unknown>): void {
    const ui = useAppStore.getState().ui;
    const next: Partial<UiSlice> = {};

    if (typeof patch.theme === 'string' && patch.theme in THEME_MODES) {
        next.theme = patch.theme as Theme;
        applyTheme(next.theme);
    }
    if (patch.locale === 'zh' || patch.locale === 'en') next.locale = patch.locale;
    if (typeof patch.fontFamilyZh === 'string' && patch.fontFamilyZh.trim()) next.fontFamilyZh = patch.fontFamilyZh;
    if (typeof patch.fontFamilyEn === 'string' && patch.fontFamilyEn.trim()) next.fontFamilyEn = patch.fontFamilyEn;
    if (typeof patch.fontSize === 'number' && patch.fontSize >= 12 && patch.fontSize <= 18) next.fontSize = patch.fontSize;
    if (typeof patch.notificationsEnabled === 'boolean') next.notificationsEnabled = patch.notificationsEnabled;

    if (patch.opacity && typeof patch.opacity === 'object') {
        const p = patch.opacity as Partial<OpacitySettings>;
        const clampO = (v: unknown, fb: number) => (typeof v === 'number' && v >= 0.3 && v <= 1 ? v : fb);
        next.opacity = {
            global: clampO(p.global, ui.opacity.global),
            sidebar: clampO(p.sidebar, ui.opacity.sidebar),
            input: clampO(p.input, ui.opacity.input),
        };
        applyOpacitySettings(next.opacity);
    }
    if ('accent' in patch) {
        const a = patch.accent as AccentPair | null;
        if (a === null || (Boolean(a) && typeof a.from === 'string' && typeof a.to === 'string')) {
            next.accent = a;
            applyAccent(a);
        }
    }
    if ('glassColor' in patch) {
        const gc = patch.glassColor;
        if (gc === null || typeof gc === 'string') {
            next.glassColor = gc;
            applyGlassColor(gc);
        }
    }
    if (typeof patch.codeTheme === 'string' && CODE_THEME_PRESETS.some(p => p.id === patch.codeTheme)) {
        next.codeTheme = patch.codeTheme;
        applyCodeTheme(patch.codeTheme);
    }
    if (patch.fontColor && typeof patch.fontColor === 'object') {
        const fc = {...ui.fontColor, ...(patch.fontColor as Partial<FontColorSettings>)};
        next.fontColor = {
            enabled: fc.enabled === true,
            color: typeof fc.color === 'string' ? fc.color : DEFAULT_FONT_COLOR.color,
            weight: typeof fc.weight === 'number' && fc.weight >= 100 && fc.weight <= 900 ? fc.weight : 400,
            caretColor: typeof fc.caretColor === 'string' ? fc.caretColor : null,
        };
        applyFontColorSettings(next.fontColor);
    }
    if (patch.mascot && typeof patch.mascot === 'object') {
        const m = {...ui.mascot, ...(patch.mascot as Partial<MascotSettings>)};
        next.mascot = {
            enabled: m.enabled !== false,
            size: typeof m.size === 'number' && m.size >= 0.5 && m.size <= 2.5 ? m.size : 1,
            bubble: m.bubble !== false,
            form: PET_FORMS.includes(m.form) ? m.form : 'joi-flowers',
            position: sanitizeMascotPosition(m.position),
        };
    }
    if ('bgImage' in patch) {
        const b = patch.bgImage;
        if (b === null || typeof b === 'string') {
            next.bgImage = b;
            applyBgImage(b);
        }
    }

    if (Object.keys(next).length > 0) {
        useAppStore.setState((state) => ({ui: {...state.ui, ...next}}));
        // 应用后的状态即新基线：防止同步本身触发回环 PUT
        lastSyncedSnapshot = preferencesSnapshot(useAppStore.getState().ui);
    }
}

/**
 * 启动 UI 偏好同步（幂等，Layout 挂载时调用一次）
 * localStorage 秒开 → 服务端为准合并（服务端为空则反向播种）→ 变更防抖回写
 */
export function syncUiPreferences(): void {
    if (prefsSyncStarted) return;
    prefsSyncStarted = true;
    lastSyncedSnapshot = preferencesSnapshot(useAppStore.getState().ui);

    void (async () => {
        let serverHasPrefs = false;
        try {
            const res = await fetch(PREFS_URL);
            if (res.ok) {
                const prefs = (await res.json()) as Record<string, unknown>;
                if (prefs && typeof prefs === 'object' && Object.keys(prefs).length > 0) {
                    serverHasPrefs = true;
                    applyPreferencePatch(prefs);
                }
            }
        } catch { /* 服务端不可达：沿用 localStorage */ }

        // 服务端还没有偏好（首次）：把当前本地值播种上去，后续来源即可收敛
        if (!serverHasPrefs) {
            try {
                void fetch(PREFS_URL, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(collectPreferences(useAppStore.getState().ui)),
                });
            } catch { /* ignore */ }
        }

        // 后续本机变更：快照变化才防抖 PUT（全量）
        useAppStore.subscribe((state) => {
            const snap = preferencesSnapshot(state.ui);
            if (!snap || snap === lastSyncedSnapshot) return;
            lastSyncedSnapshot = snap;
            if (prefsPutTimer) clearTimeout(prefsPutTimer);
            prefsPutTimer = setTimeout(() => {
                void fetch(PREFS_URL, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(collectPreferences(useAppStore.getState().ui)),
                }).catch(() => undefined);
            }, PREFS_PUT_DELAY);
        });
    })();
}
