"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractOtpFromRaw, buildGmrawQuery, buildGmrawFallbackQuery, pickRecencyMatch, getOtpViaImap } = require("../imap-otp.js");

test("extractOtpFromRaw: pola 'Verification code' + tag + 6 digit", () => {
  const raw = `<p>Verification code:</p><strong>573868</strong>`;
  assert.equal(extractOtpFromRaw(raw), "573868");
});

test("extractOtpFromRaw: kata 'verification' dalam 300 char sebelum digit", () => {
  const raw = `Your verification code is 344535. Valid for 10 minutes.`;
  assert.equal(extractOtpFromRaw(raw), "344535");
});

test("extractOtpFromRaw: fallback konteks 'code' menangkap 6 digit", () => {
  const raw = `some text code: 481030 here`;
  assert.equal(extractOtpFromRaw(raw), "481030");
});

test("extractOtpFromRaw: null kalau tidak ada OTP", () => {
  assert.equal(extractOtpFromRaw("Welcome to AWS"), null);
  assert.equal(extractOtpFromRaw(null), null);
});

test("buildGmrawQuery: format to: + subject:", () => {
  assert.equal(
    buildGmrawQuery("abc@aleeas.com", "Verify your AWS Builder ID email address"),
    `to:abc@aleeas.com subject:"Verify your AWS Builder ID email address"`
  );
});

test("pickRecencyMatch: pilih match terbaru dalam window + ber-OTP", () => {
  const since = 1000000;
  const messages = [
    { uid: 1, internalDate: new Date(since - 120000), source: "verification 111111" }, // luar window (slack 60s)
    { uid: 2, internalDate: new Date(since - 10000), source: "verification 222222" }, // dalam window
    { uid: 3, internalDate: new Date(since - 5000), source: "Welcome to AWS" },       // dalam window, no OTP
  ];
  const r = pickRecencyMatch(messages, { since, slackMs: 60000 });
  assert.equal(r.otp, "222222");
  assert.equal(r.message.uid, 2);
});

test("pickRecencyMatch: null kalau tidak ada match dalam window ber-OTP", () => {
  const since = 1000000;
  const messages = [
    { uid: 1, internalDate: new Date(since - 120000), source: "verification 111111" },
  ];
  assert.equal(pickRecencyMatch(messages, { since, slackMs: 60000 }), null);
});

test("getOtpViaImap: gmraw path nemu OTP + delete-after-read", async () => {
  const since = Date.now() - 5000;
  let deleted = null;
  const fakeClient = {
    capabilities: new Set(["X-GM-EXT-1"]),
    async getMailboxLock() { return { async release() {} }; },
    async search() { return [100]; },
    async fetchOne() {
      return {
        source: Buffer.from("Your verification code is 573868. Valid 10 min."),
        envelope: { subject: "Verify your AWS Builder ID email address", from: [{ address: "no-reply@signin.aws" }] },
        internalDate: new Date(since + 1000),
      };
    },
    async messageDelete(uid) { deleted = uid; },
    async logout() {},
  };
  const res = await getOtpViaImap(
    { user: "u@gmail.com", password: "p", deleteAfterRead: true },
    "abc@aleeas.com",
    { since, maxWaitMs: 1000, pollMs: 10, clientFactory: async () => fakeClient }
  );
  assert.equal(res.ok, true);
  assert.equal(res.otp, "573868");
  assert.equal(res.from, "no-reply@signin.aws");
  assert.equal(deleted, 100);
});

test("getOtpViaImap: fallback folder (tanpa X-GM-EXT-1), no-delete", async () => {
  const since = Date.now() - 5000;
  let deleted = null;
  let searchCalls = 0;
  const fakeClient = {
    capabilities: new Set([]),
    async list() { return [{ path: "INBOX", specialUse: "\\Inbox" }, { path: "[Gmail]/Spam", specialUse: "\\Junk" }]; },
    async getMailboxLock() { return { async release() {} }; },
    async search() { searchCalls++; return searchCalls >= 2 ? [200] : []; },
    async fetchOne() {
      return {
        source: Buffer.from("verification code 209910"),
        envelope: { subject: "Verify your AWS Builder ID email address", from: [{ address: "x@signin.aws" }] },
        internalDate: new Date(since + 2000),
      };
    },
    async messageDelete(uid) { deleted = uid; },
    async logout() {},
  };
  const res = await getOtpViaImap(
    { user: "u@gmail.com", password: "p", deleteAfterRead: false },
    "xyz@mozmail.com",
    { since, maxWaitMs: 3000, pollMs: 10, clientFactory: async () => fakeClient }
  );
  assert.equal(res.ok, true);
  assert.equal(res.otp, "209910");
  assert.equal(deleted, null); // deleteAfterRead false
});

test("getOtpViaImap: timeout -> {ok:false} + debug", async () => {
  const fakeClient = {
    capabilities: new Set(["X-GM-EXT-1"]),
    async getMailboxLock() { return { async release() {} }; },
    async search() { return []; },
    async fetchOne() { return null; },
    async logout() {},
  };
  const res = await getOtpViaImap(
    { user: "u", password: "p" },
    "a@b.com",
    { since: Date.now(), maxWaitMs: 50, pollMs: 10, clientFactory: async () => fakeClient }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /timeout/i);
  assert.equal(res.debug.usedGmraw, true);
});

test("getOtpViaImap: creds hilang -> gagal cepat", async () => {
  const res = await getOtpViaImap({}, "a@b.com", { clientFactory: async () => { throw new Error("x"); } });
  assert.equal(res.ok, false);
  assert.match(res.error, /tidak lengkap/i);
});

test("buildGmrawFallbackQuery: from:signin.aws + subject", () => {
  assert.equal(
    buildGmrawFallbackQuery("Verify your AWS Builder ID email address"),
    `from:signin.aws subject:"Verify your AWS Builder ID email address"`
  );
});

test("getOtpViaImap: fallback path (To-rewrite) nemu OTP + debug.usedFallback", async () => {
  const since = Date.now() - 5000;
  let deleted = null;
  let searchCalls = [];
  const fakeClient = {
    capabilities: new Set(["X-GM-EXT-1"]),
    async getMailboxLock() { return { async release() {} }; },
    async search(criteria) {
      // Log query, return [] for "to:" (simulating Relay rewrite),
      // then [300] for the fallback "from:signin.aws".
      const q = criteria.gmraw || JSON.stringify(criteria);
      searchCalls.push(q);
      if (q.startsWith("to:")) return [];
      return [300];
    },
    async fetchOne() {
      return {
        source: Buffer.from("verification 888222"),
        envelope: { subject: "Verify your AWS Builder ID email address", from: [{ address: "no-reply@signin.aws" }] },
        internalDate: new Date(since + 3000),
      };
    },
    async messageDelete(uid) { deleted = uid; },
    async logout() {},
  };
  const res = await getOtpViaImap(
    { user: "u@gmail.com", password: "p", deleteAfterRead: true },
    "abc@mozmail.com",
    { since, maxWaitMs: 1000, pollMs: 10, clientFactory: async () => fakeClient }
  );
  assert.equal(res.ok, true);
  assert.equal(res.otp, "888222");
  assert.equal(deleted, 300);
  assert.equal(res.debug.usedFallback, true);
  // Pastikan kedua query dipanggil
  assert.equal(searchCalls.length, 2);
  assert.ok(searchCalls[0].startsWith("to:abc@mozmail.com"));
  assert.ok(searchCalls[1].startsWith("from:signin.aws"));
});
