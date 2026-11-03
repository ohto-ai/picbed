#!/usr/bin/env node
/**
 * 存量图片库一次性处理：回填内容指纹（sha256）+ 清理重复。
 *
 * 背景：新上传是内容寻址（键 = img/<sha256>.<ext>，服务端在 begin/单传阶段查重），
 * 但迁移过来的老图没有指纹，查重覆盖不到它们；而且老上传机制下同一张图可能已经
 * 存了好几份（每次上传 = 新键 = 新对象）。这个脚本做两件事：
 *
 *   1. 回填：对 sha256 为空的行，从公网直链把原图拉下来算 SHA-256 写回 D1；
 *   2. 去重：按指纹分组，每组保留最早一条（uploaded_at, id），其余删掉
 *      （D1 行 + R2 原图对象 + 缩略图对象）。
 *
 * 用法（在仓库根目录）：
 *   node scripts/backfill-dedup.mjs             # 回填 + 打印重复报告（不删任何东西）
 *   node scripts/backfill-dedup.mjs --apply     # 报告里列出的重复项真删
 *   node scripts/backfill-dedup.mjs --local     # 打在本地 wrangler dev 的库上（联调用）
 *   node scripts/backfill-dedup.mjs --base https://img.ohtoai.top   # 直链前缀（默认同左）
 *
 * 凭据：只依赖本机已登录的 wrangler（npx wrangler whoami 能过就行），
 * 远程 D1/R2 都通过它操作，不需要额外的 API Token 或站点密码。
 * 幂等：可反复重跑；已回填的行会跳过，删过的行自然消失。下载 404 的行只报告、不动库。
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const LOCAL = process.argv.includes('--local'); // 打在本地 wrangler dev 的库上（配合 .dev.vars）
const baseIdx = process.argv.indexOf('--base');
const BASE = (baseIdx > -1
  ? process.argv[baseIdx + 1]
  : LOCAL ? 'http://127.0.0.1:8787' : 'https://img.ohtoai.top'
).replace(/\/+$/, '');
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker-r2');
const DB = 'picbed-db';
const D1_TARGET = LOCAL ? [] : ['--remote'];
const R2_TARGET = LOCAL ? ['--local'] : ['--remote'];
const DOWNLOAD_CONCURRENCY = 8;
const SQL_CHUNK = 90; // 与 src/db.js 的 CHUNK 一致：D1 单语句 100 绑定参数上限

let wranglerCalls = 0;
// 临时 SQL 目录放在 worker-r2 下面：路径里没有空格。批量写回（UPDATE/DELETE）走 --file，
// 那是 mutation 不需要返回值；SELECT 走 --command（见 d1Query 里的说明）。
let tmpDir = '';

/** 跑一条 wrangler 命令，返回 stdout。失败直接抛（带 stderr） */
function wrangler(args, { quiet = false } = {}) {
  wranglerCalls++;
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd: WORKER_DIR,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} 失败（exit ${r.status}）：\n${(r.stderr || r.stdout || '').slice(-2000)}`);
  }
  if (!quiet) process.stdout.write(`  ✓ wrangler ${args[0]} ${args[1] || ''} (#${wranglerCalls})\n`);
  return r.stdout;
}

/** d1 查询：SELECT 必须走 --command —— wrangler 的 --file 是 import 管道，不返回查询结果。
 *  shell:true 下数组拼接会把含空格的 SQL 拆碎，所以这里传整条命令串、SQL 自己用双引号包好
 *  （SQL 全是脚本内的常量：哈希是十六进制、id 是数字，没有需要转义的输入）。 */
function d1Query(sql) {
  const target = D1_TARGET.join(' ');
  const cmd = `wrangler d1 execute ${DB} ${target} --json --command "${sql}" -y`.replace(/\s+/g, ' ');
  const r = spawnSync(cmd, {
    cwd: WORKER_DIR,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`d1 查询失败（exit ${r.status}）：\n${(r.stderr || r.stdout || '').slice(-2000)}`);
  }
  const out = r.stdout;
  // wrangler 有时在 JSON 前带日志行：从每个 '[' 处试解析，取第一个能过 JSON.parse 的
  for (let i = out.indexOf('['); i >= 0; i = out.indexOf('[', i + 1)) {
    try {
      const parsed = JSON.parse(out.slice(i));
      return parsed[0]?.results ?? [];
    } catch { /* 不是 JSON 起点，继续找 */ }
  }
  throw new Error('d1 输出里没找到 JSON：\n' + out.slice(-800));
}

