/* ============================================================
   BINROUTE — APP LOGIC v2
   • Permanent config-only drop-offs
   • Tap marker → bottom sheet → "Go to tip-off" activates it
   • Live speed HUD (user speed + zone limit from Overpass)
   • Address autocomplete with partial-match search
   • Inline loading indicators (no full-screen takeover)
   • Recenter FAB + adaptive zoom (far/near = 2D/3D feel)
   ============================================================ */

"use strict";

// ── STATE ──────────────────────────────────────────────────
const State = {
  map: null,
  userMarker: null,
  userLocation: null,       // { lat, lon }
  userHeading: null,
  userSpeed: 0,             // m/s from GPS
  watchId: null,

  depots: [],               // { name, lat, lon } — geocoded
  dropOffs: [],             // { name, lat, lon, done, active, marker }

  route: [],                // ordered stop objects
  routeLayer: null,

  selectedDepotIdx: 0,      // 0 = user loc, 1+ = depots[i-1]
  activeDropIdx: null,      // currently navigating to

  zoneSpeedKmh: null,       // from Overpass; null = unknown
  speedLookupTimer: null,
  speedLookupLast: 0,

  isGeocoding: false,
  geocodeQueue: 0,          // count of in-flight geocodes for inline loader

  acDebounce: null,         // autocomplete timer
  acResults: [],
};

// ── BOOT ──────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  bindUI();
  startGPS();
  geocodeAll();
});

// ── MAP ───────────────────────────────────────────────────
function initMap() {
  const C = CONFIG.map;
  State.map = L.map("map", {
    worldCopyJump: true,
    minZoom: C.minZoom,
    maxZoom: C.maxZoom,
    zoomControl: false,
  }).setView(C.defaultCenter, C.defaultZoom);

  L.tileLayer(C.tileUrl, {
    maxZoom: C.maxZoom,
    attribution: C.tileAttribution,
  }).addTo(State.map);

  // Track zoom for 2D/3D feel label
  State.map.on("zoom", updateZoomLabel);
}

function updateZoomLabel() {
  const z = State.map.getZoom();
  const el = document.getElementById("zoom-mode-label");
  if (!el) return;
  el.textContent = z >= CONFIG.map.flatZoomThreshold ? "Street" : "Overview";
}

// ── GPS / GEOLOCATION ─────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) {
    toast("GPS not available on this device.", "warning");
    return geocodeAll();
  }

  // Quick single fix first
  navigator.geolocation.getCurrentPosition(
    onGPSUpdate,
    () => {
      // denied / failed — use default
      State.map.setView(CONFIG.map.defaultCenter, CONFIG.map.defaultZoom);
    },
    { timeout: 8000, enableHighAccuracy: true }
  );

  // Then watch continuously
  State.watchId = navigator.geolocation.watchPosition(
    onGPSUpdate,
    null,
    { enableHighAccuracy: true, maximumAge: 2000 }
  );
}

function onGPSUpdate(pos) {
  const { latitude: lat, longitude: lon, speed, heading } = pos.coords;
  const first = !State.userLocation;

  State.userLocation = { lat, lon };
  State.userSpeed = speed || 0;
  State.userHeading = heading;

  updateSpeedHUD();
  updateUserMarker(lat, lon, heading);

  if (first) {
    State.map.setView([lat, lon], CONFIG.map.defaultZoom);
    updateDepotSelector();
    // Trigger speed zone lookup
    scheduleLookup();
  }

  // Adaptive zoom: if user is within ~200m of active drop, zoom in
  if (State.activeDropIdx !== null) {
    const drop = State.dropOffs[State.activeDropIdx];
    if (drop) {
      const dist = haversine(lat, lon, drop.lat, drop.lon);
      if (dist < 200 && State.map.getZoom() < CONFIG.map.nearZoom) {
        State.map.flyTo([lat, lon], CONFIG.map.nearZoom, { duration: 1.2 });
      } else if (dist >= 500 && State.map.getZoom() > CONFIG.map.farZoom) {
        State.map.flyTo([lat, lon], CONFIG.map.farZoom, { duration: 1.2 });
      }
    }
  }
}

