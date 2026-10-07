/**
 * D1 读写封装 —— 所有 SQL 都集中在这里，接口层不直接写 SQL。
 *
 * 约定：
 *   * 字段白名单：只允许改 is_hidden / rating / album / filename（见 updateImages），
 *     字段名不来自用户输入，不拼字符串。
 *   * 值一律用 bind() 参数化。
 *   * D1 单条语句最多 100 个绑定参数，所以 id 列表按 90 一组分块（见 CHUNK）。
 *   * uploaded_at / updated_at 统一存 ISO8601 UTC 文本，排序和 JS 解析都省事。
 */

import { listableSql } from './access.js';

/** 查询用到的列（顺序固定，方便复用） */
const COLS = 'id, r2_key, filename, mime, size, is_hidden, rating, album, thumb_key, uploaded_at, updated_at';

/** id 列表分块大小：D1 单语句上限 100 个绑定参数，留点余量给其它占位符 */
const CHUNK = 90;

/**
 * 「某相册本身 + 它的整棵子树」的匹配条件，配合 .bind(album, album, album) 使用。
 *
 * ⚠️ 刻意不用 `album = ? OR album LIKE ? || '/%'`：
 *   1. `_` 和 `%` 是 LIKE 的通配符，而它们在相册名里完全合法
 *      —— 重命名 `a_b` 会连 `axb/...` 一起改掉；
 *   2. SQLite 的 LIKE 对 ASCII 不区分大小写 —— 重命名 `travel` 会误伤 `Travel/...`；
 *   3. 这两种错误都是静默的，改完才发现一堆不该动的相册被改了。
 * 用 substr 做逐字节的前缀匹配，语义和「路径前缀」完全一致。
 */
// 注意用普通 `?` 而不是 `?1` 编号形式：编号参数在本地 SQLite 实现里不被支持，
// 而普通占位符在哪儿都能用 —— 代价是调用方要把相册名绑定三次。
const SUBTREE = `(album = ? OR substr(album, 1, length(?) + 1) = ? || '/')`;

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 转义 LIKE 里的通配符，避免用户搜 "100%" 时变成通配查询 */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

// ---------- 写 ----------

/**
 * 插入一条图片记录。
 * @returns {Promise<number>} 新行的 id（用官方给的 meta.last_row_id，不用 RETURNING）
 */
