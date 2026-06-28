#!/usr/bin/env bash
#
# Register (or inspect) the QAIT Tasker Telegram webhook.
#
# Secrets are READ FROM THE ENVIRONMENT — never type them inline, never commit
# them. Run AFTER the new code is deployed + the server restarted, and after the
# prod env has TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET set (the SAME secret
# the server checks). HTTPS with a valid cert is required by Telegram.
#
# Usage:
#   export TELEGRAM_BOT_TOKEN=...            # the rotated bot token
#   export TELEGRAM_WEBHOOK_SECRET=...       # the rotated secret (must match prod env)
#   export PUBLIC_BASE_URL=https://api.qait.dev   # your prod domain, no trailing slash
#   ./scripts/register-telegram-webhook.sh           # set the webhook
#   ./scripts/register-telegram-webhook.sh info      # show current webhook status
#   ./scripts/register-telegram-webhook.sh delete    # remove the webhook
#
# API_VERSION defaults to v1 (matches env default); override with API_VERSION=...

set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN in the environment}"
API_VERSION="${API_VERSION:-v1}"
BASE="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

cmd="${1:-set}"

case "$cmd" in
  info)
    curl -fsS "${BASE}/getWebhookInfo" | sed 's/,/,\n/g'
    ;;

  delete)
    # drop_pending_updates clears the backlog so a fresh start isn't flooded.
    curl -fsS -X POST "${BASE}/deleteWebhook" \
      -H 'Content-Type: application/json' \
      -d '{"drop_pending_updates": true}'
    echo
    ;;

  set)
    : "${TELEGRAM_WEBHOOK_SECRET:?Set TELEGRAM_WEBHOOK_SECRET (must match the server env)}"
    : "${PUBLIC_BASE_URL:?Set PUBLIC_BASE_URL, e.g. https://api.qait.dev (no trailing slash)}"
    URL="${PUBLIC_BASE_URL%/}/api/${API_VERSION}/telegram-tasks/webhook"
    echo "Registering webhook → ${URL}"
    # allowed_updates limits Telegram to the two update kinds the bot handles,
    # so it isn't billed/woken for everything (joins, polls, reactions, ...).
    curl -fsS -X POST "${BASE}/setWebhook" \
      -H 'Content-Type: application/json' \
      --data-binary @- <<JSON | sed 's/,/,\n/g'
{
  "url": "${URL}",
  "secret_token": "${TELEGRAM_WEBHOOK_SECRET}",
  "allowed_updates": ["message", "edited_message"],
  "drop_pending_updates": true
}
JSON
    echo
    echo "Done. Verify with: $0 info   (last_error_message must be empty)"
    ;;

  *)
    echo "Usage: $0 [set|info|delete]" >&2
    exit 1
    ;;
esac
