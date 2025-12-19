#!/bin/bash

# Auto-update documentation based on changed files
# This script automatically detects which feature docs need updating

CHANGED_FILES="$1"

if [ -z "$CHANGED_FILES" ]; then
    echo "Usage: ./auto-update.sh <file1.ts> [file2.ts ...]"
    exit 1
fi

FEATURE_MAP=(
    "src/agent/|intelligent-testing"
    "src/api/chat/|chat-flow"
    "src/api/auth/|authentication"
    "src/ai/prompts/|prompts-system"
    "src/services/core/pricing-plans.service.ts|credits-system"
    "src/services/core/user-credits.service.ts|credits-system"
    "src/websocket/|websocket"
)

for file in $CHANGED_FILES; do
    echo "Processing: $file"

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
        echo "⚠️  No feature mapping found for: $file"
        continue
    fi

    FEATURE_DIR="docs/features/features/$FEATURE"

    if [ ! -d "$FEATURE_DIR" ]; then
        echo "⚠️  Feature directory not found: $FEATURE_DIR"
        continue
    fi

    echo "📝 Updating documentation for: $FEATURE"

    # Track changes
    echo "  → Tracking changes..."
    node docs/features/scripts/track-changes.js "$file" --feature="$FEATURE_DIR" || echo "  ⚠️  track-changes failed"

    # Update diagrams
    echo "  → Updating diagrams..."
    node docs/features/scripts/update-docs.js --feature="$FEATURE_DIR" || echo "  ⚠️  update-docs failed"

    echo "✅ Updated: $FEATURE"
done

echo ""
echo "🎉 Documentation update complete!"
