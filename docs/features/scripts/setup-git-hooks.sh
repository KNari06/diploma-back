#!/bin/bash

# Setup Git hooks for automatic documentation updates

GIT_DIR=$(git rev-parse --git-dir)
HOOKS_DIR="$GIT_DIR/hooks"

# Create pre-commit hook
cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash

# Pre-commit hook for documentation updates
# This hook runs before commit to check if documentation needs updating

CHANGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep '\.ts$')

if [ -z "$CHANGED_FILES" ]; then
    exit 0
fi

echo "Checking if documentation needs updating..."

# Check if any changed files match feature patterns
for file in $CHANGED_FILES; do
    if [[ $file == src/agent/* ]]; then
        echo "⚠️  Agent files changed - consider updating intelligent-testing docs"
    fi
    if [[ $file == src/api/chat/* ]]; then
        echo "⚠️  Chat files changed - consider updating chat-flow docs"
    fi
    if [[ $file == src/api/auth/* ]]; then
        echo "⚠️  Auth files changed - consider updating authentication docs"
    fi
    if [[ $file == src/ai/prompts/* ]]; then
        echo "⚠️  Prompt files changed - consider updating prompts-system docs"
    fi
done

exit 0
EOF

# Create post-commit hook
cat > "$HOOKS_DIR/post-commit" << 'EOF'
#!/bin/bash

# Post-commit hook for documentation updates
# This hook runs after commit to optionally update documentation

echo "Documentation update hook (post-commit)"
echo "To update docs manually, run:"
echo "  node docs/features/scripts/track-changes.js <file.ts> --feature=docs/features/features/<feature-name>"
echo "  node docs/features/scripts/update-docs.js --feature=docs/features/features/<feature-name>"

exit 0
EOF

chmod +x "$HOOKS_DIR/pre-commit"
chmod +x "$HOOKS_DIR/post-commit"

echo "✅ Git hooks installed successfully"
echo "  - pre-commit: Warns about files that may need doc updates"
echo "  - post-commit: Reminds to update docs if needed"
