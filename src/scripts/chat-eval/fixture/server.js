/**
 * Web fixture for the Tier-2b run-on-fixture eval.
 *
 * A tiny, deterministic, offline web app the chat-authoring agent authors tests
 * against and those tests are then replayed. Ported from qait-testbed's DESIGN
 * (keyed elements, per-request flag reads, silent-functional bug behind a flag) —
 * NOT its code; this is web (Express + server-rendered HTML), the testbed is mobile.
 *
 * Three flows, every interactive element carries `id` + `data-testid` + a real
 * <label> so the resolver + identity fast-path resolve without guessing:
 *   - Login:    /login  → (demo@qait.dev / password) → /dashboard
 *   - Search:   /shop?q=…  server-side filter + visible result count
 *   - Checkout: /shop → add to cart → /cart → /checkout → /confirmation (totals)
 *
 * Broken-state: GET/POST /config/flags, POST /config/flags/reset. Default all-off
 * = clean. `shop.sf2-discount` on → checkout OMITS the 10% discount (total wrong-
 * high) while the DOM/flow stays intact — a silent-functional bug only an
 * assertion on the number can catch. That is exactly what false-green measures.
 *
 * No DB, no auth beyond a stub cookie, no clock/random in money math → a stable,
 * reproducible eval world. Run: `node server.js` (or `npm run chat-eval:fixture:serve`).
 */

'use strict';

const express = require('express');
const { getFlag, getAllFlags, setFlag, resetFlags } = require('./flag-store');

const app = express();
// 4400 avoids the local dev stack: 3000=qai-backend, 4100=runner, 4300=qait-testbed.
const PORT = Number(process.env.FIXTURE_PORT) || 4400;
const HOST = process.env.FIXTURE_HOST || '127.0.0.1';

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Demo credentials (stub, offline) ────────────────────────────────────────
const DEMO_EMAIL = 'demo@qait.dev';
const DEMO_PASSWORD = 'password';

// ── Catalog (mirrors qait-testbed's 8 fixed products, integer-cent prices) ───
const PRODUCTS = [
  { id: 'p1', name: 'Aurora Wireless Headphones', priceCents: 12999 },
  { id: 'p2', name: 'Nimbus Mechanical Keyboard', priceCents: 8950 },
  { id: 'p3', name: 'Vertex 4K Webcam', priceCents: 6499 },
  { id: 'p4', name: 'Pulse Fitness Band', priceCents: 4500 },
  { id: 'p5', name: 'Quantum Portable SSD 1TB', priceCents: 10999 },
  { id: 'p6', name: 'Halo Smart Desk Lamp', priceCents: 3299 },
  { id: 'p7', name: 'Terra Insulated Bottle', priceCents: 2400 },
  { id: 'p8', name: 'Comet Wireless Charger', priceCents: 2999 },
];
const findProduct = (id) => PRODUCTS.find((p) => p.id === id) || null;
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/**
 * Canonical money math (mirrors qait-testbed computeTotals): 10% off when
 * subtotal >= $100, 8% tax on the post-discount amount. The `sf2-discount` flag
 * SILENTLY drops the discount — the one divergence the false-green test targets.
 */
function computeTotals(lines) {
  const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const discountBroken = getFlag('shop.sf2-discount');
  const discountCents = !discountBroken && subtotalCents >= 10000 ? Math.round(subtotalCents * 0.1) : 0;
  const taxableCents = subtotalCents - discountCents;
  const taxCents = Math.round(taxableCents * 0.08);
  const totalCents = taxableCents + taxCents;
  return { subtotalCents, discountCents, taxCents, totalCents };
}

