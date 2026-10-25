// B3A home board plus KMB / Long Win and Citybus route search.
// All data comes straight from the operators' open data on DATA.GOV.HK; nothing runs on a server.
(() => {
  const REFRESH_MS = 30000;
  const DAY = 864e5;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const phone = matchMedia("(max-width: 759px)");
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmtClock = t => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Hong_Kong" });
  const bound = dir => (dir === "O" ? "outbound" : "inbound");
  const ICON = {
    pin: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>`,
    near: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4 3.5 10.6l7 2.9 2.9 7z"/></svg>`,
    down: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
  };

  // ---------- Cache (per-viewer convenience; everything still works without it) ----------
  const cache = {
    get(key, maxAge) {
      try {
        const v = JSON.parse(localStorage.getItem(key));
        return v && Date.now() - v.at < maxAge ? v.data : null;
      } catch { return null; }
    },
    set(key, data) {
      try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch {}
    },
  };

  async function getJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Run fn over items a few at a time.
  async function pool(items, size, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
    return out;
  }

  function distance(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(h));
  }
  function nearestStop(stops, lat, lng) {
    let best = null, bestD = Infinity;
    for (const s of stops) { const d = distance(s, { lat, lng }); if (d < bestD) { bestD = d; best = s; } }
    return { stop: best, dist: bestD };
  }

  // ---------- Operators ----------
  // Each operator exposes: routes() -> [{co, route, orig, dest, origEn, destEn}],
  // variants(route) -> [{dir, st, label, ids}], stops(ids) -> [{id, name, road, lat, lng}], eta(route, dir, st, stop).
  const OPS = {};

  OPS.CTB = (() => {
    const API = "https://rt.data.gov.hk/v2/transport/citybus";
    let list = null;
    const mem = {};
    async function routes() {
      if (list) return list;
      list = cache.get("ctb:routes", DAY);
      if (!list) {
        list = (await getJSON(`${API}/route/CTB`)).data.map(r => ({ co: "CTB", route: r.route, orig: r.orig_tc, dest: r.dest_tc, origEn: r.orig_en, destEn: r.dest_en }));
        cache.set("ctb:routes", list);
      }
      return list;
    }
    async function routeStops(route, dir) {
      const key = `ctb:rs:${route}:${bound(dir)}`;
      let ids = cache.get(key, DAY);
      if (!ids) {
        const json = await getJSON(`${API}/route-stop/CTB/${encodeURIComponent(route)}/${bound(dir)}`);
        ids = (json.data || []).sort((a, b) => a.seq - b.seq).map(s => s.stop)
          .filter((id, i, arr) => id !== arr[i - 1]); // some routes list the same stop twice in a row
        cache.set(key, ids);
      }
      return ids;
    }
    async function variants(route) {
      const [o, i] = await Promise.all([routeStops(route, "O"), routeStops(route, "I").catch(() => [])]);
      return [{ dir: "O", st: "", ids: o }, { dir: "I", st: "", ids: i }].filter(v => v.ids.length);
    }
    async function stop(id) {
      if (mem[id]) return mem[id];
      let s = cache.get(`ctb:stop:${id}`, 7 * DAY);
      if (!s) {
        const d = (await getJSON(`${API}/stop/${id}`)).data;
        const [name, road = ""] = d.name_tc.split(",").map(x => x.trim());
        s = { id, name, road, lat: +d.lat, lng: +d.long };
        cache.set(`ctb:stop:${id}`, s);
      }
      return (mem[id] = s);
    }
    // Citybus has no bulk stop endpoint, so fetch a route's stops a few at a time.
    async function stops(ids, onProgress) {
      let done = 0;
      return pool(ids, 6, async id => { const s = await stop(id); onProgress?.(++done, ids.length); return s; });
    }
    async function eta(route, dir, st, stopId) {
      const json = await getJSON(`${API}/eta/CTB/${stopId}/${encodeURIComponent(route)}`);
      return (json.data || []).filter(e => e.dir === dir);
    }
    return { name: "城巴", routes, variants, stops, stop, eta };
  })();

  OPS.KMB = (() => {
    const API = "https://data.etabus.gov.hk/v1/transport/kmb";
    let raw = null, list = null, stopMap = null;
    // KMB stop names carry a stop code, e.g. "石排站 (TM584)".
    const clean = s => String(s).replace(/\s*\([A-Z]{1,3}\d{1,4}\)\s*$/, "").trim();
    async function rawRoutes() {
      if (raw) return raw;
      raw = cache.get("kmb:routes", DAY);
      if (!raw) {
        raw = (await getJSON(`${API}/route/`)).data.map(r => ({ route: r.route, dir: r.bound, st: r.service_type, orig: r.orig_tc, dest: r.dest_tc, origEn: r.orig_en, destEn: r.dest_en }));
        cache.set("kmb:routes", raw);
      }
      return raw;
    }
    async function routes() {
      if (list) return list;
      const byRoute = new Map();
      for (const r of await rawRoutes()) {
        const cur = byRoute.get(r.route);
        // Show each route once, described by its main outbound trip.
        const rank = x => (x.dir === "O" ? 0 : 2) + (x.st === "1" ? 0 : 1);
        if (!cur || rank(r) < rank(cur)) byRoute.set(r.route, r);
      }
      list = [...byRoute.values()].map(r => ({ co: "KMB", route: r.route, orig: r.orig, dest: r.dest, origEn: r.origEn, destEn: r.destEn }));
      return list;
    }
    async function allStops() {
      if (stopMap) return stopMap;
      stopMap = cache.get("kmb:stops", 7 * DAY);
      if (!stopMap) {
        stopMap = {};
        for (const s of (await getJSON(`${API}/stop`)).data) stopMap[s.stop] = [clean(s.name_tc), +(+s.lat).toFixed(6), +(+s.long).toFixed(6)];
        cache.set("kmb:stops", stopMap);
      }
      return stopMap;
    }
    async function variants(route) {
      const entries = (await rawRoutes()).filter(r => r.route === route);
      const out = await Promise.all(entries.map(async r => {
        const key = `kmb:rs:${route}:${r.dir}:${r.st}`;
        let ids = cache.get(key, DAY);
        if (!ids) {
          const json = await getJSON(`${API}/route-stop/${encodeURIComponent(route)}/${bound(r.dir)}/${r.st}`);
          ids = (json.data || []).sort((a, b) => a.seq - b.seq).map(s => s.stop).filter((id, i, arr) => id !== arr[i - 1]);
          cache.set(key, ids);
        }
        return { dir: r.dir, st: r.st, ids, label: r.st === "1" ? "" : `${r.orig} → ${r.dest}` };
      }));
      return out.filter(v => v.ids.length).sort((a, b) => (a.dir === "O" ? 0 : 1) - (b.dir === "O" ? 0 : 1) || +a.st - +b.st);
    }
    async function stops(ids, onProgress) {
      const map = await allStops();
      onProgress?.(ids.length, ids.length);
      return ids.map(id => map[id] && { id, name: map[id][0], road: "", lat: map[id][1], lng: map[id][2] }).filter(Boolean);
    }
    async function stop(id) { return (await stops([id]))[0]; }
    async function eta(route, dir, st, stopId) {
      const json = await getJSON(`${API}/eta/${stopId}/${encodeURIComponent(route)}/${st || 1}`);
      return (json.data || []).filter(e => e.dir === dir);
    }
    return { name: "九巴", routes, variants, stops, stop, eta };
  })();

  const coName = co => OPS[co]?.name || co;

  // ---------- Map ----------
  const map = L.map("map", { scrollWheelZoom: !phone.matches, dragging: !phone.matches, tap: false, zoomControl: !phone.matches });
  map.zoomControl?.setPosition("bottomright");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · 九巴 龍運 城巴 <a href="https://data.gov.hk/tc-data/group/transportation">DATA.GOV.HK</a>',
  }).addTo(map);
  map.setView([22.41, 113.98], 12);

  let mapLayer = null, markers = {}, userMarker = null;

  function fitTo(points) {
    if (!points.length) return;
    const opts = phone.matches
      ? { paddingTopLeft: [24, 96], paddingBottomRight: [24, Math.round(innerHeight * 0.56)] }
      : { paddingTopLeft: [460, 48], paddingBottomRight: [48, 48] };
    map.fitBounds(L.latLngBounds(points), opts);
  }

  function stopMarker(s, { key = false, label = "", color }) {
    const m = L.circleMarker([s.lat, s.lng], {
      radius: key ? 8 : 4, weight: key ? 3 : 2, color, fillColor: css("--marker"), fillOpacity: 1,
    }).addTo(mapLayer);
    if (key) m.bindTooltip(label || s.name, { permanent: true, direction: "right", offset: [10, 0], className: "stop-label" });
    else m.bindTooltip(s.name, { direction: "top", className: "stop-minor" });
    markers[s.id] = m;
    return m;
  }

  function resetMap() {
    mapLayer?.remove();
    mapLayer = L.layerGroup().addTo(map);
    markers = {};
  }

  // Centre a stop in the part of the map the panels don't cover.
  function flyToStop(id) {
    const m = markers[id];
    if (!m) return;
    const size = map.getSize(), zoom = 16;
    const visible = phone.matches ? L.point(size.x / 2, size.y * 0.27) : L.point(434 + (size.x - 434) / 2, size.y / 2);
    const offset = L.point(size.x / 2, size.y / 2).subtract(visible);
    map.flyTo(map.unproject(map.project(m.getLatLng(), zoom).add(offset), zoom), zoom, { animate: !reduceMotion, duration: 0.8 });
    m.openTooltip();
    if (phone.matches) scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }

  // ---------- Boards ----------
  // A board is a set of sections; each section shows arrivals of one route+direction at one stop,
  // optionally merged with a partner operator's trips on a jointly run route.
  const boardEl = $("board");
  let board = null;

  function sectionEl(innerTop) {
    const el = document.createElement("section");
    el.className = "sheet glass glass-text";
    el.innerHTML = `${innerTop}<div class="next"><span class="empty">載入中…</span></div><ul class="later"></ul>
      <button class="tt-toggle" type="button" aria-expanded="false">時刻表${ICON.down}</button>
      <div class="tt" hidden></div>`;
    return el;
  }

  // ---------- Timetables ----------
  // Built from the Transport Department GTFS feed by tools/build_timetables.py: departures from each
  // variant's first stop, as time windows with a headway, grouped by day type.
  const TT_VERSION = "2026-10-14";
  const ttMem = {};
  const getTimetable = route => (ttMem[route] ??= getJSON(`timetables/${encodeURIComponent(route)}.json?v=${TT_VERSION}`).catch(() => []));
  const holidays = getJSON(`timetables/holidays.json?v=${TT_VERSION}`).catch(() => []);
  const TT_AGENCIES = { KMB: ["KMB", "LWB", "KMB+CTB", "LWB+CTB"], CTB: ["CTB", "KMB+CTB", "LWB+CTB"] };

  function hkNow() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map(p => [p.type, p.value]));
    return { date: `${parts.year}${parts.month}${parts.day}`, day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday), min: +parts.hour * 60 + +parts.minute };
  }
  const toMin = t => { const [h, m] = t.split(":"); return +h * 60 + +m; };

  // Timetable variants that run along this direction: same operator family, starting near its first stop
  // and ending at one of its stops (this also picks up short trips such as 深圳灣口岸 → 富泰邨).
  function matchTimetable(all, co, stops) {
    if (!stops?.length) return [];
    const near = (p, s, m) => p && distance({ lat: p[0], lng: p[1] }, s) < m;
    return all.filter(v => TT_AGENCIES[co].includes(v.agency) && near(v.o, stops[0], 1500) && stops.some(s => near(v.d, s, 600)));
  }

  function setupTimetable(s) {
    const btn = s.el.querySelector(".tt-toggle"), box = s.el.querySelector(".tt");
    btn.addEventListener("click", () => {
      const open = btn.getAttribute("aria-expanded") !== "true";
      btn.setAttribute("aria-expanded", String(open));
      box.hidden = !open;
      if (open) renderTimetable(s);
    });
  }

  async function renderTimetable(s) {
    const box = s.el.querySelector(".tt");
    if (box.hidden) return;
    if (!box.innerHTML) box.innerHTML = `<p class="hint">載入中…</p>`;
    const [all, hol] = await Promise.all([getTimetable(s.route), holidays]);
    const variants = matchTimetable(all, s.co, s.ttStops);
    if (!variants.length) { box.innerHTML = `<p class="hint">暫時沒有這個方向的時刻表</p>`; return; }

    const now = hkNow(), isHoliday = hol.includes(now.date);
    const todays = v => v.days.find(d => (isHoliday ? d.holidays : d.mask[now.day] === "1" && !(d.holidays && !d.mask.includes("1")))) || v.days[0];
    const main = variants[0];
    if (!main.days.some(d => d.label === s.ttDay)) s.ttDay = todays(main).label;
    const picked = main.days.find(d => d.label === s.ttDay);
    const isToday = picked === todays(main);

    const rowsHtml = day => {
      const rows = day.rows;
      // The window running now, or else the next single departure.
      const cur = !isToday ? -1 : rows.findIndex(r => (r.length === 3 ? toMin(r[0]) <= now.min && now.min < toMin(r[1]) : toMin(r[0]) >= now.min));
      return rows.map((r, i) => `<li${i === cur ? ` class="now"` : ""}>${r.length === 3
        ? `<span>${r[0]} – ${r[1]}</span><span>每 ${r[2]} 分</span>` : `<span>${r[0]}</span><span></span>`}</li>`).join("");
    };
    // Other variants show the group that overlaps the chosen day type.
    const shown = variants.map((v, i) => [v, i === 0 ? picked : v.days.find(d => [...d.mask].some((b, k) => b === "1" && picked.mask[k] === "1") || (d.holidays && picked.holidays))])
      .filter(([, day]) => day);
    const blocks = shown.map(([v, day]) => {
      const title = shown.length > 1 ? `${esc(v.from)} 開出 · 往 ${esc(v.to)}` : `${esc(v.from)} 開出`;
      return `<p class="tt-from">${title}</p><ol class="tt-rows">${rowsHtml(day)}</ol>`;
    }).join("");
    box.innerHTML = (main.days.length > 1
      ? `<div class="seg tt-days" role="group" aria-label="日子">${main.days.map(d => `<button type="button" data-day="${esc(d.label)}" aria-pressed="${d === picked}">${esc(d.label.replace(/^星期/, ""))}</button>`).join("")}</div>`
      : `<p class="tt-from">${esc(picked.label)}</p>`) + blocks;
    box.querySelector(".tt-days")?.addEventListener("click", e => {
      const b = e.target.closest("button[data-day]");
      if (b) { s.ttDay = b.dataset.day; renderTimetable(s); }
    });
  }

  function setTitle(no, main, sub, home = false) {
    $("title-no").textContent = no;
    $("title-main").textContent = main;
    $("title-sub").textContent = sub;
    document.title = home ? "B3A Fu Tai ⇄ Shenzhen Bay" : `${no} ${main} · 巴士到站`;
  }

  function b3aBoard() {
    const R = window.B3A_ROUTE;
    setTitle("B3A", "富泰 ⇄ 深圳灣口岸", "城巴", true);
    $("home").hidden = true;

    const defs = [
      // Toward Shenzhen Bay -> when buses reach Fu Tai Estate (Castle Peak Road).
      { stop: "003261", dir: "O", h: "往 深圳灣口岸", p: "富泰邨 · 青山公路" },
      // Toward Fu Tai -> when buses leave Shenzhen Bay Port.
      { stop: "003208", dir: "I", h: "往 富泰 · 山景邨", p: "深圳灣口岸 · 開出" },
    ];
    const sections = defs.map(d => {
      const el = sectionEl(`<div class="sheet-head"><div><h2>${d.h}</h2><p>${d.p}</p></div><button class="icon-btn locate" type="button" aria-label="在地圖上顯示">${ICON.pin}</button></div>`);
      el.querySelector(".locate").addEventListener("click", () => flyToStop(d.stop));
      const s = { el, co: "CTB", route: "B3A", stop: d.stop, dir: d.dir, st: "", etas: [], ttStops: d.dir === "O" ? R.stops.outbound : R.stops.inbound };
      setupTimetable(s);
      return s;
    });
    boardEl.replaceChildren(...sections.map(s => s.el));

    function drawMap() {
      resetMap();
      const sodium = css("--accent"), ret = css("--return");
      L.polyline(R.paths.inbound, { color: ret, weight: 3, dashArray: "6 6", opacity: 0.9 }).addTo(mapLayer);
      L.polyline(R.paths.outbound, { color: sodium, weight: 4, opacity: 0.95 }).addTo(mapLayer);
      const KEY = { "003261": "富泰邨", "003208": "深圳灣口岸", "003201": "山景邨" };
      const seen = new Set();
      [...R.stops.outbound, ...R.stops.inbound].forEach(s => {
        if (seen.has(s.id)) return;
        seen.add(s.id);
        stopMarker(s, { key: s.id in KEY, label: KEY[s.id], color: s.id in KEY ? sodium : ret });
      });
    }
    drawMap();
    fitTo([...R.paths.outbound, ...R.paths.inbound]);
    return { sections, redrawMap: drawMap };
  }

  // Jointly run routes share a number with the other operator *and* start and end in the same places.
  // (Many numbers exist at both operators as unrelated routes, e.g. KMB 1 and Citybus 1.)
  async function findPartner(co, route, variant, onStatus) {
    const other = co === "KMB" ? "CTB" : "KMB";
    const list = await OPS[other].routes().catch(() => []);
    if (!list.some(r => r.route === route)) return null;
    onStatus?.(`正在核對${coName(other)}聯營班次…`);
    const vs = await OPS[other].variants(route).catch(() => []);
    const first = variant.stops[0], last = variant.stops[variant.stops.length - 1];
    for (const v of vs) {
      if (v.st && v.st !== "1") continue; // compare against the other operator's regular trips only
      const [a, b] = await OPS[other].stops([v.ids[0], v.ids[v.ids.length - 1]]);
      if (a && b && distance(a, first) < 1500 && distance(b, last) < 1500) {
        v.stops = (await OPS[other].stops(v.ids)).filter(Boolean);
        return { co: other, route, dir: v.dir, st: v.st, stops: v.stops };
      }
    }
    return null;
  }

  // A searched route: pick direction and boarding stop; state lives in the hash (#co/ROUTE/DIR-ST/STOP).
  async function routeBoard(co, routeNo, want) {
    const op = OPS[co];
    const list = await op.routes().catch(() => null);
    const info = list?.find(r => r.route === routeNo);
    setTitle(routeNo, info ? `${info.orig} ⇄ ${info.dest}` : `${op.name}路線`, op.name);
    $("home").hidden = false;

    // The boarding stop is the sheet's title; tapping it opens the native picker.
    const el = sectionEl(`<div class="sheet-head">
        <label class="picker"><span class="picked h">載入路線…</span>${ICON.down}<select class="stop-select" aria-label="上車站" disabled></select></label>
        <button class="icon-btn nearest" type="button" aria-label="選擇最近的站">${ICON.near}</button>
        <button class="icon-btn locate" type="button" aria-label="在地圖上顯示">${ICON.pin}</button>
      </div>
      <div class="seg" role="group" aria-label="方向"></div>
      <label class="picker variant-pick" hidden><span class="picked"></span>${ICON.down}<select class="variant" aria-label="班次類型"></select></label>
      <p class="hint" hidden></p>`);
    boardEl.replaceChildren(el);
    const section = { el, co, route: routeNo, stop: null, dir: null, st: "", etas: [], idle: true, partner: null, ttStops: null };
    setupTimetable(section);
    const segEl = el.querySelector(".seg"), selectEl = el.querySelector(".stop-select");
    const variantEl = el.querySelector(".variant"), variantPick = el.querySelector(".variant-pick"), hintEl = el.querySelector(".hint");
    const hint = msg => { hintEl.hidden = !msg; hintEl.textContent = msg || ""; };
    const stale = () => currentKey !== `${co}/${routeNo}`; // user moved on while loading
    resetMap();

    let variants;
    try {
      variants = await op.variants(routeNo);
    } catch (err) {
      el.querySelector(".h").textContent = "未能載入路線";
      el.querySelector(".next").innerHTML = `<span class="empty">請檢查網絡後按「刷新」再試（${esc(err.message)}）</span>`;
      section.retry = () => go(location.hash, true);
      return { sections: [section] };
    }
    if (!variants.length) {
      el.querySelector(".h").textContent = "找不到這條路線的站點";
      el.querySelector(".next").innerHTML = `<span class="empty">${op.name}暫時沒有提供 ${esc(routeNo)} 的站點資料</span>`;
      return { sections: [section] };
    }

    try {
      const all = [...new Set(variants.flatMap(v => v.ids))];
      const got = await op.stops(all, (n, total) => hint(`載入站點中… ${n}/${total}`));
      const byId = Object.fromEntries(got.filter(Boolean).map(s => [s.id, s]));
      for (const v of variants) v.stops = v.ids.map(id => byId[id]).filter(Boolean);
    } catch (err) {
      hint(`部分站點未能載入（${err.message}），請稍後再試`);
      for (const v of variants) v.stops = v.stops || [];
    }
    variants = variants.filter(v => v.stops.length);
    hint("");
    if (stale()) return null;

    const dirs = [...new Set(variants.map(v => v.dir))];
    const main = d => variants.filter(v => v.dir === d).sort((a, b) => (a.st === "1" || !a.st ? -1 : 1) - (b.st === "1" || !b.st ? -1 : 1))[0];
    let cur = variants.find(v => v.dir === want.dir && (v.st || "") === (want.st || v.st || "")) || main(dirs[0]);
    const partners = new Map(); // variant -> partner (or null) once checked

    function drawMap() {
      resetMap();
      const ret = css("--return"), sodium = css("--accent");
      dirs.map(main).forEach(v => {
        if (v !== cur) L.polyline(v.stops.map(s => [s.lat, s.lng]), { color: ret, weight: 2, opacity: 0.35, dashArray: "4 6" }).addTo(mapLayer);
      });
      L.polyline(cur.stops.map(s => [s.lat, s.lng]), { color: sodium, weight: 3, opacity: 0.9, dashArray: "6 6" }).addTo(mapLayer);
      cur.stops.forEach(s => stopMarker(s, { key: s.id === section.stop, color: s.id === section.stop ? sodium : ret }));
      if (userMarker) userMarker.addTo(mapLayer);
    }

    // Attach the other operator's matching stop when this route is jointly run.
    function attachPartner() {
      const p = partners.get(cur);
      const here = cur.stops.find(s => s.id === section.stop);
      section.partner = null;
      if (p && here) {
        const { stop, dist } = nearestStop(p.stops, here.lat, here.lng);
        if (dist < 300) section.partner = { ...p, stop: stop.id };
      }
      $("title-sub").textContent = p ? "九巴 · 城巴聯營" : op.name;
    }

    async function checkPartner() {
      const v = cur;
      if (partners.has(v)) return attachPartner();
      partners.set(v, null);
      const p = await findPartner(co, routeNo, v, hint).catch(() => null);
      partners.set(v, p);
      if (stale() || v !== cur) return;
      hint("");
      attachPartner();
      if (p) load(true);
    }

    function apply(stopId, { fit = false, fly = false } = {}) {
      const stop = cur.stops.find(s => s.id === stopId) || cur.stops[0];
      Object.assign(section, { dir: cur.dir, st: cur.st, stop: stop.id, etas: [], loaded: false, idle: false, ttStops: cur.stops });
      el.querySelector(".h").textContent = stop.name;
      segEl.querySelectorAll("button").forEach(btn => btn.setAttribute("aria-pressed", String(btn.dataset.dir === cur.dir)));
      const same = variants.filter(v => v.dir === cur.dir);
      const vLabel = v => (v.st === "1" || !v.st ? "正常班次" : `特別班次 · ${v.label}`);
      variantPick.hidden = same.length < 2;
      variantPick.querySelector(".picked").textContent = vLabel(cur);
      variantEl.innerHTML = same.map(v => `<option value="${v.st}"${v === cur ? " selected" : ""}>${esc(vLabel(v))}</option>`).join("");
      selectEl.innerHTML = cur.stops.map(s => `<option value="${s.id}"${s.id === stop.id ? " selected" : ""}>${esc(s.name)}${s.road ? ` · ${esc(s.road)}` : ""}</option>`).join("");
      selectEl.disabled = false;
      history.replaceState(null, "", `#${co.toLowerCase()}/${encodeURIComponent(routeNo)}/${cur.dir}${cur.st ? `-${cur.st}` : ""}/${stop.id}`);
      cache.set(`last:${co}:${routeNo}`, { dir: cur.dir, st: cur.st, stop: stop.id });
      drawMap();
      if (fit) fitTo(cur.stops.map(s => [s.lat, s.lng]));
      if (fly) flyToStop(stop.id);
      attachPartner();
      el.querySelector(".next").innerHTML = `<span class="empty">載入中…</span>`;
      el.querySelector(".later").innerHTML = "";
      load(true);
      checkPartner();
      renderTimetable(section);
    }

    // Switching direction or trip type keeps the same stop if served, otherwise the closest one,
    // but never auto-picks the terminus (nobody boards there in this direction).
    function switchTo(v) {
      const prev = cur.stops.find(s => s.id === section.stop);
      cur = v;
      const boardable = cur.stops.length > 1 ? cur.stops.slice(0, -1) : cur.stops;
      const same = prev && (boardable.find(s => s.id === prev.id) || nearestStop(boardable, prev.lat, prev.lng).stop);
      apply(same?.id, { fit: true });
    }

    segEl.innerHTML = dirs.map(d => `<button type="button" data-dir="${d}">往 ${esc(main(d).stops.at(-1)?.name || "")}</button>`).join("");
    if (dirs.length === 1) segEl.innerHTML = `<span class="solo">循環線 · 往 ${esc(main(dirs[0]).stops.at(-1)?.name || "")}</span>`;
    segEl.addEventListener("click", e => {
      const btn = e.target.closest("button[data-dir]");
      if (btn && btn.dataset.dir !== cur.dir) switchTo(main(btn.dataset.dir));
    });
    variantEl.addEventListener("change", () => switchTo(variants.find(v => v.dir === cur.dir && v.st === variantEl.value)));
    selectEl.addEventListener("change", () => apply(selectEl.value, { fly: true }));
    el.querySelector(".locate").addEventListener("click", () => flyToStop(section.stop));
    el.querySelector(".nearest").addEventListener("click", () => {
      if (!navigator.geolocation) return hint("這個瀏覽器不支援定位");
      hint("正在取得你的位置…");
      navigator.geolocation.getCurrentPosition(pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        const { stop, dist } = nearestStop(cur.stops.length > 1 ? cur.stops.slice(0, -1) : cur.stops, lat, lng);
        userMarker = L.marker([lat, lng], { icon: L.divIcon({ className: "user-dot", iconSize: [16, 16] }), interactive: false });
        hint(dist > 3000 ? `最近的站在 ${(dist / 1000).toFixed(1)} 公里外` : `最近的站約 ${Math.round(dist / 10) * 10} 米`);
        apply(stop.id, { fly: true });
      }, err => {
        hint(err.code === 1 ? "沒有定位權限，請直接選擇車站" : "暫時無法定位，請直接選擇車站");
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });

    let wantStop = want.stop;
    const remembered = cache.get(`last:${co}:${routeNo}`, 365 * DAY) || (co === "CTB" && cache.get(`ctb:last:${routeNo}`, 365 * DAY));
    if (!wantStop && remembered) {
      cur = variants.find(v => v.dir === remembered.dir && (v.st || "") === (remembered.st || "")) || cur;
      wantStop = remembered.stop;
    }
    const result = { sections: [section], redrawMap: drawMap };
    board = result;
    apply(wantStop, { fit: true });
    return result;
  }

  // ---------- Arrivals ----------
  const statusEl = $("status"), refreshBtn = $("refresh");
  let lastOk = null, error = null, loading = false, nextAt = 0, timer = null, loadSeq = 0;

  function renderSection(s, now) {
    const nextEl = s.el.querySelector(".next"), laterEl = s.el.querySelector(".later");
    if (s.idle || !s.stop) return;
    const upcoming = s.etas.filter(e => e.t > now - 60000);
    // KMB marks timetable-only times as "原定班次"; show that quietly instead of repeating the words.
    const sched = e => /原定班次|Scheduled/.test(e.rmk || "");
    const note = e => [s.partner ? coName(e.co) : "", sched(e) ? "時刻表" : esc(e.rmk || "")].filter(Boolean).join(" · ");
    if (!upcoming.length) {
      if (!s.loaded) return;
      nextEl.innerHTML = `<span class="empty">${s.failed ? "未能載入，請按刷新再試" : (s.rmk ? esc(s.rmk) : "暫時沒有班次")}</span>`;
      laterEl.innerHTML = "";
      return;
    }
    const [first, ...rest] = upcoming;
    const m = Math.ceil((first.t - now) / 60000);
    const firstNote = note(first);
    nextEl.innerHTML = (m <= 0 ? `<span class="big due">即將到站</span>` : `<span class="big">${m}</span><span class="unit">分鐘</span>`)
      + `<span class="clock">${fmtClock(first.t)}${firstNote ? `<small>${firstNote}</small>` : ""}</span>`;
    laterEl.innerHTML = rest.map(e => {
      const mm = Math.max(0, Math.ceil((e.t - now) / 60000));
      return `<li class="${sched(e) ? "sched" : ""}" title="${fmtClock(e.t)}${sched(e) ? " · 時刻表" : ""}"><b>${mm}</b>分${s.partner ? `<small>${coName(e.co)}</small>` : ""}</li>`;
    }).join("");
  }

  function render() {
    const now = Date.now();
    board?.sections.forEach(s => renderSection(s, now));
    const ago = lastOk ? Math.max(0, Math.round((now - lastOk) / 1000)) : null;
    const until = Math.max(0, Math.ceil((nextAt - now) / 1000));
    if (loading) statusEl.textContent = "更新中";
    else if (error) statusEl.innerHTML = `<span class="err">未能更新</span>`;
    else statusEl.textContent = ago === null ? "" : ago < 5 ? "剛剛更新" : `${ago} 秒前更新`;
    refreshBtn.classList.toggle("failed", !!error && !loading);
    refreshBtn.title = error || (ago === null ? "刷新" : `${until} 秒後自動刷新`);
    refreshBtn.style.setProperty("--ring-offset", String(119.4 * (1 - Math.min(1, until / (REFRESH_MS / 1000)))));
  }

  async function loadSection(s) {
    const legs = [{ co: s.co, route: s.route, dir: s.dir, st: s.st, stop: s.stop }];
    if (s.partner) legs.push(s.partner);
    const results = await Promise.allSettled(legs.map(async l =>
      (await OPS[l.co].eta(l.route, l.dir, l.st, l.stop)).map(e => ({ ...e, co: l.co }))));
    if (results[0].status === "rejected") throw results[0].reason; // the partner leg is best-effort
    const rows = results.flatMap(r => (r.status === "fulfilled" ? r.value : []));
    s.etas = rows.filter(e => e.eta).map(e => ({ t: Date.parse(e.eta), rmk: e.rmk_tc, co: e.co })).sort((a, b) => a.t - b.t);
    s.rmk = rows.find(e => !e.eta && e.rmk_tc)?.rmk_tc || ""; // e.g. last bus has left
    s.loaded = true;
  }

  async function load(force = false) {
    if (loading && !force) return;
    const seq = ++loadSeq;
    loading = true;
    clearTimeout(timer);
    refreshBtn.classList.add("loading");
    refreshBtn.setAttribute("aria-busy", "true");
    render();
    const sections = (board?.sections || []).filter(s => s.stop && !s.idle);
    if (!sections.length && board?.sections[0]?.retry) board.sections[0].retry();
    const results = await Promise.allSettled(sections.map(loadSection));
    if (seq !== loadSeq) return; // a newer load (e.g. a different stop) took over
    results.forEach((r, i) => sections[i].failed = r.status === "rejected" && !sections[i].etas.length);
    const failed = results.find(r => r.status === "rejected");
    if (failed) error = navigator.onLine === false ? "沒有網絡連線，顯示的是上次的結果" : `更新失敗（${failed.reason.message}），請檢查網絡`;
    else if (sections.length) { error = null; lastOk = Date.now(); }
    loading = false;
    refreshBtn.classList.remove("loading");
    refreshBtn.removeAttribute("aria-busy");
    nextAt = Date.now() + REFRESH_MS;
    timer = setTimeout(load, REFRESH_MS);
    render();
  }

  refreshBtn.addEventListener("click", () => load());
  // Phones pause timers in the background; catch up as soon as the page is visible again.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() >= nextAt) load(); });
  setInterval(render, 1000);

  // ---------- Routing ----------
  // ""                     -> B3A home
  // "#kmb/960/O-1/STOP"    -> KMB / Long Win route, direction O, service type 1
  // "#ctb/B3X/O/STOP"      -> Citybus route
  // "#B3X/O/STOP"          -> older Citybus links
  function parseHash(hash) {
    const parts = decodeURIComponent(hash.replace(/^#/, "")).split("/");
    let co = "CTB";
    if (/^(kmb|ctb)$/i.test(parts[0])) co = parts.shift().toUpperCase();
    const [route = "", dirSt = "", stop = ""] = parts;
    const [dir, st = ""] = dirSt.split("-");
    return { co, route: route.toUpperCase(), dir, st, stop };
  }

  let currentKey = null;
  async function go(hash, forceReload = false) {
    const h = parseHash(hash);
    const key = h.route ? `${h.co}/${h.route}` : "";
    if (!forceReload && key === currentKey) return;
    currentKey = key;
    lastOk = null; error = null;
    statusEl.textContent = "";
    if (!key) {
      board = b3aBoard();
      load(true);
    } else {
      board = { sections: [] };
      const b = await routeBoard(h.co, h.route, h);
      if (b && currentKey === key) board = b;
    }
  }
  addEventListener("hashchange", () => go(location.hash));
  $("home").addEventListener("click", () => { history.pushState(null, "", location.pathname + location.search); go(""); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => board?.redrawMap?.());
  phone.addEventListener?.("change", () => location.reload());

  // ---------- Search ----------
  const qEl = $("q"), resultsEl = $("results"), clearEl = $("clear");
  let active = -1, shown = [], allRoutes = null;

  async function getAllRoutes() {
    if (allRoutes) return allRoutes;
    const lists = await Promise.allSettled([OPS.KMB.routes(), OPS.CTB.routes()]);
    const ok = lists.filter(r => r.status === "fulfilled").flatMap(r => r.value);
    if (!ok.length) throw lists[0].reason;
    if (lists.every(r => r.status === "fulfilled")) allRoutes = ok; // retry later if one operator failed
    return ok;
  }

  const norm = s => String(s || "").normalize("NFKC").toUpperCase().replace(/\s+/g, "");
  const routeKey = r => r.replace(/\d+/g, n => n.padStart(4, "0"));

  function search(routes, q) {
    const n = norm(q);
    if (!n) return [];
    const hits = [];
    for (const r of routes) {
      const no = norm(r.route);
      if (no.startsWith(n)) hits.push([no === n ? 0 : 1, r]);
      else if ((n.length >= 2 || /[^\x00-\x7F]/.test(n)) && [r.orig, r.dest, r.origEn, r.destEn].some(x => norm(x).includes(n))) hits.push([2, r]);
    }
    return hits
      .sort((a, b) => a[0] - b[0] || routeKey(a[1].route).localeCompare(routeKey(b[1].route)) || a[1].co.localeCompare(b[1].co))
      .slice(0, 50).map(x => x[1]);
  }

  function showResults(items, note) {
    shown = items;
    active = items.length ? 0 : -1;
    resultsEl.innerHTML = note
      ? `<li class="note" role="presentation">${esc(note)}</li>`
      : items.map((r, i) => `<li role="option" id="opt-${i}" data-co="${r.co}" data-route="${esc(r.route)}" aria-selected="${i === active}">
          <span class="rno">${esc(r.route)}</span><span class="rdest">往 ${esc(r.dest)}<small>${esc(r.orig)}開出</small></span><span class="op">${coName(r.co)}</span></li>`).join("");
    resultsEl.hidden = !resultsEl.children.length;
    qEl.setAttribute("aria-expanded", String(!resultsEl.hidden));
    qEl.setAttribute("aria-activedescendant", active >= 0 ? `opt-${active}` : "");
  }

  function highlight(i) {
    if (!shown.length) return;
    active = (i + shown.length) % shown.length;
    [...resultsEl.children].forEach((li, j) => li.setAttribute("aria-selected", String(j === active)));
    resultsEl.children[active]?.scrollIntoView({ block: "nearest" });
    qEl.setAttribute("aria-activedescendant", `opt-${active}`);
  }

  function pick(co, route) {
    qEl.value = "";
    clearEl.hidden = true;
    showResults([]);
    qEl.blur();
    const last = cache.get(`last:${co}:${route}`, 365 * DAY);
    const base = `${co.toLowerCase()}/${encodeURIComponent(route)}`;
    location.hash = last ? `${base}/${last.dir}${last.st ? `-${last.st}` : ""}/${last.stop}` : base;
  }

  async function onInput() {
    const q = qEl.value;
    clearEl.hidden = !q;
    if (!norm(q)) return showResults([]);
    let routes;
    if (!allRoutes) showResults([], "載入中…");
    try { routes = await getAllRoutes(); } catch {
      return showResults([], navigator.onLine === false ? "搜尋需要網絡連線" : "未能載入路線，請稍後再試");
    }
    if (qEl.value !== q) return;
    const items = search(routes, q);
    items.length ? showResults(items) : showResults([], `沒有「${q.trim()}」的路線`);
  }

  qEl.addEventListener("input", onInput);
  qEl.addEventListener("focus", () => { if (qEl.value) onInput(); else getAllRoutes().catch(() => {}); });
  qEl.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(active - 1); }
    else if (e.key === "Enter" && shown[active]) { e.preventDefault(); pick(shown[active].co, shown[active].route); }
    else if (e.key === "Escape") { qEl.value = ""; clearEl.hidden = true; showResults([]); }
  });
  resultsEl.addEventListener("click", e => {
    const li = e.target.closest("li[data-route]");
    if (li) pick(li.dataset.co, li.dataset.route);
  });
  clearEl.addEventListener("click", () => { qEl.value = ""; clearEl.hidden = true; showResults([]); qEl.focus(); });

  go(location.hash);
})();
