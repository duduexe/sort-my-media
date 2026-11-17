#!/bin/zsh
# Double-click this file to open Sort my Media.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
if ! command -v node >/dev/null 2>&1; then
  echo "I cannot find Node on this Mac. Please tell Claude: Sort my Media does not start."
  read -k 1 "?Press any key to close."
  exit 1
fi
if curl -s -o /dev/null http://localhost:5190/; then
  open http://localhost:5190
  exit 0
fi
echo "Sort my Media is starting. Leave this window open while you use it."
echo "Close this window to stop it."
(sleep 1; open http://localhost:5190) &
node server.mjs
