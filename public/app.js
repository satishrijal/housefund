'use strict';
/* HouseFund app */
let ME = null, MEMBERS = [], MONTH = new Date().toISOString().slice(0, 7);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt$ = (c) => '$' + (Math.round(c) / 100).toFixed(2);

async function api(method, path, body) {
  const r = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}

// ------------------------------------------------------------- auth ---

async function boot() {
  try {
    const me = await api('GET', '/api/me');
    ME = me.user;
    MEMBERS = await api('GET', '/api/members');
    show('app'); go('home');
  } catch { show('login'); }
}
function show(id) {
  for (const x of ['login', 'forcepw', 'app']) $(x).classList.toggle('hidden', x !== id);
}
async function doLogin() {
  $('li-err').textContent = '';
  try {
    const r = await api('POST', '/api/login', { username: $('li-user').value.trim(), password: $('li-pass').value });
    if (r.mustChangePw) { show('forcepw'); }
    else boot();
  } catch (e) { $('li-err').textContent = e.message; }
}
async function doForcePw() {
  $('fp-err').textContent = '';
  const a = $('fp-new').value, b = $('fp-new2').value;
  if (a.length < 6) { $('fp-err').textContent = 'At least 6 characters.'; return; }
  if (a !== b) { $('fp-err').textContent = 'Passwords do not match.'; return; }
  try { await api('POST', '/api/change-password', { newPassword: a }); boot(); }
  catch (e) { $('fp-err').textContent = e.message; }
}
async function doLogout() { await api('POST', '/api/logout'); location.reload(); }

// ------------------------------------------------------------- tabs ---

function go(t) {
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('on', el.dataset.t === t));
  $('tab-title').textContent = { home: 'Home', activity: 'Activity', groceries: 'Groceries', house: 'House' }[t] || 'Home';
  ({ home: vHome, activity: vActivity, groceries: vGroceries, house: vHouse })[t]();
}

async function vHome() {
  const s = await api('GET', '/api/summary?month=' + MONTH);
  const h = s.house, me = s.me;
  const pct = h.target ? Math.min(100, Math.round(h.collected / h.target * 100)) : 0;
  let html = `<div class="card">
    <div class="row"><h3>Monthly fund</h3><span class="muted">${esc(MONTH)}</span></div>
    <div class="big">${fmt$(h.collected)} <span class="muted" style="font-size:16px">of ${fmt$(h.target)}</span></div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div class="row"><span class="muted">Collected</span>
    <span class="${h.contribOutstanding > 0 ? 'debt' : 'credit'}">${h.contribOutstanding > 0 ? fmt$(h.contribOutstanding) + ' still due' : 'Fully funded ✓'}</span></div>
  </div>`;

  html += `<div class="card"><h3>My status — ${esc(ME.name)}</h3>
    <div class="row" style="margin-top:8px"><span>Contribution</span>
      ${me.contribDue > 0 ? `<span class="pill warn">${fmt$(me.contribDue)} due</span>` : `<span class="pill ok">Paid ✓</span>`}</div>`;
  for (const d of me.iOwe) html += `<div class="row" style="margin-top:6px"><span class="muted">I owe ${esc(d.to)}</span><span class="debt">${fmt$(d.cents)}</span></div>`;
  for (const d of me.owedToMe) html += `<div class="row" style="margin-top:6px"><span class="muted">${esc(d.from)} owes me</span><span class="credit">${fmt$(d.cents)}</span></div>`;
  if (me.houseOwesMe > 0) html += `<div class="row" style="margin-top:6px"><span class="muted">House owes me</span><span class="credit">${fmt$(me.houseOwesMe)}</span></div>`;
  html += `</div>`;

  const bills = (await api('GET', '/api/bills')).filter((b) => b.status !== 'paid').slice(0, 3);
  if (bills.length) {
    html += `<div class="card"><h3>Upcoming bills</h3>` + bills.map((b) =>
      `<div class="row" style="margin-top:8px"><span>${esc(b.name)} <span class="muted">due ${esc(b.due)}</span></span><b>${fmt$(b.cents)}</b></div>`).join('') + `</div>`;
  }
  $('view').innerHTML = html;
}

