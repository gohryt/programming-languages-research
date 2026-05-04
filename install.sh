#!/bin/sh
set -eu

HOST=""
EMAIL=""
INSTALL_DIR="$HOME/.programming-languages-research"
SERVICE_NAME="programming-languages-research"
RELEASE_URL="https://github.com/gohryt/programming-languages-research/releases/latest/download/programming-languages-research-bundle.tar.gz"

usage() {
  cat <<EOF
Usage: ./install.sh --host HOST --email EMAIL

Options:
  --host HOST    Public hostname for the service (required)
  --email EMAIL  Contact email for ACME / Let's Encrypt (required)
  -h, --help     Show this help

You can also run it directly from GitHub:
  curl -fsSL https://raw.githubusercontent.com/gohryt/programming-languages-research/main/install.sh | sh -s -- --host HOST --email EMAIL
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      HOST="$2"
      shift 2
      ;;
    --email)
      EMAIL="$2"
      shift 2
      ;;

    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$HOST" ] || [ -z "$EMAIL" ]; then
  echo "Both --host and --email are required." >&2
  usage >&2
  exit 1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command curl
require_command tar
require_command rsync
require_command systemctl
require_command mktemp

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd 2>/dev/null && pwd || pwd)
SERVICE_TEMPLATE="$SCRIPT_DIR/deploy/programming-languages-research.service"
SERVICE_TEMPLATE_URL="https://raw.githubusercontent.com/gohryt/programming-languages-research/main/deploy/programming-languages-research.service"

TMP_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

ARCHIVE_PATH="$TMP_DIR/bundle.tar.gz"
EXTRACT_DIR="$TMP_DIR/extract"
mkdir -p "$EXTRACT_DIR"

echo "Downloading release bundle..."
curl -fL "$RELEASE_URL" -o "$ARCHIVE_PATH"

echo "Extracting bundle..."
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"
BUNDLE_DIR="$EXTRACT_DIR/bundle"
if [ ! -d "$BUNDLE_DIR" ]; then
  BUNDLE_DIR="$EXTRACT_DIR/programming-languages-research"
fi
if [ ! -d "$BUNDLE_DIR" ]; then
  echo "Release bundle did not contain bundle/ or programming-languages-research/" >&2
  exit 1
fi
if [ ! -x "$BUNDLE_DIR/programming-languages-research" ]; then
  echo "Release bundle did not contain executable programming-languages-research" >&2
  exit 1
fi
if [ ! -d "$BUNDLE_DIR/static" ]; then
  echo "Release bundle did not contain static/" >&2
  exit 1
fi

echo "Installing into $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
rsync -a --delete --exclude .acme "$BUNDLE_DIR/" "$INSTALL_DIR/"

SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SERVICE_PATH="$SYSTEMD_USER_DIR/$SERVICE_NAME.service"
mkdir -p "$SYSTEMD_USER_DIR"

if [ -f "$SERVICE_TEMPLATE" ]; then
  SERVICE_SOURCE="$SERVICE_TEMPLATE"
else
  SERVICE_SOURCE="$TMP_DIR/programming-languages-research.service"
  echo "Downloading service template..."
  curl -fL "$SERVICE_TEMPLATE_URL" -o "$SERVICE_SOURCE"
fi

sed \
  -e "s|programming-languages-research.example.com|$HOST|g" \
  -e "s|admin@example.com|$EMAIL|g" \
  "$SERVICE_SOURCE" > "$SERVICE_PATH"

echo "Installed systemd user unit at $SERVICE_PATH"

echo "Reloading systemd user daemon..."
systemctl --user daemon-reload

echo "Enabling and starting $SERVICE_NAME.service ..."
systemctl --user enable --now "$SERVICE_NAME.service"
echo
echo "Service started. Follow logs with:"
echo "  journalctl --user -u $SERVICE_NAME.service -f"
