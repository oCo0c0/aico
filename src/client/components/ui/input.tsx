/**
 * @file Input 输入框组件
 *
 * @description
 * 可复用的输入框(Input)组件，基于原生 `<input>` 元素封装。
 * 提供统一的视觉样式，包括边框、阴影、焦点环效果、禁用状态样式，
 * 以及文件上传按钮的样式重置。
 *
 * 使用 `React.forwardRef` 实现引用转发，便于与表单验证库集成。
 * 通过 `cn` 工具函数支持自定义 className 的合并扩展。
 *
 * @example
 * ```tsx
 * // 基础用法
 * <Input placeholder="请输入用户名" />
 *
 * // 带类型约束
 * <Input type="email" placeholder="请输入邮箱" />
 * <Input type="password" placeholder="请输入密码" />
 *
 * // 禁用状态
 * <Input disabled placeholder="不可编辑" />
 * ```
 */

import * as React from 'react';
import {cn} from '../../lib/utils';

/**
 * Input 输入框组件的属性接口
 *
 * 继承自原生 HTMLInputElement 的所有属性，包括 `type`、`placeholder`、
 * `value`、`onChange`、`disabled` 等。无需额外扩展自定义属性，
 * 保持与原生输入框的完整 API 兼容性。
 *
 * @extends React.InputHTMLAttributes<HTMLInputElement>
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Input 输入框组件
 *
 * 标准文本输入框，提供一致的视觉样式和交互体验。
 * 样式要点：
 * - 基础样式：全宽、固定高度(36px)、圆角边框、小号字体
 * - 焦点状态：显示主题色轮廓环（ring），提升可访问性
 * - 禁用状态：降低透明度并将光标设为禁止样式
 * - 文件输入：重置文件选择按钮的默认边框与背景样式
 * - 占位符：使用柔和的前景色，不干扰用户输入
 *
 * @param props - InputProps，包含 type、className 及其他原生 input 属性
 * @param ref   - 转发到原生 input 元素的 ref 引用
 * @returns 渲染后的 input 元素
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
    ({className, type, ...props}, ref) => {
        return (
            <input
                type={type}
                className={cn(
                    'flex h-9 w-full rounded-xl border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-all duration-200 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50',
                    className
                )}
                ref={ref}
                {...props}
            />
        );
    }
);
Input.displayName = 'Input';

export {Input};
