"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomLocalPart, generateAliases, appendAliasesToFile } = require("../cloudflare-routing.js");

test("randomLocalPart: default length 10", () => {
  const p = randomLocalPart();
  assert.equal(p.length, 10);
  assert.match(p, /^[a-z0-9]+$/);
});

test("randomLocalPart: custom length", () => {
  assert.equal(randomLocalPart(8).length, 8);
  assert.equal(randomLocalPart(15).length, 15);
});

test("generateAliases: count + format", () => {
  const list = generateAliases("minom.my.id", 5, 10);
  assert.equal(list.length, 5);
  for (const a of list) {
    assert.match(a, /^[a-z0-9]{10}@minom\.my\.id$/);
  }
});

test("generateAliases: 100 aliases unik (probabilistic check)", () => {
  const list = generateAliases("minom.my.id", 100, 10);
  const uniq = new Set(list);
  // 62^10 collision probability untuk 100 elemen sangat rendah.
  assert.equal(uniq.size, list.length);
});

test("appendAliasesToFile: append + dedupe", () => {
  const tmp = path.join(os.tmpdir(), `cf-aliases-${Date.now()}.txt`);
  fs.writeFileSync(tmp, "existing@minom.my.id\n");
  const added1 = appendAliasesToFile(tmp, ["new1@minom.my.id", "existing@minom.my.id", "new2@minom.my.id"]);
  assert.equal(added1, 2);
  const content = fs.readFileSync(tmp, "utf8");
  assert.match(content, /new1@minom\.my\.id/);
  assert.match(content, /new2@minom\.my\.id/);
  assert.match(content, /existing@minom\.my\.id/);
  const added2 = appendAliasesToFile(tmp, ["new1@minom.my.id"]);
  assert.equal(added2, 0);
  fs.unlinkSync(tmp);
});
