@echo off
chcp 65001 >nul
title SimpleTTS 语音助手（局域网模式）
cd /d "%~dp0"
set HOST=0.0.0.0

echo.
echo  ============================================
echo     SimpleTTS 语音助手 - 局域网模式
echo     手机 / 平板连接同一 WiFi 后即可访问
echo  ============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未检测到 Python，请先安装 Python 3.9 或更高版本。
  echo          下载地址: https://www.python.org/downloads/
  echo          安装时请勾选 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo  [首次运行] 正在创建虚拟环境并安装依赖，请稍候…
  python -m venv .venv
  call ".venv\Scripts\activate.bat"
  python -m pip install --upgrade pip >nul
  pip install -r requirements.txt
  if errorlevel 1 (
    echo  [错误] 依赖安装失败，请检查网络后重新运行。
    pause
    exit /b 1
  )
) else (
  call ".venv\Scripts\activate.bat"
)

echo  [提示] 首次启动 Windows 会弹出防火墙提示，请选择"允许访问"。
echo         手机访问地址见下方"局域网访问"。
echo.
start "" "http://localhost:8000"
python server.py
pause
