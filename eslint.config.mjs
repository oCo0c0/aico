/**
 * ESLint 平面配置（flat config）
 *
 * 策略：只开「抓真 bug」的规则，不开风格类规则（本仓库无 Prettier，格式以
 * 团队现状为准，避免一次性全量重排淹没 diff）。核心价值：
 * - react-hooks/rules-of-hooks   —— 钩子调用顺序合法性（真 bug，error）
 * - react-hooks/exhaustive-deps  —— useEffect/回调依赖数组完整性（历史回归多发区，warn）
 * - @typescript-eslint/no-unused-vars —— 死变量/死导入（下划线开头豁免）
 * - @typescript-eslint/no-explicit-any  —— any 使用点提醒（warn，存量约个位数）
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
    {
        // 构建产物/第三方/独立子包不参与 lint
        ignores: [
            'dist/**',
            'dist-electron/**',
            'release/**',
            'node_modules/**',
            'packages/**',
            'resources/**',
            'scripts/**',
            'src/client/public/**',
            'skills/**',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.{ts,tsx,mjs}'],
        plugins: {'react-hooks': reactHooks},
        rules: {
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            // 存量 90+ 处未用导入/变量，批量清理单独立项（批次⑥），先降 warn 不拦 CI
            '@typescript-eslint/no-unused-vars': ['warn', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            '@typescript-eslint/no-explicit-any': 'warn',
            // case 内词法声明不加花括号是既有风格（11 处），降 warn 随改随清
            'no-case-declarations': 'warn',
            // eslint 10 新规则，存量 catch 未挂 cause 的合法模式较多，降 warn
            'preserve-caught-error': 'warn',
            // 初始化值在部分控制流路径被读（如 gitDiff 的空串兜底），需逐例人工判断
            'no-useless-assignment': 'warn',
            // 空 catch + 注释是本仓库既定模式（「静默忽略」）
            'no-empty': ['error', {allowEmptyCatch: true}],
            // server-bootstrap.ts 的 require('tsx/cjs') 与部分测试 fixture 是合法 CJS 用法
            '@typescript-eslint/no-require-imports': 'warn',
            '@typescript-eslint/ban-ts-comment': 'warn',
        },
    },
    {
        // bridge 是纯 Node mjs（无类型系统），补 Node 运行时全局量
        files: ['src/bridge/**/*.mjs'],
        languageOptions: {
            globals: {
                process: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                URL: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                AbortController: 'readonly',
            },
        },
    },
);
