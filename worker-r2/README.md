# 图床后端（Cloudflare R2 + D1 + Workers）

这是图床的新后端，与仓库里的旧 `worker/`（签腾讯云 COS 临时密钥那套）**互不影响**，可以并行部署。
旧站和 `index.html` 现在照常跑在 COS 上，等前端迁移完成后再把域名切过来。

## 这套东西长什么样

```
       浏览器 / PicGo / curl
              │ 上传（极少数）
              ▼
     ┌──────────────────────┐        ┌──────────────┐
     │  Worker  picbed-r2    │──────▶ │  D1  images   │  元数据：隐藏、分级、相册…
     │  /admin  /api/*       │        └──────────────┘
     └──────────────────────┘
              │ 写
              ▼
     ┌──────────────────────┐
     │   R2  picbed-images   │◀──── 图片直链（绝大多数请求）
     └──────────────────────┘        img.ohtoai.top，走 Cloudflare 边缘缓存，
              ▲                      完全不经 Worker、不计 Worker 请求数
              │
     访客看图（直链永远可打开）
```

三句话概括：

1. **图片字节走 R2 自定义域名直出**，不经过 Worker。所以看图既不计 Worker 请求数、也不计 R2 读（缓存命中时），R2 出网流量本身免费。
2. **D1 只存元数据**，负责管理页的列表、筛选，以及相册接口的陈列范围。
3. **`is_hidden` 和 `rating` 只影响「相册里列不列」，不拦直链**——任何状态的图，拿到直链都能打开。
   这与迁移前 COS 公有读的行为一致（旧 README 里那句「『公开』是浏览性开关，不是加密」说的是同一件事）。
   想给直链也加门禁的话，见 `src/access.js` 末尾的扩展位说明。

## 快速开始（本地，不花钱也不联网）

```bash
cd worker-r2
npx wrangler d1 execute picbed-db --local --file=schema.sql   # 建本地库
npx wrangler dev                                              # http://localhost:8787
```

打开 <http://localhost:8787/admin>，密码随便填（本地没设 `PICBED_PASSWORD` 时管理接口会回 503，见下方「鉴权」）。
要本地也能进管理页，在 `worker-r2/` 下建一个 `.dev.vars`（已被 .gitignore 忽略）：

```
PICBED_PASSWORD="dev"
```

本地 R2 没有公网地址，所以**本地预览缩略图会自动回落到 Worker 的 `/i/<key>` 路由**（管理页里有这段兜底）。

## 部署步骤

```bash
cd worker-r2
npx wrangler login

# 1) 建库，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create picbed-db
npx wrangler d1 execute picbed-db --remote --file=schema.sql

# 2) 建桶（--location apac 让存储离国内近一些；建完不能改，想清楚再定）
npx wrangler r2 bucket create picbed-images --location apac

# 3) 配桶的 CORS（前端要 fetch 流式读图时需要；同域 <img> 不需要）
npx wrangler r2 bucket cors set picbed-images --file=r2-cors.json
npx wrangler r2 bucket cors list picbed-images     # 核对

# 4) 设管理密码（不设的话管理接口一律 503，这是故意的 fail closed）
npx wrangler secret put PICBED_PASSWORD

# 5) 部署
npx wrangler deploy
```

部署完得到 `https://picbed-r2.<你的子域>.workers.dev`，管理页在 `/admin`。

### 还要在控制台做两件事（wrangler 建不了）

1. **给 R2 桶绑自定义域名**：R2 → `picbed-images` → Settings → Custom Domains → 添加 `img.ohtoai.top`。
   - 该主机名在 Cloudflare DNS 里**不能已有记录**，有的话先删掉
   - 证书由 Cloudflare 自动签发和续期 —— 这一条替代了旧站那整套 acme + 上传证书绑定的 GitHub Action
   - 必须用自定义域名：`r2.dev` 那个测试域名**限流且不支持缓存**，只适合开发
2. **别开 `r2.dev`**：R2 → Settings → Public Access，保持关闭。

可选加固：给 `img.ohtoai.top` 加一条 Cache Rule（Cache Everything，Edge TTL 按需），让所有文件类型都稳定命中缓存，也让「改缓存时长」不必重新上传对象。

### 切换 `picbed-worker.ohtoai.top` 的时机

