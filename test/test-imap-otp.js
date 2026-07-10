"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractOtpFromRaw, buildGmrawQuery, pickRecencyMatch } = require("../imap-otp.js");

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
