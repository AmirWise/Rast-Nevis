// راست‌نویس — منطق پاپ‌آپ
const toFa = (n) => Number(n || 0).toLocaleString('fa-IR');

const enabledEl = document.getElementById('enabled');
const hintsEl = document.getElementById('hints');
const countEl = document.getElementById('count');

chrome.storage.sync.get({ enabled: true, includeHints: true }, (cfg) => {
  enabledEl.checked = cfg.enabled;
  hintsEl.checked = cfg.includeHints;
});

chrome.storage.local.get({ marked: 0 }, (s) => {
  countEl.textContent = toFa(s.marked);
});

enabledEl.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: enabledEl.checked });
});

hintsEl.addEventListener('change', () => {
  chrome.storage.sync.set({ includeHints: hintsEl.checked });
});

document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.local.set({ marked: 0 });
  countEl.textContent = toFa(0);
});
