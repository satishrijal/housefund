'use strict';
/**
 * ledger.js — HouseFund pure ledger engine.
 *
 * Integer cents everywhere. Immutable transactions: corrections are posted
 * as reversing entries, never edits. No I/O here — operates on a plain
 * state object so it is trivially unit-testable.
 *
 * Allocation kinds (an expense is split into allocations that MUST sum to
 * the transaction total — validated):
 *   cover    — payer covers beneficiary's monthly contribution.
 *              Creates debt: beneficiary -> payer (unless gift flag).
 *   house    — the household fund owes the payer (a house advance).
 *   personal — beneficiary's personal purchase; beneficiary -> payer debt.
 *   gift     — no debt created.
 *
 * Settlements pay down ONE specific liability (an allocation, or a house
 * debt). Partial settlements allowed; over-settlement rejected.
 */

function blankLedger() {
  return {
    monthlyTarget: 10000, // legacy global per-member target (cents); per-month targets below win
    targets: {},          // {'YYYY-MM': centsPerMember} — admin can raise/lower per month
    contributions: [],    // {id, userId, month:'YYYY-MM', cents, paidBy, by, at}
    txns: [],             // {id, kind:'expense'|'settlement'|'reversal'|'iou'|'iou_settlement', cents, payerId,
                          //  fromId, toId, allocId, iouId, house, merchant, note, date, month,
                          //  receiptId, by, at, reverses, reversedBy}
    allocs: [],           // {id, txnId, kind:'cover'|'house'|'personal'|'gift',
                          //  cents, beneficiaryId, note}
    ious: [],             // personal IOUs: {id, fromId, toId, cents, openCents, note,
                          //  date, settled, settledAt, by, at}
    seq: 1,
  };
}

/** Backfill newer fields for ledgers created before they existed. */
function shape(L) {
  if (!L.targets || typeof L.targets !== 'object') L.targets = {};
  if (!Array.isArray(L.ious)) L.ious = [];
  if (!Array.isArray(L.contributions)) L.contributions = [];
  if (!Array.isArray(L.txns)) L.txns = [];
  if (!Array.isArray(L.allocs)) L.allocs = [];
  if (!Number.isFinite(L.seq)) L.seq = 1;
  return L;
}

/** Per-member monthly target for a month (cents). Falls back to legacy global, then $100. */
function targetFor(L, month) {
  shape(L);
  const t = L.targets[String(month)];
  if (Number.isFinite(t) && t > 0) return Math.round(t);
  if (Number.isFinite(L.monthlyTarget) && L.monthlyTarget > 0) return Math.round(L.monthlyTarget);
  return 10000;
}

/** Admin sets the per-member collection target for a month (e.g. raise it when big spending is coming). */
function setMonthlyTarget(L, month, cents, by) {
  shape(L);
  _assert(/^\d{4}-\d{2}$/.test(String(month)), 'Month must look like 2026-10.');
  const c = _cents(cents, 'Monthly target');
  L.targets[String(month)] = c;
  // NOTE: deliberately NOT syncing L.monthlyTarget — that field is only a
  // fallback for ledgers from before per-month targets existed.
  return { month: String(month), cents: c, by: by || null, at: _now() };
}