function updateUserMarker(lat, lon, heading) {
  if (!State.userMarker) {
    State.userMarker = L.marker([lat, lon], {
      icon: makeUserIcon(heading),
      zIndexOffset: 1000,
    }).addTo(State.map);
  } else {
    State.userMarker.setLatLng([lat, lon]);
    State.userMarker.setIcon(makeUserIcon(heading));
  }
}

function makeUserIcon(heading) {
  const rot = heading != null ? heading : 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="14" fill="${CONFIG.markers.currentColor}" fill-opacity="0.25" stroke="${CONFIG.markers.currentColor}" stroke-width="2"/>
    <circle cx="16" cy="16" r="7" fill="${CONFIG.markers.currentColor}" stroke="#fff" stroke-width="2"/>
    ${heading != null ? `<polygon points="16,2 12,10 20,10" fill="${CONFIG.markers.currentColor}" transform="rotate(${rot},16,16)"/>` : ""}
  </svg>`;
  return L.divIcon({ html: svg, className: "", iconSize: [32,32], iconAnchor: [16,16] });
}

// ── SPEED HUD ─────────────────────────────────────────────
function updateSpeedHUD() {
  const speedEl  = document.getElementById("hud-speed");
  const limitEl  = document.getElementById("hud-limit");
  const unitsEl  = document.getElementById("hud-units");

  if (!speedEl) return;

  const isKmh = CONFIG.speed.units === "kmh";
  const mps = State.userSpeed || 0;
  const display = isKmh ? Math.round(mps * 3.6) : Math.round(mps * 2.237);

  speedEl.textContent = display;
  if (unitsEl) unitsEl.textContent = isKmh ? "km/h" : "mph";

  // Speed vs zone colour
  const zone = State.zoneSpeedKmh || CONFIG.speed.defaultZoneSpeed;
  const zoneDisplay = isKmh ? zone : Math.round(zone * 0.621);

  if (limitEl) limitEl.textContent = zone ? `/ ${zoneDisplay}` : "";

  // Colour warning
  const overSpeed = zone && (mps * 3.6) > zone + 5;
  speedEl.style.color = overSpeed ? "var(--red)" : "var(--text)";
}

function scheduleLookup() {
  if (State.speedLookupTimer) clearTimeout(State.speedLookupTimer);
  const since = Date.now() - State.speedLookupLast;
  const delay = Math.max(0, CONFIG.speed.updateIntervalMs - since);
  State.speedLookupTimer = setTimeout(lookupZoneSpeed, delay);
}

async function lookupZoneSpeed() {
  if (!State.userLocation) return;
  const { lat, lon } = State.userLocation;
  const r = CONFIG.speed.lookupRadiusM;

  const query = `[out:json][timeout:5];
way(around:${r},${lat},${lon})[highway][maxspeed];
out tags 1;`;

  try {
    const res = await fetch(CONFIG.speed.overpassUrl, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
    });
    const data = await res.json();
    if (data.elements && data.elements[0]) {
      const raw = data.elements[0].tags.maxspeed || "";
      const parsed = parseInt(raw);
      if (!isNaN(parsed)) State.zoneSpeedKmh = parsed;
    }
  } catch (_) {
    // Overpass unavailable — keep previous / default
  }

  updateSpeedHUD();
  State.speedLookupLast = Date.now();
  scheduleLookup();
}

// ── GEOCODE ───────────────────────────────────────────────
async function geocodeAddress(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Geocode failed");
  const data = await res.json();
  return data[0] || null;
}

async function geocodeAll() {
  if (State.isGeocoding) return;
  State.isGeocoding = true;

  // Reset
  State.depots = [];
  State.dropOffs = [];

  const allDrops  = [...CONFIG.dropOffs];
  const allDepots = [...CONFIG.depots];

  inlineLoader(true, `Geocoding ${allDrops.length + allDepots.length} addresses…`);

  for (const addr of allDepots) {
    await sleep(CONFIG.ui.geocodeDelay);
    try {
      const r = await geocodeAddress(addr);
      if (r) State.depots.push({ name: addr, lat: parseFloat(r.lat), lon: parseFloat(r.lon) });
    } catch (_) {}
  }

  for (const addr of allDrops) {
    await sleep(CONFIG.ui.geocodeDelay);
    try {
      const r = await geocodeAddress(addr);
      if (r) State.dropOffs.push({
        name: addr,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        done: false,
        active: false,
        marker: null,
        zone: guessZone(addr),
      });
    } catch (_) {}
  }

  inlineLoader(false);
  State.isGeocoding = false;

  plotAllMarkers();
  updateDepotSelector();
  runOptimiseRoute();
}

// ── MARKERS ───────────────────────────────────────────────
function makeIcon(color, label = "", size = 26) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size/2}" cy="${size/2}" r="${size/2-2}" fill="${color}" stroke="#0f172a" stroke-width="2"/>
    ${label ? `<text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-size="${size < 24 ? 8 : 10}" fill="#fff" font-family="monospace" font-weight="bold">${label}</text>` : ""}
  </svg>`;
  return L.divIcon({ html: svg, className: "", iconSize: [size,size], iconAnchor: [size/2,size/2], popupAnchor: [0,-size/2] });
}

