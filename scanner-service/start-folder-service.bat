@echo off
cd /d "%~dp0"
node folder-server.cjs >> folder-log.txt 2>&1