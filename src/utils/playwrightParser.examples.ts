import { PlaywrightStep } from '../types/playwright.types';
import { exportGraph, parsePlaywrightTestSteps } from './playwrightParser';

/**
 * Example 1: Simple linear test flow
 */
export function exampleLinearFlow(): void {
  const steps: PlaywrightStep[] = [
    {
      id: '1',
      type: 'goto',
      label: 'Navigate to Homepage',
      value: 'https://example.com',
    },
    {
      id: '2',
      type: 'waitForSelector',
      label: 'Wait for main content',
      selector: '#main-content',
    },
    {
      id: '3',
      type: 'click',
      label: 'Click Login button',
      selector: 'button[data-test="login"]',
    },
    {
      id: '4',
      type: 'fill',
      label: 'Fill email field',
      selector: 'input[name="email"]',
      value: 'user@example.com',
    },
    {
      id: '5',
      type: 'fill',
      label: 'Fill password field',
      selector: 'input[name="password"]',
      value: 'password123',
    },
    {
      id: '6',
      type: 'click',
      label: 'Submit login form',
      selector: 'button[type="submit"]',
    },
    {
      id: '7',
      type: 'assertVisible',
      label: 'Verify dashboard is visible',
      selector: '#dashboard',
    },
  ];

  const graph = parsePlaywrightTestSteps(steps, {
    includeStartEnd: true,
    autoLayout: true,
    addButtons: true,
  });

  console.log('Linear Flow Graph:', JSON.stringify(graph, null, 2));
}

/**
 * Example 2: Test with conditional logic (if/else)
 */
export function exampleConditionalFlow(): void {
  const steps: PlaywrightStep[] = [
    {
      id: '1',
      type: 'goto',
      label: 'Go to Homepage',
      value: 'https://example.com',
    },
    {
      id: '2',
      type: 'if',
      label: 'Check if user is logged in',
      selector: '.user-profile',
      children: [
        {
          id: '3',
          type: 'click',
          label: 'Go to Dashboard',
          selector: 'a[href="/dashboard"]',
        },
        {
          id: '4',
          type: 'assertText',
          label: 'Verify welcome message',
          selector: '.welcome-message',
          value: 'Welcome back!',
        },
      ],
      else: [
        {
          id: '5',
          type: 'click',
          label: 'Click Login button',
          selector: 'button[data-test="login"]',
        },
        {
          id: '6',
          type: 'fill',
          label: 'Fill credentials',
          selector: 'form.login',
        },
      ],
    },
    {
      id: '7',
      type: 'screenshot',
      label: 'Take final screenshot',
    },
  ];

  const graph = parsePlaywrightTestSteps(steps, {
    includeStartEnd: true,
    autoLayout: true,
  });

  console.log('Conditional Flow Graph:', JSON.stringify(graph, null, 2));
  console.log('\nMermaid Diagram:\n', exportGraph(graph, 'mermaid'));
}

/**
 * Example 3: Test with loop
 */
export function exampleLoopFlow(): void {
  const steps: PlaywrightStep[] = [
    {
      id: '1',
      type: 'goto',
      label: 'Navigate to products page',
      value: 'https://example.com/products',
    },
    {
      id: '2',
      type: 'loop',
      label: 'Iterate through products',
      value: 5,
      children: [
        {
          id: '3',
          type: 'click',
          label: 'Click product card',
          selector: '.product-card',
        },
        {
          id: '4',
          type: 'assertVisible',
          label: 'Verify product details',
          selector: '.product-details',
        },
        {
          id: '5',
          type: 'goBack',
          label: 'Return to products list',
        },
      ],
    },
    {
      id: '6',
      type: 'assert',
      label: 'Verify all products checked',
    },
  ];

  const graph = parsePlaywrightTestSteps(steps);
  console.log('Loop Flow Graph:', JSON.stringify(graph, null, 2));
}

/**
 * Example 4: Complex nested flow (if inside loop)
 */
