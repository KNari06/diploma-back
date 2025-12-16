#!/bin/bash

# Setup Git hooks for REAL automatic documentation updates
# This version actually runs the update scripts automatically

GIT_DIR=$(git rev-parse --git-dir)
HOOKS_DIR="$GIT_DIR/hooks"

# Create pre-commit hook that actually updates docs
cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash

# Pre-commit hook for automatic documentation updates
# This hook runs before commit and automatically updates documentation

CHANGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep '\.ts$')

if [ -z "$CHANGED_FILES" ]; then
    exit 0
fi

echo "🔄 Auto-updating documentation for changed files..."

# Feature mapping
FEATURE_MAP=(
    "src/agent/|intelligent-testing"
    "src/api/chat/|chat-flow"
    "src/api/auth/|authentication"
    "src/ai/prompts/|prompts-system"
    "src/services/core/pricing-plans.service.ts|credits-system"
    "src/services/core/user-credits.service.ts|credits-system"
    "src/websocket/|websocket"
)

UPDATED_FEATURES=()

for file in $CHANGED_FILES; do
    FEATURE=""
    for mapping in "${FEATURE_MAP[@]}"; do
        PATTERN=$(echo $mapping | cut -d'|' -f1)
        FEATURE_NAME=$(echo $mapping | cut -d'|' -f2)

        if [[ $file == *$PATTERN* ]]; then
            FEATURE=$FEATURE_NAME
            break
        fi
    done

    if [ -z "$FEATURE" ]; then
        continue
    fi

    # Check if we already updated this feature
    if [[ " ${UPDATED_FEATURES[@]} " =~ " ${FEATURE} " ]]; then
        continue
    fi

    FEATURE_DIR="docs/features/features/$FEATURE"

    if [ ! -d "$FEATURE_DIR" ]; then
        continue
    fi

    echo "  📝 Updating: $FEATURE"

    # Track changes
    node docs/features/scripts/track-changes.js "$file" --feature="$FEATURE_DIR" 2>/dev/null || true

    # Update diagrams
    node docs/features/scripts/update-docs.js --feature="$FEATURE_DIR" 2>/dev/null || true

    UPDATED_FEATURES+=("$FEATURE")
done

if [ ${#UPDATED_FEATURES[@]} -gt 0 ]; then
    echo "✅ Documentation updated for: ${UPDATED_FEATURES[*]}"
    # Stage updated documentation files
    git add docs/features/features/*/methods.json docs/features/features/*/changelog.json docs/features/features/*/flow-diagram.md 2>/dev/null || true
fi

exit 0
EOF

# Create post-commit hook
cat > "$HOOKS_DIR/post-commit" << 'EOF'
#!/bin/bash

# Post-commit hook for documentation updates
# This hook runs after commit

echo "✅ Commit completed"
echo "📚 Documentation is automatically updated on pre-commit"
EOF

chmod +x "$HOOKS_DIR/pre-commit"
chmod +x "$HOOKS_DIR/post-commit"

echo "✅ Auto-update Git hooks installed successfully!"
echo ""
echo "📋 What happens now:"
echo "  - pre-commit: Automatically updates documentation before commit"
echo "  - post-commit: Confirmation message"
echo ""
echo "🔄 When you commit files in src/agent/, src/api/chat/, etc.,"
echo "   documentation will be automatically updated!"
