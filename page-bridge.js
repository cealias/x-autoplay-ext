/**
 * X 自动连播助手 —— 网页“桥”脚本（在网页自己的环境里运行，manifest 里写的是 "world": "MAIN"）
 *
 * 为什么需要它？
 * 登录后的 X 时间线里，视频播放器上没有“打开大屏”的链接，点视频本身也只会开声音 / 暂停。
 * 但 X 自己打开大图时，会往浏览器历史里存一条 { fromApp: true, previousPath: 原来的网址 }，
 * 再换网址。只要照着做，X 就会在时间线上面弹出它自己的视频大屏
 * （不刷新页面，评论、点赞、收藏都能用，关掉后时间线位置也不变）。
 *
 * 这件事必须在网页自己的环境里做：扩展的主程序（content.js）和网页是隔开运行的，
 * 从那边发出去的“网址变了”通知，X 读不到里面存的 previousPath，就会把时间线换成帖子详情页。
 *
 * 用法：content.js 把要打开的网址写到 <html data-xap-open-video="..."> 上，
 * 再发一个 x-autoplay-open-video 事件，这里收到后去换网址。
 */
(function () {
  'use strict';

  window.addEventListener('x-autoplay-open-video', () => {
    const root = document.documentElement;
    const href = root.getAttribute('data-xap-open-video');
    root.removeAttribute('data-xap-open-video');

    // 只接受 /用户名/status/数字/video/数字 这种网址，别的一律不管
    if (!href || !/^\/[^/?#]+\/status\/\d+\/video\/\d+$/.test(href)) return;

    const state = {
      key: Math.random().toString(36).slice(2, 8),
      state: { fromApp: true, previousPath: location.pathname }
    };
    history.pushState(state, '', href);
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  });
})();
