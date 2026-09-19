# PicBed 图床

腾讯云 COS + GitHub Pages + Cloudflare Worker 的个人免费图床：

- **浏览器上传**：拖拽 / 点击 / Ctrl+V 粘贴截图，拿临时密钥直传 COS（密钥不出 Worker）
- **远程转存**：粘贴任意图片 URL，一键转存到自己的图床
- **相册**：浏览、复制链接（URL / Markdown / HTML）、删除
- **PicGo 客户端**：同一套 COS 桶，电脑上截图一键上传
- **全免费托管**：GitHub Pages 免费静态托管，Cloudflare Worker 免费额度 10 万请求/天

## 架构

```
┌─ PicGo 桌面端（密钥只存本机）──────┐
│   截图 / 剪贴板，一键上传           │
└──────────────┬───────────────────┘
               ▼
        ┌──────────────┐
        │  腾讯云 COS   │  album-1255316209（ap-shanghai，公有读私有写）
        │   img/ 目录   │
        └──────────────┘
               ▲
┌──────────────┴───────────────────┐
│ 网页（GitHub Pages 静态站）        │
│   浏览器 → Worker 要临时密钥        │
│   → 直传 COS / 列目录 / 删除       │
└──────────────────────────────────┘
        ▲ 签 STS（限 img/ 目录，30 分钟有效）
   Cloudflare Worker（密钥存 Secrets）
```

## 目录结构

```
picbed/
├─ index.html              # 前端页面（上传 / 相册 / 转存，纯静态）
├─ config.js               # 站点配置（Worker 地址、桶信息、访问域名）
├─ worker/
│  ├─ worker.js            # Cloudflare Worker：签 STS + 远程转存
│  └─ wrangler.toml        # Worker 配置（桶信息）
├─ .github/workflows/
│  └─ pages.yml            # 推送到 GitHub 后自动部署 Pages
└─ README.md
```

## 部署步骤

### 一、准备腾讯云密钥（推荐子账号）

1. 打开 [腾讯云 API 密钥管理](https://console.cloud.tencent.com/cam/capi) 新建密钥，记下 SecretId / SecretKey（直接用主账号密钥的话到这一步即可）
2. 更安全的做法是子账号：
   - CAM → **策略 → 新建自定义策略 → 按策略语法创建（空白模板）**，名称随意（如 `PicbedWorker`），粘贴下方 JSON
   - CAM → **用户 → 新建用户 → 自定义创建**，访问方式只勾选「编程访问」，创建完成后立即保存 SecretId / SecretKey（只显示一次）
   - 给该子账号「关联策略」，勾选刚创建的 `PicbedWorker`

   ```json
   {
     "version": "2.0",
     "statement": [
       {
         "effect": "allow",
         "action": [
           "name/cos:PutObject",
           "name/cos:PostObject",
           "name/cos:HeadObject",
           "name/cos:DeleteObject",
           "name/cos:InitiateMultipartUpload",
           "name/cos:UploadPart",
           "name/cos:CompleteMultipartUpload",
           "name/cos:AbortMultipartUpload",
           "name/cos:ListParts"
         ],
         "resource": ["qcs::cos:ap-shanghai:uid/1255316209:album-1255316209/img/*"]
       },
       {
         "effect": "allow",
         "action": ["name/cos:GetBucket", "name/cos:ListMultipartUploads"],
         "resource": ["qcs::cos:ap-shanghai:uid/1255316209:album-1255316209/*"]
       }
     ]
   }
   ```

   注意：`GetFederationToken`（换临时密钥）不需要也不能在 CAM 里单独授权；子账号凭自身 COS 权限即可调用，最终临时密钥权限 = 子账号权限 ∩ 请求中的 Policy。

### 二、配置存储桶 CORS（必须！否则浏览器上传会失败）

COS 控制台 → 存储桶 `album-1255316209` → **安全管理 → 跨域访问 CORS 设置** → 添加规则：

| 项 | 值 |
|---|---|
| 来源 Origin | `*`（或填你的 Pages 域名） |
| 操作 Methods | GET、POST、PUT、HEAD、DELETE |
| Allow-Headers | `*` |
| Expose-Headers | `ETag`、`Content-Length`、`x-cos-request-id` |
| 超时 Max-Age | 600 |

### 三、部署 Worker（签名服务）

```bash
cd worker
npm install -g wrangler
wrangler login                                        # 浏览器授权 Cloudflare
wrangler secret put TENCENT_SECRET_ID                 # 粘贴腾讯云 SecretId
wrangler secret put TENCENT_SECRET_KEY                # 粘贴腾讯云 SecretKey
wrangler secret put PICBED_PASSWORD                   # 可选：设置上传密码，不设置则拿到地址的人都能上传
wrangler deploy
```

记下输出的 Worker 地址，形如 `https://picbed-worker.<你的名字>.workers.dev`。

### 四、部署前端到 GitHub Pages

1. 把整个目录推送到 GitHub 仓库
2. 修改根目录 `config.js` 里的 `worker` 为上面的地址（不填也行，首次打开页面会弹出设置框）
3. 仓库 → **Settings → Pages → Source 选 GitHub Actions**
4. 推送后自动部署，访问 `https://<用户名>.github.io/<仓库名>/`

### 五、配置 PicGo 桌面客户端（可选）

图床区 → **腾讯云COS v5**：

| 项 | 值 |
|---|---|
| SecretId / SecretKey | 你的腾讯云密钥（长期密钥，只存本机） |
| Bucket | `album-1255316209` |
| AppId | `1255316209` |
| 存储区域 | `ap-shanghai` |
| 存储路径 | `img/` |
| 自定义域名 | `https://album.ohtoai.top` |

## 使用说明

- **上传**：拖拽 / 点击 / Ctrl+V 粘贴，支持批量；自动生成 `img/年/月/日/时间_随机.扩展名` 的路径
- **转存**：粘贴图片 URL 点「转存」（Worker 抓取，10MB 上限）
- **链接**：每条结果都有 URL / Markdown / HTML 三个复制按钮，「复制全部」按默认格式批量复制
- **相册**：浏览桶内全部图片、点击放大、复制链接、删除；「缩略图」开关需要在 COS 开通图片处理功能
- **上传密码**：Worker 里设了 `PICBED_PASSWORD` 后，页面「设置」里填相同密码

## 常见问题

| 问题 | 原因 / 解决 |
|---|---|
| 上传报 CORS 错误 | 没做第二步的 CORS 配置 |
| 403 / 密码错误 | 页面密码与 Worker 的 `PICBED_PASSWORD` 不一致 |
| 图片链接打不开 | 确认桶是公有读；若走 CDN 检查回源配置 |
| 删了图片还能访问 | CDN 缓存未过期，可在 CDN 控制台刷新目录 |
| 相册里缩略图全挂了 | 未开通 COS 图片处理，关掉「缩略图」开关即可 |

## 成本与安全

- **成本**：GitHub Pages 与 Cloudflare Worker 免费；COS 收存储费（约 0.1 元/GB/月）+ 流量费（约 0.5 元/GB），个人用量每月几毛到几元，走 `album.ohtoai.top`（CDN）流量更便宜
- **密钥安全**：`TENCENT_SECRET_ID / TENCENT_SECRET_KEY` 只存在于 Worker 的 Secrets 中，绝不写进任何会被公开的文件；网页拿到的只是 30 分钟有效、仅限 `img/` 目录的临时密钥
- **防盗链**：桶是公有读，知道域名的人都能看图，介意的话在 CDN 上开防盗链
- **注意**：Worker 的 `PREFIX` 与 `config.js` 的 `prefix` 必须一致（默认都是 `img`）
