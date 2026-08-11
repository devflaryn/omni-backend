#!/usr/bin/env bash
set -euo pipefail

# Manual end-to-end smoke test for accounts + license keys + downloads.
# Prerequisite: `npm run dev` already running in another terminal
# (http://localhost:5500). Run this from the omni-backend root:
#   bash scripts/smoke-test.sh

BASE_URL="${BASE_URL:-http://localhost:5500}"
STAMP=$(date +%s)
ADMIN_EMAIL="smoke-admin-${STAMP}@omni.test"
USER_EMAIL="smoke-user-${STAMP}@omni.test"
PASSWORD="hunter22"

# The server runs Arcjet bot detection (mode: LIVE) in front of every /api
# route. Plain curl requests (bare "curl/x.y.z" User-Agent, no Accept /
# Accept-Language headers) get classified as a bot and rejected with a 403
# before reaching our routes. These headers make curl look like an ordinary
# browser request so the smoke test can actually exercise the API.
BROWSER_HEADERS=(
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    -H "Accept: application/json, text/plain, */*"
    -H "Accept-Language: en-US,en;q=0.9"
)

echo "== sign up admin account =="
ADMIN_SIGNUP=$(curl -sf "${BROWSER_HEADERS[@]}" -X POST "$BASE_URL/api/v1/auth/sign-up" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASSWORD\"}")
ADMIN_TOKEN=$(echo "$ADMIN_SIGNUP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')
echo "admin token acquired"

echo "== promote to admin =="
node scripts/promote-admin.js "$ADMIN_EMAIL"

echo "== sign up regular user =="
USER_SIGNUP=$(curl -sf "${BROWSER_HEADERS[@]}" -X POST "$BASE_URL/api/v1/auth/sign-up" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$PASSWORD\"}")
USER_TOKEN=$(echo "$USER_SIGNUP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')
echo "user token acquired"

echo "== generate a 1_month key as admin =="
GENERATE=$(curl -sf "${BROWSER_HEADERS[@]}" -X POST "$BASE_URL/api/v1/keys/generate" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"plan":"1_month","count":1}')
CODE=$(echo "$GENERATE" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.codes[0]')
echo "generated key: $CODE"

echo "== redeem it as the regular user =="
curl -sf "${BROWSER_HEADERS[@]}" -X POST "$BASE_URL/api/v1/keys/redeem" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"code\":\"$CODE\"}" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).data, null, 2)'

echo "== seed a synthetic 5MB test artifact =="
TMP_ARTIFACT=$(mktemp)
head -c 5000000 /dev/urandom > "$TMP_ARTIFACT"
node scripts/seed-test-artifact.js "$TMP_ARTIFACT" qemu windows
rm -f "$TMP_ARTIFACT"

echo "== fetch the manifest =="
curl -sf "${BROWSER_HEADERS[@]}" "$BASE_URL/api/v1/downloads/manifest" \
    -H "Authorization: Bearer $USER_TOKEN" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).data, null, 2)'

echo "== download the seeded qemu/windows artifact and verify sha256 =="
OUT_FILE=$(mktemp)
curl -sf "${BROWSER_HEADERS[@]}" "$BASE_URL/api/v1/downloads/file/qemu/windows" \
    -H "Authorization: Bearer $USER_TOKEN" -o "$OUT_FILE"
EXPECTED=$(curl -sf "${BROWSER_HEADERS[@]}" "$BASE_URL/api/v1/downloads/manifest" -H "Authorization: Bearer $USER_TOKEN" \
    | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.find(a => a.category === "qemu" && a.platform === "windows").sha256')
ACTUAL=$(shasum -a 256 "$OUT_FILE" | cut -d' ' -f1)
if [ "$EXPECTED" = "$ACTUAL" ]; then
    echo "sha256 matches: $ACTUAL"
else
    echo "MISMATCH: expected $EXPECTED, got $ACTUAL"
    exit 1
fi
rm -f "$OUT_FILE"

echo "== range-request resume support =="
curl -sf "${BROWSER_HEADERS[@]}" -r 0-99 "$BASE_URL/api/v1/downloads/file/qemu/windows" \
    -H "Authorization: Bearer $USER_TOKEN" -o /dev/null -w "status=%{http_code} bytes=%{size_download}\n"

echo "ALL SMOKE CHECKS PASSED"
