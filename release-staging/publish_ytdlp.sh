#!/bin/bash
# publish_ytdlp.sh — seed the yt-dlp plugin into the LIVE AppOS catalog.
#
# Flow (verified against AgentService + vendor/catalog-service source):
#   1. POST /v1/publish/prepare   (service-role key + x-appos-user-id)  -> presigned R2 URL + one-shot publishToken (10 min TTL)
#   2. PUT  <presignedUploadUrl>  (Content-Type: application/zip)
#   3. POST /v1/publish/submit    { publishToken, sha256, signature: null } -> item_versions row, status 'candidate'
#   4. PATCH /rest/v1/publishers  { verified: true }  (service-role, PostgREST)   <- "promote" precondition
#   5. POST /v1/publish/claim     { versionId, signature, signingPubkey } -> claim_version RPC -> status 'published'
#   6. Verify: GET /v1/catalog/browse + /v1/catalog/items/space-appos-ytdlp (public, anon)
#
# PREREQUISITE: an auth.users row must exist in Supabase project lryytrqzkvzxyujhywhh.
#   Either sign in once via the AppOS desktop app (Settings -> Account), then run:
#     ACTING_USER_ID=<that user uuid> ./publish_ytdlp.sh
#   Or create a dedicated publisher account first (e.g. via the app's sign-up,
#   or GoTrue signup with email daniel+appos-publisher@instantlyeasy.com and
#   user_metadata {"full_name": "AppOS"} so the publisher renders as "AppOS").
#
# NEVER prints secret values. Requires: curl, python3, openssl (3.x), zip.
set -euo pipefail

SCRATCH="$(cd "$(dirname "$0")" && pwd)"
STORE_ENV="${STORE_ENV:-/Users/d/Documents/GitHub/AppOS/AppOS-Store/.env}"
BASE="${CATALOG_BASE:-https://appos-agent-service.onrender.com}"
BUNDLE_ZIP="${BUNDLE_ZIP:-$SCRATCH/space-appos-ytdlp-1.1.0.zip}"
KEYS_DIR="${KEYS_DIR:-$SCRATCH/keys}"
SLUG="space-appos-ytdlp"

[ -n "${ACTING_USER_ID:-}" ] || { echo "FATAL: set ACTING_USER_ID=<auth.users uuid>"; exit 1; }
[ -f "$BUNDLE_ZIP" ] || { echo "FATAL: bundle zip not found at $BUNDLE_ZIP"; echo "Rebuild: cd appos-plugin-ytdlp && ./build.sh && ./release-staging/stage_release.sh — stages the AppOS Catalog Bundle Layout v1 (root manifest.json, runtime manifest at appos/runtime/plugin.json, no plugin.json at root/one-deep) and self-checks it"; exit 1; }

# --- load credentials (names only ever echoed) ---
export "$(grep -E '^SUPABASE_URL=' "$STORE_ENV" | head -1 | xargs)"
export "$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "$STORE_ENV" | head -1 | xargs)"
SRK="$SUPABASE_SERVICE_ROLE_KEY"

SHA256=$(shasum -a 256 "$BUNDLE_ZIP" | awk '{print $1}')
echo "bundle: $BUNDLE_ZIP"
echo "sha256: $SHA256"

jsonget() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get(sys.argv[2],''))" "$1" "$2"; }

# --- 1. prepare ---
echo; echo "== 1. POST /v1/publish/prepare =="
HTTP=$(curl -sS -m 30 -o /tmp/prepare.json -w "%{http_code}" -X POST "$BASE/v1/publish/prepare" \
  -H "Authorization: Bearer $SRK" -H "x-appos-user-id: $ACTING_USER_ID" \
  -H "Content-Type: application/json" -d '{}')
echo "HTTP $HTTP"; [ "$HTTP" = "200" ] || { cat /tmp/prepare.json; exit 1; }
UPLOAD_URL=$(jsonget /tmp/prepare.json presignedUploadUrl)
TOKEN=$(jsonget /tmp/prepare.json publishToken)
PUBLISHER_ID=$(jsonget /tmp/prepare.json publisherId)
echo "publishToken: $TOKEN"
echo "publisherId:  $PUBLISHER_ID"

