/**
 * 接口实现 —— 上传 / 列表 / 隐藏 / 改分级 / 删除，以及公开的相册列表。
 *
 * 约定：
 *   * 管理接口一律返回 Cache-Control: no-store，且**不带 CORS 头**（同源的管理页才用得上，
 *     不给跨站读取的机会）。只有公开的相册接口带 Access-Control-Allow-Origin: *。
 *   * 上传用「裸 body + X-Filename 头」，不用 multipart —— request.formData() 会把整个文件
 *     读进内存（Worker 上限 128MB），裸 body 可以直接流式转写进 R2。
 */

import { RATINGS, allowedRatings, isListable } from './access.js';
import * as db from './db.js';

// ---------- 响应小工具 ----------

const CORS_PUBLIC = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  // 公开接口不需要密码，但客户端可能**顺手带上** x-picbed-key（比如同一套请求封装
  // 统一加头）。不在预检里放行它的话，浏览器会在发请求前就把整个请求拦掉，
  // 报「Request header field x-picbed-key is not allowed by Access-Control-Allow-Headers」。
  // 放行一个用不上的头没有安全影响，但能避免这类整页加载失败。
  'Access-Control-Allow-Headers': 'Content-Type, X-Picbed-Key',
  'Access-Control-Max-Age': '86400',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

export function jsonErr(status, message, extra = {}) {
  return json({ error: message }, status, extra);
}

/** 管理接口的响应（不带 CORS，不缓存） */
function jsonAdmin(data, status = 200) {
  return json(data, status, { 'Cache-Control': 'no-store' });
}

/**
 * 删除若干条记录对应的 R2 对象（原图 + 缩略图）。
 * R2 的 delete 一次最多 1000 个键，所以按 1000 分块。
 */
async function deleteObjects(env, rows) {
  const keys = [];
  for (const r of rows) {
    if (r.r2_key) keys.push(r.r2_key);
    if (r.thumb_key) keys.push(r.thumb_key); // 缩略图和原图一起清，别留孤儿
  }
  for (let i = 0; i < keys.length; i += 1000) {
    await env.BUCKET.delete(keys.slice(i, i + 1000));
  }
}

/**
 * 管理接口鉴权。
 * 未配置 PICBED_PASSWORD 时**一律拒绝**（fail closed）——不能让「忘了设密码」变成「谁都能传」。
 * @returns {Response|null} 返回 Response 表示鉴权失败，null 表示通过
 */
export function requireAuth(request, env) {
  if (!env.PICBED_PASSWORD) {
    return jsonErr(503, '服务端未设置 PICBED_PASSWORD，管理接口已停用（fail closed）');
  }
  if (request.headers.get('x-picbed-key') !== env.PICBED_PASSWORD) {
    return jsonErr(403, '密码错误');
  }
  return null;
}

// ---------- 键与路径 ----------

const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
};

function randHex(bytes) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 读一个可能含非 ASCII 的请求头。
 * HTTP 头只能放 Latin-1，所以前端传中文文件名/相册名时会先 URL 编码，这里解回来。
 */
function headerText(request, name) {
  const raw = request.headers.get(name);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // 没编码或编码坏了就用原样，不至于整个请求失败
  }
}

/**
 * 净化相册名。返回 null 表示含保留段（调用方应回 400）。
 *
 * ⚠️ 必须接受 UTF-8：现有相册名是中文（`旅行` 之类）。早期版本只保留 `[a-zA-Z0-9._-]`，
 * 结果会把中文相册名整段抹掉、静默变成根目录 —— 这类错误在界面上很难看出来。
 * 只挡真正危险的字符：路径分隔符、控制字符、以及文件系统保留字符。
 *
 * 相册名与 R2 键是解耦的：这里改的只是数据库里的一列，不影响任何图片的直链。
 */
