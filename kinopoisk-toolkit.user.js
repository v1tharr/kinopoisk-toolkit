// ==UserScript==
// @name         Kinopoisk Toolkit
// @namespace    https://github.com/v1tharr
// @version      0.4.10
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
  const REFRESH_AFTER = 5 * 60 * 1000; // не чаще раза в 5 минут проверяем новые записи
  const SCHEMA = 2; // версия формата кэша: при смене старые списки перезагружаются

  const state = {
    q: '', type: 'all', genre: '',
    myMin: null, myMax: null, kpMin: null, kpMax: null, yMin: null, yMax: null,
    sort: 'my', dir: -1, view: 'table',
  };
  const lists = {}; // pathname -> [{ id, type, title, original, year, genres, my, kp, votes, poster }]
  const stamps = {}; // pathname -> когда загружен

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const r1 = (v) => Math.round(v * 10) / 10;
  const listKind = (path) => (/planned/.test(path) ? 'planned' : 'voted');
  const curItems = () => lists[location.pathname] || [];
  const itemUrl = (i) => `/${i.type}/${i.id}/`;

  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem('kpx:' + key)); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem('kpx:' + key, JSON.stringify(value)); } catch { /* storage недоступен — не критично */ }
    },
  };

  // Всё, что завязано на разметку сайта, живёт здесь: readMovies, parseCards, lastPage.

  // Помимо карточек страница содержит данные, из которых отрисована (кэш Apollo в inline-скрипте).
  // Там уже есть рейтинг Кинопоиска, все жанры и оригинальные названия.
  function readMovies(doc) {
    const movies = new Map();
    const script = [...doc.querySelectorAll('script')].find((s) => /__ssr_initial_data\s*=\s*\{/.test(s.textContent));
    if (!script) return movies;
    try {
      const text = script.textContent;
      const json = text.slice(text.indexOf('{', text.indexOf('__ssr_initial_data')), text.lastIndexOf('}') + 1);
      const cache = JSON.parse(json).apolloState;
      for (const [key, entity] of Object.entries(cache)) {
        const id = key.match(/^[A-Za-z]+:(\d+)$/)?.[1];
        if (!id || !entity.title) continue;
        const kp = entity.rating?.kinopoisk;
        movies.set(id, {
          original: entity.title.original || '',
          genres: (entity.genres || []).map((g) => cache[g.__ref]?.name).filter(Boolean),
          kp: kp?.isActive ? kp.value : null,
          votes: kp?.count ?? null,
        });
      }
    } catch { /* формат данных изменился — останется то, что видно на карточках */ }
    return movies;
  }

  function parseCards(doc, kind) {
    const movies = readMovies(doc);
    const out = [];
    doc.querySelectorAll(CARD).forEach((card) => {
      const link = card.querySelector('a[href^="/film/"], a[href^="/series/"]');
      const m = link && link.getAttribute('href').match(/^\/(film|series)\/(\d+)/);
      if (!m) return;
      const sub = (card.querySelector('[class*="styles_subtitle"]')?.textContent || '').trim();
      const badge = parseFloat(card.querySelector(`[data-tid="${TID.rating}"]`)?.textContent.replace(',', '.'));
      const rating = Number.isNaN(badge) ? null : badge;
      const extra = movies.get(m[2]);
      const cardGenre = sub.includes(',') ? sub.slice(sub.indexOf(',') + 1).trim() : '';
      out.push({
        id: m[2],
        type: m[1],
        title: card.querySelector(`[data-tid="${TID.title}"]`)?.textContent.trim() || link.querySelector('img')?.alt || m[2],
        original: extra?.original || '',
        year: Number(sub.match(/^\d{4}/)?.[0]) || null,
        genres: extra?.genres.length ? extra.genres : (cardGenre ? [cardGenre] : []),
        // в «оценках» на карточке твоя оценка, в «буду смотреть» — рейтинг Кинопоиска
        my: kind === 'voted' ? rating : null,
        kp: extra?.kp ?? (kind === 'planned' ? rating : null),
        votes: extra?.votes ?? null,
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

  const captchaError = () => new Error('Кинопоиск просит капчу — открой его в соседней вкладке, пройди её и повтори');

  const scrape = (doc, kind) => ({ items: parseCards(doc, kind), last: lastPage(doc) });

  function parseDuration(value) {
    const text = value?.trim() || '';
    const iso = text.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
    const total = text.match(/\s[—–-]\s+(\d+)\s*мин\.?$/i);
    if (total) return Number(total[1]) || null;
    const time = iso ?? text.match(/^(?:(\d+)\s*(?:час(?:а|ов)?|ч\.?)\s*)?(?:(\d+)\s*(?:мин(?:ута|уты|ут)?|м)\.?)?(?:\s*\/\s*\d+:\d{2})?$/i);
    return time ? Number(time[1] || 0) * 60 + Number(time[2] || 0) || null : null;
  }

  function readDuration(doc, type) {
    if (type === 'film') {
      const metadata = doc.querySelector('meta[itemprop="duration"], time[itemprop="duration"][datetime]');
      const minutes = parseDuration(metadata?.getAttribute('content') ?? metadata?.getAttribute('datetime'));
      if (minutes) return minutes;
      for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        let data;
        try { data = JSON.parse(script.textContent); } catch { continue; }
        for (const entry of [data].flat().flatMap((value) => [value, value?.mainEntity, ...(Array.isArray(value?.['@graph']) ? value['@graph'] : [])])) {
          if (![entry?.['@type']].flat().includes('Movie')) continue;
          const minutes = typeof entry.duration === 'string' ? parseDuration(entry.duration) : null;
          if (minutes) return minutes;
        }
      }
    }
    const textNodes = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = textNodes.nextNode());) {
      const match = node.textContent.trim().match(/^Время(?:\s*:\s*(.*))?$/);
      if (!match) continue;
      const label = node.parentElement;
      // В карточке фильма значение соседствует с подписью, в списке эпизодов — ячейки таблицы.
      const values = [match[1], node.nextSibling?.textContent, label.nextElementSibling?.textContent,
        label.parentElement?.nextElementSibling?.textContent,
        label.parentElement?.parentElement?.nextElementSibling?.textContent];
      for (const value of values) {
        const minutes = parseDuration(value);
        if (minutes) return minutes;
      }
    }
    return null;
  }

  async function fetchDuration(item, signal) {
    const path = item.type === 'series' ? `/film/${item.id}/episodes/` : itemUrl(item);
    const url = new URL(path, location.origin).href;
    const res = await fetch(url, { credentials: 'same-origin', signal });
    if (/captcha/i.test(res.url)) throw captchaError();
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok || new URL(res.url || url, url).origin !== location.origin) {
      throw new Error('Кинопоиск не отдал страницу тайтла. Повтори загрузку позже.');
    }
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const minutes = readDuration(doc, item.type);
    if (minutes == null && !doc.querySelector('h1')) throw new Error('Не удалось прочитать страницу тайтла.');
    return minutes;
  }

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

  // без ?b=…, фильтруем сами
  const pageUrl = (path, n) => `${location.origin}${path}?page=${n}`;

  async function loadAll(path, onProgress) {
    const kind = listKind(path);
    const url = (n) => pageUrl(path, n);
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
      if (!force && lists[path]) return { path, items: lists[path], fromCache: true };
      const cached = !force && store.get('list:' + path);
      if (cached?.v === SCHEMA) {
        lists[path] = cached.items;
        stamps[path] = cached.ts;
        return { path, items: cached.items, fromCache: true };
      }
      try {
        lists[path] = await loadAll(path, onProgress);
        stamps[path] = Date.now();
        store.set('list:' + path, { v: SCHEMA, ts: stamps[path], items: lists[path] });
        return { path, items: lists[path] };
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  // Новые записи идут в списке первыми, поэтому вместо полной перезагрузки листаем страницы,
  // пока не пойдут уже известные. Заодно подтягиваем оценки, которые поменялись.
  let refreshing = false;

  async function refreshNewest(path) {
    if (refreshing || Date.now() - (stamps[path] || 0) < REFRESH_AFTER) return;
    refreshing = true;
    try {
      const kind = listKind(path);
      const byId = new Map(lists[path].map((i) => [i.id, i]));
      const fresh = [];
      for (let p = 1; ; p++) {
        const page = await loadPage(pageUrl(path, p), kind);
        let added = 0;
        for (const item of page.items) {
          const known = byId.get(item.id);
          if (known) {
            Object.assign(known, item, { kp: item.kp ?? known.kp });
          } else {
            fresh.push(item);
            added++;
          }
        }
        if (!added || p >= page.last) break;
        await sleep(PAGE_DELAY);
      }
      lists[path] = fresh.concat(lists[path]);
      stamps[path] = Date.now();
      store.set('list:' + path, { v: SCHEMA, ts: stamps[path], items: lists[path] });
      if (path === location.pathname && !root.hidden) {
        setStamp(path);
        fillGenres();
        render();
      }
    } catch (e) {
      note('Не удалось проверить новые записи: ' + e.message);
    } finally {
      refreshing = false;
    }
  }

  const css = `
    :host{all:initial}
    #kpx-open{position:fixed;right:16px;bottom:16px;z-index:99998;padding:10px 16px;border:0;border-radius:8px;
      background:#f60;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px #0006}
    #kpx{position:fixed;inset:0;z-index:99999;overscroll-behavior:contain;background:#16161a;color:#e6e6e6;font:14px system-ui,sans-serif;
      display:flex;flex-direction:column}
    #kpx[hidden],#kpx [hidden]{display:none!important}
    #kpx header{display:flex;gap:12px;align-items:center;padding:12px 20px;border-bottom:1px solid #2c2c33}
    #kpx h2{margin:0;font-size:18px;flex:1}
    #kpx h2 small{font-weight:400;color:#999;margin-left:10px}
    #kpx #kpx-stamp:not(:empty)::before{content:' · ';white-space:pre}
    #kpx button,#kpx select,#kpx input,#kpx textarea{background:#26262d;color:inherit;border:1px solid #3a3a44;
      border-radius:6px;padding:6px 10px;font:inherit}
    #kpx button{cursor:pointer}
    #kpx button.on{background:#f60;border-color:#f60;color:#fff}
    #kpx .filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 20px;border-bottom:1px solid #2c2c33}
    #kpx .filters input[type=number]{width:64px}
    #kpx .filters input[name=q]{width:220px}
    #kpx .filters span{color:#999}
    #kpx #kpx-filters>summary{display:none}
    #kpx #kpx-filters:not([open])>.filters{display:flex}
    #kpx .range{display:flex;gap:8px;align-items:center}
    #kpx.planned .only-voted{display:none}
    #kpx .ai{display:flex;flex-direction:column;gap:8px;padding:10px 20px;border-bottom:1px solid #2c2c33}
    #kpx .ai textarea{width:100%;box-sizing:border-box;resize:vertical}
    #kpx .ai .row{display:flex;flex-wrap:wrap;gap:14px;align-items:center}
    #kpx .ai label{display:flex;gap:6px;align-items:center}
    #kpx .ai input[type=number]{width:75px;min-width:0}
    #kpx .ai fieldset:disabled{opacity:.5}
    #kpx .ai #kpx-preview{min-height:120px;font:12px ui-monospace,monospace}
    #kpx #kpx-note{padding:6px 20px;color:#f90;font-size:13px}
    #kpx #kpx-duration-progress{padding:6px 20px;color:#999;font-size:13px}
    #kpx .body{flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-color:#555 #16161a;padding:0 20px 20px}
    #kpx .msg{padding:40px 0;text-align:center;color:#999}
    #kpx table{border-collapse:collapse;width:100%}
    #kpx th{position:sticky;top:0;background:#16161a;text-align:left;padding:8px 10px;cursor:pointer;
      border-bottom:1px solid #3a3a44;user-select:none;white-space:nowrap}
    #kpx .column-edge{position:absolute;inset:0 0 0 auto;width:12px;cursor:col-resize;touch-action:none}
    #kpx .column-edge::after{content:'';position:absolute;right:0;top:20%;height:60%;width:1px;background:#3a3a44}
    #kpx .column-edge:hover::after{background:#f60}
    #kpx .sized td{overflow-wrap:break-word}
    #kpx td.num{white-space:nowrap}
    #kpx #kpx-list{padding:6px 20px;color:#999;border-bottom:1px solid #2c2c33}
    #kpx.resizing{cursor:col-resize;user-select:none}
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
    @media (max-width:700px), (max-height:500px) {
      #kpx{overflow-y:auto}
      #kpx header{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;padding:10px}
      #kpx h2{grid-column:1/4}
      #kpx #kpx-stamp{display:none}
      #kpx #kpx-stamp:empty{display:none}
      #kpx #kpx-stamp:not(:empty)::before{content:none}
      #kpx header button{padding-inline:3px;min-height:40px}
      #kpx #kpx-close{grid-area:1/4;justify-self:end;min-width:40px}
      #kpx .filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));padding:10px}
      #kpx #kpx-filters{flex-shrink:0;max-height:40dvh;overflow:auto;border-bottom:1px solid #2c2c33}
      #kpx #kpx-filters>summary{display:list-item;cursor:pointer;padding:10px 14px}
      #kpx #kpx-filters:not([open])>.filters{display:none}
      #kpx #kpx-filters[open]>.filters{display:grid}
      #kpx .filters :is(input,select){box-sizing:border-box;width:100%;min-width:0;font-size:16px}
      #kpx .filters input[name=q],#kpx .range,#kpx .filters select[name=sort],#kpx #kpx-duration{grid-column:1/-1}
      #kpx .range{display:grid;grid-template-columns:6em repeat(2,minmax(0,1fr))}
      #kpx .filters .range input{width:100%}
      #kpx .ai,#kpx #kpx-note,#kpx #kpx-duration-progress{padding-inline:10px}
      #kpx .ai textarea,#kpx .ai #kpx-preview{font-size:16px}
      #kpx .body{flex:1 1 0;min-height:0;overscroll-behavior:auto;padding-inline:10px}
      #kpx .ai{flex-shrink:0;max-height:50dvh;overflow:auto}
      #kpx header{flex-shrink:0}
      #kpx table{min-width:800px}
      #kpx td.num{white-space:nowrap;overflow-wrap:normal}
      #kpx table{min-width:580px}
      #kpx .grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
    }
  `;
  // Интерфейс живёт в shadow DOM, чтобы стили Кинопоиска не попадали в кнопки и поля
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(Object.assign(document.createElement('style'), { textContent: css }));

  const openBtn = Object.assign(document.createElement('button'), { id: 'kpx-open', textContent: 'Kinopoisk Toolkit' });
  const root = document.createElement('div');
  root.id = 'kpx';
  root.hidden = true;
  root.innerHTML = `
    <header>
      <h2>Kinopoisk Toolkit<span id="kpx-stamp"></span><small id="kpx-count"></small></h2>
      <button data-view="table">Таблица</button>
      <button data-view="grid">Плитка</button>
      <button id="kpx-ai-toggle">Выгрузить</button>
      <button id="kpx-refresh">Обновить</button>
      <button id="kpx-close" aria-label="Закрыть">✕</button>
    </header>
    <div id="kpx-list"></div>
    <details id="kpx-filters" open>
    <summary>Фильтры и сортировка</summary>
    <div class="filters">
      <input name="q" placeholder="Поиск по названию">
      <select name="type">
        <option value="all">Фильмы и сериалы</option>
        <option value="film">Только фильмы</option>
        <option value="series">Только сериалы</option>
      </select>
      <select name="genre"><option value="">Все жанры</option></select>
      <div class="range only-voted">
        <span>Моя оценка</span>
        <input name="myMin" type="number" step="any" min="1" max="10" placeholder="от" aria-label="Моя оценка от">
        <input name="myMax" type="number" step="any" min="1" max="10" placeholder="до" aria-label="Моя оценка до">
      </div>
      <div class="range">
        <span>Рейтинг КП</span>
        <input name="kpMin" type="number" step="any" min="1" max="10" placeholder="от" aria-label="Рейтинг КП от">
        <input name="kpMax" type="number" step="any" min="1" max="10" placeholder="до" aria-label="Рейтинг КП до">
      </div>
      <div class="range">
        <span>Год</span>
        <input name="yMin" type="number" placeholder="от" aria-label="Год от">
        <input name="yMax" type="number" placeholder="до" aria-label="Год до">
      </div>
      <select name="sort">
        <option class="only-voted" value="my">Сортировка: моя оценка</option>
        <option value="kp">Сортировка: рейтинг КП</option>
        <option value="added">Сортировка: по добавлению</option>
        <option value="duration">Сортировка: по продолжительности</option>
        <option value="title">Сортировка: название</option>
        <option value="year">Сортировка: год</option>
        <option value="genre">Сортировка: жанр</option>
        <option value="type">Сортировка: тип</option>
      </select>
      <button id="kpx-dir"></button>
      <button id="kpx-reset">Сбросить</button>
      <button id="kpx-columns-reset">Сбросить ширину колонок</button>
      <button id="kpx-duration" hidden>Загрузить длительности</button>
    </div>
    </details>
    <div id="kpx-note" hidden></div>
    <div id="kpx-duration-progress" role="status" hidden></div>
    <div class="ai" id="kpx-ai" hidden>
      <div class="row">
        <label><input type="checkbox" name="aiVoted"> Мои оценки</label>
        <label><input type="checkbox" name="aiPlanned"> Буду смотреть</label>
        <select name="exportType" aria-label="Тип тайтлов для выгрузки">
          <option value="all">Фильмы и сериалы</option>
          <option value="film">Только фильмы</option>
          <option value="series">Только сериалы</option>
        </select>
      </div>
      <details>
        <summary>Жанры для выгрузки — любой из выбранных</summary>
        <p>Без отметок выгружаются все жанры.</p>
        <div class="row" id="kpx-export-genres"></div>
      </details>
      <details id="kpx-export-ratings">
        <summary>Мои оценки для выгрузки</summary>
        <p>Без отметок выгружаются все оценки. Отбор действует на список «Мои оценки».</p>
        <fieldset class="row" id="kpx-export-rating-options" style="border:0;margin:0;padding:0">
          ${Array.from({ length: 10 }, (_, index) => `<label><input type="checkbox" name="exportRating" value="${index + 1}"> ${index + 1}</label>`).join('')}
        </fieldset>
      </details>
      <details>
        <summary>Продолжительность в выгрузке</summary>
        <label><input type="checkbox" name="exportDuration"> Добавить известные длительности</label>
        <div class="row">
          <label>От, мин <input name="exportDurationMin" type="number" min="1" aria-label="Продолжительность от, минут"></label>
          <label>До, мин <input name="exportDurationMax" type="number" min="1" aria-label="Продолжительность до, минут"></label>
        </div>
        <p>Диапазон отбирает тайтлы с известной длительностью. Для сериалов используется общее время эпизодов.</p>
        <button id="kpx-export-duration">Загрузить длительности отбора</button>
      </details>
      <div class="row">
        <button id="kpx-build">Сформировать</button>
        <button id="kpx-copy">Копировать</button>
        <span id="kpx-ai-info"></span>
      </div>
      <textarea id="kpx-preview" rows="6" aria-label="Текст выгрузки" placeholder="Здесь появится текст выгрузки"></textarea>
    </div>
    <div class="body" id="kpx-body"></div>`;
  shadow.append(openBtn, root);
  document.documentElement.append(host);

  // Пока окно открыто, страница под ним не должна прокручиваться: иначе её полоса прокрутки
  // остаётся рядом с окном и не реагирует на мышь
  let pageOverflow = null;
  let restoreViewport = null;

  function useMobileViewport() {
    const existing = document.head.querySelector('meta[name="viewport"]');
    const viewport = existing || document.createElement('meta');
    const content = viewport.getAttribute('content');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    if (!existing) document.head.append(viewport);
    return () => {
      if (!existing) viewport.remove();
      else if (content === null) viewport.removeAttribute('content');
      else viewport.content = content;
    };
  }

  function setOpen(open) {
    if (open === !root.hidden) return;
    root.hidden = !open;
    const els = [document.documentElement, document.body];
    if (open) {
      if (matchMedia('(pointer: coarse)').matches) restoreViewport = useMobileViewport();
      pageOverflow = els.map((el) => el.style.overflow);
      els.forEach((el) => { el.style.overflow = 'hidden'; });
    } else if (pageOverflow) {
      durationLoad?.abort();
      els.forEach((el, i) => { el.style.overflow = pageOverflow[i]; });
      restoreViewport?.();
      restoreViewport = null;
    }
  }

  const $ = (sel) => root.querySelector(sel);
  const compactScreen = matchMedia('(max-width:700px), (max-height:500px)');
  $('#kpx-filters').open = !compactScreen.matches;
  compactScreen.addEventListener('change', () => { $('#kpx-filters').open = !compactScreen.matches; });
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

  const durationCache = new Map();
  const durationKey = (item) => 'duration:' + itemUrl(item);
  function durationFor(item) {
    const key = durationKey(item);
    if (!durationCache.has(key)) {
      const cached = store.get(key);
      // В старой версии ошибки разбора могли сохраниться как пустые значения.
      durationCache.set(key, cached?.minutes > 0 || cached?.checked ? cached.minutes : undefined);
    }
    return durationCache.get(key);
  }

  let durationLoad = null;

  async function loadDurations(items = visibleItems()) {
    if (durationLoad || root.hidden) return;
    const path = location.pathname;
    const pending = [...new Map(items.map((item) => [itemUrl(item), item])).values()]
      .filter((item) => durationFor(item) === undefined);
    if (!pending.length) return;
    const controller = new AbortController();
    durationLoad = controller;
    const progress = $('#kpx-duration-progress');
    let done = 0;
    let found = 0;
    note('');
    syncControls();
    try {
      for (const item of pending) {
        if (controller.signal.aborted || location.pathname !== path) break;
        progress.textContent = `Длительности: проверено ${done} из ${pending.length}, найдено ${found}`;
        const minutes = await fetchDuration(item, controller.signal);
        const key = durationKey(item);
        durationCache.set(key, minutes);
        store.set(key, { minutes, checked: true });
        if (minutes != null) found++;
        done++;
        if (((found === 1 && minutes != null) || done % 10 === 0) && state.sort === 'duration') render();
        if (done < pending.length) await sleep(PAGE_DELAY);
      }
    } catch (e) {
      if (!controller.signal.aborted && location.pathname === path) note(e.message);
    } finally {
      durationLoad = null;
      progress.textContent = location.pathname === path
        ? `Длительности: проверено ${done} из ${pending.length}, найдено ${found}`
        : '';
      if (!root.hidden && location.pathname === path && state.sort === 'duration') render();
      else syncControls();
    }
  }

  function sortValue(item, key) {
    if (key === 'duration') return durationFor(item);
    return key === 'genre' ? item.genres[0] : item[key];
  }

  function visibleItems() {
    const s = state;
    const inRange = (v, min, max) => (min == null && max == null) || (v != null && (min == null || v >= min) && (max == null || v <= max));
    const list = curItems().filter((i) =>
      (!s.q || i.title.toLowerCase().includes(s.q) || i.original.toLowerCase().includes(s.q)) &&
      (s.type === 'all' || i.type === s.type) &&
      (!s.genre || i.genres.includes(s.genre)) &&
      inRange(i.my, s.myMin, s.myMax) &&
      inRange(i.kp, s.kpMin, s.kpMax) &&
      inRange(i.year, s.yMin, s.yMax));

    // Кинопоиск отдаёт свежие записи первыми, кэш сохраняет этот порядок.
    if (s.sort === 'added') return s.dir > 0 ? list.reverse() : list;

    return list.sort((a, b) => {
      const x = sortValue(a, s.sort);
      const y = sortValue(b, s.sort);
      const empty = (v) => v == null || v === '';
      if (empty(x) || empty(y)) return empty(x) - empty(y); // пустые всегда в конце
      return (typeof x === 'string' ? x.localeCompare(y, 'ru') : x - y) * s.dir;
    });
  }

  const posterUrl = (p) => (p.startsWith('//') ? 'https:' + p : p);
  const kpText = (i) => (i.kp != null ? r1(i.kp).toFixed(1) : '—');
  const columnWidths = store.get('columnWidths') || {};
  let columnDrag = null;

  function sizeTable(table, widths) {
    const minimums = { title: 160, year: 76, genre: 160, type: 100, my: 130, kp: 130, duration: 180 };
    const cells = [...table.rows[0].cells];
    const fitted = cells.map((cell, index) => Math.max(minimums[cell.dataset.k] || 52,
      Number.isFinite(widths[index]) ? widths[index] : 0));
    const total = fitted.reduce((sum, width) => sum + width, 0);
    const body = $('#kpx-body');
    const padding = getComputedStyle(body);
    const available = body.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
    if (available > total) fitted[columnDrag?.index === 3 ? 1 : 3] += available - total;
    table.classList.add('sized');
    table.style.tableLayout = 'fixed';
    table.style.minWidth = '0';
    table.style.width = fitted.reduce((sum, width) => sum + width, 0) + 'px';
    table.querySelectorAll('col').forEach((col, index) => {
      col.style.width = fitted[index] + 'px';
    });
  }

  function renderTable(list) {
    const voted = listKind(location.pathname) === 'voted';
    const showDuration = state.sort === 'duration';
    const cols = [['title', 'Название'], ['year', 'Год'], ['genre', 'Жанр'], ['type', 'Тип']];
    if (voted) cols.push(['my', 'Моя оценка']);
    cols.push(['kp', 'Рейтинг КП']);
    if (showDuration) cols.push(['duration', 'Длительность, мин']);
    const head = cols
      .map(([k, name]) => `<th data-k="${k}">${name}${state.sort === k ? (state.dir > 0 ? ' ▲' : ' ▼') : ''}<span class="column-edge" title="Перетащите, чтобы изменить ширину"></span></th>`)
      .join('');
    const rows = list
      .map((i) => `<tr>
        <td>${i.poster ? `<img loading="lazy" src="${esc(posterUrl(i.poster))}" alt="">` : ''}</td>
        <td><a href="${itemUrl(i)}" target="_blank" rel="noopener">${esc(i.title)}</a></td>
        <td class="num">${i.year ?? ''}</td>
        <td>${esc(i.genres.join(', '))}</td>
        <td>${i.type === 'series' ? 'сериал' : 'фильм'}</td>
        ${voted ? `<td class="num">${i.my ?? '—'}</td>` : ''}
        <td class="num" title="${i.votes ? `голосов: ${i.votes}` : ''}">${kpText(i)}</td>
        ${showDuration ? `<td class="num">${durationFor(i) ?? '—'}</td>` : ''}
      </tr>`)
      .join('');
    const layout = voted ? 'voted' : 'planned';
    return `<table data-layout="${layout}${showDuration ? '-duration' : ''}"><colgroup>${'<col>'.repeat(cols.length + 1)}</colgroup><thead><tr><th><span class="column-edge" title="Перетащите, чтобы изменить ширину"></span></th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderGrid(list) {
    const voted = listKind(location.pathname) === 'voted';
    return '<div class="grid">' + list
      .map((i) => {
        const badge = voted ? i.my : (i.kp != null ? r1(i.kp) : null);
        const minutes = state.sort === 'duration' ? durationFor(i) : null;
        return `<a class="tile" href="${itemUrl(i)}" target="_blank" rel="noopener">
          <img loading="lazy" src="${esc(posterUrl(i.poster))}" alt="">
          ${badge != null ? `<b>${badge}</b>` : ''}
          <div>${esc(i.title)}<br><small>${i.year ?? ''}${i.genres.length ? ', ' + esc(i.genres[0]) : ''}${minutes != null ? ` · ${minutes} мин` : ''}</small></div>
        </a>`;
      })
      .join('') + '</div>';
  }

  // подписи и состояние кнопок не зависят от данных, поэтому обновляем их и пока список грузится
  function syncControls() {
    const planned = listKind(location.pathname) === 'planned';
    root.classList.toggle('planned', planned);
    $('#kpx-list').textContent = planned ? 'Буду смотреть' : 'Мои оценки';
    root.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
    $('#kpx-dir').textContent = state.dir > 0 ? '▲ по возрастанию' : '▼ по убыванию';
    const durationButton = $('#kpx-duration');
    durationButton.hidden = !durationLoad && (state.sort !== 'duration' || !visibleItems().some((i) => durationFor(i) === undefined));
    durationButton.textContent = durationLoad ? 'Остановить загрузку' : 'Загрузить длительности';
    const progress = $('#kpx-duration-progress');
    progress.hidden = !durationLoad && (state.sort !== 'duration' || !progress.textContent);
    $('#kpx-export-duration').textContent = durationLoad ? 'Остановить загрузку' : 'Загрузить длительности отбора';
  }

  function render() {
    syncControls();
    if (columnDrag) return;
    const all = curItems();
    if (!all.length) return;

    const list = visibleItems();
    $('#kpx-count').textContent = `${list.length} из ${all.length}`;
    $('#kpx-body').innerHTML = list.length
      ? (state.view === 'table' ? renderTable(list) : renderGrid(list))
      : '<div class="msg">Ничего не найдено</div>';
    const table = $('#kpx-body table');
    const widths = table && columnWidths[table.dataset.layout];
    if (widths && widths.length === table.rows[0].cells.length) sizeTable(table, widths);
  }

  function fillGenres() {
    const counts = new Map();
    curItems().forEach((i) => i.genres.forEach((g) => counts.set(g, (counts.get(g) || 0) + 1)));
    const sel = field('genre');
    const prev = sel.value;
    sel.innerHTML = '<option value="">Все жанры</option>' + [...counts]
      .sort((a, b) => a[0].localeCompare(b[0], 'ru'))
      .map(([g, n]) => `<option value="${esc(g)}">${esc(g)} (${n})</option>`)
      .join('');
    sel.value = counts.has(prev) ? prev : '';
  }

  new ResizeObserver(() => {
    if (columnDrag || root.hidden) return;
    const table = $('#kpx-body table');
    const widths = table && columnWidths[table.dataset.layout];
    if (table && widths?.length === table.rows[0].cells.length) sizeTable(table, widths);
  }).observe($('#kpx-body'));

  const setStamp = (path) => {
    $('#kpx-stamp').textContent = `обновлено ${new Date(stamps[path]).toLocaleString('ru')}`;
  };
  const setMsg = (text) => { $('#kpx-body').innerHTML = `<div class="msg">${esc(text)}</div>`; };
  let loading = false;

  async function load(force) {
    if (loading) return;
    loading = true;
    note('');
    $('#kpx-count').textContent = '';
    let fromCache = false;
    try {
      setMsg('Загружаю страницу 1…');
      ({ fromCache } = await ensureList([location.pathname], { force, onProgress: (p, total) => setMsg(`Загружаю страницу ${p} из ${total}…`) }));
      setStamp(location.pathname);
    } catch (e) {
      setMsg('Ошибка: ' + e.message);
      return;
    } finally {
      loading = false;
    }
    fillGenres();
    readFilters();
    render();
    if (fromCache) refreshNewest(location.pathname);
  }

  const AI_DEFAULTS = { voted: true, planned: true, type: 'all', genres: [], ratings: [], duration: true, durationMin: '', durationMax: '' };
  const readAi = () => ({
    voted: field('aiVoted').checked,
    planned: field('aiPlanned').checked,
    type: field('exportType').value,
    genres: [...root.querySelectorAll('[name="exportGenre"]:checked')].map((input) => input.value),
    ratings: [...root.querySelectorAll('[name="exportRating"]:checked')].map((input) => Number(input.value)),
    duration: field('exportDuration').checked,
    durationMin: field('exportDurationMin').value,
    durationMax: field('exportDurationMax').value,
  });

  function loadAiOptions() {
    const o = { ...AI_DEFAULTS, ...store.get('ai') };
    field('aiVoted').checked = o.voted;
    $('#kpx-export-rating-options').disabled = !o.voted;
    field('aiPlanned').checked = o.planned;
    field('exportType').value = o.type;
    fillExportGenres(o.genres);
    root.querySelectorAll('[name="exportRating"]').forEach((input) => { input.checked = o.ratings.includes(Number(input.value)); });
    field('exportDuration').checked = o.duration;
    field('exportDurationMin').value = o.durationMin;
    field('exportDurationMax').value = o.durationMax;
  }

  function fillExportGenres(selected = readAi().genres) {
    const genres = new Set(selected);
    for (const kind of ['voted', 'planned']) {
      if (!field(kind === 'voted' ? 'aiVoted' : 'aiPlanned').checked) continue;
      const paths = kind === listKind(location.pathname) ? [location.pathname] : listPaths(kind);
      paths.forEach((path) => lists[path]?.forEach((item) => item.genres.forEach((genre) => genres.add(genre))));
    }
    $('#kpx-export-genres').innerHTML = [...genres].sort((a, b) => a.localeCompare(b, 'ru'))
      .map((genre) => `<label><input type="checkbox" name="exportGenre" value="${esc(genre)}"${selected.includes(genre) ? ' checked' : ''}> ${esc(genre)}</label>`).join('');
  }

  async function prepareExportGenres() {
    const controls = [field('aiVoted'), field('aiPlanned'), $('#kpx-build')];
    if (controls.some((control) => control.disabled)) return;
    const opts = readAi();
    controls.forEach((control) => { control.disabled = true; });
    try {
      for (const kind of ['voted', 'planned']) {
        if (!opts[kind]) continue;
        $('#kpx-ai-info').textContent = 'Загружаю жанры выбранных списков…';
        await ensureList(kind === listKind(location.pathname) ? [location.pathname] : listPaths(kind));
      }
      fillExportGenres();
      $('#kpx-ai-info').textContent = '';
    } catch (e) {
      $('#kpx-ai-info').textContent = 'Ошибка: ' + e.message;
    } finally {
      controls.forEach((control) => { control.disabled = false; });
    }
  }

  // Адрес второго списка строим от пользователя из текущего URL; ссылку из шапки сайта оставляем запасной
  function listPaths(kind) {
    const user = location.pathname.split('/')[2];
    const name = kind === 'planned' ? 'planned-to-watch' : 'voted-watched';
    const header = kind === 'planned' ? document.querySelector('a[aria-label="Буду смотреть"]')?.getAttribute('href') : null;
    return [...new Set([`/user/${user}/movies/${name}/`, header].filter(Boolean))];
  }

  function formatItem(i, includeDuration) {
    const minutes = includeDuration ? durationFor(i) : null;
    const meta = [i.year, i.genres.join('/'), i.type === 'series' ? 'сериал' : 'фильм',
      minutes != null ? `${minutes} мин${i.type === 'series' ? ' всего' : ''}` : ''].filter(Boolean).join(', ');
    const marks = [i.my != null && `моя ${i.my}`, i.kp != null && `КП ${r1(i.kp)}`].filter(Boolean).join(', ');
    return `${i.title} (${meta})${marks ? ' — ' + marks : ''}`;
  }

  async function buildPrompt(loadRuntime = false) {
    const opts = readAi();
    if ((opts.durationMin && Number(opts.durationMin) < 1) || (opts.durationMax && Number(opts.durationMax) < 1) ||
        (opts.durationMin && opts.durationMax && Number(opts.durationMin) > Number(opts.durationMax))) {
      throw new Error('Проверь диапазон продолжительности в минутах');
    }
    store.set('ai', opts);
    const sections = [];
    for (const [kind, title] of [['voted', 'Мои оценки'], ['planned', 'Буду смотреть']]) {
      if (!opts[kind]) continue;
      $('#kpx-ai-info').textContent = `Загружаю «${title}»…`;
      const isOpen = kind === listKind(location.pathname);
      const { items } = await ensureList(isOpen ? [location.pathname] : listPaths(kind), {
        onProgress: (p, total) => { $('#kpx-ai-info').textContent = `«${title}»: страница ${p} из ${total}…`; },
      });
      const rows = items.filter((item) =>
        (opts.type === 'all' || item.type === opts.type) &&
        (!opts.genres.length || item.genres.some((genre) => opts.genres.includes(genre))) &&
        (kind !== 'voted' || !opts.ratings.length || opts.ratings.includes(item.my)));
      sections.push({ kind, title, rows });
    }
    if (!sections.length) throw new Error('Отметь хотя бы один список');
    if (loadRuntime) await loadDurations(sections.flatMap((section) => section.rows));
    if (opts.durationMin || opts.durationMax) {
      sections.forEach((section) => {
        section.rows = section.rows.filter((item) => {
          const minutes = durationFor(item);
          return minutes != null && (!opts.durationMin || minutes >= Number(opts.durationMin)) &&
            (!opts.durationMax || minutes <= Number(opts.durationMax));
        });
      });
    }

    const intro = ['Ниже данные из моего профиля на Кинопоиске. Оценки по 10-балльной шкале: «моя» — моя оценка, «КП» — рейтинг Кинопоиска.'];
    const kinds = sections.map((s) => s.kind);
    if (kinds.includes('voted')) intro.push('«Мои оценки» — то, что я уже смотрел.');
    if (kinds.includes('planned')) intro.push('«Буду смотреть» — кандидаты на просмотр.');
    if (opts.type !== 'all') intro.push(opts.type === 'film' ? 'Выгружены только фильмы.' : 'Выгружены только сериалы.');
    if (opts.genres.length) intro.push('Отбор по жанрам: ' + opts.genres.join(', ') + '.');
    if (opts.ratings.length && opts.voted) intro.push('Мои оценки для отбора: ' + opts.ratings.join(', ') + '.');
    if (opts.durationMin || opts.durationMax) intro.push(`Продолжительность: от ${opts.durationMin || 'любой'} до ${opts.durationMax || 'любой'} минут. Включены тайтлы с известной длительностью.`);

    const body = sections.map((s) => `## ${s.title} (${s.rows.length})\n${s.rows.map((item) => formatItem(item, opts.duration || opts.durationMin || opts.durationMax)).join('\n')}`);
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

  async function onBuild(loadRuntime = false) {
    const info = $('#kpx-ai-info');
    const button = $('#kpx-build');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const text = await buildPrompt(loadRuntime);
      $('#kpx-preview').value = text;
      info.textContent = `${text.length.toLocaleString('ru')} символов`;
      // после долгой загрузки браузер может не дать писать в буфер без клика — тогда есть кнопка «Копировать»
      await copyText(text).then(() => { info.textContent += ' · скопировано'; }, () => {});
    } catch (e) {
      info.textContent = 'Ошибка: ' + e.message;
    } finally {
      button.disabled = false;
    }
  }

  root.addEventListener('input', (e) => {
    if (e.target.closest('#kpx-ai')) {
      store.set('ai', readAi());
      $('#kpx-export-rating-options').disabled = !field('aiVoted').checked;
      if (['aiVoted', 'aiPlanned'].includes(e.target.name)) prepareExportGenres();
    }
    if (e.target.closest('.filters')) {
      if (e.target === field('sort') && e.target.value === 'added' && state.sort !== 'added') {
        state.dir = -1;
      }
      readFilters();
      render();
    }
  });

  root.addEventListener('pointerdown', (e) => {
    const edge = e.target.closest('.column-edge');
    if (!edge || e.button !== 0 || columnDrag) return;
    const cell = edge.parentElement;
    const table = cell.closest('table');
    const widths = Array.from(cell.parentElement.cells, (th) => Math.round(th.getBoundingClientRect().width));
    columnDrag = { table, widths, index: cell.cellIndex, start: e.clientX, width: widths[cell.cellIndex], pointerId: e.pointerId };
    root.setPointerCapture(e.pointerId);
    root.classList.add('resizing');
    e.preventDefault();
  });

  root.addEventListener('pointermove', (e) => {
    if (e.pointerId !== columnDrag?.pointerId) return;
    const { table, widths, index, start, width } = columnDrag;
    const next = Math.max(index === 0 ? 48 : 64, Math.round(width + e.clientX - start));
    if (next === widths[index]) return;
    widths[index] = next;
    sizeTable(table, widths);
  });

  root.addEventListener('lostpointercapture', (e) => {
    if (e.pointerId !== columnDrag?.pointerId) return;
    const { table, widths } = columnDrag;
    if (table.classList.contains('sized')) {
      columnWidths[table.dataset.layout] = widths;
      store.set('columnWidths', columnWidths);
    }
    columnDrag = null;
    root.classList.remove('resizing');
    render();
  });

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.view) { state.view = t.dataset.view; render(); }
    if (t.id === 'kpx-close') setOpen(false);
    if (t.id === 'kpx-refresh') load(true);
    if (t.id === 'kpx-dir') { state.dir = -state.dir; render(); }
    if (t.id === 'kpx-duration') {
      if (durationLoad) durationLoad.abort();
      else loadDurations();
    }
    if (t.id === 'kpx-export-duration') {
      if (durationLoad) durationLoad.abort();
      else onBuild(true);
    }
    if (t.id === 'kpx-ai-toggle') {
      $('#kpx-ai').hidden = !$('#kpx-ai').hidden;
      if (!$('#kpx-ai').hidden) prepareExportGenres();
    }
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
    if (t.id === 'kpx-columns-reset') {
      Object.keys(columnWidths).forEach((key) => { delete columnWidths[key]; });
      store.set('columnWidths', columnWidths);
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
    setOpen(true);
    // на «Буду смотреть» своей оценки нет — сортируем по рейтингу КП
    if (listKind(location.pathname) === 'planned' && state.sort === 'my') {
      state.sort = 'kp';
      field('sort').value = 'kp';
    } else {
      field('sort').value = state.sort;
    }
    loadAiOptions();
    syncControls();
    $('#kpx-stamp').textContent = '';
    if (curItems().length) {
      fillGenres();
      readFilters();
      render();
      refreshNewest(location.pathname);
    } else {
      load(false);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) setOpen(false);
  });

  // Кинопоиск — SPA: адрес меняется без перезагрузки, поэтому кнопку показываем только на нужных страницах
  let lastPath = location.pathname;
  const syncButton = () => {
    openBtn.style.display = LIST_PATH.test(location.pathname) ? '' : 'none';
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      setOpen(false);
    }
  };
  syncButton();
  setInterval(syncButton, 700);
})();
