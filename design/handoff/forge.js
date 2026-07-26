/* Forge — handoff demo wiring. CSP-safe: external file, addEventListener only,
   no eval, no inline handlers, no element.style writes (class/attribute toggles only). */
(function () {
  'use strict';

  var body = document.body;
  var OVERLAYS = ['usage', 'hist', 'proj', 'settings'];

  /* ---------- screen routing ---------- */
  function applyScreen(s) {
    body.setAttribute('data-screen', s);
    var els = document.querySelectorAll('[data-when]');
    for (var i = 0; i < els.length; i++) {
      var tokens = els[i].getAttribute('data-when').split(/\s+/);
      els[i].hidden = tokens.indexOf(s) === -1;
    }
    var sel = document.getElementById('demo-screen');
    if (sel && sel.value !== s) sel.value = s;
  }
  applyScreen(body.getAttribute('data-screen') || 'mid');

  var demoSel = document.getElementById('demo-screen');
  if (demoSel) demoSel.addEventListener('change', function () { applyScreen(demoSel.value); });

  /* ---------- delegation: navigation + approvals + theme ---------- */
  document.addEventListener('click', function (e) {
    var go = e.target.closest('[data-go]');
    if (go) { applyScreen(go.getAttribute('data-go')); closePalette(); return; }

    var th = e.target.closest('[data-theme-set]');
    if (th) { setTheme(th.getAttribute('data-theme-set')); closePalette(); return; }

    var ap = e.target.closest('[data-approve]');
    if (ap) { handleApprove(ap.getAttribute('data-approve')); return; }

    var pm = e.target.closest('.radio-row[data-pm]');
    if (pm) { pickRadio(pm, '.radio-row[data-pm]'); updatePmChip(pm.getAttribute('data-pm')); return; }

    var prov = e.target.closest('.provider[role="radio"]');
    if (prov) { pickRadio(prov, '.provider[role="radio"]'); return; }

    var file = e.target.closest('[data-file]');
    if (file) { selectFile(file.getAttribute('data-file')); return; }
  });

  function pickRadio(el, selector) {
    var all = document.querySelectorAll(selector);
    for (var i = 0; i < all.length; i++) all[i].setAttribute('aria-checked', 'false');
    el.setAttribute('aria-checked', 'true');
  }

  function updatePmChip(mode) {
    var labels = { ro: 'Read-only', ask: 'Ask for everything', edits: 'Edits auto · commands ask', all: 'Auto-allow all' };
    var chip = document.querySelector('.composer-foot .statuschip');
    if (chip) chip.textContent = (labels[mode] || mode) + ' ▾';
  }

  /* ---------- theme ---------- */
  function setTheme(v) {
    var root = document.documentElement;
    if (v === 'toggle') {
      var cur = root.getAttribute('data-theme');
      var dark = cur ? cur === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
      v = dark ? 'light' : 'dark';
    }
    if (v === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', v);
    var segs = document.querySelectorAll('[data-theme-set]');
    for (var i = 0; i < segs.length; i++) {
      var val = segs[i].getAttribute('data-theme-set');
      if (val === 'toggle') continue;
      segs[i].setAttribute('aria-pressed', String(val === (root.getAttribute('data-theme') || 'system')));
    }
  }

  /* ---------- approvals ---------- */
  function show(id, on) { var el = document.getElementById(id); if (el) el.hidden = !on; }
  function handleApprove(action) {
    switch (action) {
      case 'a-allow': show('approve-a', false); show('resolved-a', true); show('approve-q', true); break;
      case 'a-deny': show('approve-a', false); show('denied-a', true); break;
      case 'q-allow': show('approve-q', false); show('resolved-q', true); break;
      case 'q-deny': show('approve-q', false); show('denied-q', true); break;
      case 'd-allow': show('approve-d', false); show('resolved-d', true); break;
      case 'd-deny': show('approve-d', false); show('denied-d', true); break;
    }
  }

  /* dangerous command: type-to-arm — the button stays dead until the folder name is typed */
  var armInput = document.getElementById('arm-input');
  var armBtn = document.getElementById('arm-btn');
  if (armInput && armBtn) {
    armInput.addEventListener('input', function () {
      armBtn.disabled = armInput.value.trim().toLowerCase() !== 'build';
    });
  }

  /* ---------- review panel: file select / revert / commit ---------- */
  var reverted = { a: false, b: false };
  var selected = 'a';
  function selectFile(f) {
    selected = f;
    var fa = document.getElementById('file-a'), fb = document.getElementById('file-b');
    if (fa) fa.classList.toggle('file-item--selected', f === 'a');
    if (fb) fb.classList.toggle('file-item--selected', f === 'b');
    show('diff-a', f === 'a'); show('diff-b', f === 'b');
    show('revert-note', reverted[f]);
  }
  function wireRevert(id, key, fileId) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', function () {
      reverted[key] = !reverted[key];
      var row = document.getElementById(fileId);
      if (row) row.classList.toggle('file-item--reverted', reverted[key]);
      btn.title = reverted[key] ? 'Restore this edit' : 'Revert this file';
      selectFile(key);
    });
  }
  wireRevert('revert-a', 'a', 'file-a');
  wireRevert('revert-b', 'b', 'file-b');
  var restoreBtn = document.getElementById('restore-btn');
  if (restoreBtn) restoreBtn.addEventListener('click', function () {
    reverted[selected] = false;
    var row = document.getElementById('file-' + selected);
    if (row) row.classList.remove('file-item--reverted');
    show('revert-note', false);
  });
  var commitOpen = document.getElementById('commit-open');
  var commitDo = document.getElementById('commit-do');
  if (commitOpen) commitOpen.addEventListener('click', function () { show('commit-row', true); commitOpen.hidden = true; });
  if (commitDo) commitDo.addEventListener('click', function () { show('commit-row', false); show('committed', true); show('commit-actions', false); });

  /* ---------- shell output expand ---------- */
  var shellExpand = document.getElementById('shell-expand');
  if (shellExpand) shellExpand.addEventListener('click', function () {
    var out = document.getElementById('shell-out');
    var on = out.classList.toggle('expanded');
    shellExpand.textContent = on ? 'collapse output' : 'show all 187 lines';
  });

  /* ---------- command palette ---------- */
  var palette = document.getElementById('palette');
  var palScrim = document.getElementById('pal-scrim');
  var palInput = document.getElementById('pal-input');
  function openPalette() { if (!palette) return; palette.hidden = false; palScrim.hidden = false; palInput.value = ''; filterPalette(); palInput.focus(); }
  function closePalette() { if (!palette || palette.hidden) return; palette.hidden = true; palScrim.hidden = true; }
  function filterPalette() {
    var q = palInput.value.trim().toLowerCase(), any = false;
    var items = palette.querySelectorAll('.pal-item');
    for (var i = 0; i < items.length; i++) {
      var hit = !q || items[i].textContent.toLowerCase().indexOf(q) !== -1;
      items[i].hidden = !hit; if (hit) any = true;
    }
    show('pal-empty', !any);
  }
  if (palInput) palInput.addEventListener('input', filterPalette);
  if (palScrim) palScrim.addEventListener('click', closePalette);

  /* ---------- sidebar: collapse + thread search ---------- */
  var sidebar = document.getElementById('sidebar');
  var sbToggle = document.getElementById('sb-toggle');
  function toggleSidebar() { if (sidebar) sidebar.classList.toggle('collapsed'); }
  if (sbToggle) sbToggle.addEventListener('click', toggleSidebar);
  var sbSearch = document.getElementById('sb-search');
  if (sbSearch) sbSearch.addEventListener('input', function () {
    var q = sbSearch.value.trim().toLowerCase(), any = false;
    var rows = sidebar.querySelectorAll('.sb-thread');
    for (var i = 0; i < rows.length; i++) {
      var hit = !q || rows[i].textContent.toLowerCase().indexOf(q) !== -1;
      rows[i].hidden = !hit; if (hit) any = true;
    }
    var empty = document.getElementById('sb-empty');
    if (empty) empty.hidden = any;
  });

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.hidden ? openPalette() : closePalette(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); return; }
    if (e.key === 'Escape') {
      if (palette && !palette.hidden) { closePalette(); return; }
      var s = body.getAttribute('data-screen');
      if (OVERLAYS.indexOf(s) !== -1 || s === 'review') applyScreen('done');
    }
  });

  /* ---------- composer autosize ---------- */
  var ta = document.getElementById('composer-input');
  if (ta) ta.addEventListener('input', function () {
    ta.rows = 1;
    var lines = Math.min(8, Math.ceil((ta.scrollHeight - 18) / 20));
    ta.rows = Math.max(1, lines);
  });

  /* ---------- demo elapsed ticker ---------- */
  var t0 = 252; // 4:12
  setInterval(function () {
    if (body.getAttribute('data-screen') !== 'mid') return;
    t0++;
    var m = Math.floor(t0 / 60), s = String(t0 % 60).padStart(2, '0');
    var els = document.querySelectorAll('[data-elapsed]');
    for (var i = 0; i < els.length; i++) els[i].textContent = m + ':' + s;
  }, 1000);
})();
