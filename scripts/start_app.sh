#!/bin/zsh -l
# Opens Sort my Media like an app (same way as Dudu Editor.app): reuses the copy already running,
# otherwise starts it quietly in the background, then opens a Chrome window with no tabs.
# Used by "Sort my Media.app" (scripts/make_app.sh).
cd "$(dirname "$0")/.." || exit 1
PORT=5190
URL="http://localhost:$PORT"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
say_problem() { osascript -e "display dialog \"$1\" with title \"Sort my Media\" buttons {\"OK\"} default button 1" >/dev/null; exit 1; }
command -v node >/dev/null || say_problem "Node.js is not installed. Ask Claude to set it up."
PID="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t | head -1)"
if [ -n "$PID" ]; then
  ps -o command= -p "$PID" | grep -q "server.mjs" || say_problem "Another program is using port $PORT. Close it and try again."
else
  mkdir -p .cache
  nohup node server.mjs >> .cache/server.log 2>&1 &
  disown
fi
for i in {1..80}; do curl -s -o /dev/null "$URL" && break; sleep 0.25; done
curl -s -o /dev/null "$URL" || say_problem "Sort my Media did not start. Ask Claude to look at .cache/server.log in the SortMyMedia folder."
open -na "Google Chrome" --args --app="$URL" 2>/dev/null || open "$URL"