async function vActivity() {
  const txns = await api('GET', '/api/activity?month=' + MONTH);
  let html = `<div class="card"><div class="row"><h3>Ledger</h3>
    <input id="m-filter" type="month" value="${MONTH}" style="width:auto" onchange="MONTH=this.value;vActivity()"></div>`;
  if (!txns.length) html += `<p class="muted">Nothing yet this month.</p>`;
  for (const t of txns) {
    const status = t.kind === 'reversal' ? ' <span class="pill warn">reversal</span>' : t.reversedBy ? ' <span class="pill bad">voided</span>' : '';
    html += `<div class="txn">
      <div class="row"><b>${esc(t.kind === 'expense' ? (t.merchant || 'Expense') : t.kind === 'settlement' ? 'Settlement' : 'Reversal')}</b>
      <b class="${t.kind === 'expense' ? 'debt' : 'credit'}">${t.kind === 'expense' ? '−' : '+'}${fmt$(t.cents)}</b></div>
      <div class="muted">${esc(t.date)} · ${esc(t.kind === 'settlement'
        ? (t.fromId === 'house' ? 'House' : esc(t.fromName)) + ' → ' + esc(t.toName)
        : 'paid by ' + esc(t.payerName))}${status}</div>`;
    for (const a of t.allocs || []) {
      const who = a.kind === 'house' ? 'house fund' : esc(a.beneficiary || '');
      html += `<div class="alloc"><b>${a.kind}</b> ${fmt$(a.cents)} → ${who}${a.note ? ' · ' + esc(a.note) : ''}</div>`;
    }
    if (t.note) html += `<div class="muted">${esc(t.note)}</div>`;
    if (!t.reversedBy && t.kind === 'expense') html += `<button class="btn ghost small" onclick="reverseTxn('${t.id}')">Reverse</button>`;
    html += `</div>`;
  }
  $('view').innerHTML = html + `</div>`;
}

async function reverseTxn(id) {
  if (!confirm('Reverse this expense? A reversing entry will be posted.')) return;
  try { await api('POST', '/api/reverse', { txnId: id }); vActivity(); }
  catch (e) { alert(e.message); }
}

// ---------------------------------------------------------------- add ---

let ALLOC_ROWS = [];
function openAdd() {
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('on', el.dataset.t === 'add'));
  $('tab-title').textContent = 'Add';
  ALLOC_ROWS = [];
  $('sheet-root').innerHTML = `<div class="scrim" onclick="closeSheet()"></div><div class="sheet">
    <h2>Add</h2>
    <div class="seg">
      <button class="on" id="seg-exp" onclick="addTab('exp')">Expense</button>
      <button id="seg-con" onclick="addTab('con')">Contribution</button>
      <button id="seg-set" onclick="addTab('set')">Settle up</button>
    </div>
    <div id="add-body"></div>
  </div>`;
  addTab('exp');
}
function closeSheet() { $('sheet-root').innerHTML = ''; go('home'); }
function addTab(t) {
  for (const x of ['exp', 'con', 'set']) $('seg-' + x).classList.toggle('on', x === t);
  ({ exp: fExpense, con: fContrib, set: fSettle })[t]();
}
const memberOpts = (sel) => MEMBERS.map((m) => `<option value="${m.id}"${m.id === sel ? ' selected' : ''}>${esc(m.name)}</option>`).join('');

