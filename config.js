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

  // 界面风格（访客可在顶栏「风格」里自行改，改完存在本机，优先于这里）
  // 取值：
  //   modern          现代简约
  //   skeuo           早期智能机拟物
  //   lcd             功能机 LCD · 亮版砖绿
  //   lcd-olive       功能机 LCD · 暗版暗橄榄   ← 当前默认
  //   lcd-inv         功能机 LCD · 暗版反色砖绿
  //   lcd-amber       功能机 LCD · 暗版琥珀终端
  //   lcd-backlight   功能机 LCD · 暗版诺基亚背光
  //   y2k             Y2K 霓虹翻盖机
  //   pda             PDA / Windows Mobile
  skin: 'lcd-olive',

  // CRT 滤镜：叠在任意皮肤之上的一层扫描线 + 荫罩 + 暗角（访客同样可在「风格」里开关）
  crt: false,
};