function makeDotIcon(color) {
  // Small unobtrusive dot for drop-offs before activation
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">
    <circle cx="7" cy="7" r="5" fill="${color}" stroke="#0f172a" stroke-width="2"/>
  </svg>`;
  return L.divIcon({ html: svg, className: "", iconSize: [14,14], iconAnchor: [7,7], popupAnchor: [0,-10] });
}

function clearAllMapMarkers() {
  State.dropOffs.forEach(d => { if (d.marker) { d.marker.remove(); d.marker = null; } });
  State.depots.forEach(d => { if (d.marker) { d.marker.remove(); d.marker = null; } });
  if (State.routeLayer) { State.routeLayer.remove(); State.routeLayer = null; }
}

function plotAllMarkers() {
  clearAllMapMarkers();
  const bounds = [];

  // Depots
  State.depots.forEach((d, i) => {
    const m = L.marker([d.lat, d.lon], { icon: makeIcon(CONFIG.markers.homeColor, "D") })
      .addTo(State.map)
      .bindPopup(`<strong>🟢 Depot ${i+1}</strong><br>${d.name}`);
    d.marker = m;
    bounds.push([d.lat, d.lon]);
  });

  // Drop-offs: small amber dots until activated
  State.dropOffs.forEach((d, i) => {
    let icon;
    if (d.done)        icon = makeDotIcon(CONFIG.markers.doneColor);
    else if (d.active) icon = makeIcon(CONFIG.markers.dropActiveColor, String(i+1));
    else               icon = makeDotIcon(CONFIG.markers.dropPendingColor);

    const m = L.marker([d.lat, d.lon], { icon })
      .addTo(State.map)
      .on("click", () => openStopSheet(i));

    d.marker = m;
    bounds.push([d.lat, d.lon]);
  });

  if (State.userLocation) bounds.push([State.userLocation.lat, State.userLocation.lon]);

  if (bounds.length > 1) {
    State.map.fitBounds(L.latLngBounds(bounds).pad(0.12));
  }

  renderRouteList();
  updateHeaderStats();
}

function refreshDropIcon(idx) {
  const d = State.dropOffs[idx];
  if (!d || !d.marker) return;
  let icon;
  if (d.done)        icon = makeDotIcon(CONFIG.markers.doneColor);
  else if (d.active) icon = makeIcon(CONFIG.markers.dropActiveColor, String(idx+1));
  else               icon = makeDotIcon(CONFIG.markers.dropPendingColor);
  d.marker.setIcon(icon);
}

// ── BOTTOM SHEET — STOP DETAIL ─────────────────────────────
function openStopSheet(idx) {
  const d = State.dropOffs[idx];
  if (!d) return;

  const sheet  = document.getElementById("stop-sheet");
  const bdrop  = document.getElementById("sheet-backdrop");
  const title  = document.getElementById("sheet-title");
  const meta   = document.getElementById("sheet-meta");
  const btnGo  = document.getElementById("sheet-btn-go");
  const btnDone= document.getElementById("sheet-btn-done");
  const btnNav = document.getElementById("sheet-btn-nav");

  title.textContent = d.name;
  meta.innerHTML = `
    <span class="status-chip ${d.done ? "done" : d.active ? "active" : "pending"}">
      ${d.done ? "✅ Completed" : d.active ? "🔵 Navigating" : "⏳ Pending"}
    </span>
    ${d.zone ? `<span style="color:var(--muted);font-size:0.78rem;">· ${d.zone}</span>` : ""}
  `;

  btnGo.style.display  = (!d.done && !d.active) ? "flex" : "none";
  btnDone.style.display= (!d.done) ? "flex" : "none";
  btnNav.style.display = (d.active || d.done) ? "flex" : "none";
  if (d.done) { btnNav.textContent = "↩ Reopen"; }
  else        { btnNav.textContent = "🗺 Open in Maps"; }

  // Wire buttons
  btnGo.onclick = () => { activateStop(idx); closeSheet(); };
  btnDone.onclick = () => { markDone(idx); closeSheet(); };
  btnNav.onclick = () => {
    if (d.done) { reopenStop(idx); closeSheet(); }
    else openExternalNav(d);
  };

  sheet.classList.add("open");
  bdrop.classList.add("open");
}

function closeSheet() {
  document.getElementById("stop-sheet").classList.remove("open");
  document.getElementById("sheet-backdrop").classList.remove("open");
}

function openExternalNav(d) {
  const url = `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lon}&travelmode=driving`;
  window.open(url, "_blank");
}

// ── STOP ACTIVATION ───────────────────────────────────────
function activateStop(idx) {
  // Deactivate any previous
  if (State.activeDropIdx !== null && State.activeDropIdx !== idx) {
    State.dropOffs[State.activeDropIdx].active = false;
    refreshDropIcon(State.activeDropIdx);
  }

  const d = State.dropOffs[idx];
  d.active = true;
  State.activeDropIdx = idx;
  refreshDropIcon(idx);

  // Fly to the stop
  State.map.flyTo([d.lat, d.lon], CONFIG.map.nearZoom, { duration: CONFIG.map.flyDuration });

  // Draw route to this stop from user / depot
  drawRouteToStop(idx);
  renderRouteList();
  toast(`Navigating to: ${shortName(d.name)}`, "success");
}

function markDone(idx) {
  const d = State.dropOffs[idx];
  d.done   = true;
  d.active = false;
  if (State.activeDropIdx === idx) State.activeDropIdx = null;
  refreshDropIcon(idx);
  renderRouteList();
  updateHeaderStats();
  updateLoadBar();
  toast(`✅ Done: ${shortName(d.name)}`, "success");
}

function reopenStop(idx) {
  const d = State.dropOffs[idx];
  d.done = false;
  refreshDropIcon(idx);
  renderRouteList();
  updateHeaderStats();
  updateLoadBar();
  toast(`↩ Reopened: ${shortName(d.name)}`, "warning");
}

function markAllDone() {
  State.dropOffs.forEach((d, i) => { d.done = true; d.active = false; });
  State.activeDropIdx = null;
  plotAllMarkers();
  updateHeaderStats();
  updateLoadBar();
  toast("All stops marked done!", "success");
}

// ── ROUTE OPTIMISATION ────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getDistance(a, b) {
  return haversine(a.lat, a.lon, b.lat, b.lon);
}

function optimiseRoute(start, stops) {
  const route = [start];
  let remaining = [...stops];
  let current = start;
  while (remaining.length) {
    let ci = 0, cd = Infinity;
    remaining.forEach((s, i) => { const d = getDistance(current, s); if (d < cd) { cd = d; ci = i; } });
    current = remaining.splice(ci, 1)[0];
    route.push(current);
  }
  return route;
}

function runOptimiseRoute() {
  const pending = State.dropOffs.filter(d => !d.done);
  const start = getRouteStart();
  State.route = optimiseRoute(start, pending);
  drawRoute(State.route);
  renderRouteList();
  updateHeaderStats();
}

function getRouteStart() {
  if (State.selectedDepotIdx === 0 && State.userLocation)
    return { name: "Your Location", ...State.userLocation };
  if (State.depots.length)
    return State.depots[Math.max(0, State.selectedDepotIdx - 1)] || State.depots[0];
  if (State.userLocation)
    return { name: "Your Location", ...State.userLocation };
  return { name: "Start", lat: CONFIG.map.defaultCenter[0], lon: CONFIG.map.defaultCenter[1] };
}

async function drawRoute(route) {
  if (State.routeLayer) { State.routeLayer.remove(); State.routeLayer = null; }
  if (route.length < 2) return;
  const C = CONFIG.route;
  if (C.useRealRoads) {
    await drawOSRMRoute(route);
  } else {
    State.routeLayer = L.polyline(route.map(p => [p.lat, p.lon]), {
      color: C.color, weight: C.weight, opacity: C.opacity, dashArray: C.dashArray,
    }).addTo(State.map);
  }
}

async function drawRouteToStop(idx) {
  if (State.routeLayer) { State.routeLayer.remove(); State.routeLayer = null; }
  const start = getRouteStart();
  const stop  = State.dropOffs[idx];
  const seg   = [start, stop];
  if (CONFIG.route.useRealRoads) await drawOSRMRoute(seg);
  else {
    State.routeLayer = L.polyline(seg.map(p => [p.lat, p.lon]), {
      color: CONFIG.route.color, weight: CONFIG.route.weight, opacity: CONFIG.route.opacity,
    }).addTo(State.map);
  }
}

async function drawOSRMRoute(route) {
  const coords = route.map(p => `${p.lon},${p.lat}`).join(";");
  const url = `${CONFIG.route.osrmBase}${coords}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.routes?.[0]) {
      State.routeLayer = L.geoJSON(data.routes[0].geometry, {
        style: { color: CONFIG.route.color, weight: CONFIG.route.weight, opacity: CONFIG.route.opacity },
      }).addTo(State.map);
      return;
    }
  } catch (_) {}
  // Fallback
  State.routeLayer = L.polyline(route.map(p => [p.lat, p.lon]), {
    color: CONFIG.route.color, weight: CONFIG.route.weight,
  }).addTo(State.map);
}

