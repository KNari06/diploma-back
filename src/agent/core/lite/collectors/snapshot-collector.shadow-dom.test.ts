/**
 * Tests for Shadow DOM Support in SnapshotCollector
 * Validates proper traversal, ref prefixing, slotted content, depth tracking
 */

import { chromium, Page, Browser } from 'playwright';
import { SnapshotCollector } from './snapshot-collector';

describe('SnapshotCollector - Shadow DOM Support', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page.close();
  });

  describe('Basic Shadow DOM', () => {
    it('should collect elements from open shadow root', async () => {
      await page.setContent(`
        <div id="host"></div>
        <script>
          const host = document.getElementById('host');
          const shadow = host.attachShadow({ mode: 'open' });
          shadow.innerHTML = '<button id="shadow-btn">Shadow Button</button>';
        </script>
      `);

      const snapshot = await SnapshotCollector.collect(page);
      const shadowButton = snapshot.elements.find(el => el.name.includes('Shadow Button'));

      expect(shadowButton).toBeDefined();
      expect(shadowButton?.isInsideShadowDOM).toBe(true);
      expect(shadowButton?.ref).toMatch(/^s\d+$/); // Starts with 's'
      expect(shadowButton?.shadowDepth).toBe(1);
    });

    it('should skip closed shadow root gracefully', async () => {
      await page.setContent(`
        <div id="host"></div>
        <button id="regular">Regular Button</button>
        <script>
          const host = document.getElementById('host');
          host.attachShadow({ mode: 'closed' });
        </script>
      `);

      // Should not throw error
      const snapshot = await SnapshotCollector.collect(page);

      // Should find regular button
      const regularButton = snapshot.elements.find(el => el.name.includes('Regular Button'));
      expect(regularButton).toBeDefined();
      expect(regularButton?.isInsideShadowDOM).toBe(false);
      expect(regularButton?.ref).toMatch(/^e\d+$/); // Light DOM prefix
    });

    it('should use "e" prefix for light DOM elements', async () => {
      await page.setContent(`
        <button id="light-btn">Light Button</button>
      `);

      const snapshot = await SnapshotCollector.collect(page);
      const lightButton = snapshot.elements.find(el => el.name.includes('Light Button'));

      expect(lightButton).toBeDefined();
      expect(lightButton?.isInsideShadowDOM).toBe(false);
      expect(lightButton?.ref).toMatch(/^e\d+$/);
      expect(lightButton?.shadowDepth).toBe(0);
    });
  });

  describe('Nested Shadow DOM', () => {
    it('should traverse nested shadow roots up to max depth', async () => {
      await page.setContent(`
        <div id="level1"></div>
        <script>
          const level1 = document.getElementById('level1');
          const shadow1 = level1.attachShadow({ mode: 'open' });
          shadow1.innerHTML = '<div id="level2"></div>';

          const level2 = shadow1.getElementById('level2');
          const shadow2 = level2.attachShadow({ mode: 'open' });
          shadow2.innerHTML = '<button id="nested-btn">Nested Button</button>';
        </script>
      `);

      const snapshot = await SnapshotCollector.collect(page);
      const nestedButton = snapshot.elements.find(el => el.name.includes('Nested Button'));

      expect(nestedButton).toBeDefined();
      expect(nestedButton?.isInsideShadowDOM).toBe(true);
      expect(nestedButton?.ref).toMatch(/^s\d+$/);
      expect(nestedButton?.shadowDepth).toBe(2); // Two levels deep
    });

    it('should stop traversal at max depth', async () => {
      // Create 10 nested levels (beyond max depth of 5)
      await page.setContent(`
        <div id="root"></div>
        <script>
          let current = document.getElementById('root');
          for (let i = 0; i < 10; i++) {
            const shadow = current.attachShadow({ mode: 'open' });
            const div = document.createElement('div');
            div.id = 'level' + (i + 1);
            shadow.appendChild(div);
            current = div;
          }
          // Add button at deepest level (level 10)
          const deepest = document.querySelector('div[id="root"]')
            .shadowRoot.querySelector('div[id="level1"]')
            .shadowRoot.querySelector('div[id="level2"]')
            .shadowRoot.querySelector('div[id="level3"]')
            .shadowRoot.querySelector('div[id="level4"]')
            .shadowRoot.querySelector('div[id="level5"]')
            .shadowRoot.querySelector('div[id="level6"]')
            .shadowRoot.querySelector('div[id="level7"]')
            .shadowRoot.querySelector('div[id="level8"]')
            .shadowRoot.querySelector('div[id="level9"]')
            .shadowRoot.querySelector('div[id="level10"]');
          const button = document.createElement('button');
          button.textContent = 'Deep Button';
          deepest.appendChild(button);
        </script>
      `);

      const snapshot = await SnapshotCollector.collect(page);
      const deepButton = snapshot.elements.find(el => el.name.includes('Deep Button'));

      // Button at depth 10 should NOT be collected (max depth is 5)
      expect(deepButton).toBeUndefined();
    });
  });

  describe('Slotted Content', () => {
    it('should detect slotted content', async () => {
      await page.setContent(`
        <custom-button id="host">
          <span id="slotted-content">Click me</span>
        </custom-button>
        <script>
          class CustomButton extends HTMLElement {
            constructor() {
              super();
              const shadow = this.attachShadow({ mode: 'open' });
              shadow.innerHTML = '<button><slot></slot></button>';
            }
          }
          customElements.define('custom-button', CustomButton);
        </script>
      `);

      // Wait for custom element to be defined
      await page.waitForTimeout(500);

      const snapshot = await SnapshotCollector.collect(page);
      const slottedSpan = snapshot.elements.find(el =>
        el.tag === 'span' && el.name.includes('Click me')
      );

      expect(slottedSpan).toBeDefined();
      expect(slottedSpan?.isSlotted).toBe(true);
      expect(slottedSpan?.slotName).toBe('default');
      expect(slottedSpan?.isInsideShadowDOM).toBe(false); // Light DOM content
    });

    it('should detect named slots', async () => {
      await page.setContent(`
        <custom-card id="host">
          <span slot="title">Card Title</span>
          <span slot="content">Card Content</span>
        </custom-card>
        <script>
          class CustomCard extends HTMLElement {
            constructor() {
              super();
              const shadow = this.attachShadow({ mode: 'open' });
              shadow.innerHTML = \`
                <div class="card">
                  <slot name="title"></slot>
                  <slot name="content"></slot>
                </div>
              \`;
            }
          }
          customElements.define('custom-card', CustomCard);
        </script>
      `);

      await page.waitForTimeout(500);

      const snapshot = await SnapshotCollector.collect(page);
      const titleSpan = snapshot.elements.find(el =>
        el.name.includes('Card Title')
      );
      const contentSpan = snapshot.elements.find(el =>
        el.name.includes('Card Content')
      );

      expect(titleSpan?.isSlotted).toBe(true);
      expect(titleSpan?.slotName).toBe('title');

      expect(contentSpan?.isSlotted).toBe(true);
      expect(contentSpan?.slotName).toBe('content');
    });
  });

  describe('Mixed Light and Shadow DOM', () => {
    it('should collect both light and shadow DOM elements', async () => {
      await page.setContent(`
        <button id="light">Light Button</button>
        <div id="host"></div>
        <button id="light2">Light Button 2</button>
        <script>
          const host = document.getElementById('host');
          const shadow = host.attachShadow({ mode: 'open' });
          shadow.innerHTML = '<button id="shadow">Shadow Button</button>';
        </script>
      `);

      const snapshot = await SnapshotCollector.collect(page);

      const lightButtons = snapshot.elements.filter(el =>
        el.name.includes('Light Button')
      );
      const shadowButton = snapshot.elements.find(el =>
        el.name.includes('Shadow Button')
      );

      expect(lightButtons.length).toBe(2);
      expect(lightButtons.every(el => el.ref.startsWith('e'))).toBe(true);
      expect(lightButtons.every(el => !el.isInsideShadowDOM)).toBe(true);

      expect(shadowButton).toBeDefined();
      expect(shadowButton?.ref).toMatch(/^s\d+$/);
      expect(shadowButton?.isInsideShadowDOM).toBe(true);
    });
  });

  describe('Performance', () => {
    it('should collect shadow DOM within acceptable time', async () => {
      // Create 50 web components with shadow roots
      await page.setContent(`
        <div id="container"></div>
        <script>
          const container = document.getElementById('container');
          for (let i = 0; i < 50; i++) {
            const host = document.createElement('div');
            const shadow = host.attachShadow({ mode: 'open' });
            shadow.innerHTML = \`<button>Button \${i}</button>\`;
            container.appendChild(host);
          }
        </script>
      `);

      const start = Date.now();
      const snapshot = await SnapshotCollector.collect(page, { fullPage: true });
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(3000); // Should be <3s (config timeout)
      expect(snapshot.elements.filter(el => el.isInsideShadowDOM).length).toBeGreaterThanOrEqual(50);
    });

    it('should handle large number of nested elements efficiently', async () => {
      await page.setContent(`
        <div id="host"></div>
        <script>
          const host = document.getElementById('host');
          const shadow = host.attachShadow({ mode: 'open' });
          let html = '';
          for (let i = 0; i < 100; i++) {
            html += \`<button>Button \${i}</button>\`;
          }
          shadow.innerHTML = html;
        </script>
      `);

      const start = Date.now();
      const snapshot = await SnapshotCollector.collect(page);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(2000); // Should be <2s
      const shadowButtons = snapshot.elements.filter(el =>
        el.isInsideShadowDOM && el.tag === 'button'
      );
      expect(shadowButtons.length).toBe(100);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty shadow root', async () => {
      await page.setContent(`
        <div id="host"></div>
        <script>
          const host = document.getElementById('host');
          host.attachShadow({ mode: 'open' });
          // Empty shadow root
        </script>
      `);

      const snapshot = await SnapshotCollector.collect(page);
      // Should not throw error, just return empty shadow elements
      expect(snapshot.elements.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle shadow root with only text nodes', async () => {
      await page.setContent(`
        <div id="host"></div>
        <script>
          const host = document.getElementById('host');
          const shadow = host.attachShadow({ mode: 'open' });
          shadow.textContent = 'Just text, no elements';
        </script>
      `);

      const snapshot = await SnapshotCollector.collect(page);
      // Should not crash, text nodes are not collected
      expect(snapshot.elements.length).toBeGreaterThanOrEqual(0);
    });

    it('should deduplicate elements collected multiple times', async () => {
      await page.setContent(`
        <button id="unique">Unique Button</button>
      `);

      const snapshot = await SnapshotCollector.collect(page);
      const uniqueButtons = snapshot.elements.filter(el =>
        el.name.includes('Unique Button')
      );

      // Should only appear once
      expect(uniqueButtons.length).toBe(1);
    });
  });
});
