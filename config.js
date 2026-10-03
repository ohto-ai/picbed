// OhtoAi 图床站点配置：修改后推送到 GitHub 即可生效
// 页面上「设置」里修改的项会存到浏览器本地，优先级高于这里
window.PICBED_CONFIG = {
  // 必填：图床后端（Cloudflare Worker）地址
  // 这个域名原本属于旧的 COS Worker，现已切换给新的 R2 后端。
  // （切换期间 workers.dev 地址也保持可用，避免缓存里的旧 config.js 失效）
  api: 'https://picbed-worker.ohtoai.top',

  // 图片访问域名：R2 桶的自定义域名，图片字节从这里直出（不经过 Worker）
  imageBase: 'https://img.ohtoai.top',

  // 源码仓库地址：填了会在顶栏给访客显示一个 GitHub 入口，留空则不显示
  repo: 'https://github.com/ohto-ai/picbed',

  // ---------------------------------------------------------------------------
  // 以下字段是迁移前的旧版前端用的，**暂时保留**：
  // index.html 和 config.js 是两个独立缓存的文件，浏览器里可能存着旧版页面 +
  // 新版配置。现在就删掉它们，那些还没更新到新页面的访客会当场加载失败。
  // 等这次部署过了缓存窗口（几天），就可以把下面整段删掉。
  // ---------------------------------------------------------------------------
  worker: 'https://picbed-worker.ohtoai.top',
  bucket: 'album-1255316209',
  region: 'ap-shanghai',
  prefix: 'img',
  customDomain: 'https://album.ohtoai.top',
  maxKeys: 500,
  thumb: true,
};
