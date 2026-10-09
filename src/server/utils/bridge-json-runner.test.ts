/**
 * bridge-json-runner 活动看门狗测试。
 *
 * 背景：旧实现是「绝对定时器」（Promise.race + 30 分钟 reject），
 * 健康长任务到点被无脑杀掉，且 reject 后底层 bridge 泄漏继续跑。
 * 新实现 withOutputTimeout：「无输出才超时」——输出活动重置定时器，
 * 到点先 abort 内部 signal（真正停掉 bridge）再拒绝。
 */
import {describe, expect, it} from 'vitest';
import {withOutputTimeout} from './bridge-json-runner.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('withOutputTimeout（无输出活动看门狗）', () => {
    it('正常完成：不受看门狗影响，输出原样透传', async () => {
        const seen: string[] = [];
        const result = await withOutputTimeout(
            200,
            '测试任务',
            undefined,
            (data) => seen.push(data),
            async (_signal, onOutput) => {
                onOutput('a');
                onOutput('b');
                return 'ok';
            },
        );
        expect(result).toBe('ok');
        expect(seen).toEqual(['a', 'b']);
    });

    it('持续输出会不断重置定时器：总时长超过无输出容忍值也不中止', async () => {
        const result = await withOutputTimeout(
            120,
            '测试任务',
            undefined,
            undefined,
            async (_signal, onOutput) => {
                for (let i = 0; i < 6; i++) {
                    await sleep(60); // 总耗时 ~360ms > 120ms 容忍值，但每次输出都重置
                    onOutput(`tick-${i}`);
                }
                return 'long-but-alive';
            },
        );
        expect(result).toBe('long-but-alive');
    });

    it('沉寂到点：先中止底层 signal（真正停掉 bridge），再以明确错误拒绝', async () => {
        let bridgeSignal: AbortSignal | undefined;
        const promise = withOutputTimeout(
            50,
            '计划生成',
            undefined,
            undefined,
            async (signal) => {
                bridgeSignal = signal;
                await new Promise(() => undefined); // 模拟挂死：永不产出、永不返回
            },
        );
        await expect(promise).rejects.toThrow(/计划生成.*无任何输出（疑似卡死）/);
        expect(bridgeSignal?.aborted).toBe(true);
    });

    it('调用方 abort：内部 signal 联动中止，底层可感知', async () => {
        const controller = new AbortController();
        let bridgeSignal: AbortSignal | undefined;
        const promise = withOutputTimeout(
            60_000,
            '测试任务',
            controller.signal,
            undefined,
            (signal) =>
                new Promise<never>((_resolve, reject) => {
                    bridgeSignal = signal;
                    signal.addEventListener('abort', () => reject(new Error('bridge aborted')), {once: true});
                }),
        );
        controller.abort();
        await expect(promise).rejects.toThrow('bridge aborted');
        expect(bridgeSignal?.aborted).toBe(true);
    });
});
