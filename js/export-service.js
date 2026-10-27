/* Persists analysis to the local Node backend, then downloads a JSON backup. */
(function (global) {
  "use strict";
  function pause() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }

  function downloadJson(data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "otago_results_" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".json";
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function bindJsonExport(options) {
    options.button.addEventListener("click", async function () {
      var state = options.getState();
      var results = state.results;
      if (!results.length) return;
      options.button.disabled = true;
      try {
        for (var i = 0; i < results.length; i++) {
          if (typeof state.ensureMeasurements === "function") state.ensureMeasurements(results[i]);
          if (i > 0 && i % 25 === 0) {
            options.setStatus("جاري تجهيز JSON… " + i.toLocaleString("en-US") + " / " + results.length.toLocaleString("en-US"));
            await pause();
          }
        }
        var data = {
          schemaVersion: 2,
          generatedAt: new Date().toISOString(),
          source: state.service,
          crs: "EPSG:2193",
          units: "meters",
          query: state.context,
          count: results.length,
          selectedObjectId: state.selectedResult ? state.selectedResult.objectId : null,
          results: results.map(function (result) {
            return {
              layer: result.layerName,
              geometryType: result.geom && result.geom.type,
              objectId: result.objectId,
              label: state.labelOf(result),
              attributes: result.feature && result.feature.attributes || {},
              areaM2: result.areaM2 == null ? null : +result.areaM2.toFixed(3),
              perimeterM: result.perimeterM == null ? null : +result.perimeterM.toFixed(3),
              overlapAreaM2: result.overlapM2 != null ? +result.overlapM2.toFixed(3) : null,
              overlapPercentOfFeature: result.overlapPercentOfFeature == null ? null : +result.overlapPercentOfFeature.toFixed(4),
              overlapPercentOfQuery: result.overlapPercentOfQuery == null ? null : +result.overlapPercentOfQuery.toFixed(4),
              overlapCrs: result.overlapCrs || result.analysisCrs || null,
              overlapQueryLabel: result.overlapQueryLabel || null,
              nearestRoadName: result.nearestRoadName || null,
              distanceToNearestRoadM: result.roadDistanceM == null ? null : +result.roadDistanceM.toFixed(3),
              roadDistanceMayBeIncomplete: !!result.roadDistanceMayBeIncomplete,
              roadDistanceSearchMayBeIncomplete: !!result.roadDistanceSearchMayBeIncomplete,
              roadSearchRadiusM: result.roadSearchRadiusM == null ? null : result.roadSearchRadiusM,
              nearestRoadObjectId: result.nearestRoadObjectId == null ? null : result.nearestRoadObjectId,
              crossLayerOverlaps: (result.layerOverlapSummary || []).map(function (summary) {
                return {
                  layer: summary.layerName,
                  count: summary.count,
                  truncated: !!summary.truncated,
                  matches: (summary.matches || []).map(function (match) {
                    return {
                      objectId: match.objectId,
                      label: match.label,
                      overlapAreaM2: match.overlapM2,
                      selectedFeaturePercent: match.selectedPercent,
                      otherFeaturePercent: match.otherPercent
                    };
                  })
                };
              }),
              shapefileLongestEdges: (result.shapefileEdges || []).map(function (edge) {
                return { n: edge.n, ring: edge.ring, lengthM: edge.lengthM };
              }),
              longestFeatureEdges: (result.edges || []).slice().sort(function (a, b) { return b.lengthM - a.lengthM; }).slice(0, 5)
                .map(function (edge) { return { n: edge.n, ring: edge.ring, lengthM: edge.lengthM }; }),
              edges: (result.edges || []).map(function (edge) { return { n: edge.n, ring: edge.ring, lengthM: edge.lengthM }; }),
              manualDimensions: (result.manualDimensions || []).map(function (dimension) { return { label: dimension.label, valueM: dimension.valueM, unit: "m" }; }),
              addresses: (result.addresses || []).map(function (address) { return address.attributes || {}; }),
              geometry: result.geom && typeof result.geom.toJSON === "function" ? result.geom.toJSON() : result.geom
            };
          })
        };

        var backendError = null;
        var recordId = null;
        try {
          var response = await fetch((state.apiBaseUrl || "http://localhost:3000") + "/api/saves", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
          });
          var responseBody = await response.json().catch(function () { return {}; });
          if (!response.ok || !responseBody.success) {
            throw new Error(responseBody.error || ("HTTP " + response.status));
          }
          recordId = responseBody.id || null;
        } catch (error) {
          backendError = error;
        }

        // A downloadable copy is provided either way, but the UI distinguishes backend
        // persistence from a local-only backup so it never claims the backend saved it.
        downloadJson(data);
        if (!backendError) {
          options.setStatus("تم حفظ البيانات في Backend بنجاح (ID: " + recordId + ")، وتم تنزيل نسخة JSON احتياطية.", "ok");
        } else {
          console.error("Backend save failed:", backendError);
          options.setStatus("لم يتم الحفظ في Backend. تم تنزيل نسخة JSON محلية فقط. شغّل npm start ثم افتح http://localhost:3000. التفاصيل: " + backendError.message, "error");
        }
      } catch (error) {
        console.error("JSON export failed:", error);
        options.setStatus("تعذر تجهيز ملف JSON: " + (error.message || error), "error");
      } finally {
        options.button.disabled = results.length === 0;
      }
    });
  }

  function csvCell(value) {
    if (value == null) return "";
    var text = typeof value === "object" ? JSON.stringify(value) : String(value);
    // Prevent spreadsheet formula injection from untrusted feature attributes. Keep
    // actual numeric values numeric; escape only imported text values that begin with
    // formula-triggering characters after optional whitespace/control characters.
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(value)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function safeFileStamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  }

  function bindCsvExport(options) {
    if (!options || !options.button) return;
    options.button.addEventListener("click", async function () {
      var state = options.getState();
      var results = state.results || [];
      if (!results.length) return;
      options.button.disabled = true;
      try {
        var headers = ["layer", "object_id", "feature", "geometry_type", "area_m2", "perimeter_m", "overlap_area_m2",
          "overlap_percent_of_feature", "overlap_percent_of_query", "overlap_query_label", "nearest_road", "distance_to_nearest_road_m",
          "road_distance_may_be_incomplete", "road_distance_search_may_be_incomplete", "road_search_radius_m", "road_distance_error",
          "cross_layer_overlap_incomplete", "cross_layer_overlap_error", "analysis_query_truncated", "cross_layer_overlaps",
          "shapefile_longest_edges", "feature_longest_edges", "manual_dimensions"];
        var rows = [headers.map(csvCell).join(",")];
        for (var i = 0; i < results.length; i++) {
          var result = results[i];
          if (typeof state.ensureMeasurements === "function") state.ensureMeasurements(result);
          if (i > 0 && i % 50 === 0) {
            options.setStatus("جاري تجهيز CSV… " + i.toLocaleString("en-US") + " / " + results.length.toLocaleString("en-US"));
            await pause();
          }
          rows.push([
            result.layerName || result.layer && result.layer.title || "",
            result.objectId,
            state.labelOf ? state.labelOf(result) : "",
            result.geom && result.geom.type,
            result.areaM2 == null ? "" : +Number(result.areaM2).toFixed(3),
            result.perimeterM == null ? "" : +Number(result.perimeterM).toFixed(3),
            result.overlapM2 == null ? "" : +Number(result.overlapM2).toFixed(3),
            result.overlapPercentOfFeature == null ? "" : +Number(result.overlapPercentOfFeature).toFixed(4),
            result.overlapPercentOfQuery == null ? "" : +Number(result.overlapPercentOfQuery).toFixed(4),
            result.overlapQueryLabel || "",
            result.nearestRoadName || "",
            result.roadDistanceM == null ? "" : +Number(result.roadDistanceM).toFixed(3),
            !!result.roadDistanceMayBeIncomplete,
            !!result.roadDistanceSearchMayBeIncomplete,
            result.roadSearchRadiusM == null ? "" : result.roadSearchRadiusM,
            result.roadDistanceError || "",
            (result.layerOverlapSummary || []).some(function (summary) { return !!summary.truncated; }),
            result.layerOverlapError || "",
            !!(state.context && state.context.queryTruncated),
            (result.layerOverlapSummary || []).map(function (summary) {
              return { layer: summary.layerName, count: summary.count, truncated: !!summary.truncated,
                matches: (summary.matches || []).slice(0, 20).map(function (match) {
                  return { objectId: match.objectId, label: match.label, overlapM2: match.overlapM2,
                    percentOfSelectedFeature: match.selectedPercent, percentOfOtherFeature: match.otherPercent };
                }) };
            }),
            (result.shapefileEdges || []).map(function (edge) { return { side: edge.n, lengthM: edge.lengthM }; }),
            (result.edges || []).slice().sort(function (a, b) { return b.lengthM - a.lengthM; }).slice(0, 5)
              .map(function (edge) { return { side: edge.n, ring: edge.ring, lengthM: edge.lengthM }; }),
            (result.manualDimensions || []).map(function (dimension) { return { label: dimension.label, valueM: dimension.valueM, unit: "m" }; })
          ].map(csvCell).join(","));
        }
        var blob = new Blob(["\uFEFF" + rows.join("\r\n")], { type: "text/csv;charset=utf-8;" });
        var url = URL.createObjectURL(blob);
        var link = document.createElement("a");
        link.href = url;
        link.download = "otago_analysis_" + safeFileStamp() + ".csv";
        link.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        options.setStatus("تم تنزيل ملف CSV بعدد " + results.length.toLocaleString("en-US") + " نتيجة. القيم التي لم تُحسب بعد تُترك فارغة ولا تُقدّر تلقائيًا.", "ok");
      } catch (error) {
        console.error("CSV export failed:", error);
        options.setStatus("تعذر تجهيز CSV: " + (error.message || error), "error");
      } finally {
        options.button.disabled = !(options.getState().results || []).length;
      }
    });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character];
    });
  }

  function bindPrintableReport(options) {
    if (!options || !options.button) return;
    options.button.addEventListener("click", async function () {
      var state = options.getState();
      var allResults = state.results || [];
      if (!allResults.length) return;
      // Open synchronously inside the click event so browser popup protection does not
      // block the report after measurements finish.
      var reportWindow = window.open("", "_blank");
      if (!reportWindow) {
        options.setStatus("المتصفح منع فتح التقرير. اسمح بالنوافذ المنبثقة لهذا الموقع ثم أعد المحاولة.", "error");
        return;
      }
      options.button.disabled = true;
      try {
        var results = allResults.slice(0, 250);
        var mapImageDataUrl = "";
        for (var i = 0; i < results.length; i++) {
          if (typeof state.ensureMeasurements === "function") state.ensureMeasurements(results[i]);
          if (i > 0 && i % 25 === 0) {
            options.setStatus("جاري تجهيز التقرير للطباعة… " + i.toLocaleString("en-US") + " / " + results.length.toLocaleString("en-US"));
            await pause();
          }
        }
        var selected = state.selectedResult;
        if (typeof state.getMapScreenshot === "function") {
          try { mapImageDataUrl = await state.getMapScreenshot() || ""; }
          catch (screenshotError) { console.warn("Map screenshot unavailable for report:", screenshotError); }
        }
        var selectedRows = [];
        if (selected) {
          if (typeof state.ensureMeasurements === "function") state.ensureMeasurements(selected);
          selectedRows = [
            ["الطبقة", selected.layerName], ["المعرّف", selected.objectId == null ? "غير متاح" : selected.objectId],
            ["المساحة (م²)", selected.areaM2 == null ? "غير محسوبة" : Number(selected.areaM2).toFixed(2)],
            ["المحيط (م)", selected.perimeterM == null ? "غير محسوب" : Number(selected.perimeterM).toFixed(2)],
            ["مساحة التقاطع (م²)", selected.overlapM2 == null ? "غير محسوبة" : Number(selected.overlapM2).toFixed(2)],
            ["نسبة التقاطع من العنصر (%)", selected.overlapPercentOfFeature == null ? "غير محسوبة" : Number(selected.overlapPercentOfFeature).toFixed(4)],
            ["نسبة التقاطع من نطاق التحليل (%)", selected.overlapPercentOfQuery == null ? "غير محسوبة" : Number(selected.overlapPercentOfQuery).toFixed(4)],
            ["أقرب شارع", selected.nearestRoadName || "غير محسوب"],
            ["المسافة للشارع (م)", selected.roadDistanceM == null ? "غير محسوبة" : Number(selected.roadDistanceM).toFixed(3)],
            ["جودة تحليل الطريق", selected.roadDistanceMayBeIncomplete ? "المسافة مرشحة؛ استعلام الطرق بلغ حد النتائج" : selected.roadDistanceSearchMayBeIncomplete ? "تعذر تأكيد أقرب شارع بسبب حد النتائج" : selected.roadDistanceError ? "تعذر الحساب: " + selected.roadDistanceError : "لا يوجد تحذير طريق مسجل"],
            ["جودة التقاطع", (selected.layerOverlapSummary || []).some(function (summary) { return summary.truncated; }) ? "نتائج التقاطع قد تكون جزئية" : selected.layerOverlapError || "لا يوجد تحذير تقاطع مسجل"],
            ["نطاق النتائج", state.context && state.context.queryTruncated ? "قائمة النتائج قد تكون جزئية بسبب حد الاستعلام" : "لم يسجل التطبيق بلوغ حد النتائج"],
            ["نظام القياس", "EPSG:2193 — metres"]
          ];
        }
        var bodyRows = results.map(function (result) {
          var qualityNotes = [];
          if (state.context && state.context.queryTruncated) qualityNotes.push("قائمة النتائج العامة قد تكون جزئية");
          if (result.roadDistanceMayBeIncomplete) qualityNotes.push("مسافة الشارع مرشحة بسبب حد النتائج");
          if (result.roadDistanceSearchMayBeIncomplete) qualityNotes.push("لم يتأكد أقرب شارع بسبب حد النتائج");
          if (result.roadDistanceError) qualityNotes.push("خطأ قياس الشارع: " + result.roadDistanceError);
          if ((result.layerOverlapSummary || []).some(function (summary) { return summary.truncated; })) qualityNotes.push("نتائج تقاطع الطبقات جزئية");
          if (result.layerOverlapError) qualityNotes.push("خطأ تقاطع الطبقات: " + result.layerOverlapError);
          return "<tr>" + [result.layerName || "", result.objectId == null ? "" : result.objectId,
            state.labelOf ? state.labelOf(result) : "", result.geom && result.geom.type || "",
            result.areaM2 == null ? "" : Number(result.areaM2).toFixed(2),
            result.perimeterM == null ? "" : Number(result.perimeterM).toFixed(2),
            result.overlapM2 == null ? "" : Number(result.overlapM2).toFixed(2),
            result.overlapPercentOfFeature == null ? "" : Number(result.overlapPercentOfFeature).toFixed(3) + "%",
            result.overlapPercentOfQuery == null ? "" : Number(result.overlapPercentOfQuery).toFixed(3) + "%",
            result.nearestRoadName || "", result.roadDistanceM == null ? "" : Number(result.roadDistanceM).toFixed(2),
            qualityNotes.length ? qualityNotes.join("؛ ") : "—"
          ].map(function (value) { return "<td>" + escapeHtml(value) + "</td>"; }).join("") + "</tr>";
        }).join("");
        var selectedTable = selectedRows.length ? "<h2>ملخص العنصر المحدد</h2><table><tbody>" + selectedRows.map(function (row) {
          return "<tr><th>" + escapeHtml(row[0]) + "</th><td>" + escapeHtml(row[1]) + "</td></tr>";
        }).join("") + "</tbody></table>" : "<p>لم يتم تحديد عنصر واحد؛ التقرير يعرض النتائج المتاحة فقط.</p>";
        var truncationNote = allResults.length > results.length
          ? `<p class="notice">يعرض تقرير الطباعة أول ${results.length} نتيجة من أصل ${allResults.length}. استخدم تصدير CSV للحصول على جميع النتائج.</p>` : "";
        var resultHeaders = ["الطبقة", "ID", "العنصر", "النوع", "المساحة م²", "المحيط م", "التقاطع م²", "% العنصر", "% النطاق", "الشارع", "المسافة م", "ملاحظات الجودة"];
        var mapSection = mapImageDataUrl
          ? `<h2>لقطة الخريطة عند إنشاء التقرير</h2><img class="map-shot" alt="لقطة الخريطة" src="${escapeHtml(mapImageDataUrl)}">`
          : '<h2>لقطة الخريطة</h2><p class="meta">تعذر التقاط الخريطة في هذه الجلسة؛ بقية التقرير متاحة.</p>';
        var html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير تحليل Otago</title>
          <style>@page{size:landscape;margin:10mm}body{font-family:Tahoma,Arial,sans-serif;color:#172b3e;margin:24px;line-height:1.55}h1{font-size:22px;color:#0d557a}h2{font-size:16px;margin-top:22px;border-bottom:1px solid #d7e0e7;padding-bottom:6px}.meta{color:#526579;font-size:12px}table{width:100%;border-collapse:collapse;margin:8px 0 18px;font-size:11px}td,th{border:1px solid #d7e0e7;padding:6px;text-align:right;overflow-wrap:anywhere}th{background:#edf5f8;width:32%}.results td{direction:ltr;text-align:left}.notice{background:#fff7ed;border:1px solid #fed7aa;padding:8px;border-radius:6px}.map-shot{display:block;width:100%;max-height:155mm;object-fit:contain;border:1px solid #d7e0e7;border-radius:6px}@media print{button{display:none}body{margin:10mm}tr{break-inside:avoid}h2{break-after:avoid}.map-shot{break-inside:avoid}}</style></head><body>
          <h1>تقرير التحليل المكاني — Otago Property Explorer</h1>
          <div class="meta">تاريخ الإنشاء: ${escapeHtml(new Date().toLocaleString("ar-EG"))} · نظام القياس: EPSG:2193 · الوحدات: متر ومتر مربع</div>
          <h2>ملخص التنفيذ</h2><table><tbody>
          <tr><th>عدد النتائج الكلي</th><td>${allResults.length}</td></tr>
          <tr><th>نوع التحليل</th><td>${escapeHtml(state.context && state.context.mode || "غير محدد")}</td></tr>
          <tr><th>مصدر البيانات</th><td>${escapeHtml(state.service || "")}</td></tr>
          <tr><th>اكتمال قائمة النتائج</th><td>${state.context && state.context.queryTruncated ? "تحذير: وصل الاستعلام إلى حد النتائج؛ قد تكون القائمة جزئية" : "لم يسجل التطبيق بلوغ حد النتائج"}</td></tr></tbody></table>
          ${mapSection}${selectedTable}${truncationNote}<h2>جدول النتائج</h2><table class="results"><thead><tr>
          ${resultHeaders.map(function (x) { return "<th>" + escapeHtml(x) + "</th>"; }).join("")}
          </tr></thead><tbody>${bodyRows}</tbody></table>
          <p class="meta">النتائج التي لم يُجرَ حسابها صراحةً تُعرض كقيمة غير محسوبة أو فارغة، وليست صفرًا.</p>
          <button onclick="window.print()">طباعة / حفظ PDF</button><script>setTimeout(function(){window.focus()},250)<\/script></body></html>`;
        reportWindow.document.open(); reportWindow.document.write(html); reportWindow.document.close();
        options.setStatus("تم تجهيز تقرير الطباعة. من نافذة التقرير اختر طباعة ثم Save as PDF لحفظه كملف PDF.", "ok");
      } catch (error) {
        console.error("Printable report failed:", error);
        reportWindow.document.body.textContent = "تعذر تجهيز التقرير: " + (error.message || error);
        options.setStatus("تعذر تجهيز تقرير الطباعة: " + (error.message || error), "error");
      } finally {
        options.button.disabled = !(options.getState().results || []).length;
      }
    });
  }

  global.OtagoExportService = { bindJsonExport: bindJsonExport, bindCsvExport: bindCsvExport, bindPrintableReport: bindPrintableReport };
})(window);
