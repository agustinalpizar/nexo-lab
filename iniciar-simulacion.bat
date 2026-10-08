@echo off
rem Nexo Lab en MODO SIMULACION (puerto 8772): las acciones de Control se simulan y no cambian VirtualBox, Active Directory ni servicios.
rem Sirve para grabar el video o probar la interfaz. La lectura de VirtualBox sigue siendo real.
rem No usa el puerto 8770 (el del panel normal), asi que pueden convivir.
cd /d "%~dp0"
set NEXO_SIMULAR=1
netstat -ano | findstr /R /C:":8772 .*LISTENING" >nul
if not errorlevel 1 (
  echo Ya hay algo en el puerto 8772. Cierra esa ventana y vuelve a abrir este archivo.
  pause
  goto :eof
)
echo Arrancando Nexo Lab en modo simulacion en el puerto 8772...
start "Nexo Lab (SIMULACION)" cmd /k "set NEXO_SIMULAR=1&& python server.py 8772"
echo Esperando a que el servidor responda (la primera lectura puede tardar hasta 30 s)...
set /a intentos=0
:esperar
set /a intentos+=1
curl -s -o nul -m 5 http://127.0.0.1:8772/api/estado
if not errorlevel 1 goto :listo
if %intentos% GEQ 20 goto :listo
goto :esperar
:listo
start "" http://127.0.0.1:8772/index.html
echo Listo. Debe verse el aviso "MODO SIMULACION" en la seccion Control.