// ── SIDEBAR ───────────────────────────────────────────────
function renderRouteList() {
  const el = document.getElementById("route-list");
  if (!el) return;

  if (State.route.length === 0 && State.dropOffs.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🗺️</div>Geocoding stops…</div>`;
    return;
  }

  el.innerHTML = "";

  State.route.forEach((stop, idx) => {
    const isStart = idx === 0;
    const dropIdx = State.dropOffs.findIndex(d => d.name === stop.name && d.lat === stop.lat);
    const d = dropIdx >= 0 ? State.dropOffs[dropIdx] : null;
    const done   = d?.done   || false;
    const active = d?.active || false;

    const badgeColor = isStart ? "depot" : done ? "done" : active ? "drop" : "pending";
    const badge = isStart ? "S" : done ? "✓" : String(idx);

    const item = document.createElement("div");
    item.className = `route-item${done ? " done" : ""}${active ? " active-stop" : ""}`;
    item.innerHTML = `
      <div class="route-badge ${badgeColor}">${badge}</div>
      <div class="route-info">
        <div class="route-name">${stop.name}</div>
        <div class="route-meta">${isStart ? "START" : done ? "Completed" : active ? "Navigating ↗" : `Stop #${idx}`}${stop.zone ? ` · ${stop.zone}` : ""}</div>
      </div>
      <div class="route-actions">
        ${!isStart && dropIdx >= 0 ? `
          <button class="btn btn-icon ${done ? "btn-secondary" : "btn-success"}" onclick="event.stopPropagation();${done ? `reopenStop(${dropIdx})` : `markDone(${dropIdx})`}" title="${done ? "Reopen" : "Done"}">
            ${done ? "↩" : "✓"}
          </button>
          ${!done ? `<button class="btn btn-icon btn-primary" onclick="event.stopPropagation();activateStop(${dropIdx})" title="Go to">↗</button>` : ""}
        ` : ""}
      </div>
    `;
    item.addEventListener("click", () => {
      if (isStart) return;
      State.map.flyTo([stop.lat, stop.lon], 15, { duration: 0.8 });
    });
    el.appendChild(item);
  });

  // Progress
  const total = State.dropOffs.length;
  const done  = State.dropOffs.filter(d => d.done).length;
  const pct   = total ? Math.round((done/total)*100) : 0;
  const prog  = document.getElementById("progress-row");
  if (prog) prog.innerHTML = `
    <div class="progress-pct">${pct}%</div>
    <div class="progress-info">
      <div>${done} of ${total} stops complete</div>
      <div class="progress-label">${total-done} remaining</div>
    </div>
  `;
}

function updateDepotSelector() {
  const el = document.getElementById("depot-selector");
  if (!el) return;
  el.innerHTML = "";
  const opts = [
    { label: State.userLocation ? "📍 Your Location" : "📍 Current Location", idx: 0 },
    ...State.depots.map((d, i) => ({ label: `🟢 ${shortName(d.name)}`, idx: i+1 })),
  ];
  opts.forEach(({ label, idx }) => {
    const div = document.createElement("div");
    div.className = `depot-option${State.selectedDepotIdx === idx ? " selected" : ""}`;
    div.innerHTML = `<div class="dot-green"></div><div class="depot-option-name">${label}</div>`;
    div.addEventListener("click", () => { State.selectedDepotIdx = idx; updateDepotSelector(); });
    el.appendChild(div);
  });
}

function updateHeaderStats() {
  const total   = State.dropOffs.length;
  const done    = State.dropOffs.filter(d => d.done).length;
  setEl("stat-total",   total);
  setEl("stat-done",    done);
  setEl("stat-pending", total - done);
  setEl("stat-depots",  State.depots.length);
}

function updateLoadBar() {
  const delivered = State.dropOffs.filter(d => d.done).length;
  const cap = CONFIG.van.capacity;
  const pct = Math.min(100, Math.round((delivered/cap)*100));
  const fill = document.getElementById("load-fill");
  const label= document.getElementById("load-label");
  if (!fill) return;
  fill.style.width = `${pct}%`;
  fill.classList.toggle("warn", (cap - delivered) <= CONFIG.van.warnAt);
  if (label) label.textContent = `${delivered} / ${cap} bins`;
}

// ── AUTOCOMPLETE ──────────────────────────────────────────
async function fetchSuggestions(query) {
  const C = CONFIG.autocomplete;
  const cc = C.countryCode ? `&countrycodes=${C.countryCode}` : "";
  const url = `${C.nominatimUrl}?format=jsonv2&limit=${C.maxResults}&q=${encodeURIComponent(query)}${cc}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return [];
  return await res.json();
}

function bindAutocomplete(inputId, listId, onSelect) {
  const input = document.getElementById(inputId);
  const list  = document.getElementById(listId);
  if (!input || !list) return;

  input.addEventListener("input", () => {
    const val = input.value.trim();
    clearTimeout(State.acDebounce);
    if (val.length < CONFIG.autocomplete.minChars) { list.classList.add("hidden"); return; }
    State.acDebounce = setTimeout(async () => {
      const results = await fetchSuggestions(val);
      renderSuggestions(results, list, input, onSelect);
    }, CONFIG.autocomplete.debounceMs);
  });

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !list.contains(e.target)) list.classList.add("hidden");
  });
}

