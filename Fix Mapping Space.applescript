-- ============================================================
--  FIX / UPDATE MAPPING SPACE (for any Mac account)
--  Press the ▶ (Run) button at the top of this window.
--
--  It downloads the latest Mapping Space from GitHub into ~/ai/mapping_space,
--  keeps your settings (Google keys + login), rebuilds it and starts it.
--  Your old copy is kept as ~/ai/mapping_space-old-<date> (delete it later if all works).
-- ============================================================

set homeDir to POSIX path of (path to home folder)
set projectDir to homeDir & "ai/mapping_space"
set logFile to homeDir & "Library/Logs/MappingSpace-fix.log"
set zipURL to "https://github.com/Shakti-Sharma/mapping_space/archive/refs/heads/main.zip"

display dialog "This will download the latest Mapping Space into:" & return & projectDir & return & return & ¬
	"Your settings are kept and your old copy is saved next to it. Takes 2–4 minutes." ¬
	with title "Mapping Space" buttons {"Cancel", "Fix it"} default button 2 cancel button 1 with icon note

set prefix to "export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:/usr/bin:/bin:/usr/sbin:/sbin; " & ¬
	"[ -s \"$HOME/.nvm/nvm.sh\" ] && . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1; "

try
	do shell script prefix & "command -v node && command -v npm"
on error
	display dialog "Node.js isn't installed for this account. Install it from nodejs.org, then run this again." with title "Mapping Space" buttons {"Open nodejs.org", "OK"} default button 1 with icon caution
	if button returned of result is "Open nodejs.org" then open location "https://nodejs.org/en/download"
	return
end try

set progress total steps to 3
set progress description to "Fixing Mapping Space…"
set progress additional description to "Downloading the latest version (1 of 3)…"

try
	with timeout of 3600 seconds
		-- 1. Download + unpack into a temp folder, keep settings, swap folders.
		do shell script prefix & "set -e; exec >" & quoted form of logFile & " 2>&1; " & ¬
			"TMP=$(mktemp -d); cd \"$TMP\"; " & ¬
			"curl -fL -o src.zip " & quoted form of zipURL & "; unzip -q src.zip; NEW=\"$TMP/mapping_space-main\"; " & ¬
			"P=" & quoted form of projectDir & "; mkdir -p \"$(dirname \"$P\")\"; " & ¬
			"if [ -d \"$P\" ]; then " & ¬
			"  [ -f \"$P/server/.env\" ] && cp \"$P/server/.env\" \"$NEW/server/.env\"; " & ¬
			"  [ -d \"$P/server/.data\" ] && cp -R \"$P/server/.data\" \"$NEW/server/.data\"; " & ¬
			"  mv \"$P\" \"$P-old-$(date +%Y%m%d-%H%M%S)\"; " & ¬
			"fi; " & ¬
			"mv \"$NEW\" \"$P\"; rm -rf \"$TMP\"; echo downloaded"
		set progress completed steps to 1
		set progress additional description to "Installing parts (2 of 3)…"
		do shell script prefix & "cd " & quoted form of projectDir & " && npm run setup >> " & quoted form of logFile & " 2>&1"
		set progress completed steps to 2
		set progress additional description to "Building (3 of 3)…"
		do shell script prefix & "cd " & quoted form of projectDir & " && npm run build >> " & quoted form of logFile & " 2>&1"
		set progress completed steps to 3
	end timeout
on error
	set tailText to do shell script "tail -n 12 " & quoted form of logFile & " | cut -c1-160"
	display dialog "Something went wrong:" & return & return & tailText & return & return & ¬
		"Send a screenshot of this message to Claude." with title "Mapping Space" buttons {"Show full log", "OK"} default button 2 with icon stop
	if button returned of result is "Show full log" then do shell script "open -a Console " & quoted form of logFile
	return
end try

-- Start it inside the Terminal app: macOS applies Full Disk Access to the program that
-- starts the server, and Terminal is the one you gave access to (Script Editor isn't).
do shell script "pkill -u $(id -u) -f 'mapping_space/server/src/index.js' 2>/dev/null; true"
tell application "Terminal"
	activate
	do script "cd " & quoted form of projectDir & " && npm start"
end tell

display dialog "Done! Mapping Space is starting in a Terminal window and opens in your browser in a few seconds." & return & return & ¬
	"Keep that Terminal window open while you use it (close it to stop the app)." & return & ¬
	"Next time, start it in Terminal with:  cd ~/ai/mapping_space && npm start" ¬
	with title "Mapping Space" buttons {"OK"} default button 1 with icon note
