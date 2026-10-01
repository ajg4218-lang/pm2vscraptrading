@echo off
setlocal
title PM2V Scrap Trading - Firebase + AI Scrap Scanner
cd /d "%~dp0"

echo ==============================================
echo       PM2V SCRAP TRADING WEB APP
echo ==============================================
echo.
echo Checking Python installation...
python --version
if errorlevel 1 (
    echo.
    echo ERROR: Python was not found.
    echo Install Python 3 and make sure "python" works in Command Prompt.
    pause
    exit /b 1
)

echo.
echo Starting PM2V local server on http://127.0.0.1:8000 ...
start "PM2V Local Server" cmd /k python "%~dp0ScrapScan_server_v8.py"

echo.
echo Waiting 3 seconds for the server to start...
timeout /t 3 /nobreak >nul

echo Opening PM2V...
start "" "http://127.0.0.1:8000/PM2V.html"

echo.
echo PM2V should now be open in your browser.
echo Keep the "PM2V Local Server" window open for the AI Scrap Scanner.
echo.
pause
endlocal
