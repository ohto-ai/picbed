# PicBed 图床

腾讯云 COS + GitHub Pages + Cloudflare Worker 的个人免费图床：

- **浏览器上传**：拖拽 / 点击 / Ctrl+V 粘贴截图，拿临时密钥直传 COS（密钥不出 Worker）
- **远程转存**：粘贴任意图片 URL，一键转存到自己的图床
- **相册**：浏览、复制链接（URL / Markdown / HTML）、删除
- **公开画廊**：单张图片可设为公开，游客无需密码即可浏览（看不到未公开的图片）
- **悬浮上传面板**：右下角状态按钮，实时进度 / 本次结果 / 上传历史收在一处
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
        │   img/ 目录   │  相册 = 文件夹；img/_picbed/public/ 存「公开」标记
        └──────────────┘
               ▲
┌──────────────┴───────────────────┐
│ 网页（GitHub Pages 静态站）        │
│   管理：浏览器 → Worker 要临时密钥  │
│   → 直传 COS / 列目录 / 删除       │
│   游客：直接请求 Worker 的 /public │
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
│  ├─ worker.js            # Cloudflare Worker：签 STS + 远程转存 + 公开画廊接口
│  └─ wrangler.toml        # Worker 配置（桶信息）
├─ .github/workflows/
│  ├─ pages.yml            # 推送到 GitHub 后自动部署 Pages
│  └─ renew-cert.yml       # 每周自动续期证书并部署到腾讯云 COS
├─ scripts/
│  └─ tencent-cert-deploy.py  # 上传证书到腾讯云 SSL 并绑定 COS 自定义域名
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
           "name/cos:GetObject",
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

Worker 提供的接口：

| 接口 | 需要密码 | 说明 |
|---|---|---|
| `POST/GET /token` | 是 | 签发 30 分钟、仅限 `PREFIX/` 目录的 COS 临时密钥 |
| `POST /url` | 是 | 抓取远程图片并转存（10MB 上限） |
| `GET /list` | 是 | 列出 `PREFIX/` 下全部对象，前端据此构建相册目录树 |
| `GET /public` | 否 | 游客用：列出 `PREFIX/_picbed/public/` 下的公开图片与相册结构 |

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

### 六、证书自动续期（`album.ohtoai.top`）

`album.ohtoai.top` 的 HTTPS 证书由 GitHub Actions 全自动维护：每周定时用 acme.sh 走 Cloudflare DNS-01 验证向 Let's Encrypt 续期 → 上传到腾讯云 SSL 证书管理 → 自动绑定到 COS 存储桶 `album-1255316209` 的自定义域名。证书到期前 30 天才会真正换新，其余时候流程仅做上传校验，相同证书不会重复上传。

首次启用需一次性配置：

1. **Cloudflare API Token**：Cloudflare 控制台 → 我的个人资料 → **API 令牌 → 创建令牌**，模板选「编辑区域 DNS」（Zone.DNS.Edit），区域限定为 `ohtoai.top`。记下 Token；Zone ID 在域名概览页右下角
2. **腾讯云子账号密钥**：按「步骤一」的方式新建一个子账号，粘贴下方最小权限策略（仅能上传证书 + 给该桶绑定/查询证书）：

   ```json
   {
     "version": "2.0",
     "statement": [
       {
         "effect": "allow",
         "action": [
           "name/ssl:UploadCertificate",
           "name/ssl:DescribeCertificates",
           "name/ssl:DeleteCertificate"
         ],
         "resource": ["*"]
       },
       {
         "effect": "allow",
         "action": [
           "name/cos:PutBucketDomainCertificate",
           "name/cos:GetBucketDomainCertificate"
         ],
         "resource": ["qcs::cos:ap-shanghai:uid/1255316209:album-1255316209/*"]
       }
     ]
   }
   ```

   > 若策略编辑器里搜不到上面的 `cos:` action（接口较新），可暂时改用 `name/cos:*`。
   >
   > 如果子账号之前已按旧版策略创建过（缺 `ssl:DescribeCertificates` / `ssl:DeleteCertificate`），在策略列表里编辑该策略补上这两个 action 即可，无需重建子账号。

3. **配置 GitHub Secrets**：仓库 → Settings → Secrets and variables → Actions，新增 4 个 secret：

   | Secret | 值 |
   |---|---|
   | `CF_API_TOKEN` | 第 1 步的 Cloudflare API Token |
   | `CF_ZONE_ID` | `ohtoai.top` 的 Zone ID |
   | `TENCENT_SECRET_ID` | 第 2 步子账号的 SecretId |
   | `TENCENT_SECRET_KEY` | 第 2 步子账号的 SecretKey |

   （可选）加一个变量 `ACME_EMAIL` 作为 Let's Encrypt 注册邮箱，默认 `noreply@ohtoai.top`。

