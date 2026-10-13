/**
 * 从开源主题 dsh-joi-channel-theme 提取吉祥物精灵图 → src/client/public/mascot/
 *
 * 素材许可：CC BY-NC-SA 4.0（仓库 LICENSE-ASSETS.md；代码 MIT）。
 * src/generated/assets.ts 是生成物不入库，改从 stuff/Stuff for Use/ 源 PNG 起步，
 * 复刻 scripts/gen-assets.mjs 的压缩管线（LANCZOS 降到 512 宽 + WebP 无损/q95 取小）。
 * 格序（与主题 chat.ts CELL 一致）：[0,0]=info [1,0]=success [0,1]=running [1,1]=error。
 */
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'src/client/public/mascot');
const BRANCH = 'main';
const BASE = `https://raw.githubusercontent.com/tpmoonchefryan/dsh-joi-channel-theme/${BRANCH}`;
const SRC_DIR = resolve(ROOT, '.joi-src');

// key → [源文件名, 输出名]（源文件即主题用过的 aligned/traced 精灵表）
const WANTED = {
    'joi-flowers.webp': 'In a Chat - Flowers 3-aligned.png',
    'joi-library.webp': 'In a Chat - Library 2-aligned.png',
    'zhouxin.webp': 'In a Chat - Zhouxin-traced.png',
};
const TARGET_WIDTH = 512;

const h = {'User-Agent': 'node'};
mkdirSync(SRC_DIR, {recursive: true});
mkdirSync(OUT_DIR, {recursive: true});
for (const file of Object.values(WANTED)) {
    const url = `${BASE}/stuff/Stuff for Use/${encodeURIComponent(file)}`;
    const buf = Buffer.from(await (await fetch(url, {headers: h})).arrayBuffer());
    writeFileSync(resolve(SRC_DIR, file), buf);
    console.log(`↓ ${file} (${(buf.length / 1024).toFixed(0)} KB)`);
}

const PY = `
import sys, json, io
from PIL import Image
src_dir, out_dir, width = sys.argv[1], sys.argv[2], int(sys.argv[3])
plan = json.loads(sys.argv[4])
report = []
for out_name, src_name in plan.items():
    im = Image.open(src_dir + "/" + src_name).convert("RGBA")
    w0, h0 = im.size
    if w0 > width:
        im = im.resize((width, round(h0 * width / w0)), Image.LANCZOS)
    best = None
    for tag, kw in (("lossless", dict(lossless=True, method=6)),
                    ("q95", dict(quality=95, method=6))):
        buf = io.BytesIO(); im.save(buf, format="WEBP", **kw)
        data = buf.getvalue()
        if best is None or len(data) < len(best[1]):
            best = (tag, data)
    tag, data = best
    open(out_dir + "/" + out_name, "wb").write(data)
    report.append([out_name, w0, h0, im.size[0], im.size[1], len(data), tag])
print(json.dumps(report))
`;

const report = JSON.parse(execFileSync('python', ['-c', PY, SRC_DIR, OUT_DIR, String(TARGET_WIDTH), JSON.stringify(WANTED)], {encoding: 'utf8'}));
for (const [name, w0, h0, w1, h1, bytes, tag] of report) {
    console.log(`${name}: ${w0}x${h0} → ${w1}x${h1} ${(bytes / 1024).toFixed(0)} KB (${tag})`);
}

// 署名文件（CC BY-NC-SA 要求 attribution）
const license = await (await fetch(`${BASE}/LICENSE-ASSETS.md`, {headers: h})).text();
writeFileSync(resolve(OUT_DIR, 'LICENSE-ASSETS.md'), license);
const notices = await (await fetch(`${BASE}/THIRD_PARTY_NOTICES.md`, {headers: h})).text();
writeFileSync(resolve(OUT_DIR, 'THIRD_PARTY_NOTICES.md'), notices);
console.log('LICENSE-ASSETS.md / THIRD_PARTY_NOTICES.md → public/mascot/');
