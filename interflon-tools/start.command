#!/bin/bash
# Double-click this file (macOS) to launch the Terminal Interflon, or run: ./start.command
cd "$(dirname "$0")"
PORT="${1:-8766}"
echo "Starting TERMINAL INTERFLON on http://127.0.0.1:$PORT ..."
( sleep 1.5; open "http://127.0.0.1:$PORT" >/dev/null 2>&1 ) &
exec python3 server.py --port "$PORT"
