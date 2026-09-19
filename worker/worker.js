/**
 * PicBed Worker — 为图床签发 COS 临时密钥（STS）+ 远程图片转存
 *
 * 部署：cd worker && wrangler deploy
 * 密钥通过 `wrangler secret put` 配置，绝不写进代码：
 *   TENCENT_SECRET_ID / TENCENT_SECRET_KEY（必填）
 *   PICBED_PASSWORD（可选，设置后所有接口需要请求头 x-picbed-key 匹配）
 *
 * 接口：
 *   POST/GET /token  返回受限的 COS 临时密钥（仅能操作 PREFIX 目录，30 分钟有效）
 *   POST /url        body { url }，抓取远程图片并转存到 COS（10MB 上限）
 */

const MAX_BYTES = 10 * 1024 * 1024; // 转存单图上限 10MB
const STS_HOST = 'sts.tencentcloudapi.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Picbed-Key',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function jsonErr(status, message) {
  return json({ error: message }, status);
}

function checkPassword(request, env) {
  if (!env.PICBED_PASSWORD) return true;
  return request.headers.get('x-picbed-key') === env.PICBED_PASSWORD;
}

// ---------- 加密工具 ----------
const encoder = new TextEncoder();

function bytes(data) {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, data, algo = 'SHA-256') {
  const k = await crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: algo }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, bytes(data)));
}

async function digestHex(algo, data) {
  return bufToHex(await crypto.subtle.digest(algo, bytes(data)));
}

// 腾讯云 COS 的 URL 编码：仅保留 RFC3986 非保留字符
function camSafeUrlEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// ---------- 腾讯云 API（TC3-HMAC-SHA256 签名） ----------
async function tc3Request(secretId, secretKey, action, version, payload, region) {
  const now = Math.floor(Date.now() / 1000);
  const date = new Date(now * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);

  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${STS_HOST}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${await digestHex('SHA-256', body)}`;
  const stringToSign = `TC3-HMAC-SHA256\n${now}\n${date}/sts/tc3_request\n${await digestHex('SHA-256', canonicalRequest)}`;

  const kDate = await hmac('TC3' + secretKey, date);
  const kService = await hmac(kDate, 'sts');
  const kSigning = await hmac(kService, 'tc3_request');
  const signature = bufToHex(await hmac(kSigning, stringToSign));
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${date}/sts/tc3_request, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(`https://${STS_HOST}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(now),
      'X-TC-Region': region,
      'X-TC-RequestClient': 'picbed-worker',
      'Authorization': authorization,
    },
    body,
  });
  const data = await resp.json();
  if (!resp.ok || data.Response?.Error) {
    throw new Error(data.Response?.Error?.Message || `STS 请求失败 HTTP ${resp.status}`);
  }
  return data.Response;
}

// 临时密钥策略：PREFIX 目录的对象操作 + 列出目录（GetBucket，供相册使用）
// resource 格式注意：桶级操作也需要以 /* 结尾
function buildPolicy(env) {
  const bucketResource = `qcs::cos:${env.REGION}:uid/${env.APPID}:${env.BUCKET}/*`;
  const prefixResource = `qcs::cos:${env.REGION}:uid/${env.APPID}:${env.BUCKET}/${env.PREFIX}/*`;
  return {
    version: '2.0',
    statement: [
      {
        effect: 'allow',
        action: [
          'name/cos:PutObject',
          'name/cos:PostObject',
          'name/cos:HeadObject',
          'name/cos:DeleteObject',
          'name/cos:InitiateMultipartUpload',
          'name/cos:UploadPart',
          'name/cos:CompleteMultipartUpload',
          'name/cos:AbortMultipartUpload',
          'name/cos:ListParts',
        ],
        resource: [prefixResource],
      },
      {
        effect: 'allow',
        action: ['name/cos:GetBucket', 'name/cos:ListMultipartUploads'],
        resource: [bucketResource],
      },
    ],
  };
}