`wrangler.toml` 末尾有一段**注释掉的** `[[routes]]`。现在不要打开——这个域名还被旧的 COS Worker 占着，
打开会让旧站的上传 / 相册 / 公开画廊当场全部失效。等前端迁移完成、准备切换时再取消注释并重新 `deploy`。

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `https://img.ohtoai.top/<key>` | 无 | 图片直链。**任何状态都能打开**（不经 Worker） |
| GET | `/api/public/images?album=&rating=&page=&pageSize=` | 公开 | 相册列表，只含可陈列的图。带 CORS |
| POST | `/api/upload?album=&rating=` | 密码 | 上传。裸 body，文件名放 `X-Filename`（非 ASCII 要 URL 编码）。相册与分级走 **query 参数**：中文相册名在 URL 里天然安全，而且空串能表达「传到根目录」 |
| PUT | `/api/images/:id/thumb` | 密码 | 上传浏览器生成的缩略图（body 是图片字节，Content-Type 决定扩展名）。键由服务端推导 |
| GET | `/api/images?page=&pageSize=&rating=&hidden=&q=&album=&thumb=` | 密码 | 管理列表，含隐藏与 unspecified。`thumb=missing` 只列还没有缩略图的（批量补全用）。**带 `album=`（哪怕空串）就精确筛该相册，不传才是不筛** |
| PATCH | `/api/images/:id` | 密码 | body `{is_hidden?, rating?, album?}` |
| POST | `/api/images/bulk` | 密码 | body `{ids, is_hidden?, rating?, album?}` 或 `{ids, delete:true}`，单次最多 500 条 |
| DELETE | `/api/images/:id` | 密码 | 同时删 R2 对象（原图 + 缩略图）与 D1 记录 |
| GET | `/api/albums` | 密码 | 相册名列表（管理页筛选用） |
| GET | `/api/albums/stats?album=` | 密码 | 删除前的统计：图片数 / 子相册数 / 字节数 |
| DELETE | `/api/albums?album=` | 密码 | 删除整个相册子树（记录 + R2 对象） |
| POST | `/api/albums/rename` | 密码 | body `{from, to}`，重命名/移动整个相册（含子相册），一条 UPDATE |
| POST | `/api/transfer` | 密码 | body `{url}`，抓远程图片转存进 R2（50MB 上限、15 秒超时） |
| GET | `/admin` | 页面内输密码 | 管理页 |
| GET | `/i/<key>` | 无 | **本地开发用**：本地 R2 没有公网地址，靠它验证上传结果 |

上传示例：

```bash
curl -X POST https://picbed-r2.xxx.workers.dev/api/upload \
  -H "x-picbed-key: 你的密码" \
  -H "x-filename: $(printf '风景 01.jpg' | jq -sRr @uri)" \
  -H "content-type: image/jpeg" \
  -H "x-rating: G" \
  --data-binary @风景01.jpg
```

**鉴权**：管理接口用共享密码（请求头 `x-picbed-key`，对应 `wrangler secret` 里的 `PICBED_PASSWORD`）。
没设密码时管理接口一律 **503**，不会放行。公开的相册接口不需要密码。

**CORS**：只有公开的相册接口带 `Access-Control-Allow-Origin: *`；管理接口不带 CORS 头（同源的管理页才用得上，
不给跨站读取的机会）。以后前端挪到别的域名要调管理接口时，再按需加。

## 相册的分级参数

`is_hidden` 与 `rating` 是**两个独立维度**，任一命中就不进相册：

- `is_hidden = 1`：管理员主动隐藏
- `rating = 'unspecified'`：还没分类，**任何档位都不陈列**（连 `?rating=r18` 也看不到）

`?rating=` 参数决定「陈列哪些分级」，是个安静的开关（不走 UI 控件，靠 URL 传递）：

| 参数 | 陈列的分级 |
| --- | --- |
| （无） | 由 `DEFAULT_ALBUM_RATING` 决定，**默认只有 G** |
| `g` / `g_only` | G |
| `r12` | G, R12 |
| `r15` | G, R12, R15 |
| `r18` | G, R12, R15, R18 |
| `r15_only` | **仅 R15**（`g_only` / `r12_only` / `r18_only` 同理，不累进） |
| 非法值 | 静默回落到默认档，不报错 |

