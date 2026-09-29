@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
set "TOKEN_FILE=%PROJECT_ROOT%\data\admin-token.txt"
if not exist "%TOKEN_FILE%" (
  echo Reader token has not been created yet. Start Character Voice Reader once first.
  pause
  exit /b 1
)
type "%TOKEN_FILE%"
echo.
pause
endlocal
