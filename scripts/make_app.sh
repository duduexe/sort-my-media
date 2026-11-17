#!/bin/zsh
# Builds "Sort my Media.app" with its icon, in ~/Applications and on the Desktop (same way as Dudu Editor.app).
# Change the picture and run it again.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIC="${1:-$ROOT/app/assets/261104_sort_my_media_icon_v01.png}"
WORK="$ROOT/.cache/app_build/$(date +%y%m%d_%H%M%S)"
mkdir -p "$WORK"
# Square and edge to edge: the Mac rounds the corners itself.
sips -s format png -z 1024 1024 "$PIC" --out "$WORK/round.png" >/dev/null
mkdir "$WORK/i.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/round.png" --out "$WORK/i.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$WORK/round.png" --out "$WORK/i.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/i.iconset" -o "$WORK/icon.icns"
APP="$WORK/Sort my Media.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/icon.icns" "$APP/Contents/Resources/icon.icns"
cat > "$APP/Contents/MacOS/start" <<S
#!/bin/zsh
exec "$ROOT/scripts/start_app.sh"
S
chmod +x "$APP/Contents/MacOS/start"
cat > "$APP/Contents/Info.plist" <<'S'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Sort my Media</string>
<key>CFBundleDisplayName</key><string>Sort my Media</string>
<key>CFBundleIdentifier</key><string>exe.dudu.sortmymedia</string>
<key>CFBundleExecutable</key><string>start</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
</dict></plist>
S
mkdir -p "$HOME/Applications"
for D in "$HOME/Applications" "$HOME/Desktop"; do
  # an older copy of this same app goes to the Trash, never deleted
  if [ -e "$D/Sort my Media.app" ]; then mv "$D/Sort my Media.app" "$HOME/.Trash/Sort my Media $(date +%H%M%S).app"; fi
  cp -R "$APP" "$D/"
  touch "$D/Sort my Media.app"
done
echo "Sort my Media.app is in Applications (your user folder) and on the Desktop."
