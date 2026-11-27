#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Get it from https://nodejs.org and try again."; read -n 1 -s -r -p "Press any key..."; exit 1; }
node lan-server.js
