// Document PiP の実機テスト:  node test/cdp-pip.js [ext|direct]
//   ext    (既定) 拡張機能として --load-extension で読み込み、isolated world の content script を検証
//   direct content.js をページに直接読み込む（拡張ロードができない環境用）
// headful の Chrome を起動し、CDP の本物の入力（ユーザー操作扱い）で Alt+P を押す。失敗時は非ゼロ終了。
const { spawn } = require('child_process');
const http = require('http');
const path = require('path'), fs = require('fs'), os = require('os');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MODE = process.argv[2] || 'ext';
const ROOT = path.resolve(__dirname, '..');
const PORT = 9333, HTTP_PORT = 8765;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let extId = null;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
  if (!cond) failed++;
};

// localhost は secure context（Document PiP が使える）。file:// だと拡張のファイルアクセス許可が要るのでhttpで配信
const server = http
  .createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0].split('#')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  })
  .listen(HTTP_PORT, '127.0.0.1');

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));
const args = [
  `--user-data-dir=${prof}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', '--window-size=900,760',
];
if (MODE === 'ext') args.push('--enable-unsafe-extension-debugging', '--remote-allow-origins=*');
args.push(`http://127.0.0.1:${HTTP_PORT}/test/pip-test.html${MODE === 'direct' ? '#direct' : ''}`);
const chrome = spawn(CHROME, args, { stdio: 'ignore' });

async function conn(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const cb = new Map();
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && cb.has(d.id)) { cb.get(d.id)(d); cb.delete(d.id); }
    else if (process.env.DEBUG && (d.method === 'Runtime.exceptionThrown' || d.method === 'Runtime.consoleAPICalled')) console.log('  [console]', JSON.stringify(d.params).slice(0, 400));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; cb.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result.exceptionDetails ? 'EXC:' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) : r.result.result.value;
  };
  if (process.env.DEBUG) send('Runtime.enable');
  return { send, ev };
}
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page');
const key = async (c, type, k, code, vk, modifiers = 0) => c.send('Input.dispatchKeyEvent', { type, modifiers, key: k, code, windowsVirtualKeyCode: vk });
const press = async (c, k, code, vk, modifiers = 0) => { await key(c, 'rawKeyDown', k, code, vk, modifiers); await key(c, 'keyUp', k, code, vk, modifiers); };
const parseT = (t) => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(t || '');
  return m ? { x: +m[1], y: +m[2], s: +m[3] } : null;
};
// ツールバー(=hover検出済み)が出るまでマウスを動かして待つ
async function hover(c, x) {
  for (let i = 0; i < 20; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (i % 2), y: 340 });
    await sleep(250);
    if ((await c.ev('!!document.querySelector("[data-videodock]")')) === true) return true;
  }
  return false;
}
// 右ボタンを押しながらホイール
async function rwheel(c, x, y, dy, n = 1) {
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  for (let i = 0; i < n; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, buttons: 2 }); await sleep(80); }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
}
const wheel = (c, x, y, dy) => c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
const VSTATE = '(()=>{const v=document.getElementById("v");return v?JSON.stringify([v.style.cssText,v.controls,v.parentNode.tagName]):"null"})()';

