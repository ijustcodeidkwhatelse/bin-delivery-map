// ============================================================
//  BINROUTE — CONFIG FILE
//  Drop-off locations are PERMANENT — set here only.
//  Users cannot add or remove drop-offs via the app UI.
// ============================================================

const CONFIG = {

  // ── MAP ────────────────────────────────────────────────────
  map: {
    defaultCenter: [-36.8485, 174.7633],   // Auckland fallback if GPS denied
    defaultZoom: 13,
    minZoom: 2,
    maxZoom: 19,
    tileUrl: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    tileAttribution: "&copy; OpenStreetMap contributors",
    flyDuration: 1.0,
    nearZoom: 17,    // "close" zoom — used when arriving at stop
    farZoom: 13,     // "overview" zoom
    // Zoom level below which map switches to flat/2D overview feel
    flatZoomThreshold: 14,
  },

  // ── ROUTE ─────────────────────────────────────────────────
  route: {
    color: "#38bdf8",
    weight: 4,
    opacity: 0.85,
    dashArray: null,
    useRealRoads: false,
    osrmBase: "https://router.project-osrm.org/route/v1/driving/",
  },

  // ── MARKERS ───────────────────────────────────────────────
  markers: {
    homeColor:        "#22c55e",   // green  — depots
    dropPendingColor: "#f59e0b",   // amber  — drop-off dot (unactivated)
    dropActiveColor:  "#38bdf8",   // blue   — activated / navigating to
    doneColor:        "#64748b",   // grey   — completed
    currentColor:     "#f43f5e",   // red    — user position
  },

  // ── VAN / LOAD ────────────────────────────────────────────
  van: {
    capacity: 20,
    warnAt: 3,
  },

  // ── SPEED ─────────────────────────────────────────────────
  speed: {
    units: "kmh",           // "kmh" or "mph"
    defaultZoneSpeed: 50,   // shown when road limit unavailable
    overpassUrl: "https://overpass-api.de/api/interpreter",
    lookupRadiusM: 40,      // metres radius to query road near user
    updateIntervalMs: 8000, // how often to re-query road speed limit
  },

  // ── PERMANENT DROP-OFF LOCATIONS ──────────────────────────
  //  Edit this array to change stops. Cannot be changed in the UI.
  dropOffs: [
    "123 Queen Street, Auckland CBD, Auckland",
    "456 Dominion Road, Mount Eden, Auckland",
    "789 Great South Road, Papatoetoe, Auckland",
    "55 Symonds Street, Auckland CBD, Auckland",
    "32 Ponsonby Road, Ponsonby, Auckland",
  ],

  // ── DEPOTS / HOME BASES ────────────────────────────────────
  depots: [
    "170 Gaunt Street, Auckland CBD, Auckland",
    "1 Wiri Station Road, Māngere, Auckland",
  ],

  // ── ADDRESS AUTOCOMPLETE ───────────────────────────────────
  autocomplete: {
    minChars: 2,
    debounceMs: 320,
    maxResults: 6,
    nominatimUrl: "https://nominatim.openstreetmap.org/search",
    countryCode: "nz",     // bias results to NZ; empty = global
  },

  // ── UI ─────────────────────────────────────────────────────
  ui: {
    geocodeDelay:   280,
    toastDuration:  3200,
  },

  // ── STORAGE ────────────────────────────────────────────────
  storage: {
    depotsKey:  "binroute_depots",
    autoSave:   true,
  },

};

window.CONFIG = CONFIG;