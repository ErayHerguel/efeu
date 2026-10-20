#!/usr/bin/env bash
# Smoke-Test des Produktions-Builds: Bundle, Signatur, Start, Migrationen, Kaltstartzeit.
# Läuft mit einem temporären HOME, echte Daten bleiben unberührt.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="efeu"
BUNDLE_ID="app.efeu.desktop"
ROOT="src-tauri/target.noindex/aarch64-apple-darwin/release/bundle"
APP="$ROOT/macos/$APP_NAME.app"
BIN="$APP/Contents/MacOS/efeu"

fail() { echo "✗ $1" >&2; exit 1; }
ok() { echo "✓ $1"; }

[[ -d "$APP" ]] || fail "App nicht gefunden ($APP). Zuerst: npm run build:mac"
ls "$ROOT"/dmg/*.dmg >/dev/null 2>&1 || fail "Kein DMG in $ROOT/dmg"
ok "App und DMG vorhanden"

ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Contents/Info.plist")
[[ "$ID" == "$BUNDLE_ID" ]] || fail "Bundle-ID ist $ID"
ok "Bundle-ID $ID"

[[ "$(lipo -archs "$BIN")" == "arm64" ]] || fail "Binary ist nicht arm64"
ok "Architektur arm64"

codesign --verify --deep "$APP" 2>/dev/null || fail "Signatur ungültig"
ok "Ad-hoc-Signatur gültig"

TMP_HOME=$(mktemp -d)
DATA="$TMP_HOME/Library/Application Support/$BUNDLE_ID"
LOG="$TMP_HOME/efeu.log"
trap 'pkill -f "$BIN" >/dev/null 2>&1 || true; rm -rf "$TMP_HOME"' EXIT

run_once() {
  : >"$LOG"
  HOME="$TMP_HOME" "$BIN" >"$LOG" 2>&1 &
  local pid=$!
  for _ in $(seq 1 100); do
    grep -q "bereit nach" "$LOG" && break
    kill -0 "$pid" 2>/dev/null || fail "App ist abgestürzt: $(cat "$LOG")"
    sleep 0.1
  done
  grep -q "bereit nach" "$LOG" || fail "App wurde nicht bereit: $(cat "$LOG")"
  sleep 1
  kill -0 "$pid" 2>/dev/null || fail "App lief nicht stabil weiter"
  kill "$pid"
  wait "$pid" 2>/dev/null || true
  grep -o "bereit nach [0-9]* ms" "$LOG" | grep -o "[0-9]*"
}

FIRST=$(run_once)
ok "Erster Start (inkl. Migrationen und Willkommensseite): ${FIRST} ms"

DB="$DATA/efeu.db"
[[ -f "$DB" ]] || fail "Datenbank wurde nicht angelegt"
MIGRATIONS=$(sqlite3 "$DB" "SELECT count(*) FROM _sqlx_migrations WHERE success = 1")
[[ "$MIGRATIONS" == "9" ]] || fail "Erwartet 9 Migrationen, gefunden $MIGRATIONS"
ok "Migrationen angewendet ($MIGRATIONS)"

[[ "$(sqlite3 "$DB" "SELECT count(*) FROM pages_fts WHERE pages_fts MATCH 'befehlspalette'")" == "1" ]] || fail "Volltextsuche liefert keinen Treffer"
ok "FTS5-Volltextsuche aktiv"

[[ "$(sqlite3 "$DB" "PRAGMA integrity_check")" == "ok" ]] || fail "Integritätsprüfung fehlgeschlagen"
ok "Integritätsprüfung ok"

WARM=$(run_once)
ok "Kaltstart mit vorhandenen Daten: ${WARM} ms"
(( WARM < 1000 )) || fail "Kaltstart über 1 Sekunde"

echo "Smoke-Test bestanden."
