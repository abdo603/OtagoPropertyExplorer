/* Geometry measurements, projection helpers, and side labels using ArcGIS Geometry Operators. */
(function (global) {
  "use strict";
  function createGeometryService(deps) {
    var geometryOps = deps.geometryOps;
    var Point = deps.Point;
    var Polyline = deps.Polyline;
    var Graphic = deps.Graphic;
    var projection = deps.projection;
    var view = deps.view;
    var nativeSR = deps.nativeSR;
    var labelLayer = deps.labelLayer;

    function toView(geometry) { return projection.project(geometry, view.spatialReference); }
    function toNative(geometry) { return projection.project(geometry, nativeSR); }
    function validCoordinate(pair) {
      return Array.isArray(pair) && pair.length >= 2 && Number.isFinite(Number(pair[0])) && Number.isFinite(Number(pair[1]));
    }
    function lineLength(path, spatialReference) {
      if (!Array.isArray(path) || path.length < 2 || !path.every(validCoordinate)) return 0;
      var line = new Polyline({ paths: [path.map(function (xy) { return [Number(xy[0]), Number(xy[1])]; })], spatialReference: spatialReference || nativeSR });
      var length = geometryOps.planarLength(line, "meters");
      return Number.isFinite(length) ? Math.abs(length) : 0;
    }

    // Polygon rings are broken into individual sides. A polyline is represented as one
    // dimension per path, avoiding thousands of labels for every vertex in a road.
    function edgesOf(geometry) {
      var edges = [];
      var number = 0;
      var type = String(geometry && geometry.type || "").toLowerCase();
      if (type === "polygon") {
        (geometry.rings || []).forEach(function (ring, ringIndex) {
          if (!Array.isArray(ring) || ring.length < 2 || !ring.every(validCoordinate)) return;
          var first = ring[0], last = ring[ring.length - 1];
          var closed = Number(first[0]) === Number(last[0]) && Number(first[1]) === Number(last[1]);
          var count = closed ? ring.length - 1 : ring.length;
          for (var i = 0; i < count; i++) {
            var a = ring[i], b = ring[(i + 1) % count];
            var length = lineLength([a, b], geometry.spatialReference);
            if (length < 0.001) continue;
            edges.push({ n: ++number, ring: ringIndex + 1, lengthM: +length.toFixed(3),
              from: [Number(a[0]), Number(a[1])], to: [Number(b[0]), Number(b[1])],
              mid: [(Number(a[0]) + Number(b[0])) / 2, (Number(a[1]) + Number(b[1])) / 2] });
          }
        });
      } else if (type === "polyline") {
        (geometry.paths || []).forEach(function (path, pathIndex) {
          if (!Array.isArray(path) || path.length < 2 || !path.every(validCoordinate)) return;
          var length = lineLength(path, geometry.spatialReference);
          var middleIndex = Math.min(path.length - 2, Math.floor((path.length - 1) / 2));
          var a = path[middleIndex], b = path[middleIndex + 1];
          if (length >= 0.001) edges.push({ n: ++number, ring: pathIndex + 1, lengthM: +length.toFixed(3),
            from: [Number(path[0][0]), Number(path[0][1])], to: [Number(path[path.length - 1][0]), Number(path[path.length - 1][1])],
            mid: [(Number(a[0]) + Number(b[0])) / 2, (Number(a[1]) + Number(b[1])) / 2] });
        });
      }
      return edges;
    }

    function drawEdgeLabels(sourceGeometry, options) {
      options = options || {};
      var targetLayer = options.layer || labelLayer;
      if (options.clear !== false) targetLayer.removeAll();
      var type = String(sourceGeometry && sourceGeometry.type || "").toLowerCase();
      if (type !== "polygon" && type !== "polyline") return [];
      var geometry = sourceGeometry;
      try { geometry = toNative(sourceGeometry) || sourceGeometry; } catch (_) { /* retain source geometry if projection fails */ }
      var edges = edgesOf(geometry);
      // Optional duplicate suppression avoids two coincident labels on shared parcel edges.
      if (options.dedupe) {
        var seen = new Set();
        edges = edges.filter(function (edge) {
          function xyKey(xy) { return Number(xy[0]).toFixed(3) + "," + Number(xy[1]).toFixed(3); }
          var a = xyKey(edge.from), b = xyKey(edge.to);
          var key = a < b ? a + "|" + b : b + "|" + a;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      // Prefer the longest edges on complicated boundaries instead of placing hundreds of
      // unreadable labels. Label content is deliberately LTR (S-10 / 100.00 m) in an RTL UI.
      var visibleEdges = edges;
      var maxLabels = Number.isFinite(Number(options.maxLabels)) && Number(options.maxLabels) > 0 ? Number(options.maxLabels) : 140;
      // Default to the longest edges when the display is intentionally limited. This is
      // more useful than showing the first N vertices, which may miss the important sides.
      if (visibleEdges.length > maxLabels || options.longestFirst === true) {
        visibleEdges = visibleEdges.slice().sort(function (a, b) { return b.lengthM - a.lengthM; })
          .slice(0, maxLabels).sort(function (a, b) { return a.n - b.n; });
      }
      visibleEdges.forEach(function (edge) {
        var point = new Point({ x: edge.mid[0], y: edge.mid[1], spatialReference: geometry.spatialReference || nativeSR });
        var prefix = options.labelPrefix || (type === "polygon" ? "P-" : "L-");
        targetLayer.add(new Graphic({
          geometry: toView(point),
          symbol: {
            type: "text",
            text: prefix + edge.n + "\n" + edge.lengthM.toFixed(2) + " m",
            color: "#102030", haloColor: "#ffffff", haloSize: 3,
            horizontalAlignment: "center", verticalAlignment: "middle", lineHeight: 1.05,
            font: { family: "Arial", size: options.fontSize || 9, weight: "bold" }
          }
        }));
      });
      return edges;
    }

    return { toView: toView, toNative: toNative, edgesOf: edgesOf, drawEdgeLabels: drawEdgeLabels, lineLength: lineLength };
  }
  global.OtagoGeometryService = { create: createGeometryService };
})(window);