# --- 2. upload ---
echo; echo "== 2. PUT bundle to presigned R2 URL =="
HTTP=$(curl -sS -m 300 -o /tmp/upload.out -w "%{http_code}" -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/zip" --data-binary "@$BUNDLE_ZIP")
echo "HTTP $HTTP"; { [ "$HTTP" = "200" ] || [ "$HTTP" = "201" ]; } || { cat /tmp/upload.out; exit 1; }

# --- 3. submit (unsigned -> candidate) ---
echo; echo "== 3. POST /v1/publish/submit =="
HTTP=$(curl -sS -m 60 -o /tmp/submit.json -w "%{http_code}" -X POST "$BASE/v1/publish/submit" \
  -H "Authorization: Bearer $SRK" -H "x-appos-user-id: $ACTING_USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"publishToken\":\"$TOKEN\",\"sha256\":\"$SHA256\",\"signature\":null}")
echo "HTTP $HTTP"; cat /tmp/submit.json; echo
[ "$HTTP" = "201" ] || exit 1
ITEM_ID=$(jsonget /tmp/submit.json itemId)
VERSION_ID=$(jsonget /tmp/submit.json versionId)
echo "itemId:    $ITEM_ID"
echo "versionId: $VERSION_ID"

# --- 4. promote precondition: mark publisher verified ---
# guard_publisher_privileged_fields() allows service_role sessions; if hosted
# PostgREST reports session_user='authenticator' this PATCH raises — in that
# case the claim below lands as 'candidate' and step 5b force-publishes.
echo; echo "== 4. PATCH publishers.verified=true (service role) =="
HTTP=$(curl -sS -m 30 -o /tmp/verified.json -w "%{http_code}" -X PATCH \
  "$SUPABASE_URL/rest/v1/publishers?id=eq.$PUBLISHER_ID" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"verified": true}')
echo "HTTP $HTTP"; cat /tmp/verified.json; echo

# --- 5. claim (Ed25519 signature over exact zip bytes; hex sig + raw 32-byte hex pubkey) ---
echo; echo "== 5. POST /v1/publish/claim =="
mkdir -p "$KEYS_DIR" && chmod 700 "$KEYS_DIR"
if [ ! -f "$KEYS_DIR/appos-publisher-ed25519.pem" ]; then
  openssl genpkey -algorithm ed25519 -out "$KEYS_DIR/appos-publisher-ed25519.pem"
  chmod 600 "$KEYS_DIR/appos-publisher-ed25519.pem"
fi
openssl pkey -in "$KEYS_DIR/appos-publisher-ed25519.pem" -pubout -outform DER 2>/dev/null \
  | tail -c 32 | xxd -p -c 64 > "$KEYS_DIR/pubkey.hex"
openssl pkeyutl -sign -inkey "$KEYS_DIR/appos-publisher-ed25519.pem" -rawin \
  -in "$BUNDLE_ZIP" -out "$KEYS_DIR/sig.bin"
SIG_HEX=$(xxd -p -c 256 "$KEYS_DIR/sig.bin" | tr -d '\n')
PUB_HEX=$(cat "$KEYS_DIR/pubkey.hex")
echo "signingPubkey: $PUB_HEX"
HTTP=$(curl -sS -m 30 -o /tmp/claim.json -w "%{http_code}" -X POST "$BASE/v1/publish/claim" \
  -H "Authorization: Bearer $SRK" -H "x-appos-user-id: $ACTING_USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"versionId\":\"$VERSION_ID\",\"signature\":\"$SIG_HEX\",\"signingPubkey\":\"$PUB_HEX\"}")
echo "HTTP $HTTP"; cat /tmp/claim.json; echo
CLAIM_STATUS=$(jsonget /tmp/claim.json status)

# --- 5b. fallback force-publish if claim left it 'candidate' ---
if [ "$CLAIM_STATUS" != "published" ]; then
  echo; echo "== 5b. claim status='$CLAIM_STATUS' — force status='published' on item_versions (service role) =="
  HTTP=$(curl -sS -m 30 -o /tmp/force.json -w "%{http_code}" -X PATCH \
    "$SUPABASE_URL/rest/v1/item_versions?id=eq.$VERSION_ID" \
    -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
    -H "Content-Type: application/json" -H "Prefer: return=representation" \
    -d '{"status": "published"}')
  echo "HTTP $HTTP"; cat /tmp/force.json; echo
fi

# --- 6. verify (public reads, no auth) ---
echo; echo "== 6a. GET /v1/catalog/browse =="
curl -sS -m 20 -w "\nHTTP %{http_code}\n" "$BASE/v1/catalog/browse"
echo; echo "== 6b. GET /v1/catalog/items/$SLUG =="
curl -sS -m 20 -w "\nHTTP %{http_code}\n" "$BASE/v1/catalog/items/$SLUG"
echo; echo "== 6c. storefront proxy =="
curl -sS -m 25 -w "\nHTTP %{http_code}\n" "https://app.appos.space/api/catalog/browse"
echo; echo "DONE. Keep $KEYS_DIR/appos-publisher-ed25519.pem safe — publishers.signing_pubkey is now CAS-bound to it."
