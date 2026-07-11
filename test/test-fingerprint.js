"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { generateFingerprint } = require("../fingerprint.js");

test("generateFingerprint: shape has all fields", () => {
  const fp = generateFingerprint(42);
  assert.equal(typeof fp.userAgent, "string");
  assert.ok(fp.userAgent.includes("Mozilla"));
  assert.equal(typeof fp.viewport.width, "number");
  assert.equal(typeof fp.viewport.height, "number");
  assert.equal(typeof fp.locale, "string");
  assert.equal(typeof fp.acceptLanguage, "string");
  assert.equal(typeof fp.timezoneId, "string");
  assert.equal(typeof fp.hardwareConcurrency, "number");
  assert.equal(typeof fp.deviceMemory, "number");
  assert.ok(Array.isArray(fp.languages));
});

test("generateFingerprint: UA realistic Chrome", () => {
  const fp = generateFingerprint(1);
  assert.match(fp.userAgent, /Chrome\/\d+\.\d+\.\d+\.\d+/);
  assert.match(fp.userAgent, /AppleWebKit\/537\.36/);
  // Tidak ada fingerprint bot yang terlalu obvious
  assert.ok(!/HeadlessChrome/.test(fp.userAgent));
});

test("generateFingerprint: viewport dari whitelist", () => {
  const valid = [
    [1920, 1080], [1536, 864], [1440, 900],
    [1366, 768], [1680, 1050], [1280, 800], [1280, 720],
  ];
  for (let i = 0; i < 50; i++) {
    const fp = generateFingerprint(i);
    const found = valid.some(([w, h]) => w === fp.viewport.width && h === fp.viewport.height);
    assert.ok(found, `viewport ${fp.viewport.width}x${fp.viewport.height} not in whitelist`);
  }
});

test("generateFingerprint: deterministic dengan seed yang sama", () => {
  const a = generateFingerprint(123);
  const b = generateFingerprint(123);
  assert.deepEqual(a, b);
});

test("generateFingerprint: beda seed beda hasil", () => {
  const a = generateFingerprint(1);
  const b = generateFingerprint(2);
  // Tidak semua field harus beda (bisa bentrok pada beberapa field),
  // tapi paling tidak satu field utama harus beda.
  const any = a.userAgent !== b.userAgent
    || a.viewport.width !== b.viewport.width
    || a.timezoneId !== b.timezoneId
    || a.locale !== b.locale
    || a.hardwareConcurrency !== b.hardwareConcurrency;
  assert.ok(any, "expected at least one differing field");
});

test("generateFingerprint: hardwareConcurrency realistic (2-16)", () => {
  for (let i = 0; i < 100; i++) {
    const fp = generateFingerprint(i);
    assert.ok(fp.hardwareConcurrency >= 2 && fp.hardwareConcurrency <= 16);
    assert.ok(fp.deviceMemory >= 2 && fp.deviceMemory <= 32);
  }
});
