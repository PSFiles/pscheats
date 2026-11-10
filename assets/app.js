/* PS Cheats — static app (vanilla JS, no dependencies).
 * Loads data/index.json for search and data/g/<id>.json on demand for the codes.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $q = $('q');
  const $form = $('search-form');
  const $clear = $('clear');
  const $chips = $('platforms');
  const $sort = $('sort');
  const $stats = $('stats');
  const $status = $('status');
  const $list = $('list');
  const $more = $('more');
  const $drawer = $('drawer');
  const $drawerBody = $('drawer-body');
  const $drawerTitle = $('drawer-title');
  const $drawerMeta = $('drawer-meta');
  const $backdrop = $('backdrop');
  const $drawerClose = $('drawer-close');

  const PAGE = 60;

  const S = {
    games: [],
    filtered: [],
    tokens: [],
    query: '',
    platforms: new Set(),
    sort: 'title',
    shown: 0,
    cache: new Map(),
    openId: null,
    totals: { games: 0, cheats: 0 },
  };

  /* --------------------------------------------------------------- helpers -- */

  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const val = props[key];
        if (val == null || val === false) continue;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2).toLowerCase(), val);
        else node.setAttribute(key, val);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const nf = new Intl.NumberFormat('pt-BR');
  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

  function badge(text, cls) {
    return h('span', { class: 'badge ' + (cls || ''), text });
  }

  /* ----------------------------------------------------------------- state -- */

  function readHash() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return;
    const params = new URLSearchParams(raw);
    if (params.has('q')) S.query = params.get('q');
    if (params.has('p')) {
      S.platforms = new Set(params.get('p').split(',').map((p) => p.trim().toUpperCase()).filter((p) => /^PS(?:[345]|V)$/.test(p)));
    }
    if (params.has('s')) S.sort = params.get('s');
  }

  function writeHash(push) {
    const params = new URLSearchParams();
    if (S.query) params.set('q', S.query);
    if (S.platforms.size) params.set('p', [...S.platforms].sort().join(','));
    if (S.sort !== 'title') params.set('s', S.sort);
    const next = params.toString() ? '#' + params.toString() : location.pathname + location.search;
    if (push) history.replaceState(null, '', next);
    else history.replaceState(null, '', next);
  }

  function syncControls() {
    $q.value = S.query;
    $clear.hidden = !S.query;
    $sort.value = S.sort;
    for (const chip of $chips.querySelectorAll('.chip')) {
      const on = chip.dataset.p ? S.platforms.has(chip.dataset.p) : S.platforms.size === 0;
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function parseQuery() {
    S.query = $q.value.trim();
    S.tokens = S.query.toLowerCase().split(/\s+/).filter(Boolean);
    $clear.hidden = !S.query;
  }

  /* ----------------------------------------------------------------- match -- */

  function matchNames(game) {
    if (!S.tokens.length) return [];
    const hits = [];
    for (const token of S.tokens) {
      if (game._hay.includes(token)) continue;
      let found = null;
      for (let i = 0; i < game._names.length; i++) {
        if (game._names[i].includes(token)) { found = game.n[i]; break; }
      }
      if (!found) return null;
      if (!hits.includes(found)) hits.push(found);
    }
    return hits;
  }

  function applyFilters() {
    const out = [];
    for (const game of S.games) {
      if (S.platforms.size && !S.platforms.has(game.p)) continue;
      const names = matchNames(game);
      if (names === null) continue;
      out.push({ game, names });
    }

    if (S.sort === 'cheats') out.sort((a, b) => b.game.c - a.game.c || collator.compare(a.game.t, b.game.t));
    else if (S.sort === 'serial') out.sort((a, b) => collator.compare(a.game.s || a.game.i, b.game.s || b.game.i));
    else out.sort((a, b) => collator.compare(a.game.t, b.game.t));

    S.filtered = out;
    S.shown = 0;
    $list.textContent = '';
    $more.textContent = '';

    if (!out.length) {
      $status.textContent = S.query || S.platforms.size
        ? 'Nenhum jogo encontrado com esses filtros.'
        : 'Nenhum cheat disponível.';
      renderMore();
      return;
    }

    $status.textContent = `${nf.format(out.length)} ${out.length === 1 ? 'jogo' : 'jogos'}` +
      (S.query ? ` para “${S.query}”` : '') +
      (S.platforms.size ? ` em ${[...S.platforms].sort().join(', ')}` : '');
    renderChunk();
  }

  /* ------------------------------------------------------------------ list -- */

  function renderChunk() {
    const slice = S.filtered.slice(S.shown, S.shown + PAGE);
    const frag = document.createDocumentFragment();
    for (const item of slice) frag.append(renderCard(item));
    $list.append(frag);
    S.shown += slice.length;
    renderMore();
  }

  function renderMore() {
    $more.textContent = '';
    const rest = S.filtered.length - S.shown;
    if (rest <= 0) return;
    $more.append(h('button', {
      type: 'button',
      onclick: () => renderChunk(),
      text: `Carregar mais (${nf.format(rest)} restantes)`,
    }));
  }

  function renderCard({ game, names }) {
    const sub = [badge(game.p, game.p.toLowerCase())];
    if (game.s) sub.push(badge(game.s, 'serial'));
    for (const src of game.f) sub.push(badge(srcLabel(src), 'src'));

    const kids = [
      h('div', null,
        h('div', { class: 'card-title', text: game.t || game.s || game.i }),
        h('div', { class: 'card-sub' }, sub),
        names.length ? h('div', { class: 'card-names', text: names.slice(0, 3).join(' · ') }) : null,
      ),
      h('div', { class: 'card-count', text: `${nf.format(game.c)} ${game.c === 1 ? 'cheat' : 'cheats'}` }),
    ];

    return h('li', null, h('button', {
      type: 'button',
      class: 'card',
      'data-id': game.i,
      onclick: () => openGame(game.i),
    }, kids));
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

  /* ---------------------------------------------------------------- drawer -- */

  async function openGame(id) {
    if (!id) return;
    S.openId = id;
    $drawer.classList.add('open');
    $drawer.setAttribute('aria-hidden', 'false');
    $backdrop.hidden = false;
    document.body.style.overflow = 'hidden';

    const game = S.games.find((g) => g.i === id);
    $drawerTitle.textContent = game ? game.t : id;
    $drawerMeta.textContent = '';
    $drawerBody.textContent = '';
    $drawerBody.append(h('div', { class: 'spinner', text: 'Carregando…' }));
    if (game) $drawerMeta.append(...metaNodes(game));
    if (!location.hash.startsWith('#g=')) history.replaceState(null, '', '#g=' + encodeURIComponent(id));

    try {
      let detail = S.cache.get(id);
      if (!detail) {
        const res = await fetch(`data/g/${encodeURIComponent(id)}.json`, { cache: 'force-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        detail = await res.json();
        S.cache.set(id, detail);
      }
      if (S.openId !== id) return;
      renderDetail(detail);
    } catch (err) {
      $drawerBody.textContent = '';
      $drawerBody.append(h('p', { class: 'status', text: 'Não foi possível carregar os cheats deste jogo (' + err.message + ').' }));
    }
  }

  function metaNodes(game) {
    const nodes = [badge(game.p, game.p.toLowerCase())];
    if (game.s) nodes.push(badge(game.s, 'serial'));
    for (const v of game.v || []) nodes.push(badge('v' + v));
    return nodes;
  }

  function renderDetail(detail) {
    $drawerTitle.textContent = detail.title || detail.serial || detail.id;
    $drawerMeta.textContent = '';
    if (detail.serial) $drawerMeta.append(badge(detail.serial, 'serial'));
    $drawerMeta.append(badge(detail.platform, detail.platform.toLowerCase()));
    $drawerMeta.append(h('span', { class: 'badge src', text: `${nf.format(detail.cheats.length)} cheats` }));

    $drawerBody.textContent = '';

    if (Array.isArray(detail.files) && detail.files.length) {
      $drawerBody.append(h('div', { class: 'files' },
        ...detail.files.slice(0, 12).map((f) => h('a', {
          href: f.url, target: '_blank', rel: 'noopener', title: f.f,
          text: `${srcLabel(f.s)}${f.v ? ' v' + f.v : ''} ↗`,
        })),
      ));
    }

    const versions = [...new Set(detail.cheats.map((c) => c.v).filter(Boolean))].sort();
    const grouped = versions.length > 1;

    const renderCheat = (c) => {
      const copyLines = (c.l || []).join('\n');
      const btn = h('button', {
        type: 'button',
        class: 'copy',
        text: 'Copiar',
        title: 'Copiar os códigos',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(copyLines);
            btn.textContent = 'Copiado';
            btn.classList.add('done');
            setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('done'); }, 1400);
          } catch {
            const ta = h('textarea', { style: 'position:fixed;opacity:0' });
            ta.value = copyLines;
            document.body.append(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            btn.textContent = 'Copiado';
            btn.classList.add('done');
            setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('done'); }, 1400);
          }
        },
      });

      return h('article', { class: 'cheat' },
        h('div', { class: 'cheat-head' },
          h('div', null,
            h('div', { class: 'cheat-name', text: c.n }),
            c.d ? h('p', { class: 'cheat-desc', text: c.d }) : null,
          ),
          copyLines ? btn : null,
        ),
        copyLines ? h('pre', { class: 'codes', text: copyLines }) : null,
        c.a ? h('p', { class: 'cheat-author', text: 'por ' + c.a }) : null,
      );
    };

    if (grouped) {
      for (const v of versions) {
        const items = detail.cheats.filter((c) => c.v === v);
        $drawerBody.append(h('h3', { class: 'group-title', text: `Versão ${v} · ${items.length} cheats` }));
        for (const c of items) $drawerBody.append(renderCheat(c));
      }
      const rest = detail.cheats.filter((c) => !c.v);
      if (rest.length) {
        $drawerBody.append(h('h3', { class: 'group-title', text: `Sem versão · ${rest.length} cheats` }));
        for (const c of rest) $drawerBody.append(renderCheat(c));
      }
    } else {
      for (const c of detail.cheats) $drawerBody.append(renderCheat(c));
    }
  }

  function closeDrawer() {
    S.openId = null;
    $drawer.classList.remove('open');
    $drawer.setAttribute('aria-hidden', 'true');
    $backdrop.hidden = true;
    document.body.style.overflow = '';
    if (location.hash.startsWith('#g=')) {
      const params = new URLSearchParams(location.hash.replace(/^#/, ''));
      history.replaceState(null, '', params.toString() && [...params.keys()].some((k) => k !== 'g') ? '#' + params.toString() : location.pathname + location.search);
    }
  }

  /* ------------------------------------------------------------------ boot -- */

  async function boot() {
    readHash();
    syncControls();
    parseQuery();

    let index;
    try {
      const res = await fetch('data/index.json', { cache: 'force-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      index = await res.json();
    } catch (err) {
      $stats.textContent = '';
      $status.textContent = 'Não foi possível carregar o índice de cheats (' + err.message + '). Rode "node tools/build-site.mjs" ou use o site publicado.';
      return;
    }

    S.totals = index.totals || { games: 0, cheats: 0 };
    S.games = (index.games || []).map((g) => {
      const names = g.n || [];
      return {
        ...g,
        _hay: `${g.t} ${g.s} ${g.i}`.toLowerCase(),
        _names: names.map((n) => n.toLowerCase()),
      };
    });

    const platforms = index.platforms || {};
    const counts = { all: S.totals.games };
    for (const p of Object.keys(platforms)) counts[p] = platforms[p].games;
    for (const el of $chips.querySelectorAll('[data-count]')) {
      const n = counts[el.dataset.count];
      el.textContent = n == null ? '' : nf.format(n);
    }

    $stats.textContent = `${nf.format(S.totals.games)} jogos · ${nf.format(S.totals.cheats)} cheats` +
      (index.generated ? ' · ' + new Date(index.generated).toLocaleDateString('pt-BR') : '');

    applyFilters();

    const initial = location.hash.startsWith('#g=') ? decodeURIComponent(location.hash.slice(3)) : null;
    if (initial) openGame(initial);
  }

  /* ---------------------------------------------------------------- events -- */

  let timer = null;
  $q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { parseQuery(); applyFilters(); writeHash(); }, 110);
  });

  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    parseQuery();
    applyFilters();
    writeHash();
  });

  $clear.addEventListener('click', () => {
    $q.value = '';
    parseQuery();
    applyFilters();
    writeHash();
    $q.focus();
  });

  $chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const p = chip.dataset.p;
    if (!p) S.platforms.clear();
    else if (S.platforms.has(p)) S.platforms.delete(p);
    else S.platforms.add(p);
    syncControls();
    applyFilters();
    writeHash();
  });

  $sort.addEventListener('change', () => {
    S.sort = $sort.value;
    applyFilters();
    writeHash();
  });

  $drawerClose.addEventListener('click', closeDrawer);
  $backdrop.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (S.openId) closeDrawer();
      else if (document.activeElement === $q) { $q.value = ''; parseQuery(); applyFilters(); writeHash(); }
      return;
    }
    if (e.key === '/' && document.activeElement !== $q && !(document.activeElement instanceof HTMLInputElement)) {
      e.preventDefault();
      $q.focus();
      $q.select();
    }
  });

  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#g=')) {
      openGame(decodeURIComponent(location.hash.slice(3)));
      return;
    }
    if (S.openId) closeDrawer();
    readHash();
    syncControls();
    parseQuery();
    applyFilters();
  });

  boot();
})();
