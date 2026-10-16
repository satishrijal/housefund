'use strict';
/**
 * Acceptance tests from the HouseFund brief, section 14.
 * Run: node --test test/ledger.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../ledger');

function house5() {
  const ledger = L.blankLedger();
  const members = [
    { id: 'alex', name: 'Alex' }, { id: 'ben', name: 'Ben' },
    { id: 'chris', name: 'Chris' }, { id: 'david', name: 'David' },
    { id: 'ethan', name: 'Ethan' },
  ];
  return { ledger, members };
}

test('3 pay $100, 2 pay $0 → collected $300, outstanding $200', () => {
  const { ledger, members } = house5();
  for (const id of ['alex', 'ben', 'chris']) {
    L.addContribution(ledger, { userId: id, month: '2026-10', cents: 10000, by: 'admin' });
  }
  const s = L.houseSummary(ledger, members, '2026-10');
  assert.equal(s.collected, 30000);
  assert.equal(s.contribOutstanding, 20000);
  const david = L.memberSummary(ledger, members, 'david', '2026-10');
  assert.equal(david.contribDue, 10000);
  const alex = L.memberSummary(ledger, members, 'alex', '2026-10');
  assert.equal(alex.contribDue, 0);
});

test('Chris pays $225: $100 covers David, $125 house advance — debts shown once', () => {
  const { ledger, members } = house5();
  const { txn, allocs } = L.postExpense(ledger, {
    payerId: 'chris', cents: 22500, merchant: 'Walmart', date: '2026-10-15',
    allocs: [
      { kind: 'cover', cents: 10000, beneficiaryId: 'david', note: "David's contribution" },
      { kind: 'house', cents: 12500, note: 'house advance' },
    ],
    by: 'chris',
  });
  assert.equal(allocs.length, 2);

  // David owes Chris exactly $100 (contribution covered)
  const david = L.memberSummary(ledger, members, 'david', '2026-10');
  assert.equal(david.contribPaid, 10000); // covered counts toward his target
  assert.equal(david.contribDue, 0);
  assert.equal(david.iOwe.length, 1);
  assert.equal(david.iOwe[0].toId, 'chris');
  assert.equal(david.iOwe[0].cents, 10000);

  // Household owes Chris $125
  assert.equal(L.houseOwesMember(ledger, 'chris'), 12500);

  // Chris's side shows both exactly once
  const chris = L.memberSummary(ledger, members, 'chris', '2026-10');
  assert.equal(chris.owedToMe.length, 1);
  assert.equal(chris.owedToMe[0].cents, 10000);
  assert.equal(chris.houseOwesMe, 12500);

  // No double counting: total open personal debt is $100, not $200
  const totalOpen = ['alex', 'ben', 'chris', 'david', 'ethan']
    .flatMap((id) => L.memberSummary(ledger, members, id, '2026-10').iOwe)
    .reduce((s, d) => s + d.cents, 0);
  assert.equal(totalOpen, 10000);
});

test('$25 partial settlement reduces only that liability', () => {
  const { ledger, members } = house5();
  const { allocs } = L.postExpense(ledger, {
    payerId: 'chris', cents: 22500, merchant: 'Walmart', date: '2026-10-15',
    allocs: [
      { kind: 'cover', cents: 10000, beneficiaryId: 'david' },
      { kind: 'house', cents: 12500 },
    ],
    by: 'chris',
  });
  const debtAlloc = allocs.find((a) => a.kind === 'cover');
  L.postSettlement(ledger, { fromId: 'david', toId: 'chris', cents: 2500, allocId: debtAlloc.id, by: 'david' });
  assert.equal(L.allocOpen(ledger, debtAlloc.id), 7500);
  // House advance untouched
  assert.equal(L.houseOwesMember(ledger, 'chris'), 12500);
  // Over-settlement rejected
  assert.throws(() => L.postSettlement(ledger, { fromId: 'david', toId: 'chris', cents: 8000, allocId: debtAlloc.id }),
    /too much/);
});

test('allocation totals must equal the payment', () => {
  const { ledger } = house5();
  assert.throws(() => L.postExpense(ledger, {
    payerId: 'chris', cents: 22500, merchant: 'Walmart', date: '2026-10-15',
    allocs: [{ kind: 'house', cents: 20000 }], // $200 vs $225
    by: 'chris',
  }), /must match exactly/);
});

test('reversal nets to zero; blocked when settled against', () => {
  const { ledger, members } = house5();
  const { txn, allocs } = L.postExpense(ledger, {
    payerId: 'chris', cents: 22500, merchant: 'Walmart', date: '2026-10-15',
    allocs: [
      { kind: 'cover', cents: 10000, beneficiaryId: 'david' },
      { kind: 'house', cents: 12500 },
    ],
    by: 'chris',
  });
  const debtAlloc = allocs.find((a) => a.kind === 'cover');
  L.postSettlement(ledger, { fromId: 'david', toId: 'chris', cents: 2500, allocId: debtAlloc.id });
  // Cannot reverse while a settlement references it
  assert.throws(() => L.reverseTxn(ledger, txn.id, 'admin'), /settlement/);

  // Fresh expense reverses cleanly to zero
  const r2 = L.postExpense(ledger, {
    payerId: 'ben', cents: 5000, merchant: 'Aldi', date: '2026-10-16',
    allocs: [{ kind: 'house', cents: 5000 }], by: 'ben',
  });
  L.reverseTxn(ledger, r2.txn.id, 'admin');
  assert.equal(L.houseOwesMember(ledger, 'ben'), 0);
  const s = L.houseSummary(ledger, members, '2026-10');
  assert.equal(s.spent, 22500); // reversed $50 no longer counts
});

test('house reimbursement reduces only the house debt', () => {
  const { ledger } = house5();
  L.postExpense(ledger, {
    payerId: 'chris', cents: 12500, merchant: 'Costco', date: '2026-10-15',
    allocs: [{ kind: 'house', cents: 12500 }], by: 'chris',
  });
  L.postSettlement(ledger, { fromId: 'house', toId: 'chris', cents: 5000, house: true, memo: 'reimbursement', by: 'admin' });
  assert.equal(L.houseOwesMember(ledger, 'chris'), 7500);
});

test('money is integer cents — no float drift', () => {
  const { ledger, members } = house5();
  L.addContribution(ledger, { userId: 'alex', month: '2026-10', cents: 3333, by: 'admin' });
  L.addContribution(ledger, { userId: 'alex', month: '2026-10', cents: 3333, by: 'admin' });
  L.addContribution(ledger, { userId: 'alex', month: '2026-10', cents: 3334, by: 'admin' });
  const s = L.memberSummary(ledger, members, 'alex', '2026-10');
  assert.equal(s.contribPaid, 10000);
  assert.equal(s.contribDue, 0);
});

test('monthly target is per-month: raise October to $150 without touching November', () => {
  const { ledger, members } = house5();
  L.setMonthlyTarget(ledger, '2026-10', 15000, 'admin');
  const oct = L.houseSummary(ledger, members, '2026-10');
  assert.equal(oct.target, 75000); // 5 x $150
  const nov = L.houseSummary(ledger, members, '2026-11');
  assert.equal(nov.target, 50000); // still default $100 x 5
  const david = L.memberSummary(ledger, members, 'david', '2026-10');
  assert.equal(david.contribDue, 15000);
});

test('IOU: David owes Alex $30 — shows in both summaries, partial + full settle', () => {
  const { ledger, members } = house5();
  const iou = L.addIou(ledger, { fromId: 'david', toId: 'alex', cents: 3000, note: 'pizza', by: 'david' });
  assert.equal(iou.openCents, 3000);
  let d = L.memberSummary(ledger, members, 'david', '2026-10');
  assert.equal(d.iOwe.length, 1);
  assert.equal(d.iOwe[0].to, 'Alex');
  assert.equal(d.iOwe[0].cents, 3000);
  let a = L.memberSummary(ledger, members, 'alex', '2026-10');
  assert.equal(a.owedToMe.length, 1);
  assert.equal(a.owedToMe[0].from, 'David');
  // partial payment
  L.settleIou(ledger, { iouId: iou.id, cents: 1000, by: 'david' });
  d = L.memberSummary(ledger, members, 'david', '2026-10');
  assert.equal(d.iOwe[0].cents, 2000);
  // overpay rejected
  assert.throws(() => L.settleIou(ledger, { iouId: iou.id, cents: 2500, by: 'david' }), /too much/);
  // full settle clears both sides
  L.settleIou(ledger, { iouId: iou.id, cents: 2000, by: 'david' });
  d = L.memberSummary(ledger, members, 'david', '2026-10');
  a = L.memberSummary(ledger, members, 'alex', '2026-10');
  assert.equal(d.iOwe.length, 0);
  assert.equal(a.owedToMe.length, 0);
});

test('IOU validation: no self-IOUs, positive amounts only', () => {
  const { ledger } = house5();
  assert.throws(() => L.addIou(ledger, { fromId: 'alex', toId: 'alex', cents: 1000 }), /themself/);
  assert.throws(() => L.addIou(ledger, { fromId: 'alex', toId: 'ben', cents: 0 }), /positive/);
  assert.throws(() => L.addIou(ledger, { fromId: 'alex', toId: 'ben' }), /positive/);
});
