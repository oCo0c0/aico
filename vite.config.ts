import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    root: 'src/client',
    build: {
        outDir: path.resolve(__dirname, 'dist/client'),
        emptyOutDir: true,
        rollupOptions: {
            output: {
                // vendor 分包：大依赖独立成块，业务代码迭代不再打掉它们的缓存；
                // 页面本体经 Layout 的路由级 lazy 各自成块，首屏只加载当前页
                manualChunks(id) {
                    if (!id.includes('node_modules')) return undefined;
                    // Markdown 渲染链（react-markdown 及其 unified/remark/rehype 系依赖，
                    // 体积大头之一，仅聊天/日志页需要）
                    if (/node_modules[\\/](react-markdown|remark-[^\\/]*|rehype-[^\\/]*|unified|micromark[^\\/]*|mdast[^\\/]*|hast[^\\/]*|unist[^\\/]*|bail|trough|vfile[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities[^\\/]*|zwitch|loose-envify)/.test(id)) {
                        return 'vendor-markdown';
                    }
                    if (id.includes('react-joyride') || id.includes('react-float') || id.includes('popper.js') || id.includes('@popperjs')) {
                        return 'vendor-joyride';
                    }
                    if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) {
                        return 'vendor-motion';
                    }
                    if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|@remix-run|i18next|react-i18next|zustand)[\\/]/.test(id)) {
                        return 'vendor-core';
                    }
                    return 'vendor-misc';
                },
            },
        },
    },
    server: {
        proxy: {
            '/api/': 'http://localhost:3000',
            '/ws': {
                target: 'ws://localhost:3000',
                ws: true,
            },
        },
    },
});
