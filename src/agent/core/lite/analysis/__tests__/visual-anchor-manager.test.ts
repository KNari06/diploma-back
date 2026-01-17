/**
 * Unit tests for VisualAnchorManager
 * Tests signature creation, matching, and confidence scoring
 */

import { VisualAnchorManager, MIN_CONFIDENCE_THRESHOLD } from '../visual-anchor-manager';
import type { LiteElement, VisualSignature } from '../../lite-types';

// ═══════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function createMockElement(overrides: Partial<LiteElement> = {}): LiteElement {
  return {
    ref: 'e1',
    role: 'button',
    name: 'Submit',
    tag: 'button',
    visible: true,
    bounds: { x: 100, y: 100, width: 100, height: 40 },
    ...overrides,
  };
}

function createMockElements(): LiteElement[] {
  return [
    // Target button
    createMockElement({
      ref: 'e1',
      name: 'Submit',
      tag: 'button',
      bounds: { x: 200, y: 300, width: 100, height: 40 },
    }),
    // Heading above button (stable anchor)
    createMockElement({
      ref: 'e2',
      name: 'Contact Form',
      tag: 'h2',
      role: 'heading',
      bounds: { x: 150, y: 100, width: 200, height: 30 },
    }),
    // Label to the left (stable anchor)
    createMockElement({
      ref: 'e3',
      name: 'Email:',
      tag: 'label',
      bounds: { x: 50, y: 300, width: 50, height: 20 },
    }),
    // Input field (not stable - interactive)
    createMockElement({
      ref: 'e4',
      name: '',
      tag: 'input',
      type: 'email',
      bounds: { x: 110, y: 295, width: 180, height: 30 },
    }),
    // Icon with aria-label (stable anchor)
    createMockElement({
      ref: 'e5',
      name: 'Send message',
      tag: 'svg',
      role: 'img',
      bounds: { x: 310, y: 305, width: 24, height: 24 },
    }),
    // Footer text (stable but far away)
    createMockElement({
      ref: 'e6',
      name: 'Copyright 2024',
      tag: 'span',
      bounds: { x: 100, y: 800, width: 150, height: 20 },
    }),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNATURE CREATION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('VisualAnchorManager.createSignature', () => {
  it('should create signature with correct own properties', () => {
    const elements = createMockElements();
    const target = elements[0]; // Submit button

    const signature = VisualAnchorManager.createSignature(target, elements);

    expect(signature.ownText).toBe('Submit');
    expect(signature.tag).toBe('button');
    expect(signature.createdAt).toBeGreaterThan(0);
  });

  it('should find stable anchors (headings, labels, icons)', () => {
    const elements = createMockElements();
    const target = elements[0]; // Submit button

    const signature = VisualAnchorManager.createSignature(target, elements);

    // Should have anchors
    expect(signature.anchors.length).toBeGreaterThan(0);
    expect(signature.anchors.length).toBeLessThanOrEqual(5);

    // Check anchor types
    const anchorTypes = signature.anchors.map(a => a.type);
    expect(anchorTypes).toContain('heading'); // h2 "Contact Form"
    expect(anchorTypes).toContain('label');   // "Email:" label
    expect(anchorTypes).toContain('icon');    // svg "Send message"
  });

  it('should calculate correct directions', () => {
    const elements = createMockElements();
    const target = elements[0]; // Submit button at (200, 300)

    const signature = VisualAnchorManager.createSignature(target, elements);

    // Heading "Contact Form" at (150, 100) should be "top"
    const headingAnchor = signature.anchors.find(a => a.value === 'Contact Form');
    expect(headingAnchor?.direction).toBe('top');

    // Label "Email:" at (50, 300) should be "left"
    const labelAnchor = signature.anchors.find(a => a.value === 'Email:');
    expect(labelAnchor?.direction).toBe('left');

    // Icon at (310, 305) should be "right"
    const iconAnchor = signature.anchors.find(a => a.value === 'Send message');
    expect(iconAnchor?.direction).toBe('right');
  });

  it('should not include far away elements (> 300px)', () => {
    const elements = createMockElements();
    const target = elements[0]; // Submit button at (200, 300)

    const signature = VisualAnchorManager.createSignature(target, elements);

    // Footer at (100, 800) is ~500px away, should not be included
    const footerAnchor = signature.anchors.find(a => a.value === 'Copyright 2024');
    expect(footerAnchor).toBeUndefined();
  });

  it('should not include non-stable elements (inputs)', () => {
    const elements = createMockElements();
    const target = elements[0];

    const signature = VisualAnchorManager.createSignature(target, elements);

    // Input e4 should not be an anchor (not stable)
    const inputAnchor = signature.anchors.find(a => a.type === 'text' && a.value === '');
    expect(inputAnchor).toBeUndefined();
  });

  it('should handle element with no nearby anchors', () => {
    const lonelyButton = createMockElement({
      ref: 'e1',
      name: 'Lonely Button',
      tag: 'button',
      bounds: { x: 1000, y: 1000, width: 100, height: 40 },
    });

    const elements = [lonelyButton];
    const signature = VisualAnchorManager.createSignature(lonelyButton, elements);

    expect(signature.ownText).toBe('Lonely Button');
    expect(signature.anchors.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SIGNATURE MATCHING TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('VisualAnchorManager.findBySignature', () => {
  it('should find exact match with high confidence', () => {
    const elements = createMockElements();
    const target = elements[0];

    // Create signature
    const signature = VisualAnchorManager.createSignature(target, elements);

    // Find by signature (same elements)
    const { element, confidence } = VisualAnchorManager.findBySignature(signature, elements);

    expect(element).not.toBeNull();
    expect(element?.ref).toBe('e1');
    expect(confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE_THRESHOLD);
  });

  it('should find element even when ref changes', () => {
    const elements = createMockElements();
    const target = elements[0];

    // Create signature
    const signature = VisualAnchorManager.createSignature(target, elements);

    // Simulate ref change (as if page reloaded)
    const newElements = elements.map(el => ({
      ...el,
      ref: el.ref.replace('e', 'new'),
    }));

    const { element, confidence } = VisualAnchorManager.findBySignature(signature, newElements);

    expect(element).not.toBeNull();
    expect(element?.name).toBe('Submit');
    expect(confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE_THRESHOLD);
  });

  it('should reject match when tag is different', () => {
    const elements = createMockElements();
    const target = elements[0];

    // Create signature for button
    const signature = VisualAnchorManager.createSignature(target, elements);

    // Change all buttons to links
    const newElements = elements.map(el => ({
      ...el,
      tag: el.tag === 'button' ? 'a' : el.tag,
    }));

    const { element, confidence } = VisualAnchorManager.findBySignature(signature, newElements);

    // Should not find (tag mismatch)
    expect(element).toBeNull();
    expect(confidence).toBeLessThan(MIN_CONFIDENCE_THRESHOLD);
  });

  it('should handle missing anchors gracefully', () => {
    const elements = createMockElements();
    const target = elements[0];

    // Create signature with anchors
    const signature = VisualAnchorManager.createSignature(target, elements);
    expect(signature.anchors.length).toBeGreaterThan(0);

    // Remove all anchors from page (keep only button)
    const newElements = elements.filter(el => el.tag === 'button');

    const { element, confidence } = VisualAnchorManager.findBySignature(signature, newElements);

    // Without anchors, confidence will be low (text: 0.4 + tag: 0.1 = 0.5)
    // This is below the 0.7 threshold, so element should be null
    // This is expected behavior - we need anchors for confident matching
    expect(confidence).toBeLessThan(MIN_CONFIDENCE_THRESHOLD);
    expect(element).toBeNull();
  });

  it('should prefer higher confidence matches', () => {
    const elements = createMockElements();
    const target = elements[0];

    const signature = VisualAnchorManager.createSignature(target, elements);

    // Add another button with different name
    const elementsWithDuplicate = [
      ...elements,
      createMockElement({
        ref: 'e10',
        name: 'Cancel',
        tag: 'button',
        bounds: { x: 50, y: 300, width: 100, height: 40 },
      }),
    ];

    const { element, confidence } = VisualAnchorManager.findBySignature(
      signature,
      elementsWithDuplicate
    );

    // Should prefer "Submit" over "Cancel"
    expect(element?.name).toBe('Submit');
    expect(confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE_THRESHOLD);
  });

  it('should return null when no candidates match', () => {
    const signature: VisualSignature = {
      ownText: 'Unique Button',
      tag: 'button',
      anchors: [],
      createdAt: Date.now(),
    };

    const elements = [
      createMockElement({ ref: 'e1', name: 'Other Button', tag: 'a' }),
      createMockElement({ ref: 'e2', name: 'Another Element', tag: 'div' }),
    ];

    const { element, confidence } = VisualAnchorManager.findBySignature(signature, elements);

    expect(element).toBeNull();
    expect(confidence).toBeLessThan(MIN_CONFIDENCE_THRESHOLD);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIDENCE SCORING TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Confidence Scoring', () => {
  it('should give high score for exact text match', () => {
    const elements = createMockElements();
    const target = elements[0];

    const signature = VisualAnchorManager.createSignature(target, elements);

    // Find in same elements
    const { confidence } = VisualAnchorManager.findBySignature(signature, elements);

    // With exact text match (0.4) + tag (0.1) + anchors (~0.5) = ~1.0
    expect(confidence).toBeGreaterThan(0.8);
  });

  it('should give partial score for partial text match', () => {
    const elements = createMockElements();
    const target = elements[0];

    const signature = VisualAnchorManager.createSignature(target, elements);

    // Change button text to partial match
    const newElements = elements.map(el => ({
      ...el,
      name: el.name === 'Submit' ? 'Submit Form' : el.name,
    }));

    const { confidence } = VisualAnchorManager.findBySignature(signature, newElements);

    // Partial match gives 0.2 instead of 0.4
    expect(confidence).toBeLessThan(1.0);
    expect(confidence).toBeGreaterThan(0.5);
  });

  it('should score anchor matches independently', () => {
    const elements = createMockElements();
    const target = elements[0];

    const signature = VisualAnchorManager.createSignature(target, elements);

    // Remove one anchor (heading)
    const newElements = elements.filter(el => el.ref !== 'e2');

    const { confidence: confidenceWithoutAnchor } = VisualAnchorManager.findBySignature(
      signature,
      newElements
    );

    const { confidence: confidenceWithAll } = VisualAnchorManager.findBySignature(
      signature,
      elements
    );

    // Less anchors = lower confidence
    expect(confidenceWithoutAnchor).toBeLessThan(confidenceWithAll);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('should handle elements without bounds', () => {
    const elementWithoutBounds = createMockElement({
      ref: 'e1',
      name: 'No Bounds',
      bounds: undefined,
    });

    const elements = [elementWithoutBounds];
    const signature = VisualAnchorManager.createSignature(elementWithoutBounds, elements);

    expect(signature.ownText).toBe('No Bounds');
    expect(signature.anchors.length).toBe(0);
  });

  it('should filter out dynamic IDs in anchor detection', () => {
    const elements = [
      createMockElement({
        ref: 'e1',
        name: 'Submit',
        tag: 'button',
        bounds: { x: 200, y: 200, width: 100, height: 40 },
      }),
      // Pattern: starts with _ followed by alphanumeric
      createMockElement({
        ref: 'e2',
        name: '_abc123xyz',
        tag: 'span',
        bounds: { x: 100, y: 200, width: 50, height: 20 },
      }),
      // Pattern: pure alphanumeric 6+ chars (hash-like)
      createMockElement({
        ref: 'e3',
        name: 'a1b2c3d4e5',
        tag: 'span',
        bounds: { x: 300, y: 200, width: 50, height: 20 },
      }),
      // Real text content (should be included)
      createMockElement({
        ref: 'e4',
        name: 'Help Text',
        tag: 'span',
        bounds: { x: 200, y: 150, width: 80, height: 20 },
      }),
    ];

    const signature = VisualAnchorManager.createSignature(elements[0], elements);

    // Dynamic ID patterns should not be included as anchors
    const dynamicAnchors = signature.anchors.filter(
      a => a.value === '_abc123xyz' || a.value === 'a1b2c3d4e5'
    );
    expect(dynamicAnchors.length).toBe(0);

    // Real text should be included
    const realTextAnchor = signature.anchors.find(a => a.value === 'Help Text');
    expect(realTextAnchor).toBeDefined();
  });

  it('should handle empty element list', () => {
    const target = createMockElement();
    const signature = VisualAnchorManager.createSignature(target, [target]);

    expect(signature.anchors.length).toBe(0);
  });

  it('should handle signature with type field', () => {
    const inputElement = createMockElement({
      ref: 'e1',
      name: 'Email',
      tag: 'input',
      type: 'email',
      bounds: { x: 100, y: 100, width: 200, height: 30 },
    });

    const elements = [inputElement];
    const signature = VisualAnchorManager.createSignature(inputElement, elements);

    expect(signature.type).toBe('email');

    // Should only match inputs with same type
    const wrongTypeInput = createMockElement({
      ref: 'e2',
      name: 'Email',
      tag: 'input',
      type: 'text', // Different type
      bounds: { x: 100, y: 100, width: 200, height: 30 },
    });

    const { element } = VisualAnchorManager.findBySignature(signature, [wrongTypeInput]);
    expect(element).toBeNull(); // Type mismatch
  });
});
