/* ═══════════════════════════════════════════════════════════════
   BINROUTE v3 — APP.JS
   Map-as-canvas, mobile-first, fully automated delivery routing
═══════════════════════════════════════════════════════════════ */
"use strict";

// ── STATE ──────────────────────────────────────────────────────
const S = {
  map:          null,
  tileLayer:    null,
  currentStyle: null,

  userMarker:   null,
  userLat:      null,
  userLon:      null,
  userSpeed:    0,       // m/s
  userHeading:  null,
  watchId:      null,
  followMode:   true,    // auto-pan to user

  depots:   [],   // { address, label, lat, lon, marker }
  stops:    [],   // { address, label, lat, lon, done, active, marker, etaMin, distM, order }
  route:    [],   // ordered array of stop objects (first = start)
  routeLayers: [],

  activeIdx:    null,   // index in S.stops of current target
  tilt3d:       false,

  zoneKmh:      null,
  speedTimer:   null,

  acTimer:      null,
  acController: null,

  panelOpen:    null,   // 'stops' | null
  drawerIdx:    null,   // which stop is in drawer

  isGeocoding:  false,
  geocodeCount: 0,
  geocodeTotal: 0,
};

// ── BOOT ────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  bindUI();
  startGPS();
  await geocodeAll();
  runRoute();
  openStopsPanel();            // show stops panel briefly on load
  setTimeout(closeStopsPanel, CONFIG.ui.panelAutoHideMs);
});

// ── MAP INIT ────────────────────────────────────────────────────
function initMap() {
  // Find default style
  S.currentStyle = CONFIG.mapStyles.find(s => s.id === CONFIG.defaultMapStyle) || CONFIG.mapStyles[0];

  S.map = L.map("map", {
    zoomControl: false,
    attributionControl: true,
    maxZoom: CONFIG.map.maxZoom,
    minZoom: CONFIG.map.minZoom,
    tap: true,
  }).setView(CONFIG.map.defaultCenter, CONFIG.map.defaultZoom);

  S.tileLayer = L.tileLayer(S.currentStyle.url, {
    maxZoom: CONFIG.map.maxZoom,
    attribution: S.currentStyle.attr,
  }).addTo(S.map);

  // Build map style picker buttons
  const picker = document.getElementById("style-picker-inner");
  CONFIG.mapStyles.forEach(style => {
    const btn = document.createElement("button");
    btn.className = `style-btn${style.id === S.currentStyle.id ? " active" : ""}`;
    btn.dataset.id = style.id;
    btn.innerHTML = `<span class="style-btn-icon">${style.icon}</span>${style.name}`;
    btn.addEventListener("click", () => switchMapStyle(style.id));
    picker.appendChild(btn);
  });

  // Touch: 2-finger pinch/rotate for tilt toggle
  let touchStart = null;
  S.map.getContainer().addEventListener("touchstart", e => {
    if (e.touches.length === 2) touchStart = getTouchMidpoint(e);
  }, { passive: true });

  S.map.getContainer().addEventListener("touchend", e => {
    if (touchStart && e.changedTouches.length >= 1 && !e.touches.length) {
      // two-finger swipe up = 3D, down = 2D
    }
    touchStart = null;
  }, { passive: true });

  // Two-finger vertical drag = tilt
  let prevY = null;
  S.map.getContainer().addEventListener("touchmove", e => {
    if (e.touches.length !== 2) { prevY = null; return; }
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    if (prevY !== null) {
      const dy = cy - prevY;
      if (Math.abs(dy) > 12) {
        setTilt(dy < 0); // swipe up = tilt (3D), swipe down = flat
        prevY = null;
      }
    } else {
      prevY = cy;
    }
  }, { passive: true });

  S.map.on("dragstart", () => { if (S.followMode) { S.followMode = false; setFollowBtn(false); } });
}

function getTouchMidpoint(e) {
  return {
    x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
    y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
  };
}

