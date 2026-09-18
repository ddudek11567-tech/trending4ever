@echo off
REM Nightly Adult Movie Updater - Windows Batch Wrapper
REM Run via Windows Task Scheduler daily at 2 AM

cd /d "C:\Users\ddude\Documents\Default Project\trending4ever-repo"

echo [%date% %time%] Starting nightly adult update...
node nightly_adult_updater.js >> nightly_update.log 2>&1

if %errorlevel% neq 0 (
    echo [%date% %time%] ERROR: Update failed with code %errorlevel%
    exit /b %errorlevel%
)

echo [%date% %time%] Update completed successfully
exit /b 0