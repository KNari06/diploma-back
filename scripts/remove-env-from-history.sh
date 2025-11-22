#!/bin/bash
# ⚠️ CRITICAL SECURITY FIX: Remove .env from git history
#
# WARNING: This script will rewrite git history!
# Only run this if you understand the consequences.
# All team members will need to re-clone the repository after this.

set -e

echo "⚠️  WARNING: This will rewrite git history!"
echo "⚠️  All team members must re-clone the repository after this."
echo ""
read -p "Are you sure you want to continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 1
fi

echo "Removing .env from git history..."

# Method 1: Using git filter-branch (works on all systems)
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch .env" \
  --prune-empty --tag-name-filter cat -- --all

# Clean up backup refs
git for-each-ref --format="%(refname)" refs/original/ | xargs -n 1 git update-ref -d

# Force garbage collection
git reflog expire --expire=now --all
git gc --prune=now --aggressive

echo ""
echo "✅ .env removed from git history"
echo ""
echo "⚠️  NEXT STEPS (CRITICAL):"
echo "1. Force push to remote: git push origin --force --all"
echo "2. Force push tags: git push origin --force --tags"
echo "3. Notify all team members to re-clone the repository"
echo "4. ROTATE ALL CREDENTIALS that were in .env:"
echo "   - Supabase keys"
echo "   - OpenAI API key"
echo "   - JWT secrets"
echo "   - Redis password"
echo "   - Jira OAuth credentials"
echo "   - SSH private key (already fixed in GitHub Secrets)"
