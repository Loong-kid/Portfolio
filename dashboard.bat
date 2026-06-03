@echo off
REM Double-click launcher for Portfolio Monitor Dashboard
REM Do NOT close the console window - it runs the Streamlit server

cd /d "%~dp0"

if not exist ".venv\Scripts\activate.bat" (
    echo Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 ( pause & exit /b 1 )
)

call .venv\Scripts\activate.bat

if not exist ".venv\Scripts\streamlit.exe" (
    echo Installing dependencies - first run takes a few minutes...
    pip install -r requirements.txt
    if errorlevel 1 ( pause & exit /b 1 )
)

streamlit run app.py
