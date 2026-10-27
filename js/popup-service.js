/* Popup content and clicked-feature highlight helpers; measurements use Geometry Operators. */
(function (global) {
  "use strict";
  function createPopupService(deps) {
    var geometry = deps.geometry;
    var geometryOps = deps.geometryOps;
    var Graphic = deps.Graphic;
    var layers = deps.layers;
    var format = deps.format;
    var labelOf = deps.labelOf;

    function appendTable(root, title, rows) {
      var heading = document.createElement("h4");
      heading.textContent = title;
      root.appendChild(heading);
      var table = document.createElement("table");
      var body = document.createElement("tbody");
      rows.forEach(function (row) {
        var tr = document.createElement("tr");
        var th = document.createElement("th");
        var td = document.createElement("td");
        th.textContent = row[0];
        td.textContent = row[1] == null ? "" : String(row[1]);
        tr.append(th, td);
        body.appendChild(tr);
      });
      table.appendChild(body);
      root.appendChild(table);
    }

    function resultPopup(result) {
      var root = document.createElement("div");
      root.className = "popup-content";
      var geometryType = String(result.geom && result.geom.type || "").toLowerCase();
      var calculations = [];
      if (geometryType === "polygon") {
        calculations.push(["المساحة", format(result.areaM2 || 0) + " م²"]);
        calculations.push(["المحيط", format(result.perimeterM || 0) + " م"]);
        calculations.push(["عدد الأضلاع", (result.edges || []).length]);
      } else if (geometryType === "polyline") {
        calculations.push(["الطول الهندسي", format(result.perimeterM || 0) + " م"]);
        calculations.push(["عدد المسارات", (result.edges || []).length]);
      } else if (geometryType === "point") {
        calculations.push(["نوع الهندسة", "نقطة"]);
        if (result.geom) {
          calculations.push(["X", format(result.geom.x, 3)]);
          calculations.push(["Y", format(result.geom.y, 3)]);
        }
      }
      if (result.overlapM2 != null) {
        calculations.push(["مساحة التقاطع", format(result.overlapM2) + " م²"]);
        if (result.overlapPercentOfFeature != null) calculations.push(["نسبة التقاطع من مساحة القطعة", format(result.overlapPercentOfFeature, 2) + "%"]);
        if (result.overlapPercentOfQuery != null) calculations.push(["نسبة التقاطع من مساحة " + (result.overlapQueryLabel || "نطاق التحليل"), format(result.overlapPercentOfQuery, 2) + "%"]);
        calculations.push(["نظام حساب المساحة", result.overlapCrs || "EPSG:2193 — بالمتر"]);
      }
      if (result.roadDistanceChecked) {
        calculations.push(["أقرب شارع", result.nearestRoadName || (result.roadDistanceM == null
          ? (result.roadDistanceSearchMayBeIncomplete ? "لم يتم تأكيد أقرب شارع بسبب حد النتائج" : "لم يُعثر على شارع ضمن نطاق البحث") : "اسم غير متاح")]);
        calculations.push(["المسافة إلى أقرب شارع", result.roadDistanceM == null ? "غير متاحة" : format(result.roadDistanceM, 2) + " م"]);
        if (result.roadDistanceMayBeIncomplete || result.roadDistanceSearchMayBeIncomplete) calculations.push(["دقة مرشح الشارع", "وصل البحث إلى حد النتائج؛ راجع المرشح قبل اعتماد المسافة."]);
        if (result.roadDistanceError) calculations.push(["تنبيه المسافة", result.roadDistanceError]);
      }
      if ((result.addresses || []).length) calculations.push(["عدد العناوين داخل العنصر", result.addresses.length]);
      if (calculations.length) appendTable(root, "القياسات الهندسية", calculations);

      if (Array.isArray(result.layerOverlapSummary) && result.layerOverlapSummary.length) {
        var overlapRows = [];
        result.layerOverlapSummary.forEach(function (summary) {
          overlapRows.push([summary.layerName, summary.count + " عنصر متقاطع" + (summary.truncated ? " (نتائج جزئية بسبب حد الاستعلام)" : "")]);
          (summary.matches || []).slice(0, 12).forEach(function (match) {
            overlapRows.push([match.label || ("ID " + (match.objectId == null ? "غير معروف" : match.objectId)),
              format(match.overlapM2, 2) + " م² | " + format(match.selectedPercent, 2) + "% من القطعة | " + format(match.otherPercent, 2) + "% من العنصر الآخر"]);
          });
        });
        appendTable(root, "نسبة التقاطع مع الطبقات الأخرى (EPSG:2193 — بالمتر)", overlapRows);
        if (result.layerOverlapError) appendTable(root, "تنبيه مقارنة الطبقات", [["الحالة", result.layerOverlapError]]);
      } else if (result.layerOverlapChecked && result.layerOverlapError) {
        appendTable(root, "التقاطع مع الطبقات الأخرى", [["الحالة", result.layerOverlapError]]);
      }

      if (Array.isArray(result.shapefileEdges) && result.shapefileEdges.length) {
        appendTable(root, "أطول أضلاع Shapefile المتقاطع", result.shapefileEdges.slice(0, 5).map(function (edge) {
          return ["ضلع S-" + edge.n, format(edge.lengthM, 2) + " م"];
        }));
      }
      if (geometryType === "polygon" && Array.isArray(result.edges) && result.edges.length && result.layer !== layers.uploadLayer) {
        appendTable(root, "أطول 5 أضلاع للقطعة المحددة", result.edges.slice().sort(function (a, b) { return b.lengthM - a.lengthM; }).slice(0, 5).map(function (edge) {
          return ["ضلع P-" + edge.n, format(edge.lengthM, 2) + " م"];
        }));
      }
      var attributes = Object.entries(result.feature && result.feature.attributes || {})
        .filter(function (entry) { return entry[1] != null && entry[1] !== "" && !/^(shape|objectid)/i.test(entry[0]); })
        .map(function (entry) { return [entry[0], String(entry[1])]; });
      if (attributes.length) appendTable(root, "الحقول", attributes);
      if (geometryType === "polyline" && Array.isArray(result.edges) && result.edges.length) {
        appendTable(root, "أطوال المسارات المحسوبة", result.edges.slice().sort(function (a, b) { return b.lengthM - a.lengthM; }).slice(0, 5)
          .map(function (edge) { return ["مسار " + edge.n, edge.lengthM.toFixed(2) + " م"]; }));
      }
      if ((result.manualDimensions || []).length) {
        appendTable(root, "الأبعاد اليدوية المسجلة", result.manualDimensions.map(function (dimension, index) {
          return [dimension.label || ("بعد " + (index + 1)), format(dimension.valueM, 3) + " م"];
        }));
      }
      if (!root.children.length) {
        var paragraph = document.createElement("p");
        paragraph.textContent = "لا توجد Attributes أو قياسات متاحة لهذا العنصر.";
        root.appendChild(paragraph);
      }
      return root;
    }

    function attributePopupContent(attributes, sourceGeometry) {
      var root = document.createElement("div");
      root.className = "popup-content";
      var rows = [];
      if (sourceGeometry) {
        var g = sourceGeometry;
        try { g = geometry.toNative(sourceGeometry) || sourceGeometry; } catch (_) { /* keep source geometry */ }
        var type = String(g.type).toLowerCase();
        if (type === "polygon") {
          var area = Math.abs(geometryOps.planarArea(g, "square-meters"));
          var edges = geometry.edgesOf(g);
          rows.push(["المساحة", format(area) + " م²"]);
          rows.push(["المحيط", format(edges.reduce(function (sum, edge) { return sum + edge.lengthM; }, 0)) + " م"]);
          rows.push(["عدد الأضلاع", String(edges.length)]);
          rows.push(["أطوال الأضلاع", ""]);
          edges.forEach(function (edge) { rows.push(["ضلع " + edge.n, edge.lengthM.toFixed(2) + " م"]); });
        } else if (type === "polyline") {
          rows.push(["الطول", format(geometryOps.planarLength(g, "meters")) + " م"]);
        } else if (type === "point") {
          rows.push(["X", format(g.x, 3)]);
          rows.push(["Y", format(g.y, 3)]);
        }
      }
      Object.entries(attributes || {}).forEach(function (entry) {
        var key = entry[0], value = entry[1];
        if (value == null || value === "" || /^(shape|shape_area|shape_length)$/i.test(key)) return;
        rows.push([key, String(value)]);
      });
      if (!rows.length) {
        var paragraph = document.createElement("p");
        paragraph.textContent = "لا توجد Attributes متاحة لهذا العنصر.";
        root.appendChild(paragraph);
      } else appendTable(root, "بيانات العنصر والقياسات", rows);
      return root;
    }

    function titleForLayer(layer) {
      if (layer === layers.parcels) return "LINZ Primary Parcels";
      if (layer === layers.props) return "ORC Properties";
      if (layer === layers.addresses) return "Street Address";
      if (layer === layers.roads) return "Roads";
      return layer && layer.title ? layer.title : "Map feature";
    }

    function highlightGraphic(selectionLayer, sourceGeometry) {
      selectionLayer.removeAll();
      if (!sourceGeometry) return;
      var g = geometry.toView(sourceGeometry) || sourceGeometry;
      var type = String(g.type).toLowerCase();
      var symbol;
      if (type === "polygon") symbol = { type: "simple-fill", color: [24,154,211,0.20], outline: { color: [0,90,200,1], width: 3 } };
      else if (type === "polyline") symbol = { type: "simple-line", color: [0,90,200,1], width: 4 };
      else if (type === "point") symbol = { type: "simple-marker", color: [0,90,200,0.95], size: 12, outline: { color: "#ffffff", width: 2 } };
      if (symbol) selectionLayer.add(new Graphic({ geometry: g, symbol: symbol }));
    }

    return { resultPopup: resultPopup, attributePopupContent: attributePopupContent, titleForLayer: titleForLayer, highlightGraphic: highlightGraphic };
  }
  global.OtagoPopupService = { create: createPopupService };
})(window);
