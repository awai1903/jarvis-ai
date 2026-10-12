#!/data/data/com.termux/files/usr/bin/bash
# Jarvis phone bridge - one-shot setup for Termux on Android.
#
#   bash bridge/install-termux.sh
#
# Installs the two packages, creates a private token, starts the bridge and
# prints the address to open. Re-running it is safe: it replaces the running
# copy and keeps the same token.
set -e

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
JARDIR="$HOME/.jarvis"
TOKEN_FILE="$JARDIR/token"
PID_FILE="$JARDIR/bridge.pid"
LOG_FILE="$JARDIR/bridge.log"
PORT="${JARVIS_PORT:-8787}"
ORIGIN="${JARVIS_ORIGIN:-}"

echo "== Jarvis phone bridge setup =="

if [ ! -x "$PREFIX/bin/pkg" ]; then
  echo "Run this inside Termux on the phone (install Termux from F-Droid or GitHub)."
  exit 1
fi

echo "-- installing python and the Termux:API command line"
pkg update -y >/dev/null 2>&1 || true
pkg install -y python termux-api

echo "-- keeping the bridge alive in the background"
termux-wake-lock 2>/dev/null || true

echo "-- storage access (lets Jarvis list and read your files)"
termux-setup-storage 2>/dev/null || true

mkdir -p "$JARDIR"
if [ ! -s "$TOKEN_FILE" ]; then
  python3 -c "import secrets;print(secrets.token_urlsafe(24))" > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
TOKEN="$(cat "$TOKEN_FILE")"

if [ -f "$PID_FILE" ]; then
  OLD="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "-- stopping the copy that was already running (pid $OLD)"
    kill "$OLD" 2>/dev/null || true
    sleep 1
  fi
fi

echo "-- starting the bridge"
cd "$APP"
set -- python3 bridge/jarvis_bridge.py --root "$APP" --port "$PORT"
if [ -n "$ORIGIN" ]; then
  set -- "$@" --allow-origin "$ORIGIN"
fi
nohup "$@" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 2

echo
sed -n '1,12p' "$LOG_FILE" || true
echo
echo "----------------------------------------------------------------"
echo "Open this on the phone:      http://127.0.0.1:$PORT/"
echo "Bridge token (already filled in when you open that address):"
echo "    $TOKEN"
echo
echo "Then in Jarvis:  Settings > Device > 'Let Jarvis control this phone'."
echo "Android may ask for SMS / Phone / Contacts / Location / Storage access"
echo "the first time an action uses it - allow it there."
echo
echo "Optional: install the Termux:Boot app (open it once) and re-run this"
echo "script to make the bridge start automatically after a reboot."
echo "Stop it:  kill \$(cat $PID_FILE)"
echo "Log:      $LOG_FILE"
echo "----------------------------------------------------------------"

if [ -d "$HOME/.termux/boot" ]; then
  cat > "$HOME/.termux/boot/jarvis.sh" <<BOOT
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd "$APP" && nohup python3 bridge/jarvis_bridge.py --root "$APP" --port $PORT > "$LOG_FILE" 2>&1 &
BOOT
  chmod +x "$HOME/.termux/boot/jarvis.sh"
  echo "Installed the boot script: ~/.termux/boot/jarvis.sh"
fi
