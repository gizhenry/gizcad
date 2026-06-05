@echo off
echo Starting PatternQ...
echo.

:: Open browser
start http://localhost:8080/index.html

:: Install dependencies if needed and start server
if not exist node_modules (
    echo Installing dependencies...
    npm install
)

npx serve prototype-ui -l 8080

pause
