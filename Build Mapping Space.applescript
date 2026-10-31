-- ============================================================
--  BUILD MAPPING SPACE
--  How to use: press the ▶ (Run) button at the top of this window.
--  You don't need to change anything below.
-- ============================================================

set projectDir to (POSIX path of (path to home folder)) & "ai/mapping_space"
set logFile to (POSIX path of (path to home folder)) & "Library/Logs/MappingSpace-build.log"

-- Find the project folder (ask if it was moved)
try
	do shell script "test -f " & quoted form of (projectDir & "/package.json")
on error
	set projectDir to POSIX path of (choose folder with prompt "Where is the mapping_space folder?")
end try

set choice to button returned of (display dialog "What do you want to build?" & return & return & ¬
	"• Share with another Mac: makes a .dmg file you can send to anyone (Apple Silicon or Intel)." & return & ¬
	"• Install on this Mac: installs Mapping Space for every user of this Mac." & return & return & ¬
	"Takes 2–5 minutes. The first time it downloads Node.js (about 90 MB)." ¬
	with title "Mapping Space" buttons {"Cancel", "Install on this Mac", "Share with another Mac (.dmg)"} ¬
	default button 3 cancel button 1 with icon note)

set mode to "dmg"
if choice is "Install on this Mac" then set mode to "pkg"

-- Same tools you'd have in Terminal (Homebrew, nvm, Volta)
set prefix to "export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:/usr/bin:/bin:/usr/sbin:/sbin; " & ¬
	"[ -s \"$HOME/.nvm/nvm.sh\" ] && . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1; " & ¬
	"cd " & quoted form of projectDir & " && "

try
	do shell script prefix & "command -v node && command -v npm"
on error
	display dialog "Node.js isn't installed. Install it from nodejs.org, then run this again." with title "Mapping Space" buttons {"Open nodejs.org", "OK"} default button 1 with icon caution
	if button returned of result is "Open nodejs.org" then open location "https://nodejs.org/en/download"
	return
end try

-- Fix "permission denied": give the project and npm cache back to you (asks for your password once).
set me_ to do shell script "id -un"
set notMine to do shell script prefix & "find . \"$HOME/.npm\" ! -user \"$(id -u)\" -print -quit 2>/dev/null; true"
if notMine is not "" then
	do shell script "chown -R " & quoted form of me_ & " " & quoted form of projectDir & " \"$HOME/.npm\"" with administrator privileges with prompt "Mapping Space needs your password once to fix file permissions in the project folder."
end if

set progress total steps to 2
set progress description to "Building Mapping Space…"
set progress additional description to "Installing parts (1 of 2)…"
display notification "This takes a few minutes. You'll get a message when it's done." with title "Building Mapping Space"

try
	with timeout of 3600 seconds
		do shell script prefix & "echo \"=== $(date) ===\" > " & quoted form of logFile & " && npm run setup >> " & quoted form of logFile & " 2>&1"
		set progress completed steps to 1
		set progress additional description to "Building the app (2 of 2)…"
		do shell script prefix & "NO_OPEN=1 bash scripts/make-app.sh " & mode & " >> " & quoted form of logFile & " 2>&1"
		set progress completed steps to 2
	end timeout
on error
	set tailText to do shell script "tail -n 12 " & quoted form of logFile & " | cut -c1-160"
	display dialog "The build stopped with an error:" & return & return & tailText & return & return & ¬
		"Send a screenshot of this message to Claude." with title "Mapping Space" buttons {"Show full log", "OK"} default button 2 with icon stop
	if button returned of result is "Show full log" then do shell script "open -a Console " & quoted form of logFile
	return
end try

if mode is "dmg" then
	set outFile to do shell script "ls -t " & quoted form of (projectDir & "/build") & "/MappingSpace-*.dmg | head -1"
	do shell script "open -R " & quoted form of outFile
	display dialog "Done! The DMG is selected in Finder:" & return & return & outFile & return & return & ¬
		"Send it to anyone with a Mac. They open it and drag Mapping Space to Applications." with title "Mapping Space" buttons {"OK"} default button 1 with icon note
else
	set outFile to do shell script "ls -t " & quoted form of (projectDir & "/build") & "/MappingSpace-*.pkg | head -1"
	display dialog "Almost done! The installer opens next: click Continue → Install and enter your password." & return & return & ¬
		"Then every user of this Mac finds Mapping Space in Launchpad." with title "Mapping Space" buttons {"Open installer"} default button 1 with icon note
	do shell script "open " & quoted form of outFile
end if