function _id(L) { return 'x' + (L.seq++); }
function _now() { return new Date().toISOString(); }
function _monthOf(dateStr) {
  const d = String(dateStr || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(0, 7) : new Date().toISOString().slice(0, 7);
}
function _assert(cond, msg) { if (!cond) throw new Error(msg); }
function _cents(n, label) {
  const c = Math.round(Number(n));
  _assert(Number.isFinite(c) && c > 0, (label || 'Amount') + ' must be a positive number.');
  return c;
}

const ALLOC_KINDS = ['cover', 'house', 'personal', 'gift'];

function addContribution(L, { userId, month, cents, paidBy, by }) {
  shape(L);
  _assert(userId, 'Member is required.');
  _assert(/^\d{4}-\d{2}$/.test(String(month)), 'Month must look like 2026-10.');
  const c = _cents(cents, 'Contribution');
  const row = {
    id: _id(L), userId: String(userId), month: String(month), cents: c,
    paidBy: paidBy ? String(paidBy) : String(userId),
    by: by || null, at: _now(),
  };
  L.contributions.push(row);
  return row;
}

/**
 * Post an expense. allocs: [{kind, cents, beneficiaryId?, note?}]
 * cover/personal REQUIRE beneficiaryId. Sum of allocs must equal cents.
 */
function postExpense(L, { payerId, cents, merchant, note, date, allocs, receiptId, by }) {
  shape(L);
  _assert(payerId, 'Payer is required.');
  const total = _cents(cents, 'Expense total');
  _assert(Array.isArray(allocs) && allocs.length > 0, 'Split the expense into at least one allocation.');
  let sum = 0;
  const rows = allocs.map((a) => {
    _assert(ALLOC_KINDS.includes(a.kind), 'Bad allocation kind: ' + a.kind);
    const c = _cents(a.cents, 'Allocation');
    if (a.kind === 'cover' || a.kind === 'personal') {
      _assert(a.beneficiaryId, 'Allocation "' + a.kind + '" needs the member it is for.');
    }
    sum += c;
    return {
      id: _id(L), txnId: null, kind: a.kind, cents: c,
      beneficiaryId: a.beneficiaryId ? String(a.beneficiaryId) : null,
      note: a.note || null,
    };
  });
  _assert(sum === total,
    'Allocations add up to ' + fmt(sum) + ' but the expense is ' + fmt(total) + '. They must match exactly.');
  const txn = {
    id: _id(L), kind: 'expense', cents: total, payerId: String(payerId),
    fromId: null, toId: null, allocId: null, house: false,
    merchant: merchant || null, note: note || null,
    date: String(date || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
    month: _monthOf(date), receiptId: receiptId || null,
    by: by || null, at: _now(), reverses: null, reversedBy: null,
  };
  L.txns.push(txn);
  for (const r of rows) { r.txnId = txn.id; L.allocs.push(r); }
  return { txn, allocs: rows };
}

/** Open (unsettled) amount of one allocation's debt. */
function allocOpen(L, allocId) {
  shape(L);
  const a = L.allocs.find((x) => x.id === allocId);
  _assert(a, 'Allocation not found.');
  if (a.kind === 'gift' || a.kind === 'house') return 0;
  const paid = L.txns
    .filter((t) => t.kind === 'settlement' && t.allocId === allocId && !t.reversedBy)
    .reduce((s, t) => s + t.cents, 0);
  return a.cents - paid;
}

/** What the household owes one member (house advances minus house reimbursements). */
function houseOwesMember(L, userId) {
  shape(L);
  const uid = String(userId);
  const advanced = L.allocs
    .filter((a) => a.kind === 'house' && allocLive(L, a))
    .filter((a) => txnOf(L, a.txnId).payerId === uid)
    .reduce((s, a) => s + a.cents, 0);
  const reimbursed = L.txns
    .filter((t) => t.kind === 'settlement' && t.house && t.toId === uid && !t.reversedBy)
    .reduce((s, t) => s + t.cents, 0);
  return advanced - reimbursed;
}

function txnOf(L, txnId) { return L.txns.find((t) => t.id === txnId); }
function txnVoided(L, txnId) {
  const t = txnOf(L, txnId);
  return !t || !!t.reversedBy;
}
/** An allocation counts toward balances only if its txn is live (not voided, not a reversal entry). */
function allocLive(L, a) {
  const t = txnOf(L, a.txnId);
  return !!t && !t.reversedBy && t.kind !== 'reversal';
}

/**
 * Settle one liability.
 *  - personal/cover debt: {fromId, toId, allocId, cents}
 *  - house reimbursement: {fromId:'house', toId, house:true, cents}
 */
function postSettlement(L, { fromId, toId, cents, allocId, house, memo, by }) {
  shape(L);
  const c = _cents(cents, 'Settlement');
  _assert(toId, 'Recipient is required.');
  let open, label;
  if (house) {
    _assert(fromId === 'house', 'House settlements come from the house fund.');
    open = houseOwesMember(L, toId);
    label = 'house debt';
  } else {
    _assert(allocId, 'Pick the specific debt this payment settles.');
    _assert(fromId && toId, 'Both sides of the settlement are required.');
    open = allocOpen(L, allocId);
    label = 'debt';
  }
  _assert(open > 0, 'That ' + label + ' is already fully settled.');
  _assert(c <= open, 'That ' + label + ' only has ' + fmt(open) + ' open — ' + fmt(c) + ' is too much.');
  const txn = {
    id: _id(L), kind: 'settlement', cents: c, payerId: null,
    fromId: String(fromId), toId: String(toId),
    allocId: allocId || null, house: !!house,
    merchant: null, note: memo || null,
    date: new Date().toISOString().slice(0, 10),
    month: new Date().toISOString().slice(0, 7),
    receiptId: null, by: by || null, at: _now(), reverses: null, reversedBy: null,
  };
  L.txns.push(txn);
  return txn;
}

/** Reverse a transaction with an offsetting entry. Blocked if settled against. */
function reverseTxn(L, txnId, by) {
  shape(L);
  const t = txnOf(L, txnId);
  _assert(t, 'Transaction not found.');
  _assert(!t.reversedBy, 'That transaction was already reversed.');
  _assert(t.kind === 'expense', 'Only expenses can be reversed.');
  const mine = L.allocs.filter((a) => a.txnId === txnId);
  for (const a of mine) {
    const settled = L.txns.some((s) => s.kind === 'settlement' && s.allocId === a.id && !s.reversedBy);
    _assert(!settled, 'Cannot reverse: a settlement was already made against this expense. Reverse the settlement first.');
  }
  const rev = {
    id: _id(L), kind: 'reversal', cents: t.cents, payerId: t.payerId,
    fromId: null, toId: null, allocId: null, house: false,
    merchant: t.merchant, note: 'Reversal of ' + (t.merchant || t.id),
    date: new Date().toISOString().slice(0, 10),
    month: new Date().toISOString().slice(0, 7),
    receiptId: null, by: by || null, at: _now(), reverses: txnId, reversedBy: null,
  };
  L.txns.push(rev);
  for (const a of mine) {
    L.allocs.push({
      id: _id(L), txnId: rev.id, kind: a.kind, cents: -a.cents,
      beneficiaryId: a.beneficiaryId, note: 'reversal',
    });
  }
  t.reversedBy = rev.id;
  return rev;
}

/**
 * Record a personal IOU: fromId owes toId. Separate from the house fund —
 * e.g. "David owes me $30 for the pizza". Either party can record it;
 * settling it is tracked below. Never fabricates: amounts are explicit.
 */
function addIou(L, { fromId, toId, cents, note, date, by }) {
  shape(L);
  _assert(fromId && toId, 'Both people are required.');
  _assert(String(fromId) !== String(toId), 'Someone cannot owe themself.');
  const c = _cents(cents, 'IOU amount');
  const iou = {
    id: _id(L), fromId: String(fromId), toId: String(toId),
    cents: c, openCents: c, note: String(note || '').slice(0, 140) || null,
    date: String(date || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
    settled: false, settledAt: null, by: by || null, at: _now(),
  };
  L.ious.push(iou);
  L.txns.push({
    id: _id(L), kind: 'iou', cents: c, payerId: null,
    fromId: iou.fromId, toId: iou.toId, allocId: null, iouId: iou.id, house: false,
    merchant: null, note: iou.note,
    date: iou.date, month: iou.date.slice(0, 7),
    receiptId: null, by: by || null, at: _now(), reverses: null, reversedBy: null,
  });
  return iou;
}

/** Pay down an IOU. Partial payments allowed; overpaying rejected. */
function settleIou(L, { iouId, cents, by }) {
  shape(L);
  const iou = L.ious.find((x) => x.id === String(iouId));
  _assert(iou, 'IOU not found.');
  _assert(!iou.settled, 'That IOU is already fully settled.');
  const c = _cents(cents, 'Payment');
  _assert(c <= iou.openCents, 'Only ' + fmt(iou.openCents) + ' is still owed — ' + fmt(c) + ' is too much.');
  iou.openCents -= c;
  if (iou.openCents === 0) { iou.settled = true; iou.settledAt = _now(); }
  const txn = {
    id: _id(L), kind: 'iou_settlement', cents: c, payerId: null,
    fromId: iou.fromId, toId: iou.toId, allocId: null, iouId: iou.id, house: false,
    merchant: null, note: iou.note ? 'IOU payment — ' + iou.note : 'IOU payment',
    date: new Date().toISOString().slice(0, 10),
    month: new Date().toISOString().slice(0, 7),
    receiptId: null, by: by || null, at: _now(), reverses: null, reversedBy: null,
  };
  L.txns.push(txn);
  return { iou, txn };
}

// ---------------------------------------------------------- summaries ---

function memberName(L, members, id) {
  const m = (members || []).find((x) => String(x.id) === String(id));
  return m ? m.name : 'Unknown';
}

/** Full per-member picture for one month. members: [{id,name}] for labels. */
function memberSummary(L, members, userId, month) {
  shape(L);
  const uid = String(userId);
  const target = targetFor(L, month);
  const direct = L.contributions
    .filter((c) => c.userId === uid && c.month === month)
    .reduce((s, c) => s + c.cents, 0);
  const covered = L.allocs
    .filter((a) => a.kind === 'cover' && a.beneficiaryId === uid && allocLive(L, a))
    .filter((a) => txnOf(L, a.txnId).month === month)
    .reduce((s, a) => s + a.cents, 0);
  const paid = direct + covered;

  const iOwe = [];
  const owedToMe = [];
  for (const a of L.allocs) {
    if (!allocLive(L, a)) continue;
    if (a.kind !== 'cover' && a.kind !== 'personal') continue;
    const open = allocOpen(L, a.id);
    if (open <= 0) continue;
    const t = txnOf(L, a.txnId);
    const why = (a.kind === 'cover' ? 'contribution covered: ' : 'personal: ') + (t.merchant || t.note || 'expense');
    if (a.beneficiaryId === uid) {
      iOwe.push({ toId: t.payerId, to: memberName(L, members, t.payerId), cents: open, why, allocId: a.id });
    } else if (t.payerId === uid) {
      owedToMe.push({ fromId: a.beneficiaryId, from: memberName(L, members, a.beneficiaryId), cents: open, why, allocId: a.id });
    }
  }
  // Personal IOUs (outside the house fund).
  for (const iou of L.ious) {
    if (iou.settled || iou.openCents <= 0) continue;
    const why = 'IOU' + (iou.note ? ': ' + iou.note : '');
    if (iou.fromId === uid) {
      iOwe.push({ toId: iou.toId, to: memberName(L, members, iou.toId), cents: iou.openCents, why, iouId: iou.id });
    } else if (iou.toId === uid) {
      owedToMe.push({ fromId: iou.fromId, from: memberName(L, members, iou.fromId), cents: iou.openCents, why, iouId: iou.id });
    }
  }
  const house = houseOwesMember(L, uid);
  return {
    userId: uid, month, target, contribPaid: paid, contribDue: target - paid,
    iOwe, owedToMe, houseOwesMe: house,
    net: owedToMe.reduce((s, d) => s + d.cents, 0) + house - iOwe.reduce((s, d) => s + d.cents, 0),
  };
}

/** Whole-house picture for one month. */
function houseSummary(L, members, month) {
  shape(L);
  const collected = L.contributions
    .filter((c) => c.month === month)
    .reduce((s, c) => s + c.cents, 0);
  const spent = L.txns
    .filter((t) => t.kind === 'expense' && t.month === month && !t.reversedBy)
    .reduce((s, t) => s + t.cents, 0);
  const memberIds = (members || []).map((m) => String(m.id));
  const perMember = memberIds.map((id) => memberSummary(L, members, id, month));
  const target = targetFor(L, month) * memberIds.length;
  return {
    month, target, collected,
    contribOutstanding: target - collected,
    spent,
    houseDebt: memberIds.reduce((s, id) => s + Math.max(0, houseOwesMember(L, id)), 0),
    perMember,
  };
}

/** CSV of every transaction, including voided ones and reversals (audit trail). */
function exportCsv(L, members) {
  shape(L);
  const rows = [['date', 'type', 'status', 'payer/from', 'to', 'amount', 'merchant/note', 'allocations']];
  for (const t of L.txns) {
    const status = t.kind === 'reversal' ? 'reversal' : (t.reversedBy ? 'voided' : 'live');
    const allocStr = L.allocs.filter((a) => a.txnId === t.id)
      .map((a) => a.kind + ':' + (a.cents / 100) + (a.beneficiaryId ? '>' + memberName(L, members, a.beneficiaryId) : '')).join('|');
    rows.push([
      t.date, t.kind, status,
      t.kind === 'settlement' ? (t.fromId === 'house' ? 'HOUSE' : memberName(L, members, t.fromId)) : memberName(L, members, t.payerId),
      t.kind === 'settlement' ? memberName(L, members, t.toId) : '',
      (t.cents / 100).toFixed(2),
      (t.merchant || '') + (t.note ? ' — ' + t.note : ''),
      allocStr,
    ]);
  }
  return rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
}

function fmt(cents) {
  const neg = cents < 0;
  const v = Math.abs(Math.round(cents)) / 100;
  return (neg ? '-$' : '$') + v.toFixed(2);
}

module.exports = {
  blankLedger, addContribution, postExpense, postSettlement, reverseTxn,
  allocOpen, houseOwesMember, memberSummary, houseSummary, exportCsv, fmt,
  targetFor, setMonthlyTarget, addIou, settleIou,
};
