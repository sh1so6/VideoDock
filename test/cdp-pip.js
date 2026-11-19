// Document PiP の実機自動テスト: node test/cdp-pip.js
// headfulのChromeを起動し、CDPで本物の入力(ユーザー操作)を送ってAlt+Pを押す
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const page = 'file:///' + path.resolve(__dirname, 'pip-test.html').split(path.sep).join('/');
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [`--user-data-dir=${prof}`, `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--window-size=900,760', page], { stdio: 'ignore' });
async function conn(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const cb = new Map();
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && cb.has(d.id)) { cb.get(d.id)(d); cb.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; cb.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? 'EXC:' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) : r.result.result.value; };
  return { send, ev, ws };
}
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page');
(async () => {
  try {
    let t; for (let i = 0; i < 40 && !t; i++) { await sleep(500); try { t = (await targets()).find((x) => x.url.includes('pip-test')); } catch (_) {} }
    const main = await conn(t.webSocketDebuggerUrl);
    await main.send('Page.bringToFront');
    await sleep(1500);
    console.log('video playing:', await main.ev('(()=>{const v=document.getElementById("v");return [v.videoWidth,!v.paused,!!window.documentPictureInPicture,window.isSecureContext].join(",")})()'));
    await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 380, y: 340 });
    await sleep(500);
    console.log('toolbar host:', await main.ev('!!document.querySelector("[data-videodock]")'), ' loaded:', await main.ev('!!window.__videoDockLoaded'));
    // Alt+P (本物のキー入力 → ユーザーアクティベーション付き)
    const key = (type) => main.send('Input.dispatchKeyEvent', { type, modifiers: 1, key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
    await key('rawKeyDown'); await key('keyUp');
    await sleep(2000);
    console.log('toast/err:', await main.ev('document.title'));
    const ts = await targets();
    console.log('targets:', ts.map((x) => x.title + ' | ' + x.url.slice(0, 40)));
    console.log('main: pipWindow=', await main.ev('!!documentPictureInPicture.window'),
      ' video.ownerDocument is main=', await main.ev('document.getElementById("v").ownerDocument===document'));
    const pt = ts.find((x) => !x.url.includes('pip-test'));
    if (pt) {
      const p = await conn(pt.webSocketDebuggerUrl);
      console.log('pip: video inside=', await p.ev('!!document.querySelector(".stage video")'),
        ' paused=', await p.ev('document.querySelector("video").paused'),
        ' size=', await p.ev('innerWidth+"x"+innerHeight'));
      const shot = async (name) => { const r = await p.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64')); };
      await shot('pip-1.png');
      // ホイールでズーム (カーソル左上寄り)
      for (let i = 0; i < 5; i++) { await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 60, y: 60, deltaX: 0, deltaY: -120 }); await sleep(80); }
      await sleep(300);
      console.log('zoom label:', await p.ev('document.querySelector(".zoom").textContent'),
        ' transform:', await p.ev('document.querySelector("video").style.transform'));
      await shot('pip-2.png');
      // ドラッグでパン
      await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 });
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 160, y: 140, button: 'left' });
      await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 160, y: 140, button: 'left', clickCount: 1 });
      await sleep(300);
      console.log('after pan transform:', await p.ev('document.querySelector("video").style.transform'));
      await shot('pip-3.png');
      // 閉じて戻る
      await p.ev('document.querySelector("button[title=\\"タブに戻す\\"]").click()');
      await sleep(1000);
      console.log('after close: video back in page=', await main.ev('document.getElementById("v").ownerDocument===document && document.getElementById("v").isConnected'),
        ' playing=', await main.ev('!document.getElementById("v").paused'),
        ' style=', await main.ev('document.getElementById("v").style.cssText'));
    }
  } catch (e) { console.log('ERR', e); }
  chrome.kill(); process.exit(0);
})();