function fExpense() {
  $('add-body').innerHTML = `
    <label>Who paid?</label><select id="e-payer">${memberOpts(ME.id)}</select>
    <label>Total amount ($)</label><input id="e-amt" type="number" step="0.01" min="0" placeholder="0.00">
    <label>Where / what</label><input id="e-merch" placeholder="Walmart, rent, …">
    <label>Date</label><input id="e-date" type="date" value="${new Date().toISOString().slice(0, 10)}">
    <label>Split the total — allocations must add up to the total</label>
    <div id="e-allocs"></div>
    <button class="btn ghost" onclick="allocRow()">+ Add split</button>
    <div id="e-sum" class="muted"></div>
    <button class="btn green" onclick="saveExpense()">Save expense</button>`;
  allocRow();
}
function allocRow() {
  const i = ALLOC_ROWS.length;
  ALLOC_ROWS.push(i);
  const div = document.createElement('div');
  div.className = 'alloc-row'; div.id = 'ar' + i;
  div.innerHTML = `
    <div class="row"><select id="ak${i}" onchange="updSum()">
      <option value="house">House fund owes payer</option>
      <option value="cover">Cover someone's contribution</option>
      <option value="personal">Personal purchase for…</option>
      <option value="gift">Gift (no debt)</option>
    </select>
    <button class="btn ghost small" onclick="document.getElementById('ar${i}').remove();ALLOC_ROWS=ALLOC_ROWS.filter(x=>x!==${i});updSum()">✕</button></div>
    <select id="ab${i}">${memberOpts('')}</select>
    <input id="aa${i}" type="number" step="0.01" min="0" placeholder="Amount $" oninput="updSum()">`;
  $('e-allocs').appendChild(div);
}
function updSum() {
  let s = 0;
  for (const i of ALLOC_ROWS) {
    const el = $('aa' + i);
    if (el && el.value) s += Math.round(parseFloat(el.value) * 100);
  }
  $('e-sum').textContent = 'Splits total: ' + fmt$(s);
}
async function saveExpense() {
  const allocs = [];
  for (const i of ALLOC_ROWS) {
    if (!$('aa' + i)) continue;
    allocs.push({ kind: $('ak' + i).value, amount: $('aa' + i).value, beneficiaryId: $('ab' + i).value || null });
  }
  try {
    await api('POST', '/api/expenses', {
      payerId: $('e-payer').value, amount: $('e-amt').value,
      merchant: $('e-merch').value, date: $('e-date').value, allocs,
    });
    closeSheet();
  } catch (e) { alert(e.message); }
}

function fContrib() {
  $('add-body').innerHTML = `
    <label>For whom?</label><select id="c-who">${memberOpts(ME.id)}</select>
    <label>Amount ($)</label><input id="c-amt" type="number" step="0.01" min="0" placeholder="100.00">
    <label>Month</label><input id="c-month" type="month" value="${MONTH}">
    <button class="btn green" onclick="saveContrib()">Record contribution</button>`;
}
async function saveContrib() {
  try {
    await api('POST', '/api/contributions', {
      userId: $('c-who').value, amount: $('c-amt').value, month: $('c-month').value, paidBy: ME.id,
    });
    closeSheet();
  } catch (e) { alert(e.message); }
}

async function fSettle() {
  const s = await api('GET', '/api/summary?month=' + MONTH);
  const debts = [];
  for (const d of s.me.iOwe) debts.push({ label: `I owe ${d.to} ${fmt$(d.cents)} — ${d.why}`, allocId: d.allocId, toName: d.to, max: d.cents });
  window.SETTLE_DEBTS = debts;
  $('add-body').innerHTML = `
    <label>Pay what?</label>
    <select id="s-debt">${debts.map((d, i) => `<option value="${i}">${esc(d.label)}</option>`).join('') || '<option value="">No open debts 🎉</option>'}</select>
    <label>Amount ($)</label><input id="s-amt" type="number" step="0.01" min="0" placeholder="0.00">
    <button class="btn green" onclick="saveSettle()">Record payment</button>
    <p class="muted">Paying the house back (reimbursement to a member) is done from the House tab.</p>`;
}
async function saveSettle() {
  const d = (window.SETTLE_DEBTS || [])[+$('s-debt').value];
  if (!d) return;
  try {
    const toId = MEMBERS.find((m) => m.name === d.toName)?.id;
    await api('POST', '/api/settle', { fromId: ME.id, toId, amount: $('s-amt').value, allocId: d.allocId });
    closeSheet();
  } catch (e) { alert(e.message); }
}

// ----------------------------------------------------------- groceries ---

