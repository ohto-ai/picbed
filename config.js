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

  // 缩略图：列表里用缩略图代替原图，首屏流量通常能降一个数量级。整站统一，没有本机开关。
  // 边长由前端按「网格实际格子宽 × 屏幕像素比」算（常见视口下约 200~450px），不是写死的常数；
  // 用的是 crop 裁出居中正方形，和格子的显示区域一比一对应，横竖图都不浪费像素。
  // 需要桶已开通图片处理（数据万象基础图片处理，≤10TB/月 免费，等于不花钱）。
  // 单张 >32MB 或格式不支持时前端会自动退回原图，不会显示不出来 —— 所以即使误开也是安全的，
  // 只是每张图白费一次请求。桶没开通图片处理就把它设成 false。
  thumb: true,

  // 源码仓库地址：填了会在顶栏给访客显示一个 GitHub 入口，留空则不显示
  repo: 'https://github.com/ohto-ai/picbed',
};
