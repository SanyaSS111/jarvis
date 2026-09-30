@echo off
rem Сборка J.A.R.V.I.S. HUD 2.0 со значком.
rem Компилятора ресурсов в поставке Rust для GNU нет, поэтому значок
rem вписывается в готовый exe отдельным шагом.

setlocal
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
set PYTHON=%USERPROFILE%\Desktop\JarvisHUD\venv\Scripts\python.exe

echo [1/3] Сборка...
cargo build --release || goto :error

echo [2/3] Значок...
"%PYTHON%" tools\set_icon.py "%~dp0target\release\JarvisHUD2.exe" "%~dp0jarvis2.ico" || goto :error

echo [3/3] Копия в корень проекта...
copy /Y "%~dp0target\release\JarvisHUD2.exe" "%~dp0JarvisHUD2.exe" >nul || goto :error

echo.
echo Готово: %~dp0JarvisHUD2.exe
exit /b 0

:error
echo.
echo Сборка не удалась.
exit /b 1
