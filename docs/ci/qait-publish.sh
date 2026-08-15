#!/usr/bin/env bash
#
# qait-publish.sh — publish a mobile build to QAIT from a CI/CD pipeline.
# Version: 1.0.0
#
#   ./qait-publish.sh --check                 # verify key + network, upload nothing
#   ./qait-publish.sh build/app/outputs/flutter-apk/app-debug.apk
#   ./qait-publish.sh --variant Staging app-debug.apk
#
# Requires: bash, curl, jq.
# Auth:     QAIT_CI_KEY must be set (store it as a CI secret, never in the repo).
#
# The binary never transits the QAIT backend: this asks for a signed URL, PUTs
# the file straight to blob storage, then tells QAIT the object is there.
#
# Exit codes: 0 ok (or build already published) · 1 usage/env · 2 network
#             3 rejected by QAIT · 4 rate limited

set -euo pipefail

API_BASE="${QAIT_API_BASE:-https://api.qait.dev}"
API="$API_BASE/api/v1/mobile/ci"

PLATFORM="android"   # a Flutter Android build IS an .apk and is stored as android
VARIANT=""
APK=""
CHECK_ONLY=0

# ── args ───────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --check)     CHECK_ONLY=1; shift ;;
    --variant)   VARIANT="${2:-}"; shift 2 ;;
    --platform)  PLATFORM="${2:-}"; shift 2 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    -*)          echo "qait: unknown option $1" >&2; exit 1 ;;
    *)           APK="$1"; shift ;;
  esac
done

die()  { echo "qait: $*" >&2; exit 1; }
info() { echo "qait: $*"; }

command -v curl >/dev/null || die "curl is required"
command -v jq   >/dev/null || die "jq is required (apt-get install jq / brew install jq)"
[ -n "${QAIT_CI_KEY:-}" ] || die "QAIT_CI_KEY is not set — add it as a CI secret"

AUTH="Authorization: Bearer $QAIT_CI_KEY"

# ── helpers ────────────────────────────────────────────────────────

# Split a curl response into body + status code. Usage: http_split "$raw"
# sets HTTP_BODY and HTTP_CODE.
http_split() {
  HTTP_CODE=$(printf '%s' "$1" | tail -n1)
  HTTP_BODY=$(printf '%s' "$1" | sed '$d')
}

# Print the server's own explanation, then exit. QAIT returns `message` and,
# for a rejected build, a `remediation` block with the exact fix — surface both
# rather than dumping raw JSON into the CI log.
fail_from_body() {
  local code="$1" body="$2" what="$3"
  local err msg rem ecode

  err=$(printf '%s' "$body"  | jq -r '.error       // empty' 2>/dev/null || true)
  msg=$(printf '%s' "$body"  | jq -r '.message     // empty' 2>/dev/null || true)
  rem=$(printf '%s' "$body"  | jq -r '.remediation // empty' 2>/dev/null || true)
  ecode=$(printf '%s' "$body"| jq -r '.code        // empty' 2>/dev/null || true)

  echo "" >&2
  echo "qait: $what failed (HTTP $code${ecode:+ $ecode})" >&2
  [ -n "$err" ] && echo "  $err" >&2
  [ -n "$msg" ] && echo "  $msg" >&2

  if [ -n "$rem" ]; then
    echo "" >&2
    echo "  How to fix:" >&2
    printf '%s\n' "$rem" | sed 's/^/  /' >&2
  fi

  # Not JSON at all — almost always a proxy or firewall answering instead of us.
  if [ -z "$err$msg" ]; then
    echo "  Unexpected response body:" >&2
    printf '%s\n' "$body" | head -c 600 | sed 's/^/  /' >&2
    echo "" >&2
    echo "  A non-JSON reply usually means a proxy intercepted the call." >&2
  fi

  echo "" >&2
  case "$ecode" in
    RATE_LIMITED)
      # The server reports the exact wait in the body. Prefer it over a
      # hardcoded number here: the limit is configurable per deployment, and
      # this same code also covers "another publish for this project is still
      # running", where the wait is seconds rather than the rest of the hour.
      retry_after=$(printf '%s' "$body" | jq -r '.retryAfterSeconds // empty' 2>/dev/null)
      if [ -n "$retry_after" ]; then
        echo "  Publishing is rate limited. Retry in ${retry_after}s." >&2
      else
        echo "  Publishing is rate limited. Retry shortly." >&2
      fi
      exit 4 ;;
    RATE_LIMITER_UNAVAILABLE)
      echo "  QAIT briefly refused the publish rather than run it unmetered." >&2
      echo "  This is transient — retry in a minute." >&2
      exit 4 ;;
    UPGRADE_REQUIRED|WRITE_DENIED)
      exit 3 ;;
  esac
  exit 3
}