function switchMapStyle(id) {
  const style = CONFIG.mapStyles.find(s => s.id === id);
  if (!style || style.id === S.currentStyle.id) return;
  S.currentStyle = style;
  S.map.removeLayer(S.tileLayer);
  S.tileLayer = L.tileLayer(style.url, { maxZoom: CONFIG.map.maxZoom, attribution: style.attr }).addTo(S.map);
  S.tileLayer.bringToBack();
  document.querySelectorAll(".style-btn").forEach(b => b.classList.toggle("active", b.dataset.id === id));
  toggleStylePicker(false);
  toast(`Map: ${style.name}`, "info");
}

function setTilt(on) {
  S.tilt3d = on;
  document.getElementById("map-tilt-wrapper").classList.toggle("tilted", on);
  const fab = document.getElementById("fab-tilt");
  fab?.classList.toggle("active", on);
}

// ── GPS ─────────────────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) { toast("GPS not supported", "error"); return; }

  const opts = { enableHighAccuracy: true, maximumAge: 1500, timeout: 10000 };
  navigator.geolocation.getCurrentPosition(onGPS, gpsErr, opts);
  S.watchId = navigator.geolocation.watchPosition(onGPS, null, opts);
}

function onGPS(pos) {
  const { latitude: lat, longitude: lon, speed, heading } = pos.coords;
  const first = S.userLat === null;
  S.userLat = lat; S.userLon = lon;
  S.userSpeed = Math.max(0, speed || 0);
  S.userHeading = heading;

  updateUserMarker();
  updateSpeedHUD();
  updateETAs();

  if (first) {
    S.map.setView([lat, lon], CONFIG.map.defaultZoom);
    scheduleSpeedLookup();
  }

  if (S.followMode && S.activeIdx !== null) {
    S.map.setView([lat, lon], CONFIG.map.followUserZoom);
  } else if (S.followMode && first) {
    S.map.setView([lat, lon], CONFIG.map.defaultZoom);
  }

  // Arrival check
  if (S.activeIdx !== null) {
    const stop = S.stops[S.activeIdx];
    if (stop && !stop.done) {
      const dist = haversine(lat, lon, stop.lat, stop.lon);
      if (dist < CONFIG.map.arrivalRadiusM) showArrivingBanner(stop);
      else hideArrivingBanner();
    }
  }
}

function gpsErr() { /* silent — use default center */ }

function updateUserMarker() {
  if (S.userLat === null) return;
  const pos = [S.userLat, S.userLon];
  if (!S.userMarker) {
    const icon = L.divIcon({
      html: `<div class="marker-emoji" style="filter:drop-shadow(0 0 6px rgba(0,212,255,0.8));">${CONFIG.icons.user}</div>`,
      className: "", iconSize: [36,36], iconAnchor: [18,18],
    });
    S.userMarker = L.marker(pos, { icon, zIndexOffset: 2000 }).addTo(S.map);
  } else {
    S.userMarker.setLatLng(pos);
  }
}

// ── SPEED / ZONE ─────────────────────────────────────────────────
function updateSpeedHUD() {
  const kmh = S.userSpeed * 3.6;
  const isKmh = CONFIG.speed.units === "kmh";
  const display = Math.round(isKmh ? kmh : kmh * 0.621);
  const unit = isKmh ? "km/h" : "mph";

  setEl("speed-num", display);
  setEl("speed-unit", unit);

  const zone = S.zoneKmh || CONFIG.speed.defaultZoneKmh;
  const zoneDisplay = Math.round(isKmh ? zone : zone * 0.621);
  const over = zone && kmh > zone + 5;
  const zoneEl = document.getElementById("speed-zone-num");
  if (zoneEl) {
    zoneEl.textContent = zoneDisplay;
    zoneEl.classList.toggle("over", over);
  }

  const numEl = document.getElementById("speed-num");
  if (numEl) numEl.style.color = over ? "var(--red)" : "var(--text)";
}

function scheduleSpeedLookup() {
  clearTimeout(S.speedTimer);
  S.speedTimer = setTimeout(lookupZoneSpeed, 500);
}

