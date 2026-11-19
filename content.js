/* VideoDock content script
 * 動画上に PiP / ズーム / ウィンドウ内最大化 のツールバーを表示する。
 */
(() => {
  'use strict';
  if (window.__videoDockLoaded) return;
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

  const ZOOM_PROPS = ['transform', 'transform-origin', 'clip-path'];
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
  const states = new WeakMap(); // video -> {s, tx, ty, w, h, addedControls}
  const wideEls = new Set(); // 最大化中の video / iframe
  let active = null;
  let lastActivity = 0;
  let toolbarHover = false;
  let lastPt = { x: 0, y: 0 };

  const stateOf = (v) => {
    let st = states.get(v);
    if (!st) states.set(v, (st = { s: 1, tx: 0, ty: 0, w: 0, h: 0, addedControls: false }));
    return st;
  };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  // ---------- インラインstyleの保存・復元 ----------
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

  // ---------- 動画の矩形（ズーム前の見た目の枠） ----------
  function baseRect(v) {
    const r = v.getBoundingClientRect();
    const st = states.get(v);
    if (!st || st.s <= 1) return r;
    const width = r.width / st.s;
    const height = r.height / st.s;
    const left = r.left - st.tx;
    const top = r.top - st.ty;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  function isCandidate(v) {
    if (!v.isConnected) return false;
    if (v.readyState >= 1 && v.videoWidth === 0) return false; // 音声のみ
    const r = baseRect(v);
    if (r.width < MIN_W || r.height < MIN_H) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    return getComputedStyle(v).visibility !== 'hidden';
  }

  function pickVideo(pt) {
    for (const el of wideEls) if (el.tagName === 'VIDEO') return el; // 最大化中はそれが最優先
    let best = null;
    let bestArea = Infinity;
    for (const v of videos) {
      if (!isCandidate(v)) continue;
      const r = baseRect(v);
      if (pt.x < r.left || pt.x > r.right || pt.y < r.top || pt.y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  // ---------- ズーム ----------
  function applyZoom(v, st, w, h) {
    st.w = w;
    st.h = h;
    if (st.s <= 1.001) {
      st.s = 1;
      st.tx = st.ty = 0;
      restoreProps(v, ZOOM_PROPS);
      return;
    }
    st.tx = clamp(st.tx, w * (1 - st.s), 0);
    st.ty = clamp(st.ty, h * (1 - st.s), 0);
    const s = st.s;
    // 元の枠をローカル座標へ逆変換したものでclipし、親要素に手を入れずに枠内へ収める
    const l = -st.tx / s;
    const t = -st.ty / s;
    const r = w - (w - st.tx) / s;
    const b = h - (h - st.ty) / s;
    setImp(v, {
      'transform-origin': '0 0',
      transform: `translate(${st.tx}px, ${st.ty}px) scale(${s})`,
      'clip-path': `inset(${t}px ${r}px ${b}px ${l}px)`,
    });
  }

  function zoomBy(v, factor, cx, cy) {
    const st = stateOf(v);
    const r = baseRect(v);
    const ns = clamp(st.s * factor, 1, MAX_ZOOM);
    const px = (cx ?? r.left + r.width / 2) - r.left;
    const py = (cy ?? r.top + r.height / 2) - r.top;
    st.tx = px - (ns / st.s) * (px - st.tx);
    st.ty = py - (ns / st.s) * (py - st.ty);
    st.s = ns;
    applyZoom(v, st, r.width, r.height);
    refreshBar();
  }

  function resetZoom(v) {
    const st = stateOf(v);
    st.s = 1;
    st.tx = st.ty = 0;
    restoreProps(v, ZOOM_PROPS);
    refreshBar();
  }

  // ---------- ウィンドウ内最大化（Popover APIでトップレイヤーへ） ----------
  function enterWide(el) {
    if (wideEls.has(el)) return true;
    if (!SUPPORTS_POPOVER) {
      toast('このブラウザは最大化に未対応です (Chrome 114+)');
      return false;
    }
    const isVideo = el.tagName === 'VIDEO';
    if (isVideo) resetZoom(el);
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
    if (isVideo) {
      const st = stateOf(el);
      if (!el.controls) {
        el.controls = true; // サイト独自UIはトップレイヤーの背面になるので標準UIを出す
        st.addedControls = true;
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
      const st = stateOf(el);
      if (st.addedControls) {
        el.controls = false;
        st.addedControls = false;
      }
      resetZoom(el);
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
      // 子フレームでのクリック等のユーザー操作は祖先フレームにも伝播する。なりすまし対策に必須。
      if (!navigator.userActivation || !navigator.userActivation.isActive) return;
      enterWide(iframe);
    } else {
      exitWide(iframe, 'child');
    }
  });

  // ---------- PiP ----------
  async function togglePip(v) {
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

  // ---------- ツールバーUI ----------
  const ICON = {
    pip: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/></svg>',
    zin: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M8.5 11h5M11 8.5v5"/></svg>',
    zout: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M8.5 11h5"/></svg>',
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
    .zoom{padding:0 6px;font-variant-numeric:tabular-nums;min-width:44px}
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
      `<button data-act="pip" title="PiP（別ウィンドウ） Alt+P" aria-label="ピクチャインピクチャ">${ICON.pip}</button>` +
      `<span class="sep"></span>` +
      `<button data-act="zout" title="縮小 Alt+−" aria-label="縮小">${ICON.zout}</button>` +
      `<button data-act="zreset" class="zoom" title="ズームをリセット Alt+0" aria-label="ズームをリセット">100%</button>` +
      `<button data-act="zin" title="拡大 Alt+＋ / Alt+ホイール" aria-label="拡大">${ICON.zin}</button>` +
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
      case 'zin':
        return zoomBy(v, ZOOM_STEP);
      case 'zout':
        return zoomBy(v, 1 / ZOOM_STEP);
      case 'zreset':
        return resetZoom(v);
      case 'wide':
        return toggleWide(v);
    }
  }

  function toast(msg) {
    ensureToolbar();
    showToolbarHost();
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2500);
    if (active && !barVisible) showToolbar(active);
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
    const st = v && states.get(v);
    const set = (act, pressed) => bar.querySelector(`[data-act="${act}"]`).setAttribute('aria-pressed', String(pressed));
    set('pip', !!v && document.pictureInPictureElement === v);
    set('wide', !!v && wideEls.has(v));
    bar.querySelector('.zoom').textContent = Math.round((st ? st.s : 1) * 100) + '%';
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
    const r = baseRect(v);
    const st = states.get(v);
    if (st && st.s > 1 && (Math.abs(st.w - r.width) > 1 || Math.abs(st.h - r.height) > 1)) {
      applyZoom(v, st, r.width, r.height); // リサイズ追従
    }
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

  // Alt+ホイールでカーソル位置を中心にズーム
  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.altKey) return;
      const v = pickVideo({ x: e.clientX, y: e.clientY });
      if (!v) return;
      e.preventDefault();
      e.stopPropagation();
      lastActivity = performance.now();
      active = v;
      zoomBy(v, Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      showToolbar(v);
    },
    { capture: true, passive: false }
  );

  // Alt+ドラッグでパン
  let pan = null;
  let swallowClick = false;
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.altKey || e.button !== 0) return;
      const v = pickVideo({ x: e.clientX, y: e.clientY });
      if (!v) return;
      const st = stateOf(v);
      if (st.s <= 1) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      pan = { v, x: e.clientX, y: e.clientY, tx: st.tx, ty: st.ty, moved: false };
    },
    true
  );
  window.addEventListener(
    'mousedown',
    (e) => {
      if (pan) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );
  window.addEventListener(
    'pointermove',
    (e) => {
      if (!pan) return;
      const st = stateOf(pan.v);
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
      st.tx = pan.tx + dx;
      st.ty = pan.ty + dy;
      applyZoom(pan.v, st, st.w, st.h);
      lastActivity = performance.now();
    },
    true
  );
  const endPan = () => {
    if (!pan) return;
    swallowClick = pan.moved;
    pan = null;
    setTimeout(() => (swallowClick = false), 80);
  };
  window.addEventListener('pointerup', endPan, true);
  window.addEventListener('pointercancel', endPan, true);
  window.addEventListener(
    'click',
    (e) => {
      if (swallowClick) {
        swallowClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );
  // Alt+ダブルクリックでズームリセット
  window.addEventListener(
    'dblclick',
    (e) => {
      if (!e.altKey) return;
      const v = pickVideo({ x: e.clientX, y: e.clientY });
      if (!v) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      resetZoom(v);
    },
    true
  );

  // ショートカット
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
      const recent = performance.now() - lastActivity < HOTKEY_ACTIVE_MS || wideEls.size;
      const v = active && active.isConnected && recent ? active : null;
      if (!v) return;
      let act = null;
      switch (e.code) {
        case 'KeyP': act = 'pip'; break;
        case 'KeyW': act = 'wide'; break;
        case 'Equal':
        case 'NumpadAdd': act = 'zin'; break;
        case 'Minus':
        case 'NumpadSubtract': act = 'zout'; break;
        case 'Digit0':
        case 'Numpad0': act = 'zreset'; break;
      }
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
