// B3A home board plus Citybus route search. All data comes straight from Citybus open data (DATA.GOV.HK).
(() => {
  const API = "https://rt.data.gov.hk/v2/transport/citybus";
  const REFRESH_MS = 30000;
  const DAY = 864e5;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const phone = matchMedia("(max-width: 759px)");
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmtClock = t => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Hong_Kong" });
  const shortName = s => String(s).split(",")[0].trim();

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

  // ---------- Citybus static data ----------
  let routeList = null;
  async function getRouteList() {
    if (routeList) return routeList;
    routeList = cache.get("ctb:routes", DAY);
    if (!routeList) {
      const json = await getJSON(`${API}/route/CTB`);
      routeList = json.data.map(r => ({ route: r.route, orig: r.orig_tc, dest: r.dest_tc, origEn: r.orig_en, destEn: r.dest_en }));
      cache.set("ctb:routes", routeList);
    }
    return routeList;
  }

  async function getRouteStops(route, bound) {
    const key = `ctb:rs:${route}:${bound}`;
    let ids = cache.get(key, DAY);
    if (!ids) {
      const json = await getJSON(`${API}/route-stop/CTB/${encodeURIComponent(route)}/${bound}`);
      ids = (json.data || []).sort((a, b) => a.seq - b.seq).map(s => s.stop)
        .filter((id, i, arr) => id !== arr[i - 1]); // some routes list the same stop twice in a row
      cache.set(key, ids);
    }
    return ids;
  }

  const stopMem = {};
  async function getStop(id) {
    if (stopMem[id]) return stopMem[id];
    let s = cache.get(`ctb:stop:${id}`, 7 * DAY);
    if (!s) {
      const d = (await getJSON(`${API}/stop/${id}`)).data;
      s = { id, name: shortName(d.name_tc), road: d.name_tc.split(",")[1]?.trim() || "", lat: +d.lat, lng: +d.long };
      cache.set(`ctb:stop:${id}`, s);
    }
    return (stopMem[id] = s);
  }

  // Citybus has no bulk stop endpoint, so fetch a route's stops a few at a time.
  async function getStops(ids, onProgress) {
    const out = new Array(ids.length);
    let next = 0, done = 0;
    async function worker() {
      while (next < ids.length) {
        const i = next++;
        out[i] = await getStop(ids[i]);
        onProgress?.(++done, ids.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
    return out;
  }

  // ---------- Map ----------
  const map = L.map("map", { scrollWheelZoom: !phone.matches, dragging: !phone.matches, tap: false, zoomControl: !phone.matches });
  map.zoomControl?.setPosition("bottomright");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.setView([22.41, 113.98], 12);

  let mapLayer = null, markers = {}, userMarker = null;

  function fitTo(points) {
    if (!points.length) return;
    const opts = phone.matches
      ? { paddingTopLeft: [24, 70], paddingBottomRight: [24, Math.round(innerHeight * 0.56)] }
      : { paddingTopLeft: [480, 70], paddingBottomRight: [48, 48] };
    map.fitBounds(L.latLngBounds(points), opts);
  }

  function stopMarker(s, { key = false, label = "", color }) {
    const m = L.circleMarker([s.lat, s.lng], {
      radius: key ? 8 : 4, weight: key ? 3 : 2, color, fillColor: css("--panel"), fillOpacity: 1,
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
    const visible = phone.matches ? L.point(size.x / 2, size.y * 0.23) : L.point(440 + (size.x - 440) / 2, size.y / 2);
    const offset = L.point(size.x / 2, size.y / 2).subtract(visible);
    map.flyTo(map.unproject(map.project(m.getLatLng(), zoom).add(offset), zoom), zoom, { animate: !reduceMotion, duration: 0.8 });
    m.openTooltip();
    if (phone.matches) scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }

  // ---------- Boards ----------
  // A board is a set of sections; each section shows arrivals of one route+direction at one stop.
  const boardEl = $("board");
  let board = null;

  function sectionEl(innerTop) {
    const el = document.createElement("section");
    el.className = "dir glass";
    el.innerHTML = `${innerTop}<div class="next"><span class="empty">載入中…</span></div><ul class="later"></ul>`;
    return el;
  }

  function setTitle(no, main, sub) {
    $("title-no").textContent = no;
    $("title-main").textContent = main;
    $("title-sub").textContent = sub;
    document.title = no === "B3A" && !location.hash ? "B3A Fu Tai ⇄ Shenzhen Bay" : `${no} ${main} · 城巴到站`;
  }

  function setLegend(html) { $("legend").innerHTML = html; }

  function b3aBoard() {
    const R = window.B3A_ROUTE;
    setTitle("B3A", "富泰 ⇄ 深圳灣口岸", "城巴 · 實時到站");
    setLegend(`<span><i></i>往深圳灣</span><span><i class="ret"></i>往富泰 · 山景</span>`);
    $("home").hidden = true;

    const defs = [
      // Toward Shenzhen Bay -> when buses reach Fu Tai Estate (Castle Peak Road).
      { stop: "003261", dir: "O", h: "往 深圳灣口岸", p: "到 富泰邨（青山公路）還有" },
      // Toward Fu Tai -> when buses leave Shenzhen Bay Port.
      { stop: "003208", dir: "I", h: "往 富泰 · 山景邨", p: "深圳灣口岸開出還有" },
    ];
    const sections = defs.map(d => {
      const el = sectionEl(`<div class="dir-head"><div><h2>${d.h}</h2><p>${d.p}</p></div><button class="locate" type="button">地圖</button></div>`);
      el.querySelector(".locate").addEventListener("click", () => flyToStop(d.stop));
      return { el, route: "B3A", stop: d.stop, dir: d.dir, etas: [] };
    });
    boardEl.replaceChildren(...sections.map(s => s.el));

    function drawMap() {
    resetMap();
    const sodium = css("--sodium"), ret = css("--return");
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

  // A searched route: pick direction and boarding stop; state lives in the hash (#ROUTE/O/STOPID).
  async function routeBoard(routeNo, wantDir, wantStop) {
    const list = await getRouteList().catch(() => null);
    const info = list?.find(r => r.route === routeNo);
    setTitle(routeNo, info ? `${info.orig} ⇄ ${info.dest}` : "城巴路線", "城巴 · 實時到站");
    setLegend(`<span><i class="ret"></i>站點連線（近似）</span>`);
    $("home").hidden = false;

    const el = sectionEl(`<div class="dir-head"><div><h2 class="h">載入路線…</h2><p class="p"></p></div><button class="locate" type="button">地圖</button></div>
      <div class="pick">
        <div class="seg" role="group" aria-label="方向"></div>
        <div class="stop-row">
          <select aria-label="上車站" disabled><option>載入站點中…</option></select>
          <button type="button" class="nearest">最近的站</button>
        </div>
        <p class="hint" hidden></p>
      </div>`);
    boardEl.replaceChildren(el);
    const section = { el, route: routeNo, stop: null, dir: null, etas: [], idle: true };
    const segEl = el.querySelector(".seg"), selectEl = el.querySelector("select"), hintEl = el.querySelector(".hint");
    const hint = msg => { hintEl.hidden = !msg; hintEl.textContent = msg || ""; };
    resetMap();

    // Load both directions' stop lists; circular routes only have outbound.
    let bounds;
    try {
      const [o, i] = await Promise.all([getRouteStops(routeNo, "outbound"), getRouteStops(routeNo, "inbound").catch(() => [])]);
      bounds = [{ dir: "O", ids: o }, { dir: "I", ids: i }].filter(b => b.ids.length);
    } catch (err) {
      el.querySelector(".h").textContent = "未能載入路線";
      el.querySelector(".next").innerHTML = `<span class="empty">請檢查網絡後按「刷新」再試（${esc(err.message)}）</span>`;
      section.retry = () => go(location.hash, true);
      return { sections: [section] };
    }
    if (!bounds.length) {
      el.querySelector(".h").textContent = "找不到這條路線的站點";
      el.querySelector(".next").innerHTML = `<span class="empty">城巴暫時沒有提供 ${esc(routeNo)} 的站點資料</span>`;
      return { sections: [section] };
    }

    try {
      const all = [...new Set(bounds.flatMap(b => b.ids))];
      await getStops(all, (n, total) => hint(`載入站點中… ${n}/${total}`));
    } catch (err) {
      hint(`部分站點未能載入（${err.message}），請稍後再試`);
    }
    for (const b of bounds) b.stops = b.ids.map(id => stopMem[id]).filter(Boolean);
    hint("");
    if (currentRoute !== routeNo) return null; // user moved on while loading

    let cur = bounds.find(b => b.dir === wantDir) || bounds[0];

    function drawMap() {
      resetMap();
      const ret = css("--return"), sodium = css("--sodium");
      bounds.forEach(b => {
        if (b !== cur) L.polyline(b.stops.map(s => [s.lat, s.lng]), { color: ret, weight: 2, opacity: 0.35, dashArray: "4 6" }).addTo(mapLayer);
      });
      L.polyline(cur.stops.map(s => [s.lat, s.lng]), { color: sodium, weight: 3, opacity: 0.9, dashArray: "6 6" }).addTo(mapLayer);
      cur.stops.forEach(s => stopMarker(s, { key: s.id === section.stop, color: s.id === section.stop ? sodium : ret }));
      if (userMarker) userMarker.addTo(mapLayer);
    }

    function apply(stopId, { fit = false, fly = false } = {}) {
      const stop = cur.stops.find(s => s.id === stopId) || cur.stops[0];
      const last = cur.stops[cur.stops.length - 1];
      section.dir = cur.dir;
      section.stop = stop.id;
      section.etas = [];
      section.loaded = false;
      section.idle = false;
      el.querySelector(".h").textContent = `往 ${last.name}`;
      el.querySelector(".p").textContent = `到 ${stop.name}${stop.road ? `（${stop.road}）` : ""}還有`;
      segEl.querySelectorAll("button").forEach(btn => btn.setAttribute("aria-pressed", String(btn.dataset.dir === cur.dir)));
      selectEl.innerHTML = cur.stops.map((s, i) => `<option value="${s.id}"${s.id === stop.id ? " selected" : ""}>${i + 1}. ${esc(s.name)}</option>`).join("");
      selectEl.disabled = false;
      history.replaceState(null, "", `#${encodeURIComponent(routeNo)}/${cur.dir}/${stop.id}`);
      cache.set(`ctb:last:${routeNo}`, { dir: cur.dir, stop: stop.id });
      drawMap();
      if (fit) fitTo(cur.stops.map(s => [s.lat, s.lng]));
      if (fly) flyToStop(stop.id);
      el.querySelector(".next").innerHTML = `<span class="empty">載入中…</span>`;
      el.querySelector(".later").innerHTML = "";
      load(true);
    }

    segEl.innerHTML = bounds.map(b => `<button type="button" data-dir="${b.dir}">往 ${esc(b.stops[b.stops.length - 1]?.name || "")}</button>`).join("");
    if (bounds.length === 1) segEl.insertAdjacentHTML("beforeend", `<span class="hint" style="align-self:center;padding:0 8px">循環線</span>`);
    segEl.addEventListener("click", e => {
      const btn = e.target.closest("button[data-dir]");
      if (!btn || btn.dataset.dir === cur.dir) return;
      const prev = cur.stops.find(s => s.id === section.stop);
      cur = bounds.find(b => b.dir === btn.dataset.dir);
      // Keep the same stop if this direction serves it, otherwise the closest one, but never auto-pick
      // the terminus (nobody boards there in this direction).
      const boardable = cur.stops.length > 1 ? cur.stops.slice(0, -1) : cur.stops;
      const same = prev && (boardable.find(s => s.id === prev.id) || nearestStop(boardable, prev.lat, prev.lng).stop);
      apply(same?.id, { fit: true });
    });
    selectEl.addEventListener("change", () => apply(selectEl.value, { fly: true }));
    el.querySelector(".locate").addEventListener("click", () => flyToStop(section.stop));
    el.querySelector(".nearest").addEventListener("click", () => {
      if (!navigator.geolocation) return hint("這個瀏覽器不支援定位");
      hint("正在取得你的位置…");
      navigator.geolocation.getCurrentPosition(pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        const { stop, dist } = nearestStop(cur.stops.length > 1 ? cur.stops.slice(0, -1) : cur.stops, lat, lng);
        userMarker = L.marker([lat, lng], { icon: L.divIcon({ className: "user-dot", iconSize: [16, 16] }), interactive: false });
        hint(dist > 3000 ? `你離這條路線較遠，最近的站約 ${(dist / 1000).toFixed(1)} 公里` : `最近的站：${stop.name}（約 ${Math.round(dist / 10) * 10} 米）`);
        apply(stop.id, { fly: true });
      }, err => {
        hint(err.code === 1 ? "未獲定位權限，請在瀏覽器設定中允許，或直接選擇車站" : "暫時無法取得位置，請直接選擇車站");
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });

    const remembered = cache.get(`ctb:last:${routeNo}`, 365 * DAY);
    if (!wantStop && remembered) {
      cur = bounds.find(b => b.dir === remembered.dir) || cur;
      wantStop = remembered.stop;
    }
    const result = { sections: [section], redrawMap: drawMap };
    board = result;
    apply(wantStop, { fit: true });
    return result;
  }

  function nearestStop(stops, lat, lng) {
    const rad = Math.PI / 180;
    let best = null, bestD = Infinity;
    for (const s of stops) {
      const dLat = (s.lat - lat) * rad, dLng = (s.lng - lng) * rad;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(s.lat * rad) * Math.sin(dLng / 2) ** 2;
      const d = 12742000 * Math.asin(Math.sqrt(a));
      if (d < bestD) { bestD = d; best = s; }
    }
    return { stop: best, dist: bestD };
  }

  // ---------- Arrivals ----------
  const statusEl = $("status"), refreshBtn = $("refresh");
  let lastOk = null, error = null, loading = false, nextAt = 0, timer = null, loadSeq = 0;

  function renderSection(s, now) {
    const nextEl = s.el.querySelector(".next"), laterEl = s.el.querySelector(".later");
    if (s.idle || !s.stop) return;
    const upcoming = s.etas.filter(e => e.t > now - 60000);
    if (!upcoming.length) {
      if (!s.loaded) return;
      nextEl.innerHTML = `<span class="empty">${s.failed ? "未能載入班次，請按「刷新」再試" : (s.rmk ? `暫時沒有 ${esc(s.route)} 班次（${esc(s.rmk)}）` : `城巴暫時沒有 ${esc(s.route)} 在這個站的到站資料。可能已收車、未開始服務，或這段時間的班次由九巴營運（聯營路線）。`)}</span>`;
      laterEl.innerHTML = "";
      return;
    }
    const [first, ...rest] = upcoming;
    const m = Math.ceil((first.t - now) / 60000);
    nextEl.innerHTML = (m <= 0 ? `<span class="big due">即將到站</span>` : `<span class="big">${m}</span><span class="unit">分鐘</span>`)
      + `<span class="clock">${fmtClock(first.t)}${first.rmk ? `<br><span class="rmk">${esc(first.rmk)}</span>` : ""}</span>`;
    laterEl.innerHTML = rest.map(e => {
      const mm = Math.max(0, Math.ceil((e.t - now) / 60000));
      return `<li><b>${mm}</b> 分 · ${fmtClock(e.t)}${e.rmk ? ` · ${esc(e.rmk)}` : ""}</li>`;
    }).join("");
  }

  function render() {
    const now = Date.now();
    board?.sections.forEach(s => renderSection(s, now));
    const ago = lastOk ? Math.max(0, Math.round((now - lastOk) / 1000)) : null;
    const until = Math.max(0, Math.ceil((nextAt - now) / 1000));
    if (loading) statusEl.textContent = "更新中…";
    else if (error) statusEl.innerHTML = `<span class="err">${esc(error)}</span>${ago !== null ? ` · 上次成功 ${ago} 秒前` : ""}`;
    else if (ago !== null) statusEl.textContent = `${ago} 秒前更新 · ${until} 秒後自動刷新`;
  }

  async function loadSection(s) {
    const json = await getJSON(`${API}/eta/CTB/${s.stop}/${encodeURIComponent(s.route)}`);
    const rows = (json.data || []).filter(e => e.dir === s.dir);
    s.etas = rows.filter(e => e.eta).map(e => ({ t: Date.parse(e.eta), rmk: e.rmk_tc })).sort((a, b) => a.t - b.t);
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

  // ---------- Routing: "" = B3A home, "#ROUTE[/DIR/STOP]" = searched route ----------
  let currentRoute = null;
  async function go(hash, forceReload = false) {
    const [r, dir, stop] = decodeURIComponent(hash.replace(/^#/, "")).split("/");
    const routeNo = (r || "").toUpperCase();
    if (!forceReload && routeNo === currentRoute) return;
    currentRoute = routeNo;
    lastOk = null; error = null;
    statusEl.textContent = "載入中…";
    if (!routeNo) {
      board = b3aBoard();
      load(true);
    } else {
      board = { sections: [] };
      const b = await routeBoard(routeNo, dir, stop);
      if (b && currentRoute === routeNo) board = b;
    }
  }
  addEventListener("hashchange", () => go(location.hash));
  $("home").addEventListener("click", () => { history.pushState(null, "", location.pathname); go(""); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => board?.redrawMap?.());
  phone.addEventListener?.("change", () => location.reload());

  // ---------- Search ----------
  const qEl = $("q"), resultsEl = $("results"), clearEl = $("clear");
  let active = -1, shown = [];

  const norm = s => String(s).normalize("NFKC").toUpperCase().replace(/\s+/g, "");
  const routeKey = r => r.replace(/\d+/g, n => n.padStart(4, "0"));

  function search(q) {
    const n = norm(q);
    if (!n) return [];
    const byNo = [], byPlace = [];
    for (const r of routeList) {
      const no = norm(r.route);
      if (no.startsWith(n)) byNo.push([no === n ? 0 : 1, r]);
      else if ((n.length >= 2 || /[^\x00-\x7F]/.test(n)) && [r.orig, r.dest, r.origEn, r.destEn].some(x => norm(x || "").includes(n))) byPlace.push([2, r]);
    }
    return [...byNo, ...byPlace]
      .sort((a, b) => a[0] - b[0] || routeKey(a[1].route).localeCompare(routeKey(b[1].route)))
      .slice(0, 40).map(x => x[1]);
  }

  function showResults(items, note) {
    shown = items;
    active = items.length ? 0 : -1;
    resultsEl.innerHTML = note
      ? `<li class="note" role="presentation">${esc(note)}</li>`
      : items.map((r, i) => `<li role="option" id="opt-${i}" data-route="${esc(r.route)}" aria-selected="${i === active}">
          <span class="rno">${esc(r.route)}</span><span class="rdest">${esc(r.orig)} → ${esc(r.dest)}<small>${esc(r.origEn)} → ${esc(r.destEn)}</small></span></li>`).join("");
    qEl.setAttribute("aria-expanded", String(!!resultsEl.children.length));
    qEl.setAttribute("aria-activedescendant", active >= 0 ? `opt-${active}` : "");
  }

  function highlight(i) {
    if (!shown.length) return;
    active = (i + shown.length) % shown.length;
    [...resultsEl.children].forEach((li, j) => li.setAttribute("aria-selected", String(j === active)));
    resultsEl.children[active]?.scrollIntoView({ block: "nearest" });
    qEl.setAttribute("aria-activedescendant", `opt-${active}`);
  }

  function pick(route) {
    qEl.value = "";
    clearEl.hidden = true;
    showResults([]);
    qEl.blur();
    const last = cache.get(`ctb:last:${route}`, 365 * DAY);
    location.hash = last ? `${encodeURIComponent(route)}/${last.dir}/${last.stop}` : encodeURIComponent(route);
  }

  async function onInput() {
    const q = qEl.value;
    clearEl.hidden = !q;
    if (!norm(q)) return showResults([]);
    if (!routeList) {
      showResults([], "載入路線列表中…");
      try { await getRouteList(); } catch {
        return showResults([], navigator.onLine === false ? "搜尋需要網絡連線" : "未能載入城巴路線列表，請檢查網絡後再試");
      }
      if (qEl.value !== q) return;
    }
    const items = search(q);
    items.length ? showResults(items) : showResults([], `找不到「${q.trim()}」相關的城巴路線（目前只支援城巴）`);
  }

  qEl.addEventListener("input", onInput);
  qEl.addEventListener("focus", () => { if (qEl.value) onInput(); else getRouteList().catch(() => {}); });
  qEl.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(active - 1); }
    else if (e.key === "Enter" && shown[active]) { e.preventDefault(); pick(shown[active].route); }
    else if (e.key === "Escape") { qEl.value = ""; clearEl.hidden = true; showResults([]); }
  });
  resultsEl.addEventListener("click", e => {
    const li = e.target.closest("li[data-route]");
    if (li) pick(li.dataset.route);
  });
  clearEl.addEventListener("click", () => { qEl.value = ""; clearEl.hidden = true; showResults([]); qEl.focus(); });

  go(location.hash);
})();
