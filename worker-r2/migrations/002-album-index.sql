-- 给已经建好的线上库补相册索引。
--
-- 新库不用跑这个（schema.sql 已包含）。已经建过表的库执行：
--
--   cd worker-r2
--   npx wrangler d1 execute picbed-db --remote --file=migrations/002-album-index.sql -y
--
-- 反复执行是安全的（IF NOT EXISTS）。
--
-- 为什么需要它：按相册浏览的查询是 `WHERE album = ? ORDER BY uploaded_at DESC`，
-- 而 idx_images_public 的第一列是 is_hidden、idx_images_uploaded_at 是纯时间 ——
-- 两个都用不上，会退化成扫全表。D1 按「扫描行数」计费，这个索引能省下大量读取。

CREATE INDEX IF NOT EXISTS idx_images_album ON images (album, is_hidden, rating, uploaded_at DESC);
