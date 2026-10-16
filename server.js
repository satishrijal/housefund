'use strict';
/**
 * server.js — HouseFund. Zero-dependency Node server.
 * Postgres (Neon) when DATABASE_URL is set, JSON file otherwise.
 *
 * Auth model (per Satish): NO self-signup. The admin creates every member
 * account in the admin panel. First login forces a password change.
 * Forgotten passwords are reset by the admin (temp password shown once).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const ledger = require('./ledger');
const ocr = require('./ocr');
const parser = require('./parser');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const RECEIPT_DIR = path.join(db.DATA_DIR, 'receipts');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
};

// ------------------------------------------------------------ helpers ---

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
const ok = (res, body) => send(res, 200, body);
const bad = (res, msg, code = 400) => send(res, code, { error: msg });

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, val) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 25 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}

async function memberSession(req) {
  const tok = parseCookies(req).hf_session;
  if (!tok) return null;
  return db.read((d) => {
    const s = d.sessions.find((x) => x.id === tok);
    if (!s || s.admin) return null;
    const u = d.users.find((x) => x.id === s.userId);
    return u ? { token: tok, user: { id: u.id, username: u.username, name: u.name } } : null;
  });
}
async function adminSession(req) {
  const tok = parseCookies(req).hf_admin;
  if (!tok) return null;
  return db.read((d) => {
    const s = d.sessions.find((x) => x.id === tok);
    return s && s.admin ? { token: tok } : null;
  });
}

const dollarsToCents = (v, label) => {
  const c = Math.round(Number(v) * 100);
  if (!Number.isFinite(c) || c <= 0) throw new Error((label || 'Amount') + ' must be a positive number.');
  return c;
};
const thisMonth = () => new Date().toISOString().slice(0, 7);

// -------------------------------------------------------------- API ---

async function api(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;

  // ---- public ----
  if (p === '/api/login' && method === 'POST') {
    const b = await readBody(req);
    const user = await db.read((d) =>
      d.users.find((u) => u.username === String(b.username || '').trim().toLowerCase()));
    if (!user || !auth.verifyPassword(b.password, user.passHash)) return bad(res, 'Wrong username or password.', 401);
    const token = await db.mutate((d) => {
      const t = auth.newToken();
      d.sessions.push({ id: t, userId: user.id, admin: false, createdAt: new Date().toISOString() });
      return t;
    });
    setCookie(res, 'hf_session', token);
    return ok(res, { mustChangePw: !!user.mustChangePw, name: user.name });
  }

  if (p === '/api/change-password' && method === 'POST') {
    const sess = await memberSession(req);
    if (!sess) return bad(res, 'Not logged in.', 401);
    const b = await readBody(req);
    if (String(b.newPassword || '').length < 6) return bad(res, 'New password must be at least 6 characters.');
    const done = await db.mutate((d) => {
      const u = d.users.find((x) => x.id === sess.user.id);
      if (!u) return false;
      if (!u.mustChangePw && !auth.verifyPassword(b.oldPassword, u.passHash)) return 'wrong';
      u.passHash = auth.hashPassword(b.newPassword);
      u.mustChangePw = false;
      return true;
    });
    if (done === 'wrong') return bad(res, 'Current password is wrong.', 401);
    if (!done) return bad(res, 'Account not found.', 404);
    return ok(res, { ok: true });
  }

  if (p === '/api/logout' && method === 'POST') {
    const tok = parseCookies(req).hf_session;
    if (tok) await db.mutate((d) => { d.sessions = d.sessions.filter((s) => s.id !== tok); });
    clearCookie(res, 'hf_session');
    return ok(res, { ok: true });
  }

  // ---- admin ----
  if (p === '/api/admin/login' && method === 'POST') {
    const b = await readBody(req);
    if (!auth.verifyAdmin(b.user, b.pass)) return bad(res, 'Wrong admin login.', 401);
    const token = await db.mutate((d) => {
      const t = auth.newToken();
      d.sessions.push({ id: t, userId: null, admin: true, createdAt: new Date().toISOString() });
      return t;
    });
    setCookie(res, 'hf_admin', token);
    return ok(res, { ok: true });
  }
  if (p === '/api/admin/logout' && method === 'POST') {
    const tok = parseCookies(req).hf_admin;
    if (tok) await db.mutate((d) => { d.sessions = d.sessions.filter((s) => s.id !== tok); });
    clearCookie(res, 'hf_admin');
    return ok(res, { ok: true });
  }

  const admin = await adminSession(req);
  if (p.startsWith('/api/admin/')) {
    if (!admin) return bad(res, 'Admin login required.', 401);

    if (p === '/api/admin/members' && method === 'GET') {
      return ok(res, await db.read((d) => d.users.map((u) => ({
        id: u.id, username: u.username, name: u.name,
        mustChangePw: !!u.mustChangePw, createdAt: u.createdAt,
      }))));
    }
    if (p === '/api/admin/members' && method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 40);
      const username = String(b.username || '').trim().toLowerCase().slice(0, 30);
      if (!name) return bad(res, 'Name is required.');
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) return bad(res, 'Username: 3–30 chars, letters/numbers/._-');
      const password = String(b.password || '').trim() || auth.tempPassword();
      if (password.length < 6) return bad(res, 'Password must be at least 6 characters.');
      try {
        const created = await db.mutate((d) => {
          if (d.users.some((u) => u.username === username)) throwDup();
          const u = {
            id: db.nextId(d), username, name,
            passHash: auth.hashPassword(password), mustChangePw: true,
            createdAt: new Date().toISOString(),
          };
          d.users.push(u);
          d.ledger.members = d.users.map((x) => ({ id: x.id, name: x.name }));
          return { id: u.id, username, name, tempPassword: password };
        });
        return ok(res, created);
      } catch (e) { return bad(res, e.message === 'dup' ? 'That username is taken.' : e.message); }
    }
    if (p === '/api/admin/reset-password' && method === 'POST') {
      const b = await readBody(req);
      const temp = auth.tempPassword();
      const done = await db.mutate((d) => {
        const u = d.users.find((x) => x.id === String(b.userId));
        if (!u) return false;
        u.passHash = auth.hashPassword(temp);
        u.mustChangePw = true;
        d.sessions = d.sessions.filter((s) => s.userId !== u.id); // log them out
        return true;
      });
      if (!done) return bad(res, 'Member not found.', 404);
      return ok(res, { tempPassword: temp }); // shown once — admin tells the member
    }
    if (p === '/api/admin/delete-member' && method === 'POST') {
      const b = await readBody(req);
      await db.mutate((d) => {
        d.users = d.users.filter((u) => u.id !== String(b.userId));
        d.sessions = d.sessions.filter((s) => s.userId !== String(b.userId));
        d.ledger.members = d.users.map((x) => ({ id: x.id, name: x.name }));
      });
      return ok(res, { ok: true });
    }
    if (p === '/api/admin/export' && method === 'GET') {
      const dump = await db.read((d) => d);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="housefund-backup-' + new Date().toISOString().slice(0, 10) + '.json"',
      });
      return res.end(JSON.stringify(dump, null, 2));
    }
    if (p === '/api/admin/target' && method === 'POST') {
      const b = await readBody(req);
      const cents = dollarsToCents(b.target, 'Monthly target');
      await db.mutate((d) => { d.ledger.monthlyTarget = cents; });
      return ok(res, { ok: true });
    }
    if (p === '/api/admin/status' && method === 'GET') {
      return ok(res, await db.read((d) => ({
        backend: db.isPg() ? 'postgres' : 'json',
        members: d.users.length,
        txns: d.ledger.txns.length,
        monthlyTarget: d.ledger.monthlyTarget,
      })));
    }
    return bad(res, 'Not found.', 404);
  }

  // ---- member APIs ----
  const sess = await memberSession(req);
  if (!sess) return bad(res, 'Please log in.', 401);

  const monthOf = (q) => (/^\d{4}-\d{2}$/.test(q || '') ? q : thisMonth());

  if (p === '/api/me' && method === 'GET') return ok(res, { user: sess.user });

  if (p === '/api/members' && method === 'GET') {
    return ok(res, await db.read((d) => d.users.map((u) => ({ id: u.id, name: u.name, username: u.username }))));
  }

  if (p === '/api/summary' && method === 'GET') {
    const month = monthOf(url.searchParams.get('month'));
    return ok(res, await db.read((d) => {
      const members = d.users.map((u) => ({ id: u.id, name: u.name }));
      return {
        month,
        monthlyTarget: d.ledger.monthlyTarget,
        house: ledger.houseSummary(d.ledger, members, month),
        me: ledger.memberSummary(d.ledger, members, sess.user.id, month),
      };
    }));
  }

  if (p === '/api/activity' && method === 'GET') {
    const month = url.searchParams.get('month');
    return ok(res, await db.read((d) => {
      const members = d.users.map((u) => ({ id: u.id, name: u.name }));
      let txns = [...d.ledger.txns].reverse();
      if (/^\d{4}-\d{2}$/.test(month || '')) txns = txns.filter((t) => t.month === month);
      return txns.slice(0, 200).map((t) => ({
        ...t,
        allocs: d.ledger.allocs.filter((a) => a.txnId === t.id).map((a) => ({
          ...a, beneficiary: a.beneficiaryId ? members.find((m) => m.id === a.beneficiaryId)?.name : null,
        })),
        payerName: t.payerId ? members.find((m) => m.id === t.payerId)?.name : null,
        fromName: t.fromId && t.fromId !== 'house' ? members.find((m) => m.id === t.fromId)?.name : t.fromId,
        toName: t.toId ? members.find((m) => m.id === t.toId)?.name : null,
      }));
    }));
  }

  if (p === '/api/contributions' && method === 'POST') {
    const b = await readBody(req);
    try {
      const row = await db.mutate((d) => {
        if (!d.users.some((u) => u.id === String(b.userId))) throw new Error('Member not found.');
        return ledger.addContribution(d.ledger, {
          userId: String(b.userId), month: monthOf(b.month),
          cents: dollarsToCents(b.amount, 'Contribution'),
          paidBy: b.paidBy ? String(b.paidBy) : String(b.userId), by: sess.user.name,
        });
      });
      return ok(res, row);
    } catch (e) { return bad(res, e.message); }
  }

  if (p === '/api/expenses' && method === 'POST') {
    const b = await readBody(req);
    try {
      const out = await db.mutate((d) => ledger.postExpense(d.ledger, {
        payerId: String(b.payerId),
        cents: dollarsToCents(b.amount, 'Expense total'),
        merchant: String(b.merchant || '').slice(0, 60) || null,
        note: String(b.note || '').slice(0, 200) || null,
        date: String(b.date || '').slice(0, 10),
        allocs: (b.allocs || []).map((a) => ({
          kind: a.kind, cents: dollarsToCents(a.amount, 'Allocation'),
          beneficiaryId: a.beneficiaryId ? String(a.beneficiaryId) : null,
          note: a.note ? String(a.note).slice(0, 120) : null,
        })),
        receiptId: b.receiptId || null, by: sess.user.name,
      }));
      return ok(res, { id: out.txn.id });
    } catch (e) { return bad(res, e.message); }
  }

  if (p === '/api/settle' && method === 'POST') {
    const b = await readBody(req);
    try {
      const txn = await db.mutate((d) => ledger.postSettlement(d.ledger, {
        fromId: b.house ? 'house' : String(b.fromId),
        toId: String(b.toId),
        cents: dollarsToCents(b.amount, 'Settlement'),
        allocId: b.allocId || null, house: !!b.house,
        memo: String(b.memo || '').slice(0, 200) || null, by: sess.user.name,
      }));
      return ok(res, { id: txn.id });
    } catch (e) { return bad(res, e.message); }
  }

  if (p === '/api/reverse' && method === 'POST') {
    const b = await readBody(req);
    try {
      const rev = await db.mutate((d) => ledger.reverseTxn(d.ledger, String(b.txnId), sess.user.name));
      return ok(res, { id: rev.id });
    } catch (e) { return bad(res, e.message); }
  }

  // ---- bills ----
  if (p === '/api/bills' && method === 'GET') return ok(res, await db.read((d) => d.bills));
  if (p === '/api/bills' && method === 'POST') {
    const b = await readBody(req);
    const row = await db.mutate((d) => {
      const r = {
        id: db.nextId(d), name: String(b.name || '').slice(0, 60),
        cents: dollarsToCents(b.amount, 'Bill'), due: String(b.due || '').slice(0, 10),
        recurrence: String(b.recurrence || 'monthly').slice(0, 20),
        split: b.split || 'equal', payerId: b.payerId ? String(b.payerId) : null,
        status: 'unpaid', by: sess.user.name, at: new Date().toISOString(),
      };
      d.bills.push(r);
      return r;
    });
    return ok(res, row);
  }
  if (p === '/api/bills/pay' && method === 'POST') {
    const b = await readBody(req);
    try {
      const out = await db.mutate((d) => {
        const bill = d.bills.find((x) => x.id === String(b.billId));
        if (!bill) throw new Error('Bill not found.');
        if (bill.status === 'paid') throw new Error('Bill already paid.');
        const members = d.users.map((u) => u.id);
        const per = Math.floor(bill.cents / members.length);
        const allocs = members.map((id, i) => ({
          kind: 'personal', cents: i === members.length - 1 ? bill.cents - per * (members.length - 1) : per,
          beneficiaryId: id, note: bill.name,
        }));
        const { txn } = ledger.postExpense(d.ledger, {
          payerId: String(b.payerId || bill.payerId || sess.user.id),
          cents: bill.cents, merchant: bill.name, note: 'Bill payment',
          date: new Date().toISOString().slice(0, 10), allocs, by: sess.user.name,
        });
        bill.status = 'paid';
        bill.paidAt = new Date().toISOString();
        return { bill, txnId: txn.id };
      });
      return ok(res, out);
    } catch (e) { return bad(res, e.message); }
  }
  if (p === '/api/bills/delete' && method === 'POST') {
    const b = await readBody(req);
    await db.mutate((d) => { d.bills = d.bills.filter((x) => x.id !== String(b.billId)); });
    return ok(res, { ok: true });
  }

  // ---- shopping list ----
  if (p === '/api/shopping' && method === 'GET') return ok(res, await db.read((d) => d.shopping));
  if (p === '/api/shopping' && method === 'POST') {
    const b = await readBody(req);
    const row = await db.mutate((d) => {
      const r = {
        id: db.nextId(d), item: String(b.item || '').slice(0, 80),
        qty: String(b.qty || '').slice(0, 20),
        assignedTo: b.assignedTo ? String(b.assignedTo) : null,
        estCents: b.estAmount ? dollarsToCents(b.estAmount, 'Estimate') : 0,
        done: false, at: new Date().toISOString(),
      };
      d.shopping.push(r);
      return r;
    });
    return ok(res, row);
  }
  if (p === '/api/shopping/toggle' && method === 'POST') {
    const b = await readBody(req);
    await db.mutate((d) => {
      const r = d.shopping.find((x) => x.id === String(b.id));
      if (r) r.done = !r.done;
    });
    return ok(res, { ok: true });
  }
  if (p === '/api/shopping/delete' && method === 'POST') {
    const b = await readBody(req);
    await db.mutate((d) => { d.shopping = d.shopping.filter((x) => x.id !== String(b.id)); });
    return ok(res, { ok: true });
  }

  // ---- inventory ----
  if (p === '/api/inventory' && method === 'GET') return ok(res, await db.read((d) => d.inventory));
  if (p === '/api/inventory' && method === 'POST') {
    const b = await readBody(req);
    const row = await db.mutate((d) => {
      const r = {
        id: db.nextId(d), product: String(b.product || '').slice(0, 80),
        qty: String(b.qty || '').slice(0, 20), unit: String(b.unit || '').slice(0, 20),
        category: String(b.category || '').slice(0, 40),
        costCents: b.cost ? dollarsToCents(b.cost, 'Cost') : 0,
        boughtAt: String(b.boughtAt || '').slice(0, 10) || null,
        expires: String(b.expires || '').slice(0, 10) || null,
        at: new Date().toISOString(),
      };
      d.inventory.push(r);
      return r;
    });
    return ok(res, row);
  }
  if (p === '/api/inventory/delete' && method === 'POST') {
    const b = await readBody(req);
    await db.mutate((d) => { d.inventory = d.inventory.filter((x) => x.id !== String(b.id)); });
    return ok(res, { ok: true });
  }

  // ---- receipts (base64 photo in JSON; manual item entry for v1) ----
  if (p === '/api/receipts/scan' && method === 'POST') {
    const b = await readBody(req);
    const m = String(b.photo || '').match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) return bad(res, 'Photo must be a data URL.');
    if (!ocr.available()) return bad(res, 'Scanner not available on this server — enter items manually.', 503);
    const text = await ocr.scanImage(Buffer.from(m[2], 'base64'));
    if (!text.trim()) return bad(res, 'Could not read any text from that photo. Try a clearer shot.', 422);
    const parsed = parser.parseReceiptText(text);
    // Merchant guess: first text-y line of the receipt.
    let merchant = '';
    for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      if (/[a-zA-Z]{3,}/.test(line) && !/^\d/.test(line) && line.length < 40) { merchant = line; break; }
    }
    return ok(res, {
      merchant,
      total: parsed.detectedTotal,
      items: parsed.items.map((i) => ({ name: i.name_raw, amount: i.price })),
      note: 'Review before saving — the scanner guesses, you confirm.',
    });
  }
  if (p === '/api/receipts' && method === 'GET') {
    return ok(res, await db.read((d) => d.receipts.map((r) => ({ ...r, data: undefined }))));
  }
  if (p === '/api/receipts' && method === 'POST') {
    const b = await readBody(req);
    if (!b.photo || typeof b.photo !== 'string' || b.photo.length > 12 * 1024 * 1024) {
      return bad(res, 'Photo is required (max ~9MB).');
    }
    const m = b.photo.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) return bad(res, 'Photo must be a data URL.');
    const ext = m[1] === 'image/png' ? 'png' : 'jpg';
    const row = await db.mutate((d) => {
      const r = {
        id: db.nextId(d), txnId: b.txnId || null, file: 'rcpt-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.' + ext,
        merchant: String(b.merchant || '').slice(0, 60) || null,
        totalCents: b.total ? dollarsToCents(b.total, 'Total') : 0,
        items: Array.isArray(b.items) ? b.items.slice(0, 100).map((i) => ({
          name: String(i.name || '').slice(0, 80),
          cents: i.amount ? dollarsToCents(i.amount, 'Item') : 0,
        })) : [],
        status: 'recorded', by: sess.user.name, at: new Date().toISOString(),
      };
      d.receipts.push(r);
      return r;
    });
    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    fs.writeFileSync(path.join(RECEIPT_DIR, row.file), Buffer.from(m[2], 'base64'));
    return ok(res, { id: row.id });
  }
  const photoMatch = p.match(/^\/api\/receipt-photo\/([\w-]+)$/);
  if (photoMatch && method === 'GET') {
    const r = await db.read((d) => d.receipts.find((x) => x.id === photoMatch[1]));
    if (!r) return bad(res, 'Not found.', 404);
    const fp = path.join(RECEIPT_DIR, r.file);
    if (!fs.existsSync(fp)) return bad(res, 'Photo missing.', 404);
    res.writeHead(200, { 'Content-Type': r.file.endsWith('.png') ? 'image/png' : 'image/jpeg' });
    return fs.createReadStream(fp).pipe(res);
  }

  // ---- reports ----
  if (p === '/api/export.csv' && method === 'GET') {
    const csv = await db.read((d) => ledger.exportCsv(d.ledger, d.users.map((u) => ({ id: u.id, name: u.name }))));
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="housefund-ledger.csv"',
    });
    return res.end(csv);
  }

  // ---- backup pull (for the weekly Drive-backup cron; token-gated, 404 if unset) ----
  if (p === '/api/backup' && method === 'GET') {
    const token = url.searchParams.get('token');
    if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
      return bad(res, 'Not found.', 404);
    }
    const dump = await db.read((d) => d);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="housefund-backup-' + new Date().toISOString().slice(0, 10) + '.json"',
    });
    return res.end(JSON.stringify(dump));
  }

  return bad(res, 'Not found.', 404);
}

function throwDup() { throw new Error('dup'); }

// ------------------------------------------------------------ static ---

function serveStatic(req, res) {
  let p = new URL(req.url, 'http://x').pathname;
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const fp = path.join(PUBLIC, decodeURIComponent(p));
  if (!fp.startsWith(PUBLIC) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

// ------------------------------------------------------------ boot ---

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) await api(req, res);
    else serveStatic(req, res);
  } catch (e) {
    console.error('[server]', e.message);
    if (!res.headersSent) bad(res, 'Server error. Please try again.', 500);
  }
});

db.init().then(() => {
  server.listen(PORT, () => {
    console.log(`[housefund] listening on :${PORT} — backend: ${db.isPg() ? 'postgres' : 'json'}`);
    if (!auth.adminConfigured()) console.log('[housefund] WARNING: ADMIN_PASS not set — admin panel disabled until set.');
  });
});
