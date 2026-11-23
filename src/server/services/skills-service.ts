/**
 * @file Claude 技能管理服务
 * @description 提供对技能（Skills / Slash Commands）的扫描、读取、创建、更新和删除能力。
 *   技能以 Markdown 文件的形式存储在两个位置（**均在应用自管的隔离目录内**，
 *   首次使用时由 cli-isolation 从用户的 ~/.claude 播种一份，之后应用自管）：
 *   - <隔离目录>/commands/ - 全局自定义命令（扁平结构，每个 .md 文件为一个技能）
 *   - <隔离目录>/skills/ - 技能目录（每个子目录为一个技能，子目录内需有 SKILL.md）
 *   注意：不再读写用户的 ~/.claude —— 内置技能同步曾直接写入 CLI 目录，与用户环境混用。
 */

import fs from 'fs';
import path from 'path';
import {extractDescription} from '../utils/markdown-utils.js';
import {findSkillMdFile as _findSkillMdFile} from '../utils/skill-utils.js';
import {isolatedPath} from './cli-isolation.js';

/**
 * 技能基本信息接口
 * @description 表示一个 Claude 技能的摘要信息，用于列表展示
 */
export interface Skill {
    /** 技能名称（对应文件名或目录名） */
    name: string;
    /** 技能描述（从文件内容中自动提取的第一行非空文本） */
    description: string;
    /** 技能是否启用（当前版本始终为 true） */
    enabled: boolean;
    /** 技能文件的完整路径 */
    filePath: string;
    /** 是否为自动生成的技能 */
    isAutoDerived?: boolean;
}

/**
 * 技能详细信息接口
 * @description 继承 Skill，包含技能的完整 Markdown 文件内容
 */
export interface SkillDetail extends Skill {
    /** 技能的完整 Markdown 内容 */
    content: string;
}



/**
 * 技能管理服务类
 * @description 提供技能的完整生命周期管理，包括：
 *   - 扫描：同时从 commands/ 和 skills/ 两个目录发现技能
 *   - 读取：获取技能的完整内容和元信息
 *   - 创建/更新：在 commands/ 目录下创建或修改 .md 文件
 *   - 删除：移除指定技能的 .md 文件
 */
export class SkillsService {
    /** 全局命令目录路径 */
    private commandsDir: string;
    /** 技能目录路径 */
    private skillsDir: string;

    /**
     * 构造函数
     * @param commandsDir - 可选的自定义命令目录，默认隔离目录下的 commands/
     * @param skillsDir - 可选的自定义技能目录，默认隔离目录下的 skills/
     */
    constructor(commandsDir?: string, skillsDir?: string) {
        this.commandsDir = commandsDir ?? isolatedPath('claude', 'commands');
        this.skillsDir = skillsDir ?? isolatedPath('claude', 'skills');
    }

    /**
     * 确保命令目录存在
     * @description 如果目录不存在则递归创建
     */
    private ensureCommandsDir(): void {
        if (!fs.existsSync(this.commandsDir)) {
            fs.mkdirSync(this.commandsDir, {recursive: true});
        }
    }

    /**
     * 确保技能目录存在
     * @description 如果目录不存在则递归创建
     */
    private ensureSkillsDir(): void {
        if (!fs.existsSync(this.skillsDir)) {
            fs.mkdirSync(this.skillsDir, {recursive: true});
        }
    }