// ── Cart in a cookie (no server state → deterministic, no cleanup) ───────────
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function readCart(req) {
  try {
    const c = parseCookies(req).cart;
    if (!c) return [];
    const arr = JSON.parse(Buffer.from(c, 'base64').toString('utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function writeCart(res, cart) {
  const enc = Buffer.from(JSON.stringify(cart), 'utf8').toString('base64');
  res.setHeader('Set-Cookie', `cart=${enc}; Path=/; HttpOnly`);
}
function isAuthed(req) {
  return parseCookies(req).auth === '1';
}

// ── HTML layout ──────────────────────────────────────────────────────────────
function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · QAIT Web Fixture</title>
<style>
  body{font-family:system-ui,Arial,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
  header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #ddd;padding-bottom:.5rem;margin-bottom:1rem}
  nav a{margin-right:1rem}
  label{display:block;margin:.5rem 0 .25rem;font-weight:600}
  input{padding:.5rem;width:100%;max-width:320px;box-sizing:border-box}
  button{padding:.5rem 1rem;margin-top:.75rem;cursor:pointer}
  .product{border:1px solid #eee;padding:.75rem;margin:.5rem 0;display:flex;justify-content:space-between;align-items:center}
  .totals div{display:flex;justify-content:space-between;max-width:320px;padding:.15rem 0}
  .error{color:#b00020;font-weight:600}
</style></head>
<body>
<header>
  <nav><a href="/shop" id="nav-shop" data-testid="nav-shop">Shop</a><a href="/cart" id="nav-cart" data-testid="nav-cart">Cart</a></nav>
</header>
${body}
</body></html>`;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'qait-web-fixture' }));

// ── Flag config (broken-state control) ───────────────────────────────────────
app.get('/config/flags', (_req, res) => res.json(getAllFlags()));
app.post('/config/flags', (req, res) => {
  const body = req.body || {};
  const applied = {};
  for (const [id, value] of Object.entries(body)) applied[id] = setFlag(id, value);
  res.json({ applied, flags: getAllFlags() });
});
app.post('/config/flags/reset', (_req, res) => {
  resetFlags();
  res.json({ flags: getAllFlags() });
});

// ── Login flow ────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.redirect('/login'));

function loginPage(errorMsg) {
  return page('Login', `
  <h1 id="login-title" data-testid="login-title">Sign in</h1>
  ${errorMsg ? `<p class="error" id="login-error" data-testid="login-error">${errorMsg}</p>` : ''}
  <form method="post" action="/login" id="login-form" data-testid="login-form">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" data-testid="login-email" placeholder="demo@qait.dev" autocomplete="username">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" data-testid="login-password" autocomplete="current-password">
    <button type="submit" id="login-submit" data-testid="login-submit">Log in</button>
  </form>`);
}
app.get('/login', (_req, res) => res.send(loginPage(null)));
app.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (email === DEMO_EMAIL && password === DEMO_PASSWORD) {
    res.setHeader('Set-Cookie', 'auth=1; Path=/; HttpOnly');
    return res.redirect('/dashboard');
  }
  return res.status(401).send(loginPage('Invalid email or password.'));
});
app.get('/dashboard', (req, res) => {
  if (!isAuthed(req)) return res.redirect('/login');
  res.send(page('Dashboard', `
  <h1 id="dashboard-title" data-testid="dashboard-title">Dashboard</h1>
  <div id="user-avatar" data-testid="user-avatar" aria-label="User avatar" style="width:40px;height:40px;border-radius:50%;background:#4a4">🙂</div>
  <p id="welcome-message" data-testid="welcome-message">Welcome back, ${DEMO_EMAIL}!</p>`));
});

// ── Search flow ───────────────────────────────────────────────────────────────
app.get('/shop', (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const items = q ? PRODUCTS.filter((p) => p.name.toLowerCase().includes(q)) : PRODUCTS;
  // Silent-functional bug: `sf-search-count` reports the count off-by-one while
  // the product list itself still filters correctly — the DOM structure is
  // identical, only the count NUMBER is wrong. Only an assertion on that number
  // catches it (the search-flow analog of sf2-discount). Guarded so it never
  // yields a negative count on an empty result set.
  const countBroken = getFlag('shop.sf-search-count');
  const displayCount = countBroken ? items.length + 1 : items.length;
  const rows = items.map((p) => `
    <div class="product" data-testid="product-${p.id}">
      <span data-testid="product-name-${p.id}">${p.name}</span>
      <span data-testid="product-price-${p.id}">${money(p.priceCents)}</span>
      <form method="post" action="/cart/add" style="margin:0">
        <input type="hidden" name="productId" value="${p.id}">
        <button type="submit" id="add-${p.id}" data-testid="add-to-cart-${p.id}">Add to cart</button>
      </form>
    </div>`).join('');
  res.send(page('Shop', `
  <h1 id="shop-title" data-testid="shop-title">Products</h1>
  <form method="get" action="/shop" id="search-form" data-testid="search-form">
    <label for="search">Search products</label>
    <input id="search" name="q" type="search" data-testid="search-input" value="${q ? String(req.query.q) : ''}" placeholder="Search…">
    <button type="submit" id="search-submit" data-testid="search-submit">Search</button>
  </form>
  <h2 id="result-count" data-testid="result-count">${displayCount} result${displayCount === 1 ? '' : 's'}</h2>
  ${rows || '<p data-testid="no-results">No products found.</p>'}`));
});

// ── Checkout flow ─────────────────────────────────────────────────────────────
app.post('/cart/add', (req, res) => {
  const productId = (req.body && req.body.productId) || '';
  if (!findProduct(productId)) return res.status(404).send(page('Error', '<p class="error">Unknown product.</p>'));
  const cart = readCart(req);
  const existing = cart.find((l) => l.productId === productId);
  if (existing) existing.qty += 1;
  else cart.push({ productId, qty: 1 });
  writeCart(res, cart);
  res.redirect('/cart');
});

function cartLines(cart) {
  return cart
    .map((l) => {
      const p = findProduct(l.productId);
      if (!p) return null;
      const qty = Number(l.qty) || 0;
      return { productId: p.id, name: p.name, qty, unitPriceCents: p.priceCents, lineTotalCents: p.priceCents * qty };
    })
    .filter(Boolean);
}

app.get('/cart', (req, res) => {
  const lines = cartLines(readCart(req));
  const t = computeTotals(lines);
  const rows = lines.map((l) => `
    <div class="product" data-testid="cart-line-${l.productId}">
      <span>${l.name} × ${l.qty}</span><span>${money(l.lineTotalCents)}</span>
    </div>`).join('');
  res.send(page('Cart', `
  <h1 id="cart-title" data-testid="cart-title">Your cart</h1>
  ${rows || '<p data-testid="cart-empty">Your cart is empty.</p>'}
  <div class="totals" data-testid="cart-totals">
    <div><span>Subtotal</span><span data-testid="cart-subtotal">${money(t.subtotalCents)}</span></div>
    <div><span>Discount</span><span data-testid="cart-discount">${money(t.discountCents)}</span></div>
    <div><span>Tax</span><span data-testid="cart-tax">${money(t.taxCents)}</span></div>
    <div><span><b>Total</b></span><span data-testid="cart-total"><b>${money(t.totalCents)}</b></span></div>
  </div>
  ${lines.length ? '<p><a href="/checkout" id="go-checkout" data-testid="go-checkout" role="button" style="display:inline-block;padding:.5rem 1rem;border:1px solid #333;text-decoration:none;color:#111">Proceed to checkout</a></p>' : ''}`));
});

app.get('/checkout', (req, res) => {
  const lines = cartLines(readCart(req));
  if (lines.length === 0) return res.redirect('/cart');
  res.send(page('Checkout', `
  <h1 id="checkout-title" data-testid="checkout-title">Checkout</h1>
  <form method="post" action="/checkout" id="checkout-form" data-testid="checkout-form">
    <label for="name">Full name</label>
    <input id="name" name="name" type="text" data-testid="checkout-name">
    <label for="address">Address</label>
    <input id="address" name="address" type="text" data-testid="checkout-address">
    <button type="submit" id="place-order" data-testid="place-order">Place order</button>
  </form>`));
});

app.post('/checkout', (req, res) => {
  const lines = cartLines(readCart(req));
  if (lines.length === 0) return res.redirect('/cart');
  const { name, address } = req.body || {};
  if (!name || !address) {
    return res.status(400).send(page('Checkout', '<p class="error" data-testid="checkout-error">Name and address are required.</p><a href="/checkout">Back</a>'));
  }
  const t = computeTotals(lines);
  const orderId = `ord_${t.subtotalCents}_${lines.length}`; // deterministic (no clock/random)
  // Clear the cart on success.
  res.setHeader('Set-Cookie', 'cart=; Path=/; HttpOnly; Max-Age=0');
  res.send(page('Confirmation', `
  <h1 id="confirmation-title" data-testid="confirmation-title">Order confirmed</h1>
  <p id="order-id" data-testid="order-id">Order ${orderId}</p>
  <div class="totals" data-testid="confirmation-totals">
    <div><span>Subtotal</span><span data-testid="conf-subtotal">${money(t.subtotalCents)}</span></div>
    <div><span>Discount</span><span data-testid="conf-discount">${money(t.discountCents)}</span></div>
    <div><span>Tax</span><span data-testid="conf-tax">${money(t.taxCents)}</span></div>
    <div><span><b>Total</b></span><span data-testid="conf-total"><b>${money(t.totalCents)}</b></span></div>
  </div>`));
});

// ── Boot ──────────────────────────────────────────────────────────────────────
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST, () => {
      // eslint-disable-next-line no-console
      console.log(`[web-fixture] listening on http://${HOST}:${port}`);
      resolve(server);
    });
    // Surface EADDRINUSE (port already bound) as a clean rejection instead of an
    // unhandled 'error' event crashing the process with a raw stack.
    server.on('error', reject);
  });
}

if (require.main === module) start();

module.exports = { app, start, computeTotals, PRODUCTS, DEMO_EMAIL, DEMO_PASSWORD, PORT, HOST };
