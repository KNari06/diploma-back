# 🚨 CRITICAL SECURITY FIX REQUIRED

## Problem Identified

Real production credentials have been committed to the repository:

1. ✅ **FIXED**: `.env` file removed from git index and added to `.gitignore`
2. ✅ **FIXED**: GitHub Actions workflow now uses `${{ secrets.DEPLOY_SSH_PRIVATE_KEY }}` instead of hardcoded key
3. ⚠️ **ACTION REQUIRED**: `.env` file still exists in git history and must be removed

## Immediate Actions Required

### 1. Remove .env from Git History

**Option A: Using the provided script (recommended)**

```bash
./scripts/remove-env-from-history.sh
```

**Option B: Manual removal**

```bash
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch .env" \
  --prune-empty --tag-name-filter cat -- --all

git for-each-ref --format="%(refname)" refs/original/ | xargs -n 1 git update-ref -d
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# Force push (WARNING: This rewrites history!)
git push origin --force --all
git push origin --force --tags
```

### 2. Set Up GitHub Secrets

Go to: `Settings → Secrets and variables → Actions → New repository secret`

Add the following secret:

- **Name**: `DEPLOY_SSH_PRIVATE_KEY`
- **Value**: Your SSH private key (the one that was hardcoded in `.github/workflows/ci.yml`)

### 3. ROTATE ALL CREDENTIALS (CRITICAL!)

Since `.env` was in git history, **ALL credentials must be rotated immediately**:

#### Supabase

- [ ] Generate new `SUPABASE_ANON_KEY`
- [ ] Generate new `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Update `SUPABASE_JWT_SECRET` in Supabase dashboard

#### OpenAI

- [ ] Generate new `OPENAI_API_KEY` at https://platform.openai.com/api-keys
- [ ] Revoke old key

#### JWT Secrets

- [ ] Generate new `JWT_SECRET` (32+ random characters)
- [ ] Generate new `API_KEY_SECRET`
- [ ] Generate new `ENCRYPTION_SECRET` (32+ chars for AES-256)

#### Redis

- [ ] Change `REDIS_PASSWORD` on server `35.202.242.230:6379`
- [ ] Update connection string in production `.env`

#### Jira OAuth

- [ ] Regenerate `JIRA_CLIENT_SECRET` in Jira OAuth app settings
- [ ] Update callback URL if needed

#### SSH Key (for deployment)

- [ ] Generate new SSH key pair
- [ ] Add public key to server `34.172.156.158`
- [ ] Add private key to GitHub Secrets as `DEPLOY_SSH_PRIVATE_KEY`
- [ ] Revoke old SSH key from server

### 4. Update Production Environment

After rotating credentials:

1. Update `.env` file on production server `34.172.156.158`
2. Restart all services
3. Verify all integrations work

### 5. Notify Team

- [ ] Notify all team members to re-clone the repository (after history rewrite)
- [ ] Share new credentials securely (use password manager, not email/chat)

## Files Changed

- ✅ `.gitignore` - Added `.env` and `.env.*` patterns
- ✅ `.github/workflows/ci.yml` - Now uses `${{ secrets.DEPLOY_SSH_PRIVATE_KEY }}`
- ✅ `.env` - Removed from git index (still in history, needs cleanup)

## Prevention

To prevent this in the future:

1. ✅ `.env` is now in `.gitignore`
2. ✅ Use `env.example` for documentation
3. ✅ Always use GitHub Secrets for CI/CD
4. ✅ Review commits before pushing: `git diff --cached`
5. ✅ Use pre-commit hooks to detect secrets

## Status

- [x] `.env` removed from git index
- [x] `.gitignore` updated
- [x] GitHub Actions workflow fixed
- [ ] `.env` removed from git history (requires manual action)
- [ ] GitHub Secrets configured (requires manual action)
- [ ] All credentials rotated (requires manual action)

**⚠️ DO NOT COMMIT THIS FILE - It contains security information!**
