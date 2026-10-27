require([
      "esri/Map", "esri/views/MapView", "esri/layers/FeatureLayer", "esri/layers/GraphicsLayer",
      "esri/layers/TileLayer", "esri/Graphic", "esri/geometry/Polygon", "esri/geometry/Polyline", "esri/geometry/Point", "esri/geometry/SpatialReference",
      "esri/geometry/operators/intersectsOperator", "esri/geometry/operators/intersectionOperator",
      "esri/geometry/operators/areaOperator", "esri/geometry/operators/lengthOperator",
      "esri/geometry/operators/bufferOperator",
      "esri/geometry/operators/simplifyOperator", "esri/geometry/operators/projectOperator",
      "esri/geometry/operators/distanceOperator", "esri/widgets/Sketch",
      "esri/geometry/operators/proximityOperator"
    ], function (Map, MapView, FeatureLayer, GraphicsLayer, TileLayer, Graphic, Polygon, Polyline, Point, SpatialReference,
      intersectsOperator, intersectionOperator, areaOperator, lengthOperator, bufferOperator,
      simplifyOperator, projectOperator, distanceOperator, Sketch, proximityOperator) {
      "use strict";

      // Modern ArcGIS Geometry Operators (replacement for deprecated geometryEngine and projection modules).
      const geometryOps = {
        intersects: (a, b) => intersectsOperator.execute(a, b),
        accelerateIntersects: geometry => intersectsOperator.accelerateGeometry(geometry),
        intersect: (a, b) => intersectionOperator.execute(a, b),
        planarArea: (geometry, unit) => areaOperator.execute(geometry, { unit: unit }),
        planarLength: (geometry, unit) => lengthOperator.execute(geometry, { unit: unit }),
        planarDistance: (a, b) => distanceOperator.execute(a, b, { unit: "meters" }),
        simplify: geometry => simplifyOperator.execute(geometry),
        buffer: (inputGeometries, distance, unit, dissolve) => {
          const geometries = Array.isArray(inputGeometries) ? inputGeometries : [inputGeometries];
          const valid = geometries.filter(Boolean);
          if (!valid.length) return [];
          // Let bufferOperator dissolve buffers internally. A second topological union
          // over thousands of buffers was needlessly expensive and could stall the UI.
          return (bufferOperator.executeMany(
            valid,
            valid.map(() => distance),
            { unit: unit, union: Boolean(dissolve) }
          ) || []).filter(Boolean);
        }
      };
      // projectOperator must be loaded before use. Expose the small interface used by app modules.
      const projection = {
        load: () => projectOperator.isLoaded() ? Promise.resolve() : projectOperator.load(),
        project: (geometry, outSpatialReference) => projectOperator.execute(geometry, outSpatialReference)
      };

      // ---------- الخريطة تُبنى مباشرة من الكود (بدون WebMap ID) ----------
      const { SERVICE, NATIVE_SR: NATIVE_SR_CONFIG, F_AREA, F_LOC, F_ROAD, BASEMAP_URL, PAGE_SIZE, MAX_QUERY_FEATURES, API_BASE_URL } = window.OtagoConfig;
      // projectOperator requires SpatialReference instances, not plain { wkid } JSON objects.
      const NATIVE_SR = new SpatialReference(NATIVE_SR_CONFIG);
      const WGS84_SR = new SpatialReference({ wkid: 4326 });

      const Utils = window.OtagoUtils;
      const DataService = window.OtagoDataService;
      const $ = Utils.$;
      const areaInput = $("areaInput"), localitySel = $("localitySelect"), roadSel = $("roadSelect");
      const layerSel = $("layerSelect"), resultSel = $("resultSelect"), addressSel = $("addressSelect");
      const statusEl = $("status"), applyBtn = $("applyRoadBtn"), saveBtn = $("saveBtn");

      const parcels = new FeatureLayer({ url: SERVICE + "/1", title: "Parcels", outFields: ["*"], popupEnabled: false,
        renderer: { type: "simple", symbol: { type: "simple-fill", color: [228,244,191,0.25], outline: { color: [62,72,71,0.9], width: 1 } } } });
      const props = new FeatureLayer({ url: SERVICE + "/0", title: "Properties", outFields: ["*"], visible: false, popupEnabled: false,
        renderer: { type: "simple", symbol: { type: "simple-fill", color: [245,180,78,0.1], outline: { color: [185,126,43,0.85], width: 0.8 } } } });
      const addresses = new FeatureLayer({ url: SERVICE + "/2", title: "Addresses", outFields: ["*"], visible: false, popupEnabled: false });
      const roads = new FeatureLayer({ url: SERVICE + "/3", title: "Roads", outFields: ["*"], popupEnabled: false,
        renderer: { type: "simple", symbol: { type: "simple-line", color: [255,255,255,0.9], width: 2.4 } } });
      // A separate, unfiltered query layer ensures nearest-road measurements are not limited
      // by the current district/locality dropdown filters applied to the visible roads layer.
      const roadSearchLayer = new FeatureLayer({ url: SERVICE + "/3", title: "Road distance search", outFields: ["*"], visible: false, popupEnabled: false });

      const resultsLayer = new GraphicsLayer({ title: "Intersect results" });
      const roadLayer = new GraphicsLayer({ title: "Road + buffer" });
      const uploadLayer = new GraphicsLayer({ title: "Uploaded shapefile" });
      const selectLayer = new GraphicsLayer({ title: "Selection" });
      const labelLayer = new GraphicsLayer({ title: "Edge labels" });
      const addrLayer = new GraphicsLayer({ title: "Addresses in parcel" });
      const manualDrawLayer = new GraphicsLayer({ title: "Manual coordinate geometry" });
      const overlapLayer = new GraphicsLayer({ title: "Cross-layer intersections" });
      const nearestRoadLayer = new GraphicsLayer({ title: "Nearest road to selected parcel" });
      const longestSidesLayer = new GraphicsLayer({ title: "Longest parcel and shapefile sides" });
      const sketchLayer = new GraphicsLayer({ title: "Sketch drawings" });
      const shapefileLabelLayer = new GraphicsLayer({ title: "Shapefile side length labels" });
      const distanceMeasureLayer = new GraphicsLayer({ title: "Nearest road distance measurement" });
      const sketchMeasureLayer = new GraphicsLayer({ title: "Sketch measurement labels" });
      const geometryAnalysisLayer = new GraphicsLayer({ title: "Analysis intersections" });
      const geometryAnalysisLabelsLayer = new GraphicsLayer({ title: "Intersection percentage labels" });

      const mapInstance = new Map({ layers: [
        new TileLayer({ url: BASEMAP_URL }),
        roads, props, parcels, addresses, roadLayer, resultsLayer, geometryAnalysisLayer, uploadLayer, addrLayer,
        overlapLayer, nearestRoadLayer, selectLayer, longestSidesLayer, labelLayer, manualDrawLayer,
        sketchLayer, shapefileLabelLayer, distanceMeasureLayer, sketchMeasureLayer, geometryAnalysisLabelsLayer ] });
      const view = new MapView({ container: "viewDiv", map: mapInstance, center: [170.5, -45.87], zoom: 11,
        popup: { dockEnabled: false } });

      // ---------- حالة التطبيق ----------
      let results = [];            // نتائج التقاطع، مع حساب الأضلاع عند الاختيار فقط
      let analysisAddressFeatures = []; // عناوين النطاق؛ ربطها بالقطعة يحدث عند اختيارها
      let analysisWasTruncated = false;
      let context = {};            // معلومات الاستعلام لحفظها في JSON
      let currentSelectedResult = null;
      let currentSelectionPoint = null;
      // Each manually entered point is normalized to NZTM EPSG:2193 immediately, so
      // points entered in either supported CRS can safely form one geometry.
      let manualPoints = [];
      let manualGeometry = null;
      let uploadedShapefileGeometry = null;
      let uploadedShapefileEdges = [];
      let areaAnalysisRequestId = 0;
      let analysisRunId = 0;
      let sketchWidget = null;
      let sketchDrawingActive = false;
      let sketchSuppressClicksUntil = 0;
      let roadSearchReady = null;
      let districtReq = 0, localityReq = 0;

      const status = (message, kind) => Utils.setStatus(statusEl, message, kind);
      const esc = Utils.escapeSql;
      const fmt = Utils.format;
      const oid = Utils.getObjectIdField;
      const setOptions = Utils.setOptions;
      const toView = g => projection.project(g, view.spatialReference);
      const to2193 = g => projection.project(g, NATIVE_SR);
      let showAllSideLabels = true;
      function setExportActionsEnabled(enabled) {
        [saveBtn, $("exportCsvBtn")].filter(Boolean).forEach(button => { button.disabled = !enabled; });
      }
      function renderUploadedShapefileLabels() {
        shapefileLabelLayer.removeAll();
        if (!uploadedShapefileGeometry) return;
        drawEdgeLabels(uploadedShapefileGeometry, {
          layer: shapefileLabelLayer, clear: true, labelPrefix: "S-", fontSize: showAllSideLabels ? 8 : 10,
          // Show every unique side by default; when hidden, retain the five longest labels.
          maxLabels: showAllSideLabels ? Math.max(uploadedShapefileEdges.length + 1, 1) : 5,
          dedupe: true, longestFirst: !showAllSideLabels
        });
      }
      function renderSelectedEdgeLabels(result) {
        labelLayer.removeAll();
        if (!result || result.layer === uploadLayer) return;
        const type = String(result.geom && result.geom.type || "").toLowerCase();
        if (type === "polygon" || type === "polyline") drawEdgeLabels(result.geom, {
          labelPrefix: "P-", fontSize: 9, maxLabels: 5, dedupe: true, longestFirst: true
        });
      }

      // Floating map summaries can be repositioned by dragging their header/grip.
      function enableDraggableBadge(panelId, handleId) {
        const panel = $(panelId), handle = $(handleId);
        if (!panel || !handle) return;
        let drag = null;
        handle.addEventListener("pointerdown", event => {
          if (event.button !== 0 || event.target.closest("button, a, input, select")) return;
          const rect = panel.getBoundingClientRect();
          panel.style.left = rect.left + "px";
          panel.style.top = rect.top + "px";
          panel.style.right = "auto";
          panel.style.bottom = "auto";
          drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
          try { handle.setPointerCapture(event.pointerId); } catch (_) {}
          event.preventDefault();
          event.stopPropagation();
        });
        handle.addEventListener("pointermove", event => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          event.stopPropagation();
          const sidePanel = $("panel");
          const mapRightEdge = sidePanel ? sidePanel.getBoundingClientRect().left - 8 : window.innerWidth - 4;
          const maxLeft = Math.max(4, Math.min(window.innerWidth - panel.offsetWidth - 4, mapRightEdge - panel.offsetWidth));
          const maxTop = Math.max(4, window.innerHeight - Math.min(panel.offsetHeight, window.innerHeight - 8) - 4);
          panel.style.left = Math.max(4, Math.min(maxLeft, drag.left + event.clientX - drag.x)) + "px";
          panel.style.top = Math.max(4, Math.min(maxTop, drag.top + event.clientY - drag.y)) + "px";
        });
        const endDrag = event => {
          if (drag && drag.pointerId === event.pointerId) { drag = null; event.stopPropagation(); }
        };
        handle.addEventListener("pointerup", endDrag);
        handle.addEventListener("pointercancel", endDrag);
      }
      const analysisPaneIds = { selection: "mapAnalysisBadge", overlap: "geometryAnalysisBadge", shapefile: "shapefileAnalysisBadge" };
      let activeAnalysisTab = "selection";
      function syncAnalysisDashboard(preferredTab) {
        const dashboard = $("analysisDashboard");
        const available = Object.keys(analysisPaneIds).filter(key => !$(analysisPaneIds[key]).hidden);
        if (!available.length) {
          dashboard.hidden = true;
          document.querySelectorAll("[data-analysis-tab]").forEach(button => { button.hidden = true; button.setAttribute("aria-selected", "false"); });
          return;
        }
        dashboard.hidden = false;
        let target = preferredTab && available.includes(preferredTab) ? preferredTab
          : available.includes(activeAnalysisTab) ? activeAnalysisTab : available[0];
        activeAnalysisTab = target;
        Object.keys(analysisPaneIds).forEach(key => {
          const pane = $(analysisPaneIds[key]);
          const button = document.querySelector('[data-analysis-tab="' + key + '"]');
          pane.classList.toggle("is-active", key === target && !pane.hidden);
          if (button) {
            button.hidden = !available.includes(key);
            button.classList.toggle("is-active", key === target);
            button.setAttribute("aria-selected", key === target ? "true" : "false");
          }
        });
      }
      document.querySelectorAll("[data-analysis-tab]").forEach(button => button.addEventListener("click", () => {
        const tab = button.dataset.analysisTab;
        if (!$(analysisPaneIds[tab]).hidden) syncAnalysisDashboard(tab);
      }));
      enableDraggableBadge("analysisDashboard", "analysisDashboardHandle");

      const whereArea = value => Utils.whereLike(F_AREA, value);
      const whereLoc = value => Utils.whereEquals(F_LOC, value);
      const whereRoad = value => Utils.whereEquals(F_ROAD, value);
      const and = Utils.combineWhere;
      const distinct = (layer, field, where) => DataService.distinct(layer, field, where, F_AREA);
      const fetchIntersecting = (layer, area, onProgress, maxFeatures) => DataService.fetchIntersecting(layer, area, {
        nativeSR: NATIVE_SR, geometryOps: geometryOps, getObjectIdField: oid,
        pageSize: Math.min(PAGE_SIZE, maxFeatures || MAX_QUERY_FEATURES),
        maxFeatures: maxFeatures || MAX_QUERY_FEATURES, onProgress: onProgress
      });
      const Geometry = window.OtagoGeometryService.create({
        geometryOps: geometryOps, Point: Point, Polyline: Polyline, Graphic: Graphic, projection: projection,
        view: view, nativeSR: NATIVE_SR, labelLayer: labelLayer
      });
      const edgesOf = Geometry.edgesOf;
      const drawEdgeLabels = Geometry.drawEdgeLabels;

      function getAttribute(attributes, names) {
        const source = attributes || {};
        const keys = Object.keys(source);
        for (const requested of names) {
          const key = keys.find(candidate => candidate.toLowerCase() === String(requested).toLowerCase());
          if (key && source[key] != null && String(source[key]).trim() !== "") return source[key];
        }
        return null;
      }

      function asNativeGeometry(geometry) {
        if (!geometry) return null;
        const sr = geometry.spatialReference || {};
        const wkid = sr.latestWkid || sr.wkid;
        if (!wkid || wkid === NATIVE_SR.wkid) return geometry;
        return to2193(geometry) || geometry;
      }

      function drawCrossLayerIntersections(result) {
        if (currentSelectedResult !== result) return;
        overlapLayer.removeAll();
        const matches = (result && result.layerOverlapSummary || []).flatMap(summary => summary.matches || [])
          .filter(match => match.intersectionGeometry)
          .sort((a, b) => b.overlapM2 - a.overlapM2)
          .slice(0, 100);
        matches.forEach(match => {
          try {
            const displayGeometry = toView(match.intersectionGeometry);
            if (displayGeometry) overlapLayer.add(new Graphic({ geometry: displayGeometry, symbol: {
              type: "simple-fill", color: [255, 95, 31, 0.28], outline: { color: [190, 45, 15, 0.95], width: 1.5 }
            } }));
          } catch (error) { console.warn("Could not draw a cross-layer intersection:", error); }
        });
      }

      async function calculateLayerOverlaps(result) {
        if (!result || String(result.geom && result.geom.type || "").toLowerCase() !== "polygon") return;
        if (result.layerOverlapChecked && Array.isArray(result.layerOverlapSummary)) {
          drawCrossLayerIntersections(result);
          return;
        }
        result.layerOverlapChecked = true;
        result.layerOverlapSummary = [];
        result.layerOverlapError = null;
        const selectedGeometry = asNativeGeometry(result.geom);
        const selectedArea = Math.abs(geometryOps.planarArea(selectedGeometry, "square-meters"));
        if (!Number.isFinite(selectedArea) || selectedArea <= 0) return;

        let targetLayers;
        if (result.layer === props) targetLayers = [["LINZ Primary Parcels", parcels]];
        else if (result.layer === parcels) targetLayers = [["ORC Properties", props]];
        else targetLayers = [["ORC Properties", props], ["LINZ Primary Parcels", parcels]];

        try {
          for (const [layerName, layer] of targetLayers) {
            const candidates = await fetchIntersecting(layer, selectedGeometry, null, 1500);
            const matches = [];
            for (const feature of candidates) {
              if (!feature.geometry) continue;
              try {
                const candidateGeometry = asNativeGeometry(feature.geometry);
                const intersectionGeometry = geometryOps.intersect(selectedGeometry, candidateGeometry);
                if (!intersectionGeometry || String(intersectionGeometry.type || "").toLowerCase() !== "polygon") continue;
                const intersectionArea = Math.abs(geometryOps.planarArea(intersectionGeometry, "square-meters"));
                if (!Number.isFinite(intersectionArea) || intersectionArea <= 0.01) continue;
                const candidateArea = Math.abs(geometryOps.planarArea(candidateGeometry, "square-meters"));
                const objectId = feature.attributes && feature.attributes[oid(layer)];
                const labelResult = { layer: layer, feature: feature, objectId: objectId };
                matches.push({
                  layerName: layerName,
                  objectId: objectId == null ? null : objectId,
                  label: labelOf(labelResult),
                  overlapM2: +intersectionArea.toFixed(3),
                  selectedPercent: +(intersectionArea / selectedArea * 100).toFixed(4),
                  otherPercent: Number.isFinite(candidateArea) && candidateArea > 0 ? +(intersectionArea / candidateArea * 100).toFixed(4) : null,
                  intersectionGeometry: intersectionGeometry
                });
              } catch (intersectionError) {
                console.warn("Skipping an invalid cross-layer geometry:", intersectionError);
              }
            }
            matches.sort((a, b) => b.overlapM2 - a.overlapM2);
            result.layerOverlapSummary.push({
              layerName: layerName,
              count: matches.length,
              truncated: !!candidates.truncated,
              matches: matches.slice(0, 50)
            });
          }
          drawCrossLayerIntersections(result);
        } catch (error) {
          result.layerOverlapError = "تعذر إكمال المقارنة: " + (error.message || error);
          console.error("Cross-layer overlap analysis failed:", error);
        }
      }

      function collectGeometryVertices(geometry, maxVertices) {
        const type = String(geometry && geometry.type || "").toLowerCase();
        const groups = type === "polygon" ? (geometry.rings || []) : type === "polyline" ? (geometry.paths || []) : [];
        const coordinates = [];
        groups.forEach(group => {
          if (!Array.isArray(group)) return;
          group.forEach((xy, index) => {
            if (!Array.isArray(xy) || xy.length < 2 || !Number.isFinite(Number(xy[0])) || !Number.isFinite(Number(xy[1]))) return;
            if (type === "polygon" && index === group.length - 1 && group.length > 1 &&
              Number(xy[0]) === Number(group[0][0]) && Number(xy[1]) === Number(group[0][1])) return;
            coordinates.push([Number(xy[0]), Number(xy[1])]);
          });
        });
        const limit = Math.max(2, maxVertices || 2500);
        if (coordinates.length <= limit) return coordinates;
        const stride = (coordinates.length - 1) / (limit - 1);
        const sampled = [];
        for (let i = 0; i < limit; i++) sampled.push(coordinates[Math.round(i * stride)]);
        return sampled;
      }

      function findNearestConnector(polygonGeometry, roadGeometry) {
        // Minimum separation occurs at an endpoint projected onto the opposite geometry.
        // Check vertices from both boundaries and use the proximity operator to locate the
        // nearest point on the opposite boundary, all in projected metre-based EPSG:2193.
        const polygonVertices = collectGeometryVertices(polygonGeometry, 2500);
        const roadVertices = collectGeometryVertices(roadGeometry, 2500);
        let best = null;
        function consider(sourceXY, targetGeometry, sourceKind) {
          try {
            const sourcePoint = new Point({ x: sourceXY[0], y: sourceXY[1], spatialReference: NATIVE_SR });
            const nearest = proximityOperator.getNearestCoordinate(targetGeometry, sourcePoint, {
              unit: "meters", testPolygonInterior: false
            });
            const coordinate = nearest && nearest.coordinate;
            const distance = Number(nearest && nearest.distance);
            if (!coordinate || !Number.isFinite(coordinate.x) || !Number.isFinite(coordinate.y) || !Number.isFinite(distance) || distance < 0) return;
            if (!best || distance < best.distanceM) {
              const targetXY = [Number(coordinate.x), Number(coordinate.y)];
              best = sourceKind === "parcel"
                ? { parcelXY: sourceXY.slice(), roadXY: targetXY, distanceM: distance }
                : { parcelXY: targetXY, roadXY: sourceXY.slice(), distanceM: distance };
            }
          } catch (error) {
            console.warn("Could not locate a nearest coordinate for the road-distance connector:", error);
          }
        }
        polygonVertices.forEach(xy => consider(xy, roadGeometry, "parcel"));
        roadVertices.forEach(xy => consider(xy, polygonGeometry, "road"));
        return best;
      }

      function renderNearestRoadGraphics(result) {
        // Ignore stale async results before touching shared layers.
        if (!result || currentSelectedResult !== result) return;
        nearestRoadLayer.removeAll();
        distanceMeasureLayer.removeAll();
        if (result.nearestRoadGeometry) {
          try { nearestRoadLayer.add(new Graphic({ geometry: toView(result.nearestRoadGeometry), symbol: {
            type: "simple-line", color: [186, 25, 117, 0.95], width: 2.7, style: "solid"
          } })); } catch (error) { console.warn("Could not draw the nearest road:", error); }
        }
        const connector = result.nearestRoadConnector;
        if (connector && connector.parcelXY && connector.roadXY) {
          const parcelPoint = new Point({ x: connector.parcelXY[0], y: connector.parcelXY[1], spatialReference: NATIVE_SR });
          const roadPoint = new Point({ x: connector.roadXY[0], y: connector.roadXY[1], spatialReference: NATIVE_SR });
          if (Number(result.roadDistanceM) > 0.01) {
            const link = new Polyline({ paths: [[connector.parcelXY, connector.roadXY]], spatialReference: NATIVE_SR });
            distanceMeasureLayer.add(new Graphic({ geometry: toView(link), symbol: {
              type: "simple-line", color: [255, 119, 0, 1], width: 4, style: "dash"
            } }));
          }
          distanceMeasureLayer.add(new Graphic({ geometry: toView(parcelPoint), symbol: {
            type: "simple-marker", color: [0, 120, 212, 1], size: 10, outline: { color: [255,255,255,1], width: 2 }
          } }));
          distanceMeasureLayer.add(new Graphic({ geometry: toView(roadPoint), symbol: {
            type: "simple-marker", color: [255, 119, 0, 1], size: 10, outline: { color: [255,255,255,1], width: 2 }
          } }));
          const labelPoint = new Point({
            x: (connector.parcelXY[0] + connector.roadXY[0]) / 2,
            y: (connector.parcelXY[1] + connector.roadXY[1]) / 2,
            spatialReference: NATIVE_SR
          });
          const label = "ROAD DISTANCE\n" + fmt(result.roadDistanceM || 0, 2) + " m";
          distanceMeasureLayer.add(new Graphic({ geometry: toView(labelPoint), symbol: {
            type: "text", text: label, color: "#7c2d12", haloColor: "#ffffff", haloSize: 4,
            horizontalAlignment: "center", verticalAlignment: "middle",
            font: { family: "Noto Sans", size: 12, weight: "bold" }
          } }));
        } else if (result.roadDistanceM != null && result.geom) {
          const projected = toView(result.geom);
          const anchor = projected && projected.extent ? projected.extent.center : projected;
          if (anchor) distanceMeasureLayer.add(new Graphic({ geometry: anchor, symbol: {
            type: "text", text: "ROAD DISTANCE: " + fmt(result.roadDistanceM, 2) + " m",
            color: "#7c2d12", haloColor: "#ffffff", haloSize: 4,
            horizontalAlignment: "center", verticalAlignment: "middle",
            font: { family: "Noto Sans", size: 12, weight: "bold" }
          } }));
        }
      }

      async function calculateNearestRoad(result) {
        if (!result || String(result.geom && result.geom.type || "").toLowerCase() !== "polygon") return;
        if (result.roadDistanceChecked) {
          renderNearestRoadGraphics(result);
          return;
        }
        result.roadDistanceChecked = true;
        result.roadDistanceM = null;
        result.nearestRoadName = null;
        result.nearestRoadGeometry = null;
        result.nearestRoadConnector = null;
        nearestRoadLayer.removeAll();
        distanceMeasureLayer.removeAll();
        try {
          if (!roadSearchReady) roadSearchReady = roadSearchLayer.load();
          await roadSearchReady;
          const selectedGeometry = asNativeGeometry(result.geom);
          // Start locally and progressively widen the search only if no road was found.
          let anyRoadQueryTruncated = false;
          for (const radius of [250, 1000, 3000, 10000, 25000]) {
            const buffers = geometryOps.buffer([selectedGeometry], radius, "meters", true);
            const searchArea = buffers && buffers[0];
            if (!searchArea) continue;
            const candidates = await fetchIntersecting(roadSearchLayer, searchArea, null, 2500);
            anyRoadQueryTruncated = anyRoadQueryTruncated || !!candidates.truncated;
            let bestDistance = Infinity;
            let bestFeature = null;
            for (const feature of candidates) {
              if (!feature.geometry) continue;
              try {
                const roadGeometry = asNativeGeometry(feature.geometry);
                const distance = geometryOps.planarDistance(selectedGeometry, roadGeometry);
                if (Number.isFinite(distance) && distance >= 0 && distance < bestDistance) {
                  bestDistance = distance;
                  bestFeature = feature;
                }
              } catch (distanceError) { console.warn("Skipping road candidate during distance analysis:", distanceError); }
            }
            if (bestFeature && Number.isFinite(bestDistance)) {
              result.roadDistanceM = +bestDistance.toFixed(3);
              result.nearestRoadGeometry = asNativeGeometry(bestFeature.geometry);
              result.nearestRoadName = String(getAttribute(bestFeature.attributes, ["name", "full_road_name", "road_name", "street_name"]) || "اسم الشارع غير متاح");
              result.nearestRoadObjectId = bestFeature.attributes && bestFeature.attributes[oid(roadSearchLayer)];
              result.roadSearchRadiusM = radius;
              result.roadDistanceMayBeIncomplete = anyRoadQueryTruncated;
              try { result.nearestRoadConnector = findNearestConnector(selectedGeometry, result.nearestRoadGeometry); }
              catch (connectorError) { console.warn("Could not calculate the visual nearest-road connector:", connectorError); }
              renderNearestRoadGraphics(result);
              return;
            }
            if (candidates.truncated) console.warn("Nearest-road candidate query reached its result limit at radius", radius);
          }
          result.roadDistanceNotFound = true;
          result.roadDistanceSearchMayBeIncomplete = anyRoadQueryTruncated;
          renderNearestRoadGraphics(result);
        } catch (error) {
          result.roadDistanceError = error.message || String(error);
          console.error("Nearest-road analysis failed:", error);
          renderNearestRoadGraphics(result);
        }
      }

      function drawLongestSideHighlights(result) {
        longestSidesLayer.removeAll();
        function addEdges(edges, color, maxCount) {
          (edges || []).slice().sort((a, b) => b.lengthM - a.lengthM).slice(0, maxCount || 5).forEach(edge => {
            if (!edge.from || !edge.to) return;
            try {
              const line = new Polyline({ paths: [[edge.from, edge.to]], spatialReference: NATIVE_SR });
              longestSidesLayer.add(new Graphic({ geometry: toView(line), symbol: {
                type: "simple-line", color: color, width: 4.5, style: "solid"
              } }));
            } catch (error) { console.warn("Could not highlight a longest side:", error); }
          });
        }
        if (result.shapefileEdges && result.shapefileEdges.length && result.layer !== uploadLayer) addEdges(uploadedShapefileEdges, [220, 38, 100, 1], 5);
        if (String(result.geom && result.geom.type || "").toLowerCase() === "polygon" && result.layer !== uploadLayer) addEdges(result.edges || [], [255, 145, 0, 1], 5);
        if (result.layer === uploadLayer) addEdges(result.edges || uploadedShapefileEdges, [220, 38, 100, 1], 5);
      }

      // ---------- Sketch drawing and coordinate readout ----------
      let lastSketchGraphic = null;
      function sketchVertices(geometry) {
        const type = String(geometry && geometry.type || "").toLowerCase();
        if (type === "point") return [{ group: "Point", xy: [geometry.x, geometry.y] }];
        if (type === "multipoint") return (geometry.points || []).map((xy, index) => ({ group: "Point", xy: xy, index: index + 1 }));
        const output = [];
        const groups = type === "polyline" ? (geometry.paths || []) : type === "polygon" ? (geometry.rings || []) : [];
        groups.forEach((group, groupIndex) => {
          let coords = Array.isArray(group) ? group.slice() : [];
          if (type === "polygon" && coords.length > 1) {
            const first = coords[0], last = coords[coords.length - 1];
            if (first[0] === last[0] && first[1] === last[1]) coords.pop();
          }
          coords.forEach((xy, index) => output.push({ group: (type === "polygon" ? "Ring " : "Path ") + (groupIndex + 1), xy: xy, index: index + 1 }));
        });
        return output;
      }

      async function renderSketchCoordinates(graphic) {
        const output = $("sketchCoordinates");
        if (!graphic || !graphic.geometry) {
          output.className = "coordinate-result";
          output.textContent = "ابدأ الرسم من شريط Sketch على الخريطة، وستظهر الإحداثيات هنا.";
          sketchMeasureLayer.removeAll();
          return;
        }
        lastSketchGraphic = graphic;
        output.className = "coordinate-result";
        output.textContent = "جاري تحويل إحداثيات الرسم إلى EPSG:4326 وEPSG:2193…";
        try {
          await projection.load();
          const geometry = graphic.geometry;
          const type = String(geometry.type || "").toLowerCase();
          const vertices = sketchVertices(geometry);
          if (!vertices.length) throw new Error("نوع الهندسة لا يحتوي على رؤوس قابلة لعرض الإحداثيات.");
          const shown = vertices.slice(0, 100);
          const table = document.createElement("table");
          const thead = document.createElement("thead");
          const header = document.createElement("tr");
          ["الرأس", "Longitude", "Latitude", "Easting (m)", "Northing (m)"].forEach(title => {
            const th = document.createElement("th"); th.textContent = title; header.appendChild(th);
          });
          thead.appendChild(header); table.appendChild(thead);
          const tbody = document.createElement("tbody");
          shown.forEach((vertex, vertexIndex) => {
            const point = new Point({ x: Number(vertex.xy[0]), y: Number(vertex.xy[1]), spatialReference: geometry.spatialReference || view.spatialReference });
            const wgsPoint = projection.project(point, WGS84_SR);
            const nztmPoint = projection.project(point, NATIVE_SR);
            if (!wgsPoint || !nztmPoint || !Number.isFinite(wgsPoint.x) || !Number.isFinite(wgsPoint.y) || !Number.isFinite(nztmPoint.x) || !Number.isFinite(nztmPoint.y)) return;
            const tr = document.createElement("tr");
            const label = vertex.group === "Point" ? (vertex.index || vertexIndex + 1) : vertex.group + " / " + vertex.index;
            [label, wgsPoint.x.toFixed(8), wgsPoint.y.toFixed(8), nztmPoint.x.toFixed(3), nztmPoint.y.toFixed(3)].forEach(value => {
              const td = document.createElement("td"); td.textContent = String(value); tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          output.replaceChildren();
          const heading = document.createElement("div");
          heading.className = "sketch-meta-heading";
          heading.textContent = "بيانات الرسم والإحداثيات";
          output.appendChild(heading);
          const metaGrid = document.createElement("div");
          metaGrid.className = "sketch-meta-grid";
          const typeLabel = type === "point" ? "نقطة" : type === "polyline" ? "خط" : type === "polygon" ? "مضلع" : type;
          function addMeta(label, value, direction) {
            const chip = document.createElement("div"); chip.className = "sketch-meta-chip";
            const caption = document.createElement("span"); caption.className = "meta-label"; caption.textContent = label;
            const valueNode = document.createElement("bdi"); valueNode.className = "meta-value"; valueNode.dir = direction || "auto"; valueNode.textContent = value;
            chip.append(caption, valueNode); metaGrid.appendChild(chip);
          }
          addMeta("نوع الرسم", typeLabel, "rtl");
          addMeta("عدد الرؤوس", vertices.length.toLocaleString("en-US"), "ltr");
          addMeta("WGS84", "EPSG:4326 · Longitude / Latitude", "ltr");
          addMeta("نظام القياس", "EPSG:2193 · metres", "ltr");
          output.appendChild(metaGrid);
          if (vertices.length > shown.length) {
            const note = document.createElement("div"); note.className = "map-analysis-note"; note.textContent = "تم عرض أول 100 رأس فقط من أصل " + vertices.length.toLocaleString("en-US") + "."; output.appendChild(note);
          }
          sketchMeasureLayer.removeAll();
          if (type === "polyline") {
            const native = asNativeGeometry(geometry);
            const lengthM = Math.abs(geometryOps.planarLength(native, "meters"));
            const measure = document.createElement("div"); measure.className = "sketch-measurement"; measure.dir = "rtl";
            const lengthLabel = document.createElement("span"); lengthLabel.textContent = "طول الخط: ";
            const lengthValue = document.createElement("bdi"); lengthValue.dir = "ltr"; lengthValue.textContent = fmt(lengthM, 2) + " m";
            const crsNote = document.createElement("span"); crsNote.textContent = " · نظام القياس: EPSG:2193";
            measure.append(lengthLabel, lengthValue, crsNote); output.appendChild(measure);
            const projectedGeometry = toView(native);
            const anchor = projectedGeometry && projectedGeometry.extent ? projectedGeometry.extent.center : null;
            if (anchor) sketchMeasureLayer.add(new Graphic({ geometry: anchor, symbol: {
              type: "text", text: "LENGTH: " + fmt(lengthM, 2) + " m", color: "#064e3b", haloColor: "#ffffff", haloSize: 4,
              horizontalAlignment: "center", verticalAlignment: "middle", font: { family: "Arial", size: 12, weight: "bold" }
            } }));
          } else if (type === "polygon") {
            const native = asNativeGeometry(geometry);
            const areaM2 = Math.abs(geometryOps.planarArea(native, "square-meters"));
            const perimeterM = Math.abs(geometryOps.planarLength(native, "meters"));
            const measure = document.createElement("div"); measure.className = "sketch-measurement"; measure.dir = "rtl";
            const areaLabel = document.createElement("span"); areaLabel.textContent = "المساحة: ";
            const areaValue = document.createElement("bdi"); areaValue.dir = "ltr"; areaValue.textContent = fmt(areaM2, 2) + " m²";
            const perimeterLabel = document.createElement("span"); perimeterLabel.textContent = " · المحيط: ";
            const perimeterValue = document.createElement("bdi"); perimeterValue.dir = "ltr"; perimeterValue.textContent = fmt(perimeterM, 2) + " m";
            measure.append(areaLabel, areaValue, perimeterLabel, perimeterValue); output.appendChild(measure);
            const projectedGeometry = toView(native);
            const anchor = projectedGeometry && projectedGeometry.extent ? projectedGeometry.extent.center : null;
            if (anchor) sketchMeasureLayer.add(new Graphic({ geometry: anchor, symbol: {
              type: "text", text: "AREA: " + fmt(areaM2, 2) + " m²", color: "#064e3b", haloColor: "#ffffff", haloSize: 4,
              horizontalAlignment: "center", verticalAlignment: "middle", font: { family: "Arial", size: 12, weight: "bold" }
            } }));
          }
          output.appendChild(table);
        } catch (error) {
          console.error("Sketch coordinate projection failed:", error);
          output.textContent = "تعذر عرض إحداثيات الرسم: " + (error.message || error);
        }
      }

      sketchWidget = new Sketch({ view: view, layer: sketchLayer, creationMode: "update", layout: "vertical" });
      view.ui.add(sketchWidget, "top-left");
      sketchWidget.on("create", event => {
        if (event.state === "start") sketchMeasureLayer.removeAll();
        if (event.state === "start" || event.state === "active") sketchDrawingActive = true;
        if (event.state === "complete") {
          sketchDrawingActive = false;
          sketchSuppressClicksUntil = Date.now() + 500;
          renderSketchCoordinates(event.graphic);
          if (String(event.graphic && event.graphic.geometry && event.graphic.geometry.type || "").toLowerCase() === "polygon") {
            analyseSketchPolygon(event.graphic);
          }
        } else if (event.state === "cancel") sketchDrawingActive = false;
      });
      sketchWidget.on("update", event => {
        if (event.state === "start") sketchMeasureLayer.removeAll();
        if (event.state === "start" || event.state === "active") sketchDrawingActive = true;
        if (event.state === "complete") {
          sketchDrawingActive = false;
          sketchSuppressClicksUntil = Date.now() + 500;
          const graphic = event.graphics && event.graphics.length ? event.graphics[0] : lastSketchGraphic;
          renderSketchCoordinates(graphic);
          if (String(graphic && graphic.geometry && graphic.geometry.type || "").toLowerCase() === "polygon") {
            analyseSketchPolygon(graphic);
          }
        } else if (event.state === "cancel") sketchDrawingActive = false;
      });
      sketchWidget.on("delete", () => {
        if (!sketchLayer.graphics.length) {
          lastSketchGraphic = null;
          renderSketchCoordinates(null);
          if (activeGeometryAnalysisSource === "Sketch") {
            areaAnalysisRequestId++;
            activeGeometryAnalysisSource = null;
            clearGeometryAnalysisVisuals(true);
          }
        } else {
          const remaining = sketchLayer.graphics.getItemAt(sketchLayer.graphics.length - 1);
          renderSketchCoordinates(remaining);
          if (String(remaining && remaining.geometry && remaining.geometry.type || "").toLowerCase() === "polygon") analyseSketchPolygon(remaining);
        }
      });
      $("drawSketchLineBtn").addEventListener("click", () => {
        sketchMeasureLayer.removeAll();
        sketchWidget.create("polyline");
        status("ارسم الخط بالنقر على نقاط البداية والمرور، ثم انقر مرتين لإنهائه. سيظهر طول الخط على الخريطة وبالإحداثيات.", "ok");
      });
      $("clearSketchBtn").addEventListener("click", () => {
        sketchLayer.removeAll();
        sketchMeasureLayer.removeAll();
        lastSketchGraphic = null;
        sketchDrawingActive = false;
        renderSketchCoordinates(null);
        if (activeGeometryAnalysisSource === "Sketch") {
          areaAnalysisRequestId++;
          activeGeometryAnalysisSource = null;
          clearGeometryAnalysisVisuals(true);
        }
        status("تم مسح رسومات Sketch والإحداثيات فقط.", "ok");
      });

      // ---------- 1) Autocomplete للمنطقة الإدارية + معلومات المنطقة بالاستعلام ----------
      async function loadDistricts() {
        await roads.load();
        const items = await distinct(roads, F_AREA);
        const dl = $("areaList"); dl.replaceChildren();
        items.forEach(i => { const o = document.createElement("option"); o.value = i.value; dl.appendChild(o); });
        areaInput.disabled = false;
        return items.map(i => i.value);
      }
      async function onDistrictChosen(name) {
        const req = ++districtReq;
        setOptions(localitySel, [], "جاري التحميل…"); localitySel.disabled = true;
        setOptions(roadSel, [], "اختر المحلية أولًا"); roadSel.disabled = true;
        const where = whereArea(name);
        roads.definitionExpression = where;
        const [count, ext, locs] = await Promise.all([
          roads.queryFeatureCount({ where }),
          roads.queryExtent({ where }),
          distinct(roads, F_LOC, where)
        ]);
        if (req !== districtReq) return;
        const box = $("districtInfo"); box.style.display = "block";
        box.textContent = "المنطقة: " + name + " — عدد مقاطع الطرق: " + Number(count).toLocaleString("en-US") + " — عدد المحليات: " + locs.length;
        if (ext && ext.extent) view.goTo(ext.extent.expand(1.1)).catch(() => {});
        setOptions(localitySel, locs, locs.length ? "اختر المحلية" : "لا توجد محليات");
        localitySel.disabled = !locs.length;
        context.district = name;
        status("تم تحميل بيانات المنطقة " + name + ".", "ok");
      }
      let knownDistricts = [];
      areaInput.addEventListener("input", () => {
        const m = knownDistricts.find(d => d.toLowerCase() === areaInput.value.trim().toLowerCase());
        if (m) onDistrictChosen(m);
      });
      localitySel.addEventListener("change", async () => {
        const req = ++localityReq;
        setOptions(roadSel, [], "جاري التحميل…"); roadSel.disabled = true;
        if (!localitySel.value) { setOptions(roadSel, [], "اختر المحلية أولًا"); return; }
        const where = and(whereArea(areaInput.value.trim()), whereLoc(localitySel.value));
        roads.definitionExpression = where;
        const items = await distinct(roads, F_ROAD, where);
        if (req !== localityReq) return;
        setOptions(roadSel, items, items.length ? "اختر الشارع" : "لا توجد طرق");
        roadSel.disabled = !items.length;
      });

      async function analyse(area, label, extra) {
        const runId = ++analysisRunId;
        const which = layerSel.value;
        const layers = which === "both" ? [["ORC Properties", props], ["LINZ Parcels", parcels]]
          : which === "0" ? [["ORC Properties", props]] : [["LINZ Parcels", parcels]];
        const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));
        analysisWasTruncated = false;
        // Do not fetch every address in a large analysis area. Address points are queried
        // lazily only for the parcel/property currently selected by the user.
        analysisAddressFeatures = [];
        const queryAreaM2 = extra && extra.measureOverlap
          ? Math.abs(geometryOps.planarArea(asNativeGeometry(area), "square-meters")) : null;
        status("جاري تحليل العناصر المتقاطعة…");
        setExportActionsEnabled(false);
        results = [];
        for (const [name, layer] of layers) {
          status("جاري جلب " + name + " داخل النطاق المكاني…");
          const feats = await fetchIntersecting(layer, area, count =>
            status("جاري جلب " + name + "… تم استلام " + count.toLocaleString("en-US") + " عنصر")
          );
          if (runId !== analysisRunId) return;
          analysisWasTruncated = analysisWasTruncated || !!feats.truncated;

          for (let index = 0; index < feats.length; index++) {
            const f = feats[index];
            const g = f.geometry;
            if (!g) continue;
            // Do not calculate every side of every parcel during the query. That was the
            // main-thread hotspot: side lengths are calculated only when a parcel is picked
            // or when the user explicitly exports the full analysis.
            const r = {
              layerName: name, layer, feature: f, geom: g, objectId: f.attributes[oid(layer)],
              areaM2: null, perimeterM: null, edges: null, addresses: null,
              manualDimensions: [], fromAnalysis: true, analysisCrs: "EPSG:2193"
            };
            if (extra && extra.measureOverlap) {
              const nativeFeatureGeometry = asNativeGeometry(g);
              const intersection = geometryOps.intersect(asNativeGeometry(area), nativeFeatureGeometry);
              const overlap = intersection && String(intersection.type || "").toLowerCase() === "polygon"
                ? Math.abs(geometryOps.planarArea(intersection, "square-meters")) : 0;
              const featureArea = Math.abs(geometryOps.planarArea(nativeFeatureGeometry, "square-meters"));
              r.overlapM2 = Number.isFinite(overlap) ? overlap : 0;
              r.overlapGeometry = intersection || null;
              r.areaM2 = Number.isFinite(featureArea) ? featureArea : null;
              r.overlapPercentOfFeature = r.areaM2 > 0 ? +(r.overlapM2 / r.areaM2 * 100).toFixed(4) : 0;
              r.overlapPercentOfQuery = Number.isFinite(queryAreaM2) && queryAreaM2 > 0
                ? +(r.overlapM2 / queryAreaM2 * 100).toFixed(4) : 0;
              r.overlapCrs = "EPSG:2193";
              r.overlapQueryLabel = extra.overlapQueryLabel || (label === "shapefile" ? "Shapefile" : "نطاق التحليل");
              r.shapefileEdges = label === "shapefile" ? uploadedShapefileEdges.slice().sort((a, b) => b.lengthM - a.lengthM).slice(0, 5)
                .map(edge => ({ n: edge.n, ring: edge.ring, lengthM: edge.lengthM })) : [];
            }
            results.push(r);
            if ((index + 1) % 50 === 0) {
              status("جاري تحليل " + name + "… " + (index + 1).toLocaleString("en-US") + " / " + feats.length.toLocaleString("en-US"));
              await yieldToBrowser();
              if (runId !== analysisRunId) return;
            }
          }
        }
        if (runId !== analysisRunId) return;
        results.sort((a, b) => (b.overlapM2 || 0) - (a.overlapM2 || 0) || a.layerName.localeCompare(b.layerName));
        resultsLayer.removeAll();
        const maxDrawn = Math.min(results.length, 600);
        resultsLayer.addMany(results.slice(0, maxDrawn).map(r => new Graphic({ geometry: toView(r.geom),
          symbol: { type: "simple-fill", color: [25,160,214,0.18], outline: { color: [0,125,218,0.9], width: 1.3 } } })));
        setOptions(resultSel, results, results.length ? "اختر نتيجة (" + results.length + ")" : "لا توجد نتائج",
          r => "[" + r.layerName + "] " + labelOf(r) + (r.overlapM2 != null
            ? " — تقاطع " + fmt(r.overlapM2, 1) + " م² (" + fmt(r.overlapPercentOfFeature || 0, 1) + "% من القطعة)" : ""));
        resultSel.disabled = !results.length; setExportActionsEnabled(results.length > 0);
        context.mode = label;
        context.resultCount = results.length;
        context.queryTruncated = analysisWasTruncated;
        if (extra && extra.measureOverlap) renderAreaQueryAnalysis(label, queryAreaM2, results, analysisWasTruncated);
        const box = $("summary"); box.style.display = "block";
        box.textContent = "عدد الكيانات المتقاطعة: " + results.length.toLocaleString("en-US") +
          (extra && extra.measureOverlap ? " | مساحة التقاطع ونسبته محسوبتان في EPSG:2193 بالمتر المربع" : " | يتم حساب المساحة والأضلاع عند اختيار العنصر فقط") +
          (results.length > maxDrawn ? " | يتم رسم أول " + maxDrawn.toLocaleString("en-US") + " نتيجة لتجنب بطء الخريطة" : "");
        const truncationMessage = analysisWasTruncated
          ? " تنبيه: تم الوصول لحد النتائج التفاعلية (" + MAX_QUERY_FEATURES.toLocaleString("en-US") + "). قلل النطاق أو اختر طريقًا/محلية أصغر للحصول على تحليل كامل."
          : "";
        status((results.length ? "تم تحديد " + results.length + " نتيجة بالتقاطع الهندسي. اختر قطعة لتحميل قياساتها وعناوينها." : "لا توجد كيانات تتقاطع مع هذه المنطقة.") + truncationMessage,
          results.length && !analysisWasTruncated ? "ok" : (results.length ? "error" : "error"));
      }
      function labelOf(r) {
        const a = r.feature && r.feature.attributes || {};
        const get = k => { const key = Object.keys(a).find(x => x.toLowerCase() === k.toLowerCase()); return key ? a[key] : null; };
        if (r.layer === props) return ([get("HouseNumber"), get("StreetName")].filter(Boolean).join(" ") || "عقار") + " #" + (get("PropertyID") ?? r.objectId ?? "غير معروف");
        if (r.layer === addresses) return get("full_address") || get("full_road_name") || ("عنوان #" + (r.objectId ?? "غير معروف"));
        if (r.layer === roads) return (get("name") || "طريق") + " — " + (get("locality") || "") + " #" + (r.objectId ?? "غير معروف");
        return (get("appellation") || get("full_address") || "قطعة") + " (ID " + (get("id") ?? r.objectId ?? "غير معروف") + ")";
      }

      function ensureMeasurements(r) {
        const type = String(r.geom && r.geom.type || "").toLowerCase();
        if (!Array.isArray(r.edges)) r.edges = (type === "polygon" || type === "polyline") ? edgesOf(r.geom) : [];
        if (r.areaM2 == null) r.areaM2 = type === "polygon" ? Math.abs(geometryOps.planarArea(r.geom, "square-meters")) : 0;
        if (r.perimeterM == null) {
          r.perimeterM = type === "polygon" ? r.edges.reduce((sum, edge) => sum + edge.lengthM, 0)
            : type === "polyline" ? Math.abs(geometryOps.planarLength(r.geom, "meters")) : 0;
        }
        if (!Array.isArray(r.manualDimensions)) r.manualDimensions = [];
        return r;
      }

      function refreshResultsDropdown() {
        setOptions(resultSel, results, results.length ? "اختر نتيجة (" + results.length + ")" : "لا توجد نتائج",
          r => "[" + r.layerName + "] " + labelOf(r) + (r.overlapM2 != null
            ? " — تقاطع " + fmt(r.overlapM2, 1) + " م² (" + fmt(r.overlapPercentOfFeature || 0, 1) + "% من القطعة)" : ""));
        resultSel.disabled = !results.length;
        setExportActionsEnabled(results.length > 0);
      }

      function registerMapFeature(graphic, layer) {
        layer = layer || (graphic && graphic.layer);
        if (!graphic || !graphic.geometry || !layer) return null;
        const attributes = graphic.attributes || {};
        const objectId = attributes[oid(layer)] ?? attributes.OBJECTID ?? attributes.objectid ?? null;
        let normalizedGeometry = graphic.geometry;
        try {
          const wkid = normalizedGeometry.spatialReference && normalizedGeometry.spatialReference.wkid;
          if (wkid && wkid !== NATIVE_SR.wkid) normalizedGeometry = to2193(normalizedGeometry) || normalizedGeometry;
        } catch (projectionError) { console.warn("Could not normalize clicked feature geometry:", projectionError); }
        let result = objectId == null ? null : results.find(item => item.layer === layer && String(item.objectId) === String(objectId));
        if (!result) {
          const type = String(normalizedGeometry.type || "").toLowerCase();
          result = {
            layerName: titleForLayer(layer), layer: layer,
            feature: { attributes: attributes, geometry: normalizedGeometry },
            geom: normalizedGeometry, objectId: objectId,
            geometryType: type, areaM2: null, perimeterM: null, edges: null, addresses: null,
            manualDimensions: [], fromAnalysis: false
          };
          results.push(result);
          refreshResultsDropdown();
        }
        const index = results.indexOf(result);
        if (index >= 0) resultSel.value = String(index);
        setExportActionsEnabled(results.length > 0);
        return result;
      }

      function renderManualDimensions(result) {
        const info = $("selectedFeatureInfo");
        const list = $("manualDimensionsList");
        const addBtn = $("addDimensionBtn");
        const nameInput = $("dimensionNameInput");
        const valueInput = $("dimensionValueInput");
        list.replaceChildren();
        if (!result) {
          info.textContent = "اختَر قطعة أرض أو خطًا أو نقطة من الخريطة أولًا.";
          addBtn.disabled = true; nameInput.disabled = true; valueInput.disabled = true;
          list.textContent = "لا توجد أبعاد يدوية بعد.";
          list.className = "manual-dimensions empty";
          return;
        }
        const type = String(result.geom && result.geom.type || "unknown").toLowerCase();
        info.textContent = "العنصر المحدد: " + labelOf(result) + " — النوع: " + type + " — الأبعاد التي تضيفها ستُحفظ مع العنصر المحدد.";
        addBtn.disabled = false; nameInput.disabled = false; valueInput.disabled = false;
        nameInput.placeholder = type === "polygon" ? "مثال: ضلع يدوي إضافي" : (type === "polyline" ? "مثال: طول مقاس يدويًا" : "اسم البعد المخصص");
        if (!result.manualDimensions || !result.manualDimensions.length) {
          list.textContent = "لا توجد أبعاد يدوية بعد.";
          list.className = "manual-dimensions empty";
          return;
        }
        list.className = "manual-dimensions";
        result.manualDimensions.forEach((dim, index) => {
          const row = document.createElement("div"); row.className = "manual-dimension-row";
          const label = document.createElement("span"); label.textContent = dim.label + ": " + fmt(dim.valueM, 3) + " م";
          const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary remove-dimension"; remove.textContent = "حذف";
          remove.addEventListener("click", () => {
            result.manualDimensions.splice(index, 1);
            renderManualDimensions(result); refreshSelectedPopup(result);
          });
          row.append(label, remove); list.appendChild(row);
        });
      }

      function renderMapAnalysisSummary(result) {
        const panel = $("mapAnalysisBadge");
        const body = $("mapAnalysisBody");
        if (!result || currentSelectedResult !== result) {
          panel.hidden = true;
          body.replaceChildren();
          syncAnalysisDashboard();
          return;
        }
        panel.hidden = false;
        syncAnalysisDashboard("selection");
        body.replaceChildren();
        function addRow(label, value, emphasis) {
          const row = document.createElement("div"); row.className = "map-analysis-row" + (emphasis ? " emphasis" : "");
          const name = document.createElement("span"); name.className = "map-analysis-label"; name.textContent = label;
          const val = document.createElement("strong"); val.className = "map-analysis-value"; val.textContent = value;
          if (/^[\d,.%+\- ]/.test(value) || / m(?:²)?$/.test(value)) { val.dir = "ltr"; val.style.unicodeBidi = "isolate"; }
          row.append(name, val); body.appendChild(row);
        }
        if (result.overlapM2 != null) {
          addRow("نسبة التقاطع من مساحة القطعة",
            fmt(result.overlapPercentOfFeature == null ? 0 : result.overlapPercentOfFeature, 2) + "%", true);
          if (result.overlapPercentOfQuery != null) {
            addRow("النسبة من مساحة " + (result.overlapQueryLabel || "نطاق التحليل"),
              fmt(result.overlapPercentOfQuery, 2) + "%");
          }
          addRow("مساحة التقاطع", fmt(result.overlapM2, 2) + " m²");
        }
        const summaries = Array.isArray(result.layerOverlapSummary) ? result.layerOverlapSummary : [];
        if (summaries.length) {
          summaries.forEach(summary => addRow(summary.layerName,
            String(summary.count || 0) + " عنصر متقاطع" + (summary.truncated ? " (جزئي)" : "")));
          const top = summaries.flatMap(summary => (summary.matches || []).map(match => Object.assign({ sourceLayer: summary.layerName }, match)))
            .filter(match => Number.isFinite(Number(match.selectedPercent)))
            .sort((a, b) => Number(b.selectedPercent) - Number(a.selectedPercent))[0];
          if (top) {
            addRow("أكبر تقاطع من مساحة القطعة", fmt(top.selectedPercent, 2) + "%", true);
            if (top.otherPercent != null) addRow("من مساحة العنصر المقابل", fmt(top.otherPercent, 2) + "%");
          } else if (result.layerOverlapChecked) addRow("نسبة التقاطع مع الطبقات", "لا يوجد تقاطع مساحي", false);
        } else if (result.layerOverlapError) {
          addRow("تحليل الطبقات", "تعذر الإكمال");
        } else if (String(result.geom && result.geom.type || "").toLowerCase() === "polygon") {
          addRow("التقاطع مع الطبقات", "جاري الحساب…");
        }
        if (result.roadDistanceM != null) {
          addRow("أقرب شارع", result.nearestRoadName || "اسم غير متاح");
          addRow(result.roadDistanceMayBeIncomplete ? "المسافة المرشحة للشارع" : "المسافة للشارع", fmt(result.roadDistanceM, 2) + " m", true);
          if (result.roadDistanceMayBeIncomplete) addRow("جودة البحث", "وصل البحث إلى حد النتائج؛ تحقق من النتيجة قبل اعتمادها.");
        } else if (result.roadDistanceChecked && result.roadDistanceError) {
          addRow("المسافة للشارع", "تعذر الحساب");
        } else if (result.roadDistanceNotFound && result.roadDistanceSearchMayBeIncomplete) {
          addRow("المسافة للشارع", "تعذر تأكيد أقرب شارع؛ وصل البحث إلى حد النتائج.");
        } else if (result.roadDistanceNotFound) {
          addRow("المسافة للشارع", "لم يُعثر على شارع داخل 25 كم");
        } else if (String(result.geom && result.geom.type || "").toLowerCase() === "polygon") {
          addRow("المسافة للشارع", "جاري الحساب…");
        }
      }

      let activeGeometryAnalysisSource = null;

      function addAnalysisBadgeRow(body, label, value, options) {
        options = options || {};
        const row = document.createElement("div");
        row.className = "map-analysis-row" + (options.emphasis ? " emphasis" : "") +
          (options.compact ? " compact" : "") + (options.featureOverlap ? " feature-overlap" : "");
        const name = document.createElement("span"); name.className = "map-analysis-label"; name.textContent = label;
        const val = document.createElement("strong"); val.className = "map-analysis-value"; val.textContent = value;
        if (options.ltr) { val.dir = "ltr"; val.style.unicodeBidi = "isolate"; }
        row.append(name, val); body.appendChild(row);
        return row;
      }

      function edgeKey(edge) {
        const pointKey = point => Number(point[0]).toFixed(3) + "," + Number(point[1]).toFixed(3);
        const a = pointKey(edge.from), b = pointKey(edge.to);
        return a < b ? a + "|" + b : b + "|" + a;
      }

      function uniqueEdgesForDisplay(edges) {
        const seen = new Set();
        return (edges || []).filter(edge => {
          if (!edge || !edge.from || !edge.to) return false;
          const key = edgeKey(edge);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      function renderShapefileSideSummary() {
        const panel = $("shapefileAnalysisBadge");
        const body = $("shapefileAnalysisBody");
        body.replaceChildren();
        if (!uploadedShapefileGeometry || !uploadedShapefileEdges.length) { panel.hidden = true; syncAnalysisDashboard(); return; }
        panel.hidden = false;
        syncAnalysisDashboard("shapefile");
        const displayEdges = uniqueEdgesForDisplay(uploadedShapefileEdges);
        const perimeter = displayEdges.reduce((sum, edge) => sum + Number(edge.lengthM || 0), 0);
        addAnalysisBadgeRow(body, "عدد الأضلاع الفريدة", displayEdges.length.toLocaleString("en-US"), { emphasis: true, ltr: true });
        addAnalysisBadgeRow(body, "إجمالي أطوال الأضلاع الفريدة", fmt(perimeter, 2) + " m", { ltr: true });
        const rankedEdges = displayEdges.slice().sort((a, b) => b.lengthM - a.lengthM);
        const heading = document.createElement("div"); heading.className = "map-analysis-note";
        heading.textContent = "أطول 5 أضلاع — انقر على أي ضلع لإبرازه؛ جميع الأطوال متاحة أدناه."; body.appendChild(heading);
        function addInteractiveEdgeRow(edge, container) {
          const row = addAnalysisBadgeRow(container, "ضلع S-" + edge.n + (edge.ring ? " · الحلقة " + edge.ring : ""), fmt(edge.lengthM, 2) + " m", { compact: true, ltr: true });
          row.classList.add("interactive-measure-row");
          row.title = "انقر لإبراز هذا الضلع على الخريطة";
          row.tabIndex = 0;
          row.setAttribute("role", "button");
          const highlightSide = () => {
            longestSidesLayer.removeAll();
            const line = new Polyline({ paths: [[edge.from, edge.to]], spatialReference: NATIVE_SR });
            longestSidesLayer.add(new Graphic({ geometry: toView(line), symbol: { type: "simple-line", color: [255, 123, 0, 1], width: 6 } }));
            status("تم إبراز الضلع S-" + edge.n + " بطول " + fmt(edge.lengthM, 2) + " متر.", "ok");
          };
          row.addEventListener("click", highlightSide);
          row.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); highlightSide(); } });
          return row;
        }
        rankedEdges.slice(0, 5).forEach(edge => addInteractiveEdgeRow(edge, body));
        const allEdgesDetails = document.createElement("details");
        allEdgesDetails.className = "all-shapefile-edges";
        const allEdgesSummary = document.createElement("summary");
        allEdgesSummary.textContent = "عرض جميع الأضلاع (" + displayEdges.length.toLocaleString("en-US") + ")";
        const allEdgesList = document.createElement("div");
        allEdgesList.className = "all-shapefile-edges-list";
        allEdgesDetails.append(allEdgesSummary, allEdgesList);
        allEdgesDetails.addEventListener("toggle", () => {
          if (!allEdgesDetails.open || allEdgesDetails.dataset.loaded === "true") return;
          rankedEdges.forEach(edge => addInteractiveEdgeRow(edge, allEdgesList));
          allEdgesDetails.dataset.loaded = "true";
        });
        body.appendChild(allEdgesDetails);
        const note = document.createElement("div"); note.className = "map-analysis-note";
        note.textContent = showAllSideLabels
          ? "تظهر تسميات جميع الأضلاع الفريدة على الخريطة. تمت إزالة التكرار الهندسي للأضلاع المشتركة."
          : "الخريطة تعرض أطول خمسة أضلاع فقط حاليًا. فعّل خيار إظهار جميع الأضلاع لرؤية بقية التسميات.";
        body.appendChild(note);
      }

      function clearGeometryAnalysisVisuals(hideBadge) {
        geometryAnalysisLayer.removeAll();
        geometryAnalysisLabelsLayer.removeAll();
        if (hideBadge !== false) {
          $("geometryAnalysisBadge").hidden = true;
          $("geometryAnalysisBody").replaceChildren();
          syncAnalysisDashboard();
        }
      }

      function drawGeometryAnalysisGraphics(matches) {
        geometryAnalysisLayer.removeAll();
        geometryAnalysisLabelsLayer.removeAll();
        const ranked = (matches || []).filter(match => match && Number(match.overlapM2) > 0)
          .slice().sort((a, b) => Number(b.overlapM2) - Number(a.overlapM2));
        ranked.slice(0, 80).forEach(match => {
          if (!match.intersectionGeometry) return;
          try {
            const displayGeometry = toView(match.intersectionGeometry);
            if (!displayGeometry) return;
            geometryAnalysisLayer.add(new Graphic({ geometry: displayGeometry, symbol: {
              type: "simple-fill", color: [255, 145, 0, 0.18], outline: { color: [210, 91, 0, 0.95], width: 1.2 }
            } }));
          } catch (error) { console.warn("Could not draw analysis intersection:", error); }
        });
        // Percent labels on the most significant overlapping features remain legible without
        // flooding the map when an uploaded geometry contains hundreds of parcels.
        const usedLabelAnchors = new Set();
        ranked.slice(0, 28).forEach(match => {
          if (!match.geometry || !Number.isFinite(Number(match.selectedPercent))) return;
          try {
            // Anchor the percentage label on the actual intersecting area, not the full
            // source feature: a large property may extend far away from the sketched polygon.
            const labelGeometry = asNativeGeometry(match.intersectionGeometry || match.geometry);
            const anchor = labelGeometry && (labelGeometry.centroid || (labelGeometry.extent && labelGeometry.extent.center));
            const displayAnchor = anchor && toView(anchor);
            if (!displayAnchor) return;
            const anchorKey = Number(anchor.x).toFixed(1) + "," + Number(anchor.y).toFixed(1);
            if (usedLabelAnchors.has(anchorKey)) return;
            usedLabelAnchors.add(anchorKey);
            const inputLabel = activeGeometryAnalysisSource === "Sketch" ? "من مساحة الرسم" :
              (activeGeometryAnalysisSource === "shapefile" ? "من مساحة Shapefile" : "من مساحة النطاق");
            geometryAnalysisLabelsLayer.add(new Graphic({ geometry: displayAnchor, symbol: {
              type: "text", text: "من مساحة العنصر: " + fmt(Number(match.selectedPercent), 1) + "%\n" + inputLabel + ": " + fmt(Number(match.otherPercent) || 0, 1) + "%", color: "#075985",
              haloColor: "#ffffff", haloSize: 4, horizontalAlignment: "center", verticalAlignment: "middle",
              font: { family: "Arial", size: 9, weight: "bold" }
            } }));
          } catch (error) { console.warn("Could not draw overlap percentage label:", error); }
        });
      }

      function renderGeometryAnalysisSummary(title, areaM2, matches, layerCounts, truncated, noteText) {
        const panel = $("geometryAnalysisBadge");
        const body = $("geometryAnalysisBody");
        $("geometryAnalysisTitle").textContent = title;
        body.replaceChildren();
        panel.hidden = false;
        syncAnalysisDashboard("overlap");
        addAnalysisBadgeRow(body, "مساحة الشكل", fmt(Number(areaM2) || 0, 2) + " m²", { emphasis: true, ltr: true });
        addAnalysisBadgeRow(body, "عدد العناصر ذات التقاطع المساحي", (matches || []).length.toLocaleString("en-US"), { ltr: true });
        (layerCounts || []).forEach(summary => {
          addAnalysisBadgeRow(body, summary.layerName,
            Number(summary.count || 0).toLocaleString("en-US") + " عناصر" + (summary.truncated ? " (نتائج جزئية)" : ""), { compact: true, ltr: true });
        });
        const ranked = (matches || []).slice().sort((a, b) => Number(b.overlapM2 || 0) - Number(a.overlapM2 || 0)).slice(0, 6);
        if (ranked.length) {
          const heading = document.createElement("div"); heading.className = "map-analysis-note";
          heading.textContent = "النسبة الأولى = مساحة التقاطع ÷ مساحة عنصر الطبقة × 100. النسبة الثانية = مساحة التقاطع ÷ مساحة الشكل المرسوم أو Shapefile × 100. قد تختلف النسبتان لأن مساحة كل عنصر مختلفة."; body.appendChild(heading);
          ranked.forEach(match => {
            const label = String(match.label || match.layerName || "عنصر متقاطع");
            const inputName = activeGeometryAnalysisSource === "Sketch" ? "الرسم" : activeGeometryAnalysisSource === "shapefile" ? "Shapefile" : "النطاق";
            const value = fmt(Number(match.selectedPercent) || 0, 2) + "% من مساحة العنصر | " + fmt(Number(match.otherPercent) || 0, 2) + "% من مساحة " + inputName;
            const row = addAnalysisBadgeRow(body, label.length > 54 ? label.slice(0, 51) + "…" : label, value,
              { featureOverlap: true, compact: true, ltr: true });
            row.title = label;
          });
        } else {
          addAnalysisBadgeRow(body, "النتيجة", "لا يوجد تقاطع مساحي موجب ضمن الطبقات التي تم فحصها.", { compact: true });
        }
        if (truncated) {
          const note = document.createElement("div"); note.className = "map-analysis-note";
          note.textContent = "تنبيه: وصل استعلام طبقة واحدة إلى حد النتائج؛ قد لا تشمل النسب كل العناصر."; body.appendChild(note);
        }
        if (noteText) {
          const note = document.createElement("div"); note.className = "map-analysis-note"; note.textContent = noteText; body.appendChild(note);
        }
      }

      async function analyseSketchPolygon(graphic) {
        const requestId = ++areaAnalysisRequestId;
        const geometryType = String(graphic && graphic.geometry && graphic.geometry.type || "").toLowerCase();
        if (geometryType !== "polygon") {
          if (activeGeometryAnalysisSource === "Sketch") {
            activeGeometryAnalysisSource = null;
            clearGeometryAnalysisVisuals(true);
          }
          return;
        }
        clearGeometryAnalysisVisuals(false);
        $("geometryAnalysisBadge").hidden = false;
        syncAnalysisDashboard("overlap");
        $("geometryAnalysisTitle").textContent = "جاري حساب نسب التقاطع للرسم…";
        $("geometryAnalysisBody").replaceChildren();
        try {
          await projection.load();
          const shape = asNativeGeometry(graphic.geometry);
          const shapeAreaM2 = Math.abs(geometryOps.planarArea(shape, "square-meters"));
          if (!Number.isFinite(shapeAreaM2) || shapeAreaM2 <= 0) throw new Error("مساحة المضلع غير صالحة.");
          const targetLayers = [["ORC Properties", props], ["LINZ Primary Parcels", parcels]];
          const matches = [];
          const layerCounts = [];
          let truncated = false;
          for (const [layerName, layer] of targetLayers) {
            const candidates = await fetchIntersecting(layer, shape, null, 1500);
            truncated = truncated || !!candidates.truncated;
            let layerMatchCount = 0;
            for (const feature of candidates) {
              if (!feature.geometry) continue;
              try {
                const featureGeometry = asNativeGeometry(feature.geometry);
                const intersectionGeometry = geometryOps.intersect(shape, featureGeometry);
                if (!intersectionGeometry || String(intersectionGeometry.type || "").toLowerCase() !== "polygon") continue;
                const overlapM2 = Math.abs(geometryOps.planarArea(intersectionGeometry, "square-meters"));
                if (!Number.isFinite(overlapM2) || overlapM2 <= 0.01) continue;
                const featureArea = Math.abs(geometryOps.planarArea(featureGeometry, "square-meters"));
                const objectId = feature.attributes && feature.attributes[oid(layer)];
                const percentOfFeature = Number.isFinite(featureArea) && featureArea > 0 ? overlapM2 / featureArea * 100 : 0;
                const percentOfShape = overlapM2 / shapeAreaM2 * 100;
                matches.push({ layerName: layerName,
                  label: labelOf({ layer: layer, feature: feature, objectId: objectId }),
                  objectId: objectId, overlapM2: overlapM2,
                  selectedPercent: percentOfFeature, otherPercent: percentOfShape,
                  geometry: featureGeometry, intersectionGeometry: intersectionGeometry });
                layerMatchCount++;
              } catch (intersectionError) { console.warn("Skipping invalid Sketch intersection:", intersectionError); }
            }
            layerCounts.push({ layerName: layerName, count: layerMatchCount, truncated: !!candidates.truncated });
          }
          if (requestId !== areaAnalysisRequestId) return;
          activeGeometryAnalysisSource = "Sketch";
          drawGeometryAnalysisGraphics(matches);
          renderGeometryAnalysisSummary("نسب تقاطع Sketch", shapeAreaM2, matches, layerCounts, truncated,
            "النسبة الأولى هي مساحة التقاطع كنسبة من مساحة عنصر الطبقة، والثانية هي مساحة التقاطع كنسبة من مساحة المضلع المرسوم. الحسابات المساحية تستخدم EPSG:2193 بالمتر المربع.");
          status("اكتمل تحليل تقاطع الرسم. تم حساب النسب بالنسبة للقطع وبالنسبة لمساحة الرسم.", "ok");
        } catch (error) {
          if (requestId !== areaAnalysisRequestId) return;
          console.error("Sketch overlap analysis failed:", error);
          activeGeometryAnalysisSource = "Sketch";
          renderGeometryAnalysisSummary("تعذر إكمال تقاطع Sketch", 0, [], [], false, error.message || String(error));
          status("تعذر حساب تقاطع الرسم: " + (error.message || error), "error");
        }
      }

      function renderAreaQueryAnalysis(label, queryAreaM2, queryResults, truncated) {
        const matches = (queryResults || []).filter(result => Number(result.overlapM2) > 0.01).map(result => ({
          layerName: result.layerName, label: labelOf(result), overlapM2: result.overlapM2,
          selectedPercent: result.overlapPercentOfFeature, otherPercent: result.overlapPercentOfQuery,
          geometry: result.geom, intersectionGeometry: result.overlapGeometry
        }));
        const layerCounts = [];
        ["ORC Properties", "LINZ Parcels"].forEach(layerName => {
          const group = (queryResults || []).filter(result => result.layerName === layerName);
          if (group.length) layerCounts.push({ layerName: layerName, count: group.filter(result => Number(result.overlapM2) > 0.01).length, truncated: false });
        });
        activeGeometryAnalysisSource = label;
        drawGeometryAnalysisGraphics(matches);
        const title = label === "shapefile" ? "نسب تقاطع Shapefile" : label === "road" ? "نسب التقاطع حول الشارع" : "نسب التقاطع";
        renderGeometryAnalysisSummary(title, queryAreaM2, matches, layerCounts, !!truncated,
          "النسبة الأولى هي مساحة التقاطع كنسبة من مساحة عنصر الطبقة، والثانية هي مساحة التقاطع كنسبة من مساحة الشكل/ملف Shapefile المُدخل. الحسابات المساحية تستخدم EPSG:2193 بالمتر المربع.");
      }

      function refreshSelectedPopup(result) {
        if (!result || currentSelectedResult !== result) return;
        view.openPopup({ title: result.layerName + " — " + labelOf(result),
          location: currentSelectionPoint || toView(result.geom).extent && toView(result.geom).extent.center,
          content: popupOf(result) });
        renderMapAnalysisSummary(result);
      }

      $("addDimensionBtn").addEventListener("click", () => {
        if (!currentSelectedResult) { status("اختَر عنصرًا على الخريطة أولًا.", "error"); return; }
        const value = Number($("dimensionValueInput").value);
        if (!Number.isFinite(value) || value <= 0) { status("اكتب قيمة موجبة وصحيحة بالمتر.", "error"); return; }
        const label = $("dimensionNameInput").value.trim() || ((String(currentSelectedResult.geom.type).toLowerCase() === "polygon" ? "ضلع " : "بعد ") + (currentSelectedResult.manualDimensions.length + 1));
        currentSelectedResult.manualDimensions.push({ label: label, valueM: +value.toFixed(3), enteredAt: new Date().toISOString() });
        $("dimensionNameInput").value = ""; $("dimensionValueInput").value = "";
        renderManualDimensions(currentSelectedResult); refreshSelectedPopup(currentSelectedResult);
        status("تم إرفاق البعد اليدوي بالعنصر، وسيُحفظ في Backend وJSON.", "ok");
      });

      const PopupService = window.OtagoPopupService.create({
        geometry: Geometry,
        geometryOps: geometryOps,
        Graphic: Graphic,
        format: fmt,
        labelOf: labelOf,
        layers: { parcels: parcels, props: props, addresses: addresses, roads: roads, uploadLayer: uploadLayer, roadLayer: roadLayer }
      });
      const popupOf = PopupService.resultPopup;
      const attributePopupContent = PopupService.attributePopupContent;
      const titleForLayer = PopupService.titleForLayer;
      const highlightGraphic = geometry => PopupService.highlightGraphic(selectLayer, geometry);

      // ---------- إنشاء هندسة من إحداثيات مدخلة يدويًا ----------
      function updateManualCoordinateLabels() {
        const isWgs84 = $("manualCrsSelect").value === "4326";
        $("manualXLabel").textContent = isWgs84 ? "X / Longitude" : "X / Easting (m)";
        $("manualYLabel").textContent = isWgs84 ? "Y / Latitude" : "Y / Northing (m)";
        $("manualXInput").placeholder = isWgs84 ? "Longitude مثال: 170.5" : "Easting بالمتر";
        $("manualYInput").placeholder = isWgs84 ? "Latitude مثال: -45.87" : "Northing بالمتر";
      }

      function renderManualPointList() {
        const list = $("manualPointsList");
        list.replaceChildren();
        if (!manualPoints.length) {
          list.className = "manual-points-list empty";
          list.textContent = "لم تتم إضافة نقاط بعد.";
        } else {
          list.className = "manual-points-list";
          manualPoints.forEach((item, index) => {
            const row = document.createElement("div");
            row.className = "manual-point-row";
            const label = document.createElement("span");
            const crsName = item.inputCrs === "4326" ? "EPSG:4326 Lon/Lat" : "EPSG:2193 Easting/Northing";
            label.innerHTML = '<span class="manual-point-index">Point ' + (index + 1) + '</span> — ' +
              'X: ' + item.inputX.toLocaleString("en-US", { maximumFractionDigits: 8 }) +
              ' | Y: ' + item.inputY.toLocaleString("en-US", { maximumFractionDigits: 8 }) +
              ' <span>(' + crsName + ')</span>';
            const remove = document.createElement("button");
            remove.type = "button"; remove.className = "secondary"; remove.textContent = "حذف";
            remove.addEventListener("click", async () => {
              manualPoints.splice(index, 1);
              renderManualPointList();
              try { await redrawManualGeometry(false); }
              catch (error) { console.error(error); status("تعذر تحديث الشكل بعد حذف النقطة: " + (error.message || error), "error"); }
            });
            row.append(label, remove);
            list.appendChild(row);
          });
        }
        $("undoManualPointBtn").disabled = !manualPoints.length;
        $("clearManualPointsBtn").disabled = !manualPoints.length;
        $("zoomManualShapeBtn").disabled = !manualPoints.length;
      }

      function nativeManualGeometry() {
        if (!manualPoints.length) return null;
        const coords = manualPoints.map(item => [item.point.x, item.point.y]);
        if (coords.length === 1) return manualPoints[0].point;
        if (coords.length === 2) return new Polyline({ paths: [coords], spatialReference: NATIVE_SR });
        const distinct = new Set(coords.map(c => c[0].toFixed(3) + "," + c[1].toFixed(3)));
        if (distinct.size < 3) throw new Error("المضلع يحتاج إلى 3 نقاط مختلفة على الأقل.");
        const ring = coords.concat([[coords[0][0], coords[0][1]]]);
        const polygon = new Polygon({ rings: [ring], spatialReference: NATIVE_SR });
        const simplified = geometryOps.simplify(polygon);
        const validPolygon = simplified && String(simplified.type).toLowerCase() === "polygon" ? simplified : polygon;
        const area = Math.abs(geometryOps.planarArea(validPolygon, "square-meters"));
        if (!Number.isFinite(area) || area <= 0) throw new Error("المضلع غير صالح أو مساحته صفر. راجع ترتيب النقاط وتأكد أن الحدود لا تتقاطع مع نفسها.");
        return validPolygon;
      }

      async function redrawManualGeometry(zoomToShape) {
        manualDrawLayer.removeAll();
        manualGeometry = null;
        if (!manualPoints.length) {
          $("manualGeometryInfo").className = "hint";
          $("manualGeometryInfo").textContent = "الشكل اليدوي سيظهر هنا بعد إدخال النقاط.";
          renderManualPointList();
          return;
        }
        await projection.load();
        const nativeGeometry = nativeManualGeometry();
        const displayGeometry = toView(nativeGeometry);
        if (!displayGeometry) throw new Error("تعذر عرض الشكل على الخريطة. تحقق من نظام الإحداثيات المدخل.");
        manualGeometry = nativeGeometry;
        const type = String(nativeGeometry.type).toLowerCase();
        if (type === "point") {
          manualDrawLayer.add(new Graphic({ geometry: displayGeometry, symbol: {
            type: "simple-marker", style: "circle", color: [220, 38, 38, 1], size: 15,
            outline: { color: [255, 255, 255, 1], width: 2.5 }
          } }));
        } else if (type === "polyline") {
          manualDrawLayer.add(new Graphic({ geometry: displayGeometry, symbol: {
            type: "simple-line", color: [220, 38, 38, 0.95], width: 3.5, style: "solid"
          } }));
        } else {
          manualDrawLayer.add(new Graphic({ geometry: displayGeometry, symbol: {
            type: "simple-fill", color: [239, 68, 68, 0.18], outline: { color: [220, 38, 38, 1], width: 2.5 }
          } }));
        }
        // Numbered vertex markers make the order of a line or polygon visible.
        if (manualPoints.length > 1) {
          manualPoints.forEach((item, index) => {
            const pointOnView = toView(item.point);
            manualDrawLayer.add(new Graphic({ geometry: pointOnView, symbol: {
              type: "simple-marker", style: "circle", color: [15, 91, 138, 1], size: 9,
              outline: { color: [255, 255, 255, 1], width: 1.5 }
            } }));
            manualDrawLayer.add(new Graphic({ geometry: pointOnView, symbol: {
              type: "text", text: String(index + 1), color: "#102a43", haloColor: "#ffffff", haloSize: 1.5,
              font: { size: 10, weight: "bold" }, yoffset: 12
            } }));
          });
        }

        let info = "تم رسم ";
        if (type === "point") info += "Pin من نقطة واحدة.";
        else if (type === "polyline") info += "خط من نقطتين. الطول: " + fmt(Math.abs(geometryOps.planarLength(nativeGeometry, "meters")), 2) + " م.";
        else {
          const area = Math.abs(geometryOps.planarArea(nativeGeometry, "square-meters"));
          const perimeter = Math.abs(geometryOps.planarLength(nativeGeometry, "meters"));
          info += "مضلع من " + manualPoints.length + " نقاط. المساحة: " + fmt(area, 2) + " م² — المحيط: " + fmt(perimeter, 2) + " م.";
        }
        $("manualGeometryInfo").className = "coordinate-result";
        $("manualGeometryInfo").textContent = info;
        renderManualPointList();
        if (zoomToShape) {
          try {
            if (type === "point") await view.goTo({ center: displayGeometry, zoom: Math.max(view.zoom || 0, 15) });
            else await view.goTo(displayGeometry.extent.expand(1.5));
          } catch (_) { /* Extent zoom can be unavailable for a very short/flat line. */ }
        }
      }

      $("manualCrsSelect").addEventListener("change", updateManualCoordinateLabels);
      $("addManualPointBtn").addEventListener("click", async () => {
        const xText = $("manualXInput").value.trim();
        const yText = $("manualYInput").value.trim();
        const x = Number(xText), y = Number(yText);
        const inputCrs = $("manualCrsSelect").value;
        if (!xText || !yText || !Number.isFinite(x) || !Number.isFinite(y)) {
          status("أدخل قيم X وY رقمية صحيحة قبل إضافة النقطة.", "error"); return;
        }
        if (inputCrs === "4326" && (x < -180 || x > 180 || y < -90 || y > 90)) {
          status("في EPSG:4326 أدخل Longitude بين -180 و180 وLatitude بين -90 و90.", "error"); return;
        }
        const button = $("addManualPointBtn"); button.disabled = true;
        try {
          await projection.load();
          const sourcePoint = new Point({ x: x, y: y, spatialReference: inputCrs === "4326" ? WGS84_SR : NATIVE_SR });
          const nativePoint = inputCrs === "4326" ? to2193(sourcePoint) : sourcePoint;
          if (!nativePoint || !Number.isFinite(nativePoint.x) || !Number.isFinite(nativePoint.y)) throw new Error(inputCrs === "4326" ? "لم يُرجع ArcGIS إحداثيات صالحة عند التحويل من EPSG:4326 إلى EPSG:2193. تأكد من تحميل خدمة الإسقاط وأدخل Longitude ثم Latitude." : "إحداثيات EPSG:2193 غير صالحة.");
          manualPoints.push({ point: nativePoint, inputX: x, inputY: y, inputCrs: inputCrs });
          $("manualXInput").value = ""; $("manualYInput").value = "";
          // Auto-center only on the first point. Repeated goTo() calls while adding
          // each vertex cancel in-flight feature tiles and create noisy AbortError logs.
          // Additional points redraw the geometry without navigating the map.
          await redrawManualGeometry(manualPoints.length === 1);
          status("تمت إضافة النقطة رقم " + manualPoints.length + " ورسم " +
            (manualPoints.length === 1 ? "Pin" : manualPoints.length === 2 ? "خط" : "مضلع") + " على الخريطة.", "ok");
        } catch (error) {
          console.error("Manual coordinate geometry failed:", error);
          // If a new vertex made a polygon invalid, remove only that latest vertex so the
          // previous valid geometry and entered points remain intact.
          if (manualPoints.length && !manualGeometry) manualPoints.pop();
          renderManualPointList();
          status("تعذر إنشاء الشكل: " + (error.message || error), "error");
          try { await redrawManualGeometry(false); } catch (_) {}
        } finally { button.disabled = false; }
      });

      $("undoManualPointBtn").addEventListener("click", async () => {
        if (!manualPoints.length) return;
        manualPoints.pop(); renderManualPointList();
        try { await redrawManualGeometry(false); status("تم حذف آخر نقطة وتحديث الشكل.", "ok"); }
        catch (error) { status("تعذر تحديث الشكل: " + (error.message || error), "error"); }
      });

      function clearManualGeometry() {
        manualPoints = []; manualGeometry = null; manualDrawLayer.removeAll();
        $("manualXInput").value = ""; $("manualYInput").value = "";
        renderManualPointList();
        $("manualGeometryInfo").className = "hint";
        $("manualGeometryInfo").textContent = "الشكل اليدوي سيظهر هنا بعد إدخال النقاط.";
      }
      $("clearManualPointsBtn").addEventListener("click", () => {
        clearManualGeometry(); status("تم مسح النقاط والشكل اليدوي.", "ok");
      });
      $("zoomManualShapeBtn").addEventListener("click", async () => {
        if (!manualPoints.length) return;
        try {
          const nativeGeometry = nativeManualGeometry();
          const displayGeometry = toView(nativeGeometry);
          if (!displayGeometry) throw new Error("تعذر تحويل الشكل إلى نظام إحداثيات الخريطة.");
          if (String(nativeGeometry.type).toLowerCase() === "point") {
            await view.goTo({ center: displayGeometry, zoom: Math.max(view.zoom || 0, 15) });
          } else {
            await view.goTo(displayGeometry.extent.expand(1.5));
          }
          status("تم توسيط الخريطة على الشكل اليدوي.", "ok");
        } catch (error) {
          if (error && error.name === "AbortError") return;
          status("تعذر توسيط الخريطة على الشكل: " + (error.message || error), "error");
        }
      });
      updateManualCoordinateLabels();

      // ---------- تطبيق الشارع: buffer + intersect ----------
      applyBtn.addEventListener("click", async () => {
        if (!areaInput.value || !localitySel.value || !roadSel.value) { status("اختر المنطقة والمحلية والشارع أولًا.", "error"); return; }
        applyBtn.disabled = true;
        try {
          clearAll(false);
          const dist = Math.max(1, Number($("bufferInput").value) || 25);
          const where = and(whereArea(areaInput.value.trim()), whereLoc(localitySel.value), whereRoad(roadSel.value));
          const roadQuery = roads.createQuery();
          roadQuery.where = where; roadQuery.returnGeometry = true; roadQuery.outFields = ["*"];
          roadQuery.outSpatialReference = NATIVE_SR; roadQuery.num = Math.min(500, MAX_QUERY_FEATURES);
          status("جاري تحميل هندسة الطريق…");
          const r = await roads.queryFeatures(roadQuery);
          if (r.exceededTransferLimit) {
            status("الطريق يحتوي على مقاطع كثيرة جدًا لهذا النطاق. اختر محلية/شارعًا أكثر تحديدًا ثم أعد المحاولة.", "error");
            return;
          }
          const geoms = r.features.map(f => f.geometry).filter(Boolean);
          if (!geoms.length) { status("لم يتم العثور على هندسة للطريق.", "error"); return; }
          status("جاري إنشاء نطاق البحث حول الطريق…");
          const buffers = geometryOps.buffer(geoms, dist, "meters", true);
          const buf = buffers[0];
          if (!buf) { status("تعذر إنشاء نطاق حول الطريق. تحقق من الإحداثيات ثم أعد المحاولة.", "error"); return; }
          status("تم إنشاء النطاق. جاري البحث عن الأراضي المتقاطعة…");
          roadLayer.removeAll();
          roadLayer.add(new Graphic({ geometry: toView(buf), symbol: { type: "simple-fill", color: [255,200,0,0.12], outline: { color: [230,150,0,0.9], width: 1.5, style: "dash" } } }));
          geoms.forEach(g => roadLayer.add(new Graphic({ geometry: toView(g), symbol: { type: "simple-line", color: [0,130,220,1], width: 4 } })));
          context = { district: areaInput.value.trim(), locality: localitySel.value, road: roadSel.value, bufferMeters: dist,
            roadLengthM: +geoms.reduce((s, g) => s + geometryOps.planarLength(g, "meters"), 0).toFixed(2),
            bufferAreaM2: +Math.abs(geometryOps.planarArea(buf, "square-meters")).toFixed(2), analysisCrs: "EPSG:2193" };
          await view.goTo(toView(buf).extent.expand(1.8)).catch(() => {});
          await analyse(buf, "road", { measureOverlap: true, overlapQueryLabel: "نطاق الطريق" });
        } catch (e) { console.error(e); status("خطأ أثناء التحليل: " + (e.message || e), "error"); }
        finally { applyBtn.disabled = false; }
      });

      // ---------- 2) رفع Shapefile ----------
      $("shpFile").addEventListener("change", async e => {
        const file = e.target.files[0]; if (!file) return;
        try {
          clearAll(false);
          status("جاري قراءة الـ Shapefile…");
          const shpParser = await window.shpjsReady;
          if (typeof shpParser !== "function") {
            throw new Error("تعذر تحميل مكتبة Shapefile. تأكد من اتصال الإنترنت ثم أعد تحميل الصفحة.");
          }
          const zipBytes = new Uint8Array(await file.arrayBuffer());
          // Basic signature check prevents confusing non-ZIP files with malformed shapefiles.
          if (zipBytes.length < 4 || zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b) {
            throw new Error("الملف المختار ليس ZIP صالحًا. اضغط ملفات Shapefile معًا داخل ZIP ثم ارفع الملف الناتج.");
          }
          let gj = await shpParser(zipBytes);
          const collections = (Array.isArray(gj) ? gj : [gj]).filter(Boolean);
          const feats = collections.flatMap(c => Array.isArray(c.features) ? c.features : []);
          const rings = [];
          feats.forEach(f => {
            const g = f.geometry; if (!g) return;
            if (g.type === "Polygon") rings.push(...g.coordinates);
            else if (g.type === "MultiPolygon") g.coordinates.forEach(p => rings.push(...p));
          });
          if (!rings.length) { status("لم أجد مضلعات داخل ZIP. تأكد أن بداخله ملفات Shapefile متطابقة الاسم (.shp و.shx و.dbf، ويفضل .prj)، وأن الطبقة Polygon.", "error"); return; }
          // shpjs reprojects files with a readable .prj to WGS84. If coordinates still
          // look projected, only accept plausible NZTM values; never silently treat an
          // arbitrary projected CRS as EPSG:2193.
          const sampleXY = rings[0] && rings[0][0];
          if (!sampleXY || !Number.isFinite(Number(sampleXY[0])) || !Number.isFinite(Number(sampleXY[1]))) {
            throw new Error("إحداثيات Shapefile غير صالحة أو غير رقمية.");
          }
          const looksGeographic = Math.abs(Number(sampleXY[0])) <= 180 && Math.abs(Number(sampleXY[1])) <= 90;
          const looksLikeNZTM = Number(sampleXY[0]) >= 100000 && Number(sampleXY[0]) <= 3000000 && Number(sampleXY[1]) >= 4000000 && Number(sampleXY[1]) <= 7000000;
          if (!looksGeographic && !looksLikeNZTM) {
            throw new Error("الإحداثيات تبدو مسقطة ولكنها لا تطابق النطاق المتوقع لـ NZTM EPSG:2193. أرفق ملف .prj الصحيح أو أعد إسقاط البيانات إلى WGS84 قبل ضغطها.");
          }
          const assumedSourceCrs = looksLikeNZTM ? "EPSG:2193 (نطاق إحداثيات NZTM متوقع)" : "EPSG:4326 (إحداثيات جغرافية خرجت من محلل Shapefile)";
          const sr = looksLikeNZTM ? NATIVE_SR : WGS84_SR;
          await projection.load();
          let poly = new Polygon({ rings: rings.map(ring => ring.map(xy => [Number(xy[0]), Number(xy[1])])), spatialReference: sr });
          if (!looksLikeNZTM) poly = to2193(poly);
          if (!poly) throw new Error("تعذر تحويل هندسة Shapefile إلى EPSG:2193.");
          const merged = geometryOps.simplify(poly) || poly;
          uploadedShapefileGeometry = asNativeGeometry(merged);
          const verifiedArea = Math.abs(geometryOps.planarArea(uploadedShapefileGeometry, "square-meters"));
          if (!Number.isFinite(verifiedArea) || verifiedArea <= 0) throw new Error("مساحة Shapefile غير صالحة بعد التحويل. تحقق من ملف .prj والهندسة.");
          uploadedShapefileEdges = Geometry.edgesOf(uploadedShapefileGeometry)
            .slice().sort((a, b) => b.lengthM - a.lengthM);
          uploadLayer.removeAll();
          shapefileLabelLayer.removeAll();
          longestSidesLayer.removeAll();
          uploadLayer.add(new Graphic({ geometry: toView(merged), symbol: { type: "simple-fill", color: [255,0,120,0.18], outline: { color: [220,0,100,1], width: 3 } } }));
          // Show the five longest sides by default to keep the map readable. Users can opt in to all labels.
          renderUploadedShapefileLabels();
          drawLongestSideHighlights({ layer: uploadLayer, geom: uploadedShapefileGeometry, edges: uniqueEdgesForDisplay(uploadedShapefileEdges) });
          renderShapefileSideSummary();
          await view.goTo(toView(merged).extent.expand(2)).catch(() => {});
          context = {
            shapefile: file.name,
            shapefileAreaM2: +Math.abs(geometryOps.planarArea(merged, "square-meters")).toFixed(2),
            featuresInFile: feats.length,
            sourceCrsInterpretation: assumedSourceCrs,
            analysisCrs: "EPSG:2193",
            shapefileLongestSidesM: uploadedShapefileEdges.slice(0, 5).map(edge => ({ side: edge.n, lengthM: edge.lengthM }))
          };
          await analyse(uploadedShapefileGeometry, "shapefile", { measureOverlap: true });
        } catch (err) { console.error(err); status("تعذر قراءة الملف: " + (err.message || err), "error"); }
        e.target.value = "";
      });

      // ---------- اختيار نتيجة وعرضها ----------
      async function showResult(r, point) {
        currentSelectedResult = r;
        currentSelectionPoint = point || null;
        overlapLayer.removeAll();
        nearestRoadLayer.removeAll();
        longestSidesLayer.removeAll();
        ensureMeasurements(r);
        renderManualDimensions(r);
        const type = String(r.geom && r.geom.type || "").toLowerCase();
        // Only query address points for the currently selected polygon; avoid loading all
        // addresses over a wide road buffer during initial analysis.
        if (!Array.isArray(r.addresses)) {
          if (type !== "polygon" || r.layer === addresses) r.addresses = [];
          else {
            status("جاري جلب العناوين داخل العنصر المحدد…");
            try {
              r.addresses = await fetchIntersecting(addresses, r.geom, null, 300);
            } catch (error) {
              console.warn("Address lookup for selected feature failed:", error);
              r.addresses = [];
            }
          }
        }
        if (currentSelectedResult !== r) return;
        analysisAddressFeatures = r.addresses || [];
        selectLayer.removeAll(); labelLayer.removeAll(); addrLayer.removeAll();
        selectLayer.add(new Graphic({ geometry: toView(r.geom), symbol: (type === "polygon")
          ? { type: "simple-fill", color: [24,154,211,0.25], outline: { color: [0,90,200,1], width: 3 } }
          : type === "polyline" ? { type: "simple-line", color: [0,90,200,1], width: 4 }
          : { type: "simple-marker", color: [24,154,211,0.95], size: 12, outline: { color: "#fff", width: 2 } } }));
        renderSelectedEdgeLabels(r);
        drawLongestSideHighlights(r);
        r.addresses.forEach(a => { if (a.geometry) addrLayer.add(new Graphic({ geometry: toView(a.geometry),
          symbol: { type: "simple-marker", color: [0,142,87,0.95], size: 9, outline: { color: "#fff", width: 1.5 } } })); });
        setOptions(addressSel, r.addresses, r.addresses.length ? "اختر عنوانًا (" + r.addresses.length + ")" : "لا توجد عناوين داخل العنصر المحدد",
          a => a.attributes.full_address || a.attributes.full_road_name || "عنوان");
        addressSel.disabled = !r.addresses.length;
        [...addressSel.options].forEach((o, i) => { if (i > 0) o.value = i - 1; });
        var popupLocation = point || (toView(r.geom).extent ? toView(r.geom).extent.center : toView(r.geom));
        view.openPopup({ title: r.layerName + " — " + labelOf(r), location: popupLocation, content: popupOf(r) });
        renderMapAnalysisSummary(r);
        const idx = results.indexOf(r); if (idx >= 0) resultSel.value = String(idx);
        if (type === "polygon") {
          status("تم تحديد العنصر. يتم الآن حساب التقاطع مع الطبقة الأخرى وأقرب شارع…");
          Promise.all([
            calculateLayerOverlaps(r).catch(error => { r.layerOverlapError = error.message || String(error); }),
            calculateNearestRoad(r).catch(error => { r.roadDistanceError = error.message || String(error); })
          ]).then(() => {
            if (currentSelectedResult !== r) return;
            drawLongestSideHighlights(r);
            refreshSelectedPopup(r);
            const overlapCount = (r.layerOverlapSummary || []).reduce((sum, summary) => sum + (summary.count || 0), 0);
            status("اكتمل التحليل. العناوين: " + r.addresses.length + " | العناصر المتقاطعة في الطبقات الأخرى: " + overlapCount +
              " | " + (r.roadDistanceM == null ? "لم تُحدَّد مسافة طريق متاحة" : "المسافة لأقرب شارع " + fmt(r.roadDistanceM, 2) + " م"), "ok");
          }).catch(error => {
            if (currentSelectedResult !== r) return;
            console.error("Selected-feature supplementary analysis failed:", error);
            refreshSelectedPopup(r);
            status("تم تحديد العنصر، لكن تعذر إكمال بعض التحليلات الإضافية: " + (error.message || error), "error");
          });
        } else {
          status("تم تحديد العنصر. العناوين المرتبطة المحملة: " + r.addresses.length + ". الأبعاد اليدوية اختيارية وتُستخدم لتوثيق قيمة تعرفها مسبقًا.", "ok");
        }
      }

      resultSel.addEventListener("change", () => { const r = results[Number(resultSel.value)]; if (r && resultSel.value !== "") showResult(r); });
      addressSel.addEventListener("change", () => {
        const r = results[Number(resultSel.value)]; if (!r || addressSel.value === "") return;
        const a = r.addresses[Number(addressSel.value)]; if (!a) return;
        view.openPopup({ title: a.attributes.full_address || "عنوان", location: toView(a.geometry),
          content: attributePopupContent(a.attributes, a.geometry) });
      });

      // Click anywhere on visible service layers. If analysis results exist, select the
      // smallest matching result first; otherwise use hitTest to identify normal map features.
      view.popupEnabled = false;
      view.on("click", async ev => {
        // Do not run identify/hitTest while Sketch is actively creating or editing geometry.
        if (sketchDrawingActive || Date.now() < sketchSuppressClicksUntil) return;
        try {
          await projection.load();

          // The hand-built geometry is drawn in its own GraphicsLayer; identify it first
          // so a click on a manual Pin/Line/Polygon is not reported as an empty map click.
          if (manualGeometry) {
            const manualHit = await view.hitTest(ev, { include: [manualDrawLayer] });
            if ((manualHit.results || []).length) {
              view.openPopup({ title: "الهندسة المرسومة يدويًا", location: ev.mapPoint,
                content: $("manualGeometryInfo").textContent || "شكل تم إنشاؤه من نقاط يدوية." });
              return;
            }
          }

          // If the address layer is switched on, give its point features priority over
          // polygon result overlays so users can still click individual address points.
          if (addresses.visible) {
            const addressResponse = await view.hitTest(ev, { include: [addresses] });
            const addressHit = (addressResponse.results || []).find(hit => hit.graphic && hit.graphic.attributes);
            if (addressHit) {
              const graphic = addressHit.graphic;
              const selected = registerMapFeature(graphic, addresses);
              if (selected) await showResult(selected, ev.mapPoint);
              return;
            }
          }

          // Prefer the actual visible service feature first, so a user can manually
          // choose a specific parcel even when other analysis-result polygons overlap it.
          const response = await view.hitTest(ev, { include: [parcels, props, addresses, roads] });
          const featureHit = (response.results || []).find(hit => {
            const g = hit.graphic;
            return g && g.layer && [parcels, props, addresses, roads].includes(g.layer)
              && g.attributes && Object.keys(g.attributes).length > 0;
          });
          if (featureHit) {
            const graphic = featureHit.graphic;
            const selected = registerMapFeature(graphic, graphic.layer);
            if (selected) await showResult(selected, ev.mapPoint);
            return;
          }

          const pt = to2193(ev.mapPoint);
          const resultHits = results.filter(r => r.geom && geometryOps.intersects(r.geom, pt))
            .sort((a, b) => (a.areaM2 || 0) - (b.areaM2 || 0));
          if (resultHits.length) {
            await showResult(resultHits[0], ev.mapPoint);
            return;
          }

          // The uploaded area itself can be clicked even when it produced no result features.
          const uploadHit = await view.hitTest(ev, { include: [uploadLayer, roadLayer] });
          if ((uploadHit.results || []).length) {
            const graphic = uploadHit.results[0].graphic;
            if (graphic && graphic.geometry) {
              if (graphic.layer === uploadLayer) {
                const selected = {
                  layerName: "Shapefile المرفوع", layer: uploadLayer,
                  feature: { attributes: { source: context.shapefile || "Uploaded Shapefile" }, geometry: uploadedShapefileGeometry || asNativeGeometry(graphic.geometry) },
                  geom: uploadedShapefileGeometry || asNativeGeometry(graphic.geometry), objectId: "uploaded-area", areaM2: null, perimeterM: null,
                  edges: null, addresses: null, manualDimensions: [], fromAnalysis: false,
                  shapefileEdges: uploadedShapefileEdges.slice(0, 5).map(edge => ({ n: edge.n, ring: edge.ring, lengthM: edge.lengthM }))
                };
                results = results.filter(item => item.objectId !== "uploaded-area");
                results.push(selected); refreshResultsDropdown();
                resultSel.value = String(results.indexOf(selected)); setExportActionsEnabled(true);
                await showResult(selected, ev.mapPoint);
              } else {
                highlightGraphic(graphic.geometry);
                view.openPopup({ title: "نطاق الطريق", location: ev.mapPoint, content: attributePopupContent({}, graphic.geometry) });
              }
              return;
            }
          }
          view.closePopup();
          status("لم يتم العثور على Feature تحت النقطة التي اخترتها.");
        } catch (error) {
          console.error("Map click identify failed:", error);
          status("تعذر تحديد العنصر: " + (error.message || error), "error");
        }
      });

      // ---------- Save results as JSON (implemented in export-service.js) ----------
      const exportState = () => ({ service: SERVICE, apiBaseUrl: API_BASE_URL, context: context, results: results,
        selectedResult: currentSelectedResult, labelOf: labelOf,
        ensureMeasurements: result => ensureMeasurements(result),
        getMapScreenshot: async () => {
          await view.when();
          const screenshot = await view.takeScreenshot({ format: "png" });
          return screenshot && screenshot.dataUrl || "";
        },
        getAnalysisAddressCount: () => analysisAddressFeatures.length });
      window.OtagoExportService.bindJsonExport({ button: saveBtn, getState: exportState, setStatus: status });
      window.OtagoExportService.bindCsvExport({ button: $("exportCsvBtn"), getState: exportState, setStatus: status });

      $("showAllSideLabelsToggle").addEventListener("change", event => {
        showAllSideLabels = event.target.checked;
        renderUploadedShapefileLabels();
        status(showAllSideLabels
          ? "تم إظهار أطوال جميع الأضلاع الفريدة لملف Shapefile على الخريطة. قد يزيد الازدحام في الملفات الكبيرة."
          : "تم إخفاء معظم تسميات Shapefile؛ تظهر أطول خمسة أضلاع فقط على الخريطة.", "ok");
      });

      // ---------- أدوات التحكم ----------
      function clearAll(msg) {
        [resultsLayer, roadLayer, uploadLayer, selectLayer, labelLayer, addrLayer,
          overlapLayer, nearestRoadLayer, longestSidesLayer, shapefileLabelLayer, distanceMeasureLayer,
          geometryAnalysisLayer, geometryAnalysisLabelsLayer].forEach(l => l.removeAll());
        areaAnalysisRequestId++;
        analysisRunId++;
        activeGeometryAnalysisSource = null;
        clearGeometryAnalysisVisuals(true);
        $("shapefileAnalysisBadge").hidden = true;
        $("shapefileAnalysisBody").replaceChildren();
        syncAnalysisDashboard();
        uploadedShapefileGeometry = null;
        uploadedShapefileEdges = [];
        context = {};
        clearManualGeometry();
        results = []; analysisAddressFeatures = []; analysisWasTruncated = false;
        currentSelectedResult = null; currentSelectionPoint = null; renderManualDimensions(null); renderMapAnalysisSummary(null); view.closePopup();
        setOptions(resultSel, [], "لا توجد نتائج بعد"); resultSel.disabled = true;
        setOptions(addressSel, [], "العناوين داخل الأرض المحددة"); addressSel.disabled = true;
        setExportActionsEnabled(false); $("summary").style.display = "none";
        if (msg !== false) status("تم المسح.");
      }
      // Clear only the active feature selection. Keep the current analysis and result set.
      function clearSelection() {
        selectLayer.removeAll();
        labelLayer.removeAll();
        addrLayer.removeAll();
        overlapLayer.removeAll();
        nearestRoadLayer.removeAll();
        distanceMeasureLayer.removeAll();
        longestSidesLayer.removeAll();
        currentSelectedResult = null; currentSelectionPoint = null; renderManualDimensions(null); renderMapAnalysisSummary(null);
        view.closePopup();
        resultSel.value = "";
        setOptions(addressSel, [], "العناوين داخل الأرض المحددة");
        addressSel.disabled = true;
        status("تم مسح التحديد فقط؛ نتائج التحليل ما زالت موجودة.", "ok");
      }

      // Reset filter inputs and also clear the previous analysis so results cannot be mistaken
      // for results of the newly selected filters.
      function resetFilters() {
        areaInput.value = "";
        setOptions(localitySel, [], "اختر المنطقة أولًا");
        localitySel.disabled = true;
        setOptions(roadSel, [], "اختر المحلية أولًا");
        roadSel.disabled = true;
        $("bufferInput").value = "25";
        $("shpFile").value = "";
        showAllSideLabels = true;
        $("showAllSideLabelsToggle").checked = true;
        layerSel.value = "1";
        roads.definitionExpression = null;
        roads.visible = true;
        parcels.visible = true;
        props.visible = false;
        addresses.visible = false;
        $("roadsToggle").checked = true;
        $("parcelsToggle").checked = true;
        $("addressesToggle").checked = false;
        $("districtInfo").style.display = "none";
        context = {};
        clearAll(false);
        view.closePopup();
        status("تمت إعادة ضبط الفلاتر وإلغاء نتائج التحليل السابقة.", "ok");
      }

      $("clearBtn").addEventListener("click", clearSelection);
      $("resetFiltersBtn").addEventListener("click", resetFilters);
      $("roadsToggle").addEventListener("change", e => roads.visible = e.target.checked);
      $("addressesToggle").addEventListener("change", e => addresses.visible = e.target.checked);
      $("parcelsToggle").addEventListener("change", e => { parcels.visible = e.target.checked; });

      // Geographic (WGS84 lon/lat) to projected metric coordinates (NZTM, EPSG:2193).
      $("convertCoordinatesBtn").addEventListener("click", async () => {
        const longitudeText = $("longitudeInput").value.trim();
        const latitudeText = $("latitudeInput").value.trim();
        const longitude = Number(longitudeText);
        const latitude = Number(latitudeText);
        const output = $("coordinateResult");
        if (!longitudeText || !latitudeText || !Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
          output.textContent = "أدخل Longitude بين -180 و180 وLatitude بين -90 و90.";
          output.className = "hint error-text";
          return;
        }
        const button = $("convertCoordinatesBtn"); button.disabled = true;
        output.textContent = "جاري التحويل…";
        try {
          await projection.load();
          const geographicPoint = new Point({ x: longitude, y: latitude, spatialReference: WGS84_SR });
          const projectedPoint = to2193(geographicPoint);
          if (!projectedPoint || !Number.isFinite(projectedPoint.x) || !Number.isFinite(projectedPoint.y)) throw new Error("تعذر تحويل الإحداثيات إلى EPSG:2193.");
          output.className = "coordinate-result";
          output.textContent = "Easting (X): " + projectedPoint.x.toFixed(3) + " m | Northing (Y): " + projectedPoint.y.toFixed(3) + " m | EPSG:2193";
          context.lastCoordinateConversion = { input: { longitude: longitude, latitude: latitude, crs: "EPSG:4326" }, output: { easting: projectedPoint.x, northing: projectedPoint.y, crs: "EPSG:2193", units: "meters" } };
        } catch (error) {
          console.error("Coordinate conversion failed:", error);
          output.textContent = "فشل التحويل: " + (error.message || error);
          output.className = "hint error-text";
        } finally { button.disabled = false; }
      });

      view.when(async () => {
        try {
          await projection.load();
          $("shpFile").disabled = false;
          knownDistricts = await loadDistricts();
          status("الخدمة جاهزة (" + knownDistricts.length + " منطقة). اكتب اسم المنطقة أو ارفع Shapefile.", "ok");
        } catch (e) {
          console.error(e);
          status("تعذر تحميل المناطق من الخدمة: " + (e.message || e), "error");
        }
      });
    });
