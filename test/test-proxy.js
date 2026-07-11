"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseProxyLine, loadProxies, getProxyForAccount, chromiumArgsForProxy } = require("../proxy.js");

test("parseProxyLine: protocol://user:pass@host:port", () => {
  const p = parseProxyLine("http://alice:secret@1.2.3.4:8080");
  assert.deepEqual(p, {
    protocol: "http", host: "1.2.3.4", port: 8080,
    username: "alice", password: "secret", raw: "http://alice:secret@1.2.3.4:8080",
  });
});

test("parseProxyLine: socks5:// (no auth)", () => {
  const p = parseProxyLine("socks5://5.6.7.8:1080");
  assert.equal(p.protocol, "socks5");
  assert.equal(p.host, "5.6.7.8");
  assert.equal(p.port, 1080);
  assert.equal(p.username, null);
});

test("parseProxyLine: host:port:user:pass (legacy)", () => {
  const p = parseProxyLine("1.2.3.4:8080:alice:secret");
  assert.equal(p.host, "1.2.3.4");
  assert.equal(p.username, "alice");
});

test("parseProxyLine: user:pass@host:port", () => {
  const p = parseProxyLine("alice:secret@1.2.3.4:8080");
  assert.equal(p.host, "1.2.3.4");
  assert.equal(p.username, "alice");
});

test("parseProxyLine: host:port (no auth)", () => {
  const p = parseProxyLine("1.2.3.4:8080");
  assert.equal(p.username, null);
});

test("parseProxyLine: skip blank / comment / invalid", () => {
  assert.equal(parseProxyLine(""), null);
  assert.equal(parseProxyLine("# comment"), null);
  assert.equal(parseProxyLine("not a proxy"), null);
  assert.equal(parseProxyLine("just-host"), null);
});

test("loadProxies: reads file, skips invalid", () => {
  const tmp = path.join(os.tmpdir(), `proxy-test-${Date.now()}.txt`);
  fs.writeFileSync(tmp, [
    "http://alice:p@1.1.1.1:8080",
    "",
    "# this is a comment",
    "broken line",
    "socks5://2.2.2.2:1080",
    "10.0.0.1:3128:bob:secret",
  ].join("\n"));
  const proxies = loadProxies(tmp);
  assert.equal(proxies.length, 3);
  assert.equal(proxies[0].host, "1.1.1.1");
  assert.equal(proxies[1].host, "2.2.2.2");
  assert.equal(proxies[2].host, "10.0.0.1");
  fs.unlinkSync(tmp);
});

test("loadProxies: missing file → [] (not throw)", () => {
  assert.deepEqual(loadProxies("/no/such/file.txt"), []);
});

test("getProxyForAccount: cycle through pool", () => {
  const pool = [
    { host: "1.1.1.1" }, { host: "2.2.2.2" }, { host: "3.3.3.3" },
  ];
  assert.equal(getProxyForAccount(pool, 0).host, "1.1.1.1");
  assert.equal(getProxyForAccount(pool, 3).host, "1.1.1.1"); // wrap
  assert.equal(getProxyForAccount(pool, 5).host, "3.3.3.3");
});

test("getProxyForAccount: empty pool → null", () => {
  assert.equal(getProxyForAccount([], 0), null);
  assert.equal(getProxyForAccount(null, 0), null);
});

test("chromiumArgsForProxy: returns --proxy-server arg", () => {
  const args = chromiumArgsForProxy({ protocol: "http", host: "1.2.3.4", port: 8080 });
  assert.deepEqual(args, ["--proxy-server=http://1.2.3.4:8080"]);
});

test("chromiumArgsForProxy: null → empty array", () => {
  assert.deepEqual(chromiumArgsForProxy(null), []);
});
