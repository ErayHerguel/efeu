#!/bin/bash
# Richtet efeu Cloud auf einem frischen Debian- oder Ubuntu-Server ein. efeu führt das Skript per SSH
# als root aus und liest die Zeilen "##SCHRITT n Text" als Fortschritt, am Ende "##SCHLUESSEL {json}".
# Aufruf: install.sh <adresse> <gerätename>   (Server-Datei liegt vorher unter /tmp/efeu-server.mjs)
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

ADDRESS="$1"
DEVICE_NAME="$2"
NODE_VERSION="24.21.0"
step() { echo "##SCHRITT $1 $2"; }
fail() { echo "##FEHLER $1"; exit 1; }

[ "$(id -u)" = 0 ] || fail "Das Skript braucht root-Rechte."
[ -r /etc/os-release ] && . /etc/os-release
case "${ID:-}" in debian|ubuntu) ;; *) fail "Nur Debian und Ubuntu werden unterstützt (gefunden: ${PRETTY_NAME:-unbekannt}).";; esac
case "$(uname -m)" in x86_64) ARCH=x64;; aarch64) ARCH=arm64;; *) fail "Prozessor $(uname -m) wird nicht unterstützt.";; esac
[ -s /tmp/efeu-server.mjs ] || fail "Server-Datei fehlt."

step 1 "System wird aktualisiert"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades xz-utils >/dev/null
# Sicherheitsupdates des Systems laufen ab jetzt automatisch.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

step 2 "Node.js wird installiert"
if ! /opt/efeu/node/bin/node --version 2>/dev/null | grep -q "v${NODE_VERSION}"; then
  TARBALL="node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"
  cd /tmp
  curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}"
  curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  grep " ${TARBALL}\$" SHASUMS256.txt | sha256sum -c - >/dev/null || fail "Node.js-Download ist beschädigt."
  rm -rf /opt/efeu/node && mkdir -p /opt/efeu/node
  tar -xJf "${TARBALL}" -C /opt/efeu/node --strip-components=1
  rm -f "${TARBALL}" SHASUMS256.txt
fi

step 3 "efeu Cloud wird installiert"
id efeu >/dev/null 2>&1 || useradd --system --home /var/lib/efeu --shell /usr/sbin/nologin efeu
mkdir -p /var/lib/efeu /opt/efeu
install -m 0644 /tmp/efeu-server.mjs /opt/efeu/efeu-server.mjs
rm -f /tmp/efeu-server.mjs
chown -R efeu:efeu /var/lib/efeu /opt/efeu
chmod 0750 /var/lib/efeu
cat > /etc/systemd/system/efeu.service <<'EOF'
[Unit]
Description=efeu Cloud
After=network-online.target
Wants=network-online.target

[Service]
User=efeu
Environment=EFEU_DATA=/var/lib/efeu EFEU_HOST=127.0.0.1 EFEU_PORT=8080 NODE_NO_WARNINGS=1
ExecStart=/opt/efeu/node/bin/node /opt/efeu/efeu-server.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/efeu /opt/efeu
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable efeu >/dev/null 2>&1
systemctl restart efeu

step 4 "HTTPS wird eingerichtet"
if ! command -v caddy >/dev/null; then
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
# Ohne eigene Domain bekommt die IP-Adresse ein Zertifikat (Let's Encrypt, kurzlebig, erneuert sich selbst).
if [[ "$ADDRESS" =~ ^[0-9.]+$ ]]; then TLS='tls {
    issuer acme {
      profile shortlived
    }
  }'; else TLS=''; fi
cat > /etc/caddy/Caddyfile <<EOF
${ADDRESS} {
  ${TLS}
  encode zstd gzip
  reverse_proxy 127.0.0.1:8080 {
    flush_interval -1
  }
}
EOF
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

step 5 "Dieses Gerät wird verbunden"
for i in $(seq 1 30); do
  curl -fs http://127.0.0.1:8080/api/status >/dev/null && break
  sleep 1
done
KEY=$(runuser -u efeu -- env EFEU_DATA=/var/lib/efeu NODE_NO_WARNINGS=1 /opt/efeu/node/bin/node /opt/efeu/efeu-server.mjs add-device "$DEVICE_NAME")
echo "##SCHLUESSEL ${KEY}"
