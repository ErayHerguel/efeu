#!/bin/bash
# efeu-Installer: lädt die aktuelle Version von GitHub, installiert sie nach /Applications und startet sie.
# Aufruf: curl -fsSL https://github.com/__REPO__/releases/latest/download/install.sh | bash
set -euo pipefail

REPO="__REPO__"
APP="/Applications/efeu.app"
URL="https://github.com/$REPO/releases/latest/download/efeu.dmg"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Dieser Installer ist für den Mac. Für Windows gibt es efeu-setup.exe auf der Website." >&2
  exit 1
fi

if pgrep -x efeu >/dev/null 2>&1; then
  echo "efeu läuft gerade. Bitte zuerst beenden (⌘Q) und den Befehl erneut ausführen." >&2
  exit 1
fi

TMP=$(mktemp -d)
MOUNT=""
cleanup() {
  [[ -n "$MOUNT" ]] && hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "Lade efeu …"
curl -fL --progress-bar "$URL" -o "$TMP/efeu.dmg"

MOUNT=$(hdiutil attach -nobrowse -readonly "$TMP/efeu.dmg" | tail -1 | awk -F'\t' '{print $NF}')
[[ -d "$MOUNT/efeu.app" ]] || { echo "efeu.app nicht im Download gefunden." >&2; exit 1; }

echo "Installiere nach $APP …"
rm -rf "$APP"
ditto "$MOUNT/efeu.app" "$APP"
xattr -cr "$APP"

echo "Fertig. efeu startet."
open "$APP"
