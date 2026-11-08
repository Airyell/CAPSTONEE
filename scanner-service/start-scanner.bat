@echo off
cd /d "%~dp0"
call venv\Scripts\activate.bat
python app.py >> scanner-log.txt 2>&1