#!/bin/sh
# Mac/Linux: ./start.sh   (needs Node.js from https://nodejs.org)
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
node server.js
