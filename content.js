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
  const HIDE_MS = 2500;
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
  const addedControls = new WeakSet(); // 最大化のために controls を足した video
  const wideEls = new Set(); // 最大化中の video / iframe
  let active = null;
  let lastActivity = 0;
  let toolbarHover = false;
  let lastPt = { x: 0, y: 0 };
  let pip = null; // Document PiP のセッション {win, v, close}

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

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
    const vw = v.videoWidth;
    const vh = v.videoHeight;
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
    if (document.pictureInPictureElement === v) return stdPip(v);
    if (!docPipSupported()) return stdPip(v);
    if (wideEls.has(v)) exitWide(v);

    const g = geom(v);
    const width = clamp(Math.round(g ? g.width : 480), 360, 960);
    const vw = v.videoWidth || 16;
    const vh = v.videoHeight || 9;
    const height = clamp(Math.round((width * vh) / vw), 200, 720);
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

    const stage = mk('div', { className: 'stage' });
    const zoomer = mk('div', { className: 'zoomer' }); // ズームはこの専用要素のtransformで行う（サイトのstyle書き換えの影響を受けない）
    stage.append(zoomer);
    const hint = mk('div', { className: 'hint' });
    const btnPlay = mk('button', { title: '再生/一時停止 (Space)' });
    const seek = mk('input', { className: 'seek', type: 'range', min: 0, max: 1000, step: 1, value: 0 });
    const time = mk('span', { className: 'time' });
    const btnMute = mk('button', { title: 'ミュート (M)' });
    const btnOut = mk('button', { textContent: '−', title: '縮小 (-)' });
    const btnZoom = mk('button', { className: 'zoom', textContent: '100%', title: 'ズームをリセット (0)' });
    const btnIn = mk('button', { textContent: '+', title: '拡大 (+ / ホイール)' });
    const btnBack = mk('button', { textContent: '⤴', title: 'タブに戻す' });
    const ui = mk(
      'div',
      { className: 'ui' },
      btnPlay, seek, time, btnMute, mk('span', { className: 'sep' }), btnOut, btnZoom, btnIn, mk('span', { className: 'sep' }), btnBack
    );
    doc.body.append(stage, ui, hint);

    // --- <video>を移す ---
    const origCss = v.style.cssText;
    const origControls = v.controls;
    const origParent = v.parentNode;
    const origNext = v.nextSibling;
    const placeholder = document.createComment('videodock-pip');
    origParent.insertBefore(placeholder, v);
    const wasPlaying = !v.paused;
    v.controls = false;
    let restored = false;
    const VIDEO_STYLE = {
      position: 'absolute', left: '0', top: '0', right: 'auto', bottom: 'auto', width: '100%', height: '100%',
      'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0', margin: '0', padding: '0',
      border: '0', 'box-sizing': 'border-box', 'object-fit': 'contain', 'object-position': '50% 50%',
      background: '#000', transform: 'none', 'clip-path': 'none', filter: 'none',
      visibility: 'visible', opacity: '1', display: 'block',
    };
    // サイトのプレーヤーが再生/リサイズのたびに<video>のstyleを書き換えても、毎回こちらの値へ戻す
    let enforcing = false;
    function enforceVideoStyle() {
      if (enforcing) return;
      enforcing = true;
      for (const [k, val] of Object.entries(VIDEO_STYLE)) {
        if (v.style.getPropertyValue(k) !== val || v.style.getPropertyPriority(k) !== 'important') {
          v.style.setProperty(k, val, 'important');
        }
      }
      enforcing = false;
    }
    enforceVideoStyle();
    zoomer.append(v);
    const styleObserver = new MutationObserver(onVideoMutated);
    function onVideoMutated() {
      if (restored) return;
      // サイトが<video>を別の場所へ動かした場合は、PiP窓へ戻す
      if (v.parentNode !== zoomer) zoomer.append(v);
      enforceVideoStyle();
    }
    styleObserver.observe(v, { attributes: true, attributeFilter: ['style', 'class', 'width', 'height'] });
    styleObserver.observe(zoomer, { childList: true });
    if (wasPlaying && v.paused) v.play().catch(() => {});

    // --- ズーム/パン ---
    const z = { s: 1, tx: 0, ty: 0 };
    const layout = () => {
      const W = stage.clientWidth;
      const H = stage.clientHeight;
      return { W, H, c: containRect(v.videoWidth, v.videoHeight, W, H) };
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
    vEvents.forEach((t) => v.addEventListener(t, sync));
    const onVideoSize = () => applyZoom();
    v.addEventListener('loadedmetadata', onVideoSize);
    v.addEventListener('resize', onVideoSize);
    win.addEventListener('resize', onVideoSize);

    const togglePlay = () => (v.paused ? v.play().catch(() => {}) : v.pause());
    btnPlay.addEventListener('click', togglePlay);
    btnMute.addEventListener('click', () => (v.muted = !v.muted));
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

    // 操作: ホイールでズーム、ドラッグでパン、クリックで再生/停止、ダブルクリックでフィット/拡大切替
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      },
      { passive: false }
    );
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
        case 'ArrowLeft': v.currentTime = Math.max(0, v.currentTime - 5); break;
        case 'ArrowRight': v.currentTime = v.currentTime + 5; break;
        case '+': case '=': zoomAt(ZOOM_STEP); break;
        case '-': zoomAt(1 / ZOOM_STEP); break;
        case '0': z.s = 1; applyZoom(); break;
        case 'f': toggleFill(); break;
        case 'm': v.muted = !v.muted; break;
        default: return;
      }
      e.preventDefault();
    });

    // 操作UIの自動表示/非表示
    let hideTimer = 0;
    let uiHover = false;
    const showUi = () => {
      ui.classList.add('show');
      clearTimeout(hideTimer);
      hideTimer = win.setTimeout(() => {
        if (!uiHover && !v.paused) ui.classList.remove('show');
      }, 2000);
    };
    ui.addEventListener('pointerenter', () => (uiHover = true));
    ui.addEventListener('pointerleave', () => (uiHover = false));
    doc.addEventListener('pointermove', showUi);
    sync();
    applyZoom();
    showUi();
    hint.textContent = 'ホイール: ズーム / ドラッグ: 移動 / ダブルクリック: 拡大⇔戻す';
    hint.classList.add('show');
    win.setTimeout(() => hint.classList.remove('show'), 3500);

    // --- 閉じたら元へ戻す（pagehideで確実に呼ばれる） ---
    function restore() {
      if (restored) return;
      restored = true;
      styleObserver.disconnect();
      clearTimeout(clickTimer);
      clearTimeout(hideTimer);
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
    return { win, v, close };
  }

  // ---------- ツールバーUI ----------
  const ICON = {
    pip: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/></svg>',
    wide: '<svg viewBox="0 0 24 24"><path d="M3 5v14M21 5v14M7 8l-4 4 4 4M17 8l4 4-4 4M3 12h18"/></svg>',
  };
  const CSS = `
    .wrap{position:fixed;left:0;top:0;display:flex;flex-direction:column;align-items:flex-end;gap:6px;
      font:12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;pointer-events:none;visibility:hidden}
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
  `;

  let host = null;
  let wrap = null;
  let bar = null;
  let toastEl = null;
  let toastTimer = 0;
  let barVisible = false;
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
  }

  function showToolbar(v) {
    ensureToolbar();
    active = v;
    if (!barVisible) {
      barVisible = true;
      showToolbarHost();
      wrap.style.visibility = 'visible';
    }
    refreshBar();
    place(v);
    if (!tickId) tickId = requestAnimationFrame(tick);
  }

  function hideToolbar() {
    if (!barVisible) return;
    barVisible = false;
    toolbarHover = false;
    if (wrap) wrap.style.visibility = 'hidden';
    if (host && SUPPORTS_POPOVER) {
      try {
        host.hidePopover();
      } catch (_) {}
    }
  }

  function place(v) {
    const r = geom(v);
    if (!r) return;
    const bw = wrap.offsetWidth;
    const bh = wrap.offsetHeight;
    const left = clamp(r.right - bw - 10, 4, Math.max(4, innerWidth - bw - 4));
    const top = clamp(r.top + 10, 4, Math.max(4, innerHeight - bh - 4));
    wrap.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function tick() {
    tickId = 0;
    if (!barVisible) return;
    const idle = performance.now() - lastActivity > HIDE_MS;
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
      if (!moveRaf) moveRaf = requestAnimationFrame(onMove);
    },
    { capture: true, passive: true }
  );
  function onMove() {
    moveRaf = 0;
    if (document.fullscreenElement) return;
    const v = pickVideo(lastPt);
    if (!v) return;
    lastActivity = performance.now();
    if (v !== active || !barVisible) showToolbar(v);
  }

  // ショートカット (Alt+P: PiP / Alt+W: 最大表示 / Esc: 最大表示を解除)
  window.addEventListener(
    'keydown',
    (e) => {
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
      const recent = performance.now() - lastActivity < HOTKEY_ACTIVE_MS || wideEls.size;
      const v = active && active.isConnected && recent ? active : null;
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

  for (const t of ['enterpictureinpicture', 'leavepictureinpicture']) {
    document.addEventListener(t, refreshBar, true);
  }
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) hideToolbar();
  });

  // ---------- 動画の検出 ----------
  function collect(root) {
    root.querySelectorAll('video').forEach((v) => videos.add(v));
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
  let scanTimer = 0;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      collect(document);
      prune();
    }, 400);
  }

  deepCollect(document);
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => {
    if (document.hidden) return;
    deepCollect(document); // Shadow DOM内の動画も拾う
    prune();
  }, 3000);
})();