function renderSuggestions(results, list, input, onSelect) {
  list.innerHTML = "";
  if (!results.length) { list.classList.add("hidden"); return; }
  results.forEach(r => {
    const li = document.createElement("div");
    li.className = "ac-item";
    li.textContent = r.display_name;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      input.value = r.display_name;
      list.classList.add("hidden");
      onSelect(r);
    });
    list.appendChild(li);
  });
  list.classList.remove("hidden");
}

// ── DEPOT ADDING ──────────────────────────────────────────
async function addDepotFromInput() {
  const input = document.getElementById("input-add-depot");
  const val   = input.value.trim();
  if (!val) return;
  input.value = "";
  document.getElementById("depot-ac-list")?.classList.add("hidden");
  inlineLoader(true, "Adding depot…");
  try {
    const r = await geocodeAddress(val);
    if (!r) { toast("Could not find that address.", "error"); }
    else {
      State.depots.push({ name: val, lat: parseFloat(r.lat), lon: parseFloat(r.lon), marker: null });
      plotAllMarkers();
      updateDepotSelector();
      runOptimiseRoute();
      toast(`Depot added: ${shortName(val)}`, "success");
    }
  } catch (_) { toast("Geocoding failed.", "error"); }
  inlineLoader(false);
}

// ── RECENTER ──────────────────────────────────────────────
function recenter() {
  if (!State.userLocation) { toast("Waiting for GPS fix…", "warning"); return; }
  const { lat, lon } = State.userLocation;
  // If zoomed in close: go overview. If already overview: zoom close.
  const current = State.map.getZoom();
  const target  = current >= CONFIG.map.flatZoomThreshold ? CONFIG.map.farZoom : CONFIG.map.nearZoom;
  State.map.flyTo([lat, lon], target, { duration: 0.9 });
}