/** 把一批语句写进临时 .sql 再执行 */
async function d1RunStatements(statements, tag) {
  if (!statements.length) return;
  const file = join(tmpDir, `${tag}-${Math.random().toString(36).slice(2)}.sql`);
  await writeFile(file, statements.join('\n'), 'utf8');
  wrangler(['d1', 'execute', DB, ...D1_TARGET, '--file', file, '-y']);
  await rm(file, { force: true });
}

/** 确保线上库有 sha256 列和唯一索引（和 schema.sql 保持一致，可重复执行） */
async function ensureSchema() {
  const col = d1Query(`SELECT name FROM pragma_table_info('images') WHERE name='sha256'`);
  if (!col.length) {
    console.log('缺 sha256 列，执行 ALTER TABLE …');
    await d1RunStatements(['ALTER TABLE images ADD COLUMN sha256 TEXT;'], 'alter');
  }
  await d1RunStatements(
    ['CREATE UNIQUE INDEX IF NOT EXISTS idx_images_sha256 ON images(sha256) WHERE sha256 IS NOT NULL;'],
    'index'
  );
}

/** 从公网直链流式下载并算 SHA-256（不整块进内存）。返回 hex 或 null（404 等） */
async function hashFromUrl(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { redirect: 'follow' });
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const hash = createHash('sha256');
      for await (const chunk of resp.body) hash.update(chunk);
      return hash.digest('hex');
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return null;
}