async function lookupZoneSpeed() {
  if (S.userLat === null) return;
  const { userLat: lat, userLon: lon } = S;
  const r = CONFIG.speed.lookupRadiusM;
  const q = `[out:json][timeout:5];way(around:${r},${lat},${lon})[highway][maxspeed];out tags 1;`;
  try {
    const res = await fetch(CONFIG.speed.overpassUrl, {
      method: "POST", body: "data=" + encodeURIComponent(q),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (data.elements?.[0]) {
      const raw = data.elements[0].tags.maxspeed || "";
      const n = parseInt(raw);
      if (!isNaN(n)) { S.zoneKmh = n; updateSpeedHUD(); }
    }
  } catch (_) {}
  S.speedTimer = setTimeout(lookupZoneSpeed, CONFIG.speed.intervalMs);
}

// ── GEOCODE ALL ──────────────────────────────────────────────────
async function geocodeAddress(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error();
  const data = await res.json();
  return data[0] || null;
}

async function geocodeAll() {
  if (S.isGeocoding) return;
  S.isGeocoding = true;
  S.stops = []; S.depots = [];
  const allAddrs = [...CONFIG.depots, ...CONFIG.dropOffs];
  S.geocodeTotal = allAddrs.length;
  S.geocodeCount = 0;
  updateGeocodeProgress();

  for (const cfg of CONFIG.depots) {
    await sleep(CONFIG.ui.geocodeDelayMs);
    try {
      const r = await geocodeAddress(cfg.address);
      if (r) S.depots.push({ ...cfg, lat: +r.lat, lon: +r.lon, marker: null });
    } catch (_) {}
    S.geocodeCount++; updateGeocodeProgress();
  }

  for (const cfg of CONFIG.dropOffs) {
    await sleep(CONFIG.ui.geocodeDelayMs);
    try {
      const r = await geocodeAddress(cfg.address);
      if (r) S.stops.push({ ...cfg, lat: +r.lat, lon: +r.lon, done: false, active: false, marker: null, etaMin: null, distM: null, order: 0 });
    } catch (_) {}
    S.geocodeCount++; updateGeocodeProgress();
  }

  S.isGeocoding = false;
  plotAllMarkers();
}

function updateGeocodeProgress() {
  const el = document.getElementById("geocode-status");
  if (!el) return;
  if (S.geocodeCount >= S.geocodeTotal) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.textContent = `Geocoding ${S.geocodeCount}/${S.geocodeTotal}…`;
}

// ── ROUTING (OSRM — always real roads) ───────────────────────────
async function runRoute() {
  const pending = S.stops.filter(s => !s.done);
  if (!pending.length) return;

  const start = getStart();
  // Nearest-neighbour ordering first
  const ordered = nearestNeighbour(start, pending);

  // Then fetch OSRM for actual drive times across all stops
  await fetchOSRMRoute(start, ordered);

  S.route = [start, ...ordered];
  renderRoutePolylines();
  updateETAs();
  renderStopsList();
  updateTopBar();
}

function getStart() {
  if (S.userLat !== null) return { label: "Your Location", lat: S.userLat, lon: S.userLon };
  if (S.depots.length) return S.depots[0];
  return { label: "Start", lat: CONFIG.map.defaultCenter[0], lon: CONFIG.map.defaultCenter[1] };
}

function nearestNeighbour(start, stops) {
  const route = [];
  let remaining = [...stops];
  let cur = start;
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    remaining.forEach((s, i) => { const d = haversine(cur.lat, cur.lon, s.lat, s.lon); if (d < bd) { bd = d; bi = i; } });
    cur = remaining.splice(bi, 1)[0];
    route.push(cur);
  }
  return route;
}

async function fetchOSRMRoute(start, stops) {
  if (!stops.length) return;
  const allPts = [start, ...stops];
  const coords = allPts.map(p => `${p.lon},${p.lat}`).join(";");
  const url = `${CONFIG.route.osrmBase}${coords}?overview=full&geometries=geojson&annotations=duration,distance&steps=false`;

  clearRoutePolylines();

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (!data.routes?.[0]) throw new Error("no route");

    const osrmRoute = data.routes[0];
    const legs = osrmRoute.legs;

    // Assign cumulative ETA to each stop
    let cumSecs = 0;
    stops.forEach((stop, i) => {
      const leg = legs[i];
      cumSecs += (leg?.duration || 0) + CONFIG.van.dwellMinutes * 60;
      stop.etaMin  = Math.round(cumSecs / 60);
      stop.distM   = legs.slice(0, i+1).reduce((acc, l) => acc + (l?.distance || 0), 0);
      stop.order   = i + 1;
    });

    // Draw full route geometry
    if (osrmRoute.geometry) {
      const layer = L.geoJSON(osrmRoute.geometry, {
        style: { color: CONFIG.route.activeColor, weight: CONFIG.route.lineWeight, opacity: CONFIG.route.lineOpacity },
      }).addTo(S.map);
      S.routeLayers.push(layer);
    }
  } catch (_) {
    // Fallback straight lines
    const pts = allPts.map(p => [p.lat, p.lon]);
    const layer = L.polyline(pts, {
      color: CONFIG.route.plannedColor, weight: CONFIG.route.lineWeight, opacity: 0.5, dashArray: "6 4",
    }).addTo(S.map);
    S.routeLayers.push(layer);

    // Estimate ETAs by crow-fly + avg speed
    let cumSecs = 0;
    stops.forEach((stop, i) => {
      const prev = i === 0 ? start : stops[i-1];
      const d = haversine(prev.lat, prev.lon, stop.lat, stop.lon);
      const secs = (d / (CONFIG.van.avgSpeedKmh / 3.6)) + CONFIG.van.dwellMinutes * 60;
      cumSecs += secs;
      stop.etaMin = Math.round(cumSecs / 60);
      stop.distM  = d;
      stop.order  = i + 1;
    });
  }
}

