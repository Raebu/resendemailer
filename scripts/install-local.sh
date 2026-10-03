#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="${HOME}/.config/systemd/user"
ENV_DIR="${HOME}/.config/gibp-mail"
DATA_DIR="${HOME}/.local/share/gibp-mail"

command -v node >/dev/null || { echo "Node.js 22+ is required."; exit 1; }
command -v npm >/dev/null || { echo "npm is required."; exit 1; }

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22+ is required. Found: $(node --version)"
  exit 1
fi

mkdir -p "$SERVICE_DIR" "$ENV_DIR" "$DATA_DIR"
chmod 700 "$ENV_DIR" "$DATA_DIR"

cd "$ROOT"
npm install
npm run check

if [[ ! -f "$ENV_DIR/mail.env" ]]; then
  cp .env.example "$ENV_DIR/mail.env"
  chmod 600 "$ENV_DIR/mail.env"
  echo
  echo "Created $ENV_DIR/mail.env"
  echo "Edit it and add your RESEND_API_KEY before starting GIBP Mail."
fi

sed "s|@WORKDIR@|$ROOT|g" systemd/gibp-mail.service.in > "$SERVICE_DIR/gibp-mail.service"

systemctl --user daemon-reload
systemctl --user enable gibp-mail.service

echo
echo "Installed GIBP Mail."
echo "1. Edit: $ENV_DIR/mail.env"
echo "2. Start: systemctl --user start gibp-mail"
echo "3. Open:  http://127.0.0.1:8768"
echo
echo "Optional: loginctl enable-linger $USER"
