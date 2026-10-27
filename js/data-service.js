/* ArcGIS FeatureLayer query operations, with a strict result cap to keep long-road searches responsive. */
(function (global) {
  "use strict";
  function pause() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }

  async function distinct(layer, field, where, areaField) {
    var query = layer.createQuery();
    query.where = where || "1=1";
    query.outFields = [field];
    query.returnDistinctValues = true;
    query.returnGeometry = false;
    query.orderByFields = [field];
    query.num = 2000;
    var response = await layer.queryFeatures(query);
    var unique = new global.Map();
    response.features.forEach(function (feature) {
      var value = feature.attributes[field];
      if (value == null || !String(value).trim()) return;
      (field === areaField ? String(value).split(",") : [String(value)]).forEach(function (part) {
        part = part.trim();
        if (part) unique.set(part, part);
      });
    });
    return Array.from(unique.values()).sort(function (a, b) { return a.localeCompare(b); })
      .map(function (value) { return { value: value }; });
  }

  async function fetchIntersecting(layer, area, options) {
    var nativeSR = options.nativeSR;
    var geometryOps = options.geometryOps;
    var objectIdField = options.getObjectIdField;
    var maxFeatures = options.maxFeatures || 3000;
    var pageSize = options.pageSize || 1000;
    var allFeatures = [];
    var truncated = false;
    // Prepare the search geometry once because it is compared with many candidates.
    if (geometryOps && typeof geometryOps.accelerateIntersects === "function") {
      try { geometryOps.accelerateIntersects(area); } catch (_) { /* acceleration is optional */ }
    }

    // Ask the service to spatially filter using the actual area geometry rather than
    // its larger rectangular extent; local Intersect is still applied below as requested.
    for (var start = 0; start < maxFeatures;) {
      var query = layer.createQuery();
      query.geometry = area;
      query.spatialRelationship = "intersects";
      query.returnGeometry = true;
      query.outFields = ["*"];
      query.outSpatialReference = nativeSR;
      query.orderByFields = [objectIdField(layer)];
      query.start = start;
      query.num = Math.min(pageSize, maxFeatures - start);
      var response = await layer.queryFeatures(query);
      var page = response.features || [];
      allFeatures.push.apply(allFeatures, page);
      if (typeof options.onProgress === "function") options.onProgress(allFeatures.length);

      if (!page.length || !response.exceededTransferLimit) break;
      start += page.length;
      if (start >= maxFeatures) {
        truncated = !!response.exceededTransferLimit;
        break;
      }
      // Let the browser paint progress and keep the map UI responsive between requests.
      await pause();
    }

    // The ArcGIS REST query already applies spatialRelationship="intersects" to
    // the supplied search geometry. Re-running a client-side topological intersection
    // for every returned polygon duplicates expensive geometry work, especially for
    // long road buffers. Keep only records with geometry and trust the server's exact
    // spatial filter; overlap area is still calculated separately when explicitly needed.
    var matched = allFeatures.filter(function (feature) { return !!feature.geometry; });
    // Add metadata to the array without changing the calling convention.
    matched.truncated = truncated;
    matched.candidateCount = allFeatures.length;
    return matched;
  }
  global.OtagoDataService = { distinct: distinct, fetchIntersecting: fetchIntersecting };
})(window);
