/**
 * Script to analyze how Playwright finds elements on a page
 * Helps debug selector issues like finding <span> instead of <button>
 */

import { Browser, chromium } from 'playwright';

const URL = 'https://repetino.kz/onboarding';
const TARGET_TEXT = 'Математика';

async function analyzePage() {
  let browser: Browser | null = null;

  try {
    console.log('🚀 Starting Playwright analysis...\n');

    // Launch browser
    browser = await chromium.launch({
      headless: false, // Show browser for debugging
      slowMo: 500, // Slow down actions to see what's happening
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();

    console.log(`📄 Navigating to: ${URL}`);
    // ✅ FIX #4: Use domcontentloaded first (faster), then smart wait for SPA
    await page.goto(URL, { waitUntil: 'domcontentloaded' });

    // ✅ Use smart wait strategy (same as production code)
    // Wait for network idle with fallback (handles SPA/long-polling)
    console.log('⏳ Waiting for page to fully load (SPA support)...');
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
      console.log('✅ Network idle detected');
    } catch {
      // Fallback: Wait for network to settle (no new requests for 500ms)
      console.log('⚠️  Network idle timeout, using settle fallback...');
      let lastRequestTime = Date.now();
      const idleThreshold = 500;
      let inFlightRequests = 0;

      const onRequest = () => {
        inFlightRequests++;
        lastRequestTime = Date.now();
      };
      const onResponse = () => {
        inFlightRequests--;
        lastRequestTime = Date.now();
      };

      page.on('request', onRequest);
      page.on('response', onResponse);

      // Wait for settle
      while (Date.now() - lastRequestTime < idleThreshold || inFlightRequests > 0) {
        await page.waitForTimeout(100);
        if (Date.now() - lastRequestTime > 5000) break; // Max 5s
      }

      page.off('request', onRequest);
      page.off('response', onResponse);
      console.log('✅ Network settled');
    }

    // Small buffer for animations
    await page.waitForTimeout(500);

    console.log('✅ Page loaded\n');

    // ═══════════════════════════════════════════════════════════════
    // 1. Analyze DOM structure around target text
    // ═══════════════════════════════════════════════════════════════

    console.log('🔍 STEP 1: Analyzing DOM structure...\n');

    const domAnalysis = await page.evaluate((targetText) => {
      // Find all elements containing the target text
      const allElements: Array<{
        tag: string;
        text: string;
        html: string;
        parentTag?: string;
        parentHtml?: string;
        isInteractive: boolean;
        role?: string;
        classes?: string;
        tabIndex?: number;
        closestClickable?: string; // ✅ FIX #5: Find closest clickable parent
      }> = [];

      // ✅ FIX #7: Limit max elements for performance
      const MAX_ELEMENTS = 20;
      let foundCount = 0;

      // ✅ FIX #2: Case-insensitive search
      const targetLower = targetText.toLowerCase();

      // @ts-ignore - browser context, NodeFilter is available in browser
      const walker = document.createTreeWalker(
        // @ts-ignore - browser context
        document.body,
        // @ts-ignore - NodeFilter is available in browser context
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        null
      );

      let node;
      while ((node = walker.nextNode()) && foundCount < MAX_ELEMENTS) {
        // @ts-ignore - Node constants are available in browser context
        if (node.nodeType === Node.TEXT_NODE) {
          // @ts-ignore
          const text = node.textContent?.trim() || '';
          // ✅ FIX #2: Case-insensitive comparison
          if (text.toLowerCase().includes(targetLower)) {
            // @ts-ignore
            const parent = node.parentElement;
            if (parent) {
              // @ts-ignore
              const style = window.getComputedStyle(parent);
              // @ts-ignore
              const explicitRole = parent.getAttribute('role');
              // @ts-ignore
              const classes = parent.className;
              // @ts-ignore
              const tag = parent.tagName.toLowerCase();
              // ✅ FIX #1: Check tabindex for interactivity
              // @ts-ignore
              const tabIndex = parent.tabIndex;

              // Get implicit ARIA role based on HTML element
              const implicitRoleMap: Record<string, string> = {
                'button': 'button',
                'a': 'link',
                'input': 'textbox',
                'textarea': 'textbox',
                'select': 'combobox',
                'nav': 'navigation',
                'main': 'main',
                'header': 'banner',
                'footer': 'contentinfo',
              };
              const implicitRole = implicitRoleMap[tag] || null;
              const role = explicitRole || implicitRole;

              // ✅ FIX #5: Find closest clickable parent (solves span-in-button problem)
              // @ts-ignore
              const closestClickable = parent.closest('button, a, [role="button"], [role="link"], [onclick]');

              allElements.push({
                tag,
                text: text.substring(0, 100),
                // @ts-ignore - ✅ FIX #6: Limit HTML to prevent data leaks
                html: parent.outerHTML.substring(0, 150).replace(/value="[^"]*"/g, 'value="***"'),
                // @ts-ignore
                parentTag: parent.parentElement?.tagName.toLowerCase(),
                // @ts-ignore - ✅ FIX #6: Sanitize parent HTML too
                parentHtml: parent.parentElement?.outerHTML.substring(0, 150).replace(/value="[^"]*"/g, 'value="***"'),
                // ✅ FIX #1: Include tabindex in interactivity check
                isInteractive:
                  ['button', 'a', 'input', 'select', 'textarea'].includes(tag) ||
                  role === 'button' ||
                  role === 'link' ||
                  // @ts-ignore
                  parent.onclick !== null ||
                  style.cursor === 'pointer' ||
                  tabIndex >= 0, // ✅ FIX #1: tabindex check
                role: role || undefined,
                classes: typeof classes === 'string' ? classes : undefined,
                tabIndex,
                // @ts-ignore
                closestClickable: closestClickable ? closestClickable.tagName.toLowerCase() : undefined,
              });

              foundCount++;
            }
          }
        }
      }

      return allElements;
    }, TARGET_TEXT);

    console.log(`Found ${domAnalysis.length} element(s) containing "${TARGET_TEXT}":\n`);

    domAnalysis.forEach((el, index) => {
      console.log(`\n📍 Element ${index + 1}:`);
      console.log(`   Tag: <${el.tag}>`);
      console.log(`   Text: "${el.text}"`);
      console.log(`   Is Interactive: ${el.isInteractive}`);
      const roleDisplay = el.role
        ? `${el.role} (${el.tag === 'button' ? 'implicit' : el.tag === 'a' ? 'implicit' : 'explicit/implicit'})`
        : 'none';
      console.log(`   Role: ${roleDisplay}`);
      console.log(`   TabIndex: ${el.tabIndex ?? 'none'}`);
      console.log(`   Classes: ${el.classes || 'none'}`);
      console.log(`   Parent: <${el.parentTag || 'none'}>`);
      // ✅ FIX #5: Show closest clickable parent
      console.log(`   Closest Clickable: <${el.closestClickable || 'none'}>`);
      console.log(`   HTML: ${el.html}`);
      if (el.parentHtml) {
        console.log(`   Parent HTML: ${el.parentHtml}`);
      }
    });

    // ═══════════════════════════════════════════════════════════════
    // 2. Test getByText() - what does it find?
    // ═══════════════════════════════════════════════════════════════

    console.log('\n\n🔍 STEP 2: Testing getByText()...\n');

    try {
      const textLocator = page.getByText(TARGET_TEXT, { exact: true });
      const count = await textLocator.count();
      console.log(`getByText('${TARGET_TEXT}', { exact: true }) found ${count} element(s)\n`);

      if (count > 0) {
        const firstElement = textLocator.first();
        const elementInfo = await firstElement.evaluate((el) => {
          // @ts-ignore
          const rect = el.getBoundingClientRect();
          // @ts-ignore
          const style = window.getComputedStyle(el);
          // @ts-ignore
          const role = el.getAttribute('role');

          return {
            // @ts-ignore
            tag: el.tagName.toLowerCase(),
            // @ts-ignore
            text: el.textContent?.trim().substring(0, 50),
            // @ts-ignore
            html: el.outerHTML.substring(0, 200),
            // @ts-ignore
            parentTag: el.parentElement?.tagName.toLowerCase(),
            // @ts-ignore
            parentHtml: el.parentElement?.outerHTML.substring(0, 200),
            // @ts-ignore
            classes: el.className,
            role: role || null,
            // @ts-ignore
            isVisible: rect.width > 0 && rect.height > 0,
            // @ts-ignore
            isInViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
            // @ts-ignore
            cursor: style.cursor,
            // @ts-ignore
            hasOnClick: el.onclick !== null || el.hasAttribute('onclick'),
          };
        });

        console.log('📌 First element found by getByText():');
        console.log(JSON.stringify(elementInfo, null, 2));
      }
    } catch (error) {
      console.error('❌ Error with getByText():', error instanceof Error ? error.message : String(error));
    }

    // ═══════════════════════════════════════════════════════════════
    // 3. Test getByRole() - does it find button?
    // ═══════════════════════════════════════════════════════════════

    console.log('\n\n🔍 STEP 3: Testing getByRole()...\n');

    try {
      const roleLocator = page.getByRole('button', { name: TARGET_TEXT, exact: true });
      const roleCount = await roleLocator.count();
      console.log(`getByRole('button', { name: '${TARGET_TEXT}', exact: true }) found ${roleCount} element(s)\n`);

      if (roleCount > 0) {
        const firstButton = roleLocator.first();
        const buttonInfo = await firstButton.evaluate((el) => {
          // @ts-ignore
          const rect = el.getBoundingClientRect();
          // @ts-ignore
          const style = window.getComputedStyle(el);
          // @ts-ignore
          const explicitRole = el.getAttribute('role');
          // @ts-ignore
          const tag = el.tagName.toLowerCase();

          // Get implicit ARIA role (same logic as in getSmartLocator)
          const implicitRoleMap: Record<string, string> = {
            'button': 'button',
            'a': 'link',
            'input': 'textbox',
            'textarea': 'textbox',
            'select': 'combobox',
            'option': 'option',
            'img': 'img',
            'nav': 'navigation',
            'main': 'main',
            'header': 'banner',
            'footer': 'contentinfo',
            'aside': 'complementary',
            'form': 'form',
            'article': 'article',
            'section': 'region',
          };

          // Special case for input types
          // @ts-ignore
          const inputType = el.type?.toLowerCase();
          let implicitRole = implicitRoleMap[tag] || null;
          if (tag === 'input') {
            const inputRoleMap: Record<string, string> = {
              'text': 'textbox',
              'email': 'textbox',
              'password': 'textbox',
              'search': 'searchbox',
              'checkbox': 'checkbox',
              'radio': 'radio',
              'button': 'button',
              'submit': 'button',
              'reset': 'button',
            };
            implicitRole = inputRoleMap[inputType] || 'textbox';
          }

          // Use explicit role if set, otherwise implicit
          const role = explicitRole || implicitRole;

          return {
            tag,
            // @ts-ignore
            text: el.textContent?.trim().substring(0, 50),
            // @ts-ignore
            html: el.outerHTML.substring(0, 200),
            // @ts-ignore
            classes: el.className,
            role: role || null,
            roleSource: explicitRole ? 'explicit' : (implicitRole ? 'implicit' : 'none'),
            // @ts-ignore
            isVisible: rect.width > 0 && rect.height > 0,
            // @ts-ignore
            isInViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
            // @ts-ignore
            cursor: style.cursor,
          };
        });

        console.log('📌 First button found by getByRole():');
        console.log(JSON.stringify(buttonInfo, null, 2));
      } else {
        console.log('⚠️  No button found with getByRole()');
      }
    } catch (error) {
      console.error('❌ Error with getByRole():', error instanceof Error ? error.message : String(error));
    }

    // ═══════════════════════════════════════════════════════════════
    // 4. Test CSS selector for button
    // ═══════════════════════════════════════════════════════════════

    console.log('\n\n🔍 STEP 4: Testing CSS selector (button:has-text)...\n');

    try {
      const cssLocator = page.locator(`button:has-text("${TARGET_TEXT}")`);
      const cssCount = await cssLocator.count();
      console.log(`button:has-text("${TARGET_TEXT}") found ${cssCount} element(s)\n`);

      if (cssCount > 0) {
        const firstButton = cssLocator.first();
        const buttonInfo = await firstButton.evaluate((el) => {
          // @ts-ignore
          const rect = el.getBoundingClientRect();
          // @ts-ignore
          const style = window.getComputedStyle(el);

          return {
            // @ts-ignore
            tag: el.tagName.toLowerCase(),
            // @ts-ignore
            text: el.textContent?.trim().substring(0, 50),
            // @ts-ignore
            html: el.outerHTML.substring(0, 200),
            // @ts-ignore
            classes: el.className,
            // @ts-ignore
            isVisible: rect.width > 0 && rect.height > 0,
            // @ts-ignore
            isInViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
            // @ts-ignore
            cursor: style.cursor,
          };
        });

        console.log('📌 First button found by CSS selector:');
        console.log(JSON.stringify(buttonInfo, null, 2));
      } else {
        console.log('⚠️  No button found with CSS selector');
      }
    } catch (error) {
      console.error('❌ Error with CSS selector:', error instanceof Error ? error.message : String(error));
    }

    // ═══════════════════════════════════════════════════════════════
    // 5. Compare viewport positions
    // ═══════════════════════════════════════════════════════════════

    console.log('\n\n🔍 STEP 5: Comparing viewport positions...\n');

    try {
      const textLocator = page.getByText(TARGET_TEXT, { exact: true }).first();
      const roleLocator = page.getByRole('button', { name: TARGET_TEXT, exact: true }).first();

      const textBox = await textLocator.boundingBox();
      const roleBox = await roleLocator.boundingBox().catch(() => null);

      console.log('📍 getByText() element position:');
      console.log(`   x: ${textBox?.x}, y: ${textBox?.y}`);
      console.log(`   width: ${textBox?.width}, height: ${textBox?.height}`);
      console.log(`   visible: ${textBox !== null}`);

      if (roleBox) {
        console.log('\n📍 getByRole() element position:');
        console.log(`   x: ${roleBox.x}, y: ${roleBox.y}`);
        console.log(`   width: ${roleBox.width}, height: ${roleBox.height}`);
        console.log(`   visible: ${roleBox !== null}`);

        console.log('\n📊 Comparison:');
        console.log(`   Same element: ${textBox?.x === roleBox.x && textBox?.y === roleBox.y}`);
        console.log(`   Size difference: ${Math.abs((textBox?.width || 0) - roleBox.width)}px width, ${Math.abs((textBox?.height || 0) - roleBox.height)}px height`);
      } else {
        console.log('\n⚠️  getByRole() did not find element');
      }
    } catch (error) {
      console.error('❌ Error comparing positions:', error instanceof Error ? error.message : String(error));
    }

    // ═══════════════════════════════════════════════════════════════
    // 6. Test actual click attempt
    // ═══════════════════════════════════════════════════════════════

    console.log('\n\n🔍 STEP 6: Testing click attempts...\n');

    // Try getByText
    console.log('Testing click with getByText()...');
    try {
      const textLocator = page.getByText(TARGET_TEXT, { exact: true }).first();
      await textLocator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);

      const isInViewport = await textLocator.evaluate((el) => {
        // @ts-ignore
        const rect = el.getBoundingClientRect();
        // @ts-ignore
        return (
          rect.top >= 0 &&
          rect.left >= 0 &&
          // @ts-ignore
          rect.bottom <= window.innerHeight &&
          // @ts-ignore
          rect.right <= window.innerWidth
        );
      });

      console.log(`   Element in viewport after scroll: ${isInViewport}`);

      if (isInViewport) {
        console.log('   ✅ Would be able to click');
      } else {
        console.log('   ❌ Would fail - element outside viewport');
      }
    } catch (error) {
      console.error('   ❌ Error:', error instanceof Error ? error.message : String(error));
    }

    // Try getByRole
    console.log('\nTesting click with getByRole()...');
    try {
      const roleLocator = page.getByRole('button', { name: TARGET_TEXT, exact: true }).first();
      await roleLocator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);

      const isInViewport = await roleLocator.evaluate((el) => {
        // @ts-ignore
        const rect = el.getBoundingClientRect();
        // @ts-ignore
        return (
          rect.top >= 0 &&
          rect.left >= 0 &&
          // @ts-ignore
          rect.bottom <= window.innerHeight &&
          // @ts-ignore
          rect.right <= window.innerWidth
        );
      });

      console.log(`   Element in viewport after scroll: ${isInViewport}`);

      if (isInViewport) {
        console.log('   ✅ Would be able to click');
      } else {
        console.log('   ❌ Would fail - element outside viewport');
      }
    } catch (error) {
      console.error('   ❌ Error:', error instanceof Error ? error.message : String(error));
    }

    // ═══════════════════════════════════════════════════════════════
    // 7. Test getSmartLocator() from our codebase
    // ═══════════════════════════════════════════════════════════════

    console.log('\n\n🔍 STEP 7: Testing getSmartLocator() logic...\n');

    // Simulate the smart locator logic (same as in selector-utils.ts)
    try {
      const textLocator = page.getByText(TARGET_TEXT, { exact: true });
      const count = await textLocator.count();

      console.log(`Found ${count} elements with text "${TARGET_TEXT}"`);
      console.log('\nAnalyzing elements by action type "click"...\n');

      interface ElementScore {
        index: number;
        tag: string;
        role: string | null;
        isInteractive: boolean;
        score: number;
      }

      const scores: ElementScore[] = [];

      for (let i = 0; i < Math.min(count, 10); i++) {
        const element = textLocator.nth(i);

        const analysis = await element.evaluate((el) => {
          // @ts-ignore
          const tag = el.tagName.toLowerCase();
          // @ts-ignore
          const explicitRole = el.getAttribute('role');
          // @ts-ignore
          const style = window.getComputedStyle(el);
          // @ts-ignore
          const tabIndex = el.tabIndex;

          // ✅ FIX #1: Get implicit role (same as in selector-utils.ts)
          const implicitRoleMap: Record<string, string> = {
            'button': 'button',
            'a': 'link',
            'input': 'textbox',
            'textarea': 'textbox',
            'select': 'combobox',
          };
          const role = explicitRole || implicitRoleMap[tag] || null;

          const preferredTags = ['button', 'a', 'input', 'select', 'label'];
          const preferredRoles = ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio'];

          // ✅ FIX #1: Include tabindex in interactivity check
          const isInteractive = (
            preferredTags.includes(tag) ||
            preferredRoles.includes(role || '') ||
            // @ts-ignore
            el.onclick !== null ||
            style.cursor === 'pointer' ||
            tabIndex >= 0
          );

          let score = 0;
          if (preferredTags.includes(tag)) score += 50;
          if (role && preferredRoles.includes(role)) score += 40;
          if (isInteractive) score += 30;
          if (style.cursor === 'pointer') score += 5;

          return { tag, role, isInteractive, score };
        });

        scores.push({ index: i, ...analysis });
        console.log(`  Element ${i}: <${analysis.tag}> | Role: ${analysis.role || 'none'} | Interactive: ${analysis.isInteractive} | Score: ${analysis.score}`);
      }

      // Sort by score
      scores.sort((a, b) => b.score - a.score);

      console.log('\n📊 Smart selection result:');
      console.log(`   Best match: Element ${scores[0]?.index} (<${scores[0]?.tag}>) with role="${scores[0]?.role || 'none'}" score=${scores[0]?.score}`);

      if (scores[0]?.tag === 'button' || scores[0]?.role === 'button') {
        console.log('   ✅ Smart locator would correctly select interactive element');
      } else {
        console.log(`   ⚠️  Smart locator would select <${scores[0]?.tag}> - may not be optimal`);
      }

    } catch (error) {
      console.error('❌ Error testing smart locator:', error instanceof Error ? error.message : String(error));
    }

    console.log('\n\n✅ Analysis complete!');
    console.log('\n💡 Keep browser open for 10 seconds to inspect manually...');
    await page.waitForTimeout(10000);

  } catch (error) {
    console.error('❌ Fatal error:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Run the analysis
analyzePage().catch(console.error);
