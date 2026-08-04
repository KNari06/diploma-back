const { normalizeProductBrief } = require('./src/agent/core/lite/exploration/phase0/product-brief.util');
const O = 'https://acme.com/';

// 1. Prototype pollution via __proto__ / constructor
const p = normalizeProductBrief(JSON.parse('{"__proto__":{"polluted":true},"purpose":{"value":"x","source":"user"}}'), O);
console.log('1 proto pollution leaked?', ({} as any).polluted === true ? 'YES — BAD' : 'no');

// 2. Deeply nested / huge payload — does it blow up?
const deep: any = { purpose: { value: 'x', source: 'user' } };
let cur = deep; for (let i = 0; i < 5000; i++) { cur.n = {}; cur = cur.n; }
try { normalizeProductBrief(deep, O); console.log('2 deep nesting: survived'); }
catch (e: any) { console.log('2 deep nesting: THREW', e.message); }

// 3. Huge array — cap enforced before or after mapping?
const huge = { entities: { value: Array.from({length: 100000}, (_,i)=>'e'+i), source: 'observed', basis: 'b' } };
const t0 = Date.now(); const h = normalizeProductBrief(huge, O);
console.log('3 huge array:', h.entities.value.length, 'items in', Date.now()-t0, 'ms');

// 4. Does a frozen/getter-throwing input break purity?
const eviln: any = { purpose: {} };
Object.defineProperty(eviln.purpose, 'value', { get() { throw new Error('boom'); } });
try { normalizeProductBrief(eviln, O); console.log('4 throwing getter: survived'); }
catch (e: any) { console.log('4 throwing getter: THREW —', e.message); }

// 5. Is the input mutated? (purity)
const inp: any = { purpose: { value: '  x  ', source: 'user' }, entities: { value: ['a'], source: 'user' } };
const snap = JSON.stringify(inp); normalizeProductBrief(inp, O);
console.log('5 input mutated?', JSON.stringify(inp) === snap ? 'no' : 'YES — BAD');
