-- 给已经建好的线上库补 thumb_key 列。
--
-- 新库不用跑这个 —— 直接执行 schema.sql 就已经包含该列。
-- 已经建过表的库（比如已经部署上线的那套）执行：
--
--   cd worker-r2
--   npx wrangler d1 execute picbed-db --remote --file=migrations/001-add-thumb-key.sql -y
--
-- 本地库同理，把 --remote 换成 --local。
--
-- 反复执行会报「duplicate column name: thumb_key」，那是正常的，说明已经加过了。

ALTER TABLE images ADD COLUMN thumb_key TEXT;
