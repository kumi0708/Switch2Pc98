#!/bin/bash
# Decode the newest javascript_tool result (a canvas data URL) into scratchpad/shot.png
DIR="/c/Users/Shirai Naoya/.claude/projects/D--claude-Switch2Pc98/b73c9fce-694b-4ca1-9094-223d6a1c5688/tool-results"
OUT="/c/Users/Shirai Naoya/AppData/Local/Temp/claude/D--claude-Switch2Pc98/b73c9fce-694b-4ca1-9094-223d6a1c5688/scratchpad/shot.png"
F=$(ls -t "$DIR"/mcp-Claude_Browser-javascript_tool-*.txt | head -1)
node -e "
const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));let t=j[0].text.replace(/^\"|\"$/g,'');
fs.writeFileSync(process.argv[2],Buffer.from(t.split(',')[1],'base64'));console.log('wrote',process.argv[2]);" "$F" "$OUT"
