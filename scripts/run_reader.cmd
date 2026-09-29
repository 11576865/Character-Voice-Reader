@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
set "VENV_PYTHON=%PROJECT_ROOT%\.venv\Scripts\python.exe"
if not exist "%VENV_PYTHON%" (
  echo ERROR: Reader virtual environment was not found. Run .\scripts\first_setup.cmd first.
  exit /b 1
)
pushd "%PROJECT_ROOT%"
"%VENV_PYTHON%" -m reader_server.app
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
