// ==UserScript==
// @name         Kinopoisk Toolkit
// @namespace    https://github.com/v1tharr
// @version      0.3.1
// @description  Каталог оценок и «Буду смотреть»: таблица, фильтры, рейтинг КП и выгрузка списков для ИИ
// @author       v1tharr
// @license      MIT
// @homepageURL  https://github.com/v1tharr/kinopoisk-toolkit
// @supportURL   https://github.com/v1tharr/kinopoisk-toolkit/issues
// @downloadURL  https://raw.githubusercontent.com/v1tharr/kinopoisk-toolkit/main/kinopoisk-toolkit.user.js
// @updateURL    https://raw.githubusercontent.com/v1tharr/kinopoisk-toolkit/main/kinopoisk-toolkit.user.js
// @match        https://www.kinopoisk.ru/*
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // /user/<login|id>/movies/voted-watched/, /user/<login|id>/movies/planned-to-watch/ и т.п.
  const LIST_PATH = /^\/user\/[^/]+\/movies\/[^/]+\/?$/;
  // data-tid у Кинопоиска стабильнее хэшированных css-классов
  const TID = { card: 'a2ef0117', rating: '5cb64c50', title: 'ecca3393' };
  const CARD = `[data-tid="${TID.card}"]`;
  const PAGE_DELAY = 400; // пауза между страницами списка, чтобы не словить капчу
  const KP_DELAY = 700; // пауза между страницами фильмов

  const state = {
    q: '', type: 'all', genre: '',
    myMin: null, myMax: null, kpMin: null, kpMax: null, yMin: null, yMax: null,
    sort: 'my', dir: -1, view: 'table',
  };
  const lists = {}; // pathname -> [{ id, type, title, year, genre, my, kp, poster }]
  const stamps = {}; // pathname -> когда загружен
  let kpRun = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const r1 = (v) => Math.round(v * 10) / 10;
  const listKind = (path) => (/planned/.test(path) ? 'planned' : 'voted');
  const curItems = () => lists[location.pathname] || [];

  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem('kpx:' + key)); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem('kpx:' + key, JSON.stringify(value)); } catch { /* storage недоступен — не критично */ }
    },
  };
  const kpCache = store.get('kp') || {}; // id -> рейтинг Кинопоиска

  // ---------- Кинопоиск: разбор страниц ----------
  // Всё, что завязано на разметку сайта, живёт в этом блоке. Остальной код работает с
  // обычными объектами { id, type, title, year, genre, my, kp, poster }.

  function parseCards(doc, kind) {
    const out = [];
    doc.querySelectorAll(CARD).forEach((card) => {
      const link = card.querySelector('a[href^="/film/"], a[href^="/series/"]');
      const m = link && link.getAttribute('href').match(/^\/(film|series)\/(\d+)/);
      if (!m) return;
      const sub = (card.querySelector('[class*="styles_subtitle"]')?.textContent || '').trim();
      const badge = parseFloat(card.querySelector(`[data-tid="${TID.rating}"]`)?.textContent.replace(',', '.'));
      const rating = Number.isNaN(badge) ? null : badge;
      out.push({
        id: m[2],
        type: m[1],
        title: card.querySelector(`[data-tid="${TID.title}"]`)?.textContent.trim() || link.querySelector('img')?.alt || m[2],
        year: Number(sub.match(/^\d{4}/)?.[0]) || null,
        genre: sub.includes(',') ? sub.slice(sub.indexOf(',') + 1).trim() : '',
        // в «оценках» на карточке твоя оценка, в «буду смотреть» — рейтинг Кинопоиска
        my: kind === 'voted' ? rating : null,
        kp: kind === 'planned' ? rating : null,
        poster: card.querySelector('img')?.getAttribute('src') || '',
      });
    });
    return out;
  }

  function lastPage(doc) {
    const nums = [...doc.querySelectorAll('nav[aria-label="Страницы"] a[href*="page="]')]
      .map((a) => Number(new URL(a.getAttribute('href'), location.origin).searchParams.get('page')));
    return Math.max(1, ...nums.filter(Boolean));
  }

  function parseKp(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        for (const node of [].concat(JSON.parse(s.textContent))) {
          const v = Number(node?.aggregateRating?.ratingValue);
          if (v) return v;
        }
      } catch { /* битый json-ld, пробуем следующий */ }
    }
    const m = html.match(/"ratingValue"\s*:\s*"?([\d.]+)/);
    return m ? Number(m[1]) : null;
  }

  const captchaError = () => new Error('Кинопоиск просит капчу — открой его в соседней вкладке, пройди её и повтори');

  // ---------- загрузка ----------

  const scrape = (doc, kind) => ({ items: parseCards(doc, kind), last: lastPage(doc) });

  // Если сервер отдал страницу без карточек (рисуются на клиенте) — рендерим её в скрытом iframe
  function loadInFrame(url, kind) {
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.src = url;
      frame.style.cssText = 'position:fixed;left:-9999px;width:1280px;height:900px';
      document.body.append(frame);
      const started = Date.now();
      const timer = setInterval(() => {
        const doc = frame.contentDocument;
        if (doc && doc.querySelector(CARD)) {
          clearInterval(timer);
          const page = scrape(doc, kind);
          frame.remove();
          resolve(page);
        } else if (Date.now() - started > 20000) {
          clearInterval(timer);
          frame.remove();
          reject(new Error('Страница не отрисовалась (возможно, капча или неверный адрес списка)'));
        }
      }, 300);
    });
  }

  async function loadPage(url, kind) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (/captcha/i.test(res.url)) throw captchaError();
    const page = scrape(new DOMParser().parseFromString(await res.text(), 'text/html'), kind);
    return page.items.length ? page : loadInFrame(url, kind);
  }

  async function loadAll(path, onProgress) {
    const kind = listKind(path);
    const url = (n) => `${location.origin}${path}?page=${n}`; // без ?b=…, фильтруем сами
    const first = await loadPage(url(1), kind);
    let all = first.items;
    for (let p = 2; p <= first.last; p++) {
      onProgress?.(p, first.last);
      await sleep(PAGE_DELAY);
      all = all.concat((await loadPage(url(p), kind)).items);
    }
    const seen = new Set();
    return all.filter((i) => !seen.has(i.id) && seen.add(i.id));
  }

  // Список из кэша или с сайта. paths — запасные адреса на случай, если первый не откроется
  async function ensureList(paths, { force = false, onProgress } = {}) {
    let lastError;
    for (const path of paths) {
      if (!force && lists[path]) return { path, items: lists[path] };
      const cached = !force && store.get('list:' + path);
      if (cached) {
        lists[path] = cached.items;
        stamps[path] = cached.ts;
        return { path, items: cached.items };
      }
      try {
        lists[path] = await loadAll(path, onProgress);
        stamps[path] = Date.now();
        store.set('list:' + path, { ts: stamps[path], items: lists[path] });
        return { path, items: lists[path] };
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  // подмешиваем рейтинг КП, который уже подгружали с карточек фильмов
  const hydrate = (items) => items.forEach((i) => { if (i.kp == null && kpCache[i.id] != null) i.kp = kpCache[i.id]; });

  async function loadKpRatings() {
    if (kpRun) { kpRun.stop = true; return; }
    const todo = visibleItems({ ignoreKp: true }).filter((i) => i.kp == null);
    if (!todo.length) return;
    const run = (kpRun = { stop: false, done: 0, total: todo.length });
    let misses = 0;
    note('');
    render();
    try {
      for (const item of todo) {
        if (run.stop) break;
        const res = await fetch(`/${item.type}/${item.id}/`, { credentials: 'same-origin' });
        if (/captcha/i.test(res.url)) throw captchaError();
        const value = parseKp(await res.text());
        if (value == null) {
          if (++misses >= 3) throw new Error('Не нашёл рейтинг на странице фильма — разметка изменилась?');
        } else {
          misses = 0;
          kpCache[item.id] = value;
          item.kp = value;
        }
        run.done++;
        if (run.done % 10 === 0) { store.set('kp', kpCache); render(); }
        await sleep(KP_DELAY);
      }
    } catch (e) {
      note('Ошибка: ' + e.message);
    } finally {
      store.set('kp', kpCache);
      kpRun = null;
      render();
    }
  }

  // ---------- интерфейс ----------

  const css = `
    :host{all:initial}
    #kpx-open{position:fixed;right:16px;bottom:16px;z-index:99998;padding:10px 16px;border:0;border-radius:8px;
      background:#f60;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px #0006}
    #kpx{position:fixed;inset:0;z-index:99999;background:#16161a;color:#e6e6e6;font:14px system-ui,sans-serif;
      display:flex;flex-direction:column}
    #kpx[hidden],#kpx [hidden]{display:none!important}
    #kpx header{display:flex;gap:12px;align-items:center;padding:12px 20px;border-bottom:1px solid #2c2c33}
    #kpx h2{margin:0;font-size:18px;flex:1}
    #kpx h2 small{font-weight:400;color:#999;margin-left:10px}
    #kpx button,#kpx select,#kpx input,#kpx textarea{background:#26262d;color:inherit;border:1px solid #3a3a44;
      border-radius:6px;padding:6px 10px;font:inherit}
    #kpx button{cursor:pointer}
    #kpx button.on{background:#f60;border-color:#f60;color:#fff}
    #kpx .filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 20px;border-bottom:1px solid #2c2c33}
    #kpx .filters input[type=number]{width:64px}
    #kpx .filters input[name=q]{width:220px}
    #kpx .filters span{color:#999}
    #kpx.planned .only-voted{display:none}
    #kpx .ai{display:flex;flex-direction:column;gap:8px;padding:10px 20px;border-bottom:1px solid #2c2c33}
    #kpx .ai textarea{width:100%;box-sizing:border-box;resize:vertical}
    #kpx .ai .row{display:flex;flex-wrap:wrap;gap:14px;align-items:center}
    #kpx .ai label{display:flex;gap:6px;align-items:center}
    #kpx .ai #kpx-preview{min-height:120px;font:12px ui-monospace,monospace}
    #kpx #kpx-note{padding:6px 20px;color:#f90;font-size:13px}
    #kpx .body{flex:1;overflow:auto;padding:0 20px 20px}
    #kpx .msg{padding:40px 0;text-align:center;color:#999}
    #kpx table{border-collapse:collapse;width:100%}
    #kpx th{position:sticky;top:0;background:#16161a;text-align:left;padding:8px 10px;cursor:pointer;
      border-bottom:1px solid #3a3a44;user-select:none;white-space:nowrap}
    #kpx td{padding:4px 10px;border-bottom:1px solid #22222a}
    #kpx tr:hover td{background:#1e1e25}
    #kpx td img{width:28px;height:42px;object-fit:cover;border-radius:3px;display:block}
    #kpx a{color:#e6e6e6;text-decoration:none}
    #kpx a:hover{color:#f60}
    #kpx .num{text-align:right;font-variant-numeric:tabular-nums}
    #kpx .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:14px;padding-top:14px}
    #kpx .tile{position:relative}
    #kpx .tile img{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:6px;display:block}
    #kpx .tile b{position:absolute;top:6px;left:6px;background:#0009;padding:2px 7px;border-radius:5px}
    #kpx .tile div{margin-top:4px;font-size:13px}
    #kpx .tile small{color:#999}
  `;
  // Интерфейс живёт в shadow DOM, чтобы стили Кинопоиска не попадали в кнопки и поля
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(Object.assign(document.createElement('style'), { textContent: css }));

  const openBtn = Object.assign(document.createElement('button'), { id: 'kpx-open', textContent: 'Инструменты' });
  const root = document.createElement('div');
  root.id = 'kpx';
  root.hidden = true;
  root.innerHTML = `
    <header>
      <h2><span id="kpx-title">Kinopoisk Toolkit</span><small id="kpx-count"></small></h2>
      <button data-view="table">Таблица</button>
      <button data-view="grid">Плитка</button>
      <button id="kpx-ai-toggle">Для ИИ</button>
      <button id="kpx-refresh">Обновить</button>
      <button id="kpx-close">✕</button>
    </header>
    <div class="filters">
      <input name="q" placeholder="Поиск по названию">
      <select name="type">
        <option value="all">Фильмы и сериалы</option>
        <option value="film">Только фильмы</option>
        <option value="series">Только сериалы</option>
      </select>
      <select name="genre"><option value="">Все жанры</option></select>
      <span class="only-voted">Моя оценка</span>
      <input class="only-voted" name="myMin" type="number" step="any" min="1" max="10" placeholder="от">
      <input class="only-voted" name="myMax" type="number" step="any" min="1" max="10" placeholder="до">
      <span>Рейтинг КП</span>
      <input name="kpMin" type="number" step="any" min="1" max="10" placeholder="от">
      <input name="kpMax" type="number" step="any" min="1" max="10" placeholder="до">
      <span>Год</span>
      <input name="yMin" type="number" placeholder="от">
      <input name="yMax" type="number" placeholder="до">
      <select name="sort">
        <option class="only-voted" value="my">Сортировка: моя оценка</option>
        <option value="kp">Сортировка: рейтинг КП</option>
        <option value="title">Сортировка: название</option>
        <option value="year">Сортировка: год</option>
        <option value="genre">Сортировка: жанр</option>
        <option value="type">Сортировка: тип</option>
      </select>
      <button id="kpx-dir"></button>
      <button id="kpx-reset">Сбросить</button>
      <button id="kpx-kp" hidden></button>
    </div>
    <div id="kpx-note" hidden></div>
    <div class="ai" id="kpx-ai" hidden>
      <textarea name="aiq" rows="2" placeholder="Запрос, например: что посмотреть сегодня вечером, хочется чего-то лёгкого"></textarea>
      <div class="row">
        <label><input type="checkbox" name="aiVoted"> Мои оценки</label>
        <label><input type="checkbox" name="aiPlanned"> Буду смотреть</label>
        <label><input type="checkbox" name="aiFilter"> Применить текущие фильтры к открытому списку</label>
        <button id="kpx-build">Сформировать</button>
        <button id="kpx-copy">Копировать</button>
        <span id="kpx-ai-info"></span>
      </div>
      <textarea id="kpx-preview" rows="6" placeholder="Здесь появится текст для ИИ"></textarea>
    </div>
    <div class="body" id="kpx-body"></div>`;
  shadow.append(openBtn, root);
  document.body.append(host);

  const $ = (sel) => root.querySelector(sel);
  const field = (name) => $(`[name="${name}"]`);

  function note(text) {
    $('#kpx-note').textContent = text;
    $('#kpx-note').hidden = !text;
  }

  function readFilters() {
    const num = (n) => (field(n).value === '' ? null : Number(field(n).value));
    Object.assign(state, {
      q: field('q').value.trim().toLowerCase(),
      type: field('type').value,
      genre: field('genre').value,
      sort: field('sort').value,
      myMin: num('myMin'), myMax: num('myMax'),
      kpMin: num('kpMin'), kpMax: num('kpMax'),
      yMin: num('yMin'), yMax: num('yMax'),
    });
  }

  function visibleItems({ ignoreKp = false } = {}) {
    const s = state;
    const inRange = (v, min, max) => (min == null && max == null) || (v != null && (min == null || v >= min) && (max == null || v <= max));
    const list = curItems().filter((i) =>
      (!s.q || i.title.toLowerCase().includes(s.q)) &&
      (s.type === 'all' || i.type === s.type) &&
      (!s.genre || i.genre === s.genre) &&
      inRange(i.my, s.myMin, s.myMax) &&
      (ignoreKp || inRange(i.kp, s.kpMin, s.kpMax)) &&
      inRange(i.year, s.yMin, s.yMax));

    return list.sort((a, b) => {
      const x = a[s.sort];
      const y = b[s.sort];
      const empty = (v) => v == null || v === '';
      if (empty(x) || empty(y)) return empty(x) - empty(y); // пустые всегда в конце
      return (typeof x === 'string' ? x.localeCompare(y, 'ru') : x - y) * s.dir;
    });
  }

  const posterUrl = (p) => (p.startsWith('//') ? 'https:' + p : p);
  const itemUrl = (i) => `/${i.type}/${i.id}/`;
  const kpText = (i) => (i.kp != null ? r1(i.kp).toFixed(1) : '—');

  function renderTable(list) {
    const voted = listKind(location.pathname) === 'voted';
    const cols = [['title', 'Название'], ['year', 'Год'], ['genre', 'Жанр'], ['type', 'Тип']];
    if (voted) cols.push(['my', 'Моя оценка']);
    cols.push(['kp', 'Рейтинг КП']);
    const head = cols
      .map(([k, name]) => `<th data-k="${k}">${name}${state.sort === k ? (state.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`)
      .join('');
    const rows = list
      .map((i) => `<tr>
        <td>${i.poster ? `<img loading="lazy" src="${esc(posterUrl(i.poster))}" alt="">` : ''}</td>
        <td><a href="${itemUrl(i)}" target="_blank" rel="noopener">${esc(i.title)}</a></td>
        <td class="num">${i.year ?? ''}</td>
        <td>${esc(i.genre)}</td>
        <td>${i.type === 'series' ? 'сериал' : 'фильм'}</td>
        ${voted ? `<td class="num">${i.my ?? '—'}</td>` : ''}
        <td class="num">${kpText(i)}</td>
      </tr>`)
      .join('');
    return `<table><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderGrid(list) {
    const voted = listKind(location.pathname) === 'voted';
    return '<div class="grid">' + list
      .map((i) => {
        const badge = voted ? i.my : (i.kp != null ? r1(i.kp) : null);
        return `<a class="tile" href="${itemUrl(i)}" target="_blank" rel="noopener">
          <img loading="lazy" src="${esc(posterUrl(i.poster))}" alt="">
          ${badge != null ? `<b>${badge}</b>` : ''}
          <div>${esc(i.title)}<br><small>${i.year ?? ''}${i.genre ? ', ' + esc(i.genre) : ''}</small></div>
        </a>`;
      })
      .join('') + '</div>';
  }

  // подписи и состояние кнопок не зависят от данных, поэтому обновляем их и пока список грузится
  function syncControls() {
    root.classList.toggle('planned', listKind(location.pathname) === 'planned');
    root.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
    $('#kpx-dir').textContent = state.dir > 0 ? '▲ по возрастанию' : '▼ по убыванию';
  }

  function render() {
    syncControls();
    const all = curItems();
    if (!all.length) return;
    hydrate(all);

    const missing = visibleItems({ ignoreKp: true }).filter((i) => i.kp == null).length;
    const kpBtn = $('#kpx-kp');
    kpBtn.hidden = !kpRun && !missing;
    kpBtn.textContent = kpRun ? `Остановить (${kpRun.done}/${kpRun.total})` : `Подгрузить рейтинг КП (${missing})`;

    const list = visibleItems();
    $('#kpx-count').textContent = `${list.length} из ${all.length}`;
    $('#kpx-body').innerHTML = list.length
      ? (state.view === 'table' ? renderTable(list) : renderGrid(list))
      : '<div class="msg">Ничего не найдено</div>';
  }

  function fillGenres() {
    const counts = new Map();
    curItems().forEach((i) => i.genre && counts.set(i.genre, (counts.get(i.genre) || 0) + 1));
    const sel = field('genre');
    const prev = sel.value;
    sel.innerHTML = '<option value="">Все жанры</option>' + [...counts]
      .sort((a, b) => a[0].localeCompare(b[0], 'ru'))
      .map(([g, n]) => `<option value="${esc(g)}">${esc(g)} (${n})</option>`)
      .join('');
    sel.value = counts.has(prev) ? prev : '';
  }

  const setMsg = (text) => { $('#kpx-body').innerHTML = `<div class="msg">${esc(text)}</div>`; };
  let loading = false;

  async function load(force) {
    if (loading) return;
    loading = true;
    note('');
    $('#kpx-count').textContent = '';
    try {
      setMsg('Загружаю страницу 1…');
      await ensureList([location.pathname], { force, onProgress: (p, total) => setMsg(`Загружаю страницу ${p} из ${total}…`) });
      $('#kpx-title').textContent = `Kinopoisk Toolkit · обновлено ${new Date(stamps[location.pathname]).toLocaleString('ru')}`;
    } catch (e) {
      setMsg('Ошибка: ' + e.message);
      return;
    } finally {
      loading = false;
    }
    fillGenres();
    readFilters();
    render();
  }

  // ---------- выгрузка для ИИ ----------

  const AI_DEFAULTS = { q: '', voted: true, planned: true, filter: false };
  const readAi = () => ({
    q: field('aiq').value.trim(),
    voted: field('aiVoted').checked,
    planned: field('aiPlanned').checked,
    filter: field('aiFilter').checked,
  });

  function loadAiOptions() {
    const o = { ...AI_DEFAULTS, ...store.get('ai') };
    field('aiq').value = o.q;
    field('aiVoted').checked = o.voted;
    field('aiPlanned').checked = o.planned;
    field('aiFilter').checked = o.filter;
  }

  // Адрес второго списка строим от пользователя из текущего URL; ссылку из шапки сайта оставляем запасной
  function listPaths(kind) {
    const user = location.pathname.split('/')[2];
    const name = kind === 'planned' ? 'planned-to-watch' : 'voted-watched';
    const header = kind === 'planned' ? document.querySelector('a[aria-label="Буду смотреть"]')?.getAttribute('href') : null;
    return [...new Set([`/user/${user}/movies/${name}/`, header].filter(Boolean))];
  }

  function formatItem(i) {
    const meta = [i.year, i.genre, i.type === 'series' ? 'сериал' : 'фильм'].filter(Boolean).join(', ');
    const marks = [i.my != null && `моя ${i.my}`, i.kp != null && `КП ${r1(i.kp)}`].filter(Boolean).join(', ');
    return `${i.title} (${meta})${marks ? ' — ' + marks : ''}`;
  }

  async function buildPrompt() {
    const opts = readAi();
    store.set('ai', opts);
    const sections = [];
    for (const [kind, title] of [['voted', 'Мои оценки'], ['planned', 'Буду смотреть']]) {
      if (!opts[kind]) continue;
      $('#kpx-ai-info').textContent = `Загружаю «${title}»…`;
      const isOpen = kind === listKind(location.pathname);
      const { path, items } = await ensureList(isOpen ? [location.pathname] : listPaths(kind), {
        onProgress: (p, total) => { $('#kpx-ai-info').textContent = `«${title}»: страница ${p} из ${total}…`; },
      });
      hydrate(items);
      const rows = isOpen && opts.filter && path === location.pathname ? visibleItems() : items;
      sections.push({ kind, title, rows });
    }
    if (!sections.length) throw new Error('Отметь хотя бы один список');

    const intro = ['Ниже данные из моего профиля на Кинопоиске. Оценки по 10-балльной шкале: «моя» — моя оценка, «КП» — рейтинг Кинопоиска.'];
    const kinds = sections.map((s) => s.kind);
    if (kinds.includes('voted')) intro.push('«Мои оценки» — то, что я уже смотрел.');
    if (kinds.includes('planned')) intro.push('«Буду смотреть» — кандидаты на просмотр.');
    if (kinds.length === 2) intro.push('Выбирай только из списка «Буду смотреть», опираясь на мой вкус по оценкам; к каждому варианту — одно-два предложения, почему он подходит.');
    intro.push(`Запрос: ${opts.q || 'что посмотреть сегодня?'}`);

    const body = sections.map((s) => `## ${s.title} (${s.rows.length})\n${s.rows.map(formatItem).join('\n')}`);
    return [intro.join('\n'), ...body].join('\n\n');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
  }

  async function onBuild() {
    const info = $('#kpx-ai-info');
    try {
      const text = await buildPrompt();
      $('#kpx-preview').value = text;
      info.textContent = `${text.length.toLocaleString('ru')} символов`;
      // после долгой загрузки браузер может не дать писать в буфер без клика — тогда есть кнопка «Копировать»
      await copyText(text).then(() => { info.textContent += ' · скопировано'; }, () => {});
    } catch (e) {
      info.textContent = 'Ошибка: ' + e.message;
    }
  }

  // ---------- события ----------

  root.addEventListener('input', (e) => {
    if (e.target.closest('.filters')) {
      readFilters();
      render();
    }
  });

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.view) { state.view = t.dataset.view; render(); }
    if (t.id === 'kpx-close') root.hidden = true;
    if (t.id === 'kpx-refresh') load(true);
    if (t.id === 'kpx-dir') { state.dir = -state.dir; render(); }
    if (t.id === 'kpx-kp') loadKpRatings();
    if (t.id === 'kpx-ai-toggle') $('#kpx-ai').hidden = !$('#kpx-ai').hidden;
    if (t.id === 'kpx-build') onBuild();
    if (t.id === 'kpx-copy') {
      const text = $('#kpx-preview').value;
      if (text) copyText(text).then(() => { $('#kpx-ai-info').textContent = 'Скопировано'; });
    }
    if (t.id === 'kpx-reset') {
      root.querySelectorAll('.filters input').forEach((i) => { i.value = ''; });
      field('type').value = 'all';
      field('genre').value = '';
      readFilters();
      render();
    }
    if (t.tagName === 'TH' && t.dataset.k) {
      state.dir = state.sort === t.dataset.k ? -state.dir : 1;
      state.sort = t.dataset.k;
      field('sort').value = state.sort;
      render();
    }
  });

  openBtn.addEventListener('click', () => {
    root.hidden = false;
    // на «Буду смотреть» своей оценки нет — сортируем по рейтингу КП
    if (listKind(location.pathname) === 'planned' && state.sort === 'my') {
      state.sort = 'kp';
      field('sort').value = 'kp';
    } else {
      field('sort').value = state.sort;
    }
    loadAiOptions();
    syncControls();
    $('#kpx-title').textContent = 'Kinopoisk Toolkit';
    if (curItems().length) { fillGenres(); readFilters(); render(); } else load(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) root.hidden = true;
  });

  // Кинопоиск — SPA: адрес меняется без перезагрузки, поэтому кнопку показываем только на нужных страницах
  let lastPath = location.pathname;
  const syncButton = () => {
    openBtn.style.display = LIST_PATH.test(location.pathname) ? '' : 'none';
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      root.hidden = true;
    }
  };
  syncButton();
  setInterval(syncButton, 700);
})();