async function getToken(env) {
  const resp = await tc3Request(
    env.TENCENT_SECRET_ID,
    env.TENCENT_SECRET_KEY,
    'GetFederationToken',
    '2018-08-13',
    { Name: 'picbed-web', Policy: JSON.stringify(buildPolicy(env)), DurationSeconds: 1800 },
    env.REGION || 'ap-shanghai'
  );
  return {
    credentials: {
      tmpSecretId: resp.Credentials.TmpSecretId,
      tmpSecretKey: resp.Credentials.TmpSecretKey,
      sessionToken: resp.Credentials.Token,
    },
    expiredTime: resp.ExpiredTime,
  };
}

// ---------- COS XML API（q-sign 签名） ----------
async function cosPut(env, key, body, contentType) {
  const host = `${env.BUCKET}.cos.${env.REGION}.myqcloud.com`;
  const uri = '/' + key.split('/').map(camSafeUrlEncode).join('/');
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now - 60};${now + 600}`;
  const contentLength = String(body.byteLength);
  const httpHeaders = `content-length=${contentLength}&content-type=${camSafeUrlEncode(contentType)}&host=${host}`;
  const httpString = `put\n${uri}\n\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${await digestHex('SHA-1', httpString)}\n`;
  const signKey = await hmac(env.TENCENT_SECRET_KEY, keyTime, 'SHA-1');
  const signature = bufToHex(await hmac(signKey, stringToSign, 'SHA-1'));
  const authorization = `q-sign-algorithm=sha1&q-ak=${env.TENCENT_SECRET_ID}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=content-length;content-type;host&q-url-param-list=&q-signature=${signature}`;

  const resp = await fetch(`https://${host}${uri}`, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-Length': contentLength,
      'Authorization': authorization,
    },
    body,
  });
  if (!resp.ok) throw new Error(`COS 上传失败 HTTP ${resp.status}`);
}

// ---------- 列出目录（Worker 用长期密钥调用 COS ListObjects） ----------
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function cosList(env, marker) {
  const host = `${env.BUCKET}.cos.${env.REGION}.myqcloud.com`;
  const params = [['prefix', env.PREFIX + '/'], ['max-keys', '500']];
  if (marker) params.push(['marker', String(marker)]);
  const sorted = params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const queryString = sorted.map(([k, v]) => `${camSafeUrlEncode(k)}=${camSafeUrlEncode(v)}`).join('&');
  const paramList = sorted.map(([k]) => k).join(';');

  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now - 60};${now + 600}`;
  const httpHeaders = `host=${host}`;
  const httpString = `get\n/\n${queryString}\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${await digestHex('SHA-1', httpString)}\n`;
  const signKey = await hmac(env.TENCENT_SECRET_KEY, keyTime, 'SHA-1');
  const signature = bufToHex(await hmac(signKey, stringToSign, 'SHA-1'));
  const authorization = `q-sign-algorithm=sha1&q-ak=${env.TENCENT_SECRET_ID}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=host&q-url-param-list=${paramList}&q-signature=${signature}`;

  const resp = await fetch(`https://${host}/?${queryString}`, { headers: { Authorization: authorization } });
  const xml = await resp.text();
  if (!resp.ok) {
    const grab = (re) => {
      const m = re.exec(xml);
      return m ? unescapeXml(m[1]) : '';
    };
    const code = grab(/<Code>([\s\S]*?)<\/Code>/) || '';
    const msg = grab(/<Message>([\s\S]*?)<\/Message>/) || '';
    const expected = grab(/<StringToSign>([\s\S]*?)<\/StringToSign>/) || '';
    const format = grab(/<FormatString>([\s\S]*?)<\/FormatString>/) || '';
    const parts = [`COS 列表失败 HTTP ${resp.status} (${code}: ${msg})`];
    if (format) parts.push(`COS期望FormatString=${JSON.stringify(format)}`);
    if (expected) parts.push(`COS期望StringToSign=${JSON.stringify(expected)}`);
    parts.push(`我方HttpString=${JSON.stringify(httpString)}`);
    parts.push(`我方StringToSign=${JSON.stringify(stringToSign)}`);
    parts.push(`COS原始XML=${JSON.stringify(xml.slice(0, 800))}`);
    throw new Error(parts.join(' || '));
  }
  const truncated = /<IsTruncated>([\s\S]*?)<\/IsTruncated>/.exec(xml)?.[1] === 'true';
  const nextMarker = unescapeXml(/<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml)?.[1] || '');
  const items = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(xml))) {
    const key = unescapeXml(/<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1] || '');
    const size = Number(/<Size>([\s\S]*?)<\/Size>/.exec(m[1])?.[1] || 0);
    const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(m[1])?.[1] || '';
    if (key) items.push({ key, size, lastModified });
  }
  return { items, truncated, nextMarker };
}