function clearRoutePolylines() {
  S.routeLayers.forEach(l => l.remove());
  S.routeLayers = [];
}

function renderRoutePolylines() { /* handled inside fetchOSRMRoute */ }

// ── MARKERS ──────────────────────────────────────────────────────
function plotAllMarkers() {
  // Remove old
  S.stops.forEach(s => { if (s.marker) { s.marker.remove(); s.marker = null; } });
  S.depots.forEach(d => { if (d.marker) { d.marker.remove(); d.marker = null; } });

  S.depots.forEach(d => {
    const icon = L.divIcon({
      html: `<div class="marker-emoji">${CONFIG.icons.depot}</div>`,
      className: "", iconSize: [30,30], iconAnchor: [15,15],
    });
    d.marker = L.marker([d.lat, d.lon], { icon })
      .addTo(S.map)
      .bindPopup(`<strong>${CONFIG.icons.depot} ${d.label}</strong><br>${d.address}`);
  });

  S.stops.forEach((stop, i) => {
    refreshStopMarker(i);
  });

  // Fit bounds
  const allPts = [...S.stops, ...S.depots, ...(S.userLat !== null ? [{ lat: S.userLat, lon: S.userLon }] : [])];
  if (allPts.length > 1) {
    try { S.map.fitBounds(L.latLngBounds(allPts.map(p => [p.lat, p.lon])).pad(0.1)); } catch (_) {}
  }
}

function refreshStopMarker(idx) {
  const stop = S.stops[idx];
  if (!stop) return;
  if (stop.marker) stop.marker.remove();

  const emoji = stop.done ? CONFIG.icons.dropDone : stop.active ? CONFIG.icons.dropActive : CONFIG.icons.dropOff;
  const cls   = stop.done ? "stop-done" : stop.active ? "stop-active" : "";
  const etaStr = stop.etaMin != null ? fmtETA(stop.etaMin) : "";

  const html = `
    <div style="position:relative;width:34px;height:34px;">
      <div class="marker-stop ${cls}">${stop.order || idx+1}</div>
      ${etaStr ? `<div class="eta-badge">${etaStr}</div>` : ""}
    </div>`;

  const icon = L.divIcon({ html, className: "", iconSize: [34,34], iconAnchor: [17,17], popupAnchor: [0,-20] });
  stop.marker = L.marker([stop.lat, stop.lon], { icon })
    .addTo(S.map)
    .on("click", () => openStopDrawer(idx));
}

function refreshAllStopMarkers() {
  S.stops.forEach((_, i) => refreshStopMarker(i));
}

