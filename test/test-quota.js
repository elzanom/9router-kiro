"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { utcDateKey, domainOf, loadStats, saveStats, isAllowed, increment, tryConsume, pruneOld } = require("../quota.js");

test("utcDateKey: today UTC", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(utcDateKey(), today);
});

test("domainOf: extract domain, lowercase", () => {
  assert.equal(domainOf("Alice@Aleeas.COM"), "aleeas.com");
  assert.equal(domainOf("xyz@mozmail.com"), "mozmail.com");
  assert.equal(domainOf("no-at-sign"), null);
  assert.equal(domainOf(null), null);
});

test("loadStats: missing file → {}", () => {
  assert.deepEqual(loadStats("/no/such/file.json"), {});
});

test("loadStats: corrupt JSON → {} + warning", () => {
  const tmp = path.join(os.tmpdir(), `quota-${Date.now()}.json`);
  fs.writeFileSync(tmp, "{not json");
  const out = loadStats(tmp);
  assert.deepEqual(out, {});
  fs.unlinkSync(tmp);
});

test("saveStats + loadStats roundtrip", () => {
  const tmp = path.join(os.tmpdir(), `quota-${Date.now()}.json`);
  const stats = { "2026-07-11": { "mozmail.com": 5 } };
  saveStats(tmp, stats);
  assert.deepEqual(loadStats(tmp), stats);
  fs.unlinkSync(tmp);
});

test("isAllowed: under cap", () => {
  const stats = { "2026-07-11": { "mozmail.com": 3 } };
  assert.equal(isAllowed(stats, "x@mozmail.com", 10), true);
});

test("isAllowed: at cap", () => {
  const stats = { "2026-07-11": { "mozmail.com": 10 } };
  assert.equal(isAllowed(stats, "x@mozmail.com", 10), false);
});

test("isAllowed: no entry yet → allowed", () => {
  const stats = {};
  assert.equal(isAllowed(stats, "x@mozmail.com", 10), true);
});

test("increment: bumps domain counter", () => {
  const stats = {};
  increment(stats, "a@mozmail.com");
  increment(stats, "b@mozmail.com");
  assert.equal(stats["2026-07-11"]["mozmail.com"], 2);
});

test("tryConsume: allow + persist", () => {
  const tmp = path.join(os.tmpdir(), `quota-${Date.now()}.json`);
  const r1 = tryConsume(tmp, "a@mozmail.com", 10);
  assert.equal(r1.allowed, true);
  // Sisa counter di file
  const stats = loadStats(tmp);
  const used = stats[utcDateKey()]?.["mozmail.com"] || 0;
  assert.equal(used, 1);
  fs.unlinkSync(tmp);
});

test("tryConsume: block when cap reached", () => {
  const tmp = path.join(os.tmpdir(), `quota-${Date.now()}.json`);
  // Burn 10
  for (let i = 0; i < 10; i++) tryConsume(tmp, `a${i}@mozmail.com`, 10);
  const r = tryConsume(tmp, "x@mozmail.com", 10);
  assert.equal(r.allowed, false);
  // File tidak berubah karena tidak di-increment
  const stats = loadStats(tmp);
  const used = stats[utcDateKey()]?.["mozmail.com"] || 0;
  assert.equal(used, 10);
  fs.unlinkSync(tmp);
});

test("tryConsume: per-domain isolation", () => {
  const tmp = path.join(os.tmpdir(), `quota-${Date.now()}.json`);
  tryConsume(tmp, "a@mozmail.com", 10);
  // aleeas.com belum terpakai → masih allowed walau mozmail.com sudah 1
  const r = tryConsume(tmp, "x@aleeas.com", 10);
  assert.equal(r.allowed, true);
  fs.unlinkSync(tmp);
});

test("pruneOld: keeps only N days back", () => {
  const today = utcDateKey();
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const wayBack = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const stats = {
    [wayBack]: { "mozmail.com": 5 },
    [yesterday]: { "mozmail.com": 3 },
    [today]: { "mozmail.com": 1 },
  };
  const out = pruneOld(stats, 30);
  assert.ok(!out[wayBack], "way-back day dropped");
  assert.ok(out[yesterday], "yesterday kept");
  assert.ok(out[today], "today kept");
});
