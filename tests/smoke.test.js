"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

const sourceFiles = [
  "server.js", "js/config.js", "js/utils.js", "js/data-service.js", "js/geometry-service.js",
  "js/popup-service.js", "js/export-service.js", "js/shapefile-loader.js", "js/app.js"
];

test("all JavaScript source files parse", () => {
  for (const file of sourceFiles) assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }), file);
});

test("HTML ids are unique and all literal app selectors exist", () => {
  const html = read("index.html");
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], [], "duplicate HTML ids must not exist");
  const idSet = new Set(ids);
  const app = read("js/app.js");
  const selectors = [...app.matchAll(/\$\("([^"']+)"\)/g)].map(match => match[1]);
  const missing = [...new Set(selectors)].filter(id => !idSet.has(id));
  assert.deepEqual(missing, [], "all literal DOM lookups must point to an existing element");
});

test("geometry service calculates polygon side lengths and labels the longest edges first", () => {
  class Point { constructor(props) { Object.assign(this, props); this.type = "point"; } }
  class Polyline { constructor(props) { Object.assign(this, props); this.type = "polyline"; } }
  class Graphic { constructor(props) { Object.assign(this, props); } }
  const sandbox = { console, Set, Number, Math, Array, Object };
  sandbox.window = sandbox;
  vm.runInNewContext(read("js/geometry-service.js"), sandbox, { filename: "geometry-service.js" });
  const layer = { graphics: [], removeAll() { this.graphics = []; }, add(item) { this.graphics.push(item); } };
  const geometryOps = { planarLength(line) {
    const path = line.paths[0];
    let sum = 0;
    for (let i = 1; i < path.length; i++) sum += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    return sum;
  } };
  const geometry = sandbox.OtagoGeometryService.create({
    geometryOps, Point, Polyline, Graphic,
    projection: { project(value) { return value; } },
    view: { spatialReference: { wkid: 2193 } }, nativeSR: { wkid: 2193 }, labelLayer: layer
  });
  const polygon = { type: "polygon", spatialReference: { wkid: 2193 }, rings: [[[0, 0], [10, 0], [10, 5], [0, 5], [0, 0]]] };
  const edges = geometry.edgesOf(polygon);
  assert.equal(edges.length, 4);
  assert.deepEqual(Array.from(edges, edge => edge.lengthM), [10, 5, 10, 5]);
  const drawn = geometry.drawEdgeLabels(polygon, { maxLabels: 2, longestFirst: true, labelPrefix: "S-", fontSize: 9 });
  assert.equal(drawn.length, 4);
  assert.equal(layer.graphics.length, 2);
  assert.match(layer.graphics[0].symbol.text, /S-1[\s\S]*10\.00 m/);
  assert.match(layer.graphics[1].symbol.text, /S-3[\s\S]*10\.00 m/);
});


test("all unique boundary edges can be labeled without truncation", () => {
  class Point { constructor(props) { Object.assign(this, props); this.type = "point"; } }
  class Polyline { constructor(props) { Object.assign(this, props); this.type = "polyline"; } }
  class Graphic { constructor(props) { Object.assign(this, props); } }
  const sandbox = { console, Set, Number, Math, Array, Object };
  sandbox.window = sandbox;
  vm.runInNewContext(read("js/geometry-service.js"), sandbox, { filename: "geometry-service.js" });
  const layer = { graphics: [], removeAll() { this.graphics = []; }, add(item) { this.graphics.push(item); } };
  const geometryOps = { planarLength(line) {
    const path = line.paths[0];
    return Math.hypot(path[1][0] - path[0][0], path[1][1] - path[0][1]);
  } };
  const service = sandbox.OtagoGeometryService.create({
    geometryOps, Point, Polyline, Graphic, projection: { project(value) { return value; } },
    view: { spatialReference: { wkid: 2193 } }, nativeSR: { wkid: 2193 }, labelLayer: layer
  });
  const twoAdjacentSquares = { type: "polygon", spatialReference: { wkid: 2193 }, rings: [
    [[0,0],[10,0],[10,10],[0,10],[0,0]],
    [[10,0],[20,0],[20,10],[10,10],[10,0]]
  ] };
  const labels = service.drawEdgeLabels(twoAdjacentSquares, { layer, maxLabels: 100000, dedupe: true, longestFirst: false, labelPrefix: "S-" });
  assert.equal(labels.length, 7, "the duplicate shared edge is removed from the returned display list");
  assert.equal(layer.graphics.length, 7, "the shared edge is shown once to avoid duplicate labels");
});

test("data service pages intersecting results and reports truncation correctly", async () => {
  const sandbox = { console, setTimeout, Promise, Array, Number, Math, Object, String, Map };
  sandbox.window = sandbox;
  vm.runInNewContext(read("js/data-service.js"), sandbox, { filename: "data-service.js" });
  function makeLayer(pages) {
    return {
      fields: [{ name: "OBJECTID", type: "oid" }],
      createQuery() { return {}; },
      async queryFeatures(query) {
        const page = pages[query.start || 0] || { features: [], exceededTransferLimit: false };
        return page;
      }
    };
  }
  const features = id => ({ attributes: { OBJECTID: id }, geometry: { type: "polygon" } });
  const complete = makeLayer({
    0: { features: [features(1), features(2)], exceededTransferLimit: true },
    2: { features: [features(3)], exceededTransferLimit: false }
  });
  const result = await sandbox.OtagoDataService.fetchIntersecting(complete, {}, { nativeSR: {}, maxFeatures: 10, pageSize: 2, getObjectIdField: () => "OBJECTID" });
  assert.equal(result.length, 3);
  assert.equal(result.truncated, false);
  const capped = makeLayer({ 0: { features: [features(1), features(2)], exceededTransferLimit: true } });
  const limited = await sandbox.OtagoDataService.fetchIntersecting(capped, {}, { nativeSR: {}, maxFeatures: 2, pageSize: 2, getObjectIdField: () => "OBJECTID" });
  assert.equal(limited.length, 2);
  assert.equal(limited.truncated, true);
});

test("dashboard and export buttons are present in the document", () => {
  const html = read("index.html");
  for (const id of ["analysisDashboard", "mapAnalysisBadge", "geometryAnalysisBadge", "shapefileAnalysisBadge", "exportCsvBtn", "showAllSideLabelsToggle"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  const exportSource = read("js/export-service.js");
  assert.match(exportSource, /bindCsvExport/);
  assert.doesNotMatch(html, /printReportBtn|تقرير \/ PDF/);
});



test("all Shapefile side labels are enabled by default and can be listed completely", () => {
  const app = read("js/app.js");
  const html = read("index.html");
  assert.match(app, /let showAllSideLabels = true/);
  assert.match(app, /maxLabels: showAllSideLabels \? Math\.max\(uploadedShapefileEdges\.length \+ 1, 1\) : 5/);
  assert.match(app, /عرض جميع الأضلاع/);
  assert.match(html, /id="showAllSideLabelsToggle" type="checkbox" checked/);
});

test("Sketch overlap labels are anchored on intersection geometry and use explicit denominator names", () => {
  const app = read("js/app.js");
  assert.match(app, /asNativeGeometry\(match\.intersectionGeometry \|\| match\.geometry\)/);
  assert.match(app, /من مساحة العنصر: .*inputLabel/);
  assert.match(app, /activeGeometryAnalysisSource === "Sketch" \? "من مساحة الرسم"/);
  assert.match(app, /النسبة الأولى = مساحة التقاطع/);
});

test("CSV export neutralizes formula-like source attributes", async () => {
  let handler;
  let downloadedText = "";
  let clicked = false;
  class FakeBlob {
    constructor(parts) { this.parts = parts; }
  }
  const link = { click() { clicked = true; }, href: "", download: "" };
  const sandbox = {
    console, Promise, Array, Number, Math, Object, String, JSON, Date, setTimeout,
    Blob: FakeBlob,
    URL: { createObjectURL(blob) { downloadedText = blob.parts.join(""); return "blob:csv-test"; }, revokeObjectURL() {} },
    document: { createElement() { return link; }, body: { appendChild() {}, removeChild() {} } }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(read("js/export-service.js"), sandbox, { filename: "export-service.js" });
  const button = { disabled: false, addEventListener(type, callback) { if (type === "click") handler = callback; } };
  sandbox.OtagoExportService.bindCsvExport({
    button,
    getState: () => ({ results: [{ layerName: "=1+1", objectId: 7, geom: { type: "polygon" }, manualDimensions: [] }], labelOf: () => "@SUM(A1:A2)" }),
    setStatus() {}
  });
  await handler();
  assert.equal(clicked, true);
  assert.match(downloadedText, /'=1\+1/);
  assert.match(downloadedText, /'@SUM\(A1:A2\)/);
  assert.equal(downloadedText.charCodeAt(0), 0xFEFF);
});

