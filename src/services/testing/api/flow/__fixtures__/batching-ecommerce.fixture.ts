/**
 * Batching stress fixture — 25-endpoint e-commerce marketplace API.
 *
 * The whole point: this fixture has MORE than MAX_ENDPOINTS_PER_BATCH (20),
 * so the resolver splits into ≥2 chunks and runs Architect on each chunk in
 * parallel via Promise.all. Each Architect call sees ONLY its own chunk, so
 * cross-batch dependencies (e.g. POST /cart/items in batch 2 depending on
 * POST /products in batch 1) are structurally impossible for the AI to wire.
 *
 * This fixture measures how much of that loss is recovered by:
 *   1. The AI merger call (only runs when chunks ≤ 4)
 *   2. The deterministic post-processing (autoWireCrudDependencies, Rule 4 especially)
 *
 * Domain: E-commerce — users → stores → products → carts → orders → payments/reviews.
 * Realistic cross-resource dependency chain that forces cross-batch references.
 *
 * How the test uses this: the AI mock returns the idealArchitectOutput SPLIT
 * by chunk — each Architect call gets nodes matching its input endpoints, and
 * only dependsOn that point to IDs within the same chunk. Any cross-chunk
 * dependency (e.g. createCartItem → createProduct) is DROPPED in the per-batch
 * output. This simulates what a real LLM does: it can only wire what it sees.
 */

import type { ResolverFixture } from './types';
import type { ParsedEndpoint } from '../flow.types';

const ep = (
  id: string,
  method: ParsedEndpoint['method'],
  path: string,
  pathParams: string[] = [],
  hasBody = false,
  bodyFields: string[] = [],
): ParsedEndpoint => ({
  operationId: id,
  method,
  path,
  summary: id,
  tags: ['ecommerce'],
  parameters: pathParams.map(name => ({
    name,
    in: 'path' as const,
    required: true,
    schema: { type: name.endsWith('Id') || name.endsWith('_id') ? 'integer' : 'string' },
  })),
  requestBody: hasBody
    ? {
        contentType: 'application/json',
        required: true,
        schema: {
          type: 'object',
          properties: bodyFields.reduce<Record<string, any>>((acc, f) => {
            acc[f] = { type: f.endsWith('Id') || f.endsWith('_id') ? 'integer' : 'string' };
            return acc;
          }, {}),
        },
      }
    : undefined,
  responses: {
    '200': {
      description: 'ok',
      schema: { type: 'object', properties: { id: { type: 'integer' } } },
    },
  },
  security: [],
});

// ─────────────────────────────────────────────────────────────────────────────
// 25 endpoints, ordered so batching splits dependencies cross-batch
// ─────────────────────────────────────────────────────────────────────────────

