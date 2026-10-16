// Stub test for demo.html: extracts scripts, runs seed + tab renders with fake DOM.
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../demo.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
console.log('scripts found:', scripts.length);

// --- minimal DOM stub ---
const els = {};
function makeEl(id) {
  const el = {
    _id: id, _html: '', style: {}, value: '', dataset: { t: 'home' },
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, remove() {},
    querySelectorAll() { return []; },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
  };
  return el;
}
global.document = {
  getElementById: (id) => els[id] || (els[id] = makeEl(id)),
  createElement: () => makeEl('dyn'),
  querySelector: () => makeEl('q'),
  querySelectorAll: () => [],
};
global.window = global;
global.alert = (m) => { throw new Error('ALERT: ' + m); };
global.prompt = () => null;
global.confirm = () => true;

for (const [i, code] of scripts.entries()) {
  // driver appended inside eval so it shares scope with function declarations
  const driver = i === 1 ? '\n;globalThis.__demo={dGo,dAddTab,dAllocRow,dFExp,dFCon,dFSet,render,D};' : '';
  try {
    eval.call(global, code + driver);
    console.log('script', i, 'eval OK');
  } catch (e) {
    console.error('script', i, 'FAILED:', e.message);
    process.exit(1);
  }
}
// seed() and render() run at eval time (last script). Exercise tabs:
for (const t of ['home', 'activity', 'groceries', 'house']) {
  globalThis.__demo.dGo(t);
  console.log('tab', t, 'render OK');
}
// exercise add flows
globalThis.__demo.dAddTab('exp');
globalThis.__demo.dAllocRow();
globalThis.__demo.dAddTab('con');
globalThis.__demo.dAddTab('set');
console.log('DEMO SMOKE PASS');
console.log('DEMO SMOKE PASS');
