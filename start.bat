@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Poker Server
echo.
echo Starting Texas Hold'em Poker Server...
echo.
echo Keep this window open while playing.
echo.
choice /c KOF /n /m "[K] Keep league setting  [O] Enable league  [F] Disable league: "
set "LEAGUE_OPTION="
if errorlevel 3 set "LEAGUE_OPTION=--leagues=off"
if errorlevel 2 if not errorlevel 3 set "LEAGUE_OPTION=--leagues=on"
node.exe server.js %LEAGUE_OPTION%
echo.
echo Server stopped. Press any key to close...
pause >nul
