/* VideoDock content script
 * 動画上に「PiP（ズーム・パン可）」と「ウィンドウ内最大表示」のボタンを表示する。
 *  - PiP: Document Picture-in-Picture に<video>を移し、PiPウィンドウ側でズーム/パン/操作を行う
 *         （非対応・iframe内・失敗時は標準PiPにフォールバック。標準PiPはズーム不可）
 *  - 最大表示: Popover API でトップレイヤーへ出して 100vw×100vh に
 */
(() => {
  'use strict';
  if (window.__videoDockLoaded) return;
  // Document PiP のウィンドウ(トップレベルのabout:blank)には拡張機能が自動注入されるが、
  // そこで二重に動くと操作を横取りするため何もしない
  if (window === window.top && location.protocol === 'about:') return;
  window.__videoDockLoaded = true;

  // ---------- 定数 ----------
  const MIN_W = 240;
  const MIN_H = 135;
  const MAX_ZOOM = 8;
  const ZOOM_STEP = 1.25;
  const BELOW_BAR_H = 40; // PiP窓: 操作バーを動画の下に置くモードの高さ(px)
  const HOTKEY_ACTIVE_MS = 10000;
  const MSG = '__videodock__';
  const SUPPORTS_POPOVER = typeof HTMLElement.prototype.showPopover === 'function';

  const WIDE_STYLE = {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    'max-width': 'none',
    'max-height': 'none',
    'min-width': '0',
    'min-height': '0',
    margin: '0',
    padding: '0',
    border: '0',
    'box-sizing': 'border-box',
    background: '#000',
    'object-fit': 'contain',
    overflow: 'hidden',
    'z-index': '2147483647',
  };
  const WIDE_PROPS = Object.keys(WIDE_STYLE);

  // ---------- 状態 ----------
  const videos = new Set();
  const images = new Set(); // 画像PiP用（imageMode が off 以外のとき対象）
  let keyDown = false; // 画像トリガーのキー(settings.imageKey)を押している間 true
  const addedControls = new WeakSet(); // 最大化のために controls を足した video
  const wideEls = new Set(); // 最大化中の video / iframe
  let active = null;
  let lastActivity = 0;
  let toolbarHover = false;
  let lastPt = { x: 0, y: 0 };
  let pip = null; // Document PiP のセッション {win, v, close}

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  // ---------- 設定（options ページで変更。chrome.storage.sync） ----------
  const DEFAULTS = VIDEODOCK_DEFAULTS;
  let settings = videodockMerge();
  function mergeSettings(saved) {
    settings = videodockMerge(saved);
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get('settings').then((r) => mergeSettings(r.settings)).catch(() => {});
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'sync' || !ch.settings) return;
        mergeSettings(ch.settings.newValue);
        if (pip && pip.applySettings) pip.applySettings();
        applyPageSettings();
      });
    }
  } catch (_) {}

  // ---------- インラインstyleの保存・復元（最大化用） ----------
  const savedStyles = new WeakMap();
  function setImp(el, props) {
    let m = savedStyles.get(el);
    if (!m) savedStyles.set(el, (m = new Map()));
    for (const [k, v] of Object.entries(props)) {
      if (!m.has(k)) m.set(k, [el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]);
      el.style.setProperty(k, v, 'important');
    }
  }
  function restoreProps(el, keys) {
    const m = savedStyles.get(el);
    if (!m) return;
    for (const k of keys) {
      if (!m.has(k)) continue;
      const [v, p] = m.get(k);
      if (v) el.style.setProperty(k, v, p);
      else el.style.removeProperty(k);
      m.delete(k);
    }
  }

  // ---------- 映像の描画領域 ----------
  // object-fit: contain で W×H に収めたときの映像領域
  function containRect(vw, vh, W, H) {
    if (!vw || !vh) return { x: 0, y: 0, w: W, h: H };
    const k = Math.min(W / vw, H / vh);
    const w = vw * k;
    const h = vh * k;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  // ページ内の<video>について、object-fit/positionを考慮した映像領域(画面座標)
  function geom(v) {
    if (v.ownerDocument !== document) return null;
    const W = v.offsetWidth;
    const H = v.offsetHeight;
    if (!W || !H) return null;
    const r = v.getBoundingClientRect();
    const k = r.width / W || 1;
    const vw = v.videoWidth || v.naturalWidth;
    const vh = v.videoHeight || v.naturalHeight;
    let c = { x: 0, y: 0, w: W, h: H };
    if (vw && vh) {
      const cs = getComputedStyle(v);
      let w, h;
      switch (cs.objectFit) {
        case 'fill': w = W; h = H; break;
        case 'cover': { const s = Math.max(W / vw, H / vh); w = vw * s; h = vh * s; break; }
        case 'none': w = vw; h = vh; break;
        case 'scale-down': { const s = Math.min(1, W / vw, H / vh); w = vw * s; h = vh * s; break; }
        default: { const s = Math.min(W / vw, H / vh); w = vw * s; h = vh * s; }
      }
      const pos = (cs.objectPosition || '50% 50%').split(/\s+/);
      const off = (tok, free) => {
        const n = parseFloat(tok);
        if (!tok || Number.isNaN(n)) return free / 2;
        return tok.endsWith('%') ? (free * n) / 100 : n;
      };
      c = { x: off(pos[0], W - w), y: off(pos[1], H - h), w, h };
    }
    const left = r.left + k * c.x;
    const top = r.top + k * c.y;
    return { left, top, width: k * c.w, height: k * c.h, right: left + k * c.w, bottom: top + k * c.h };
  }

  function isCandidate(v) {
    if (!v.isConnected || v.ownerDocument !== document) return false;
    if (v.tagName === 'IMG') {
      if (!v.complete || !v.naturalWidth) return false;
      const r = v.getBoundingClientRect();
      if (r.width < settings.imageMin || r.height < settings.imageMin * 0.6) return false;
      if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
      return getComputedStyle(v).visibility !== 'hidden';
    }
    if (v.readyState >= 1 && v.videoWidth === 0) return false; // 音声のみ
    const g = geom(v);
    if (!g || g.width < MIN_W || g.height < MIN_H) return false;
    if (g.bottom < 0 || g.right < 0 || g.top > innerHeight || g.left > innerWidth) return false;
    return getComputedStyle(v).visibility !== 'hidden';
  }

  function pickVideo(pt) {
    for (const el of wideEls) if (el.tagName === 'VIDEO') return el; // 最大化中はそれが最優先
    let best = null;
    let bestArea = Infinity;
    for (const v of videos) {
      if (!isCandidate(v)) continue;
      const r = geom(v);
      if (pt.x < r.left || pt.x > r.right || pt.y < r.top || pt.y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  // 画像は数が多いので、既定ではキー(Alt)を押しながらホバーしたときだけ対象にする（settings.imageMode / imageKey）
  const MODIFIER_KEYS = ['Alt', 'Control', 'Shift', 'Meta'];
  const isImageKey = (e) => e.key === settings.imageKey || e.code === settings.imageKey;
  const imagesAllowed = () => settings.imageMode === 'always' || (settings.imageMode === 'key' && keyDown);
  function pickImage(pt) {
    let best = null;
    let bestArea = Infinity;
    for (const im of images) {
      if (!im.isConnected) continue;
      const r = im.getBoundingClientRect();
      if (pt.x < r.left || pt.x > r.right || pt.y < r.top || pt.y > r.bottom) continue;
      if (!isCandidate(im)) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        best = im;
        bestArea = area;
      }
    }
    return best;
  }
  const pickTarget = (pt) => pickVideo(pt) || (imagesAllowed() ? pickImage(pt) : null);

  // ---------- ウィンドウ内最大化（Popover APIでトップレイヤーへ） ----------
  function enterWide(el) {
    if (wideEls.has(el)) return true;
    if (!SUPPORTS_POPOVER) {
      toast('このブラウザは最大化に未対応です (Chrome 114+)');
      return false;
    }
    try {
      el.setAttribute('popover', 'manual');
      setImp(el, WIDE_STYLE);
      el.showPopover();
    } catch (e) {
      el.removeAttribute('popover');
      restoreProps(el, WIDE_PROPS);
      toast('最大化に失敗しました');
      return false;
    }
    wideEls.add(el);
    if (el.tagName === 'VIDEO') {
      if (!el.controls) {
        el.controls = true; // サイト独自UIはトップレイヤーの背面になるので標準UIを出す
        addedControls.add(el);
      }
      if (window.parent !== window) {
        window.parent.postMessage({ [MSG]: true, type: 'wide-frame', on: true }, '*');
      }
    }
    bringToolbarToFront();
    refreshBar();
    return true;
  }

  // origin: 'user' | 'parent' | 'child'
  function exitWide(el, origin = 'user') {
    if (!wideEls.has(el)) return;
    wideEls.delete(el);
    try {
      el.hidePopover();
    } catch (_) {}
    el.removeAttribute('popover');
    restoreProps(el, WIDE_PROPS);
    if (el.tagName === 'VIDEO') {
      if (addedControls.has(el)) {
        el.controls = false;
        addedControls.delete(el);
      }
      if (origin !== 'parent' && window.parent !== window) {
        window.parent.postMessage({ [MSG]: true, type: 'wide-frame', on: false }, '*');
      }
    } else if (el.tagName === 'IFRAME') {
      if (origin !== 'child') {
        try {
          el.contentWindow.postMessage({ [MSG]: true, type: 'exit-wide' }, '*');
        } catch (_) {}
      } else if (window.parent !== window) {
        window.parent.postMessage({ [MSG]: true, type: 'wide-frame', on: false }, '*');
      }
    }
    refreshBar();
  }

  // 最大化中のホイール: 背面のページをスクロールさせず、PiP窓と同じく上部=音量 / 下部=シーク（割り当て・範囲・向き・ステップは同じ設定）
  let wideOsd = null;
  let wideOsdTimer = 0;
  function showWideOsd(text) {
    if (!wideOsd) {
      wideOsd = document.createElement('div');
      wideOsd.setAttribute('data-videodock', '');
      if (SUPPORTS_POPOVER) wideOsd.setAttribute('popover', 'manual');
      wideOsd.style.cssText =
        'position:fixed!important;inset:auto!important;left:50%!important;top:16px!important;transform:translateX(-50%)!important;' +
        'margin:0!important;padding:6px 12px!important;border:0!important;border-radius:8px!important;background:rgba(20,20,26,.85)!important;' +
        'color:#fff!important;font:14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif!important;pointer-events:none!important;' +
        'z-index:2147483647!important;width:auto!important;height:auto!important;overflow:visible!important;';
      document.documentElement.appendChild(wideOsd);
    }
    wideOsd.textContent = text;
    try {
      if (SUPPORTS_POPOVER) {
        if (wideOsd.matches(':popover-open')) wideOsd.hidePopover(); // 出し直して最前面に
        wideOsd.showPopover();
      }
    } catch (_) {}
    clearTimeout(wideOsdTimer);
    wideOsdTimer = setTimeout(() => {
      try {
        if (SUPPORTS_POPOVER && wideOsd.matches(':popover-open')) wideOsd.hidePopover();
      } catch (_) {}
    }, 900);
  }

  window.addEventListener(
    'wheel',
    (e) => {
      if (!wideEls.size || e.ctrlKey) return; // Ctrl+ホイール（ブラウザのズーム）は触らない
      e.preventDefault(); // 背面のページをスクロールさせない（iframe最大化の親側も含む）
      const v = [...wideEls].find((el) => el.tagName === 'VIDEO');
      if (!v || !v.isConnected) return;
      const unit = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100;
      if (unit === 0) return;
      const h = innerHeight;
      const zone = h * (settings.wheelZone / 100);
      const inTop = e.clientY <= zone;
      const inBottom = e.clientY >= h - zone;
      if (!inTop && !inBottom) return;
      const n = (settings.wheelInvert ? 1 : -1) * unit;
      if (inTop === !settings.wheelSwap) {
        const vol = clamp((v.muted ? 0 : v.volume) + (n * settings.volumeStep) / 100, 0, 1);
        if (vol > 0) v.muted = false;
        v.volume = vol;
        showWideOsd(`🔊 音量 ${Math.round(vol * 100)}%`);
      } else {
        const d = v.duration;
        if (!isFinite(d) || d <= 0) return showWideOsd('ライブ配信はシークできません');
        const t = clamp(v.currentTime + n * settings.seekStep, 0, d);
        v.currentTime = t;
        const f = (x) => {
          x = Math.floor(x);
          const hh = Math.floor(x / 3600);
          const mm = Math.floor((x % 3600) / 60);
          const ss = String(x % 60).padStart(2, '0');
          return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
        };
        showWideOsd(`${n > 0 ? '⏩' : '⏪'} ${f(t)} / ${f(d)}`);
      }
    },
    { passive: false, capture: true }
  );

  const exitAllWide = (origin) => [...wideEls].forEach((el) => exitWide(el, origin));
  const toggleWide = (v) => (wideEls.has(v) ? exitWide(v) : enterWide(v));

  // 親フレーム側: 子iframeの「最大化」要求を受けてiframe自体を最大化する
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d[MSG] !== true) return;
    if (d.type === 'exit-wide') {
      if (e.source === window.parent) exitAllWide('parent');
      return;
    }
    if (d.type !== 'wide-frame') return;
    const iframe = [...document.querySelectorAll('iframe')].find((f) => f.contentWindow === e.source);
    if (!iframe) return;
    if (d.on) {
      // 子フレームでのクリック等のユーザー操作は祖先フレームにも伝播する。なりすまし対策。
      if (!navigator.userActivation || !navigator.userActivation.isActive) return;
      enterWide(iframe);
    } else {
      exitWide(iframe, 'child');
    }
  });

  // ---------- PiP ----------
  const docPipSupported = () =>
    'documentPictureInPicture' in window && window.isSecureContext && window === window.top;

  // 標準PiP（ズーム不可）
  async function stdPip(v) {
    try {
      if (document.pictureInPictureElement === v) {
        await document.exitPictureInPicture();
        return;
      }
      v.removeAttribute('disablepictureinpicture');
      v.disablePictureInPicture = false;
      await v.requestPictureInPicture();
    } catch (e) {
      toast('PiPを開始できません: ' + (e && e.message ? e.message : e));
    }
  }

  // ユーザー操作(クリック/キー)の同期区間内で requestWindow を呼ぶこと（先にawaitしない）
  async function togglePip(v) {
    if (pip) {
      pip.close();
      return;
    }
    const isImg = v.tagName === 'IMG';
    if (!isImg && document.pictureInPictureElement === v) return stdPip(v);
    if (!docPipSupported()) {
      if (isImg) return toast('画像のPiPは、最上位のページ内の画像のみ対応です');
      return stdPip(v);
    }
    if (wideEls.has(v)) exitWide(v);

    const g = geom(v);
    const width = clamp(Math.round(g ? g.width : 480), 360, 960);
    const vw = (isImg ? v.naturalWidth : v.videoWidth) || 16;
    const vh = (isImg ? v.naturalHeight : v.videoHeight) || 9;
    const height = clamp(Math.round((width * vh) / vw), 200, 720) + (settings.uiMode === 'below' ? BELOW_BAR_H : 0);
    let win;
    try {
      win = await window.documentPictureInPicture.requestWindow({ width, height });
    } catch (e) {
      toast('PiPウィンドウを開けません: ' + (e && e.message ? e.message : e));
      return;
    }
    try {
      pip = buildPip(win, v);
    } catch (e) {
      console.error('[VideoDock] PiP構築に失敗', e);
      try { win.close(); } catch (_) {}
      pip = null;
      toast('PiPの構築に失敗しました');
    }
    refreshBar();
  }

  const PIP_CSS = `
      html,body{margin:0;height:100%;background:#000;overflow:hidden;color:#fff;
        font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none}
      .stage{position:fixed;inset:0;overflow:hidden;background:#000;touch-action:none}
      .zoomer{position:absolute;inset:0;transform-origin:0 0}
      .stage.zoomed{cursor:grab}.stage.panning{cursor:grabbing}
      .ui{position:fixed;left:0;right:0;bottom:0;display:flex;align-items:center;gap:2px;
        padding:22px 8px 6px;background:linear-gradient(transparent,rgba(0,0,0,.8));
        opacity:0;transition:opacity .2s;pointer-events:none}
      .ui.show{opacity:1;pointer-events:auto}
      /* 動画の下に常設するモード: 動画の表示領域(.stage)を操作バーの分だけ縮め、重ならないようにする */
      body.below .stage{bottom:${BELOW_BAR_H}px}
      body.below .ui{height:${BELOW_BAR_H}px;box-sizing:border-box;padding:0 8px;background:#15151a;opacity:1;pointer-events:auto;transition:none}
      button{all:unset;box-sizing:border-box;min-width:28px;height:28px;display:grid;place-items:center;
        border-radius:6px;cursor:pointer;font-size:14px;color:#fff}
      button:hover{background:rgba(255,255,255,.2)}
      button:focus-visible{outline:2px solid #60a5fa}
      .zoom{font-size:12px;min-width:46px;font-variant-numeric:tabular-nums}
      .time{font-size:11px;padding:0 4px;font-variant-numeric:tabular-nums;white-space:nowrap;opacity:.9}
      .seek{flex:1;min-width:40px;margin:0 4px;accent-color:#3b82f6;height:14px}
      .sep{width:1px;height:16px;background:rgba(255,255,255,.3);margin:0 4px}
      .hint{position:fixed;top:8px;left:8px;padding:4px 8px;border-radius:6px;background:rgba(0,0,0,.6);
        opacity:0;transition:opacity .2s;pointer-events:none}
      .hint.show{opacity:1}
      .osd{position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:6px 14px;border-radius:8px;
        background:rgba(0,0,0,.72);font-size:14px;font-variant-numeric:tabular-nums;opacity:0;
        transition:opacity .15s;pointer-events:none;white-space:nowrap}
      .osd.show{opacity:1}
      [hidden]{display:none!important}
    `;

  // PiPウィンドウ内のUIとズーム/パン。<video>の移動は同期的に行うこと（awaitを挟むとpauseされる）。<video>を移し、閉じたら元へ戻す。
  function buildPip(win, v) {
    const doc = win.document;
    const mk = (tag, props, ...kids) => {
      const n = doc.createElement(tag);
      if (props) Object.assign(n, props);
      n.append(...kids);
      return n;
    };

    // 別realmのCSSStyleSheetをadoptできない/CSPで弾かれる場合に備え、両方式を試す
    try {
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(PIP_CSS);
      doc.adoptedStyleSheets = [sheet];
    } catch (_) {
      const st = doc.createElement('style');
      st.textContent = PIP_CSS;
      doc.head.append(st);
    }
    doc.title = document.title || 'VideoDock';
    const isImg = v.tagName === 'IMG'; // 画像モード: 元の<img>は動かさず、複製をPiPに表示する
    const natSize = () => (isImg ? [v.naturalWidth, v.naturalHeight] : [v.videoWidth, v.videoHeight]);

    const stage = mk('div', { className: 'stage' });
    const zoomer = mk('div', { className: 'zoomer' }); // ズームはこの専用要素のtransformで行う（サイトのstyle書き換えの影響を受けない）
    stage.append(zoomer);
    const hint = mk('div', { className: 'hint' });
    const osd = mk('div', { className: 'osd' });
    const btnPlay = mk('button', { title: '再生/一時停止 (Space)' });
    const seek = mk('input', { className: 'seek', type: 'range', min: 0, max: 1000, step: 1, value: 0 });
    const time = mk('span', { className: 'time' });
    const btnMute = mk('button', { title: 'ミュート (M)' });
    const btnOut = mk('button', { textContent: '−', title: '縮小 (-)' });
    const btnZoom = mk('button', { className: 'zoom', textContent: '100%', title: 'ズームをリセット (0)' });
    const btnIn = mk('button', { textContent: '+', title: '拡大 (+ / 右クリック+ホイール)' });
    const btnBack = mk('button', { textContent: '⤴', title: 'タブに戻す' });
    const sepA = mk('span', { className: 'sep' });
    const sepB = mk('span', { className: 'sep' });
    const ui = mk('div', { className: 'ui' }, btnPlay, seek, time, btnMute, sepA, btnOut, btnZoom, btnIn, sepB, btnBack);
    doc.body.append(stage, ui, hint, osd);

    // --- <video>を移す（画像の場合は複製を置く） ---
    let restored = false;
    const VIDEO_STYLE = {
      position: 'absolute', left: '0', top: '0', right: 'auto', bottom: 'auto', width: '100%', height: '100%',
      'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0', margin: '0', padding: '0',
      border: '0', 'box-sizing': 'border-box', 'object-fit': 'contain', 'object-position': '50% 50%',
      background: '#000', transform: 'none', 'clip-path': 'none', filter: 'none',
      visibility: 'visible', opacity: '1', display: 'block',
    };
    let el = v; // PiP内に置く要素
    let origCss, origControls, origParent, origNext, placeholder, wasPlaying, styleObserver;
    // サイトのプレーヤーが再生/リサイズのたびに<video>のstyleを書き換えても、毎回こちらの値へ戻す
    let enforcing = false;
    function enforceVideoStyle() {
      if (enforcing) return;
      enforcing = true;
      for (const [k, val] of Object.entries(VIDEO_STYLE)) {
        if (el.style.getPropertyValue(k) !== val || el.style.getPropertyPriority(k) !== 'important') {
          el.style.setProperty(k, val, 'important');
        }
      }
      enforcing = false;
    }
    if (isImg) {
      el = mk('img', { src: v.currentSrc || v.src, alt: v.alt || '', draggable: false });
      if (v.referrerPolicy) el.referrerPolicy = v.referrerPolicy;
      enforceVideoStyle();
      zoomer.append(el);
      // 再取得に失敗した場合(ホットリンク対策など)は、読み込み済みの画像をcanvasへ描いて表示する（静止画）
      el.addEventListener('error', () => {
        try {
          const c = mk('canvas', { width: v.naturalWidth, height: v.naturalHeight });
          c.getContext('2d').drawImage(v, 0, 0);
          const old = el;
          el = c;
          enforceVideoStyle();
          old.replaceWith(c);
        } catch (_) {
          showOsd('画像を読み込めませんでした');
        }
      });
    } else {
      origCss = v.style.cssText;
      origControls = v.controls;
      origParent = v.parentNode;
      origNext = v.nextSibling;
      placeholder = document.createComment('videodock-pip');
      origParent.insertBefore(placeholder, v);
      wasPlaying = !v.paused;
      v.controls = false;
      enforceVideoStyle();
      zoomer.append(v);
      styleObserver = new MutationObserver(() => {
        if (restored) return;
        // サイトが<video>を別の場所へ動かした場合は、PiP窓へ戻す
        if (v.parentNode !== zoomer) zoomer.append(v);
        enforceVideoStyle();
      });
      styleObserver.observe(v, { attributes: true, attributeFilter: ['style', 'class', 'width', 'height'] });
      styleObserver.observe(zoomer, { childList: true });
      if (wasPlaying && v.paused) v.play().catch(() => {});
    }

    // --- ズーム/パン ---
    const z = { s: 1, tx: 0, ty: 0 };
    const layout = () => {
      const W = stage.clientWidth;
      const H = stage.clientHeight;
      const [nw, nh] = natSize();
      return { W, H, c: containRect(nw, nh, W, H) };
    };
    function applyZoom() {
      const { c } = layout();
      if (z.s <= 1.001) {
        z.s = 1;
        z.tx = z.ty = 0;
        zoomer.style.transform = 'none';
      } else {
        // 拡大後の映像が窓より大きければ窓全体を覆う範囲に、小さければ中央に固定する
        const { W, H } = layout();
        const fit = (t, c0, cl, size) => {
          const lo = size - z.s * (c0 + cl);
          const hi = -z.s * c0;
          return hi < lo ? (size - z.s * cl) / 2 - z.s * c0 : clamp(t, lo, hi);
        };
        z.tx = fit(z.tx, c.x, c.w, W);
        z.ty = fit(z.ty, c.y, c.h, H);
        zoomer.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
      }
      btnZoom.textContent = Math.round(z.s * 100) + '%';
      stage.classList.toggle('zoomed', z.s > 1);
    }
    function zoomAt(factor, px, py) {
      const { W, H } = layout();
      const ns = clamp(z.s * factor, 1, MAX_ZOOM);
      const x = px ?? W / 2;
      const y = py ?? H / 2;
      z.tx = x - (ns / z.s) * (x - z.tx);
      z.ty = y - (ns / z.s) * (y - z.ty);
      z.s = ns;
      applyZoom();
    }
    function toggleFill(px, py) {
      if (z.s > 1) {
        z.s = 1;
        applyZoom();
        return;
      }
      const { W, H, c } = layout();
      const fill = Math.max(W / c.w, H / c.h);
      zoomAt(fill > 1.02 ? fill : 2, px, py);
    }

    // --- 再生UIの同期 ---
    let seeking = false;
    const fmt = (t) => {
      if (!isFinite(t)) return '--:--';
      t = Math.max(0, Math.floor(t));
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = String(t % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
    };
    function sync() {
      btnPlay.textContent = v.paused ? '▶' : '⏸';
      btnMute.textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
      const d = v.duration;
      const live = !isFinite(d) || d <= 0;
      seek.disabled = live;
      if (!seeking) seek.value = live ? 0 : Math.round((v.currentTime / d) * 1000);
      time.textContent = live ? fmt(v.currentTime) : `${fmt(v.currentTime)} / ${fmt(d)}`;
    }
    const vEvents = ['play', 'pause', 'timeupdate', 'durationchange', 'volumechange', 'ended', 'seeked'];
    const onVideoSize = () => applyZoom();
    if (!isImg) {
      vEvents.forEach((t) => v.addEventListener(t, sync));
      v.addEventListener('loadedmetadata', onVideoSize);
      v.addEventListener('resize', onVideoSize);
    }
    win.addEventListener('resize', onVideoSize);
    // 操作バーを動画の下に出し入れして表示領域の大きさが変わったときも、ズームの範囲を計算し直す
    try {
      new win.ResizeObserver(onVideoSize).observe(stage);
    } catch (_) {}

    const togglePlay = () => {
      if (isImg) return;
      return v.paused ? v.play().catch(() => {}) : v.pause();
    };
    btnPlay.addEventListener('click', togglePlay);
    btnMute.addEventListener('click', () => {
      if (!isImg) v.muted = !v.muted;
    });
    btnOut.addEventListener('click', () => zoomAt(1 / ZOOM_STEP));
    btnIn.addEventListener('click', () => zoomAt(ZOOM_STEP));
    btnZoom.addEventListener('click', () => {
      z.s = 1;
      applyZoom();
    });
    btnBack.addEventListener('click', () => close());
    seek.addEventListener('input', () => {
      seeking = true;
      if (isFinite(v.duration)) v.currentTime = (seek.value / 1000) * v.duration;
    });
    seek.addEventListener('change', () => {
      seeking = false;
      sync();
    });

    // 画面に一瞬出す表示（音量・シーク・ズーム量）
    let osdTimer = 0;
    const showOsd = (text) => {
      osd.textContent = text;
      osd.classList.add('show');
      clearTimeout(osdTimer);
      osdTimer = win.setTimeout(() => osd.classList.remove('show'), 900);
    };
    const changeVolume = (n) => {
      const vol = clamp((v.muted ? 0 : v.volume) + (n * settings.volumeStep) / 100, 0, 1);
      if (vol > 0) v.muted = false;
      v.volume = vol;
      showOsd(`🔊 音量 ${Math.round(vol * 100)}%`);
    };
    const seekBy = (n) => {
      const d = v.duration;
      if (!isFinite(d) || d <= 0) return showOsd('ライブ配信はシークできません');
      const t = clamp(v.currentTime + n * settings.seekStep, 0, d);
      v.currentTime = t;
      showOsd(`${n > 0 ? '⏩' : '⏪'} ${fmt(t)} / ${fmt(d)}`);
    };

    // 操作: 右クリック+ホイール=ズーム / 上部ホイール・下部ホイール=音量・シーク（上下の割り当て・向きは設定で変更）
    // 中央部の通常ホイールは何もしない。
    doc.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100; // 1ノッチ≒1（トラックパッドは小数）
        if (unit === 0) return;
        if (e.buttons & 2 || isImg) {
          // 右ボタンを押しながら → ズーム（カーソル位置が中心）。画像は音量/シークが無いので通常のホイールでもズーム
          const dir = settings.zoomInvert ? 1 : -1;
          zoomAt(Math.exp(dir * unit * 0.15), e.clientX, e.clientY);
          showOsd(`🔍 ${Math.round(z.s * 100)}%`);
          return;
        }
        const h = stage.clientHeight; // 動画の下の操作バーは音量・シークの範囲に含めない
        if (e.clientY > h) return;
        const zone = h * (settings.wheelZone / 100);
        const inTop = e.clientY <= zone;
        const inBottom = e.clientY >= h - zone;
        if (!inTop && !inBottom) return;
        const topIsVolume = !settings.wheelSwap;
        const n = (settings.wheelInvert ? 1 : -1) * unit; // 既定: ホイール上 = 音量UP / 進む
        if (inTop === topIsVolume) changeVolume(n);
        else seekBy(n);
      },
      { passive: false }
    );
    // 右クリック+ホイールを使うので、PiP窓ではコンテキストメニューを出さない
    doc.addEventListener('contextmenu', (e) => e.preventDefault());
    let drag = null;
    let clickTimer = 0;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      stage.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, tx: z.tx, ty: z.ty, moved: false };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved && z.s > 1) {
        stage.classList.add('panning');
        z.tx = drag.tx + dx;
        z.ty = drag.ty + dy;
        applyZoom();
      }
    });
    const endDrag = () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      stage.classList.remove('panning');
      if (!moved) {
        clearTimeout(clickTimer);
        clickTimer = win.setTimeout(togglePlay, 220); // dblclickと区別
      }
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', () => {
      drag = null;
      stage.classList.remove('panning');
    });
    stage.addEventListener('dblclick', (e) => {
      clearTimeout(clickTimer);
      toggleFill(e.clientX, e.clientY);
    });
    doc.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyP') {
        e.preventDefault();
        close();
        return;
      }
      if (e.target === seek && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      switch (e.key) {
        case ' ': case 'k': togglePlay(); break;
        case 'ArrowLeft': if (isImg) return; v.currentTime = Math.max(0, v.currentTime - 5); break;
        case 'ArrowRight': if (isImg) return; v.currentTime = v.currentTime + 5; break;
        case '+': case '=': zoomAt(ZOOM_STEP); break;
        case '-': zoomAt(1 / ZOOM_STEP); break;
        case '0': z.s = 1; applyZoom(); break;
        case 'f': toggleFill(); break;
        case 'm': if (isImg) return; v.muted = !v.muted; break;
        case 'h': if (settings.uiMode === 'below') { belowHidden = !belowHidden; applySettings(); break; } pinned = !pinned; if (pinned) { ui.classList.add('show'); clearTimeout(hideTimer); } else hideUi(); break;
        default: return;
      }
      e.preventDefault();
    });

    // 操作UIの表示制御（settings.uiMode: edge / move / always / below / hidden）
    let hideTimer = 0;
    let uiHover = false;
    let pinned = false; // H キーで固定表示
    let belowHidden = false; // below モードで H キーにより操作バーを隠している間 true
    const keepVisible = () => pinned || settings.uiMode === 'always';
    const showUi = () => {
      ui.classList.add('show');
      clearTimeout(hideTimer);
      if (keepVisible()) return;
      hideTimer = win.setTimeout(() => {
        if (!uiHover) ui.classList.remove('show');
      }, settings.hideDelay);
    };
    const hideUi = () => {
      clearTimeout(hideTimer);
      if (!uiHover && !keepVisible()) ui.classList.remove('show');
    };
    const wantsUi = (e) => {
      switch (settings.uiMode) {
        case 'move': return true;
        case 'edge': return e.clientY >= win.innerHeight - settings.edgeSize;
        default: return false; // always は常時表示、hidden は出さない
      }
    };
    ui.addEventListener('pointerenter', () => (uiHover = true));
    ui.addEventListener('pointerleave', () => {
      uiHover = false;
      showUi(); // 離れた後の隠す時間を数え直す
      if (!keepVisible() && settings.uiMode !== 'move') hideUi();
    });
    doc.addEventListener('pointermove', (e) => {
      if (wantsUi(e)) showUi();
      else if (settings.uiMode === 'edge' && ui.classList.contains('show') && !uiHover) hideUi();
    });
    doc.documentElement.addEventListener('mouseleave', hideUi);

    // 設定の反映（ボタンの表示/非表示・表示モード）。設定変更時にも呼ばれる
    function applySettings() {
      const b = isImg ? { ...settings.buttons, play: false, seek: false, time: false, mute: false } : settings.buttons;
      btnPlay.hidden = !b.play;
      seek.hidden = !b.seek;
      time.hidden = !b.time;
      btnMute.hidden = !b.mute;
      for (const x of [btnOut, btnZoom, btnIn]) x.hidden = !b.zoom;
      btnBack.hidden = !b.back;
      const before = b.play || b.seek || b.time || b.mute;
      sepA.hidden = !(b.zoom && before);
      sepB.hidden = !(b.back && (before || b.zoom));
      doc.body.classList.toggle('below', settings.uiMode === 'below' && !belowHidden);
      if (settings.uiMode === 'below') {
        ui.classList.remove('show'); // 表示は body.below のCSSで常時
      } else if (settings.uiMode === 'always' || pinned) {
        ui.classList.add('show');
        clearTimeout(hideTimer);
      } else if (!uiHover) {
        ui.classList.remove('show');
      }
    }
    if (!isImg) sync();
    applyZoom();
    applySettings();
    if (settings.showHint) {
      hint.textContent = isImg ? 'ホイール / 右クリック+ホイール: ズーム / ドラッグ: 移動 / ダブルクリック: 拡大⇔戻す / H: 操作バー' : '右クリック+ホイール: ズーム / 上部ホイール: 音量 / 下部ホイール: シーク / ドラッグ: 移動 / ダブルクリック: 拡大⇔戻す / H: 操作バー';
      hint.classList.add('show');
      win.setTimeout(() => hint.classList.remove('show'), 3500);
    }

    // --- 閉じたら元へ戻す（pagehideで確実に呼ばれる） ---
    function restore() {
      if (restored) return;
      restored = true;
      clearTimeout(clickTimer);
      clearTimeout(hideTimer);
      if (isImg) {
        pip = null;
        refreshBar();
        return;
      }
      styleObserver.disconnect();
      vEvents.forEach((t) => v.removeEventListener(t, sync));
      v.removeEventListener('loadedmetadata', onVideoSize);
      v.removeEventListener('resize', onVideoSize);
      const playing = !v.paused;
      v.style.cssText = origCss;
      v.controls = origControls;
      // 戻し先: ①placeholder ②元の親(元の次の兄弟の前) ③諦める（サイトが再描画で消した場合）
      if (placeholder.isConnected) placeholder.replaceWith(v);
      else if (origParent.isConnected) origParent.insertBefore(v, origNext && origNext.parentNode === origParent ? origNext : null);
      else console.warn('[VideoDock] 元の位置が失われたため<video>を戻せませんでした');
      if (playing && v.paused) v.play().catch(() => {});
      pip = null;
      refreshBar();
    }
    function close() {
      try { win.close(); } catch (_) {}
      restore(); // pagehideが来なくても戻す
    }
    win.addEventListener('pagehide', restore);
    return { win, v, close, applySettings };
  }

  // ---------- ツールバーUI ----------
  const ICON = {
    pip: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/></svg>',
    wide: '<svg viewBox="0 0 24 24"><path d="M3 5v14M21 5v14M7 8l-4 4 4 4M17 8l4 4-4 4M3 12h18"/></svg>',
  };
  const CSS = `
    .wrap{position:fixed;left:0;top:0;display:flex;flex-direction:column;align-items:flex-end;gap:6px;
      font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;pointer-events:none;
      opacity:0;visibility:hidden;transition:opacity .18s ease,visibility 0s linear .18s}
    .wrap.on{opacity:1;visibility:visible;transition:opacity .18s ease,visibility 0s}
    .wrap:not(.on) .bar{pointer-events:none}
    @media (prefers-reduced-motion:reduce){.wrap,.wrap.on{transition:none}}
    .bar{display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;
      background:rgba(20,20,26,.82);backdrop-filter:blur(8px);box-shadow:0 2px 12px rgba(0,0,0,.45);
      pointer-events:auto;user-select:none}
    button{all:unset;box-sizing:border-box;min-width:30px;height:30px;display:grid;place-items:center;
      border-radius:7px;cursor:pointer;color:#fff}
    button:hover{background:rgba(255,255,255,.18)}
    button:focus-visible{outline:2px solid #60a5fa}
    button[aria-pressed=true]{background:#2563eb}
    button svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .sep{width:1px;height:18px;background:rgba(255,255,255,.25);margin:0 3px}
    .toast{padding:6px 10px;border-radius:8px;background:rgba(20,20,26,.9);pointer-events:none;max-width:320px}
    .toast[hidden]{display:none}
    [hidden]{display:none!important}
  `;

  let host = null;
  let wrap = null;
  let bar = null;
  let toastEl = null;
  let toastTimer = 0;
  let barVisible = false;
  let hostHideTimer = 0;
  const FADE_MS = 180;
  let tickId = 0;

  function ensureToolbar() {
    if (host) return;
    host = document.createElement('div');
    host.setAttribute('data-videodock', '');
    if (SUPPORTS_POPOVER) host.setAttribute('popover', 'manual');
    // displayは触らない（popover未表示時のdisplay:noneを壊さないため）
    host.style.cssText =
      'position:fixed!important;inset:auto!important;left:0!important;top:0!important;width:0!important;height:0!important;' +
      'margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;' +
      'pointer-events:none!important;z-index:2147483647!important;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML =
      `<style>${CSS}</style><div class="wrap"><div class="bar" role="toolbar" aria-label="VideoDock">` +
      `<button data-act="pip" title="PiP（別ウィンドウ・ズーム/移動可） Alt+P" aria-label="ピクチャインピクチャ">${ICON.pip}</button>` +
      `<span class="sep"></span>` +
      `<button data-act="wide" title="ウィンドウ内で最大表示 Alt+W / Esc で戻る" aria-label="ウィンドウ内で最大表示">${ICON.wide}</button>` +
      `</div><div class="toast" hidden></div></div>`;
    wrap = root.querySelector('.wrap');
    bar = root.querySelector('.bar');
    toastEl = root.querySelector('.toast');

    wrap.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest && e.target.closest('button[data-act]');
      if (btn && active) runAction(btn.dataset.act, active);
    });
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'touchstart', 'wheel']) {
      wrap.addEventListener(t, (e) => e.stopPropagation());
    }
    bar.addEventListener('pointerenter', () => (toolbarHover = true));
    bar.addEventListener('pointerleave', () => (toolbarHover = false));
    document.documentElement.appendChild(host);
  }

  function runAction(act, v) {
    lastActivity = performance.now();
    if (v.tagName === 'IMG' && act !== 'pip') return;
    switch (act) {
      case 'pip':
        return togglePip(v);
      case 'wide':
        return toggleWide(v);
    }
  }

  function toast(msg) {
    ensureToolbar();
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
    if (!barVisible) {
      const v = active || [...videos].find(isCandidate);
      if (v) {
        lastActivity = performance.now();
        showToolbar(v);
      }
    }
  }

  function showToolbarHost() {
    if (!SUPPORTS_POPOVER) return;
    try {
      if (!host.matches(':popover-open')) host.showPopover();
    } catch (_) {}
  }

  // トップレイヤー内の積み順は「後からshowしたものが上」なので、最大化後に出し直す
  function bringToolbarToFront() {
    if (!host || !SUPPORTS_POPOVER || !barVisible) return;
    try {
      host.hidePopover();
      host.showPopover();
    } catch (_) {}
  }

  function refreshBar() {
    if (!bar) return;
    const v = active;
    const set = (act, pressed) => bar.querySelector(`[data-act="${act}"]`).setAttribute('aria-pressed', String(pressed));
    set('pip', !!v && (document.pictureInPictureElement === v || (!!pip && pip.v === v)));
    set('wide', !!v && wideEls.has(v));
    // 画像には「最大表示」を出さない
    const isImg = !!v && v.tagName === 'IMG';
    bar.querySelector('[data-act="wide"]').hidden = isImg;
    bar.querySelector('.sep').hidden = isImg;
  }

  function showToolbar(v) {
    ensureToolbar();
    active = v;
    if (!barVisible) {
      barVisible = true;
      clearTimeout(hostHideTimer);
      showToolbarHost();
      void wrap.offsetWidth; // 非表示(opacity:0)の状態を確定させてから .on を付け、フェードインさせる
      wrap.classList.add('on');
    }
    refreshBar();
    place(v);
    if (!tickId) tickId = requestAnimationFrame(tick);
  }

  function hideToolbar() {
    if (!barVisible) return;
    barVisible = false;
    toolbarHover = false;
    if (wrap) wrap.classList.remove('on'); // フェードアウト（0.18秒）
    clearTimeout(hostHideTimer);
    hostHideTimer = setTimeout(() => {
      if (barVisible || !host || !SUPPORTS_POPOVER) return;
      try {
        host.hidePopover();
      } catch (_) {}
    }, FADE_MS + 40);
  }

  // ボタンの表示位置(settings.barPos)。bw/bh はバーの大きさ
  let lastBarSize = { w: 84, h: 38 };
  function barLeftTop(r, bw, bh) {
    const [vert, horiz] = String(settings.barPos).split('-');
    const left = horiz === 'left' ? r.left + 10 : horiz === 'center' ? r.left + (r.width - bw) / 2 : r.right - bw - 10;
    const top = vert === 'bottom' ? r.bottom - bh - 10 : r.top + 10;
    return {
      left: clamp(left, 4, Math.max(4, innerWidth - bw - 4)),
      top: clamp(top, 4, Math.max(4, innerHeight - bh - 4)),
    };
  }
  function place(v) {
    const r = geom(v);
    if (!r) return;
    const bw = wrap.offsetWidth;
    const bh = wrap.offsetHeight;
    if (bw && bh) lastBarSize = { w: bw, h: bh };
    const p = barLeftTop(r, bw, bh);
    wrap.style.transform = `translate(${Math.round(p.left)}px, ${Math.round(p.top)}px)`;
  }
  // 「ボタンの近く」判定用: まだ表示されていないボタンの予定位置
  function barRect(v) {
    const r = geom(v);
    if (!r) return null;
    const p = barLeftTop(r, lastBarSize.w, lastBarSize.h);
    return { left: p.left, top: p.top, right: p.left + lastBarSize.w, bottom: p.top + lastBarSize.h };
  }
  function pointerOver(v) {
    const r = geom(v);
    return !!r && lastPt.x >= r.left && lastPt.x <= r.right && lastPt.y >= r.top && lastPt.y <= r.bottom;
  }

  function tick() {
    tickId = 0;
    if (!barVisible) return;
    // barHideMs=0: 時間では隠さず、動画・画像の領域から出たら隠す
    const idle = settings.barHideMs > 0 ? performance.now() - lastActivity > settings.barHideMs : !!active && !pointerOver(active);
    if (!active || !isCandidate(active) || document.fullscreenElement || (idle && !toolbarHover)) {
      hideToolbar();
      return;
    }
    place(active);
    tickId = requestAnimationFrame(tick);
  }

  // ---------- 入力イベント ----------
  let moveRaf = 0;
  window.addEventListener(
    'pointermove',
    (e) => {
      lastPt = { x: e.clientX, y: e.clientY };
      if (settings.imageMode === 'key' && MODIFIER_KEYS.includes(settings.imageKey)) keyDown = e.getModifierState(settings.imageKey);
      if (!moveRaf) moveRaf = requestAnimationFrame(onMove);
    },
    { capture: true, passive: true }
  );
  function onMove() {
    moveRaf = 0;
    if (document.fullscreenElement) return;
    const v = pickTarget(lastPt);
    if (!v) return;
    if (settings.barTrigger === 'near' && !toolbarHover) {
      // ボタンの予定位置の近くにカーソルが来たときだけ出す
      const b = barRect(v);
      const d = settings.barNear;
      if (!b || lastPt.x < b.left - d || lastPt.x > b.right + d || lastPt.y < b.top - d || lastPt.y > b.bottom + d) return;
    }
    lastActivity = performance.now();
    if (v !== active || !barVisible) showToolbar(v);
  }

  // ショートカット (Alt+P: PiP / Alt+W: 最大表示 / Esc: 最大表示を解除)
  window.addEventListener(
    'keydown',
    (e) => {
      if (settings.imageMode === 'key' && isImageKey(e)) {
        const t = e.composedPath()[0];
        const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
        if (!typing || MODIFIER_KEYS.includes(settings.imageKey)) {
          // キーを押した瞬間に、いまポインタの下にある画像を対象にする（動かさなくても出せる）
          keyDown = true;
          if (!moveRaf) moveRaf = requestAnimationFrame(onMove);
        }
      }
      if (e.key === 'Escape' && wideEls.size) {
        exitAllWide('user');
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const src = e.composedPath()[0];
      if (src && (src.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(src.tagName))) return;
      if (e.code === 'KeyP' && pip) {
        e.preventDefault();
        pip.close();
        return;
      }
      // ポインタの下の動画・画像を優先し、無ければ直近に操作した対象
      const recent = performance.now() - lastActivity < HOTKEY_ACTIVE_MS || wideEls.size;
      const v = pickVideo(lastPt) || (settings.imageMode !== 'off' ? pickImage(lastPt) : null) || (active && active.isConnected && recent ? active : null);
      if (!v) return;
      const act = e.code === 'KeyP' ? 'pip' : e.code === 'KeyW' ? 'wide' : null;
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      runAction(act, v);
      if (barVisible) place(v);
    },
    true
  );

  window.addEventListener('keyup', (e) => {
    if (isImageKey(e)) keyDown = false;
  }, true);
  window.addEventListener('blur', () => (keyDown = false));

  for (const t of ['enterpictureinpicture', 'leavepictureinpicture']) {
    document.addEventListener(t, refreshBar, true);
  }
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) hideToolbar();
  });

  // ---------- 動画の検出 ----------
  function collect(root) {
    root.querySelectorAll('video').forEach((v) => videos.add(v));
    if (settings.imageMode !== 'off') root.querySelectorAll('img').forEach((i) => images.add(i));
  }
  function deepCollect(root) {
    collect(root);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) deepCollect(el.shadowRoot);
    }
  }
  function prune() {
    for (const v of videos) {
      if (v.isConnected) continue;
      videos.delete(v);
      if (wideEls.has(v)) exitWide(v);
      if (active === v) {
        active = null;
        hideToolbar();
      }
    }
  }
  function pruneImages() {
    for (const i of images) {
      if (i.isConnected) continue;
      images.delete(i);
      if (active === i) {
        active = null;
        hideToolbar();
      }
    }
  }
  let scanTimer = 0;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      collect(document);
      prune();
      pruneImages();
    }, 400);
  }

  // 設定変更をページ側へ即時反映する（関数宣言なのでonChangedから呼べる）。ボタンの位置・表示時間・トリガーは毎フレーム/毎イベントで設定を読むので、ここでは画像まわりだけ
  function applyPageSettings() {
    if (settings.imageMode === 'off') {
      images.clear();
      if (active && active.tagName === 'IMG') {
        active = null;
        hideToolbar();
      }
      keyDown = false;
    } else {
      deepCollect(document); // 「オフ」から切り替えた直後でも、すぐ画像を対象にする
      if (active && active.tagName === 'IMG' && !isCandidate(active)) hideToolbar(); // 最小サイズを上げたとき
    }
    if (settings.imageMode !== 'key') keyDown = false;
    if (!moveRaf) moveRaf = requestAnimationFrame(onMove); // 今のポインタ位置で出し直す
  }

  deepCollect(document);
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => {
    if (document.hidden) return;
    deepCollect(document); // Shadow DOM内の動画も拾う
    prune();
    pruneImages();
  }, 3000);
})();