// ── STOP DRAWER ───────────────────────────────────────────────────
function openStopDrawer(idx) {
  const stop = S.stops[idx];
  if (!stop) return;
  S.drawerIdx = idx;
  closeStopsPanel();

  const emoji = stop.done ? CONFIG.icons.dropDone : stop.active ? CONFIG.icons.dropActive : CONFIG.icons.dropOff;
  setEl("drawer-emoji", emoji);
  setEl("drawer-name", stop.label || stop.address.split(",")[0]);
  setEl("drawer-addr", stop.address);

  // Status chip
  const metaEl = document.getElementById("drawer-meta");
  const etaStr = stop.etaMin != null ? `ETA ${fmtETA(stop.etaMin)}` : "";
  metaEl.innerHTML = `
    <span class="meta-chip ${stop.done ? "done" : stop.active ? "active" : "pending"}">
      ${stop.done ? "✅ Done" : stop.active ? "🔵 Navigating" : "⏳ Pending"}
    </span>
    ${etaStr ? `<span class="meta-chip eta">🕐 ${etaStr}</span>` : ""}
    ${stop.distM ? `<span class="meta-chip eta">📏 ${fmtDist(stop.distM)}</span>` : ""}
  `;

  // Button visibility
  document.getElementById("drawer-btn-go").style.display   = (!stop.done && !stop.active) ? "" : "none";
  document.getElementById("drawer-btn-done").style.display = !stop.done ? "" : "none";
  document.getElementById("drawer-btn-reopen").style.display = stop.done ? "" : "none";
  document.getElementById("drawer-btn-nav").style.display  = !stop.done ? "" : "none";

  document.getElementById("stop-drawer").classList.add("open");
  document.getElementById("sheet-backdrop").classList.add("open");

  // Fly to stop
  S.map.flyTo([stop.lat, stop.lon], 15, { duration: 0.8 });
}

function closeStopDrawer() {
  document.getElementById("stop-drawer").classList.remove("open");
  document.getElementById("sheet-backdrop").classList.remove("open");
  S.drawerIdx = null;
}

// ── STOP ACTIONS ──────────────────────────────────────────────────
function goToStop(idx) {
  if (idx == null) idx = S.drawerIdx;
  if (idx == null) return;
  const stop = S.stops[idx];
  if (!stop) return;

  // Deactivate previous
  S.stops.forEach(s => { s.active = false; });
  stop.active = true;
  S.activeIdx = idx;
  S.followMode = true;
  setFollowBtn(true);

  closeStopDrawer();
  refreshAllStopMarkers();
  renderStopsList();
  updateTopBar();

  // Redraw route from user to this stop then remaining
  redrawActiveRoute();
  toast(`Navigating to ${stop.label || stop.address.split(",")[0]}`, "info");
}

async function redrawActiveRoute() {
  clearRoutePolylines();
  if (S.activeIdx === null) return;

  const remaining = S.stops.filter(s => !s.done);
  const activeStop = S.stops[S.activeIdx];
  if (!activeStop) return;

  const start = getStart();
  const reordered = [activeStop, ...remaining.filter(s => s !== activeStop)];
  await fetchOSRMRoute(start, reordered);
  refreshAllStopMarkers();
  renderStopsList();
}

function markDone(idx) {
  if (idx == null) idx = S.drawerIdx;
  if (idx == null) return;
  const stop = S.stops[idx];
  if (!stop) return;
  stop.done = true; stop.active = false;
  if (S.activeIdx === idx) S.activeIdx = null;
  hideArrivingBanner();
  closeStopDrawer();
  refreshStopMarker(idx);
  renderStopsList();
  updateTopBar();
  updateLoadBar();
  toast(`✅ ${stop.label || "Stop"} complete`, "success");

  // Auto-advance to next pending
  const next = S.stops.find(s => !s.done && !s.active);
  if (next) {
    const ni = S.stops.indexOf(next);
    setTimeout(() => goToStop(ni), 700);
  } else {
    updateTopBar();
    toast("🎉 All stops done!", "success");
  }
}

function reopenStop(idx) {
  if (idx == null) idx = S.drawerIdx;
  if (idx == null) return;
  S.stops[idx].done = false;
  closeStopDrawer();
  refreshStopMarker(idx);
  renderStopsList();
  updateTopBar();
  toast("Stop reopened", "warning");
}

