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
  // PiP窓のホイール操作:
  //   右クリックを押しながらホイール = ズーム
  //   窓の上部のホイール = 音量 / 下部のホイール = シーク（wheelSwap で入れ替え）。中央部は何もしない
  wheelSwap: false, // true: 上部=シーク / 下部=音量
  wheelZone: 30, // 上部・下部それぞれの範囲(窓の高さに対する%)
  wheelInvert: false, // 音量・シークのホイール向きを反転（既定: 上=音量UP/進む）
  zoomInvert: false, // ズームのホイール向きを反転（既定: 上=拡大）
  volumeStep: 5, // ホイール1ノッチあたりの音量(%)
  seekStep: 5, // ホイール1ノッチあたりのシーク(秒)
  // 画像のPiP（ズーム・移動つきの別ウィンドウ）:
  //   alt   = Alt を押しながら画像にマウスを乗せたときだけボタンを出す（既定）。Alt+P でも開ける
  //   hover = 動画と同じく、画像にマウスを乗せるたびに出す
  //   off   = 画像には使わない
  imageMode: 'alt',
  imageMin: 120, // これより小さい画像(幅px)は対象外。高さは幅の0.6倍まで許容
  buttons: { play: true, seek: true, time: true, mute: true, zoom: true, back: true },
};