    /**
     * 将内置技能从源目录同步到 ~/.claude/skills/
     * @description 在服务启动时调用，确保内置技能对 Claude CLI 可见。
     *   以 SKILL.md 的 MD5 指纹判断是否需要更新，避免重复写入。
     * @param builtinSourceDir - 内置技能的源目录（项目 skills/ 或 dist/skills/）
     * @returns 同步结果统计
     */
    syncBuiltinSkills(builtinSourceDir: string): { synced: number; skipped: number; errors: number } {
        let synced = 0, skipped = 0, errors = 0;
        if (!fs.existsSync(builtinSourceDir)) return {synced, skipped, errors};

        this.ensureSkillsDir();

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(builtinSourceDir, {withFileTypes: true});
        } catch {
            return {synced, skipped, errors: 1};
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const srcMd = path.join(builtinSourceDir, entry.name, 'SKILL.md');
            if (!fs.existsSync(srcMd)) continue;

            try {
                const srcContent = fs.readFileSync(srcMd, 'utf-8');
                const targetDir = path.join(this.skillsDir, entry.name);
                const targetMd = path.join(targetDir, 'SKILL.md');

                // 已存在且内容相同 → 跳过
                if (fs.existsSync(targetMd)) {
                    const existingContent = fs.readFileSync(targetMd, 'utf-8');
                    if (existingContent === srcContent) {
                        skipped++;
                        continue;
                    }
                }

                // 写入目标
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, {recursive: true});
                }
                fs.writeFileSync(targetMd, srcContent, 'utf-8');
                synced++;
            } catch {
                errors++;
            }
        }

        return {synced, skipped, errors};
    }

    /**
     * 从文件名推导技能名称
     * @description 移除 .md 文件扩展名，得到技能名称
     * @param filename - 文件名（如 "my-skill.md"）
     * @returns 技能名称（如 "my-skill"）
     */
    private fileNameToSkillName(filename: string): string {
        return filename.replace(/\.md$/, '');
    }

    /**
     * 列出所有可用技能
     * @description 同时扫描 commands/ 和 skills/ 两个目录：
     *   - commands/ 目录：直接读取其中的 .md 文件
     *   - skills/ 目录：读取子目录中的 .md 文件（优先 index.md），
     *     同时也支持直接放置在 skills/ 根目录下的 .md 文件
     * @returns 合并后的技能列表
     */
    list(): Skill[] {
        const skills: Skill[] = [];

        // 扫描 commands/ 目录中的 .md 文件
        if (fs.existsSync(this.commandsDir)) {
            try {
                const entries = fs.readdirSync(this.commandsDir, {withFileTypes: true});
                for (const entry of entries) {
                    if (entry.isFile() && entry.name.endsWith('.md')) {
                        const filePath = path.join(this.commandsDir, entry.name);
                        try {
                            const content = fs.readFileSync(filePath, 'utf-8');
                            skills.push({
                                name: this.fileNameToSkillName(entry.name),
                                description: extractDescription(content),
                                enabled: true,
                                filePath,
                                isAutoDerived: entry.name.startsWith('auto-derived-'),
                            });
                        } catch {
                            // 跳过无法读取的文件
                        }
                    }
                }
            } catch {
                // 忽略目录读取错误
            }
        }

        // 扫描 skills/ 目录（子目录结构和根目录 .md 文件）
        if (fs.existsSync(this.skillsDir)) {
            try {
                const entries = fs.readdirSync(this.skillsDir, {withFileTypes: true});
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        // 子目录模式：每个子目录代表一个技能
                        const skillDir = path.join(this.skillsDir, entry.name);
                        const mdFile = this.findSkillMdFile(skillDir);
                        if (mdFile) {
                            try {
                                const content = fs.readFileSync(mdFile, 'utf-8');
                                skills.push({
                                    name: entry.name,
                                    description: extractDescription(content),
                                    enabled: true,
                                    filePath: mdFile,
                                });
                            } catch {
                                // 跳过
                            }
                        }
                    } else if (entry.isFile() && entry.name.endsWith('.md')) {
                        // 根目录 .md 文件模式：与 commands/ 相同的处理方式
                        const filePath = path.join(this.skillsDir, entry.name);
                        try {
                            const content = fs.readFileSync(filePath, 'utf-8');
                            skills.push({
                                name: this.fileNameToSkillName(entry.name),
                                description: extractDescription(content),
                                enabled: true,
                                filePath,
                                isAutoDerived: entry.name.startsWith('auto-derived-'),
                            });
                        } catch {
                            // 跳过
                        }
                    }
                }
            } catch {
                // 忽略目录读取错误
            }
        }

        return skills;
    }

    /** 委托到 skill-utils.findSkillMdFile */
    private findSkillMdFile(dirPath: string): string | null {
        return _findSkillMdFile(dirPath);
    }

    /**
     * 获取指定技能的完整详情（包括内容）
     * @description 同时搜索 commands/ 和 skills/ 两个目录
     * @param name - 技能名称
     * @returns 技能详情对象，未找到时返回 undefined
     */
    get(name: string): SkillDetail | undefined {
        // name 来自路由参数，先净化（与 delete() 同规则），防止路径遍历读任意文件
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-');
        // 1. 搜索 commands/ 目录（扁平 .md 文件）
        const commandFile = path.join(this.commandsDir, `${safeName}.md`);
        if (fs.existsSync(commandFile)) {
            try {
                const content = fs.readFileSync(commandFile, 'utf-8');
                return {
                    name,
                    description: extractDescription(content),
                    enabled: true,
                    filePath: commandFile,
                    content,
                };
            } catch {
                // 继续搜索 skills/ 目录
            }
        }

        // 2. 搜索 skills/ 目录（子目录结构）
        const skillDir = path.join(this.skillsDir, safeName);
        if (fs.existsSync(skillDir)) {
            try {
                const stat = fs.statSync(skillDir);
                if (stat.isDirectory()) {
                    const mdFile = this.findSkillMdFile(skillDir);
                    if (mdFile) {
                        const content = fs.readFileSync(mdFile, 'utf-8');
                        return {
                            name,
                            description: extractDescription(content),
                            enabled: true,
                            filePath: mdFile,
                            content,
                        };
                    }
                }
            } catch {
                // 忽略
            }
        }

        // 3. 搜索 skills/ 根目录的 .md 文件
        const skillFile = path.join(this.skillsDir, `${safeName}.md`);
        if (fs.existsSync(skillFile)) {
            try {
                const content = fs.readFileSync(skillFile, 'utf-8');
                return {
                    name,
                    description: extractDescription(content),
                    enabled: true,
                    filePath: skillFile,
                    content,
                };
            } catch {
                // 忽略
            }
        }

        return undefined;
    }

    /**
     * 创建新技能
     * @description 在 skills/ 目录下按标准目录结构创建：skills/<name>/SKILL.md
     *   技能名称会被清理：仅允许字母、数字、连字符和下划线，其他字符替换为连字符。
     * @param name - 技能名称
     * @param content - 技能的 Markdown 内容
     * @returns 创建后的技能详情对象
     * @throws 当名称为空、内容为空或同名技能已存在时抛出错误
     */
    create(name: string, content: string): SkillDetail {
        if (!name || name.trim() === '') {
            throw new Error('Skill name is required');
        }

        if (!content || content.trim() === '') {
            throw new Error('Skill content cannot be empty');
        }

        // 清理技能名称：仅保留字母、数字、连字符和下划线
        const sanitizedName = name.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
        const skillDir = path.join(this.skillsDir, sanitizedName);
        const filePath = path.join(skillDir, 'SKILL.md');

        if (fs.existsSync(filePath)) {
            throw new Error(`Skill "${sanitizedName}" already exists`);
        }

        this.ensureSkillsDir();
        if (!fs.existsSync(skillDir)) {
            fs.mkdirSync(skillDir, {recursive: true});
        }
        fs.writeFileSync(filePath, content, 'utf-8');

        return {
            name: sanitizedName,
            description: extractDescription(content),
            enabled: true,
            filePath,
            content,
        };
    }

    /**
     * 更新现有技能的内容
     * @description 优先查找 skills/<name>/SKILL.md（标准目录），
     *   回退到 commands/<name>.md（旧格式兼容）。
     * @param name - 技能名称
     * @param content - 新的 Markdown 内容
     * @returns 更新后的技能详情对象
     * @throws 当内容为空或技能不存在时抛出错误
     */
    update(name: string, content: string): SkillDetail {
        if (!content || content.trim() === '') {
            throw new Error('Skill content cannot be empty');
        }

        if (!name || name.trim() === '') {
            throw new Error('Skill name is required');
        }

        // 清理技能名称：仅保留字母、数字、连字符和下划线，与 create 保持一致
        const sanitizedName = name.trim().replace(/[^a-zA-Z0-9_-]/g, '-');

        // 优先查找标准目录结构
        const skillFilePath = path.join(this.skillsDir, sanitizedName, 'SKILL.md');
        // 回退到旧扁平格式
        const commandFilePath = path.join(this.commandsDir, `${sanitizedName}.md`);

        let filePath: string;
        if (fs.existsSync(skillFilePath)) {
            filePath = skillFilePath;
        } else if (fs.existsSync(commandFilePath)) {
            filePath = commandFilePath;
        } else {
            throw new Error(`Skill "${sanitizedName}" not found`);
        }

        // 确保目标路径在允许的目录内
        if (!filePath.startsWith(this.skillsDir) && !filePath.startsWith(this.commandsDir)) {
            throw new Error(`Skill "${name}" is outside allowed directories`);
        }

        fs.writeFileSync(filePath, content, 'utf-8');

        return {
            name: sanitizedName,
            description: extractDescription(content),
            enabled: true,
            filePath,
            content,
        };
    }

    /**
     * 删除指定技能
     * @description 优先查找 skills/<name>/SKILL.md，回退到 commands/<name>.md。
     *   删除标准目录技能时会同时删除整个技能子目录。
     * @param name - 技能名称
     * @returns 是否删除成功（false 表示技能不存在）
     */
    delete(name: string): boolean {
        if (!name || name.trim() === '') {
            throw new Error('Skill name is required');
        }

        // 清理技能名称：仅保留字母、数字、连字符和下划线
        const sanitizedName = name.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
        const skillDir = path.join(this.skillsDir, sanitizedName);
        const skillFilePath = path.join(skillDir, 'SKILL.md');
        const commandFilePath = path.join(this.commandsDir, `${sanitizedName}.md`);

        // 标准目录结构
        if (fs.existsSync(skillFilePath)) {
            if (!skillFilePath.startsWith(this.skillsDir)) {
                throw new Error(`Skill "${name}" is outside skills directory`);
            }
            // 删除整个技能子目录
            fs.rmSync(skillDir, {recursive: true, force: true});
            return true;
        }

        // 回退：旧扁平格式
        if (fs.existsSync(commandFilePath)) {
            if (!commandFilePath.startsWith(this.commandsDir)) {
                throw new Error(`Skill "${name}" is outside commands directory`);
            }
            fs.unlinkSync(commandFilePath);
            return true;
        }

        return false;
    }

}
