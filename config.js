// OhtoAi 图床站点配置：修改后推送到 GitHub 即可生效
// 页面上「设置」里修改的项会存到浏览器本地，优先级高于这里
window.PICBED_CONFIG = {
  // 图床后端（Cloudflare Worker）地址
  api: 'https://picbed-worker.ohtoai.top',

  // 图片直链域名：R2 桶的自定义域名
  // （album.ohtoai.top 也指向同一个桶，那是迁移前的老域名，只为让旧链接继续有效）
  imageBase: 'https://img.ohtoai.top',

  // 源码仓库地址：填了会在顶栏给访客显示一个 GitHub 入口，留空则不显示
  repo: 'https://github.com/ohto-ai/picbed',
};
