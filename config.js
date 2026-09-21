// PicBed 站点配置：修改后推送到 GitHub 即可生效
// 页面上「设置」里修改的项会存到浏览器本地，优先级高于这里
window.PICBED_CONFIG = {
  // 必填：Cloudflare Worker 地址（部署完 Worker 后填，形如 https://picbed-worker.xxx.workers.dev）
  // 不填也可以，首次打开页面时会弹出设置框
  worker: 'https://picbed-worker.ohtoai.top',

  // 腾讯云 COS 存储桶信息（已按你的桶填好）
  bucket: 'album-1255316209',
  region: 'ap-shanghai',

  // 上传目录前缀，必须与 worker/wrangler.toml 中的 PREFIX 一致
  prefix: 'img',

  // 图片访问域名：留空则用 COS 默认域名，有自定义域名/CDN 就填这里
  customDomain: 'https://album.ohtoai.top',

  // 相册每页加载数量
  maxKeys: 500,

  // 源码仓库地址：填了会在顶栏给访客显示一个 GitHub 入口，留空则不显示
  repo: 'https://github.com/ohto-ai/picbed',
};
