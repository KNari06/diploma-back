# Intent Classification Examples

This document contains examples for training the intent parser to better understand user requests in the QAIT testing platform.

## Platform Test Intent Examples

### Full Platform Testing

- "test the entire website" → intent: platform_test, scope: full
- "explore and test all pages" → intent: platform_test, scope: full
- "comprehensive platform testing" → intent: platform_test, scope: full
- "check the whole application" → intent: platform_test, scope: full
- "scan complete website" → intent: platform_test, scope: full

### Specific Page Testing

- "test the homepage" → intent: platform_test, scope: page, target: homepage
- "check about us page" → intent: platform_test, scope: page, target: about us
- "validate dashboard page" → intent: platform_test, scope: page, target: dashboard
- "analyze product page" → intent: platform_test, scope: page, target: product

### Element Testing

- "test the search button" → intent: platform_test, scope: element, target: search button
- "check submit button works" → intent: platform_test, scope: element, target: submit button
- "verify dropdown menu" → intent: platform_test, scope: element, target: dropdown menu
- "validate input field" → intent: platform_test, scope: element, target: input field
- "test navigation bar" → intent: platform_test, scope: element, target: navigation bar

### User Flow Testing

- "test the login flow" → intent: platform_test, scope: flow, target: login
- "check sign up process" → intent: platform_test, scope: flow, target: sign up
- "verify checkout flow" → intent: platform_test, scope: flow, target: checkout
- "test user journey from landing to purchase" → intent: platform_test, scope: flow, target: landing to purchase
- "check onboarding process" → intent: platform_test, scope: flow, target: onboarding
- "retry flow test" → intent: platform_test, scope: flow, target: retry
- "retry mechanism testing" → intent: platform_test, scope: flow, target: retry mechanism
- "user journey scenario" → intent: platform_test, scope: flow, target: user journey
- "end to end flow" → intent: platform_test, scope: flow, target: end to end

### Form Testing

- "test registration form" → intent: platform_test, scope: form, target: registration
- "check login form" → intent: platform_test, scope: form, target: login
- "verify contact form" → intent: platform_test, scope: form, target: contact
- "validate payment form" → intent: platform_test, scope: form, target: payment
- "test form validation" → intent: platform_test, scope: form, target: validation
- "check form submission" → intent: platform_test, scope: form, target: submission

### Authentication Testing

- "test login functionality" → intent: platform_test, scope: auth, target: login
- "check authentication" → intent: platform_test, scope: auth, target: authentication
- "verify sign in works" → intent: platform_test, scope: auth, target: sign in
- "test user authentication" → intent: platform_test, scope: auth, target: user authentication
- "check logout process" → intent: platform_test, scope: auth, target: logout
- "verify password reset" → intent: platform_test, scope: auth, target: password reset

### Navigation Testing

- "test website navigation" → intent: platform_test, scope: navigation, target: website navigation
- "check menu functionality" → intent: platform_test, scope: navigation, target: menu
- "verify breadcrumbs" → intent: platform_test, scope: navigation, target: breadcrumbs
- "test sidebar navigation" → intent: platform_test, scope: navigation, target: sidebar
- "check page routing" → intent: platform_test, scope: navigation, target: routing

### Edge Cases and Special Scenarios

- "edge case testing" → intent: platform_test, scope: flow, target: edge cases
- "error scenario validation" → intent: platform_test, scope: flow, target: error scenarios
- "boundary testing" → intent: platform_test, scope: element, target: boundaries
- "stress test the form" → intent: platform_test, scope: form, target: stress test
- "negative testing" → intent: platform_test, scope: flow, target: negative cases
- "corner case scenarios" → intent: platform_test, scope: flow, target: corner cases
- "failure scenario testing" → intent: platform_test, scope: flow, target: failure scenarios
- "happy path validation" → intent: platform_test, scope: flow, target: happy path
- "sad path testing" → intent: platform_test, scope: flow, target: sad path

## API Test Intent Examples

### GET Requests

- "test GET endpoint" → intent: api_test, apiMethod: GET
- "check GET request to /api/users" → intent: api_test, apiMethod: GET, apiUrl: /api/users
- "verify GET /api/posts returns 200" → intent: api_test, apiMethod: GET, apiUrl: /api/posts
- "test GET https://api.example.com/data" → intent: api_test, apiMethod: GET, apiUrl: https://api.example.com/data
- "fetch data from /api/products" → intent: api_test, apiMethod: GET, apiUrl: /api/products