export async function insertImage(env, img) {
  const res = await env.DB.prepare(
    `INSERT INTO images (r2_key, filename, mime, size, is_hidden, rating, album, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(img.r2_key, img.filename, img.mime, img.size, img.is_hidden, img.rating, img.album, img.uploaded_at)
    .run();
  return res.meta.last_row_id;
}

/**
 * 批量改 is_hidden / rating（单张改也走这里，传一个 id 的数组即可）。
 * @param {number[]} ids
 * @param {{is_hidden?: number, rating?: string}} patch
 * @returns {Promise<number>} 受影响的行数
 */
export async function updateImages(env, ids, patch) {
  const sets = [];
  const vals = [];

  if (patch.is_hidden === 0 || patch.is_hidden === 1) {
    sets.push('is_hidden = ?');
    vals.push(patch.is_hidden);
  }
  if (typeof patch.rating === 'string') {
    sets.push('rating = ?');
    vals.push(patch.rating);
  }
  if (typeof patch.album === 'string') {
    // 相册只是数据库里的一列：改它不产生新的直链，R2 里的对象一个都不动
    sets.push('album = ?');
    vals.push(patch.album);
  }
  if (typeof patch.filename === 'string') {
    // 同上：只是展示名，键与 URL 都不动
    sets.push('filename = ?');
    vals.push(patch.filename);
  }
  if (!sets.length || !ids.length) return 0;

  sets.push('updated_at = ?');
  vals.push(nowIso());

  let changed = 0;
  for (const part of chunked(ids, CHUNK)) {
    const res = await env.DB.prepare(
      `UPDATE images SET ${sets.join(', ')} WHERE id IN (${part.map(() => '?').join(', ')})`
    )
      .bind(...vals, ...part)
      .run();
    changed += res.meta.changes || 0;
  }
  return changed;
}

/** 按 id 删除数据库记录（R2 对象的删除由调用方负责） */
export async function deleteImages(env, ids) {
  let changed = 0;
  for (const part of chunked(ids, CHUNK)) {
    const res = await env.DB.prepare(
      `DELETE FROM images WHERE id IN (${part.map(() => '?').join(', ')})`
    )
      .bind(...part)
      .run();
    changed += res.meta.changes || 0;
  }
  return changed;
}

// ---------- 读 ----------

export async function getImageById(env, id) {
  return await env.DB.prepare(`SELECT ${COLS} FROM images WHERE id = ?`).bind(id).first();
}

/** 按 id 批量取（删除前要先拿到 r2_key） */
export async function getImagesByIds(env, ids) {
  const out = [];
  for (const part of chunked(ids, CHUNK)) {
    const res = await env.DB.prepare(
      `SELECT ${COLS} FROM images WHERE id IN (${part.map(() => '?').join(', ')})`
    )
      .bind(...part)
      .all();
    out.push(...(res.results || []));
  }
  return out;
}

/**
 * 管理列表：能看到全部图片（含隐藏与 unspecified）。
 * @param {{page:number,pageSize:number,rating?:string,hidden?:number,q?:string,album?:string}} opts
 */
export async function listImages(env, opts) {
  const { page, pageSize, rating, hidden, q, album, thumbMissing } = opts;
  const where = [];
  const params = [];

  if (thumbMissing) {
    // 批量补缩略图用：只挑还没有缩略图的。
    // 排除 SVG/ICO —— 它们永远生成不出缩略图（canvas 处理不了），
    // 不排掉的话补全工具会一直把它们捞出来，永远跑不完。
    where.push("thumb_key IS NULL AND mime NOT IN ('image/svg+xml', 'image/x-icon')");
  }
  if (rating) {
    where.push('rating = ?');
    params.push(rating);
  }
  if (hidden === 0 || hidden === 1) {
    where.push('is_hidden = ?');
    params.push(hidden);
  }
  if (album !== undefined) {
    // 传空串表示「只要根目录的图」，和「不筛相册」（undefined）是两回事
    where.push('album = ?');
    params.push(album);
  }
  if (q) {
    where.push(`filename LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(q)}%`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;

  // 一次往返拿「总数 + 当前页」两件事，比发两条请求省一半延迟
  const [countRes, rowsRes] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM images ${clause}`).bind(...params),
    env.DB
      .prepare(`SELECT ${COLS} FROM images ${clause} ORDER BY uploaded_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...params, pageSize, offset),
  ]);

  return {
    total: (countRes.results && countRes.results[0] && countRes.results[0].n) || 0,
    rows: (rowsRes.results || []),
  };
}

/**
 * 相册列表：只含「可陈列」的图。规则来自 access.js，这里只是把它翻成 SQL。
 * @param {{page:number,pageSize:number,album?:string,allowed:Set<string>}} opts
 */
export async function listPublicImages(env, opts) {
  const { page, pageSize, album, allowed } = opts;
  const listable = listableSql(allowed);
  const where = [listable.where];
  const params = [...listable.params];

  if (album !== undefined) {
    where.push('album = ?');
    params.push(album);
  }

  const clause = `WHERE ${where.join(' AND ')}`;
  const offset = (page - 1) * pageSize;

  const [countRes, rowsRes] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM images ${clause}`).bind(...params),
    env.DB
      .prepare(`SELECT ${COLS} FROM images ${clause} ORDER BY uploaded_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...params, pageSize, offset),
  ]);

  return {
    total: (countRes.results && countRes.results[0] && countRes.results[0].n) || 0,
    rows: (rowsRes.results || []),
  };
}

/** 相册名列表（管理页的筛选下拉和自动补全树用） */
export async function listAlbums(env) {
  const res = await env.DB.prepare(
    `SELECT album, COUNT(*) AS n FROM images GROUP BY album ORDER BY album`
  ).all();
  return res.results || [];
}

/** 记录某张图的缩略图键 */
export async function setThumbKey(env, id, thumbKey) {
  await env.DB.prepare('UPDATE images SET thumb_key = ?, updated_at = ? WHERE id = ?')
    .bind(thumbKey, nowIso(), id)
    .run();
}

// ---------- 相册（都是「改一列」，不动 R2 对象） ----------

/** 某相册及其子相册下每个 album 值的图片数（前端据此推导子相册与计数） */
export async function listAlbumCounts(env, album) {
  const sql = album
    ? `SELECT album, COUNT(*) AS n FROM images WHERE ${SUBTREE} GROUP BY album`
    : `SELECT album, COUNT(*) AS n FROM images GROUP BY album`;
  const stmt = album ? env.DB.prepare(sql).bind(album, album, album) : env.DB.prepare(sql);
  const res = await stmt.all();
  return res.results || [];
}

/** 同上，但只统计「可陈列」的图（公开侧用，避免泄漏隐藏相册的存在） */
export async function listPublicAlbumCounts(env, album, allowed) {
  const listable = listableSql(allowed);
  const where = [listable.where];
  const params = [...listable.params];

  if (album) {
    where.push(SUBTREE);
    params.push(album, album, album); // 三条 ? 各自绑定，不复用编号（见 SUBTREE 上的说明）
  }
  const res = await env.DB.prepare(
    `SELECT album, COUNT(*) AS n FROM images WHERE ${where.join(' AND ')} GROUP BY album`
  )
    .bind(...params)
    .all();
  return res.results || [];
}

/**
 * 重命名 / 移动相册：整棵子树一次性改列。
 * 子相册跟着走（`旅行` → `风景` 时 `旅行/2024` → `风景/2024`）。
 * @returns {Promise<number>} 受影响行数
 */
export async function renameAlbum(env, from, to) {
  if (!from || from === to) return 0;
  // 占位符按出现顺序：SET 里的 (新名, 旧名, 时间)，然后 WHERE 里的旧名三次。
  // `substr(album, length(?) + 1)` 保留子树里的相对部分（旅行/2024 → 风景/2024）。
  const res = await env.DB.prepare(
    `UPDATE images
        SET album = ? || substr(album, length(?) + 1),
            updated_at = ?
      WHERE (album = ? OR substr(album, 1, length(?) + 1) = ? || '/')`
  )
    .bind(to, from, nowIso(), from, from, from)
    .run();
  return res.meta.changes || 0;
}

/** 取某相册子树下的全部记录（删除前要先拿到所有 R2 键） */
export async function albumRows(env, album) {
  const res = await env.DB.prepare(`SELECT ${COLS} FROM images WHERE ${SUBTREE}`)
    .bind(album, album, album)
    .all();
  return res.results || [];
}

/** 删掉某相册子树下的所有记录（R2 对象的清理由调用方负责） */
export async function deleteAlbumRows(env, album) {
  const res = await env.DB.prepare(`DELETE FROM images WHERE ${SUBTREE}`)
    .bind(album, album, album)
    .run();
  return res.meta.changes || 0;
}
