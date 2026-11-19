// VideoDock 設定ページ。変更は即座に chrome.storage.sync へ保存され、開いているPiP窓にも反映される。
(() => {
  const D = VIDEODOCK_DEFAULTS;
  const $ = (s) => document.querySelector(s);
  const status = $('#status');
  let timer = 0;

  const merge = videodockMerge;
  let imageKey = D.imageKey;
  const keyLabel = (k) => ({ Control: 'Ctrl', Meta: 'Win/Cmd', ' ': 'Space' }[k] || k.replace(/^Key/, '').replace(/^Digit/, ''));

  function render(s) {
    document.querySelectorAll('input[name=uiMode]').forEach((r) => (r.checked = r.value === s.uiMode));
    $('#edgeSize').value = s.edgeSize;
    $('#hideDelay').value = s.hideDelay;
    $('#showHint').checked = s.showHint;
    document.querySelectorAll('input[name=imageMode]').forEach((r) => (r.checked = r.value === s.imageMode));
    $('#imageMin').value = s.imageMin;
    imageKey = s.imageKey;
    $('#imageKeyBox').value = keyLabel(s.imageKey);
    $('#imageKeyBox').disabled = s.imageMode !== 'key';
    $('#imageKeyAlt').disabled = s.imageMode !== 'key';
    $('#barPos').value = s.barPos;
    document.querySelectorAll('input[name=barTrigger]').forEach((r) => (r.checked = r.value === s.barTrigger));
    $('#barNear').value = s.barNear;
    $('#barNear').disabled = s.barTrigger !== 'near';
    $('#barHideMs').value = s.barHideMs;
    document.querySelectorAll('input[name=wheelSwap]').forEach((r) => (r.checked = r.value === (s.wheelSwap ? '1' : '0')));
    $('#wheelZone').value = s.wheelZone;
    $('#wheelInvert').checked = s.wheelInvert;
    $('#zoomInvert').checked = s.zoomInvert;
    $('#volumeStep').value = s.volumeStep;
    $('#seekStep').value = s.seekStep;
    document.querySelectorAll('[data-btn]').forEach((c) => (c.checked = !!s.buttons[c.dataset.btn]));
    const edge = s.uiMode === 'edge';
    $('#edgeSize').disabled = !edge;
    $('#hideDelay').disabled = s.uiMode === 'always' || s.uiMode === 'hidden';
  }

  function read() {
    const mode = document.querySelector('input[name=uiMode]:checked');
    const num = (id, def, min, max) => {
      const n = parseInt($(id).value, 10);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
    };
    const buttons = {};
    document.querySelectorAll('[data-btn]').forEach((c) => (buttons[c.dataset.btn] = c.checked));
    return {
      uiMode: mode ? mode.value : D.uiMode,
      edgeSize: num('#edgeSize', D.edgeSize, 16, 300),
      hideDelay: num('#hideDelay', D.hideDelay, 200, 10000),
      showHint: $('#showHint').checked,
      imageMode: (document.querySelector('input[name=imageMode]:checked') || {}).value || D.imageMode,
      imageMin: num('#imageMin', D.imageMin, 40, 800),
      imageKey,
      barPos: $('#barPos').value || D.barPos,
      barTrigger: (document.querySelector('input[name=barTrigger]:checked') || {}).value || D.barTrigger,
      barNear: num('#barNear', D.barNear, 10, 500),
      barHideMs: num('#barHideMs', D.barHideMs, 0, 30000),
      wheelSwap: (document.querySelector('input[name=wheelSwap]:checked') || {}).value === '1',
      wheelZone: num('#wheelZone', D.wheelZone, 10, 45),
      wheelInvert: $('#wheelInvert').checked,
      zoomInvert: $('#zoomInvert').checked,
      volumeStep: num('#volumeStep', D.volumeStep, 1, 25),
      seekStep: num('#seekStep', D.seekStep, 1, 120),
      buttons,
    };
  }

  async function save(s) {
    await chrome.storage.sync.set({ settings: s });
    status.textContent = '保存しました';
    clearTimeout(timer);
    timer = setTimeout(() => (status.textContent = ''), 1500);
  }

  document.addEventListener('change', () => {
    const s = read();
    render(s);
    save(s);
  });
  // 画像トリガーのキー設定: 欄にフォーカスして押したキーを登録（Esc/Tabで取り消し）
  $('#imageKeyBox').addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key === 'Escape' || e.key === 'Tab') return $('#imageKeyBox').blur();
    imageKey = ['Alt', 'Control', 'Shift', 'Meta'].includes(e.key) ? e.key : e.code;
    $('#imageKeyBox').blur();
    const s = read();
    render(s);
    save(s);
  });
  $('#imageKeyAlt').addEventListener('click', () => {
    imageKey = 'Alt';
    const s = read();
    render(s);
    save(s);
  });
  $('#reset').addEventListener('click', async () => {
    await chrome.storage.sync.remove('settings');
    render(merge());
    status.textContent = '既定に戻しました';
  });

  chrome.storage.sync.get('settings').then((r) => render(merge(r.settings)));
})();
