/**
 * Worker 入口与路由。
 *
 * 这个 Worker 负责：
 *   /admin               管理页（HTML 由 Text 模块打进 Worker，不需要额外部署静态站）
 *   /api/upload          上传（密码）
 *   /api/images          管理列表（密码）
 *   /api/images/:id      改隐藏 / 改分级 / 删除（密码）
 *   /api/images/bulk     批量（密码）
 *   /api/albums          相册名列表（密码）
 *   /api/public/images   相册列表（公开，带 CORS）
 *   /i/<key>             直接读 R2 —— 本地开发用；生产直链走 R2 自定义域名，不经过这里
 *
 * ⚠️ 图片直链不走 Worker：img.ohtoai.top 是 R2 桶的自定义域名。
 *    所以隐藏 / 分级只影响相册列表的陈列，不拦直链（详见 src/access.js）。
 */

import ADMIN_HTML from './admin.html';
import {
  CORS_PUBLIC,
  json,
  jsonErr,
  requireAuth,
  handleUpload,
  handleAdminList,
  handleAlbums,
  handleUpdate,
  handleBulk,
  handleDelete,
  handleThumbUpload,
  handleAlbumRename,
  handleAlbumDelete,
  handleAlbumStats,
  handleTransfer,
  handlePublicList,
} from './api.js';

/**
 * 跨域头：只放行 ALLOWED_ORIGINS 里列出的来源。
 *
 * 前端在 GitHub Pages 上、Worker 在另一个域名，属于跨域；但管理接口默认**不发光 CORS 头**
 * （不给任何站点跨站读取的机会）。只有白名单里的来源才拿到头。
 * 刻意不带 Access-Control-Allow-Credentials —— 不用 Cookie，密码靠 x-picbed-key 显式携带。
 */