export function exampleNestedFlow(): void {
  const steps: PlaywrightStep[] = [
    {
      id: '1',
      type: 'goto',
      label: 'Go to items page',
      value: 'https://example.com/items',
    },
    {
      id: '2',
      type: 'forEach',
      label: 'Process each item',
      children: [
        {
          id: '3',
          type: 'click',
          label: 'Select item',
          selector: '.item',
        },
        {
          id: '4',
          type: 'if',
          label: 'Check if item is available',
          selector: '.in-stock',
          children: [
            {
              id: '5',
              type: 'click',
              label: 'Add to cart',
              selector: 'button.add-to-cart',
            },
            {
              id: '6',
              type: 'assertText',
              label: 'Verify added message',
              selector: '.cart-message',
              value: 'Added to cart',
            },
          ],
          else: [
            {
              id: '7',
              type: 'click',
              label: 'Add to wishlist',
              selector: 'button.add-to-wishlist',
            },
          ],
        },
      ],
    },
    {
      id: '8',
      type: 'goto',
      label: 'Go to cart',
      value: '/cart',
    },
    {
      id: '9',
      type: 'assertCount',
      label: 'Verify cart items count',
      selector: '.cart-item',
    },
  ];

  const graph = parsePlaywrightTestSteps(steps, {
    includeStartEnd: true,
    autoLayout: true,
    groupNesting: true,
  });

  console.log('Nested Flow Graph:', JSON.stringify(graph, null, 2));
}

/**
 * Example 5: All action types showcase
 */
export function exampleAllActionTypes(): void {
  const steps: PlaywrightStep[] = [
    // Navigation
    { id: '1', type: 'goto', label: 'Navigate to page' },
    { id: '2', type: 'reload', label: 'Reload page' },
    { id: '3', type: 'goBack', label: 'Go back' },
    { id: '4', type: 'goForward', label: 'Go forward' },

    // Interactions
    { id: '5', type: 'click', label: 'Click element', selector: 'button' },
    { id: '6', type: 'dblclick', label: 'Double click', selector: '.item' },
    { id: '7', type: 'fill', label: 'Fill input', selector: 'input', value: 'text' },
    { id: '8', type: 'type', label: 'Type slowly', selector: 'textarea' },
    { id: '9', type: 'hover', label: 'Hover element', selector: '.menu' },
    { id: '10', type: 'check', label: 'Check checkbox', selector: '#agree' },
    { id: '11', type: 'uncheck', label: 'Uncheck', selector: '#newsletter' },
    { id: '12', type: 'selectOption', label: 'Select option', selector: 'select' },
    { id: '13', type: 'press', label: 'Press Enter', value: 'Enter' },

    // Wait operations
    { id: '14', type: 'waitForSelector', label: 'Wait for element' },
    { id: '15', type: 'waitForTimeout', label: 'Wait 1s', value: 1000 },
    { id: '16', type: 'waitForLoadState', label: 'Wait for load' },

    // Scroll
    { id: '17', type: 'scroll', label: 'Scroll down' },
    { id: '18', type: 'scrollIntoView', label: 'Scroll to element' },

    // File operations
    { id: '19', type: 'upload', label: 'Upload file', selector: 'input[type="file"]' },
    { id: '20', type: 'screenshot', label: 'Take screenshot' },
    { id: '21', type: 'download', label: 'Download file' },

    // Assertions
    { id: '22', type: 'assertVisible', label: 'Assert visible' },
    { id: '23', type: 'assertHidden', label: 'Assert hidden' },
    { id: '24', type: 'assertText', label: 'Assert text content' },
    { id: '25', type: 'assertValue', label: 'Assert input value' },
    { id: '26', type: 'expect', label: 'Expect condition' },

    // Custom
    { id: '27', type: 'custom', label: 'Custom action' },
    { id: '28', type: 'evaluate', label: 'Run JavaScript' },
  ];

  const graph = parsePlaywrightTestSteps(steps, {
    includeStartEnd: true,
  });

  console.log(`All Actions Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  console.log('Metadata:', graph.metadata);
}

// Run examples
if (require.main === module) {
  console.log('=== Example 1: Linear Flow ===\n');
  exampleLinearFlow();

  console.log('\n\n=== Example 2: Conditional Flow ===\n');
  exampleConditionalFlow();

  console.log('\n\n=== Example 3: Loop Flow ===\n');
  exampleLoopFlow();

  console.log('\n\n=== Example 4: Nested Flow ===\n');
  exampleNestedFlow();

  console.log('\n\n=== Example 5: All Action Types ===\n');
  exampleAllActionTypes();
}