## 配置项（`wrangler.toml` 的 `[vars]`）

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PREFIX` | `img` | 键前缀，与旧站一致，迁移时键不用改 |
| `IMAGE_BASE` | `https://img.ohtoai.top` | 直链前缀，接口用它拼完整 URL |
| `DEFAULT_ALBUM_RATING` | `g` | 相册不带参数时的档位。想让访客默认看到更多，改成 `r12` / `r15` / `r18` |
| `LIST_CACHE_SECONDS` | `0` | 相册接口的边缘缓存秒数。**0 = 不缓存，永远最新**；访问量上来想省 D1 读取再调大 |
| `IMAGE_CACHE_SECONDS` | `86400` | 图片直链的缓存秒数，**上传时写进 R2 对象**，改它只影响之后上传的图 |
| `UPLOAD_DEFAULT_RATING` | `unspecified` | 上传默认分级。想「传完就能直接分享」就改成 `G` |
| `MAX_UPLOAD_BYTES` | `52428800` | 单文件上限（50MB） |
| `ALLOWED_ORIGINS` | 站点域 + 本地测试端口 | 允许跨域调管理接口的来源（逗号分隔）。前端在 GitHub Pages 上、Worker 在另一个域名，属于跨域；管理接口默认**不发光 CORS 头**，只有这里的来源才放行。不带 credentials（不用 Cookie） |

### 给已经建过表的库加新列

`schema.sql` 用的是 `CREATE TABLE IF NOT EXISTS`，**不会**给已有的表加列。已经部署过的库要跑迁移：

```bash
cd worker-r2
npx wrangler d1 execute picbed-db --remote --file=migrations/001-add-thumb-key.sql -y
npx wrangler d1 execute picbed-db --remote --file=migrations/002-album-index.sql -y
```

（本地库同理，把 `--remote` 换成 `--local`。新库不用跑，`schema.sql` 里已经包含。）

两点值得展开：

**为什么相册默认不缓存**：D1 是按「**扫描**的行数」计费的（不是返回的行数），所以相册查询建了复合索引
`idx_images_public`，一次浏览只读「命中该档位的行数」。默认只列 G 时通常就是 G 的数量——几千张图的量级下，
免费额度（500 万行/天）离用满还很远，没必要为了省钱牺牲「改完立刻生效」。真被大流量转载了，把
`LIST_CACHE_SECONDS` 调成 300 / 3600 就行。

**为什么图片缓存可以很长**：键是**不可变**的（每次上传都生成新键，不会覆盖旧对象），所以缓存再久也不会
出现「内容换了还拿旧图」。唯一的代价是**删除**后最长要等 TTL 过期才彻底访问不到（隐藏不受影响，直链本来就开放）。

## 从腾讯云 COS 迁移

### 原则

1. **只 copy，绝不 move / delete**：旧站和旧前端还在用 `album.ohtoai.top`，COS 上的数据在切换完成前必须原封不动。
2. **键保持不变**（`img/YYYY/MM/DD/…`）：老链接在新域名下按同样路径就能对上，`r2_key` 无需转换。
3. **可见性精确对齐**：原本有公开标记的图 → `rating='G'`，其余 → `rating='unspecified'`，**全部 `is_hidden=0`**。
   这样迁移后「相册里能看到什么」与迁移前完全一致（「不公开」由 `unspecified` 表达，不占用 `is_hidden`，两个维度不混）。

### 步骤

**一、配 rclone 的两个 remote**（`rclone config` 交互式创建）

```
[cos]  type = tencentcos
       secret_id / secret_key
       endpoint = cos.ap-shanghai.myqcloud.com

[r2]   type = s3
       provider = Cloudflare
       access_key_id / secret_access_key   ← R2 控制台 Manage R2 API Tokens（Object Read & Write）
       endpoint = https://<账户ID>.r2.cloudflarestorage.com
       region = auto
       acl = private
```

**二、搬字节**（先小目录试跑，确认大小与 MIME 对得上再全量）

```bash
rclone copy "cos:album-1255316209/img/2026/10/03" "r2:picbed-images/img/2026/10/03" --progress
rclone copy "cos:album-1255316209/img" "r2:picbed-images/img" --exclude "_picbed/**" --transfers 8 --progress
rclone check "cos:album-1255316209/img" "r2:picbed-images/img" --exclude "_picbed/**" --size-only
```

**三、生成导入 SQL**（清单要对**桶根**跑，Path 就是 R2 的键，少一处前缀写错的机会）

```bash
rclone lsjson --recursive "cos:album-1255316209" > img-lsjson.json
node ../scripts/cos-to-r2/gen-seed-sql.mjs img-lsjson.json ./seed
```

脚本会跳过目录占位对象、`_picbed` 保留路径、点开头的文件和 0 字节对象，并打印一份对账摘要
（入库多少、公开多少、悬空标记多少、总字节）。**先人工核对「公开」数**是否等于 COS 上
`img/_picbed/public/` 下的标记数（减去悬空标记）。

**四、导入**

```bash
npx wrangler d1 execute picbed-db --remote --file=./seed/seed_0001.sql -y
# 文件不止一个就按编号依次跑
```