const endpoints: ParsedEndpoint[] = [
  // Batch 1 expected (first 20 when MAX_ENDPOINTS_PER_BATCH=20)
  ep('createUser', 'POST', '/users', [], true, ['email', 'name']),
  ep('getUser', 'GET', '/users/{userId}', ['userId']),
  ep('updateUser', 'PUT', '/users/{userId}', ['userId'], true, ['name']),

  ep('createStore', 'POST', '/stores', [], true, ['ownerId', 'name']),
  ep('getStore', 'GET', '/stores/{storeId}', ['storeId']),
  ep('updateStore', 'PUT', '/stores/{storeId}', ['storeId'], true, ['name']),
  ep('deleteStore', 'DELETE', '/stores/{storeId}', ['storeId']),

  ep('createProduct', 'POST', '/products', [], true, ['storeId', 'name', 'price']),
  ep('getProduct', 'GET', '/products/{productId}', ['productId']),
  ep('updateProduct', 'PUT', '/products/{productId}', ['productId'], true, ['price']),
  ep('deleteProduct', 'DELETE', '/products/{productId}', ['productId']),
  ep('listProducts', 'GET', '/products', []),

  ep('createProductImage', 'POST', '/products/{productId}/images', ['productId'], true, ['url']),
  ep('getProductImage', 'GET', '/products/{productId}/images/{imageId}', ['productId', 'imageId']),
  ep('deleteProductImage', 'DELETE', '/products/{productId}/images/{imageId}', ['productId', 'imageId']),

  ep('createCart', 'POST', '/carts', [], true, ['userId']),
  ep('getCart', 'GET', '/carts/{cartId}', ['cartId']),
  ep('deleteCart', 'DELETE', '/carts/{cartId}', ['cartId']),

  ep('createCartItem', 'POST', '/carts/{cartId}/items', ['cartId'], true, ['productId', 'qty']),
  ep('getCartItem', 'GET', '/carts/{cartId}/items/{itemId}', ['cartId', 'itemId']),

  // Batch 2 expected (next 5+)
  ep('deleteCartItem', 'DELETE', '/carts/{cartId}/items/{itemId}', ['cartId', 'itemId']),

  ep('createOrder', 'POST', '/orders', [], true, ['cartId', 'userId']),
  ep('getOrder', 'GET', '/orders/{orderId}', ['orderId']),

  ep('createReview', 'POST', '/reviews', [], true, ['userId', 'productId', 'rating']),
  ep('getReview', 'GET', '/reviews/{reviewId}', ['reviewId']),
];

// ─────────────────────────────────────────────────────────────────────────────
// Build the "ideal" AI output — this is what a PERFECT architect would return
// if it saw all 25 endpoints in one shot. We split it per-batch in the test.
// ─────────────────────────────────────────────────────────────────────────────

const node = (
  id: string,
  method: any,
  path: string,
  dependsOn: string[] = [],
  extractVar: string | null = null,
  injectVars: Array<{ name: string; as: 'path_param' | 'body_field'; key: string }> = [],
) => ({
  id,
  method,
  path,
  operationId: id,
  summary: id,
  tags: ['ecommerce'],
  dependsOn,
  variableExtractions: extractVar
    ? [{ variableName: extractVar, jsonPath: '$.id' }]
    : [],
  variableInjections: injectVars.map(v => ({
    variableName: v.name,
    injectAs: v.as,
    targetKey: v.key,
  })),
  priority: dependsOn.length,
  isAuthEndpoint: false,
  isPagination: false,
  hasFileUpload: false,
  isUnsupported: false,
  canRunParallel: false,
  sampleRequestBody: null,
  expectedStatusCodes: [200, 201, 204],
});

