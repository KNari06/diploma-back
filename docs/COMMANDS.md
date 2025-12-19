# Playwright Commands Guide

## Overview

This document describes the Playwright command system that allows AI to generate executable browser automation commands from natural language requests.

## Flow

```
User Request → Intent Parser (AI) → Playwright Commands (JSON) → Command Executor → Browser Actions → Results
```

**Example:**
```
"Проверь кнопку Buy на https://shop.com"
↓
{
  "intent": "check_element",
  "commands": [
    { "action": "goto", "url": "https://shop.com" },
    { "action": "assertVisible", "selector": "button:has-text('Buy')" },
    { "action": "click", "selector": "button:has-text('Buy')" }
  ]
}
↓
Playwright executes actions in browser
↓
Returns: screenshots, logs, errors, assertions results
```

## Available Commands

### Navigation
- **`goto`** - Navigate to URL
  ```json
  { "action": "goto", "url": "https://example.com", "waitFor": "networkidle" }
  ```

### Interactions
- **`click`** - Click element
  ```json
  { "action": "click", "selector": "button:has-text('Submit')" }
  ```

- **`fill`** - Fill input field
  ```json
  { "action": "fill", "selector": "input[name='email']", "value": "test@test.com" }
  ```

- **`type`** - Type text with keyboard events
  ```json
  { "action": "type", "selector": "input", "value": "Hello" }
  ```

- **`check/uncheck`** - Toggle checkbox
  ```json
  { "action": "check", "selector": "input[type='checkbox']" }
  ```

- **`select`** - Select dropdown option
  ```json
  { "action": "select", "selector": "select[name='country']", "value": "USA" }
  ```

- **`hover`** - Hover over element
  ```json
  { "action": "hover", "selector": ".menu-item" }
  ```

- **`press`** - Press keyboard key
  ```json
  { "action": "press", "value": "Enter" }
  ```

### Waits
- **`wait`** - Wait for timeout
  ```json
  { "action": "wait", "timeout": 2000 }
  ```

- **`waitForSelector`** - Wait for element to appear
  ```json
  { "action": "waitForSelector", "selector": ".loading-done", "timeout": 5000 }
  ```

- **`waitForNavigation`** - Wait for page to load
  ```json
  { "action": "waitForNavigation", "timeout": 5000 }
  ```

### Assertions
- **`assertVisible`** - Check element is visible
  ```json
  { "action": "assertVisible", "selector": "button.submit" }
  ```

- **`assertText`** - Check element text
  ```json
  {
    "action": "assertText",
    "selector": ".message",
    "assertion": {
      "type": "text",
      "expected": "Success",
      "operator": "contains"
    }
  }
  ```

- **`assertValue`** - Check input value
  ```json
  {
    "action": "assertValue",
    "selector": "input#email",
    "assertion": {
      "type": "value",
      "expected": "test@example.com",
      "operator": "="
    }
  }
  ```

- **`assertUrl`** - Check current URL
  ```json
  {
    "action": "assertUrl",
    "assertion": {
      "type": "url",
      "expected": "/dashboard",
      "operator": "contains"
    }
  }
  ```

- **`assertCount`** - Check number of elements
  ```json
  {
    "action": "assertCount",
    "selector": ".list-item",
    "assertion": {
      "type": "count",
      "expected": 5,
      "operator": ">"
    }
  }
  ```

### Other
- **`screenshot`** - Take screenshot
  ```json
  { "action": "screenshot" }
  ```

- **`scroll`** - Scroll page or element
  ```json
  { "action": "scroll", "selector": ".bottom-section" }
  ```

- **`extract`** - Extract data from element
  ```json
  {
    "action": "extract",
    "selector": ".product-price",
    "extract": {
      "name": "price",
      "property": "text"
    }
  }
  ```

- **`evaluate`** - Execute JavaScript
  ```json
  { "action": "evaluate", "value": "console.log('test')" }
  ```

## Selectors

### CSS Selectors
```json
"selector": "button"
"selector": ".btn-primary"
"selector": "#submit-button"
"selector": "input[name='email']"
```

### Text Selectors
```json
"selector": "text=Login"
"selector": "button:has-text('Buy')"
```

### Aria Labels
```json
"selector": "button[aria-label='Close']"
```

### Placeholders
```json
"selector": "input[placeholder='Email']"
```

## Command Options

### Common Fields
- `description` (string) - Human-readable description
- `timeout` (number) - Timeout in milliseconds (default: 30000)
- `continueOnError` (boolean) - Continue if command fails
- `screenshot` (boolean) - Take screenshot after command

### Example with Options
```json
{
  "action": "click",
  "selector": "button.submit",
  "description": "Click submit button",
  "timeout": 5000,
  "screenshot": true,
  "continueOnError": false
}
```

## Operators for Assertions

- `=` - Exact match
- `!=` - Not equal
- `>` - Greater than (numbers)
- `<` - Less than (numbers)
- `contains` - String contains substring
- `startsWith` - String starts with
- `endsWith` - String ends with

## Example Test Plan

```json
{
  "url": "https://shop.com",
  "description": "Test product purchase flow",
  "commands": [
    {
      "action": "goto",
      "url": "https://shop.com/products",
      "description": "Navigate to products page"
    },
    {
      "action": "waitForSelector",
      "selector": ".product-grid",
      "description": "Wait for products to load"
    },
    {
      "action": "click",
      "selector": ".product:first-child .btn-buy",
      "description": "Click buy button on first product"
    },
    {
      "action": "waitForNavigation",
      "description": "Wait for cart page"
    },
    {
      "action": "assertUrl",
      "assertion": {
        "type": "url",
        "expected": "/cart",
        "operator": "contains"
      },
      "description": "Verify redirected to cart"
    },
    {
      "action": "assertVisible",
      "selector": ".cart-item",
      "description": "Verify item in cart"
    },
    {
      "action": "screenshot",
      "description": "Take final screenshot"
    }
  ]
}
```

## Error Handling

Commands can fail for various reasons:
- Element not found
- Timeout exceeded
- Navigation failed
- Assertion failed

Use `continueOnError: true` to continue test execution despite errors.

## Best Practices

1. **Always add waits** before interacting with dynamic content
2. **Use text selectors** when possible (more readable and stable)
3. **Add assertions** after critical actions to verify success
4. **Take screenshots** at key points for debugging
5. **Use descriptive descriptions** for each command
6. **Set appropriate timeouts** based on expected page load times