function corsFor(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Picbed-Key, X-Filename, X-Rating, X-Album',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** 给一个已经生成的响应补上跨域头（白名单外原样返回） */
function withCors(request, env, res) {
  const cors = corsFor(request, env);
  if (!cors || !res) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

/**
 * 直接读 R2 返回图片字节。
 *
 * 生产环境用不到这条路由（直链由 R2 自定义域名直出）。它有两个用处：
 *   1. 本地 `wrangler dev`：本地 R2 没有公网地址，靠它验证上传结果
 *   2. 以后想给直链加门禁时的落点：在这里查一次 D1、调 access.js 里的扩展函数，
 *      再决定要不要代取 R2（键结构与数据库都不用动）
 */
async function serveFromR2(request, env, rawKey) {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    /* 解不开就用原样 */
  }
  // 只挡真正的「路径段是 . 或 ..」——不能简单用 key.includes('..')，
  // 那会误伤相册名里合法带连续点号的键（如 img/v1..2/xxx.jpg）。
  // 顺带说明：URL 解析器本来就会把 . / .. / %2e%2e 规范化掉，所以实际很难走到这里，
  // 这段是纵深防御，防的是「以后改了路由」的情况。
  if (!key || key.startsWith('/') || key.split('/').some((s) => s === '.' || s === '..')) {
    return jsonErr(400, '非法键');
  }

  const obj = await env.BUCKET.get(key, {
    range: request.headers, // 直接把 Range 头交给 R2（下载器 / 断点续传用得上）
    onlyIf: request.headers, // If-None-Match / If-Modified-Since 也交给 R2，命中就回 304
  });
  // 图片是公开的（任何人拿到直链都能看），所以这里直接放开跨域。
  // 不加这几行的话，前端用 fetch 流式读图会被 CORS 拦下 —— 本地开发时尤其明显，
  // 因为本地只能让 IMAGE_BASE 指向 Worker 自己。
  const ACAO = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Range, Accept-Ranges',
  };

  if (!obj) return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store', ...ACAO } });

  // 条件请求命中（内容没变）时 R2 返回的对象没有 body，回 304
  if (!obj.body) {
    return new Response(null, { status: 304, headers: { ETag: obj.httpEtag, ...ACAO } });
  }

  const headers = new Headers(ACAO);
  obj.writeHttpMetadata(headers); // 还原上传时写的 content-type / cache-control
  headers.set('ETag', obj.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  // 上传的图片里可能有 SVG，而 SVG 直接打开是会执行脚本的。
  // 这两行让它在浏览器里「只当图片看」，不给脚本执行的机会。
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");

  let status = 200;
  let length = obj.size;
  if (obj.range) {
    const r = obj.range;
    const start = r.offset != null ? r.offset : r.suffix != null ? Math.max(0, obj.size - r.suffix) : 0;
    length = r.length != null ? r.length : obj.size - start;
    headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${obj.size}`);
    status = 206;
  }
  headers.set('Content-Length', String(length));

  return new Response(obj.body, { status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      if (method === 'OPTIONS') {
        // 公开接口对所有人开放；其余接口只回白名单来源的预检，别的来源拿不到头，浏览器自然拦下
        const headers = pathname.startsWith('/api/public/') ? CORS_PUBLIC : corsFor(request, env) || {};
        return new Response(null, { status: 204, headers });
      }

      // ---- 管理页 ----
      if (pathname === '/admin' || pathname === '/admin/') {
        return new Response(ADMIN_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      // ---- 图片直链兜底（本地开发用）----
      if (pathname.startsWith('/i/')) {
        return await serveFromR2(request, env, pathname.slice(3));
      }

      // ---- 公开接口 ----
      if (pathname === '/api/public/images') {
        if (method !== 'GET') return jsonErr(405, '只支持 GET');
        return await handlePublicList(request, url, env, ctx);
      }

      // ---- 以下都要密码 ----
      if (pathname.startsWith('/api/')) {
        const denied = requireAuth(request, env);
        if (denied) return withCors(request, env, denied);

        const one = /^\/api\/images\/(\d+)$/.exec(pathname);
        const thumb = /^\/api\/images\/(\d+)\/thumb$/.exec(pathname);

        let res;
        if (thumb) {
          res = method === 'PUT' ? await handleThumbUpload(request, env, Number(thumb[1])) : jsonErr(405, '只支持 PUT');
        } else if (one) {
          const id = Number(one[1]);
          if (method === 'PATCH') res = await handleUpdate(request, env, id);
          else if (method === 'DELETE') res = await handleDelete(env, id);
          else res = jsonErr(405, '只支持 PATCH / DELETE');
        } else if (pathname === '/api/upload' && method === 'POST') {
          res = await handleUpload(request, env);
        } else if (pathname === '/api/transfer' && method === 'POST') {
          res = await handleTransfer(request, env);
        } else if (pathname === '/api/images' && method === 'GET') {
          res = await handleAdminList(url, env);
        } else if (pathname === '/api/images/bulk' && method === 'POST') {
          res = await handleBulk(request, env);
        } else if (pathname === '/api/albums' && method === 'GET') {
          res = await handleAlbums(env);
        } else if (pathname === '/api/albums' && method === 'DELETE') {
          res = await handleAlbumDelete(url, env);
        } else if (pathname === '/api/albums/stats' && method === 'GET') {
          res = await handleAlbumStats(url, env);
        } else if (pathname === '/api/albums/rename' && method === 'POST') {
          res = await handleAlbumRename(request, env);
        } else {
          res = jsonErr(404, 'Not Found');
        }

        return withCors(request, env, res);
      }

      // ---- 图片直链兜底（本地开发用）----
      // 生产环境走不到这里：img.ohtoai.top 是 R2 桶的自定义域名，图片请求根本到不了 Worker。
      // 但本地开发时 IMAGE_BASE 只能指向 Worker 自己，于是接口返回的 URL 是裸键路径
      // （http://127.0.0.1:8787/img/...），这里兜一下，让本地也能正常看图。
      if (pathname.length > 1 && !pathname.startsWith('/api/') && !pathname.startsWith('/admin')) {
        const res = await serveFromR2(request, env, pathname.slice(1));
        if (res.status !== 400) return res; // 400 = 键非法，继续往下走正常的 404
      }

      // ---- 根路径：给个自检信息，省得访问到一片空白 ----
      if (pathname === '/') {
        return json({
          ok: true,
          name: 'picbed-r2',
          imageBase: env.IMAGE_BASE || '',
          endpoints: [
            'GET  /admin',
            'POST /api/upload',
            'GET  /api/images',
            'GET  /api/albums',
            'PATCH|DELETE /api/images/:id',
            'POST /api/images/bulk',
            'GET  /api/public/images?rating=&album=&page=',
          ],
        });
      }

      return jsonErr(404, 'Not Found');
    } catch (e) {
      return jsonErr(500, (e && e.message) || 'Internal Error');
    }
  },
};