# ── --check: prove the key and the network before touching a pipeline ──
if [ "$CHECK_ONLY" = "1" ]; then
  info "checking $API_BASE ..."
  raw=$(curl -sS -m 30 -H "$AUTH" "$API/whoami" -w $'\n%{http_code}' 2>&1) \
    || die "cannot reach $API_BASE — a firewall or proxy is blocking outbound 443 (exit 2)"
  http_split "$raw"
  [ "$HTTP_CODE" = "200" ] || fail_from_body "$HTTP_CODE" "$HTTP_BODY" "key check"
  info "key OK — project $(printf '%s' "$HTTP_BODY" | jq -r .projectId)"

  # The blob host is the one people forget to allowlist: the API can be
  # reachable while the actual binary PUT is blocked. Any HTTP status here
  # means reachable; a timeout does not.
  BLOB_HOST="${QAIT_BLOB_HOST:-qaiprodappsc3f4ef.blob.core.windows.net}"
  info "checking https://$BLOB_HOST ..."
  bcode=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' "https://$BLOB_HOST" 2>/dev/null || echo "000")
  if [ "$bcode" = "000" ]; then
    echo "qait: blob storage is NOT reachable — outbound 443 to $BLOB_HOST is blocked." >&2
    echo "      The API works but the upload itself will hang. Ask your network team" >&2
    echo "      to allow this host." >&2
    exit 2
  fi
  info "blob storage reachable (HTTP $bcode)"
  info "all checks passed"
  exit 0
fi

# ── publish ────────────────────────────────────────────────────────
[ -n "$APK" ]    || die "usage: $0 [--variant NAME] <path-to-apk>   (or --check)"
[ -f "$APK" ]    || die "file not found: $APK"

# stat is not portable: GNU wants -c, BSD/macOS wants -f.
SIZE=$(stat -c%s "$APK" 2>/dev/null || stat -f%z "$APK")
[ "$SIZE" -gt 0 ] || die "file is empty: $APK"
if [ "$SIZE" -gt 524288000 ]; then
  die "file is $((SIZE / 1048576)) MB — the limit is 500 MB"
fi

FILENAME=$(basename "$APK")

# Build identity. QAIT requires at least one of commitSha / versionName /
# versionCode so builds stay distinguishable in the audit trail and pruning
# stays non-destructive. Every CI system below exposes a commit SHA.
COMMIT="${QAIT_COMMIT_SHA:-${GITHUB_SHA:-${CI_COMMIT_SHA:-${BITBUCKET_COMMIT:-${GIT_COMMIT:-}}}}}"
BRANCH="${QAIT_BRANCH:-${GITHUB_REF_NAME:-${CI_COMMIT_REF_NAME:-${BITBUCKET_BRANCH:-${GIT_BRANCH:-}}}}}"
RUN_ID="${QAIT_CI_RUN_ID:-${GITHUB_RUN_ID:-${CI_PIPELINE_ID:-${BITBUCKET_BUILD_NUMBER:-${BUILD_NUMBER:-}}}}}"

[ -n "$COMMIT" ] || die "no commit SHA found in the environment — set QAIT_COMMIT_SHA"

info "publishing $FILENAME ($((SIZE / 1048576)) MB, commit ${COMMIT:0:8}${VARIANT:+, variant $VARIANT})"