export function safeAlbum(raw) {
  const segs = String(raw || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');

  // 保留段必须在「净化之前」判断：净化会削掉开头的下划线，
  // _picbed 会被悄悄变成 picbed，检查就永远命不中了。
  // 只剥开头的非字母数字（_ . - 空格），中文本身就是字母，不会被误剥。
  if (segs.some((s) => s.replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase() === 'picbed')) return null;

  return segs
    .map((s) =>
      s
        .replace(/[\\:*?"<>|\u0000-\u001f]/g, '_') // 危险字符
        .replace(/^[._]+|[._]+$/g, '') // 首尾的点和下划线（隐藏文件风格）
        .slice(0, 60)
    )
    .filter(Boolean)
    .join('/');
}

/**
 * 默认相册名：按 UTC 日期的 `YYYY/MM/DD`。
 * 与迁移脚本从旧键推导出来的相册名（`2026/10/03`）保持一致，
 * 这样新传的图和搬过来的老图在同一个相册体系里。
 */
export function dateAlbum() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
}

/**
 * 生成 R2 键：<PREFIX>/<日期>/<时分秒>_<8位随机>.<ext>
 *
 * 键是**不透明且不可变**的：相册名不参与其中（相册是数据库里的一列，随便改都不影响直链）。
 * 与旧站保持同样的前缀和日期目录形状，迁移过来的键不用改。
 */
function makeKey(env, filename, contentType) {
  const prefix = String(env.PREFIX || 'img').replace(/^\/+|\/+$/g, '') || 'img';

  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateDir = dateAlbum();
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

  const name = String(filename || '');
  let ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!/^[a-z0-9]{2,8}$/.test(ext)) ext = '';
  ext = ext || EXT_BY_TYPE[contentType] || 'bin';

  // 键里刻意不放原始文件名（与旧站一致）：省掉一整套 URL 编码/转义问题，
  // 也不会把用户的文件名暴露在 URL 上。原始名完整存在 D1 的 filename 列里，管理页照常显示。
  //
  // 随机部分用 4 字节（8 位十六进制）：直链是公开的，键别太好猜。
  return `${prefix}/${dateDir}/${time}_${randHex(4)}.${ext}`;
}

/** 缩略图扩展名跟着 Content-Type 走：浏览器的 toBlob 在不支持 WebP 时会静默退回 PNG */
const THUMB_EXT_BY_TYPE = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

/**
 * 缩略图的键：放在原图旁边，主干加 `.thumb.<ext>`。
 *   img/2026/10/03/164503_e72bf439.png → img/2026/10/03/164503_e72bf439.thumb.webp
 *
 * 放旁边是为了删除时一并清理，也让「有原图必有缩略图」在存储上看得见。
 * 注意扩展名由**原图键**和 Content-Type 决定，与 album 无关 ——
 * album 是可变的（还会是中文），键必须保持不可变。
 */
function thumbKeyOf(key, contentType) {
  const ext = THUMB_EXT_BY_TYPE[contentType] || 'webp';
  return key.replace(/\.[^./]+$/, '') + '.thumb.' + ext;
}

// ---------- 上传 ----------

class TooLargeError extends Error {}
class EmptyBodyError extends Error {}

/**
 * 把请求体写进 R2，并保证不超过 limit。返回实际写入的字节数。
 *
 * ⚠️ 不要写成 `env.BUCKET.put(key, request.body.pipeThrough(new TransformStream(...)))`：
 * R2 要求传入的流**长度已知**，而 TransformStream 的可读端长度未知，线上会直接报
 * 「Provided readable stream must have a known length (request/response body or readable
 * half of FixedLengthStream)」。本地模拟桶不检查这条，所以只有部署到线上才会暴露。
 *
 * 这里按「长度是否已知」分两条路：
 *   - 有 Content-Length（浏览器 XHR / curl 上传都属此类）→ 直接把 request.body 交给 R2，
 *     全程流式、不占内存；写完后用 R2 返回的 size 复核一次，超限就删掉。
 *   - 没有 Content-Length（chunked 等）→ 只能整体读进来再按真实长度判断。
 */
async function putObjectLimited(env, key, request, contentType, limit) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) throw new TooLargeError('declared too large');

  const httpMetadata = { contentType: contentType || 'application/octet-stream' };
  const cacheSeconds = Number(env.IMAGE_CACHE_SECONDS) || 0;
  if (cacheSeconds > 0) httpMetadata.cacheControl = `public, max-age=${cacheSeconds}`;

  if (declared > 0) {
    const obj = await env.BUCKET.put(key, request.body, { httpMetadata });
    const size = obj && obj.size != null ? obj.size : declared;
    // 兜底：声明与实际不符时（或流被截断），以 R2 记录的为准
    if (size > limit) {
      await env.BUCKET.delete(key).catch(() => {});
      throw new TooLargeError('actual too large');
    }
    if (!size) throw new EmptyBodyError('empty');
    return size;
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength > limit) throw new TooLargeError('actual too large');
  if (!buf.byteLength) throw new EmptyBodyError('empty');
  await env.BUCKET.put(key, buf, { httpMetadata });
  return buf.byteLength;
}