// ── UI BINDING ────────────────────────────────────────────
function bindUI() {
  // Tabs
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const panel = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(panel)?.classList.add("active");
    });
  });

  // Sheet backdrop close
  document.getElementById("sheet-backdrop")?.addEventListener("click", closeSheet);
  document.getElementById("sheet-close")?.addEventListener("click", closeSheet);

  // Recenter FAB
  document.getElementById("fab-recenter")?.addEventListener("click", recenter);

  // Fit bounds FAB
  document.getElementById("fab-fit")?.addEventListener("click", () => {
    const pts = [...State.depots, ...State.dropOffs, ...(State.userLocation ? [State.userLocation] : [])];
    if (!pts.length) return;
    State.map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lon])).pad(0.12));
  });

  // Optimise
  document.getElementById("btn-optimise")?.addEventListener("click", runOptimiseRoute);
  document.getElementById("btn-recalc")?.addEventListener("click", () => {
    State.dropOffs.forEach(d => { d.done = false; d.active = false; });
    State.activeDropIdx = null;
    plotAllMarkers();
    runOptimiseRoute();
    toast("Route recalculated.", "success");
  });
  document.getElementById("btn-mark-all")?.addEventListener("click", markAllDone);

  // Depot add
  document.getElementById("btn-add-depot")?.addEventListener("click", addDepotFromInput);
  document.getElementById("input-add-depot")?.addEventListener("keydown", e => {
    if (e.key === "Enter") addDepotFromInput();
  });

  // Depot autocomplete
  bindAutocomplete("input-add-depot", "depot-ac-list", (r) => {
    document.getElementById("input-add-depot").value = r.display_name;
  });

  // Settings
  document.getElementById("toggle-real-roads")?.addEventListener("change", (e) => {
    CONFIG.route.useRealRoads = e.target.checked;
    if (State.route.length > 0) drawRoute(State.route);
  });

  document.getElementById("toggle-autosave")?.addEventListener("change", (e) => {
    CONFIG.storage.autoSave = e.target.checked;
  });

  document.getElementById("input-capacity")?.addEventListener("change", (e) => {
    const v = parseInt(e.target.value);
    if (!isNaN(v) && v > 0) { CONFIG.van.capacity = v; updateLoadBar(); }
  });

  document.getElementById("input-speed-units")?.addEventListener("change", (e) => {
    CONFIG.speed.units = e.target.value;
    updateSpeedHUD();
  });

  document.getElementById("input-route-color")?.addEventListener("input", (e) => {
    CONFIG.route.color = e.target.value;
    if (State.routeLayer) State.routeLayer.setStyle({ color: e.target.value });
  });

  updateLoadBar();
  updateHeaderStats();
}

// ── HELPERS ───────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function shortName(name) {
  const parts = (name || "").split(",");
  return parts[0].trim().substring(0, 28);
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function guessZone(address) {
  const p = address.split(",");
  return p.length >= 2 ? p[p.length - 2].trim() : null;
}

function inlineLoader(show, msg = "") {
  const el = document.getElementById("inline-loader");
  const tx = document.getElementById("inline-loader-text");
  if (!el) return;
  el.classList.toggle("hidden", !show);
  if (tx) tx.textContent = msg;
}

function toast(msg, type = "info") {
  const c = document.getElementById("toast-container");
  if (!c) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), CONFIG.ui.toastDuration);
}