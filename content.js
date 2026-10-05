/* ═══════════════════════════════════════════════════════════════
   راست‌نویس (RastNevis) — Content Script
   تشخیص توییت‌های فارسی + بررسی درست‌نویسی پیش از ارسال در X/Twitter
   تمام پردازش محلی است؛ هیچ داده‌ای ارسال نمی‌شود.
═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const engine = window.RastNevisEngine;
  if (!engine) {
    console.error('راست‌نویس: موتور زبانی بارگذاری نشد.');
    return;
  }

  /* ── ۱) تنظیمات ─────────────────────────────────────────── */
  const cfg = {
    enabled: true,
    includeHints: true,
    ignoredWords: [],
  };

  function loadConfig() {
    try {
      chrome.storage.sync.get({ enabled: true, includeHints: true, ignoredWords: [] }, (res) => {
        const wasOff = !cfg.enabled;
        cfg.enabled = res.enabled;
        cfg.includeHints = res.includeHints;
        cfg.ignoredWords = res.ignoredWords || [];

        if (!cfg.enabled) {
          clearAll();
          removeComposerButtons();
        } else if (wasOff) {
          document.querySelectorAll('[data-pfa-done]').forEach((el) => el.removeAttribute('data-pfa-done'));
          scanAll();
        } else {
          scanAll();
        }
      });
    } catch (e) { /* storage در دسترس نیست */ }
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.enabled) cfg.enabled = changes.enabled.newValue;
      if (changes.includeHints) cfg.includeHints = changes.includeHints.newValue;
      if (changes.ignoredWords) cfg.ignoredWords = changes.ignoredWords.newValue || [];

      if (!cfg.enabled) {
        clearAll();
        removeComposerButtons();
      } else {
        document.querySelectorAll('[data-pfa-done]').forEach((el) => el.removeAttribute('data-pfa-done'));
        clearAll(true);
        scanAll();
      }
    });
  }

  /* ── ۲) ابزارهای DOM ────────────────────────────────────── */
  const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  const ICON_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>';
  const ICON_FEATHER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  const toFa = (n) => Number(n || 0).toLocaleString('fa-IR');

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function getTwitterTheme() {
    try {
      const bg = window.getComputedStyle(document.body).backgroundColor;
      if (bg === 'rgb(255, 255, 255)' || bg === '#ffffff') return 'pfa-theme-light';
      if (bg === 'rgb(21, 32, 43)' || bg === '#15202b') return 'pfa-theme-dim';
    } catch (e) { /* نادیده */ }
    return 'pfa-theme-dark';
  }

  /* ── ۳) پاک‌سازی نشانه‌های تایم‌لاین ──────────────────────── */
  function findTweetText(article) {
    return article.querySelector('[data-testid="tweetText"]');
  }

  function clearMarks(article) {
    article.querySelectorAll('.pfa-u').forEach((span) => {
      const parent = span.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(span.textContent), span);
      parent.normalize();
    });
    article.querySelectorAll('.pfa-badge, .pfa-panel').forEach((el) => el.remove());
    if (article._pfaIssues) article._pfaIssues = null;
  }

  function clearAll(keepDoneFlag) {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
      clearMarks(a);
      if (!keepDoneFlag) a.removeAttribute('data-pfa-done');
    });
    hideTip();
    closeActivePopover();
  }

  /* ── ۴) زیرخط زدن کلمات توییت‌های تایم‌لاین ─────────────── */
  function decorateText(textEl, text, issues) {
    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('a') || p.closest('.pfa-u')) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IMG') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    let base = 0;
    for (const node of nodes) {
      const idx = text.indexOf(node.nodeValue, base);
      const start = idx >= 0 ? idx : base;
      const end = start + node.nodeValue.length;
      const hits = issues.filter((i) => i.index < end && i.index + i.length > start);
      if (hits.length) wrapNode(node, start, hits);
      base = end;
    }
  }

  function wrapNode(node, nodeStart, hits) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const issue of hits) {
      const s = Math.max(issue.index - nodeStart, 0);
      const e = Math.min(issue.index + issue.length - nodeStart, text.length);
      if (s > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, s)));
      if (e > s) {
        const span = document.createElement('span');
        span.className =
          'pfa-u pfa-' + (issue.severity === 'hint' ? 'hint' : issue.severity === 'warning' ? 'warning' : 'error');
        span.textContent = text.slice(s, e);
        span.dataset.pfaWrong = issue.wrong;
        span.dataset.pfaCorrect = issue.correct;
        span.dataset.pfaReason = issue.reason;
        frag.appendChild(span);
        cursor = e;
      }
    }
    if (cursor <= text.length - 1) frag.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode.replaceChild(frag, node);
  }

  /* ── ۵) نشان روی توییت در تایم‌لاین ──────────────────────── */
  function addBadge(article, issues, soft) {
    if (article.querySelector('.pfa-badge')) return;
    const textEl = findTweetText(article);
    if (!textEl) return;

    const spellingCount = issues.filter(i => i.type === 'misspelling' || i.type === 'arabic' || i.type === 'heksare').length;
    const writingCount = issues.filter(i => i.type === 'zwnj' || i.type === 'tanwin').length;
    const styleCount = issues.filter(i => i.type === 'repeat').length;

    const parts = [];
    if (spellingCount) parts.push(toFa(spellingCount) + ' غلط املایی');
    if (writingCount) parts.push(toFa(writingCount) + ' نکته‌ی نگارشی');
    if (styleCount) parts.push(toFa(styleCount) + ' تکرار حرف');
    const label = parts.join(' · ');

    const badge = document.createElement('button');
    badge.className = 'pfa-badge' + (soft ? ' pfa-badge-soft' : '');
    badge.setAttribute('dir', 'rtl');
    badge.innerHTML = ICON_WARN + '<span>' + label + '</span>';
    badge.title = 'راست‌نویس — نمایش اصلاحات';
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(article);
    });
    textEl.insertAdjacentElement('afterend', badge);
  }

  /* ── ۶) پنل اصلاحات توییت‌های خوانده‌شده ─────────────────── */
  function togglePanel(article) {
    const existing = article.querySelector('.pfa-panel');
    if (existing) { existing.remove(); return; }
    const textEl = findTweetText(article);
    const data = article._pfaIssues;
    if (!textEl || !data) return;
    const panel = document.createElement('div');
    panel.className = 'pfa-panel';
    panel.innerHTML =
      '<h4>' + ICON_WARN + '<span>ویرایش پیشنهادی راست‌نویس</span></h4>' +
      data.issues.map((i) =>
        '<div class="pfa-item"><span class="w">' + esc(i.wrong) + '</span>' +
        ICON_ARROW +
        '<span class="c">' + esc(i.correct) + '</span><span class="r">' + esc(i.reason) + '</span></div>'
      ).join('') +
      '<div class="pfa-actions"><button class="pfa-btn pfa-btn-copy">کپی متن اصلاح‌شده</button>' +
      '<button class="pfa-btn pfa-btn-close">بستن</button></div>';

    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.querySelector('.pfa-btn-close').addEventListener('click', () => panel.remove());
    const copyBtn = panel.querySelector('.pfa-btn-copy');
    copyBtn.addEventListener('click', async () => {
      const fixed = engine.applyCorrections(data.text, data.issues);
      try {
        await navigator.clipboard.writeText(fixed);
        copyBtn.textContent = 'کپی شد';
        setTimeout(() => { copyBtn.textContent = 'کپی متن اصلاح‌شده'; }, 1600);
      } catch (e) { copyBtn.textContent = 'خطا در کپی'; }
    });
    textEl.insertAdjacentElement('afterend', panel);
  }

  /* ── ۷) تول‌تیپ کلیک روی کلمه ───────────────────────────── */
  let tipEl = null;
  function hideTip() {
    if (tipEl) { tipEl.remove(); tipEl = null; }
  }
  function showTip(span) {
    hideTip();
    tipEl = document.createElement('div');
    tipEl.className = 'pfa-tip';
    tipEl.innerHTML =
      '<span class="t-w">' + esc(span.dataset.pfaWrong) + '</span> ' +
      '<span style="display:inline-block;vertical-align:-1px;width:12px;height:12px;">' + ICON_ARROW + '</span> ' +
      '<b class="t-c">' + esc(span.dataset.pfaCorrect) + '</b>' +
      '<span class="t-r">' + esc(span.dataset.pfaReason) + '</span>';
    document.body.appendChild(tipEl);
    const r = span.getBoundingClientRect();
    const tw = tipEl.offsetWidth;
    let left = r.left + window.scrollX + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    tipEl.style.left = left + 'px';
    tipEl.style.top = r.bottom + window.scrollY + 8 + 'px';
  }

  document.addEventListener('click', (e) => {
    const span = e.target && e.target.closest ? e.target.closest('.pfa-u') : null;
    if (span) {
      e.preventDefault();
      e.stopPropagation();
      showTip(span);
      return;
    }
    if (tipEl && !(e.target && e.target.closest && e.target.closest('.pfa-tip'))) hideTip();
  }, true);
  window.addEventListener('scroll', hideTip, { passive: true, capture: true });

  /* ── ۸) اسکن توییت‌های تایم‌لاین ────────────────────────── */
  function scanTweet(article) {
    if (!cfg.enabled) return;
    if (article.hasAttribute('data-pfa-done')) return;
    article.setAttribute('data-pfa-done', '1');
    const textEl = findTweetText(article);
    if (!textEl) return;
    const text = textEl.textContent || '';
    if (!engine.isPersianText(text)) return;
    const issues = engine.checkText(text, cfg.includeHints, cfg.ignoredWords);
    const shown = cfg.includeHints ? issues : issues.filter((i) => i.severity !== 'hint');
    if (!shown.length) return;
    article._pfaIssues = { text, issues: shown };
    decorateText(textEl, text, shown);
    addBadge(article, shown, !shown.some((i) => i.severity === 'error'));
    queueStat();
  }

  let pendingMarks = 0;
  let statTimer = null;
  function queueStat() {
    pendingMarks++;
    if (statTimer) return;
    statTimer = setTimeout(() => {
      statTimer = null;
      const add = pendingMarks;
      pendingMarks = 0;
      try {
        chrome.storage.local.get({ marked: 0 }, (s) => chrome.storage.local.set({ marked: (s.marked || 0) + add }));
      } catch (e) { /* نادیده */ }
    }, 500);
  }

  /* ═══════════════════════════════════════════════════════════════
     ۹) بخش بررسی کامپوزر و دکمه کنار دکمه Post توییتر
  ═══════════════════════════════════════════════════════════════ */

  let activePopover = null;

  function closeActivePopover() {
    if (activePopover) {
      const ed = activePopover._editor;
      activePopover.remove();
      activePopover = null;
      if (ed && document.contains(ed)) {
        try { ed.focus(); } catch (e) {}
      }
    }
  }

  // یافتن ادیتور مرتبط با دکمه Post
  function findAssociatedEditor(postBtn) {
    if (!postBtn) return null;

    // ۱. بالا رفتن از والدها برای پیدا کردن نزدیک‌ترین کانتینر ادیتور این دکمه
    let current = postBtn.parentElement;
    while (current && current !== document.body) {
      const found =
        current.querySelector('[contenteditable="true"][role="textbox"]') ||
        current.querySelector('[data-testid^="tweetTextarea_"][contenteditable="true"]') ||
        current.querySelector('.public-DraftEditor-content[contenteditable="true"]') ||
        current.querySelector('[contenteditable="true"]');

      if (found) {
        return found;
      }
      current = current.parentElement;
    }

    // ۲. در پنجره بازشو (Modal) یا بدنه اصلی
    const modal =
      postBtn.closest('[role="dialog"]') ||
      postBtn.closest('[data-testid="primaryColumn"]') ||
      document;

    let fallback =
      modal.querySelector('[contenteditable="true"][role="textbox"]') ||
      modal.querySelector('[data-testid^="tweetTextarea_"][contenteditable="true"]') ||
      modal.querySelector('.public-DraftEditor-content[contenteditable="true"]') ||
      modal.querySelector('[contenteditable="true"]') ||
      modal.querySelector('[data-testid^="tweetTextarea_"]');

    if (fallback && fallback.getAttribute('contenteditable') !== 'true') {
      const inner = fallback.querySelector('[contenteditable="true"]');
      if (inner) fallback = inner;
    }

    return fallback;
  }

  // استخراج متن تمیز از ادیتور Draft.js / Lexical توییتر
  function getEditorText(editor) {
    if (!editor) return '';
    return (editor.innerText || editor.textContent || '')
      .replace(/​/g, '')
      .replace(/\r?\n$/, '');
  }

  // جایگزینی ایمن متن در ادیتور توییتر (همگام با React State و Draft.js/Lexical)
  function replaceEditorText(editor, newText) {
    if (!editor) return false;

    let target = editor;
    if (target.getAttribute('contenteditable') !== 'true') {
      const inner = target.querySelector('[contenteditable="true"]');
      if (inner) target = inner;
    }

    target.focus();

    // گام ۱: انتخاب تمام محتوا با دستور مرورگر
    try {
      document.execCommand('selectAll', false, null);
    } catch (e) {}

    // گام ۲: آماده‌سازی داده انتقال برای رویداد Paste
    const dt = new DataTransfer();
    dt.setData('text/plain', newText);
    dt.setData('text/html', `<span>${newText}</span>`);

    // گام ۳: ارسال رویداد قبل از درج (beforeinput - روش استاندارد Lexical و Draft.js مدرن)
    try {
      const beforeEv = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertFromPaste',
        dataTransfer: dt,
      });
      target.dispatchEvent(beforeEv);
    } catch (e) {}

    // گام ۴: ارسال رویداد Paste که هسته Draft.js و Lexical را به‌روزرسانی می‌کند
    try {
      const pasteEv = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
        dataType: 'text/plain',
        data: newText,
      });
      target.dispatchEvent(pasteEv);
    } catch (e) {}

    // گام ۵: درج مستقیم با دستور مرورگر
    try {
      document.execCommand('insertText', false, newText);
    } catch (e) {}

    // گام ۶: رویدادهای input و change برای همگام‌سازی بی‌درنگ React State
    try {
      target.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertFromPaste',
        data: newText,
      }));
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {}

    // گام ۷: کپی همزمان در کلیپ‌بورد برای اطمینان
    try {
      navigator.clipboard.writeText(newText);
    } catch (e) {}

    // بازگرداندن فوکوس به ادیتور تا کیبورد همواره فعال بماند
    try {
      target.focus();
    } catch (e) {}

    return true;
  }

  // ایجاد پاپ‌اور منوی بررسی
  function openComposerCheckMenu(btn, editor) {
    closeActivePopover();

    const text = getEditorText(editor);
    if (!text) {
      showComposerToast(btn, 'ابتدا متن توییت را بنویسید.');
      return;
    }

    const issues = engine.checkText(text, cfg.includeHints, cfg.ignoredWords);
    if (issues.length === 0) {
      showComposerToast(btn, '✓ متن شما کاملاً درست است و ایرادی ندارد.', 2800);
      return;
    }

    const popover = document.createElement('div');
    const themeClass = getTwitterTheme();
    popover.className = `pfa-composer-popover ${themeClass}`;
    popover._editor = editor;

    renderPopoverContent(popover, btn, editor, text);

    document.body.appendChild(popover);
    activePopover = popover;

    // موقعیت‌سنجی شناور هوشمند کنار دکمه
    positionPopover(popover, btn);

    // بستن با کلیک بیرون یا ESC
    const onDocClick = (e) => {
      if (activePopover && !activePopover.contains(e.target) && !btn.contains(e.target)) {
        closeActivePopover();
        document.removeEventListener('click', onDocClick, true);
      }
    };
    setTimeout(() => document.addEventListener('click', onDocClick, true), 10);
  }

  function positionPopover(popover, btn) {
    const r = btn.getBoundingClientRect();
    const pw = popover.offsetWidth || 350;
    const ph = popover.offsetHeight || 220;

    let left = r.right + window.scrollX - pw;
    if (left < 12) left = 12;
    if (left + pw > window.innerWidth - 12) left = window.innerWidth - pw - 12;

    // همیشه زیر دکمه و باکس توییت قرار گیرد تا به هیچ وجه روی متن توییت نیفتد
    let top = r.bottom + window.scrollY + 8;

    // فقط اگر در پایین صفحه اصلاً فضای کافی نبود بالای دکمه باز شود
    if (r.bottom + ph > window.innerHeight - 10 && r.top - ph > 10) {
      top = r.top + window.scrollY - ph - 8;
    }

    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  }

  function positionToast(toast, btn) {
    const r = btn.getBoundingClientRect();
    const tw = toast.offsetWidth || 220;
    const th = toast.offsetHeight || 32;

    let left = r.left + window.scrollX + (r.width / 2) - (tw / 2);
    if (left < 12) left = 12;
    if (left + tw > window.innerWidth - 12) left = window.innerWidth - tw - 12;

    // زیر دکمه در نوار پایینی
    let top = r.bottom + window.scrollY + 8;
    if (r.bottom + th > window.innerHeight - 10 && r.top - th > 10) {
      top = r.top + window.scrollY - th - 6;
    }

    toast.style.left = left + 'px';
    toast.style.top = top + 'px';
  }

  function showAutoFixToast(btn, editor, originalText) {
    closeActivePopover();

    const toast = document.createElement('div');
    const themeClass = getTwitterTheme();
    toast.className = `pfa-composer-toast ${themeClass}`;
    toast._editor = editor;

    toast.innerHTML = `
      <span style="color:#00ba7c;display:inline-flex;align-items:center;gap:4px;">${ICON_CHECK} متن اصلاح شد</span>
      <button class="pfa-toast-undo" id="pfaToastUndoBtn">بازگردانی (Undo)</button>
      <button class="pfa-toast-close" title="بستن">✕</button>
    `;

    document.body.appendChild(toast);
    activePopover = toast;
    positionToast(toast, btn);

    const undoBtn = toast.querySelector('#pfaToastUndoBtn');
    undoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      replaceEditorText(editor, originalText);
      delete editor._pfaOriginalText;
      toast.innerHTML = `<span style="color:#71767b;font-size:11.5px;">متن بازگردانی شد</span>`;
      positionToast(toast, btn);
      setTimeout(() => {
        if (activePopover === toast) closeActivePopover();
      }, 1500);
    });

    toast.querySelector('.pfa-toast-close').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeActivePopover();
    });

    setTimeout(() => {
      if (activePopover === toast) closeActivePopover();
    }, 6000);
  }

  function showComposerToast(btn, msg, duration = 2500) {
    closeActivePopover();
    const toast = document.createElement('div');
    const themeClass = getTwitterTheme();
    toast.className = `pfa-composer-toast ${themeClass}`;

    toast.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:5px;">${msg}</span>
      <button class="pfa-toast-close" title="بستن">✕</button>
    `;

    document.body.appendChild(toast);
    activePopover = toast;
    positionToast(toast, btn);

    toast.querySelector('.pfa-toast-close').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeActivePopover();
    });

    setTimeout(() => {
      if (activePopover === toast) closeActivePopover();
    }, duration);
  }

  function renderPopoverContent(popover, btn, editor, currentText) {
    const issues = engine.checkText(currentText, cfg.includeHints, cfg.ignoredWords);

    if (issues.length === 0) {
      const hasUndo = Boolean(editor && editor._pfaOriginalText);
      popover.innerHTML = `
        <div class="pfa-pop-header">
          <span class="pfa-pop-title">${ICON_FEATHER}بررسی راست‌نویس</span>
          <button class="pfa-pop-close" title="بستن">✕</button>
        </div>
        <div class="pfa-pop-clean">
          ${ICON_CHECK}
          <div>متن شما از نظر املایی و نگارشی کاملاً درست است و هیچ ایرادی ندارد. آماده‌ی انتشار!</div>
        </div>
        ${hasUndo ? `
          <div class="pfa-pop-actions" style="margin-top:12px;">
            <button class="pfa-btn-undo" id="pfaBtnUndo">بازگردانی متن قبلی (Undo)</button>
          </div>
        ` : ''}
      `;
      popover.querySelector('.pfa-pop-close').addEventListener('click', closeActivePopover);
      const undoBtn = popover.querySelector('#pfaBtnUndo');
      if (undoBtn) {
        undoBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const activeEditor = findAssociatedEditor(btn) || editor;
          if (activeEditor && activeEditor._pfaOriginalText) {
            const restored = activeEditor._pfaOriginalText;
            delete activeEditor._pfaOriginalText;
            replaceEditorText(activeEditor, restored);
            renderPopoverContent(popover, btn, activeEditor, restored);
            positionPopover(popover, btn);
          }
        });
      }
      return;
    }

    const hasUndo = Boolean(editor && editor._pfaOriginalText);

    popover.innerHTML = `
      <div class="pfa-pop-header">
        <span class="pfa-pop-title">${ICON_FEATHER}بررسی درست‌نویسی</span>
        <button class="pfa-pop-close" title="بستن">✕</button>
      </div>

      <div class="pfa-pop-summary">
        <span class="pfa-badge-pill">${toFa(issues.length)} مورد</span>
        <span>خطاهای شناسایی‌شده در متن:</span>
      </div>

      <div class="pfa-pop-list">
        ${issues.map((i, idx) => `
          <div class="pfa-pop-item">
            <div class="pfa-item-main">
              <div class="pfa-item-words">
                <span class="pfa-w">${esc(i.wrong)}</span>
                <span class="pfa-arrow">←</span>
                <span class="pfa-c">${esc(i.correct)}</span>
              </div>
              <div class="pfa-item-reason">${esc(i.reason)}</div>
            </div>
            <div class="pfa-item-btns">
              <button class="pfa-btn-item-copy" data-copy="${esc(i.correct)}" title="کپی این واژه">کپی</button>
              <button class="pfa-btn-ignore" data-idx="${idx}" title="افزودن به واژه‌نامه شخصی">نادیده</button>
            </div>
          </div>
        `).join('')}
      </div>

      <div class="pfa-pop-actions">
        <button class="pfa-btn-autofix" id="pfaBtnAutoFix">اصلاح خودکار در ادیتور</button>
        <button class="pfa-btn-copy-comp" id="pfaBtnCopy">کپی متن اصلاح‌شده</button>
        ${hasUndo ? '<button class="pfa-btn-undo" id="pfaBtnUndo">بازگردانی (Undo)</button>' : ''}
      </div>
      <div id="pfaToastMsg" class="pfa-toast-msg" style="display:none;"></div>
    `;

    popover.querySelector('.pfa-pop-close').addEventListener('click', closeActivePopover);

    // کپی تک‌واژه اصلاح‌شده
    popover.querySelectorAll('.pfa-btn-item-copy').forEach((copyWordBtn) => {
      copyWordBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wordToCopy = copyWordBtn.dataset.copy;
        if (!wordToCopy) return;
        try {
          await navigator.clipboard.writeText(wordToCopy);
          const orig = copyWordBtn.textContent;
          copyWordBtn.textContent = 'کپی شد';
          copyWordBtn.style.color = '#00ba7c';
          copyWordBtn.style.borderColor = '#00ba7c';
          setTimeout(() => {
            copyWordBtn.textContent = orig;
            copyWordBtn.style.color = '';
            copyWordBtn.style.borderColor = '';
          }, 1400);
        } catch (err) {
          copyWordBtn.textContent = 'خطا';
        }
      });
    });

    // نادیده گرفتن کلمه
    popover.querySelectorAll('.pfa-btn-ignore').forEach((ignBtn) => {
      ignBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(ignBtn.dataset.idx);
        const item = issues[idx];
        if (!item) return;
        const word = item.wrong.trim();
        if (!cfg.ignoredWords.includes(word)) {
          cfg.ignoredWords.push(word);
          chrome.storage.sync.set({ ignoredWords: cfg.ignoredWords }, () => {
            renderPopoverContent(popover, btn, editor, getEditorText(editor));
            positionPopover(popover, btn);
          });
        }
      });
    });

    // اصلاح خودکار در ادیتور توییتر
    const autoFixBtn = popover.querySelector('#pfaBtnAutoFix');
    if (autoFixBtn) {
      autoFixBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const activeEditor = findAssociatedEditor(btn) || editor;
        if (!activeEditor) {
          showComposerToast(btn, 'ادیتور توییت یافت نشد.');
          return;
        }

        const latestText = getEditorText(activeEditor);
        const latestIssues = engine.checkText(latestText, cfg.includeHints, cfg.ignoredWords);
        if (!latestIssues.length) {
          closeActivePopover();
          return;
        }

        // ذخیره برای آندو
        activeEditor._pfaOriginalText = latestText;
        const fixed = engine.applyCorrections(latestText, latestIssues);

        replaceEditorText(activeEditor, fixed);

        // بستن پاپ‌آپ بزرگ تا روی متن توییت نیفتد
        closeActivePopover();

        // نمایش مینی‌توست باریک در پایین کنار دکمه بدون پوشاندن توییت
        showAutoFixToast(btn, activeEditor, latestText);
      });
    }

    // کپی متن اصلاح‌شده
    const copyBtn = popover.querySelector('#pfaBtnCopy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const activeEditor = findAssociatedEditor(btn) || editor;
        const latestText = getEditorText(activeEditor);
        const fixed = engine.applyCorrections(latestText, issues);
        try {
          await navigator.clipboard.writeText(fixed);
          const orig = copyBtn.textContent;
          copyBtn.textContent = 'کپی شد!';
          setTimeout(() => { copyBtn.textContent = orig; }, 1500);
        } catch (err) {
          copyBtn.textContent = 'خطا در کپی';
        }
      });
    }

    // بازگردانی متن قبلی (Undo)
    const undoBtn = popover.querySelector('#pfaBtnUndo');
    if (undoBtn) {
      undoBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const activeEditor = findAssociatedEditor(btn) || editor;
        if (activeEditor && activeEditor._pfaOriginalText) {
          const restored = activeEditor._pfaOriginalText;
          delete activeEditor._pfaOriginalText;
          replaceEditorText(activeEditor, restored);
          renderPopoverContent(popover, btn, activeEditor, restored);
          positionPopover(popover, btn);
        }
      });
    }
  }

  function showComposerToast(btn, msg) {
    closeActivePopover();
    const tip = document.createElement('div');
    const themeClass = getTwitterTheme();
    tip.className = `pfa-composer-popover ${themeClass}`;
    tip.style.width = 'auto';
    tip.style.padding = '8px 14px';
    tip.style.fontSize = '12.5px';
    tip.style.textAlign = 'center';
    tip.textContent = msg;

    document.body.appendChild(tip);
    activePopover = tip;
    positionPopover(tip, btn);

    setTimeout(() => {
      if (activePopover === tip) closeActivePopover();
    }, 2000);
  }

  // یافتن ردیف افقی اصلی دکمه Post تا دکمه حتماً در کنار آن قرار گیرد
  function findRowPlacement(postBtn) {
    let el = postBtn;
    while (el && el !== document.body) {
      const parent = el.parentElement;
      if (!parent) break;

      const style = window.getComputedStyle(parent);
      const isFlexRow =
        style.display.includes('flex') &&
        (style.flexDirection === 'row' || style.flexDirection === 'row-reverse');

      if (isFlexRow) {
        return { container: parent, target: el };
      }

      // اگر والد نوار ابزار اصلی باشد
      if (
        parent.getAttribute('role') === 'toolbar' ||
        parent.getAttribute('data-testid') === 'toolBar'
      ) {
        return { container: parent, target: el };
      }

      el = parent;
      if (
        el.matches &&
        (el.matches('[data-testid="tweetBox"]') ||
          el.matches('form') ||
          el.matches('[role="dialog"]'))
      ) {
        break;
      }
    }

    // حالت پیش‌فرض
    return { container: postBtn.parentElement, target: postBtn };
  }

  // تزریق دکمه کنار دکمه Post
  function injectComposerButton(postBtn) {
    if (!cfg.enabled) return;

    // جلوگیری از درج مجدد در همین کامپوزر
    const root =
      postBtn.closest('[data-testid="tweetBox"]') ||
      postBtn.closest('[role="dialog"]') ||
      postBtn.closest('form') ||
      postBtn.closest('[data-testid="toolBar"]') ||
      postBtn.parentElement;

    if (root && root.querySelector('.pfa-post-check-btn')) return;

    const placement = findRowPlacement(postBtn);
    if (!placement || !placement.container) return;
    if (placement.container.querySelector('.pfa-post-check-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pfa-post-check-btn';
    btn.title = 'راست‌نویس — بررسی درست‌نویسی پیش از انتشار';
    btn.innerHTML = `${ICON_FEATHER}<span>راست‌نویس</span>`;

    // جلوگیری از تغییر فوکوس و گم‌شدن مکان‌نما در ادیتور توییتر
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const editor = findAssociatedEditor(postBtn);
      openComposerCheckMenu(btn, editor);
    });

    // تضمین چیدمان ردیفی افقی و عدم شکست خط
    placement.container.style.setProperty('display', 'flex', 'important');
    placement.container.style.setProperty('flex-direction', 'row', 'important');
    placement.container.style.setProperty('align-items', 'center', 'important');
    placement.container.style.setProperty('flex-wrap', 'nowrap', 'important');

    // قرار دادن دکمه در همان ردیف کنار دکمه Post
    placement.container.insertBefore(btn, placement.target);
  }

  function removeComposerButtons() {
    document.querySelectorAll('.pfa-post-check-btn').forEach((b) => b.remove());
    closeActivePopover();
  }

  function scanComposers() {
    if (!cfg.enabled) return;
    const postButtons = document.querySelectorAll(
      '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]'
    );
    postButtons.forEach(injectComposerButton);
  }

  /* ── ۱۰) حلقه زمان‌بندی و ناظر رویدادها ──────────────────── */
  let scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      scanAll();
    }, 350);
  }

  function scanAll() {
    if (!cfg.enabled) return;
    try {
      // ۱. اسکن توییت‌های تایم‌لاین
      document
        .querySelectorAll('article[data-testid="tweet"]:not([data-pfa-done])')
        .forEach(scanTweet);

      // ۲. اسکن ادیتورها و دکمه‌های Post
      scanComposers();
    } catch (e) { /* نادیده */ }
  }

  // بستن منو در صورت فشردن Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeActivePopover();
      hideTip();
    }
  });

  /* ── ۱۱) راه‌اندازی ──────────────────────────────────────── */
  loadConfig();

  const start = () => {
    scanAll();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
