/**
 * 相册可见性判定 —— 全站唯一的「这张图该不该出现在相册里」的判断处。
 *
 * ⚠️ 定位（很重要，别搞混）：
 *   is_hidden 和 rating 只影响**相册列表的陈列**，不影响图片直链。
 *   图片字节由 R2 自定义域名直接对外（img.ohtoai.top，不经过 Worker），
 *   所以任何状态的图——隐藏的、R18 的、未分类的——拿到直链都能打开。
 *   这与迁移前 COS 公有读的行为一致：相册是「陈列」，不是「门禁」。
 *
 * 为什么要单独一个文件：
 *   过滤规则只写在这里，接口层（api.js）和查询层（db.js）都调它，不各写一份。
 *   以后要加「登录后可见 R18」「年龄验证」「某些分级对某些人生效」，
 *   只改这个文件即可，键结构和 R2 布局都不用动。
 */

/** 允许的分级取值（与 schema.sql 里的 CHECK 约束保持一致） */
export const RATINGS = ['G', 'R12', 'R15', 'R18', 'unspecified'];

/** 分级 → 年龄门槛。unspecified 不在表里：它永不陈列，不参与比较 */
const AGE_OF = { G: 0, R12: 12, R15: 15, R18: 18 };

/** 累进档位的写法：?rating=r15 表示「G + R12 + R15」 */
const LEVELS = ['g', 'r12', 'r15', 'r18'];

/** 累进：某档位包含哪些分级 */
function cumulative(level) {
  const max = AGE_OF[level.toUpperCase()];
  return new Set(RATINGS.filter((r) => r !== 'unspecified' && AGE_OF[r] <= max));
}

/** 解析单个写法，认不出来就返回 null（交给调用方回落） */
function parseOne(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  // xxx_only：只陈列这一档，不累进
  if (s.endsWith('_only')) {
    const upper = s.slice(0, -'_only'.length).toUpperCase();
    return RATINGS.includes(upper) && upper !== 'unspecified' ? new Set([upper]) : null;
  }
  if (LEVELS.includes(s)) return cumulative(s);
  return null;
}

/**
 * 把 ?rating= 参数解析成「允许陈列的分级集合」。
 *
 *   （缺省）                     → 取 env.DEFAULT_ALBUM_RATING（默认 g）
 *   rating=g / r12 / r15 / r18   → 累进：r15 = G + R12 + R15
 *   rating=r15_only              → 仅 R15（g_only / r12_only / r18_only 同理）
 *   非法值                       → 回落到默认档，不报错
 *                                  （链接被改坏时相册不至于打不开，静默降级更友好）
 *
 * @returns {{ allowed: Set<string>, label: string }} label 用于在响应里回显实际生效的档位
 */
export function allowedRatings(param, env) {
  const fallback = (env && env.DEFAULT_ALBUM_RATING) || 'g';
  const given = String(param || '').trim().toLowerCase();

  const parsed = parseOne(given);
  if (parsed) return { allowed: parsed, label: given };

  const fb = parseOne(fallback);
  if (fb) return { allowed: fb, label: String(fallback).trim().toLowerCase() };

  return { allowed: cumulative('g'), label: 'g' };
}

/**
 * 相册里是否陈列这张图。
 *
 * 两个维度独立判断，任一命中就不陈列：
 *   is_hidden = 1        → 管理员主动隐藏，任何档位都不陈列
 *   rating = unspecified → 未分类，任何档位都不陈列（连 r18 也看不到它）
 *
 * @param {object} image   images 表的一行（或至少含 is_hidden / rating 的对象）
 * @param {Set<string>} allowed   allowedRatings() 的产物
 */
export function isListable(image, allowed) {
  if (!image) return false;
  if (Number(image.is_hidden) === 1) return false;
  if (image.rating === 'unspecified') return false;
  return allowed.has(image.rating);
}

/**
 * 给 SQL 用的粗筛条件，和 isListable 是同一套规则（一个在库里筛，一个在内存里复核）。
 * 用参数化占位符，绝不把值拼进 SQL 字符串。
 *
 * @returns {{ where: string, params: string[] }}
 */
export function listableSql(allowed) {
  const ratings = [...allowed];
  // 防御：集合为空时构造一个永假条件，避免生成 "IN ()" 这种语法错误
  if (!ratings.length) return { where: '1 = 0', params: [] };
  return {
    where: `is_hidden = 0 AND rating IN (${ratings.map(() => '?').join(', ')})`,
    params: ratings,
  };
}

/**
 * 参数速查（写进文档用）：
 *
 *   （无）      → G（由 DEFAULT_ALBUM_RATING 决定）
 *   g / g_only  → G
 *   r12         → G, R12
 *   r15         → G, R12, R15
 *   r18         → G, R12, R15, R18
 *   r15_only    → 仅 R15
 *   unspecified → 永不陈列（任何参数都看不到）
 *
 * ─────────────────────────────────────────────────────────────
 * 扩展位：以后想给直链也加门禁，或者加「登录 / 年龄验证」时
 *
 *   1) 在这里加一个函数，例如：
 *
 *        export function canViewBytes(image, viewer, env) {
 *          if (viewer.isAdmin) return true;
 *          if (Number(image.is_hidden) === 1) return false;
 *          if (image.rating === 'unspecified') return false;
 *          if (viewer.minAge != null && AGE_OF[image.rating] > viewer.minAge) return false;
 *          return true;
 *        }
 *
 *   2) 让 Worker 重新挡在 R2 前面：把 img.ohtoai.top 从 R2 桶的自定义域名上摘掉，
 *      改成这个 Worker 的自定义域名，然后在 index.js 的 serveFromR2 里先查 D1、
 *      调 canViewBytes、再代取 R2。键结构和数据库都不用动。
 *
 *   3) 配套的 viewer 解析（从 Cookie / Header / Cloudflare Access 里取）也放这里，
 *      保持「规则只在这一个文件里」的约定。
 * ─────────────────────────────────────────────────────────────
 */