(async () => {
  try {
    let t;
    for (let i = 0; i < 40 && !t; i++) { await sleep(500); try { t = (await targets()).find((x) => x.url.includes('pip-test')); } catch (_) {} }
    if (!t) throw new Error('テストページに接続できません');
    if (MODE === 'ext') {
      // 新しいChromeは --load-extension を無視するので、CDPの Extensions.loadUnpacked で読み込む
      const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      const br = await conn(ver.webSocketDebuggerUrl);
      const r = await br.send('Extensions.loadUnpacked', { path: ROOT.split(path.sep).join('/') });
      console.log('loadUnpacked:', JSON.stringify(r.result || r.error));
      extId = r.result && r.result.id;
      const pg = await conn(t.webSocketDebuggerUrl);
      await pg.send('Page.reload');
      await sleep(1500);
    }
    const main = await conn(t.webSocketDebuggerUrl);
    await main.send('Page.bringToFront');
    for (let i = 0; i < 40 && (await main.ev('!!window.__ready')) !== true; i++) await sleep(500); // テスト動画の録画完了待ち
    await sleep(500);
    console.log(`mode=${MODE}`);
    check('動画が再生中(長さのある動画)', (await main.ev('(()=>{const v=document.getElementById("v");return v.videoWidth>0&&!v.paused&&isFinite(v.duration)&&v.duration>6})()')) === true);
    check('documentPictureInPicture が使える(secure)', (await main.ev('!!window.documentPictureInPicture')) === true);

    const before = await main.ev(VSTATE);
    for (let round = 1; round <= 2; round++) {
      console.log(`--- round ${round} (${round === 1 ? 'PiP内でAlt+Pで閉じる' : '「タブに戻す」ボタンで閉じる'}) ---`);
      await hover(main, 380 + round);
      await press(main, 'p', 'KeyP', 80, 1);
      let pt;
      for (let i = 0; i < 10 && !pt; i++) { await sleep(400); pt = (await targets()).find((x) => !x.url.includes('pip-test')); }
      check('Alt+PでPiP窓が開く', !!pt);
      if (!pt) break;
      check('opener側 documentPictureInPicture.window がある', (await main.ev('!!documentPictureInPicture.window')) === true);
      const p = await conn(pt.webSocketDebuggerUrl);
      await sleep(500);
      check('<video>がPiP窓へ移動している', (await p.ev('!!document.querySelector(".stage video")')) === true);
      check('移動後も再生が続いている', (await p.ev('!document.querySelector("video").paused')) === true);
      check('PiP窓にスタイルが適用されている', (await p.ev('getComputedStyle(document.querySelector(".stage")).position')) === 'fixed');

      // 操作バーは既定(下端に近づいたときだけ)なので、開いた直後・中央では出ない
      const mv = (y, x = 400) => p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      const uiShown = () => p.ev('document.querySelector(".ui").classList.contains("show")');
      check('開いた直後は操作バーが出ない(既定: edge)', (await uiShown()) === false);
      check('開いた直後に操作ヒントが出ない', (await p.ev('document.querySelector(".hint").classList.contains("show")')) === false);
      await mv(300); await sleep(200);
      check('窓の中央でマウスを動かしても出ない', (await uiShown()) === false);
      await mv(700); await sleep(250);
      check('下端に近づくと出る', (await uiShown()) === true);
      await mv(300); await sleep(250);
      check('下端から離れると消える', (await uiShown()) === false);
      await press(p, 'h', 'KeyH', 72); await sleep(150);
      check('Hキーで固定表示', (await uiShown()) === true);
      await press(p, 'h', 'KeyH', 72); await sleep(150);
      check('もう一度Hキーで隠れる', (await uiShown()) === false);

      // --- ホイール: 上部=音量 / 下部=シーク / 中央=何もしない（動画を止めて決定的に検証）---
      const vs = () => p.ev('(()=>{const e=document.querySelector("video");return {vol:Math.round(e.volume*100)/100,t:e.currentTime,d:e.duration,z:document.querySelector(".zoomer").style.transform}})()');
      await p.ev('(()=>{const e=document.querySelector("video");e.pause();e.muted=false;e.volume=0.5;e.currentTime=1;return 1})()');
      await sleep(300);
      let a = await vs();
      await wheel(p, 400, 360, -100); await sleep(150);
      let b = await vs();
      check('中央部の通常ホイールは何もしない(音量/時間/ズーム不変)', b.vol === a.vol && Math.abs(b.t - a.t) < 0.05 && b.z === a.z, JSON.stringify([a, b]));
      await wheel(p, 400, 60, -100); await sleep(150);
      b = await vs();
      check('上部でホイール上 = 音量UP', b.vol === 0.55, JSON.stringify(b));
      await wheel(p, 400, 60, 100); await wheel(p, 400, 60, 100); await sleep(150);
      b = await vs();
      check('上部でホイール下 = 音量DOWN', b.vol === 0.45, JSON.stringify(b));
      a = b;
      await wheel(p, 400, 680, -100); await sleep(250);
      b = await vs();
      check('下部でホイール上 = 5秒進む', Math.abs(b.t - (a.t + 5)) < 0.3 || b.t >= b.d - 0.3, `${a.t} -> ${b.t}`);
      check('下部のホイールでは音量が変わらない', b.vol === a.vol);
      a = b;
      await wheel(p, 400, 680, 100); await sleep(250);
      b = await vs();
      check('下部でホイール下 = 戻る', b.t < a.t - 3, `${a.t} -> ${b.t}`);
      check('PiP窓のコンテキストメニューは抑止される', (await p.ev('(()=>{const e=new MouseEvent("contextmenu",{cancelable:true,bubbles:true});document.body.dispatchEvent(e);return e.defaultPrevented})()')) === true);
      await p.ev('document.querySelector("video").play()');

      await rwheel(p, 60, 60, -120, 5);
      await sleep(300);
      const z1 = parseT(await p.ev('document.querySelector(".zoomer").style.transform'));
      check('右クリック+ホイールでズームされる', !!z1 && z1.s > 2, JSON.stringify(z1));
      check('ズーム%表示が一致', (await p.ev('document.querySelector(".zoom").textContent')) === Math.round((z1 ? z1.s : 0) * 100) + '%');

      // サイトのプレーヤーがstyleを書き換えたり<video>を動かしても、ズームが保たれること
      await main.ev('(()=>{__v.style.cssText="width:10px;height:10px;transform:rotate(5deg);position:static";__v.setAttribute("class","reset");return 1})()');
      await sleep(400);
      check('サイトのstyle書き換え後もズームが保たれる', (await p.ev('document.querySelector(".zoomer").style.transform')) === (z1 && `translate(${z1.x}px, ${z1.y}px) scale(${z1.s})`));
      check('サイトのstyle書き換え後も<video>が窓いっぱい', (await p.ev('(()=>{const e=document.querySelector("video");return e.style.width==="100%"&&e.style.position==="absolute"&&e.style.transform==="none"})()')) === true);
      await main.ev('(()=>{__v.remove();document.body.append(__v);return 1})()');
      await sleep(400);
      check('サイトが<video>を動かしてもPiP窓へ戻される', (await p.ev('!!document.querySelector(".zoomer video")')) === true);
      await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 300, button: 'left', clickCount: 1 });
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 240, y: 300, button: 'left' });
      await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 240, y: 300, button: 'left', clickCount: 1 });
      await sleep(400);
      const z2 = parseT(await p.ev('document.querySelector(".zoomer").style.transform'));
      check('ドラッグでパンされる(x方向 -60px)', !!z1 && !!z2 && Math.abs(z2.x - (z1.x - 60)) < 0.5, `${z1 && z1.x} -> ${z2 && z2.x}`);
      check('ドラッグ後に再生状態が変わらない', (await p.ev('!document.querySelector("video").paused')) === true);

      await rwheel(p, 300, 300, 3000);
      await sleep(300);
      check('縮小で100%(transform none)に戻る', (await p.ev('document.querySelector(".zoomer").style.transform')) === 'none');

      if (MODE === 'ext' && round === 1 && extId) {
        // 設定ページで変更 → 開いているPiP窓へ即反映
        const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/options.html`, { method: 'PUT' })).json();
        const op = await conn(created.webSocketDebuggerUrl);
        await sleep(800);
        check('設定ページの既定値が表示される(edge)', (await op.ev('document.querySelector("input[name=uiMode]:checked").value')) === 'edge');
        await op.ev('chrome.storage.sync.set({settings:{uiMode:"always",buttons:{mute:false,time:false}}})');
        await sleep(500);
        check('設定「常に表示」が開いているPiP窓へ反映', (await uiShown()) === true);
        check('設定でミュート/時間ボタンが非表示になる', (await p.ev('(()=>{const b=[...document.querySelectorAll(".ui button")].find(x=>x.title.startsWith("ミュート"));return b.hidden&&document.querySelector(".time").hidden&&!document.querySelector(".zoom").hidden})()')) === true);
        await op.ev('chrome.storage.sync.remove("settings")');
        await sleep(500);
        check('設定を既定に戻すと再び隠れ、ボタンも戻る', (await uiShown()) === false && (await p.ev('!document.querySelector(".time").hidden')) === true);
        // ホイールの入れ替え・反転
        const base = await p.ev('(()=>{const e=document.querySelector("video");e.pause();e.muted=false;e.volume=0.5;e.currentTime=1;return 1})()');
        await op.ev('chrome.storage.sync.set({settings:{wheelSwap:true}})');
        await sleep(400);
        await wheel(p, 400, 60, -100); await sleep(250);
        let sw = await vs();
        check('設定: 上下入れ替えで 上部=シーク(音量は不変)', sw.t > 5.5 && sw.vol === 0.5, JSON.stringify(sw));
        await p.ev('(()=>{const e=document.querySelector("video");e.currentTime=1;return 1})()');
        await wheel(p, 400, 680, -100); await sleep(150);
        sw = await vs();
        check('設定: 上下入れ替えで 下部=音量', sw.vol === 0.55 && sw.t < 1.5, JSON.stringify(sw));
        await op.ev('chrome.storage.sync.set({settings:{wheelInvert:true}})');
        await sleep(400);
        await p.ev('(()=>{const e=document.querySelector("video");e.volume=0.5;e.currentTime=1;return 1})()');
        await wheel(p, 400, 60, -100); await sleep(150);
        sw = await vs();
        check('設定: 反転で 上部のホイール上 = 音量DOWN', sw.vol === 0.45, JSON.stringify(sw));
        await p.ev('(()=>{const e=document.querySelector("video");e.currentTime=1;return 1})()');
        await wheel(p, 400, 680, -100); await sleep(250);
        sw = await vs();
        check('設定: 反転で 下部のホイール上 = 戻る(先頭でclamp)', sw.t < 1.2, JSON.stringify(sw));
        await op.ev('chrome.storage.sync.set({settings:{zoomInvert:true}})');
        await sleep(400);
        await rwheel(p, 300, 300, -120, 3); await sleep(250);
        check('設定: ズーム反転で 右クリック+ホイール上 = 縮小(100%のまま)', (await p.ev('document.querySelector(".zoomer").style.transform')) === 'none');
        await op.ev('chrome.storage.sync.remove("settings")');
        await sleep(400);
        await p.ev('document.querySelector("video").play()');
        await fetch(`http://127.0.0.1:${PORT}/json/close/${created.id}`);
      }

      if (round === 1) {
        await Promise.race([p.send('Page.bringToFront'), sleep(1000)]);
        // 窓が閉じるとCDP応答が返らないので待たない
        await Promise.race([press(p, 'p', 'KeyP', 80, 1), sleep(1500)]);
      } else {
        await Promise.race([p.ev('document.querySelector("button[title=\\"タブに戻す\\"]").click()'), sleep(1500)]);
      }
      await sleep(1200);
      check('PiP窓が閉じた', (await main.ev('!documentPictureInPicture.window')) === true);
      const after = await main.ev(VSTATE);
      check('<video>が元の位置に戻りstyle/controlsが完全に復元', after === before, after === before ? '' : `before=${before} after=${after}`);
      check('戻った後も再生が続いている', (await main.ev('(()=>{const v=document.getElementById("v");return v.ownerDocument===document&&v.isConnected&&!v.paused})()')) === true);
    }

    // --- 画像のPiP: Altを押しながら画像にホバー → Alt+P ---
    console.log('--- 画像PiP ---');
    await main.send('Page.bringToFront');
    await key(main, 'rawKeyDown', 'Alt', 'AltLeft', 18, 1);
    for (let i = 0; i < 8; i++) { await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 800 + (i % 2), y: 110, modifiers: 1 }); await sleep(200); }
    await press(main, 'p', 'KeyP', 80, 1);
    let ipt;
    for (let i = 0; i < 10 && !ipt; i++) { await sleep(400); ipt = (await targets()).find((x) => !x.url.includes('pip-test')); }
    check('Alt+ホバー→Alt+Pで画像のPiP窓が開く', !!ipt);
    if (ipt) {
      const ip = await conn(ipt.webSocketDebuggerUrl);
      await sleep(600);
      check('PiP窓に<img>が表示され、<video>は無い', (await ip.ev('!!document.querySelector(".zoomer img")&&!document.querySelector(".zoomer video")')) === true);
      check('画像が読み込まれている', (await ip.ev('document.querySelector(".zoomer img").naturalWidth')) === 800);
      check('画像モードでは再生/シーク/時間/ミュートのボタンが無い', (await ip.ev('[...document.querySelectorAll(".ui > *")].filter(e=>e.tagName==="BUTTON"||e.tagName==="INPUT"||e.className==="time").slice(0,4).every(e=>e.hidden)')) === true);
      const cx = Math.round((await ip.ev('innerWidth')) / 2), cy = Math.round((await ip.ev('innerHeight')) / 2);
      await wheel(ip, cx, cy, -100); await wheel(ip, cx, cy, -100); await sleep(250);
      const q1 = parseT(await ip.ev('document.querySelector(".zoomer").style.transform'));
      check('画像は通常のホイールでズームできる', !!q1 && q1.s > 1.2, JSON.stringify(q1));
      await rwheel(ip, cx, cy, -100, 2); await sleep(250);
      const q2 = parseT(await ip.ev('document.querySelector(".zoomer").style.transform'));
      check('右クリック+ホイールでもズームできる', !!q2 && !!q1 && q2.s > q1.s, JSON.stringify(q2));
      check('元のページの画像はそのまま残っている', (await main.ev('(()=>{const i=document.getElementById("im");return i.isConnected&&i.complete&&i.naturalWidth===800&&!i.hasAttribute("popover")})()')) === true);
      await Promise.race([press(ip, 'p', 'KeyP', 80, 1), sleep(1500)]);
      await sleep(1000);
      check('画像PiPをAlt+Pで閉じられる', (await main.ev('!documentPictureInPicture.window')) === true);
    }
    await key(main, 'keyUp', 'Alt', 'AltLeft', 18);

    // 最大表示 (Alt+W) → Esc
    await main.send('Page.bringToFront');
    await hover(main, 390);
    await press(main, 'w', 'KeyW', 87, 1);
    await sleep(500);
    check('Alt+Wで最大表示(トップレイヤー)になる', (await main.ev('document.getElementById("v").matches(":popover-open")')) === true);
    await press(main, 'Escape', 'Escape', 27);
    await sleep(500);
    check('Escで最大表示が解除され元のstyleに戻る', (await main.ev('document.getElementById("v").hasAttribute("popover")')) === false && (await main.ev(VSTATE)) === before);

    if (MODE === 'ext' && extId) {
      // --- ボタンの表示位置/トリガー/表示時間、画像トリガーのキー、拡張ボタン(background) ---
      console.log('--- ボタン設定 ---');
      const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/options.html`, { method: 'PUT' })).json();
      const op = await conn(created.webSocketDebuggerUrl);
      await sleep(800);
      const setS = async (o) => { await op.ev(`chrome.storage.sync.set({settings:${JSON.stringify(o)}})`); await sleep(500); };
      const hit = (x, y) => main.ev(`(()=>{const e=document.elementFromPoint(${x},${y});return !!e&&e.hasAttribute("data-videodock")})()`);
      const mv = async (x, y, n = 4) => { for (let i = 0; i < n; i++) { await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (i % 2), y }); await sleep(150); } };
      check('設定ページの既定値(右上/領域/キーAlt)', (await op.ev('[document.getElementById("barPos").value,document.querySelector("input[name=barTrigger]:checked").value,document.querySelector("input[name=imageMode]:checked").value,document.getElementById("imageKeyBox").value].join()')) === 'top-right,area,key,Alt');
      await op.send('Page.bringToFront');
      await op.ev('document.getElementById("imageKeyBox").focus()');
      await key(op, 'rawKeyDown', 'q', 'KeyQ', 81);
      await key(op, 'keyUp', 'q', 'KeyQ', 81);
      await sleep(500);
      check('設定ページでキーを押すとトリガーキーに登録される(Q)', (await op.ev('document.getElementById("imageKeyBox").value')) === 'Q' && (await op.ev('chrome.storage.sync.get("settings").then(r=>r.settings.imageKey)')) === 'KeyQ');
      await op.ev('chrome.storage.sync.remove("settings")');
      await sleep(400);
      await main.send('Page.bringToFront');
      // 映像の描画領域は x:60..700, y:160..520（レターボックスを除く）
      await setS({ barPos: 'bottom-left', barHideMs: 0 });
      await mv(380, 340, 6);
      check('左下に表示される', (await hit(60 + 10 + 15, 520 - 10 - 15)) === true);
      check('右上には表示されない', (await hit(700 - 10 - 15, 160 + 10 + 15)) === false);
      await sleep(3200);
      check('表示時間0: 領域内にいる間は隠れない', (await hit(60 + 10 + 15, 520 - 10 - 15)) === true);
      await mv(800, 580, 3);
      await sleep(500);
      check('領域から出ると隠れる', (await hit(60 + 10 + 15, 520 - 10 - 15)) === false);

      await setS({ barPos: 'top-right', barTrigger: 'near', barNear: 40, barHideMs: 700 });
      await mv(380, 340, 5);
      await sleep(300);
      check('近く判定: 領域に入っただけでは出ない', (await hit(700 - 10 - 15, 160 + 10 + 15)) === false);
      await mv(680, 200, 5);
      check('近く判定: ボタンの近くへ行くと出る', (await hit(700 - 10 - 15, 160 + 10 + 15)) === true);
      await mv(380, 340, 3);
      await sleep(1300);
      check('表示時間(700ms)後に隠れる', (await hit(700 - 10 - 15, 160 + 10 + 15)) === false);

      // 画像: キーを Z に変更 → Zを押している間だけ出る
      await setS({ imageMode: 'key', imageKey: 'KeyZ' });
      const ir = JSON.parse(await main.ev('JSON.stringify(document.getElementById("im").getBoundingClientRect())'));
      const ix = Math.round(ir.right - 25), iy = Math.round(ir.top + 25);
      await mv(Math.round(ir.left + 40), Math.round(ir.top + 50), 6);
      await sleep(300);
      check('画像: キー(Z)を押していないと出ない', (await hit(ix, iy)) === false);
      await key(main, 'rawKeyDown', 'z', 'KeyZ', 90);
      await sleep(400);
      check('画像: キー(Z)を押すと出る', (await hit(ix, iy)) === true);
      await key(main, 'keyUp', 'z', 'KeyZ', 90);
      await sleep(3300);
      await setS({ imageMode: 'always', barHideMs: 2500 });
      await mv(Math.round(ir.left + 40), Math.round(ir.top + 50), 6);
      await sleep(300);
      check('画像: キー不要モードではホバーだけで出る', (await hit(ix, iy)) === true);
      await setS({ imageMode: 'off' });
      await sleep(3300);
      await mv(Math.round(ir.left + 30), Math.round(ir.top + 40), 6);
      check('画像: オフでは出ない', (await hit(ix, iy)) === false);
      await op.ev('chrome.storage.sync.remove("settings")');

      check('拡張ボタン(action)とbackgroundが定義されている', (await op.ev('(()=>{const m=chrome.runtime.getManifest();return m.background.service_worker==="background.js"&&!!m.action&&!m.action.default_popup})()')) === true);
    }
  } catch (e) {
    console.log('ERR', e);
    failed++;
  }
  console.log(failed ? `\n${failed} 件失敗` : '\n全て成功');
  chrome.kill();
  server.close();
  process.exit(failed ? 1 : 0);
})();
