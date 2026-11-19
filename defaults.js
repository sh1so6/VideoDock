// 設定の既定値（content.js と options.js で共有。content script では content.js より先に読み込む）
// eslint-disable-next-line no-unused-vars
const VIDEODOCK_DEFAULTS = {
  // PiP窓の操作バーの出し方:
  //   edge   = 窓の下端に近づいたときだけ（既定）
  //   move   = マウスを動かすたび
  //   always = 常に表示
  //   hidden = 出さない（H キーで出し入れ）
  uiMode: 'edge',
  edgeSize: 56, // edgeモード: 下端から何pxで反応するか
  hideDelay: 1200, // 操作が止まってから隠すまで(ms)
  showHint: false, // PiPを開いたとき操作ヒントを出す
  buttons: { play: true, seek: true, time: true, mute: true, zoom: true, back: true },
};
