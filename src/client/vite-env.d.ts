/// <reference types="vite/client" />

/**
 * 编译期注入的应用版本号（vite.config.ts define 从 package.json 读取）。
 * 设置中心「版本与更新」区展示用；Web 与桌面同源。
 */
declare const __APP_VERSION__: string;
