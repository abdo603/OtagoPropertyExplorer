"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const ROOT = __dirname;
const STORAGE_DIR = path.join(ROOT, "storage");
const STORAGE_FILE = path.join(STORAGE_DIR, "saved-analyses.json");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 50 * 1024 * 1024;
let writeQueue = Promise.resolve();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large (50 MB max)."), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (_) { reject(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}

async function readDatabase() {
  try {
    const raw = await fs.readFile(STORAGE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function saveRecord(payload) {
  let saved;
  // Serialize writes to avoid losing records if the user clicks save rapidly.
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    const records = await readDatabase();
    saved = { id: randomUUID(), createdAt: new Date().toISOString(), payload };
    records.push(saved);
    const temp = STORAGE_FILE + ".tmp";
    await fs.writeFile(temp, JSON.stringify(records, null, 2), "utf8");
    await fs.rename(temp, STORAGE_FILE);
  });
  await writeQueue;
  return saved;
}

function serveStatic(req, res, pathname) {
  // Only serve front-end assets; never expose server code or storage JSON via static paths.
  let target;
  if (pathname === "/" || pathname === "/index.html") target = path.join(ROOT, "index.html");
  else if (pathname === "/styles.css") target = path.join(ROOT, "styles.css");
  else if (pathname.startsWith("/js/")) {
    const relative = pathname.slice(1);
    target = path.resolve(ROOT, relative);
    const allowedRoot = path.resolve(ROOT, "js") + path.sep;
    if (!target.startsWith(allowedRoot) || path.extname(target).toLowerCase() !== ".js") {
      res.writeHead(403); res.end("Forbidden"); return;
    }
  } else {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found"); return;
  }
  fs.readFile(target).then(contents => {
    res.writeHead(200, { "Content-Type": MIME[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(contents);
  }).catch(() => { res.writeHead(404); res.end("Not found"); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    });
    res.end(); return;
  }
  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { success: true, service: "Otago Property Explorer local backend", storage: "storage/saved-analyses.json" });
    return;
  }
  if (pathname === "/api/saves" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || !Array.isArray(body.results)) {
        sendJson(res, 400, { success: false, error: "Expected a JSON object with a results array." });
        return;
      }
      const saved = await saveRecord(body);
      sendJson(res, 201, { success: true, id: saved.id, createdAt: saved.createdAt, count: body.results.length });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { success: false, error: error.message || "Could not save data." });
    }
    return;
  }
  if (pathname === "/api/saves" && req.method === "GET") {
    try {
      const records = await readDatabase();
      sendJson(res, 200, { success: true, count: records.length, saves: records.map(record => ({ id: record.id, createdAt: record.createdAt, count: record.payload && record.payload.count || 0 })) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: error.message });
    }
    return;
  }
  if (req.method === "GET" && !pathname.startsWith("/api/")) {
    serveStatic(req, res, pathname); return;
  }
  sendJson(res, 404, { success: false, error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Otago Property Explorer running at http://localhost:${PORT}`);
  console.log(`Saved analyses will be written to ${STORAGE_FILE}`);
});
