/* Load shpjs as ESM so it does not register AMD/Dojo module names. */
(function (global) {
  "use strict";
  global.shpjsReady = import("https://unpkg.com/shpjs@6.2.0/dist/shp.esm.js")
    .then(function (module) {
      var parser = module.default || module.shp;
      if (typeof parser !== "function") throw new Error("لم يتم العثور على دالة قراءة Shapefile داخل مكتبة shpjs.");
      return parser;
    })
    .catch(function (error) {
      console.error("Failed to load shpjs ES module:", error);
      return null;
    });
})(window);
