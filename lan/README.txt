TACOCRAFT - LAN play (no internet needed once installed)

(Download this whole repository as a ZIP from GitHub, unzip it, and run the files in this lan folder.
 The server uses the game page (index.html) one folder up.)

ONE-TIME SETUP (on the host's computer, needs internet once)
 1. Install Node.js from https://nodejs.org (the LTS version).
 2. Double-click start.bat (Windows) or run ./start.sh (Mac/Linux).
    The first run downloads two small packages, then the server starts.

PLAYING
 1. The window prints addresses like http://192.168.1.23:8080 .
 2. EVERYONE (host included) opens one of those addresses in their browser.
    Use the SAME address for everyone, not the GitHub link.
 3. Host: load a world, then Multiplayer > Host. Share the 5-letter code.
 4. Friends: Multiplayer > Join, type the code.

ACCOUNTS, TACOMAIL AND LEADERBOARDS ON LAN
 - When you play from the LAN address, the "Sign in" button makes a LAN account.
   It only exists on this server (separate from online accounts on the GitHub page).
 - Everything is saved in tacocraft-data.json next to server.js (passwords are hashed).
   Back that file up to keep everyone's accounts. Delete it to start fresh.
 - Reported messages are printed in the server window and kept in that file.
 - Updating from an older version: replace server.js (and index.html) and restart.

IF IT DOES NOT WORK
 - Allow Node.js through the firewall when Windows asks (tick Private networks).
 - Everyone must be on the same Wi-Fi/router. Some guest or school Wi-Fi blocks
   devices from talking to each other; a phone hotspot usually works.
 - Keep the server window open while playing.
 - Saves are per address: a world saved at http://192.168.1.23:8080 will not appear
   at a different address or on the GitHub page.