// ── UI RENDERING ─────────────────────────────────────────────────
function updateTopBar() {
  const active = S.activeIdx !== null ? S.stops[S.activeIdx] : null;
  const destCard = document.getElementById("dest-card");
  if (!active) {
    destCard?.classList.add("hidden-card");
    return;
  }
  destCard?.classList.remove("hidden-card");
  setEl("dest-name", active.label || active.address.split(",")[0]);
  setEl("dest-addr", active.address);
  setEl("dest-eta-time", active.etaMin != null ? fmtETA(active.etaMin) : "--");
  setEl("dest-dist", active.distM ? fmtDist(active.distM) : "");
}

function renderStopsList() {
  const el = document.getElementById("stops-list");
  if (!el) return;
  el.innerHTML = "";

  const total = S.stops.length;
  const done  = S.stops.filter(s => s.done).length;
  const pct   = total ? Math.round(done/total*100) : 0;

  setEl("panel-stat-total",   total);
  setEl("panel-stat-done",    done);
  setEl("panel-stat-pending", total - done);
  const fill = document.getElementById("panel-progress-fill");
  if (fill) fill.style.width = `${pct}%`;

  // Sort: active first, then pending by order, then done
  const sorted = [...S.stops].sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (a.order || 999) - (b.order || 999);
  });

  sorted.forEach(stop => {
    const origIdx = S.stops.indexOf(stop);
    const row = document.createElement("div");
    const cls = stop.done ? "done-row" : stop.active ? "active-row" : "";
    row.className = `stop-row ${cls}`;

    const numCls = stop.done ? "n-done" : stop.active ? "n-active" : "n-pending";
    const numLabel = stop.done ? "✓" : String(stop.order || origIdx+1);
    const etaStr = stop.etaMin != null ? `ETA ${fmtETA(stop.etaMin)}` : (stop.distM ? fmtDist(stop.distM) : "");

    row.innerHTML = `
      <div class="stop-row-num ${numCls}">${numLabel}</div>
      <div class="stop-row-info">
        <div class="stop-row-name">${stop.label || stop.address.split(",")[0]}</div>
        <div class="stop-row-eta">${etaStr}</div>
      </div>
      <div class="stop-row-action">
        ${!stop.done ? `<button class="btn btn-sm btn-go" onclick="event.stopPropagation();goToStop(${origIdx})">↗</button>` : ""}
        ${!stop.done ? `<button class="btn btn-sm btn-done" onclick="event.stopPropagation();markDone(${origIdx})">✓</button>` : `<button class="btn btn-sm btn-skip" onclick="event.stopPropagation();reopenStop(${origIdx})">↩</button>`}
      </div>
    `;
    row.addEventListener("click", () => openStopDrawer(origIdx));
    el.appendChild(row);
  });
}

function updateETAs() {
  // Recalculate based on GPS position
  if (S.userLat === null || !S.route.length) return;
  const pending = S.stops.filter(s => !s.done);
  if (!pending.length) return;

  // Use GPS speed or config avg
  const speedKmh = S.userSpeed > 0.5 ? S.userSpeed * 3.6 : CONFIG.van.avgSpeedKmh;
  let cur = { lat: S.userLat, lon: S.userLon };
  let cumMin = 0;

  S.route.slice(1).forEach(stop => {
    if (!stop || stop.done) return;
    const d = haversine(cur.lat, cur.lon, stop.lat, stop.lon);
    cumMin += (d / (speedKmh / 3.6)) / 60 + CONFIG.van.dwellMinutes;
    stop.etaMin = Math.round(cumMin);
    stop.distM  = d;
    cur = stop;
  });

  updateTopBar();
  // Update eta badges on markers
  S.stops.forEach((s, i) => { if (s.marker && !s.done) refreshStopMarker(i); });
}

function updateLoadBar() {
  const done = S.stops.filter(s => s.done).length;
  const cap  = CONFIG.van.capacity;
  const pct  = Math.min(100, Math.round(done/cap*100));
  const el   = document.getElementById("load-fill");
  if (el) el.style.width = `${pct}%`;
}