# 1 ─ ask for a signed URL
req=$(jq -n --arg f "$FILENAME" --arg p "$PLATFORM" --arg v "$VARIANT" --argjson n "$SIZE" \
  '{filename:$f, platform:$p, contentLength:$n} + (if $v == "" then {} else {variant:$v} end)')

raw=$(curl -sS -m 60 -X POST "$API/app/upload-url" \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d "$req" -w $'\n%{http_code}' 2>&1) || die "cannot reach $API_BASE (exit 2)"
http_split "$raw"
[ "$HTTP_CODE" = "200" ] || fail_from_body "$HTTP_CODE" "$HTTP_BODY" "requesting an upload URL"

UPLOAD_URL=$(printf '%s' "$HTTP_BODY" | jq -r .uploadUrl)
STORAGE_PATH=$(printf '%s' "$HTTP_BODY" | jq -r .storagePath)
LANE=$(printf '%s' "$HTTP_BODY" | jq -r .variant)

# The headers are declared by whoever minted the URL — replay them verbatim.
# Do NOT infer them from the URL's hostname: Azure answers 400
# MissingRequiredHeader on a block-blob PUT without x-ms-blob-type.
PUT_HEADERS=()
while IFS= read -r h; do
  [ -n "$h" ] && PUT_HEADERS+=(-H "$h")
done < <(printf '%s' "$HTTP_BODY" | jq -r '.requiredHeaders // {} | to_entries[] | "\(.key): \(.value)"')

# 2 ─ PUT the binary straight to storage
info "uploading to $LANE lane ..."
pcode=$(curl -sS -m 900 -X PUT "$UPLOAD_URL" "${PUT_HEADERS[@]}" \
  --upload-file "$APK" -o /tmp/qait-put.$$ -w '%{http_code}' 2>&1) \
  || { echo "qait: upload failed — check outbound access to blob storage" >&2
       echo "      run '$0 --check' to test connectivity" >&2; rm -f /tmp/qait-put.$$; exit 2; }

if [ "${pcode:0:1}" != "2" ]; then
  echo "qait: storage rejected the upload (HTTP $pcode)" >&2
  head -c 600 /tmp/qait-put.$$ >&2 2>/dev/null || true
  rm -f /tmp/qait-put.$$
  exit 3
fi
rm -f /tmp/qait-put.$$

# 3 ─ finalize: QAIT parses the binary, applies the build contract, records it
info "finalizing ..."
fin=$(jq -n \
  --arg sp "$STORAGE_PATH" --arg p "$PLATFORM" --arg c "$COMMIT" \
  --arg b "$BRANCH" --arg r "$RUN_ID" --arg v "$VARIANT" --arg o "$FILENAME" \
  '{storagePath:$sp, platform:$p, commitSha:$c, originalName:$o}
   + (if $b == "" then {} else {branch:$b}   end)
   + (if $r == "" then {} else {ciRunId:$r}  end)
   + (if $v == "" then {} else {variant:$v}  end)')

raw=$(curl -sS -m 600 -X POST "$API/app/finalize" \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d "$fin" -w $'\n%{http_code}' 2>&1) || die "cannot reach $API_BASE (exit 2)"
http_split "$raw"

# A re-run of the pipeline for a commit already published is a no-op, not a
# failure — do not fail the customer's build for it.
if [ "$HTTP_CODE" = "409" ] \
   && [ "$(printf '%s' "$HTTP_BODY" | jq -r '.code // empty')" = "DUPLICATE_COMMIT" ]; then
  info "build for commit ${COMMIT:0:8} is already published — nothing to do"
  exit 0
fi

[ "$HTTP_CODE" = "201" ] || fail_from_body "$HTTP_CODE" "$HTTP_BODY" "finalizing the build"

info "published ✓  lane=$(printf '%s' "$HTTP_BODY" | jq -r '.variant')  build=$(printf '%s' "$HTTP_BODY" | jq -r '.build.id // "?"')"