const idealNodes = [
  node('createUser', 'POST', '/users', [], 'user_id'),
  node('getUser', 'GET', '/users/{userId}', ['createUser'], null, [
    { name: 'user_id', as: 'path_param', key: 'userId' },
  ]),
  node('updateUser', 'PUT', '/users/{userId}', ['createUser'], null, [
    { name: 'user_id', as: 'path_param', key: 'userId' },
  ]),

  node('createStore', 'POST', '/stores', ['createUser'], 'store_id', [
    { name: 'user_id', as: 'body_field', key: 'ownerId' },
  ]),
  node('getStore', 'GET', '/stores/{storeId}', ['createStore'], null, [
    { name: 'store_id', as: 'path_param', key: 'storeId' },
  ]),
  node('updateStore', 'PUT', '/stores/{storeId}', ['createStore'], null, [
    { name: 'store_id', as: 'path_param', key: 'storeId' },
  ]),
  node('deleteStore', 'DELETE', '/stores/{storeId}', ['createStore', 'updateStore'], null, [
    { name: 'store_id', as: 'path_param', key: 'storeId' },
  ]),

  node('createProduct', 'POST', '/products', ['createStore'], 'product_id', [
    { name: 'store_id', as: 'body_field', key: 'storeId' },
  ]),
  node('getProduct', 'GET', '/products/{productId}', ['createProduct'], null, [
    { name: 'product_id', as: 'path_param', key: 'productId' },
  ]),
  node('updateProduct', 'PUT', '/products/{productId}', ['createProduct'], null, [
    { name: 'product_id', as: 'path_param', key: 'productId' },
  ]),
  node('deleteProduct', 'DELETE', '/products/{productId}', ['createProduct', 'updateProduct'], null, [
    { name: 'product_id', as: 'path_param', key: 'productId' },
  ]),
  node('listProducts', 'GET', '/products', []),

  node('createProductImage', 'POST', '/products/{productId}/images', ['createProduct'], 'image_id', [
    { name: 'product_id', as: 'path_param', key: 'productId' },
  ]),
  node(
    'getProductImage',
    'GET',
    '/products/{productId}/images/{imageId}',
    ['createProduct', 'createProductImage'],
    null,
    [
      { name: 'product_id', as: 'path_param', key: 'productId' },
      { name: 'image_id', as: 'path_param', key: 'imageId' },
    ],
  ),
  node(
    'deleteProductImage',
    'DELETE',
    '/products/{productId}/images/{imageId}',
    ['createProductImage', 'getProductImage'],
    null,
    [
      { name: 'product_id', as: 'path_param', key: 'productId' },
      { name: 'image_id', as: 'path_param', key: 'imageId' },
    ],
  ),

  node('createCart', 'POST', '/carts', ['createUser'], 'cart_id', [
    { name: 'user_id', as: 'body_field', key: 'userId' },
  ]),
  node('getCart', 'GET', '/carts/{cartId}', ['createCart'], null, [
    { name: 'cart_id', as: 'path_param', key: 'cartId' },
  ]),
  node('deleteCart', 'DELETE', '/carts/{cartId}', ['createCart'], null, [
    { name: 'cart_id', as: 'path_param', key: 'cartId' },
  ]),

  // ↓ this node references BOTH cart (batch 1) AND product (batch 1) — same batch
  // but note: createCart is near end of batch 1, createProduct is early — OK within batch
  node(
    'createCartItem',
    'POST',
    '/carts/{cartId}/items',
    ['createCart', 'createProduct'],
    'cart_item_id',
    [
      { name: 'cart_id', as: 'path_param', key: 'cartId' },
      { name: 'product_id', as: 'body_field', key: 'productId' },
    ],
  ),
  node(
    'getCartItem',
    'GET',
    '/carts/{cartId}/items/{itemId}',
    ['createCart', 'createCartItem'],
    null,
    [
      { name: 'cart_id', as: 'path_param', key: 'cartId' },
      { name: 'cart_item_id', as: 'path_param', key: 'itemId' },
    ],
  ),

  // ── Batch 2 boundary — everything below is in chunk 2 ──
  node(
    'deleteCartItem',
    'DELETE',
    '/carts/{cartId}/items/{itemId}',
    ['createCartItem', 'getCartItem'], // CROSS-BATCH: these are in batch 1
    null,
    [
      { name: 'cart_id', as: 'path_param', key: 'cartId' },
      { name: 'cart_item_id', as: 'path_param', key: 'itemId' },
    ],
  ),
  node('createOrder', 'POST', '/orders', ['createCart', 'createUser'], 'order_id', [
    // CROSS-BATCH: createCart and createUser are both in batch 1
    { name: 'cart_id', as: 'body_field', key: 'cartId' },
    { name: 'user_id', as: 'body_field', key: 'userId' },
  ]),
  node('getOrder', 'GET', '/orders/{orderId}', ['createOrder'], null, [
    { name: 'order_id', as: 'path_param', key: 'orderId' },
  ]),
  node(
    'createReview',
    'POST',
    '/reviews',
    ['createUser', 'createProduct'], // CROSS-BATCH: both in batch 1
    'review_id',
    [
      { name: 'user_id', as: 'body_field', key: 'userId' },
      { name: 'product_id', as: 'body_field', key: 'productId' },
    ],
  ),
  node('getReview', 'GET', '/reviews/{reviewId}', ['createReview'], null, [
    { name: 'review_id', as: 'path_param', key: 'reviewId' },
  ]),
];

