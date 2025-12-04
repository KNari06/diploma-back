# Scripts

Utility scripts for development and testing.

## create-test-users.ts

Creates 10 test users with authentication enabled.

### Usage

```bash
npm run create-test-users
```

### What it does

1. Creates users in `auth.users` via Supabase Admin API
2. Trigger automatically syncs to `public.users`
3. Updates `public.users` with correct credits (1000) and subscription plans

### Test Users

All users have:
- **Password:** `test123456`
- **Plan:** `professional`
- **Credits:** `1000`

| Email | Name | Role | Credits | Plan |
|-------|------|------|---------|------|
| `test1@qai-test.local` | Test User 1 | user | 1000 | professional |
| `test2@qai-test.local` | Test User 2 | user | 1000 | professional |
| `test3@qai-test.local` | Test User 3 | user | 1000 | professional |
| `test4@qai-test.local` | Test User 4 | user | 1000 | professional |
| `test5@qai-test.local` | Test User 5 | user | 1000 | professional |
| `test6@qai-test.local` | Test User 6 | user | 1000 | professional |
| `admin@qai-test.local` | Test Admin User | **admin** | 1000 | professional |
| `test8@qai-test.local` | Test User 8 | user | 1000 | professional |
| `test9@qai-test.local` | Test User 9 | user | 1000 | professional |
| `test10@qai-test.local` | Test User 10 | user | 1000 | professional |

### Login

You can now login with any of these users:

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test1@qai-test.local",
    "password": "test123456"
  }'
```

### Requirements

- `.env` file with `SUPABASE_SERVICE_ROLE_KEY` set
- `auth-sync.sql` migration applied (creates trigger for auto-sync)

### Notes

- If user already exists, script will update existing user
- Script is idempotent (safe to run multiple times)
- All users have email confirmed (no verification needed)

## analyze-playwright-selector.ts

Analyzes how Playwright finds elements on a page. Helps debug selector issues like finding `<span>` instead of `<button>`.

### Usage

```bash
npm run analyze-selector
```

### What it does

1. Opens the target page (`https://repetino.kz/onboarding`)
2. Analyzes DOM structure around target text ("Математика")
3. Tests different selector methods:
   - `getByText()` - what element does it find?
   - `getByRole('button')` - does it find the button?
   - CSS selector `button:has-text()` - alternative approach
4. Compares viewport positions of found elements
5. Tests click attempts and viewport checks

### Output

The script shows:
- Which elements contain the target text
- HTML structure (tag, parent, classes, role)
- What `getByText()` finds vs `getByRole()`
- Viewport positions and visibility
- Why clicks might fail

### Configuration

Edit the script to change:
- `URL` - target page URL
- `TARGET_TEXT` - text to search for