// ── AUTOCOMPLETE ──────────────────────────────────────────────────
function initSearchAutocomplete() {
  const input = document.getElementById("search-input");
  const drop  = document.getElementById("search-ac");
  if (!input || !drop) return;

  input.addEventListener("input", () => {
    const val = input.value.trim();
    document.getElementById("search-clear").classList.toggle("hidden", !val);
    clearTimeout(S.acTimer);
    if (val.length < CONFIG.autocomplete.minChars) { drop.classList.add("hidden"); return; }
    drop.innerHTML = `<div class="ac-loading"><div class="spinner"></div> Searching…</div>`;
    drop.classList.remove("hidden");
    S.acTimer = setTimeout(() => doAutocomplete(val, drop, input), CONFIG.autocomplete.debounceMs);
  });

  document.getElementById("search-clear")?.addEventListener("click", () => {
    input.value = "";
    drop.classList.add("hidden");
    document.getElementById("search-clear").classList.add("hidden");
  });

  document.addEventListener("click", e => {
    if (!input.contains(e.target) && !drop.contains(e.target)) drop.classList.add("hidden");
  });
}

async function doAutocomplete(query, drop, input) {
  if (S.acController) S.acController.abort();
  S.acController = new AbortController();
  const cc = CONFIG.autocomplete.countryCode ? `&countrycodes=${CONFIG.autocomplete.countryCode}` : "";
  const url = `${CONFIG.autocomplete.url}?format=jsonv2&limit=${CONFIG.autocomplete.maxResults}&addressdetails=1&q=${encodeURIComponent(query)}${cc}`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: S.acController.signal,
    });
    const results = await res.json();
    renderACResults(results, drop, input);
  } catch (e) {
    if (e.name !== "AbortError") drop.classList.add("hidden");
  }
}

function renderACResults(results, drop, input) {
  drop.innerHTML = "";
  if (!results.length) {
    drop.innerHTML = `<div class="ac-loading" style="color:var(--text-3)">No results found</div>`;
    return;
  }
  results.forEach(r => {
    const primary   = r.namedetails?.name || r.address?.road || r.display_name.split(",")[0];
    const secondary = r.display_name.replace(primary + ", ", "").substring(0, 60);
    const typeIcon  = getLocationIcon(r.type, r.class);

    const item = document.createElement("div");
    item.className = "ac-item";
    item.innerHTML = `
      <div class="ac-item-icon">${typeIcon}</div>
      <div class="ac-item-text">
        <div class="ac-item-primary">${primary}</div>
        <div class="ac-item-secondary">${secondary}</div>
      </div>`;
    item.addEventListener("mousedown", e => e.preventDefault());
    item.addEventListener("click", () => {
      input.value = r.display_name;
      drop.classList.add("hidden");
      // Fly to result
      const lat = +r.lat, lon = +r.lon;
      S.map.flyTo([lat, lon], 16, { duration: 1 });
      S.followMode = false; setFollowBtn(false);
    });
    drop.appendChild(item);
  });
}

function getLocationIcon(type, cls) {
  const map = {
    "house": "🏠", "road": "🛣", "suburb": "🏘", "city": "🏙",
    "restaurant": "🍽", "shop": "🛍", "hospital": "🏥",
    "school": "🏫", "park": "🌳", "fuel": "⛽",
    "pharmacy": "💊", "supermarket": "🛒", "bank": "🏦",
  };
  return map[type] || (cls === "highway" ? "🛣" : cls === "amenity" ? "📍" : cls === "building" ? "🏢" : "📍");
}

// ── PANELS ────────────────────────────────────────────────────────
function openStopsPanel() {
  document.getElementById("stops-panel").classList.add("open");
  S.panelOpen = "stops";
  renderStopsList();
}
function closeStopsPanel() {
  document.getElementById("stops-panel").classList.remove("open");
  if (S.panelOpen === "stops") S.panelOpen = null;
}
function toggleStopsPanel() {
  if (S.panelOpen === "stops") closeStopsPanel();
  else openStopsPanel();
}

let stylePicker = false;
function toggleStylePicker(force) {
  stylePicker = force !== undefined ? force : !stylePicker;
  document.getElementById("map-style-picker").classList.toggle("hidden", !stylePicker);
}