// ---------- 权限探针（临时调试用） ----------
// 用长期密钥换临时密钥，实测 GetBucket / HeadObject 是否生效：
//   listGetBucket: 200=有列表权限 403=无
//   headObjectOnPrefix: 404=有对象权限（对象不存在） 403=无
async function cosSigned(env, cred, method, uri, params) {
  const host = `${env.BUCKET}.cos.${env.REGION}.myqcloud.com`;
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now - 60};${now + 600}`;
  const sortedKeys = Object.keys(params).sort();
  const queryString = sortedKeys.map((k) => `${camSafeUrlEncode(k)}=${camSafeUrlEncode(params[k])}`).join('&');
  const paramList = sortedKeys.join(';');
  const headerObj = { host, 'x-cos-security-token': cred.sessionToken };
  const headerKeys = Object.keys(headerObj).sort();
  const httpHeaders = headerKeys
    .map((k) => `${camSafeUrlEncode(k).toLowerCase()}=${camSafeUrlEncode(String(headerObj[k]))}`)
    .join('&');
  const headerList = headerKeys.join(';');
  const httpString = `${method.toLowerCase()}\n${uri}\n${queryString}\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${await digestHex('SHA-1', httpString)}\n`;
  const signKey = await hmac(cred.tmpSecretKey, keyTime, 'SHA-1');
  const signature = bufToHex(await hmac(signKey, stringToSign, 'SHA-1'));
  const authorization = `q-sign-algorithm=sha1&q-ak=${cred.tmpSecretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=${paramList}&q-signature=${signature}`;
  const reqHeaders = {};
  for (const k of headerKeys) reqHeaders[k] = String(headerObj[k]);
  reqHeaders.Authorization = authorization;
  const resp = await fetch(`https://${host}${uri}${queryString ? '?' + queryString : ''}`, {
    method: method.toUpperCase(),
    headers: reqHeaders,
  });
  return { status: resp.status, body: (await resp.text()).slice(0, 200) };
}

async function probePermissions(env) {
  const bucketRes = `qcs::cos:${env.REGION}:uid/${env.APPID}:${env.BUCKET}/*`;
  const prefixRes = `qcs::cos:${env.REGION}:uid/${env.APPID}:${env.BUCKET}/${env.PREFIX}/*`;
  const probePolicy = {
    version: '2.0',
    statement: [
      { effect: 'allow', action: ['name/cos:GetBucket'], resource: [bucketRes] },
      { effect: 'allow', action: ['name/cos:HeadObject'], resource: [prefixRes] },
    ],
  };
  const tok = await tc3Request(
    env.TENCENT_SECRET_ID,
    env.TENCENT_SECRET_KEY,
    'GetFederationToken',
    '2018-08-13',
    { Name: 'picbed-probe', Policy: JSON.stringify(probePolicy), DurationSeconds: 900 },
    env.REGION || 'ap-shanghai'
  );
  const cred = {
    tmpSecretId: tok.Credentials.TmpSecretId,
    tmpSecretKey: tok.Credentials.TmpSecretKey,
    sessionToken: tok.Credentials.Token,
  };
  const list = await cosSigned(env, cred, 'GET', '/', { prefix: env.PREFIX + '/', 'max-keys': '1' });
  const head = await cosSigned(env, cred, 'HEAD', `/${env.PREFIX}/__probe_nonexist__.txt`, {});
  let longKeyList = 'ok';
  try {
    await cosList(env, '');
  } catch (e) {
    longKeyList = e.message.slice(0, 600);
  }
  // Workers 加密原语自检：固定输入的标准结果见 Node 对照
  const cryptoSelfTest = {
    sha1: await digestHex('SHA-1', 'picbed-test-data'),
    hmacSha1: bufToHex(await hmac('picbed-test-key', 'picbed-test-data', 'SHA-1')),
    hmacSha256: bufToHex(await hmac('picbed-test-key', 'picbed-test-data', 'SHA-256')),
  };
  return json({
    token: 'ok',
    cryptoSelfTest,
    listGetBucket: { status: list.status, body: list.body },
    headObjectOnPrefix: { status: head.status, body: head.body },
    longKeyListError: longKeyList,
  });
}