async function vGroceries() {
  const [list, inv, receipts] = await Promise.all([
    api('GET', '/api/shopping'), api('GET', '/api/inventory'), api('GET', '/api/receipts'),
  ]);
  let html = `<div class="card"><div class="row"><h3>Shopping list</h3>
    <button class="btn green small" onclick="addItem()">+ Add</button></div>
    <div id="shop-new" class="hidden">
      <input id="sn-item" placeholder="Item"><input id="sn-qty" placeholder="Qty (e.g. 2)">
      <select id="sn-who"><option value="">Anyone</option>${memberOpts('')}</select>
      <button class="btn green small" onclick="saveItem()">Save</button></div>`;
  for (const it of list) {
    html += `<div class="row" style="padding:8px 0; border-bottom:1px solid var(--line)">
      <span><input type="checkbox" ${it.done ? 'checked' : ''} onchange="toggleItem('${it.id}')" style="width:auto">
      <b style="${it.done ? 'text-decoration:line-through' : ''}">${esc(it.item)}</b>
      <span class="muted">${esc(it.qty || '')}${it.assignedTo ? ' · ' + esc(nameOf(it.assignedTo)) : ''}</span></span>
      <button class="btn ghost small" onclick="delItem('${it.id}')">✕</button></div>`;
  }
  html += `</div><div class="card"><div class="row"><h3>Inventory</h3>
    <button class="btn green small" onclick="addInv()">+ Add</button></div>
    <div id="inv-new" class="hidden">
      <input id="in-prod" placeholder="Product"><input id="in-qty" placeholder="Qty">
      <input id="in-cat" placeholder="Category (dairy, pantry…)">
      <button class="btn green small" onclick="saveInv()">Save</button></div>`;
  for (const p of inv) {
    html += `<div class="row" style="padding:6px 0"><span><b>${esc(p.product)}</b> <span class="muted">${esc(p.qty || '')} ${esc(p.category || '')}</span></span>
      <button class="btn ghost small" onclick="delInv('${p.id}')">✕</button></div>`;
  }
  html += `</div><div class="card"><div class="row"><h3>Receipts</h3>
    <button class="btn green small" onclick="addReceipt()">📷 Upload</button></div>
    <div id="rc-new" class="hidden">
      <input type="file" id="rc-file" accept="image/*">
      <div class="row"><button class="btn ghost small" onclick="scanReceipt()">Scan with AI</button>
      <span class="muted" id="rc-scanmsg"></span></div>
      <input id="rc-merch" placeholder="Store"><input id="rc-total" type="number" step="0.01" placeholder="Total $">
      <div id="rc-items"></div>
      <button class="btn green small" onclick="saveReceipt()">Save receipt</button>
      <p class="muted">Scan reads the photo — you review and fix before saving.</p></div>`;
  for (const r of receipts.slice().reverse().slice(0, 10)) {
    html += `<div class="row" style="padding:6px 0"><span>${esc(r.merchant || 'Receipt')} <span class="muted">${esc(r.at.slice(0, 10))}</span></span>
      <span><b>${fmt$(r.totalCents)}</b> <a href="/api/receipt-photo/${r.id}" target="_blank" class="muted">view</a></span></div>`;
  }
  $('view').innerHTML = html + `</div>`;
}
const nameOf = (id) => (MEMBERS.find((m) => m.id === id) || {}).name || '';
async function addItem() { $('shop-new').classList.toggle('hidden'); }
async function saveItem() {
  await api('POST', '/api/shopping', { item: $('sn-item').value, qty: $('sn-qty').value, assignedTo: $('sn-who').value || null });
  vGroceries();
}
async function toggleItem(id) { await api('POST', '/api/shopping/toggle', { id }); vGroceries(); }
async function delItem(id) { await api('POST', '/api/shopping/delete', { id }); vGroceries(); }
async function addInv() { $('inv-new').classList.toggle('hidden'); }
async function saveInv() {
  await api('POST', '/api/inventory', { product: $('in-prod').value, qty: $('in-qty').value, category: $('in-cat').value });
  vGroceries();
}
async function delInv(id) { await api('POST', '/api/inventory/delete', { id }); vGroceries(); }
async function addReceipt() { $('rc-new').classList.toggle('hidden'); }
let RC_ITEMS = [];
async function scanReceipt() {
  const f = $('rc-file').files[0];
  if (!f) { alert('Pick a photo first.'); return; }
  $('rc-scanmsg').textContent = 'Scanning… (takes ~20s first time)';
  const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
  try {
    const r = await api('POST', '/api/receipts/scan', { photo: data });
    $('rc-scanmsg').textContent = '';
    if (r.merchant) $('rc-merch').value = r.merchant;
    if (r.total) $('rc-total').value = r.total;
    RC_ITEMS = r.items || [];
    renderRcItems();
    if (!RC_ITEMS.length) alert('No line items found — check the total and add items manually if needed.');
  } catch (e) {
    $('rc-scanmsg').textContent = '';
    alert(e.message);
  }
}
function renderRcItems() {
  $('rc-items').innerHTML = RC_ITEMS.map((it, i) => `<div class="row" style="gap:6px">
    <input id="rci-n${i}" value="${it.name.replace(/"/g, '&quot;')}" style="flex:2">
    <input id="rci-a${i}" type="number" step="0.01" value="${it.amount}" style="flex:1;max-width:90px">
    <button class="btn ghost small" onclick="RC_ITEMS.splice(${i},1);renderRcItems()">✕</button></div>`).join('')
    + (RC_ITEMS.length ? `<button class="btn ghost small" onclick="RC_ITEMS.push({name:'',amount:''});renderRcItems()">+ Add item</button>` : '');
}
async function saveReceipt() {
  const f = $('rc-file').files[0];
  if (!f) { alert('Pick a photo first.'); return; }
  const items = RC_ITEMS.map((_, i) => ({ name: $('rci-n' + i).value, amount: $('rci-a' + i).value }))
    .filter((x) => x.name.trim());
  const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
  try {
    await api('POST', '/api/receipts', { photo: data, merchant: $('rc-merch').value, total: $('rc-total').value, items });
    RC_ITEMS = [];
    vGroceries();
  } catch (e) { alert(e.message); }
}