/** 把数据库行整理成给前端用的形状（补上完整直链与缩略图直链） */
export function shape(row, env) {
  const base = String(env.IMAGE_BASE || '').replace(/\/+$/, '');
  const abs = (k) => (base ? `${base}/${k}` : k);
  return {
    id: row.id,
    key: row.r2_key,
    url: abs(row.r2_key),
    // 缩略图是**独立的 R2 对象**，不是原图加查询参数 ——
    // R2 会忽略未知查询参数、拿原图回 200，那样「缩略图 404 就退回原图」的判断永远不触发。
    thumb_url: row.thumb_key ? abs(row.thumb_key) : null,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    is_hidden: Number(row.is_hidden) || 0,
    rating: row.rating,
    album: row.album,
    uploaded_at: row.uploaded_at,
    updated_at: row.updated_at || null,
  };
}

/**
 * POST /api/upload
 * 裸 body 上传；文件名放 X-Filename（非 ASCII 要 URL 编码），可选 X-Rating / X-Album。
 */
export async function handleUpload(request, env) {
  const limit = Number(env.MAX_UPLOAD_BYTES) || 50 * 1024 * 1024;
  const limitMb = Math.round(limit / 1024 / 1024);

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared && declared > limit) return jsonErr(413, `文件超过 ${limitMb}MB 上限`);
  if (!request.body) return jsonErr(400, '空请求体');

  // 文件名：只取最后一段，避免有人塞路径进来
  const filename = headerText(request, 'x-filename').split(/[\\/]/).pop().slice(0, 200) || 'image';

  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();

  // 分级和相册走 query 参数（`?rating=&album=`），请求头写法仍然兼容。用 query 的两个原因：
  //   1. HTTP 头只能放 Latin-1，中文相册名得先 URL 编码再由服务端解回来，绕；
  //   2. 头里区分不出「没传」和「传了空值」，而 album= 空串正是「传到根目录」这个有效意图。
  const q = new URL(request.url).searchParams;

  let rating = String(q.get('rating') || request.headers.get('x-rating') || env.UPLOAD_DEFAULT_RATING || 'unspecified').trim();
  if (!RATINGS.includes(rating)) rating = 'unspecified';

  // 相册只写数据库列，不进键：键保持不透明不可变，之后随便改相册都不会动直链。
  // 完全不指定时才按日期归档（YYYY/MM/DD），与迁移过来的老图保持同一套相册命名。
  const albumRaw = q.has('album') ? q.get('album') : headerText(request, 'x-album') || null;
  const album = albumRaw === null ? dateAlbum() : safeAlbum(albumRaw);
  if (album === null) return jsonErr(400, '_picbed 是保留目录名，不能用作相册');

  const key = makeKey(env, filename, contentType);

  let size;
  try {
    size = await putObjectLimited(env, key, request, contentType, limit);
  } catch (e) {
    if (e instanceof TooLargeError) return jsonErr(413, `文件超过 ${limitMb}MB 上限`);
    if (e instanceof EmptyBodyError) return jsonErr(400, '空文件');
    return jsonErr(502, '写入 R2 失败：' + (e && e.message ? e.message : e));
  }

  const row = {
    r2_key: key,
    filename,
    mime: contentType || null,
    size,
    is_hidden: 0,
    rating,
    album,
    uploaded_at: db.nowIso(),
  };

  let id;
  try {
    id = await db.insertImage(env, row);
  } catch (e) {
    // 元数据没写成就把对象删掉，不留孤儿
    await env.BUCKET.delete(key).catch(() => {});
    return jsonErr(500, '元数据写入失败：' + (e && e.message ? e.message : e));
  }

  return jsonAdmin({ image: shape({ id, ...row }, env) }, 201);
}

