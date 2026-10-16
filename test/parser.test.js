'use strict';
// Parser test: sample OCR text → items + total. Run: node --test test/parser.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReceiptText } = require('../parser');

const SAMPLE = `
WALMART SUPERCENTER
(214) 555-0132
09/28/2026 14:32
CHICKEN BREAST 12.99
WATER 24PK 4.98T
2X BANANAS 1.20
SUBTOTAL 19.17
TAX 1.12
TOTAL 20.29
CASH 20.29
THANK YOU FOR SHOPPING
`;

test('parses items and total from receipt text', () => {
  const r = parseReceiptText(SAMPLE);
  assert.equal(r.detectedTotal, 20.29);
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].name_raw, 'CHICKEN BREAST');
  assert.equal(r.items[0].price, 12.99);
  assert.equal(r.items[1].price, 4.98);
  assert.equal(r.items[2].name_raw, 'BANANAS');
});

test('junk lines never become items', () => {
  const r = parseReceiptText('TOTAL 20.29\nTAX 1.12\nTHANK YOU\n(214) 555-0132\n');
  assert.equal(r.items.length, 0);
});