4. **测试**：Actions → `自动续期证书并部署到腾讯云 COS` → Run workflow，勾选「强制重新签发」跑一次。日志三步全绿后，到 [SSL 证书管理](https://console.cloud.tencent.com/ssl) 和 COS 桶「域名与传输管理」里确认新证书已就位。

注意事项：

- 每周一自动跑（北京时间周二凌晨）；失败时 GitHub 会发邮件到账号邮箱
- 公开仓库的定时任务在 60 天无提交后会被 GitHub 停用，保持仓库有 push 即可（手动 Run workflow 不受影响）
- acme.sh 的账号/证书状态（含 Cloudflare Token）存在 workflow artifact 里，仅本仓库有权限的 token 可读取，不会对外公开；轮换 Cloudflare Token 后手动「强制重新签发」跑一次即可
- 每次换证都会在 SSL 证书管理里新增一条证书；旧证书过期后由脚本自动清理删除（仅清理本域名、状态已过期、未关联云资源的上传证书，其余证书不受影响）

## 使用说明

页面顶部有两个标签：**🌍 公开画廊**（默认，游客视角）与 **🔒 我的相册**（管理视角）。
本机浏览器里存过密码的话，打开页面会直接进「我的相册」；没有密码时点「我的相册」会引导你去设置里填。

### 公开画廊（游客可见）

- 想公开某张图片：在「我的相册」里把鼠标移到图片上，点右上角 **🌑** 即可设为公开（**🌍** 表示已公开）；灯箱里也有「设为公开 / 取消公开」按钮
- 多选模式下可**批量**公开 / 取消公开
- 游客看到的相册结构与图片所在的目录一致：某张图片公开后，它所在的相册路径也会出现在公开画廊里，但**同相册中未公开的图片游客看不到**
- 游客只能浏览和复制链接，看不到上传、移动、删除等任何管理入口
- 实现方式：设为公开时会在 `img/_picbed/public/` 下创建一个零字节**镜像标记**对象（如 `img/travel/x.jpg` → `img/_picbed/public/travel/x.jpg`）；取消公开即删除该标记。图片移动 / 相册重命名 / 删除时标记会同步跟随，无需手动维护
- `_picbed` 是保留目录名，不能用作相册名或上传目录

### 管理

- **上传**：拖拽 / 点击 / Ctrl+V 粘贴，支持批量
  - **上传文件夹**：点「📂 上传文件夹」或直接把整个文件夹拖进页面，会**递归**扫描子目录，只上传图片（非图片文件自动跳过），并保留目录结构——选「我的相册」会生成同名相册，里面的子目录也原样保留
  - **重名处理**：上传/移动遇到同名文件会弹出冲突窗口，可预览新旧两张图、自动比对内容是否完全一致，并选择覆盖 / 自动重命名（`名字 (1).jpg`）/ 跳过，可勾选「应用到后续所有文件」
  - 单张上限 50MB
- **进度面板**：右下角的悬浮按钮显示上传进度；开始上传时会自动展开，里面按顺序放着**进行中的队列**、**本次上传结果**（含「复制全部」）和**上传历史**（仅存本机浏览器）。徽标显示百分比 / 完成数 / 失败数，点按钮或按 Esc 收起
- **转存**：粘贴图片 URL 点「转存」（Worker 抓取，10MB 上限）
- **链接**：每条结果都有 URL / Markdown / HTML 三个复制按钮，「复制全部」按默认格式批量复制
- **相册管理**：
  - 相册 = `img/` 下的文件夹；点文件夹进入，面包屑导航返回（导航条吸顶，滚动时始终可见）
  - **新建 / 重命名 / 移动**：都在自定义弹窗里完成，弹窗下方是一棵**可展开的相册目录树**，点任意相册即可把路径填进输入框（输入框里已有的相册名会保留在末尾，方便「移动到某相册下并改名」）
    - 输入框里直接打字时，目录树会变成**自动补全**的匹配列表
    - 路径可用 `/` 创建多级；以 `/` 开头表示**从图床根目录**算起，否则相对当前目录；留空=根目录
    - 会阻止移动到自身或其子相册
  - **删除相册**（🗑️）：递归删除其中全部图片、子相册和空相册标记，确认框会写明将删除多少张图片
  - **多选模式**：勾选图片后批量删除、批量移动、批量公开
  - 单图删除在灯箱里；「缩略图」开关需要在 COS 开通图片处理功能
- **上传密码**：Worker 里设了 `PICBED_PASSWORD` 后，页面「设置」里填相同密码；没有密码的人只能看公开画廊，无法进行任何操作

## 常见问题

| 问题 | 原因 / 解决 |
|---|---|
| 上传报 CORS 错误 | 没做第二步的 CORS 配置 |
| 403 / 密码错误 | 页面密码与 Worker 的 `PICBED_PASSWORD` 不一致 |
| 公开画廊报「加载失败」 | Worker 未更新到含 `/public` 接口的版本，重新 `wrangler deploy` |
| 设为公开了游客还是看不到 | 刷新页面；公开列表不做缓存，但浏览器可能仍显示旧页面 |
| 图片链接打不开 | 确认桶是公有读；若走 CDN 检查回源配置 |
| 删了图片还能访问 | CDN 缓存未过期，可在 CDN 控制台刷新目录 |
| 相册里缩略图全挂了 | 未开通 COS 图片处理，关掉「缩略图」开关即可 |
| 证书快过期了还没换 | 看 Actions 里 renew-cert 是否失败（失败会收到邮件），或手动 Run workflow 勾选「强制重新签发」 |

## 成本与安全

- **成本**：GitHub Pages 与 Cloudflare Worker 免费；COS 收存储费（约 0.1 元/GB/月）+ 流量费（约 0.5 元/GB），个人用量每月几毛到几元，走 `album.ohtoai.top`（CDN）流量更便宜
- **密钥安全**：`TENCENT_SECRET_ID / TENCENT_SECRET_KEY` 只存在于 Worker 的 Secrets 和 GitHub Secrets（证书自动化）中，绝不写进任何会被公开的文件；网页拿到的只是 30 分钟有效、仅限 `img/` 目录的临时密钥
- **防盗链**：桶是公有读，知道域名的人都能看图，介意的话在 CDN 上开防盗链
- **「公开」是浏览性开关，不是加密**：桶本身仍是公有读，任何人拿到图片 URL 都能直接打开——公开功能只是决定**游客能不能在页面里逛到**这些图，别把敏感图片的 URL 泄露出去
- **注意**：Worker 的 `PREFIX` 与 `config.js` 的 `prefix` 必须一致（默认都是 `img`）