// ── ARRIVING BANNER ────────────────────────────────────────────────
function showArrivingBanner(stop) {
  const el = document.getElementById("arriving-banner");
  if (!el || el.classList.contains("show")) return;
  setEl("arriving-name", stop.label || stop.address.split(",")[0]);
  el.classList.add("show");
}
function hideArrivingBanner() {
  document.getElementById("arriving-banner")?.classList.remove("show");
}

// ── FOLLOW MODE ────────────────────────────────────────────────────
function toggleFollow() {
  S.followMode = !S.followMode;
  setFollowBtn(S.followMode);
  if (S.followMode && S.userLat !== null) {
    S.map.flyTo([S.userLat, S.userLon], S.activeIdx !== null ? CONFIG.map.followUserZoom : CONFIG.map.defaultZoom, { duration: 0.9 });
  }
}
function setFollowBtn(on) {
  document.getElementById("fab-follow")?.classList.toggle("active", on);
}

// ── BIND UI ────────────────────────────────────────────────────────
function bindUI() {
  initSearchAutocomplete();

  document.getElementById("fab-follow")?.addEventListener("click", toggleFollow);
  document.getElementById("fab-tilt")?.addEventListener("click", () => setTilt(!S.tilt3d));
  document.getElementById("fab-layers")?.addEventListener("click", () => toggleStylePicker());
  document.getElementById("fab-fit")?.addEventListener("click", () => {
    const pts = [...S.stops, ...S.depots, ...(S.userLat ? [{ lat: S.userLat, lon: S.userLon }] : [])];
    if (pts.length) S.map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lon])).pad(0.1));
    S.followMode = false; setFollowBtn(false);
  });

  // Bottom nav
  document.getElementById("nav-map")?.addEventListener("click", () => { closeStopsPanel(); closeStopDrawer(); });
  document.getElementById("nav-stops")?.addEventListener("click", toggleStopsPanel);
  document.getElementById("nav-recenter")?.addEventListener("click", () => {
    if (S.userLat !== null) {
      S.followMode = true; setFollowBtn(true);
      S.map.flyTo([S.userLat, S.userLon], CONFIG.map.followUserZoom, { duration: 0.9 });
    }
  });
  document.getElementById("nav-route")?.addEventListener("click", () => { runRoute(); toast("Route recalculated", "info"); });

  // Drawer buttons
  document.getElementById("drawer-btn-go")?.addEventListener("click", () => goToStop(S.drawerIdx));
  document.getElementById("drawer-btn-done")?.addEventListener("click", () => markDone(S.drawerIdx));
  document.getElementById("drawer-btn-reopen")?.addEventListener("click", () => reopenStop(S.drawerIdx));
  document.getElementById("drawer-btn-nav")?.addEventListener("click", () => {
    const s = S.drawerIdx != null ? S.stops[S.drawerIdx] : null;
    if (s) window.open(`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`, "_blank");
  });

  // Panel close
  document.getElementById("panel-close")?.addEventListener("click", closeStopsPanel);
  document.getElementById("sheet-backdrop")?.addEventListener("click", () => { closeStopDrawer(); closeStopsPanel(); });

  // Dest card tap → open drawer for active stop
  document.getElementById("dest-card")?.addEventListener("click", () => {
    if (S.activeIdx !== null) openStopDrawer(S.activeIdx);
  });

  // Arriving banner dismiss
  document.getElementById("arriving-banner")?.addEventListener("click", () => {
    if (S.activeIdx !== null) markDone(S.activeIdx);
  });

  // Close style picker on map click
  S.map?.on("click", () => { if (stylePicker) toggleStylePicker(false); });
}

// ── HELPERS ────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const d1 = (lat2-lat1)*Math.PI/180, d2 = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(d1/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(d2/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function setEl(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }

function fmtETA(minutes) {
  const now = new Date();
  now.setMinutes(now.getMinutes() + minutes);
  const h = now.getHours(), m = now.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2,"0")}${ampm}`;
}

function fmtDist(metres) {
  if (metres < 1000) return `${Math.round(metres)}m`;
  return `${(metres/1000).toFixed(1)}km`;
}

function toast(msg, type = "info") {
  const c = document.getElementById("toast-host");
  if (!c) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), CONFIG.ui.toastMs);
}
