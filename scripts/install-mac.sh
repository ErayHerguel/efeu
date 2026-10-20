#!/usr/bin/env bash
# Kopiert die gebaute App nach /Applications und entfernt das Quarantäne-Flag,
# damit sie ohne Gatekeeper-Warnung startet.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="efeu"
CANDIDATES=(
  "src-tauri/target.noindex/aarch64-apple-darwin/release/bundle/macos/$APP_NAME.app"
  "src-tauri/target.noindex/release/bundle/macos/$APP_NAME.app"
)

SOURCE=""
for candidate in "${CANDIDATES[@]}"; do
  if [[ -d "$candidate" && ( -z "$SOURCE" || "$candidate" -nt "$SOURCE" ) ]]; then
    SOURCE="$candidate"
  fi
done

if [[ -z "$SOURCE" ]]; then
  echo "Keine gebaute App gefunden. Bitte zuerst bauen: npm run build:mac" >&2
  exit 1
fi

if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "$APP_NAME läuft gerade. Bitte zuerst beenden (⌘Q), damit nichts verloren geht." >&2
  exit 1
fi

# INSTALL_DIR nur zum Testen überschreiben; Standard ist /Applications.
TARGET="${INSTALL_DIR:-/Applications}/$APP_NAME.app"
echo "Installiere $SOURCE → $TARGET"
rm -rf "$TARGET"
ditto "$SOURCE" "$TARGET"
xattr -cr "$TARGET"
echo "Fertig. Starten mit: open -a \"$APP_NAME\""
