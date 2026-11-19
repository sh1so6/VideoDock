// VideoDock 設定ページ。変更は即座に chrome.storage.sync へ保存され、開いているPiP窓にも反映される。
(() => {
  const D = VIDEODOCK_DEFAULTS;
  const $ = (s) => document.querySelector(s);
  const status = $('#status');
  let timer = 0;

  const merge = (saved) => ({ ...D, ...(saved || {}), buttons: { ...D.buttons, ...((saved && saved.buttons) || {}) } });

  function render(s) {
    document.querySelectorAll('input[name=uiMode]').forEach((r) => (r.checked = r.value === s.uiMode));
    $('#edgeSize').value = s.edgeSize;
    $('#hideDelay').value = s.hideDelay;
    $('#showHint').checked = s.showHint;
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
  $('#reset').addEventListener('click', async () => {
    await chrome.storage.sync.remove('settings');
    render(merge());
    status.textContent = '既定に戻しました';
  });

  chrome.storage.sync.get('settings').then((r) => render(merge(r.settings)));
})();