async function backfill(rows) {
  const todo = rows.filter((r) => !r.sha256);
  console.log(`\n── 回填指纹：${todo.length} 行待算（已算过 ${rows.length - todo.length} 行）──`);
  if (!todo.length) return;

  let done = 0;
  let cursor = 0;
  const failed = [];

  async function worker() {
    while (cursor < todo.length) {
      const row = todo[cursor++];
      const hex = await hashFromUrl(`${BASE}/${row.r2_key}`).catch((e) => {
        console.warn(`  ✗ #${row.id} ${row.r2_key}：${e.message}`);
        return null;
      });
      done++;
      if (hex) row._sha = hex; // 先记在内存里，落库放在下面的守卫写回
      else failed.push(row);
      if (done % 50 === 0 || done === todo.length) {
        process.stdout.write(`  进度 ${done}/${todo.length}（失败 ${failed.length}）\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));

  // 守卫写回：同内容的老重复行只有一方能拿到指纹（唯一索引不许两行同哈希），
  // 抢不到的留 NULL，先记在内存（_sha）里照常参与去重分组，等删除阶段清掉。
  // dry-run 时抢不到的行每次重跑都要重新下载计算 —— 它们本来就是要删的。
  let written = 0;
  for (let i = 0; i < todo.length; i += SQL_CHUNK) {
    const stmts = todo.slice(i, i + SQL_CHUNK)
      .filter((r) => r._sha)
      .map((r) => {
        const id = Number(r.id);
        return `UPDATE images SET sha256='${r._sha}' WHERE id=${id}` +
          ` AND NOT EXISTS (SELECT 1 FROM images WHERE sha256='${r._sha}' AND id<>${id});`;
      });
    if (stmts.length) {
      await d1RunStatements(stmts, `backfill-${i}`);
      written += stmts.length;
    }
  }
  // 谁真正拿到了指纹以数据库为准（并发写回后可能被别人占位），内存里对齐一次
  const finalSha = d1Query('SELECT id, sha256 FROM images WHERE sha256 IS NOT NULL');
  const shaById = new Map(finalSha.map((r) => [Number(r.id), r.sha256]));
  for (const r of rows) {
    r._final = shaById.get(Number(r.id)) || null; // 库里最终的指纹（可能为 NULL）
  }
  console.log(`  已写回 ${written} 行${failed.length ? `；${failed.length} 行没拉到对象（404/网络），已跳过` : ''}`);
  if (failed.length) {
    for (const r of failed) console.log(`    - #${r.id} ${r.r2_key}（${r.album || '根目录'}）`);
  }
}

/** 按内容分组找重复。指纹取「库里的，没有就用本轮算出来的」；保留最早一条 */
function findDuplicates(rows) {
  const bySha = new Map();
  for (const r of rows) {
    const sha = r._final || r._sha || '';
    if (!sha) continue;
    if (!bySha.has(sha)) bySha.set(sha, []);
    bySha.get(sha).push(r);
  }
  const groups = [];
  const victims = [];
  let freedBytes = 0;
  for (const list of bySha.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) =>
      String(a.uploaded_at || '').localeCompare(String(b.uploaded_at || '')) || (a.id - b.id)
    );
    const [keep, ...rest] = list;
    groups.push({ keep, rest });
    for (const v of rest) {
      victims.push(v);
      freedBytes += Number(v.size) || 0;
    }
  }
  return { groups, victims, freedBytes };
}

function printReport(groups, freedBytes) {
  console.log(`\n── 重复报告：${groups.length} 组同内容，可释放 ${fmtBytes(freedBytes)} ──`);
  for (const { keep, rest } of groups) {
    console.log(`  组 #${keep.id}（保留：${keep.album || '根目录'}/${keep.filename}，${fmtBytes(keep.size)}，传于 ${keep.uploaded_at}）`);
    for (const v of rest) {
      console.log(`    删 #${v.id}  ${v.album || '根目录'}/${v.filename}  ${fmtBytes(v.size)}  ${v.r2_key}`);
    }
  }
  if (!groups.length) console.log('  （没有重复，库很干净）');
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

/** --apply：删重复行 + 对应的 R2 对象（原图与缩略图） */
async function applyDeletions(victims) {
  if (!victims.length) return;
  console.log(`\n── 应用：删除 ${victims.length} 个重复项 ──`);

  // D1 行。先删行再删对象：万一中途断掉，残留的只是孤儿对象（可再跑一次清掉），
  // 反过来则会短暂出现「有记录没对象」的坏图。
  for (let i = 0; i < victims.length; i += SQL_CHUNK) {
    const ids = victims.slice(i, i + SQL_CHUNK).map((v) => Number(v.id));
    await d1RunStatements([`DELETE FROM images WHERE id IN (${ids.join(',')});`], `dedup-${i}`);
  }

  // R2 对象（原图 + 缩略图）。逐个删，慢一点但每个都确认到位。
  const objects = victims.flatMap((v) => (v.thumb_key ? [v.r2_key, v.thumb_key] : [v.r2_key]));
  let deleted = 0;
  for (const key of objects) {
    try {
      wrangler(['r2', 'object', 'delete', `picbed-images/${key}`, ...R2_TARGET, '-y'], { quiet: true });
      deleted++;
    } catch (e) {
      console.warn(`  ✗ 对象删除失败（不影响 D1，可重跑补删）：${key}\n    ${e.message.split('\n')[0]}`);
    }
  }
  console.log(`  已删 ${deleted}/${objects.length} 个对象`);
}

async function main() {
  console.log(`picbed 存量库处理（--apply ${APPLY ? '开：会真删' : '关：只看不删'}）`);
  tmpDir = await mkdtemp(join(WORKER_DIR, '.tmp-backfill-'));
  await ensureSchema();

  console.log('拉取全表 …');
  const rows = d1Query(
    'SELECT id, r2_key, filename, size, album, uploaded_at, thumb_key, sha256 FROM images ORDER BY id'
  );
  console.log(`共 ${rows.length} 行`);

  try {
    await backfill(rows);

    // 分组直接用内存里的完整指纹视图（库里的 + 本轮算出来的），不用再拉一遍表
    const { groups, victims, freedBytes } = findDuplicates(rows);
    printReport(groups, freedBytes);

    if (APPLY && victims.length) {
      await applyDeletions(victims);

      // 收尾填充：保留的可能是「落库时被同内容占位、指纹还是 NULL」的那行
      //（守卫只看先后，不看新旧）。重复行删掉后占位解除，把幸存行补齐。
      const fill = rows.filter((r) => r._sha && !r._final && !victims.includes(r));
      for (let i = 0; i < fill.length; i += SQL_CHUNK) {
        await d1RunStatements(
          fill.slice(i, i + SQL_CHUNK).map((r) => `UPDATE images SET sha256='${r._sha}' WHERE id=${Number(r.id)};`),
          `fill-${i}`
        );
      }
      if (fill.length) console.log(`  补写 ${fill.length} 行幸存指纹`);
      console.log('\n完成。');
    } else if (!APPLY && victims.length) {
      console.log('\n以上是 dry-run，没有删任何东西。确认无误后加 --apply 重跑：');
      console.log('  node scripts/backfill-dedup.mjs --apply');
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('\n失败：', e.message || e);
  process.exit(1);
});
