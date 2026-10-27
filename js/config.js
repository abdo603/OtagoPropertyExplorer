/* Central configuration for the Otago Property Explorer. */
(function (global) {
  "use strict";
  global.OtagoConfig = Object.freeze({
    SERVICE: "https://maps.orc.govt.nz/arcgis/rest/services/PropertyExternal/MapServer",
    BASEMAP_URL: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer",
    NATIVE_SR: Object.freeze({ wkid: 2193 }), // NZGD2000 / New Zealand Transverse Mercator 2000; metres
    F_AREA: "territorial_authority",
    F_LOC: "locality",
    F_ROAD: "name",
    PAGE_SIZE: 1000,
    MAX_QUERY_FEATURES: 1000,
    API_BASE_URL: "http://127.0.0.1:3000"
  });
})(window);
