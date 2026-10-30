@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Poker Server
echo.
echo Starting Texas Hold'em Poker Server...
echo.
echo Keep this window open while playing.
echo.
node.exe server.js
echo.
echo Server stopped. Press any key to close...
pause >nul
