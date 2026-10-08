@echo off
rem Abre Nexo Lab en 127.0.0.1:8770. server.py lee VirtualBox; las acciones de la seccion Control siempre piden confirmacion.
rem Sin Python, o con el puerto ocupado, abre el archivo directamente (en ese caso el panel muestra datos demo).
cd /d "%~dp0"
netstat -ano | findstr /R /C:":8770 .*LISTENING" >nul
if errorlevel 1 goto :arrancar
rem El puerto esta ocupado: comprobamos que sea server.py (responde JSON en /api/estado).
curl -s -o nul -w "%%{content_type}" http://127.0.0.1:8770/api/estado | findstr /C:"json" >nul
if not errorlevel 1 (
  echo Nexo Lab ya esta en marcha. Abriendo el navegador...
  start "" http://127.0.0.1:8770/index.html
  goto :eof
)
echo.
echo  ATENCION: el puerto 8770 lo ocupa otro programa ^(probablemente una ventana vieja de Nexo Lab^).
echo  Cierra esa ventana y vuelve a abrir iniciar.bat para ver tus maquinas reales.
echo.
pause
goto :eof

:arrancar
py -3 --version >nul 2>&1
if not errorlevel 1 ( start "" http://127.0.0.1:8770/index.html & py -3 server.py 8770 & goto :eof )
python --version >nul 2>&1
if not errorlevel 1 ( start "" http://127.0.0.1:8770/index.html & python server.py 8770 & goto :eof )
echo No se encontro Python. Abriendo index.html directamente (datos demo)...
start "" "%~dp0index.html"
