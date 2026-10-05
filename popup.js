// راست‌نویس — منطق پاپ‌آپ
const toFa = (n) => Number(n || 0).toLocaleString('fa-IR');

const enabledEl = document.getElementById('enabled');
const hintsEl = document.getElementById('hints');
const countEl = document.getElementById('count');

const testInput = document.getElementById('testInput');
const btnCheck = document.getElementById('btnCheck');
const btnAutoFix = document.getElementById('btnAutoFix');
const btnCopyFixed = document.getElementById('btnCopyFixed');
const btnClear = document.getElementById('btnClear');
const testResult = document.getElementById('testResult');
const testStatus = document.getElementById('testStatus');
const testIssues = document.getElementById('testIssues');
const resetDictBtn = document.getElementById('resetDict');
const dictListEl = document.getElementById('dictList');

let currentIssues = [];
let ignoredWordsList = [];

function renderDictList() {
  if (!dictListEl) return;
  if (!ignoredWordsList || ignoredWordsList.length === 0) {
    dictListEl.innerHTML = '<span class="dict-empty">هنوز کلمه‌ای نادیده گرفته نشده است.</span>';
    return;
  }
  dictListEl.innerHTML = ignoredWordsList.map((word, idx) => `
    <span class="dict-tag">
      <span>${escapeHtml(word)}</span>
      <button class="dict-tag-del" data-idx="${idx}" title="حذف از واژه‌نامه">✕</button>
    </span>
  `).join('');

  dictListEl.querySelectorAll('.dict-tag-del').forEach((delBtn) => {
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(delBtn.dataset.idx);
      ignoredWordsList.splice(idx, 1);
      chrome.storage.sync.set({ ignoredWords: ignoredWordsList }, () => {
        renderDictList();
        if (testInput.value.trim()) runTestCheck();
      });
    });
  });
}

// بارگذاری تنظیمات
chrome.storage.sync.get({ enabled: true, includeHints: true, ignoredWords: [] }, (cfg) => {
  enabledEl.checked = cfg.enabled;
  hintsEl.checked = cfg.includeHints;
  ignoredWordsList = cfg.ignoredWords || [];
  renderDictList();
});

chrome.storage.local.get({ marked: 0 }, (s) => {
  countEl.textContent = toFa(s.marked);
});

enabledEl.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: enabledEl.checked });
});

hintsEl.addEventListener('change', () => {
  chrome.storage.sync.set({ includeHints: hintsEl.checked }, () => {
    if (testInput.value.trim()) runTestCheck();
  });
});

document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.local.set({ marked: 0 });
  countEl.textContent = toFa(0);
});

resetDictBtn.addEventListener('click', () => {
  chrome.storage.sync.set({ ignoredWords: [] }, () => {
    ignoredWordsList = [];
    renderDictList();
    resetDictBtn.textContent = 'پاک شد!';
    setTimeout(() => { resetDictBtn.textContent = 'پاک‌کردن لغات شخصی'; }, 1500);
    if (testInput.value.trim()) runTestCheck();
  });
});

// اجرای آزمون درست‌نویسی
function runTestCheck() {
  const text = testInput.value;
  if (!text || !text.trim()) {
    testResult.style.display = 'none';
    btnAutoFix.style.display = 'none';
    btnCopyFixed.style.display = 'none';
    currentIssues = [];
    return;
  }

  const engine = window.RastNevisEngine;
  if (!engine) return;

  const includeHints = hintsEl.checked;
  currentIssues = engine.checkText(text, includeHints, ignoredWordsList);

  testResult.style.display = 'block';

  if (currentIssues.length === 0) {
    testStatus.className = 'test-status status-clean';
    testStatus.innerHTML = '<span>✓ متن کاملاً درست است و ایرادی ندارد.</span>';
    testIssues.style.display = 'none';
    btnAutoFix.style.display = 'none';
    btnCopyFixed.style.display = 'none';
  } else {
    testStatus.className = 'test-status status-dirty';
    testStatus.innerHTML = `<span>⚠ ${toFa(currentIssues.length)} مورد نیازمند اصلاح یافت شد</span>`;
    testIssues.style.display = 'block';
    testIssues.innerHTML = currentIssues.map((issue) => `
      <div class="issue-row">
        <span class="issue-w">${escapeHtml(issue.wrong)}</span>
        <span style="color:#71767b;font-size:10px;">←</span>
        <span class="issue-c">${escapeHtml(issue.correct)}</span>
        <span class="issue-r">${escapeHtml(issue.reason)}</span>
      </div>
    `).join('');
    btnAutoFix.style.display = 'inline-flex';
    btnCopyFixed.style.display = 'inline-flex';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// دکمه‌ها
btnCheck.addEventListener('click', runTestCheck);

let debounceTimer = null;
testInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runTestCheck, 300);
});

btnAutoFix.addEventListener('click', () => {
  const engine = window.RastNevisEngine;
  if (!engine || !currentIssues.length) return;
  const fixed = engine.applyCorrections(testInput.value, currentIssues);
  testInput.value = fixed;
  runTestCheck();
});

btnCopyFixed.addEventListener('click', async () => {
  const engine = window.RastNevisEngine;
  if (!engine) return;
  const fixed = engine.applyCorrections(testInput.value, currentIssues);
  try {
    await navigator.clipboard.writeText(fixed);
    const origText = btnCopyFixed.textContent;
    btnCopyFixed.textContent = 'کپی شد!';
    setTimeout(() => { btnCopyFixed.textContent = origText; }, 1500);
  } catch (e) {
    btnCopyFixed.textContent = 'خطا در کپی';
  }
});

btnClear.addEventListener('click', () => {
  testInput.value = '';
  testResult.style.display = 'none';
  btnAutoFix.style.display = 'none';
  btnCopyFixed.style.display = 'none';
  currentIssues = [];
  testInput.focus();
});
