#!/usr/bin/env node
/**
 * 构建产物目录准备（原 package.json 里的两段内联 node -e 脚本，抽出以便维护）
 *
 * 用法：
 *   node scripts/stage-dist.mjs clean    —— 清理 dist/server、dist/cli（build:backend 前）
 *   node scripts/stage-dist.mjs assets   —— 拷贝 bridge/模板/技能到 dist/（build:bridge）
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cleanDirs(dirs) {
    for (const dir of dirs) {
        try {
            fs.rmSync(path.join(ROOT, dir), {recursive: true});
        } catch {
            // 目录不存在 → 已是干净状态
        }
    }
}

function cpDir(src, dest) {
    fs.mkdirSync(dest, {recursive: true});
    for (const e of fs.readdirSync(src, {withFileTypes: true})) {
        const s = path.join(src, e.name);
        const d = path.join(dest, e.name);
        if (e.isDirectory()) cpDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

function stageAssets() {
    // bridge（纯 mjs，不经 tsc，直接拷贝）
    const bridgeDir = path.join(ROOT, 'dist', 'bridge');
    fs.mkdirSync(bridgeDir, {recursive: true});
    fs.copyFileSync(
        path.join(ROOT, 'src', 'bridge', 'claude-bridge.mjs'),
        path.join(bridgeDir, 'claude-bridge.mjs'),
    );

    // Excel 模板
    const tplDir = path.join(ROOT, 'dist', 'templates');
    fs.mkdirSync(tplDir, {recursive: true});
    fs.copyFileSync(
        path.join(ROOT, 'templates', 'task-split-effort-template.xlsx'),
        path.join(tplDir, 'task-split-effort-template.xlsx'),
    );

    // 内置技能（skills/ 不存在时跳过）
    const skillsSrc = path.join(ROOT, 'skills');
    if (fs.existsSync(skillsSrc)) cpDir(skillsSrc, path.join(ROOT, 'dist', 'skills'));
}

const mode = process.argv[2];
if (mode === 'clean') {
    cleanDirs(['dist/server', 'dist/cli']);
} else if (mode === 'assets') {
    stageAssets();
} else {
    console.error('用法: node scripts/stage-dist.mjs <clean|assets>');
    process.exit(1);
}
