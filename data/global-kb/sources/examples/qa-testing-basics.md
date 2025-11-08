# QA Testing Basics

## What is QA Testing?

Quality Assurance (QA) testing is the process of evaluating software to ensure it meets requirements and functions correctly. QA testing helps identify bugs, performance issues, and usability problems before they reach end users.

## Types of Testing

### 1. Functional Testing
Verifies that the application functions according to requirements. This includes:
- Unit testing: Testing individual components
- Integration testing: Testing component interactions
- System testing: Testing the complete system
- Acceptance testing: Validating against business requirements

### 2. API Testing
Testing REST APIs, GraphQL endpoints, and other backend services:
- Verify correct HTTP status codes (200, 404, 401, etc.)
- Validate response structure and data types
- Test authentication and authorization
- Check error handling
- Measure response times

Example API test:
```
GET /api/users
Expected: 200 OK
Response should contain array of user objects with id, name, email fields
```

### 3. UI Testing
Testing user interface elements and interactions:
- Element visibility and positioning
- Button clicks and form submissions
- Input validation
- Navigation flows
- Responsive design (mobile, tablet, desktop)

### 4. Performance Testing
Measuring application speed and responsiveness:
- Page load times
- API response times
- Database query performance
- Memory usage
- Concurrent user handling

## Best Practices

### API Testing Best Practices
1. Always verify status codes
2. Validate response structure
3. Test error scenarios (401, 404, 500)
4. Check authentication requirements
5. Measure response times
6. Test with different payloads
7. Verify headers (Content-Type, Authorization)

### UI Testing Best Practices
1. Test on multiple browsers (Chrome, Firefox, Safari)
2. Test on different screen sizes
3. Verify accessibility
4. Check loading states
5. Test error messages
6. Validate form submissions
7. Check navigation flows

## Common Issues

### API Testing Issues
- Missing authentication headers
- Incorrect request body format
- Wrong HTTP method
- Invalid URL or endpoint
- CORS errors
- Timeout issues

### UI Testing Issues
- Element not found (incorrect selector)
- Element not visible
- Timing issues (element not loaded)
- Click intercepted by another element
- Input validation failures
- Navigation redirects

## Playwright Specific

### Playwright Advantages
- Cross-browser testing (Chromium, Firefox, WebKit)
- Mobile emulation
- Automatic waiting
- Network interception
- Screenshot and video capture
- Trace recording for debugging

### Common Playwright Commands
```javascript
// Navigation
await page.goto('https://example.com');

// Click
await page.click('button#submit');

// Fill input
await page.fill('input#email', 'test@example.com');

// Assert
await expect(page.locator('text=Welcome')).toBeVisible();

// Wait
await page.waitForSelector('.main-content');
```

## Testing Workflow

1. **Plan**: Identify what to test
2. **Design**: Create test scenarios
3. **Execute**: Run tests
4. **Analyze**: Review results
5. **Report**: Document bugs
6. **Fix**: Resolve issues
7. **Retest**: Verify fixes

## Tools and Frameworks

- **Playwright**: Browser automation
- **Jest**: JavaScript testing framework
- **Postman**: API testing
- **Cypress**: E2E testing
- **Selenium**: Browser automation
- **JMeter**: Performance testing