### POST Requests

- "test POST endpoint" → intent: api_test, apiMethod: POST
- "check POST /api/users" → intent: api_test, apiMethod: POST, apiUrl: /api/users
- "send POST request to create user" → intent: api_test, apiMethod: POST
- "test POST with body" → intent: api_test, apiMethod: POST
- "create new resource via POST" → intent: api_test, apiMethod: POST

### PUT/PATCH Requests

- "test PUT /api/users/1" → intent: api_test, apiMethod: PUT, apiUrl: /api/users/1
- "update resource with PATCH" → intent: api_test, apiMethod: PATCH
- "test PATCH endpoint" → intent: api_test, apiMethod: PATCH
- "modify user via PUT" → intent: api_test, apiMethod: PUT

### DELETE Requests

- "test DELETE /api/users/1" → intent: api_test, apiMethod: DELETE, apiUrl: /api/users/1
- "remove resource via DELETE" → intent: api_test, apiMethod: DELETE
- "test deletion endpoint" → intent: api_test, apiMethod: DELETE

### API General Testing

- "validate API response" → intent: api_test
- "check API status codes" → intent: api_test
- "test API authentication" → intent: api_test
- "verify API headers" → intent: api_test
- "test API error handling" → intent: api_test
- "check API rate limiting" → intent: api_test
- "validate JSON response" → intent: api_test
- "test API timeout" → intent: api_test

### Relative Path API Testing

- "test /api/v1/users" → intent: api_test, apiUrl: /api/v1/users
- "check /v2/products endpoint" → intent: api_test, apiUrl: /v2/products
- "verify /api/auth/login" → intent: api_test, apiUrl: /api/auth/login
- "test /graphql endpoint" → intent: api_test, apiUrl: /graphql

## General Chat Intent Examples

### Capability Questions

- "what can you do?" → intent: general_chat
- "how does this work?" → intent: general_chat
- "what features do you have?" → intent: general_chat
- "tell me about your capabilities" → intent: general_chat
- "what testing can you perform?" → intent: general_chat

### Help Requests

- "help me with testing" → intent: general_chat
- "how do I test my website?" → intent: general_chat
- "explain API testing" → intent: general_chat
- "what is UI testing?" → intent: general_chat
- "show me examples" → intent: general_chat

### General Information

- "hello" → intent: general_chat
- "hi, how are you?" → intent: general_chat
- "thanks" → intent: general_chat
- "good job" → intent: general_chat
- "explain the difference between UI and API testing" → intent: general_chat

## Complex/Ambiguous Cases

### Could Be Platform Test or General Chat

- "how to test login" → intent: general_chat (asking how, not requesting test)
- "test login" → intent: platform_test, scope: auth, target: login (direct command)
- "explain sign up flow" → intent: general_chat (asking for explanation)
- "test sign up flow" → intent: platform_test, scope: flow, target: sign up (direct command)

### Context-Dependent Cases

- "retry scenario" → intent: platform_test, scope: flow, target: retry (testing context)
- "process validation" → intent: platform_test, scope: flow, target: process validation
- "check behavior" → intent: platform_test, scope: element (vague but testing implied)
- "verify functionality" → intent: platform_test, scope: full (general testing request)

## Keywords That Indicate Testing Intent

### Action Keywords (Strong Indicators)

- test, check, verify, validate, explore, analyze, scan, inspect, examine
- ensure, confirm, assess, evaluate, measure, monitor
- try, attempt, execute, run, perform

### Testing-Specific Terms

- scenario, flow, journey, process, mechanism, sequence
- edge case, corner case, boundary, limit, threshold
- error case, failure case, negative case, sad path, happy path
- retry, timeout, latency, response time, performance

### Platform Testing Keywords

- page, form, button, input, field, element, component
- navigation, menu, link, route, redirect
- login, signup, authentication, registration, checkout
- modal, popup, dialog, dropdown, accordion

### API Testing Keywords

- endpoint, route, path, URL, request, response
- status code, header, body, payload, JSON, XML
- GET, POST, PUT, PATCH, DELETE, OPTIONS
- authentication, authorization, token, API key
