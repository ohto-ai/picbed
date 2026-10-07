-- OhtoAi 图床 · D1 建表
--
-- 本地：npx wrangler d1 execute picbed-db --local  --file=schema.sql
-- 线上：npx wrangler d1 execute picbed-db --remote --file=schema.sql
--
-- 设计要点：
--   * 图片字节存在 R2，这里只存元数据；表里没有「内容」字段。
--   * is_hidden 与 rating 是两个**独立**维度，都只影响相册列表的陈列：
--       - is_hidden = 1  → 不进任何相册（管理员主动隐藏）
--       - rating = 'unspecified' → 不进任何相册（还没决定分级）
--       两者可以同时成立，判断时取并集（任一命中就不陈列）。
--     ⚠️ 它们**不拦图片直链**：图片由 R2 自定义域名直接对外，任何状态的图拿到
--     直链都能打开。这是刻意的设计（与迁移前 COS 公有读一致），详见 src/access.js。

CREATE TABLE IF NOT EXISTS images (
  id          INTEGER PRIMARY KEY,            -- 主键（SQLite 里 INTEGER PRIMARY KEY 自增，无需 AUTOINCREMENT）
  r2_key      TEXT    NOT NULL UNIQUE,        -- R2 中的完整键，如 img/2026/10/03/120000_ab12cd.jpg
  filename    TEXT    NOT NULL,               -- 原始文件名（仅展示用，键里带的是净化后的名字）
  mime        TEXT,                           -- 上传时写进 R2 对象的 httpMetadata，直链的 Content-Type
  size        INTEGER,                        -- 字节数
  is_hidden   INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
  rating      TEXT    NOT NULL DEFAULT 'unspecified'
              CHECK (rating IN ('G', 'R12', 'R15', 'R18', 'unspecified')),
  album       TEXT    NOT NULL DEFAULT '',    -- 逻辑相册名（'旅行' / '2026/10/03'，'' = 根）
                                              -- 注意：不是 r2_key 的目录部分 —— 键是不可变的不透明路径，
                                              -- 相册可以随时改，两者刻意解耦（移动/改名不产生新的直链）
  thumb_key   TEXT,                           -- 缩略图在 R2 里的键；NULL = 没有缩略图，前端退回原图
  uploaded_at TEXT    NOT NULL,               -- ISO8601 UTC，如 2026-10-03T12:00:00Z
  updated_at  TEXT                            -- 最后一次改 is_hidden / rating / album / filename / thumb_key 的时间
);

-- 相册接口的热路径：
--   SELECT ... FROM images WHERE is_hidden = 0 AND rating IN (…) ORDER BY uploaded_at DESC
-- 必须有这个索引：D1 是按「扫描的行数」计费的（不是返回的行数），没有它一次列表就全表扫，
-- 5000 张图就是 5000 行额度，一天一千次浏览就能把 500 万行/天的免费额度吃满。
CREATE INDEX IF NOT EXISTS idx_images_public ON images (is_hidden, rating, uploaded_at DESC);

-- 按相册浏览用：进一个相册就是 WHERE album = ? ORDER BY uploaded_at DESC，
-- 上面那个索引的第一列是 is_hidden，帮不上忙，会退化成扫全表。
CREATE INDEX IF NOT EXISTS idx_images_album ON images (album, is_hidden, rating, uploaded_at DESC);

-- 管理列表用：恒定按 uploaded_at DESC, id DESC 排序。
-- id 也要进索引：批量上传的图 uploaded_at 常常同秒，光靠时间排序不稳定（翻页会重复/漏图），
-- 而带上 id 当第二排序键后，索引能直接提供排序，不用再建临时 B 树把整个索引读一遍。
CREATE INDEX IF NOT EXISTS idx_images_uploaded_at ON images (uploaded_at DESC, id DESC);
