// OhtoAi 图床站点配置：修改后推送到 GitHub 即可生效
// （.github/workflows/deploy.yml 会把 index.html 与这个文件传进 R2 桶 —— 站点就是从桶里发出去的，
//   所以这里改了以后等一次工作流，不是等 GitHub Pages）
// 页面上「设置」里修改的项会存到浏览器本地，优先级高于这里
window.PICBED_CONFIG = {
  // 图床后端（Cloudflare Worker）地址。
  // 它和站点不同源，所以管理接口要放行本站来源 —— 名单在 worker-r2/wrangler.toml 的 ALLOWED_ORIGINS
  api: 'https://picbed-worker.ohtoai.top',

  // 站点与图片的**唯一域名**：R2 桶的自定义域名。
  // 页面（桶里的 index.html）和图片都在它上面，**同源** —— 那些要读字节进度的 fetch 因此
  // 完全不依赖 CORS（从前页面在 picbed.ohtoai.top、图在 img.ohtoai.top，跨域，边缘缓存里
  // 偶尔会读到一份没有 ACAO 的副本，表现为「偶发 CORS 报错、刷新又好了」）。
  // picbed.ohtoai.top 与 album.ohtoai.top 现在只是 301 到这个域名的别名。
  imageBase: 'https://img.ohtoai.top',

  // 源码仓库地址：填了会在顶栏给访客显示一个 GitHub 入口，留空则不显示
  repo: 'https://github.com/ohto-ai/picbed',

  // 界面风格（访客可在顶栏「风格」里自行改，改完存在本机，优先于这里）
  // 取值：
  //   modern          现代简约
  //   skeuo           早期智能机拟物
  //   lcd             功能机 LCD · 亮版砖绿
  //   lcd-olive       功能机 LCD · 暗版暗橄榄
  //   lcd-inv         功能机 LCD · 暗版反色砖绿
  //   lcd-amber       功能机 LCD · 暗版琥珀终端
  //   lcd-backlight   功能机 LCD · 暗版诺基亚背光
  //   y2k             Y2K 霓虹翻盖机   ← 当前默认
  //   pda             PDA / Windows Mobile
  skin: 'y2k',

  // CRT 滤镜：叠在任意皮肤之上的一层扫描线 + 荫罩 + 暗角 + 镜头畸变
  // （访客同样可在「风格」里开关。畸变挂的是 backdrop-filter，只有 Chromium 系会弯，
  //   Safari / Firefox 拿到的是不弯的平面扫描线 + 一块屏幕形状的黑边。
  //   因位移产生的点按/悬停偏差主脚本做了补偿，只有框选拖拽还偏 —— 详见 README）
  crt: false,
};
