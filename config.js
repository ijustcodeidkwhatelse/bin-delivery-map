// ═══════════════════════════════════════════════════════════════
//  BINROUTE CONFIG — Edit this file to customise everything
// ═══════════════════════════════════════════════════════════════

const CONFIG = {

  // ── APP ────────────────────────────────────────────────────────
  app: {
    name: "BinRoute",
    version: "3.0",
  },

  // ── MAP ────────────────────────────────────────────────────────
  map: {
    defaultCenter:    [-36.8485, 174.7633],  // Auckland fallback
    defaultZoom:      14,
    maxZoom:          19,
    minZoom:          3,
    followUserZoom:   17,    // zoom when actively navigating
    overviewZoom:     13,    // zoom when showing all stops
    // Auto-follow: map stays centred on user while navigating
    autoFollow:       true,
    // Pitch/tilt for 3D feel while navigating (0-60 degrees)
    // Note: OSM tiles are 2D but we simulate 3D feel via CSS transform
    navPitch:         45,
    overviewPitch:    0,
    // Metres from stop before auto-zooming in
    arrivalRadiusM:   150,
  },

  // ── MAP TILE STYLES ────────────────────────────────────────────
  // Switch between these in the map view picker
  mapStyles: [
    {
      id:   "street",
      name: "Street",
      icon: "🗺",
      url:  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      attr: "&copy; OpenStreetMap contributors",
    },
    {
      id:   "dark",
      name: "Dark",
      icon: "🌑",
      url:  "https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png",
      attr: "&copy; Stadia Maps &copy; OpenStreetMap contributors",
    },
    {
      id:   "satellite",
      name: "Satellite",
      icon: "🛰",
      url:  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attr: "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGS, and the GIS User Community",
    },
    {
      id:   "topo",
      name: "Topo",
      icon: "⛰",
      url:  "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      attr: "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap",
    },
  ],
  defaultMapStyle: "dark",   // id from mapStyles array

  // ── ICONS ──────────────────────────────────────────────────────
  // Emoji or text used for map markers
  icons: {
    user:      "🚛",   // your vehicle marker
    dropOff:   "📦",   // pending drop-off
    dropDone:  "✅",   // completed drop-off
    dropActive:"📍",   // currently navigating to
    depot:     "🏭",   // depot / home base
    destination:"🏁",  // final stop indicator
  },

  // ── ROUTE COLOURS ─────────────────────────────────────────────
  route: {
    activeColor:   "#00d4ff",   // current leg being driven
    plannedColor:  "#ffffff",   // remaining route
    doneColor:     "#4ade80",   // completed legs
    lineWeight:    5,
    lineOpacity:   0.85,
    osrmBase:      "https://router.project-osrm.org/route/v1/driving/",
  },

  // ── MARKER COLOURS ────────────────────────────────────────────
  markers: {
    userColor:    "#00d4ff",
    dropColor:    "#f59e0b",
    doneColor:    "#4ade80",
    activeColor:  "#00d4ff",
    depotColor:   "#a78bfa",
  },

  // ── PERMANENT DROP-OFF STOPS ───────────────────────────────────
  // ONLY edit here — cannot be changed in the UI
  dropOffs: [
  ],

  // ── DEPOTS ─────────────────────────────────────────────────────
  // Set here — cannot be changed in UI
  depots: [
    "29, Bergin Road, Horowhenua District, Manawatū-Whanganui, 4814, New Zealand",
    "10, Roe Street, Weraroa, Horowhenua District, Manawatū-Whanganui, 5510, New Zealand",
    "Tip Road, Palmerston North City, Manawatū-Whanganui, 4412, New Zealand",
  ],

  // ── VAN ────────────────────────────────────────────────────────
  van: {
    capacity:     15,
    warnAt:       9,
    // Average speed for ETA calculation (km/h) when GPS speed unavailable
    avgSpeedKmh:  35,
    // Stop dwell time (minutes) — time spent at each delivery
    dwellMinutes: 3,
  },

  // ── SPEED ──────────────────────────────────────────────────────
  speed: {
    units:           "kmh",       // "kmh" | "mph"
    defaultZoneKmh:  50,
    overpassUrl:     "https://overpass-api.de/api/interpreter",
    lookupRadiusM:   50,
    intervalMs:      10000,
  },

  // ── AUTOCOMPLETE ──────────────────────────────────────────────
  autocomplete: {
    minChars:    2,
    debounceMs:  250,
    maxResults:  7,
    url:         "https://nominatim.openstreetmap.org/search",
    countryCode: "nz",        // "" = global
    // Also try partial words (e.g. "26 ea" → "26 east road")
    partialMatch: true,
  },

  // ── UI ─────────────────────────────────────────────────────────
  ui: {
    geocodeDelayMs:    280,
    toastMs:           3500,
    panelAutoHideMs:   6000,   // ms before slide-out panels auto-hide
    // Show panel on startup briefly
    showPanelOnStart:  true,
  },

};

window.CONFIG = CONFIG;