生成的 SQL 可重复执行（`ON CONFLICT(r2_key) DO NOTHING`），跑错了重跑一遍即可。

**五、对账**

```bash
npx wrangler d1 execute picbed-db --remote --json -y \
  --command="SELECT COUNT(*) n, SUM(size) bytes, SUM(rating='G') g FROM images"
rclone size "r2:picbed-images/img"
```

行数 = `rclone size` 的对象数 − 被跳过的占位/标记数；`bytes` 应当对得上。最后从管理页随机抽几张点开确认能出图。

### 迁移后作废的东西（确认切换完成后再删）

- `.github/workflows/renew-cert.yml` 和 `scripts/tencent-cert-deploy.py` —— 整套证书自动化。
  自定义域名由 Cloudflare 自动签发续期，不需要「上传证书 + 绑定到桶」这一步了。
- COS 的跨域 CORS 配置、README 里的腾讯云子账号 / PicGo COS 章节。
- 旧的 `worker/`（签 STS 那套）—— 等 `index.html` 也迁移完再删。
- COS 桶里的 `img/_picbed/` 标记对象 —— 状态已经搬进 D1，但那要等旧前端也停用之后。

### 迁移期间的正常现象

新上传的图进 R2，**旧站看不到它们**（旧站读的是 COS）——这是预期行为，等前端迁移那轮才合并。
两个域名（`album.ohtoai.top` 走 COS、`img.ohtoai.top` 走 R2）互不影响，可以安全并行。

## 常见问题

| 现象 | 原因 |
| --- | --- |
| `wrangler … --local` 跑完**不回命令行** | wrangler 在本地模式会拉起 `workerd` 子进程，Windows 上退出时没回收它，父进程就一直等。**SQL 已经执行完了**（会先打印 `commands executed successfully`），直接 Ctrl+C 即可——`--local` 的写入是立刻落盘的。试过关遥测和清代理变量，都没用，不用在那些方向折腾 |
| 想直接看本地库里的数据 | 本地 D1 就是个普通 SQLite 文件：`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`，用任何 SQLite 工具都能打开。绕开 wrangler，也就没有上面那个卡住的问题 |
| 改了 schema 但 `wrangler dev` 里没生效 | 重启 `wrangler dev`（miniflare 会缓存数据库连接） |
| 管理接口报 503 | 没设 `PICBED_PASSWORD`（故意 fail closed，不是 bug）。本地开发时在 `worker-r2/.dev.vars` 里写 `PICBED_PASSWORD="dev"` 再重启 dev |
| 部署时 `custom_domain` 绑定失败 | `img.ohtoai.top` 在 DNS 里已有记录，先删掉那条 |
| 上传报 CORS 错 | 管理页是同源的，不该有 CORS 问题；若从前端别的域名调管理接口，需要自己加 CORS 头 |
| 前端 `fetch` 读图报 CORS | 桶的 CORS 没配，跑 `wrangler r2 bucket cors set`；`<img>` 标签不受影响 |
| 上传 413 | 超过 `MAX_UPLOAD_BYTES`；Workers 免费版请求体上限 100MB，别设得太接近 |
| 用 `wrangler r2 object put` 传了对象，直链却 404 | **这个子命令默认写的是本地模拟桶**，要加 `--remote` 才写线上（wrangler 4.135 实测如此，`get` 同理）。用 rclone 迁移不受影响，但手动验证时务必带上 `--remote` |
| 本地预览图 404 | 正常，管理页会自动回落到 `/i/<key>` |
| 改了 `IMAGE_CACHE_SECONDS` 但旧图没变 | 缓存头是上传时烧进对象的；要么重新上传，要么用 Cache Rule 覆盖 Edge TTL |

## 刻意没做的

- **服务端缩略图**：R2 没有图片处理能力，Cloudflare Images / Image Resizing 要另外付费（$5/月起）。
  管理页用 `<img loading="lazy" width="64">` 就够。**前端迁移那轮必须单独决策**：
  在「浏览器用 canvas 生成缩略图一并上传」「原图直出」「付费上 Cloudflare Images」之间选一个。
- **远程转存 `/url`**：属于前端功能，旧 Worker 上还在跑，前端迁移时再搬。
- **删除时主动 purge CDN**：想让「删除」立刻生效又不想牺牲长缓存时才需要。你已经有 `CF_API_TOKEN`，
  加两个 secret + 一次 API 调用即可，随时可加。
- **给直链加门禁**：见 `src/access.js` 末尾的扩展位说明（把 Worker 重新挡回 R2 前面，键结构不用变）。
