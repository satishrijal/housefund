'use strict';
// End-to-end API test. Run: ADMIN_USER=admin ADMIN_PASS=secret node test/api.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'secret-test-pass';
process.env.PORT = '3210';
process.env.HF_DATA_DIR = require('os').tmpdir() + '/housefund-test-' + Date.now();

const server = require('../server.js'); // starts listening (no export needed)
const BASE = 'http://localhost:3210';

async function api(method, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = r.headers.get('set-cookie');
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j, cookie: setCookie ? setCookie.split(';')[0] : null };
}

test('full flow: admin creates members, member forced pw change, expense, settle', async () => {
  // admin login
  let r = await api('POST', '/api/admin/login', { user: 'admin', pass: 'secret-test-pass' });
  assert.equal(r.status, 200);
  const adminCookie = r.cookie;
  assert.ok(adminCookie);

  // create two members
  r = await api('POST', '/api/admin/members', { name: 'Alex', username: 'alex' }, adminCookie);
  assert.equal(r.status, 200);
  const alexTemp = r.json.tempPassword;
  assert.ok(alexTemp && alexTemp.length >= 6);
  const alexId = r.json.id;

  r = await api('POST', '/api/admin/members', { name: 'Ben', username: 'ben', password: 'benpass1' }, adminCookie);
  assert.equal(r.status, 200);
  const benId = r.json.id;

  // duplicate username rejected
  r = await api('POST', '/api/admin/members', { name: 'Alex2', username: 'alex' }, adminCookie);
  assert.equal(r.status, 400);

  // member login with temp pw → mustChangePw
  r = await api('POST', '/api/login', { username: 'alex', password: alexTemp });
  assert.equal(r.status, 200);
  assert.equal(r.json.mustChangePw, true);
  const alexCookie = r.cookie;

  // wrong password rejected
  r = await api('POST', '/api/login', { username: 'alex', password: 'nope' });
  assert.equal(r.status, 401);

  // force change
  r = await api('POST', '/api/change-password', { newPassword: 'alexnew1' }, alexCookie);
  assert.equal(r.status, 200);

  // old temp pw no longer works
  r = await api('POST', '/api/login', { username: 'alex', password: alexTemp });
  assert.equal(r.status, 401);
  r = await api('POST', '/api/login', { username: 'alex', password: 'alexnew1' });
  assert.equal(r.json.mustChangePw, false);
  const alexC2 = r.cookie;

  // summary works
  r = await api('GET', '/api/summary?month=2026-10', null, alexC2);
  assert.equal(r.status, 200);
  assert.equal(r.json.me.contribDue, 10000);

  // contribution
  r = await api('POST', '/api/contributions', { userId: alexId, amount: 100, month: '2026-10' }, alexC2);
  assert.equal(r.status, 200);

  // expense: Alex pays $225, $100 covers Ben's contribution, $125 house
  r = await api('POST', '/api/expenses', {
    payerId: alexId, amount: 225, merchant: 'Walmart', date: '2026-10-15',
    allocs: [
      { kind: 'cover', amount: 100, beneficiaryId: benId },
      { kind: 'house', amount: 125 },
    ],
  }, alexC2);
  assert.equal(r.status, 200);

  // bad split rejected
  r = await api('POST', '/api/expenses', {
    payerId: alexId, amount: 225, merchant: 'X', date: '2026-10-15',
    allocs: [{ kind: 'house', amount: 200 }],
  }, alexC2);
  assert.equal(r.status, 400);

  // ben logs in, sees he owes alex $100 and contribution covered
  r = await api('POST', '/api/login', { username: 'ben', password: 'benpass1' });
  const benCookie = r.cookie;
  r = await api('GET', '/api/summary?month=2026-10', null, benCookie);
  assert.equal(r.json.me.contribDue, 0);
  assert.equal(r.json.me.iOwe.length, 1);
  assert.equal(r.json.me.iOwe[0].cents, 10000);
  const allocId = r.json.me.iOwe[0].allocId;

  // ben settles $25
  r = await api('POST', '/api/settle', { fromId: benId, toId: alexId, amount: 25, allocId }, benCookie);
  assert.equal(r.status, 200);
  r = await api('GET', '/api/summary?month=2026-10', null, benCookie);
  assert.equal(r.json.me.iOwe[0].cents, 7500);

  // admin reset logs ben out + temp pw shown once
  r = await api('POST', '/api/admin/reset-password', { userId: benId }, adminCookie);
  assert.equal(r.status, 200);
  assert.ok(r.json.tempPassword);
  r = await api('GET', '/api/me', null, benCookie);
  assert.equal(r.status, 401); // logged out

  // CSV export
  r = await api('GET', '/api/export.csv', null, alexC2);
  assert.equal(r.status, 200);

  // unauthenticated blocked
  r = await api('GET', '/api/summary');
  assert.equal(r.status, 401);

  console.log('API E2E PASS');
  process.exit(0);
});