export const batchingEcommerceFixture: ResolverFixture = {
  name: 'batching-ecommerce',
  description: '25-endpoint e-commerce API forcing cross-batch dependencies',

  spec: {
    title: 'E-commerce Marketplace',
    version: '1.0',
    specVersion: '3.0.0',
    baseUrl: 'https://shop.example.com',
    authSchemes: [],
    sourceType: 'openapi_url',
    unsupportedEndpoints: [],
    endpoints,
  },

  idealAnalystOutput: {
    domain: { name: 'E-commerce', description: 'Marketplace with users, stores, products, carts, orders, reviews' },
    entities: [
      { name: 'User', createEndpoint: 'createUser', idField: { fieldName: 'id', jsonPath: '$.id' }, dependsOnEntities: [] },
      { name: 'Store', createEndpoint: 'createStore', idField: { fieldName: 'id', jsonPath: '$.id' }, dependsOnEntities: ['User'] },
      { name: 'Product', createEndpoint: 'createProduct', idField: { fieldName: 'id', jsonPath: '$.id' }, dependsOnEntities: ['Store'] },
      { name: 'Cart', createEndpoint: 'createCart', idField: { fieldName: 'id', jsonPath: '$.id' }, dependsOnEntities: ['User'] },
      { name: 'CartItem', createEndpoint: 'createCartItem', idField: { fieldName: 'id', jsonPath: '$.id' }, dependsOnEntities: ['Cart', 'Product'] },
      { name: 'Order', createEndpoint: 'createOrder', idField: { fieldName: 'id', jsonPath: '$.id' }, dependsOnEntities: ['Cart', 'User'] },
      { name: 'Review', createEndpoint: 'createReview', idField: { fieldName: 'id', jsonPath: '$.id' }, dependsOnEntities: ['User', 'Product'] },
    ],
    authFlow: { type: 'none', steps: [] },
    dataFlows: [],
    publicEndpoints: [],
    executionPhases: [],
    edgeCases: [],
    questions: [],
    confidence: { overall: 0.9, auth: 1, dependencies: 0.9, dataFlow: 0.9 },
  },

  // This "ideal" full DAG is what we WOULD get if the resolver didn't batch.
  // The test uses this as the SOURCE OF TRUTH to split per-batch.
  idealArchitectOutput: {
    nodes: idealNodes,
    executionOrder: idealNodes.map(n => n.id),
    summary: '25-endpoint e-commerce flow',
    totalEndpoints: 25,
    unsupportedEndpoints: [],
  },

  // Ordering constraints — cross-resource ones that batching can break.
  // If batching + auto-wire can't recover these, the final order is broken.
  orderingConstraints: [
    // same-collection basics (should always hold)
    ['createUser', 'getUser'],
    ['createStore', 'getStore'],
    ['createProduct', 'getProduct'],
    ['createCart', 'getCart'],
    ['createOrder', 'getOrder'],
    ['createReview', 'getReview'],

    // parent → child (cross-resource)
    ['createUser', 'createStore'],      // store needs user (ownerId)
    ['createStore', 'createProduct'],   // product needs store
    ['createUser', 'createCart'],       // cart needs user
    ['createCart', 'createCartItem'],   // cart item needs cart
    ['createProduct', 'createCartItem'],// cart item needs product  ← CROSS-BATCH
    ['createCart', 'createOrder'],      // order needs cart          ← CROSS-BATCH
    ['createUser', 'createOrder'],      // order needs user          ← CROSS-BATCH
    ['createUser', 'createReview'],     // review needs user         ← CROSS-BATCH
    ['createProduct', 'createReview'],  // review needs product      ← CROSS-BATCH

    // delete orderings (tests Rule 5 at scale)
    ['deleteProductImage', 'deleteProduct'],  // nested image → parent product
    ['deleteCartItem', 'deleteCart'],         // nested item → parent cart
  ],

  expectedNodeIds: idealNodes.map(n => n.id),
};
