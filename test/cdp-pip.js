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
    await sleep(2500);
    console.log(`mode=${MODE}`);
    check('動画が再生中', (await main.ev('(()=>{const v=document.getElementById("v");return v.videoWidth>0&&!v.paused})()')) === true);
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

      for (let i = 0; i < 5; i++) { await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 60, y: 60, deltaX: 0, deltaY: -120 }); await sleep(80); }
      await sleep(300);
      const z1 = parseT(await p.ev('document.querySelector(".zoomer").style.transform'));
      check('ホイールでズームされる', !!z1 && z1.s > 2, JSON.stringify(z1));
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

      await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: 3000 });
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

    // 最大表示 (Alt+W) → Esc
    await main.send('Page.bringToFront');
    await hover(main, 390);
    await press(main, 'w', 'KeyW', 87, 1);
    await sleep(500);
    check('Alt+Wで最大表示(トップレイヤー)になる', (await main.ev('document.getElementById("v").matches(":popover-open")')) === true);
    await press(main, 'Escape', 'Escape', 27);
    await sleep(500);
    check('Escで最大表示が解除され元のstyleに戻る', (await main.ev('document.getElementById("v").hasAttribute("popover")')) === false && (await main.ev(VSTATE)) === before);
  } catch (e) {
    console.log('ERR', e);
    failed++;
  }
  console.log(failed ? `\n${failed} 件失敗` : '\n全て成功');
  chrome.kill();
  server.close();
  process.exit(failed ? 1 : 0);
})();
