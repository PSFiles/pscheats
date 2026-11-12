/**
 * PS Cheats v2.0 — Fast, static PlayStation cheat code browser & exporter.
 * Zero external dependencies.
 */
(function () {
  'use strict';

  // DOM Elements
  const $ = (id) => document.getElementById(id);
  const $q = $('q');
  const $form = $('search-form');
  const $clear = $('clear');
  const $platforms = $('platforms');
  const $regions = $('regions');
  const $sort = $('sort');
  const $stats = $('stats');
  const $status = $('status');
  const $list = $('list');
  const $more = $('more');
  const $quickTags = $('quick-tags');
  const $toast = $('toast');

  // View toggles
  const $btnCards = $('btn-view-cards');
  const $btnCompact = $('btn-view-compact');

  // Drawer Elements
  const $drawer = $('drawer');
  const $drawerBody = $('drawer-body');
  const $drawerTitle = $('drawer-title');
  const $drawerMeta = $('drawer-meta');
  const $backdrop = $('backdrop');
  const $drawerClose = $('drawer-close');
  const $drawerSearch = $('drawer-search');
  const $btnDownload = $('btn-download-cheat');
  const $btnCopyAll = $('btn-copy-all');
  const $btnShare = $('btn-share-game');
  const $downloadLabel = $('download-btn-label');

  // Guide Dialog Elements
  const $btnGuide = $('btn-guide');
  const $guideDialog = $('guide-dialog');
  const $guideClose = $('guide-close');
  const $guideCloseBtn = $('guide-close-btn');
  const $langEn = $('lang-en');
  const $langPt = $('lang-pt');

  const PAGE_CHUNK = 60;

  // Application State
  const State = {
    games: [],
    filtered: [],
    tokens: [],
    query: '',
    platforms: new Set(),
    regions: new Set(),
    sort: 'title',
    viewMode: localStorage.getItem('pscheats_view') || 'cards',
    shown: 0,
    cache: new Map(),
    activeGame: null,
    activeDetail: null,
    drawerFilter: '',
    guideLang: localStorage.getItem('pscheats_lang') || 'en',
    totals: { games: 0, cheats: 0 },
  };

  const nf = new Intl.NumberFormat('en-US');
  const collator = new Intl.Collator('en-US', { sensitivity: 'base', numeric: true });

  /* ----------------------------------------------------------- DOM Helpers -- */

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (val == null || val === false) continue;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key.startsWith('on') && typeof val === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else {
          node.setAttribute(key, val);
        }
      }
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function badge(text, typeClass) {
    return el('span', { class: `badge ${typeClass ? 'badge-' + typeClass : ''}`, text });
  }

  let toastTimer = null;
  function showToast(message) {
    if (!$toast) return;
    $toast.textContent = message;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      $toast.hidden = true;
    }, 2400);
  }

  function copyText(text, successMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => {
        showToast(successMsg || 'Copied to clipboard');
      }).catch(() => fallbackCopy(text, successMsg));
    }
    fallbackCopy(text, successMsg);
  }

  function fallbackCopy(text, successMsg) {
    const ta = el('textarea', { style: 'position:fixed;top:0;left:0;opacity:0;' });
    ta.value = text;
    document.body.append(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      showToast(successMsg || 'Copied to clipboard');
    } catch {
      showToast('Could not copy automatically');
    }
    ta.remove();
  }

  /* ------------------------------------------------------------- URL State -- */

  function readUrlHash() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return;

    if (raw.startsWith('g=')) {
      State.activeGame = decodeURIComponent(raw.slice(2));
      return;
    }

    const params = new URLSearchParams(raw);
    if (params.has('q')) State.query = params.get('q');
    if (params.has('p')) {
      State.platforms = new Set(
        params.get('p').split(',')
          .map((p) => p.trim().toUpperCase())
          .filter((p) => /^(PS3|PS4|PS5|PSV)$/.test(p))
      );
    }
    if (params.has('r')) {
      State.regions = new Set(
        params.get('r').split(',')
          .map((r) => r.trim().toUpperCase())
          .filter((r) => /^(EUR|USA|JPN|ASIA|KOR)$/.test(r))
      );
    }
    if (params.has('s')) State.sort = params.get('s');
    if (params.has('v')) State.viewMode = params.get('v') === 'compact' ? 'compact' : 'cards';
    if (params.has('g')) State.activeGame = params.get('g');
  }

  function writeUrlHash() {
    if (State.activeGame) {
      history.replaceState(null, '', '#g=' + encodeURIComponent(State.activeGame));
      return;
    }

    const params = new URLSearchParams();
    if (State.query) params.set('q', State.query);
    if (State.platforms.size) params.set('p', [...State.platforms].sort().join(','));
    if (State.regions.size) params.set('r', [...State.regions].sort().join(','));
    if (State.sort !== 'title') params.set('s', State.sort);
    if (State.viewMode !== 'cards') params.set('v', State.viewMode);

    const qs = params.toString();
    const next = qs ? '#' + qs : location.pathname + location.search;
    history.replaceState(null, '', next);
  }

  /* ------------------------------------------------------------ UI Syncing -- */

  function syncControls() {
    $q.value = State.query;
    $clear.hidden = !State.query;
    $sort.value = State.sort;

    // Platform chips
    for (const chip of $platforms.querySelectorAll('.chip')) {
      const p = chip.dataset.p;
      const isSelected = p ? State.platforms.has(p) : State.platforms.size === 0;
      chip.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }

    // Region chips
    for (const chip of $regions.querySelectorAll('.chip')) {
      const r = chip.dataset.r;
      const isSelected = r ? State.regions.has(r) : State.regions.size === 0;
      chip.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }

    // View mode switch
    applyViewMode(State.viewMode, false);
  }

  function applyViewMode(mode, save = true) {
    State.viewMode = mode;
    if (save) localStorage.setItem('pscheats_view', mode);

    if (mode === 'compact') {
      $list.classList.remove('view-cards');
      $list.classList.add('view-compact');
      $btnCompact.classList.add('active');
      $btnCompact.setAttribute('aria-pressed', 'true');
      $btnCards.classList.remove('active');
      $btnCards.setAttribute('aria-pressed', 'false');
    } else {
      $list.classList.remove('view-compact');
      $list.classList.add('view-cards');
      $btnCards.classList.add('active');
      $btnCards.setAttribute('aria-pressed', 'true');
      $btnCompact.classList.remove('active');
      $btnCompact.setAttribute('aria-pressed', 'false');
    }
  }

  function parseQuery() {
    State.query = $q.value.trim();
    State.tokens = State.query.toLowerCase().split(/\s+/).filter(Boolean);
    $clear.hidden = !State.query;
  }

  /* ----------------------------------------------------- Search & Filtering -- */

  function matchGame(game) {
    if (!State.tokens.length) return [];
    const matchedCheats = [];

    for (const token of State.tokens) {
      if (game._hay.includes(token)) continue;

      let found = null;
      for (let i = 0; i < game._names.length; i++) {
        if (game._names[i].includes(token)) {
          found = game.n[i];
          break;
        }
      }

      if (!found) return null; // token not satisfied in either metadata or cheat names
      if (!matchedCheats.includes(found)) matchedCheats.push(found);
    }

    return matchedCheats;
  }

  function applyFilters() {
    const results = [];

    for (const game of State.games) {
      if (State.platforms.size && !State.platforms.has(game.p)) continue;
      if (State.regions.size && !State.regions.has(game.r || '')) continue;

      const matchedNames = matchGame(game);
      if (matchedNames === null) continue;

      results.push({ game, matchedNames });
    }

    // Sort
    if (State.sort === 'cheats') {
      results.sort((a, b) => b.game.c - a.game.c || collator.compare(a.game.t, b.game.t));
    } else if (State.sort === 'serial') {
      results.sort((a, b) => collator.compare(a.game.s || a.game.i, b.game.s || b.game.i));
    } else if (State.sort === 'platform') {
      results.sort((a, b) => collator.compare(a.game.p, b.game.p) || collator.compare(a.game.t, b.game.t));
    } else {
      results.sort((a, b) => collator.compare(a.game.t, b.game.t));
    }

    State.filtered = results;
    State.shown = 0;
    $list.textContent = '';
    $more.textContent = '';

    if (!results.length) {
      $status.textContent = State.query || State.platforms.size || State.regions.size
        ? 'No PlayStation games found matching the active filters.'
        : 'No games available.';
      renderMore();
      return;
    }

    const platformLabel = State.platforms.size ? ` on ${[...State.platforms].sort().join(', ')}` : '';
    const regionLabel = State.regions.size ? ` in ${[...State.regions].sort().join(', ')}` : '';
    const queryLabel = State.query ? ` for “${State.query}”` : '';

    $status.textContent = `${nf.format(results.length)} ${results.length === 1 ? 'game' : 'games'}${queryLabel}${platformLabel}${regionLabel}`;
    renderChunk();
  }

  /* -------------------------------------------------------- Render Listings -- */

  function renderChunk() {
    const slice = State.filtered.slice(State.shown, State.shown + PAGE_CHUNK);
    const frag = document.createDocumentFragment();

    for (const item of slice) {
      frag.append(renderCard(item));
    }

    $list.append(frag);
    State.shown += slice.length;
    renderMore();
  }

  function renderMore() {
    $more.textContent = '';
    const remaining = State.filtered.length - State.shown;
    if (remaining <= 0) return;

    const btn = el('button', {
      type: 'button',
      class: 'btn btn-outline',
      onclick: () => renderChunk(),
      text: `Load more (${nf.format(remaining)} left)`,
    });
    $more.append(btn);
  }

  function renderCard({ game, matchedNames }) {
    const badges = [
      badge(game.p, game.p.toLowerCase()),
    ];
    if (game.s) badges.push(badge(game.s, 'serial'));
    if (game.r) badges.push(badge(game.r, 'region'));

    const title = game.t || game.s || game.i;
    const cheatCount = `${nf.format(game.c)} ${game.c === 1 ? 'cheat' : 'cheats'}`;

    const card = el('li', { class: 'game-item' },
      el('button', {
        type: 'button',
        class: 'game-card',
        'data-id': game.i,
        onclick: () => openGame(game.i),
      },
        el('div', { class: 'card-top' },
          el('div', { class: 'card-title', title, text: title }),
          el('span', { class: 'card-count-badge', text: cheatCount })
        ),
        el('div', { class: 'card-badge-row' }, badges),
        matchedNames && matchedNames.length
          ? el('div', { class: 'card-names-preview', text: matchedNames.slice(0, 3).join(' · ') })
          : null
      )
    );

    return card;
  }

  function srcLabel(id) {
    return ({
      'game-cheats': 'game-cheats',
      artemis: 'ArtemisDB',
      goldhen: 'GoldHEN',
      hen5: 'HEN',
      vitacheats: 'VitaCheat',
    })[id] || id;
  }

  /* ---------------------------------------------------- Drawer / Detail View -- */

  async function openGame(id) {
    if (!id) return;
    State.activeGame = id;
    $drawer.classList.add('open');
    $drawer.setAttribute('aria-hidden', 'false');
    $backdrop.hidden = false;
    document.body.style.overflow = 'hidden';

    const game = State.games.find((g) => g.i === id);
    $drawerTitle.textContent = game ? game.t : id;
    $drawerMeta.textContent = '';
    $drawerSearch.value = '';
    State.drawerFilter = '';

    if (game) {
      $drawerMeta.append(
        badge(game.p, game.p.toLowerCase()),
        game.s ? badge(game.s, 'serial') : null,
        game.r ? badge(game.r, 'region') : null
      );
      updateDownloadButton(game.p);
    }

    $drawerBody.textContent = '';
    $drawerBody.append(el('div', { class: 'status-message', text: 'Loading cheat codes…' }));

    writeUrlHash();

    try {
      let detail = State.cache.get(id);
      if (!detail) {
        const res = await fetch(`data/g/${encodeURIComponent(id)}.json`, { cache: 'force-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        detail = await res.json();
        State.cache.set(id, detail);
      }
      if (State.activeGame !== id) return;
      State.activeDetail = detail;
      renderDetail(detail);
    } catch (err) {
      $drawerBody.textContent = '';
      $drawerBody.append(el('p', { class: 'status-message', text: 'Could not load cheats: ' + err.message }));
    }
  }

  function updateDownloadButton(platform) {
    const ext = platform === 'PS3' ? '.ncl (Artemis)' : (platform === 'PSV' ? '.psv (VitaCheat)' : '.json (GoldHEN)');
    $downloadLabel.textContent = `Download ${ext}`;
  }

  function renderDetail(detail) {
    $drawerTitle.textContent = detail.title || detail.serial || detail.id;
    $drawerMeta.textContent = '';

    $drawerMeta.append(
      badge(detail.platform, detail.platform.toLowerCase()),
      detail.serial ? badge(detail.serial, 'serial') : null,
      detail.region ? badge(detail.region, 'region') : null,
      el('span', { class: 'badge', text: `${nf.format(detail.cheats.length)} cheats` })
    );

    $drawerBody.textContent = '';

    // Upstream Sources Box
    if (Array.isArray(detail.files) && detail.files.length) {
      const links = detail.files.map((f) =>
        el('a', {
          href: f.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: f.f,
          text: `${srcLabel(f.s)}${f.v ? ' v' + f.v : ''} ↗`,
        })
      );
      $drawerBody.append(
        el('div', { class: 'source-links-box' },
          el('span', { class: 'source-links-label', text: 'Source repos:' }),
          ...links
        )
      );
    }

    // Filter Cheats within game if search term entered
    const term = State.drawerFilter.trim().toLowerCase();
    const visibleCheats = term
      ? detail.cheats.filter((c) =>
          c.n.toLowerCase().includes(term) ||
          (c.d && c.d.toLowerCase().includes(term)) ||
          (c.a && c.a.toLowerCase().includes(term)) ||
          (c.l && c.l.some((line) => line.toLowerCase().includes(term)))
        )
      : detail.cheats;

    if (!visibleCheats.length) {
      $drawerBody.append(el('p', { class: 'status-message', text: `No cheats found matching “${term}”.` }));
      return;
    }

    // Grouping by version if multiple versions exist
    const versions = [...new Set(visibleCheats.map((c) => c.v).filter(Boolean))].sort();
    const isMultiVersion = versions.length > 1;

    if (isMultiVersion) {
      for (const ver of versions) {
        const verCheats = visibleCheats.filter((c) => c.v === ver);
        if (!verCheats.length) continue;
        $drawerBody.append(
          el('h3', { class: 'cheat-group-heading', text: `Version ${ver} (${verCheats.length})` })
        );
        for (const c of verCheats) $drawerBody.append(renderCheatItem(c));
      }
      const unversioned = visibleCheats.filter((c) => !c.v);
      if (unversioned.length) {
        $drawerBody.append(
          el('h3', { class: 'cheat-group-heading', text: `Universal / Unspecified Version (${unversioned.length})` })
        );
        for (const c of unversioned) $drawerBody.append(renderCheatItem(c));
      }
    } else {
      for (const c of visibleCheats) {
        $drawerBody.append(renderCheatItem(c));
      }
    }
  }

  function renderCheatItem(cheat) {
    const codeLines = (cheat.l || []).join('\n');

    const copyBtn = el('button', {
      type: 'button',
      class: 'copy-btn',
      title: 'Copy this cheat code',
      onclick: () => {
        copyText(codeLines, `Copied: ${cheat.n}`);
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('done');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('done');
        }, 1400);
      },
      text: 'Copy',
    });

    return el('article', { class: 'cheat-card' },
      el('div', { class: 'cheat-header' },
        el('div', null,
          el('div', { class: 'cheat-title', text: cheat.n }),
          cheat.d ? el('p', { class: 'cheat-desc', text: cheat.d }) : null,
          cheat.a ? el('p', { class: 'cheat-author-tag', text: 'Author: ' + cheat.a }) : null
        ),
        codeLines ? copyBtn : null
      ),
      codeLines ? el('pre', { class: 'code-display', text: codeLines }) : null
    );
  }

  function closeDrawer() {
    State.activeGame = null;
    State.activeDetail = null;
    $drawer.classList.remove('open');
    $drawer.setAttribute('aria-hidden', 'true');
    $backdrop.hidden = true;
    document.body.style.overflow = '';
    writeUrlHash();
  }

  /* ------------------------------------------------------- Export / Actions -- */

  function exportCurrentGameFile() {
    const detail = State.activeDetail;
    if (!detail) return;

    const platform = detail.platform;
    const serial = detail.serial || 'UNKNOWN';
    const title = detail.title || 'Cheats';
    let content = '';
    let filename = '';
    let mime = 'text/plain;charset=utf-8';

    if (platform === 'PS3') {
      // Artemis .ncl format
      filename = `${title.replace(/[^A-Za-z0-9_ -]/g, '').trim()} ${serial}.ncl`;
      const blocks = [];
      for (const c of detail.cheats) {
        const lines = [c.n, c.a || 'Community', ...(c.l || [])];
        blocks.push(lines.join('\n'));
      }
      content = blocks.join('\n#\n') + '\n#\n';
    } else if (platform === 'PSV') {
      // VitaCheat .psv format
      filename = `${serial}.psv`;
      const lines = [
        `# Title: ${title}`,
        `# ID: ${serial}`,
        `# Version: 1.00`,
        '',
      ];
      for (const c of detail.cheats) {
        lines.push(`_V0 ${c.n}`);
        for (const l of (c.l || [])) lines.push(l);
      }
      content = lines.join('\n');
    } else {
      // PS4 / PS5 GoldHEN JSON format
      filename = `${serial}_01.00.json`;
      mime = 'application/json;charset=utf-8';
      const mods = detail.cheats.map((c) => ({
        name: c.n,
        type: c.t || 'checkbox',
        memory: [],
        code: (c.l || []).join('\n'),
      }));
      const payload = {
        name: title,
        id: serial,
        version: '01.00',
        process: 'eboot.bin',
        mods,
      };
      content = JSON.stringify(payload, null, 2);
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename, style: 'display:none' });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 400);

    showToast(`Exported ${filename}`);
  }

  function copyAllCodes() {
    const detail = State.activeDetail;
    if (!detail) return;

    const term = State.drawerFilter.trim().toLowerCase();
    const list = term
      ? detail.cheats.filter((c) => c.n.toLowerCase().includes(term) || (c.l && c.l.some((l) => l.toLowerCase().includes(term))))
      : detail.cheats;

    const chunks = [];
    for (const c of list) {
      chunks.push(`// ${c.n}${c.a ? ' (by ' + c.a + ')' : ''}\n` + (c.l || []).join('\n'));
    }

    copyText(chunks.join('\n\n'), `Copied ${list.length} cheat codes!`);
  }

  function shareGameLink() {
    if (!State.activeGame) return;
    const url = `${location.origin}${location.pathname}#g=${encodeURIComponent(State.activeGame)}`;
    copyText(url, 'Game link copied to clipboard');
  }

  /* ---------------------------------------------------------- Setup Guide -- */

  function openGuide() {
    if ($guideDialog.showModal) {
      $guideDialog.showModal();
    } else {
      $guideDialog.setAttribute('open', '');
    }
  }

  function closeGuide() {
    if ($guideDialog.close) {
      $guideDialog.close();
    } else {
      $guideDialog.removeAttribute('open');
    }
  }

  function setGuideLanguage(lang) {
    State.guideLang = lang;
    localStorage.setItem('pscheats_lang', lang);

    const isPt = lang === 'pt';
    $langPt.classList.toggle('active', isPt);
    $langPt.setAttribute('aria-pressed', isPt ? 'true' : 'false');
    $langEn.classList.toggle('active', !isPt);
    $langEn.setAttribute('aria-pressed', !isPt ? 'true' : 'false');

    for (const en of $guideDialog.querySelectorAll('.en-content')) en.hidden = isPt;
    for (const pt of $guideDialog.querySelectorAll('.pt-content')) pt.hidden = !isPt;
  }

  function switchGuideTab(tabId) {
    for (const tab of $guideDialog.querySelectorAll('.guide-tab')) {
      const active = tab.id === tabId;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }

    const targetSection = tabId.replace('tab-', 'guide-');
    for (const sec of $guideDialog.querySelectorAll('.guide-section')) {
      const isTarget = sec.id === targetSection;
      sec.classList.toggle('active', isTarget);
      sec.hidden = !isTarget;
    }
  }

  /* ---------------------------------------------------------------- Boot -- */

  async function boot() {
    readUrlHash();
    syncControls();
    setGuideLanguage(State.guideLang);
    parseQuery();

    let index;
    try {
      const res = await fetch('data/index.json', { cache: 'force-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      index = await res.json();
    } catch (err) {
      $stats.textContent = '';
      $status.textContent = 'Could not load the database (' + err.message + '). Run "node tools/build-site.mjs" to generate static files.';
      return;
    }

    State.totals = index.totals || { games: 0, cheats: 0 };
    State.games = (index.games || []).map((g) => {
      const names = g.n || [];
      return {
        ...g,
        _hay: `${g.t} ${g.s} ${g.i} ${g.r || ''} ${g.p}`.toLowerCase(),
        _names: names.map((n) => n.toLowerCase()),
      };
    });

    // Populate Platform Counts
    const platforms = index.platforms || {};
    const platformCounts = { all: State.totals.games };
    for (const p of Object.keys(platforms)) platformCounts[p] = platforms[p].games;

    for (const el of $platforms.querySelectorAll('[data-count]')) {
      const count = platformCounts[el.dataset.count];
      el.textContent = count == null ? '—' : nf.format(count);
    }

    // Populate Region Counts
    const regionCounts = {};
    for (const g of State.games) {
      if (g.r) regionCounts[g.r] = (regionCounts[g.r] || 0) + 1;
    }
    for (const el of $regions.querySelectorAll('[data-rcount]')) {
      const count = regionCounts[el.dataset.rcount];
      el.textContent = count == null ? '0' : nf.format(count);
    }

    // Header Stats
    $stats.textContent = `${nf.format(State.totals.games)} games · ${nf.format(State.totals.cheats)} cheats` +
      (index.generated ? ' · ' + new Date(index.generated).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '');

    applyFilters();

    // Direct game deep-link
    if (State.activeGame) {
      openGame(State.activeGame);
    }
  }

  /* -------------------------------------------------------------- Events -- */

  let searchDebounce = null;
  $q.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      parseQuery();
      applyFilters();
      writeUrlHash();
    }, 90);
  });

  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(searchDebounce);
    parseQuery();
    applyFilters();
    writeUrlHash();
  });

  $clear.addEventListener('click', () => {
    $q.value = '';
    parseQuery();
    applyFilters();
    writeUrlHash();
    $q.focus();
  });

  // Quick Tags
  $quickTags.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-query]');
    if (!btn) return;
    $q.value = btn.dataset.query;
    parseQuery();
    applyFilters();
    writeUrlHash();
    $q.focus();
  });

  // Platform Filter
  $platforms.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const p = chip.dataset.p;

    if (!p) {
      State.platforms.clear();
    } else if (State.platforms.has(p)) {
      State.platforms.delete(p);
    } else {
      State.platforms.add(p);
    }

    syncControls();
    applyFilters();
    writeUrlHash();
  });

  // Region Filter
  $regions.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const r = chip.dataset.r;

    if (!r) {
      State.regions.clear();
    } else if (State.regions.has(r)) {
      State.regions.delete(r);
    } else {
      State.regions.add(r);
    }

    syncControls();
    applyFilters();
    writeUrlHash();
  });

  // Sort dropdown
  $sort.addEventListener('change', () => {
    State.sort = $sort.value;
    applyFilters();
    writeUrlHash();
  });

  // View switches
  $btnCards.addEventListener('click', () => applyViewMode('cards'));
  $btnCompact.addEventListener('click', () => applyViewMode('compact'));

  // Drawer events
  $drawerClose.addEventListener('click', closeDrawer);
  $backdrop.addEventListener('click', closeDrawer);
  $btnDownload.addEventListener('click', exportCurrentGameFile);
  $btnCopyAll.addEventListener('click', copyAllCodes);
  $btnShare.addEventListener('click', shareGameLink);

  let drawerDebounce = null;
  $drawerSearch.addEventListener('input', () => {
    clearTimeout(drawerDebounce);
    drawerDebounce = setTimeout(() => {
      State.drawerFilter = $drawerSearch.value;
      if (State.activeDetail) renderDetail(State.activeDetail);
    }, 120);
  });

  // Guide Dialog events
  $btnGuide.addEventListener('click', openGuide);
  $guideClose.addEventListener('click', closeGuide);
  $guideCloseBtn.addEventListener('click', closeGuide);
  $langEn.addEventListener('click', () => setGuideLanguage('en'));
  $langPt.addEventListener('click', () => setGuideLanguage('pt'));

  $guideDialog.addEventListener('click', (e) => {
    if (e.target === $guideDialog) closeGuide();
    const tab = e.target.closest('.guide-tab');
    if (tab) switchGuideTab(tab.id);
  });

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($guideDialog.open) {
        closeGuide();
      } else if (State.activeGame) {
        closeDrawer();
      } else if (document.activeElement === $q && $q.value) {
        $q.value = '';
        parseQuery();
        applyFilters();
        writeUrlHash();
      }
      return;
    }

    const isTyping = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
    if (isTyping) return;

    if (e.key === '/') {
      e.preventDefault();
      $q.focus();
      $q.select();
    } else if (e.key === 'v' || e.key === 'V') {
      applyViewMode(State.viewMode === 'cards' ? 'compact' : 'cards');
    } else if (e.key === 'g' || e.key === 'G') {
      openGuide();
    }
  });

  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#g=')) {
      openGame(decodeURIComponent(location.hash.slice(3)));
      return;
    }
    if (State.activeGame) closeDrawer();
    readUrlHash();
    syncControls();
    parseQuery();
    applyFilters();
  });

  boot();
})();
