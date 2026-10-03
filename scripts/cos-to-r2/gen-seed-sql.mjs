#!/usr/bin/env node
/**
 * 把 `rclone lsjson --recursive` 的输出，转成能喂给 `wrangler d1 execute --file=` 的 INSERT SQL。
 *
 * 用法（零依赖，Node 18+）：
 *
 *   1) 先拿到清单（对桶根跑，Path 就是 R2 的键，少一处前缀写错的机会）：
 *        rclone lsjson --recursive "cos:album-1255316209" > img-lsjson.json
 *
 *   2) 生成 SQL：
 *        node gen-seed-sql.mjs img-lsjson.json ./seed
 *
 *   3) 导入：
 *        cd worker-r2
 *        npx wrangler d1 execute picbed-db --remote --file=../seed/seed_0001.sql
 *
 * 处理规则（顺序很重要）：
 *   1. 只保留 <prefix>/ 开头的对象
 *   2. **先**收集旧「公开标记」：<prefix>/_picbed/public/<相对键> 表示 <prefix>/<相对键> 是公开的
 *   3. 丢掉目录占位对象（IsDir 或 Path 以 / 结尾）
 *   4. 丢掉任一路径段等于 _picbed 或以 . 开头的对象（保留命名空间 / 隐藏文件）
 *   5. 丢掉 Size === 0 的对象（占位与垃圾；公开标记本身也是 0 字节，但第 2 步已经先收走了）
 *   6. 分级映射：旧站「有公开标记」→ rating='G'，其余 → 'unspecified'
 *      这样迁移后「相册里能看到什么」与迁移前完全一致
 *      （「不公开」由 unspecified 表达，**不占用 is_hidden** —— 两个维度不要混）
 *   7. is_hidden 一律 0
 *
 * 生成的 SQL 可重复执行：用 ON CONFLICT(r2_key) DO NOTHING
 * （不用 INSERT OR IGNORE —— 那会把 CHECK / NOT NULL 违规也一起吞掉，出错了都不知道）
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------- 参数 ----------

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const prefixArg = args.find((a) => a.startsWith('--prefix='));
const PREFIX = (prefixArg ? prefixArg.split('=')[1] : 'img').replace(/^\/+|\/+$/g, '');

const outDir = args.filter((a) => !a.startsWith('--'))[1] || './seed';

if (!input || !existsSync(input)) {
  console.error('用法: node gen-seed-sql.mjs <rclone-lsjson 路径> [输出目录] [--prefix=img]');
  process.exit(1);
}

// ---------- 分批上限 ----------
// wrangler d1 execute --file 对单个文件有大小限制，单条 SQL 也不宜太长，所以切碎
const MAX_STMT_BYTES = 64 * 1024;
const MAX_ROWS_PER_STMT = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// ---------- 工具 ----------

const TYPE_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** SQL 字符串字面量：单引号翻倍，去掉控制字符 */
function sqlStr(v) {
  if (v == null) return 'NULL';
  return "'" + String(v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/'/g, "''") + "'";
}

function mimeOf(entry, key) {
  const declared = (entry.MimeType || '').split(';')[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;
  const ext = key.split('.').pop().toLowerCase();
  return TYPE_BY_EXT[ext] || declared || 'application/octet-stream';
}

/** rclone 的时间可能是 0001-01-01（未知），也可能带纳秒；统一成 ISO8601 秒级 UTC */
function normalizeTime(raw) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (!raw || String(raw).startsWith('0001-01-01')) return now;
  const d = new Date(raw);
  if (isNaN(d)) return now;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 从键推导**逻辑相册名**：剥掉 <prefix>/ 之后的目录部分。
 *   img/2026/10/03/120000_aaaa1111.jpg → 2026/10/03
 *   img/travel/x.jpg                   → travel
 *
 * 相册名不含 `img/` 前缀，因为新模型里相册是数据库列、和键彻底解耦
 * （键保持不透明不可变，之后改名/移动相册都不会动直链）。
 */
function albumOf(key, prefix) {
  const root = prefix + '/';
  const rel = key.startsWith(root) ? key.slice(root.length) : key;
  const i = rel.lastIndexOf('/');
  return i > 0 ? rel.slice(0, i) : '';
}

function filenameOf(key) {
  return key.split('/').pop() || key;
}

/** 路径里是否有保留段（_picbed / 以 . 开头） */
function hasReservedSegment(key) {
  return key.split('/').some((s) => s === '_picbed' || (s.length > 1 && s.startsWith('.')));
}

// ---------- 读取与分类 ----------

const raw = JSON.parse(readFileSync(input, 'utf8'));
if (!Array.isArray(raw)) {
  console.error('输入不是 rclone lsjson 的数组格式');
  process.exit(1);
}

const stats = {
  总对象: raw.length,
  不在前缀内: 0,
  公开标记: 0,
  目录占位: 0,
  保留路径: 0,
  空文件: 0,
  入库: 0,
  悬空标记: 0,
  公开: 0,
  总字节: 0,
};

const publicPrefix = `${PREFIX}/_picbed/public/`;
const publicSet = new Set(); // 存放「公开」的图片键

// 第 1 步：先收公开标记（它们本身是 0 字节，晚于空文件过滤就会被丢掉）
for (const e of raw) {
  const key = e.Path || '';
  if (e.IsDir || key.endsWith('/')) continue;
  if (!key.startsWith(publicPrefix)) continue;
  const target = PREFIX + '/' + key.slice(publicPrefix.length);
  if (target && target !== PREFIX + '/') {
    publicSet.add(target);
    stats.公开标记++;
  }
}

// 第 2 步：筛出真正的图片
const rows = [];
const allKeys = new Set();

for (const e of raw) {
  const key = e.Path || '';
  if (!key.startsWith(PREFIX + '/')) {
    stats.不在前缀内++;
    continue;
  }
  if (e.IsDir || key.endsWith('/')) {
    stats.目录占位++;
    continue;
  }
  if (hasReservedSegment(key)) {
    stats.保留路径++;
    continue;
  }
  if (!e.Size) {
    stats.空文件++;
    continue;
  }

  allKeys.add(key);
  stats.入库++;
  const rating = publicSet.has(key) ? 'G' : 'unspecified';
  if (rating === 'G') stats.公开++;

  rows.push({
    r2_key: key,
    filename: filenameOf(key),
    mime: mimeOf(e, key),
    size: Number(e.Size) || 0,
    is_hidden: 0,
    rating,
    album: albumOf(key, PREFIX),
    uploaded_at: normalizeTime(e.ModTime),
  });
  stats.总字节 += Number(e.Size) || 0;
}

// 悬空标记：标记指向的图片并不存在（旧站移动/删除时可能残留）
for (const key of publicSet) if (!allKeys.has(key)) stats.悬空标记++;

// ---------- 生成 SQL ----------

const COLS = '(r2_key, filename, mime, size, is_hidden, rating, album, uploaded_at, updated_at)';

function rowSql(r) {
  return `(${sqlStr(r.r2_key)},${sqlStr(r.filename)},${sqlStr(r.mime)},${r.size},${r.is_hidden},${sqlStr(r.rating)},${sqlStr(r.album)},${sqlStr(r.uploaded_at)},${sqlStr(r.uploaded_at)})`;
}

if (!rows.length) {
  console.log('没有需要入库的对象。');
  printStats();
  process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let fileIndex = 1;
let fileBody = '';
const written = [];

let stmtRows = [];
let stmtBytes = 0;

function flushStatement() {
  if (!stmtRows.length) return;
  const stmt = `INSERT INTO images ${COLS} VALUES\n${stmtRows.join(',\n')}\nON CONFLICT(r2_key) DO NOTHING;\n`;
  // 单个文件太大就切新文件
  if (Buffer.byteLength(fileBody) + Buffer.byteLength(stmt) > MAX_FILE_BYTES) {
    flushFile();
  }
  fileBody += stmt;
  stmtRows = [];
  stmtBytes = 0;
}

function flushFile() {
  if (!fileBody) return;
  const name = `seed_${String(fileIndex).padStart(4, '0')}.sql`;
  const text = `-- 由 gen-seed-sql.mjs 生成，可重复执行（ON CONFLICT DO NOTHING）\n${fileBody}`;
  writeFileSync(join(outDir, name), text, 'utf8'); // 无 BOM
  written.push(name);
  fileIndex++;
  fileBody = '';
}

for (const r of rows) {
  const s = rowSql(r);
  stmtRows.push(s);
  stmtBytes += Buffer.byteLength(s) + 2;
  if (stmtRows.length >= MAX_ROWS_PER_STMT || stmtBytes >= MAX_STMT_BYTES) flushStatement();
}
flushStatement();
flushFile();

// ---------- 汇报 ----------

console.log(`生成 ${written.length} 个 SQL 文件：${join(outDir, written[0])}${written.length > 1 ? ` … ${written[written.length - 1]}` : ''}`);
console.log('导入命令：');
console.log(`  cd worker-r2`);
for (const n of written) console.log(`  npx wrangler d1 execute picbed-db --remote --file=${join(outDir, n)}`);
console.log('');
printStats();
console.log('');
console.log('⚠️ 核对：');
console.log(`   * 「公开」数应等于 COS 上 ${publicPrefix} 下的标记数（悬空标记 ${stats.悬空标记} 个已排除）`);
console.log(`   * 「入库」数应等于 rclone size "${PREFIX}" 的对象数减去空文件/占位`);
console.log(`   * 「总字节」应等于 rclone size 报的字节数`);

function printStats() {
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k.padEnd(8, '　')} ${v}`);
  }
}