// ---------- 远程图片转存 ----------
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

function nameFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    return decodeURIComponent(p.split('/').pop() || '');
  } catch (e) {
    return '';
  }
}

function makeKey(env, sourceUrl, contentType) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePath = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const name = nameFromUrl(sourceUrl || '');
  let ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!/^[a-z0-9]{2,8}$/.test(ext)) ext = '';
  ext = ext || EXT_BY_TYPE[contentType] || 'bin';
  const base =
    name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'image';
  const rand = bufToHex(crypto.getRandomValues(new Uint8Array(3)));
  return `${env.PREFIX}/${datePath}/${time}_${rand}.${ext}`;
}

function publicUrl(env, key) {
  return `https://${env.BUCKET}.cos.${env.REGION}.myqcloud.com/${key}`;
}

async function handleUrl(request, env) {
  const { url } = await request.json().catch(() => ({}));
  if (!url || !/^https?:\/\//i.test(url)) return jsonErr(400, '请提供合法的 http(s) 图片地址');

  let resp;
  try {
    resp = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PicBedWorker/1.0)' },
    });
  } catch (e) {
    return jsonErr(502, '抓取失败：' + (e.name === 'TimeoutError' ? '请求超时' : e.message));
  }
  if (!resp.ok) return jsonErr(502, `抓取失败：目标返回 HTTP ${resp.status}`);

  const declared = parseInt(resp.headers.get('content-length') || '0', 10);
  if (declared > MAX_BYTES) return jsonErr(413, '图片超过 10MB 限制');

  let ct = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ct.startsWith('image/')) {
    ct = TYPE_BY_EXT[nameFromUrl(url).split('.').pop()?.toLowerCase()] || '';
    if (!ct) return jsonErr(400, '目标不是图片（无法识别 Content-Type）');
  }

  const buf = await resp.arrayBuffer();
  if (buf.byteLength === 0) return jsonErr(400, '空文件');
  if (buf.byteLength > MAX_BYTES) return jsonErr(413, '图片超过 10MB 限制');

  const key = makeKey(env, url, ct);
  await cosPut(env, key, buf, ct);
  return json({ url: publicUrl(env, key), key, size: buf.byteLength });
}

// ---------- 路由 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (url.pathname === '/token' && (request.method === 'POST' || request.method === 'GET')) {
        if (!checkPassword(request, env)) return jsonErr(403, '密码错误');
        return json(await getToken(env));
      }
      if (url.pathname === '/url' && request.method === 'POST') {
        if (!checkPassword(request, env)) return jsonErr(403, '密码错误');
        return await handleUrl(request, env);
      }
      if (url.pathname === '/list' && request.method === 'GET') {
        if (!checkPassword(request, env)) return jsonErr(403, '密码错误');
        try {
          const marker = url.searchParams.get('marker') || '';
          return json(await cosList(env, marker));
        } catch (e) {
          return jsonErr(502, e.message);
        }
      }
      // 临时调试：实测 Worker 密钥的 COS 有效权限（需密码）
      if (url.pathname === '/probe' && request.method === 'GET') {
        if (!checkPassword(request, env)) return jsonErr(403, '密码错误');
        try {
          return await probePermissions(env);
        } catch (e) {
          return jsonErr(502, e.message);
        }
      }
      return jsonErr(404, 'Not Found');
    } catch (e) {
      return jsonErr(500, e.message || 'Internal Error');
    }
  },
};
