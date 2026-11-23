/**
 * @file attachment-store.ts
 * @description 聊天附件的内存暂存：上传时经 MinerU 解析为 markdown 存入，
 *   发送消息时一次性取出并注入引擎 prompt——聊天记录只落 stub，不存全文。
 */

export interface StoredAttachment {
    id: string;
    fileName: string;
    markdown: string;
    chars: number;
    createdAt: number;
}

/** 内存暂存 TTL：30 分钟未消费即清理 */
const TTL_MS = 30 * 60 * 1000;

export class AttachmentStore {
    private entries = new Map<string, StoredAttachment>();
    private pendingByOwner = new Map<string, StoredAttachment[]>();

    save(fileName: string, markdown: string): StoredAttachment {
        this.sweep();
        const att: StoredAttachment = {
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            // 净化引号：fileName 会被拼进 formatAttachmentsBlock 的 XML 属性，避免破坏结构
            fileName: fileName.replace(/"/g, "'"),
            markdown,
            chars: markdown.length,
            createdAt: Date.now(),
        };
        this.entries.set(att.id, att);
        return att;
    }

    get(id: string): StoredAttachment | undefined {
        return this.entries.get(id);
    }

    /** 一次性消费：按 id 取出并删除（未知 id 忽略） */
    drain(ids: string[]): StoredAttachment[] {
        const out: StoredAttachment[] = [];
        for (const id of ids) {
            const att = this.entries.get(id);
            if (att) {
                out.push(att);
                this.entries.delete(id);
            }
        }
        return out;
    }

    /** 绑定到会话主体（agent-execution 的 executionId），由协调器组 prompt 时取走 */
    bindPending(ownerId: string, atts: StoredAttachment[]): void {
        const list = this.pendingByOwner.get(ownerId) ?? [];
        list.push(...atts);
        this.pendingByOwner.set(ownerId, list);
    }

    takePending(ownerId: string): StoredAttachment[] {
        const list = this.pendingByOwner.get(ownerId) ?? [];
        this.pendingByOwner.delete(ownerId);
        return list;
    }

    sweep(): void {
        const now = Date.now();
        for (const [id, att] of this.entries) {
            if (now - att.createdAt > TTL_MS) this.entries.delete(id);
        }
        // pendingByOwner 同步清理：owner（executionId）从未消费时，
        // 附件全文（可达数百 KB/条）会永久驻留内存
        for (const [owner, list] of this.pendingByOwner) {
            const oldest = list.reduce((min, a) => Math.min(min, a.createdAt), Infinity);
            if (Number.isFinite(oldest) && now - oldest > TTL_MS) this.pendingByOwner.delete(owner);
        }
    }
}

/** 把解析后的附件格式化为注入 prompt 的 XML 块 */
export function formatAttachmentsBlock(atts: StoredAttachment[]): string {
    if (atts.length === 0) return '';
    const body = atts
        .map(a => `<attachment name="${a.fileName}">\n${a.markdown}\n</attachment>`)
        .join('\n');
    return `\n\n<attachments>\n以下是用户随消息附带的文档（已解析为文本/markdown），请结合其内容理解用户需求：\n${body}\n</attachments>`;
}