// ---------- 管理：列表 / 修改 / 删除 ----------

function intParam(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/** GET /api/images —— 管理列表，看得见全部（含隐藏与 unspecified） */
export async function handleAdminList(url, env) {
  const page = intParam(url.searchParams.get('page'), 1, 1, 100000);
  const pageSize = intParam(url.searchParams.get('pageSize'), 50, 1, 200);
  const rating = url.searchParams.get('rating') || '';
  const hiddenRaw = url.searchParams.get('hidden');
  const hidden = hiddenRaw === '0' ? 0 : hiddenRaw === '1' ? 1 : undefined;
  const q = (url.searchParams.get('q') || '').trim();
  const album = url.searchParams.get('album') || '';

  if (rating && !RATINGS.includes(rating)) return jsonErr(400, `rating 只能是 ${RATINGS.join(' / ')}`);

  const thumb = url.searchParams.get('thumb') || ''; // 'missing' = 只列还没有缩略图的（批量补全用）
  // 带 album= 参数（哪怕是空串）就按它精确筛选：空串 = 只列根目录下的图。
  // 完全不传 album 才是「不筛相册」——否则根目录视图会把整库图片都列出来。
  const albumFilter = url.searchParams.has('album') ? url.searchParams.get('album') || '' : undefined;

  const { total, rows } = await db.listImages(env, {
    page, pageSize, rating, hidden, q, album: albumFilter, thumbMissing: thumb === 'missing',
  });

  // 子相册只在第一页返回：前端只在 reset（切目录）时渲染文件夹，翻页时不追加。
  // 一次查询就够，别按页重复算。
  const folders = page === 1 ? childFolders(await db.listAlbumCounts(env, album), album) : [];

  return jsonAdmin({ total, page, pageSize, album, folders, images: rows.map((r) => shape(r, env)) });
}

/** GET /api/albums —— 相册名列表（管理页的筛选候选，单独一个接口避免每次列表都 GROUP BY 扫全表） */
export async function handleAlbums(env) {
  const rows = await db.listAlbums(env);
  return jsonAdmin({ albums: rows });
}

/** 读一次请求体并解析成 JSON（请求体只能读一次，所以统一在这里读） */
async function readJson(request) {
  try {
    return { body: await request.json() };
  } catch {
    return { error: '请求体不是合法 JSON' };
  }
}

/** 从**已解析**的请求体里取白名单字段；不认识的一律忽略 */
function readPatch(body) {
  if (!body || typeof body !== 'object') return { error: '请求体必须是 JSON 对象' };

  const patch = {};
  if ('is_hidden' in body) {
    const v = body.is_hidden;
    if (v === true || v === 1 || v === '1') patch.is_hidden = 1;
    else if (v === false || v === 0 || v === '0') patch.is_hidden = 0;
    else return { error: 'is_hidden 只能是 0 或 1' };
  }
  if ('rating' in body) {
    if (!RATINGS.includes(body.rating)) return { error: `rating 只能是 ${RATINGS.join(' / ')}` };
    patch.rating = body.rating;
  }
  if ('album' in body) {
    // 移动图片/相册就是改这一列；传空串表示移到根目录
    const a = safeAlbum(body.album);
    if (a === null) return { error: '_picbed 是保留目录名，不能用作相册' };
    patch.album = a;
  }
  return { patch };
}

/** 把一系列 album 值折叠成「当前层级的直接子相册」（含子树图片数） */
function childFolders(rows, album) {
  const prefix = album ? album + '/' : '';
  const map = new Map();
  for (const r of rows) {
    const a = r.album || '';
    if (!a) continue;
    const rest = prefix ? (a === album ? '' : a.startsWith(prefix) ? a.slice(prefix.length) : '') : a;
    if (!rest) continue; // 正好是当前相册本身，不是子相册
    const child = prefix + rest.split('/')[0];
    map.set(child, (map.get(child) || 0) + (r.n || 0));
  }
  return [...map]
    .map(([name, n]) => ({ album: name, n }))
    .sort((a, b) => a.album.localeCompare(b.album, 'zh'));
}

/** PATCH /api/images/:id —— 改隐藏状态和/或分级（两个维度独立，可只改一个） */
export async function handleUpdate(request, env, id) {
  const { body, error: jsonError } = await readJson(request);
  if (jsonError) return jsonErr(400, jsonError);

  const { patch, error } = readPatch(body);
  if (error) return jsonErr(400, error);
  if (!Object.keys(patch).length) return jsonErr(400, '没有要修改的字段（只接受 is_hidden / rating）');

  const changed = await db.updateImages(env, [id], patch);
  if (!changed) return jsonErr(404, '没有这条记录');

  const row = await db.getImageById(env, id);
  return jsonAdmin({ image: shape(row, env) });
}

/** POST /api/images/bulk —— 批量：{ ids, is_hidden?, rating? } 或 { ids, delete: true } */
export async function handleBulk(request, env) {
  const { body, error: jsonError } = await readJson(request);
  if (jsonError) return jsonErr(400, jsonError);

  const ids = Array.isArray(body && body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return jsonErr(400, 'ids 不能为空');
  if (ids.length > 500) return jsonErr(400, '一次最多处理 500 条');

  if (body.delete) {
    const rows = await db.getImagesByIds(env, ids);
    if (rows.length) {
      await deleteObjects(env, rows);
      await db.deleteImages(env, rows.map((r) => r.id));
    }
    return jsonAdmin({ deleted: rows.length });
  }

  const { patch, error } = readPatch(body);
  if (error) return jsonErr(400, error);
  if (!Object.keys(patch).length) return jsonErr(400, '没有要修改的字段（只接受 is_hidden / rating）');

  const changed = await db.updateImages(env, ids, patch);
  return jsonAdmin({ updated: changed });
}

/** DELETE /api/images/:id —— 同时删 R2 对象（原图 + 缩略图）与数据库记录 */
export async function handleDelete(env, id) {
  const row = await db.getImageById(env, id);
  if (!row) return jsonErr(404, '没有这条记录');
  await deleteObjects(env, [row]);
  await db.deleteImages(env, [row.id]);
  return jsonAdmin({ deleted: 1, key: row.r2_key });
}

/**
 * PUT /api/images/:id/thumb —— 上传浏览器生成的缩略图。
 * 缩略图键由服务端从原图键推导（同目录 `<主干>.thumb.webp`），前端不用关心命名。
 * 这条接口失败不影响原图：thumb_key 保持 NULL，前端会退回加载原图。
 */
export async function handleThumbUpload(request, env, id) {
  const row = await db.getImageById(env, id);
  if (!row) return jsonErr(404, '没有这条记录');

  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'image/webp';
  if (!contentType.startsWith('image/')) return jsonErr(400, '缩略图必须是图片');
  const limit = Number(env.THUMB_MAX_BYTES) || 2 * 1024 * 1024;
  if (!request.body) return jsonErr(400, '空请求体');

  const key = thumbKeyOf(row.r2_key, contentType);
  try {
    await putObjectLimited(env, key, request, contentType, limit);
  } catch (e) {
    if (e instanceof TooLargeError) return jsonErr(413, `缩略图超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
    if (e instanceof EmptyBodyError) return jsonErr(400, '空缩略图');
    return jsonErr(502, '写入缩略图失败：' + (e && e.message ? e.message : e));
  }

  await db.setThumbKey(env, id, key);
  const fresh = await db.getImageById(env, id);
  return jsonAdmin({ image: shape(fresh, env) });
}

// ---------- 相册（整体操作，都是改一列，不动 R2 对象） ----------

/** POST /api/albums/rename { from, to } —— 重命名/移动整个相册（含子相册） */
export async function handleAlbumRename(request, env) {
  const { body, error } = await readJson(request);
  if (error) return jsonErr(400, error);

  const from = safeAlbum(body && body.from);
  const to = safeAlbum(body && body.to);
  if (from === null || to === null) return jsonErr(400, '_picbed 是保留目录名，不能用作相册');
  if (!from) return jsonErr(400, '不能重命名根目录');
  if (to === undefined) return jsonErr(400, '缺少目标相册名');
  // 不能把相册移进它自己或它的子相册，否则子树会自我嵌套
  if (to === from || to.startsWith(from + '/')) return jsonErr(400, '不能移动到自身或其子相册下');

  const changed = await db.renameAlbum(env, from, to);
  return jsonAdmin({ changed, from, to });
}

/** GET /api/albums/stats?album=<名> —— 删之前的统计，供确认框显示「将删除 N 张图」 */
export async function handleAlbumStats(url, env) {
  const album = url.searchParams.get('album') || '';
  if (!album) return jsonErr(400, '缺少相册名');

  const rows = await db.albumRows(env, album);
  const folders = childFolders(await db.listAlbumCounts(env, album), album).length;
  return jsonAdmin({
    album,
    images: rows.length,
    folders,
    bytes: rows.reduce((s, r) => s + (r.size || 0), 0),
  });
}

/** DELETE /api/albums?album=<名> —— 删除整个相册子树（数据库记录 + R2 对象） */
export async function handleAlbumDelete(url, env) {
  const album = safeAlbum(url.searchParams.get('album'));
  if (album === null) return jsonErr(400, '非法的相册名');
  if (!album) return jsonErr(400, '不能删除根目录');

  const rows = await db.albumRows(env, album);
  await deleteObjects(env, rows);
  const changed = await db.deleteAlbumRows(env, album);
  return jsonAdmin({ deleted: changed, album });
}

// ---------- 远程转存 ----------

const TYPE_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};

function nameFromUrl(u) {
  try {
    return decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

/**
 * POST /api/transfer { url } —— 抓取远程图片转存到 R2。
 * 逻辑沿用旧 Worker 的 /url（抓取 → 校验类型与大小 → 写 R2 → 写 D1）。
 */
export async function handleTransfer(request, env) {
  const { body, error } = await readJson(request);
  if (error) return jsonErr(400, error);

  const src = body && body.url;
  if (!src || !/^https?:\/\//i.test(src)) return jsonErr(400, '请提供合法的 http(s) 图片地址');

  const limit = Number(env.MAX_UPLOAD_BYTES) || 50 * 1024 * 1024;
  let resp;
  try {
    resp = await fetch(src, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PicBed/1.0)' },
    });
  } catch (e) {
    return jsonErr(502, '抓取失败：' + (e && e.name === 'TimeoutError' ? '请求超时' : e && e.message));
  }
  if (!resp.ok) return jsonErr(502, `抓取失败：目标返回 HTTP ${resp.status}`);

  const declared = Number(resp.headers.get('content-length') || 0);
  if (declared > limit) return jsonErr(413, '远程图片超过大小上限');

  let contentType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const filename = nameFromUrl(src) || 'image';
  if (!contentType.startsWith('image/')) {
    contentType = TYPE_BY_EXT[(filename.split('.').pop() || '').toLowerCase()] || '';
    if (!contentType) return jsonErr(400, '目标不是图片（无法识别 Content-Type）');
  }

  const buf = await resp.arrayBuffer();
  if (!buf.byteLength) return jsonErr(400, '空文件');
  if (buf.byteLength > limit) return jsonErr(413, '远程图片超过大小上限');

  const key = makeKey(env, filename, contentType);
  const cacheSeconds = Number(env.IMAGE_CACHE_SECONDS) || 0;
  const httpMetadata = { contentType };
  if (cacheSeconds > 0) httpMetadata.cacheControl = `public, max-age=${cacheSeconds}`;
  await env.BUCKET.put(key, buf, { httpMetadata });

  let rating = String(body.rating || env.UPLOAD_DEFAULT_RATING || 'unspecified').trim();
  if (!RATINGS.includes(rating)) rating = 'unspecified';
  const album = body.album ? safeAlbum(body.album) : dateAlbum();
  if (album === null) return jsonErr(400, '_picbed 是保留目录名，不能用作相册');

  const row = {
    r2_key: key,
    filename,
    mime: contentType,
    size: buf.byteLength,
    is_hidden: 0,
    rating,
    album,
    uploaded_at: db.nowIso(),
  };
  try {
    const id = await db.insertImage(env, row);
    return jsonAdmin({ image: shape({ id, ...row }, env) }, 201);
  } catch (e) {
    await env.BUCKET.delete(key).catch(() => {});
    return jsonErr(500, '元数据写入失败：' + (e && e.message ? e.message : e));
  }
}

// ---------- 公开：相册列表 ----------

/**
 * GET /api/public/images?album=&rating=&page=&pageSize=
 *
 * 只返回「可陈列」的图（见 access.js）。默认只列 G，靠 ?rating= 参数放宽：
 *   ?rating=r15 → G + R12 + R15     ?rating=r15_only → 仅 R15
 *
 * 缓存由 LIST_CACHE_SECONDS 控制，默认 0 = 不缓存（永远最新）。
 * 大于 0 时用 Cache API 显式存（Worker 生成的响应不会被 Cloudflare 自动缓存，必须显式存），
 * 代价是最长这么久才更新——按需在 wrangler.toml 里调。
 */
export async function handlePublicList(request, url, env, ctx) {
  const cacheSeconds = Number(env.LIST_CACHE_SECONDS) || 0;
  const bypass = url.searchParams.get('refresh') === '1';
  const useCache = cacheSeconds > 0 && !bypass && request.method === 'GET';

  let cacheKey = null;
  if (useCache) {
    cacheKey = new Request(url.toString(), { method: 'GET' });
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  }

  const { allowed, label } = allowedRatings(url.searchParams.get('rating'), env);
  const page = intParam(url.searchParams.get('page'), 1, 1, 100000);
  const pageSize = intParam(url.searchParams.get('pageSize'), 60, 1, 100);
  // 与 /api/images 同一套语义：带 album=（哪怕空串）就精确筛该相册，不传才是不筛
  const albumFilter = url.searchParams.has('album') ? url.searchParams.get('album') || '' : undefined;
  const album = albumFilter || '';

  const { total, rows } = await db.listPublicImages(env, { page, pageSize, album: albumFilter, allowed });
  // 子相册同样只在第一页给；用可陈列过滤，避免让访客看出隐藏相册的存在
  const folders = page === 1 ? childFolders(await db.listPublicAlbumCounts(env, album, allowed), album) : [];

  // 双保险：SQL 已经按同一套规则筛过，这里再按 isListable 复核一遍。
  // 两处规则同源（都来自 access.js），但只要将来有人改了一处，这道复核能保证
  // 「列表里出现的图」一定满足 isListable —— 相册不会漏出不该陈列的图。
  const images = rows.filter((r) => isListable(r, allowed)).map((r) => shape(r, env));

  const body = JSON.stringify({ total, page, pageSize, rating: label, album, folders, images });

  if (useCache) {
    const res = new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`,
        ...CORS_PUBLIC,
      },
    });
    ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
    return res;
  }

  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_PUBLIC,
    },
  });
}

export { CORS_PUBLIC };
