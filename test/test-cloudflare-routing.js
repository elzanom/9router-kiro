"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomLocalPart, generateAliases, appendAliasesToFile } = require("../cloudflare-routing.js");

test("randomLocalPart: name-like format (word + word + digits)", () => {
  for (let i = 0; i < 50; i++) {
    const p = randomLocalPart();
    // Format: "<first>[.<last>]<num>" dengan num 10-99
    assert.match(p, /^[a-z]+(\.[a-z]+)?[1-9][0-9]$/);
    assert.ok(p.length >= 6 && p.length <= 30);
  }
});

test("generateAliases: count + email format", () => {
  const list = generateAliases("minom.my.id", 5);
  assert.equal(list.length, 5);
  for (const a of list) {
    assert.match(a, /^[^@]+@minom\.my\.id$/);
  }
});

test("generateAliases: 100 aliases unik (probabilistic check)", () => {
  const list = generateAliases("minom.my.id", 100);
  const uniq = new Set(list);
  // Dict kecil (50 first × 50 last × 90 num = 225k + 2 format = 450k
  // possible local parts). Collision untuk 100 elemen sangat rendah.
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