// --------------------------------------------------------------- house ---

async function vHouse() {
  const s = await api('GET', '/api/summary?month=' + MONTH);
  const bills = await api('GET', '/api/bills');
  let html = `<div class="card"><h3>Roommates</h3>`;
  for (const m of s.house.perMember) {
    const nm = MEMBERS.find((x) => x.id === m.userId)?.name || '?';
    html += `<div class="row" style="padding:8px 0; border-bottom:1px solid var(--line)">
      <span><b>${esc(nm)}</b><br><span class="muted">${m.iOwe.length ? 'owes ' + fmt$(m.iOwe.reduce((a, d) => a + d.cents, 0)) : 'settled ✓'}</span></span>
      ${m.contribDue > 0 ? `<span class="pill warn">${fmt$(m.contribDue)} due</span>` : `<span class="pill ok">paid</span>`}</div>`;
  }
  html += `</div><div class="card"><div class="row"><h3>Bills</h3>
    <button class="btn green small" onclick="addBill()">+ Add</button></div>
    <div id="bill-new" class="hidden">
      <input id="bn-name" placeholder="Internet, rent…"><input id="bn-amt" type="number" step="0.01" placeholder="Amount $">
      <input id="bn-due" type="date"><button class="btn green small" onclick="saveBill()">Save</button></div>`;
  for (const b of bills) {
    html += `<div class="row" style="padding:8px 0; border-bottom:1px solid var(--line)">
      <span><b>${esc(b.name)}</b><br><span class="muted">due ${esc(b.due)} · ${fmt$(b.cents)}</span></span>
      ${b.status === 'paid' ? '<span class="pill ok">paid</span>' :
        `<span><button class="btn green small" onclick="payBill('${b.id}')">Mark paid</button>
         <button class="btn ghost small" onclick="delBill('${b.id}')">✕</button></span>`}</div>`;
  }
  html += `</div><div class="card"><h3>Reports & backup</h3>
    <button class="btn ghost" onclick="location.href='/api/export.csv'">⬇ Download ledger CSV</button>
    <p class="muted">Full backup (everything, including photos list) is in the admin panel.</p></div>`;
  $('view').innerHTML = html;
}
async function addBill() { $('bill-new').classList.toggle('hidden'); }
async function saveBill() {
  await api('POST', '/api/bills', { name: $('bn-name').value, amount: $('bn-amt').value, due: $('bn-due').value });
  vHouse();
}
async function payBill(id) {
  const payer = prompt('Who paid? Enter name:', ME.name);
  const m = MEMBERS.find((x) => x.name.toLowerCase() === String(payer || '').toLowerCase());
  try { await api('POST', '/api/bills/pay', { billId: id, payerId: m ? m.id : ME.id }); vHouse(); }
  catch (e) { alert(e.message); }
}
async function delBill(id) { if (confirm('Delete this bill?')) { await api('POST', '/api/bills/delete', { billId: id }); vHouse(); } }

boot();
