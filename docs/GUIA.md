# Nexo Lab · Centro de operaciones

Panel local para ver de un vistazo tu equipo y tus máquinas virtuales de **VirtualBox**.

## Iniciar

Doble clic en `iniciar.bat`, o:

```bash
python server.py 8770
```

y abre <http://127.0.0.1:8770/index.html>. Requiere Python 3 (sin paquetes extra) y VirtualBox instalado.
Si `VBoxManage.exe` no está en la ruta habitual, define la variable `NEXO_VBOXMANAGE` con su ruta.

## Qué es real y qué no

- **Real (leído de VirtualBox, solo lectura):** lista de máquinas, estado exacto (encendida, guardada, pausada, apagada, interrumpida), fecha del último cambio de estado, vCPU y RAM asignadas, adaptadores de red e IP (solo si la VM está encendida y tiene Guest Additions).
- **Real (equipo anfitrión):** uso de CPU, memoria y disco.
- **No disponible:** el uso de CPU y memoria de cada VM. VirtualBox solo lo da si se activa su recolección de métricas, y este panel no cambia la configuración de VirtualBox.
- **Demo:** si el servicio no responde (por ejemplo, al abrir `index.html` con doble clic), el panel muestra datos de ejemplo de `js/data.js` y lo indica claramente.

**La monitorización es de solo lectura:** para leer VirtualBox, `server.py` solo ejecuta `VBoxManage list vms`, `showvminfo` y `guestproperty get`.

**La sección Control sí cambia el laboratorio.** Sus acciones (encender y apagar VM, Active Directory en DC01, correcciones de servicios, asistente) se enrutan desde `server.py` hacia `control.py`. Solo existe un catálogo fijo de acciones, cada una exige confirmación con un ticket de un solo uso, un token y el mismo origen, y queda registrada en `data/acciones-auditoria.jsonl` (sin secretos). Con `NEXO_SIMULAR=1` se muestra «Modo simulación» y no se ejecuta nada real. Detalles en la sección Control, más abajo.

Escucha solo en 127.0.0.1 y rechaza peticiones con otro nombre de host.

## Tiempo real y vista previa

- **Rendimiento en vivo (cada segundo):** CPU y memoria del equipo y de cada VM encendida, con gráficas de los últimos 60 s, como el Administrador de tareas.
  Se mide desde este equipo leyendo los procesos `VirtualBoxVM.exe` / `VBoxHeadless.exe` de cada VM (permiso de consulta limitada de Windows). No cambia nada en VirtualBox.
  - *CPU*: porcentaje de la CPU total de tu PC que usa la VM.
  - *Memoria*: RAM de tu PC que ocupa la VM, sobre la que tiene asignada.
  - *E/S*: lectura y escritura del proceso de la VM (disco y red).
  - No es la CPU "dentro" del sistema invitado; para eso harían falta las métricas de VirtualBox con Guest Additions.
- **Pausa automática:** las lecturas se detienen cuando la pestaña no está visible.
- **Vista previa al pasar el ratón:** sobre una tarjeta, fila, máquina de la vista de red, actividad o alerta aparece un resumen en vivo sin hacer clic. Con el teclado aparece al enfocar; `Esc` la cierra. El clic sigue abriendo la hoja con todos los detalles.

## Servicios, alertas y grupos (`servicios.json`)

- **Servicios esperados:** cada VM tiene en `servicios.json` su grupo, etiquetas y servicios (nombre y puerto). Edítalo y el cambio se aplica en la siguiente actualización.
- **Comprobación:** conexión TCP simple (abre y cierra, sin enviar datos), solo a esos puertos y solo en IPs de VMs encendidas que estén en una red de este equipo (la de solo anfitrión). Nunca rangos ni equipos ajenos.
- **Estados de servicio:** Responde, No responde, Arrancando (la VM se encendió hace menos de 2 min) y Sin comprobar (VM apagada o sin IP alcanzable).
- **Alertas de salud:** servicio que no responde, VM interrumpida desde hace días, VM encendida sin IP, y memoria o CPU del equipo altas de forma sostenida. Cada alerta dice qué se comprobó y a qué hora. Los umbrales se editan con el botón **Configurar** (o en `ajustes` de `servicios.json`).
- **Tipos de comprobación:** `tcp` solo confirma que el puerto acepta la conexión; `http`/`https` hace un GET sin credenciales y confirma que la aplicación contesta (código menor que 500; 401/403 se consideran normales sin credenciales).
- **Red del laboratorio:** agrupa las máquinas por red de VirtualBox (solo anfitrión, NAT, red interna, puente) con la IP de cada una en esa red.
- **Historial de esta sesión:** registra cambios de estado y de servicios mientras el panel está abierto, con cuánto duró el estado anterior. No se guarda en ningún archivo.
- **Exportar:** genera un reporte Markdown o JSON en tu equipo, con opción de ocultar IPs y el nombre del equipo.

## Guías de solución

Si no ves el botón «Guía de solución» en las alertas, tu navegador tiene una versión antigua de la página: el panel lo detecta y muestra un aviso naranja «Estás viendo una versión antigua de la interfaz» (pulsa `Ctrl + F5`). En «Conectado a VirtualBox…» aparece la versión de la interfaz que está cargada (por ejemplo, «Interfaz v24»).

Cada alerta tiene el botón **Guía de solución**, que abre una hoja con:

1. **Qué detectó el panel:** hora y evidencia exacta de la comprobación.
2. **Qué significa y su límite:** por ejemplo, un puerto que no responde no prueba por sí solo que el servicio esté detenido.
3. **Diagnóstico:** pasos numerados de solo lectura, de lo más simple a lo más detallado. Cada uno indica dónde se ejecuta (tu PC en PowerShell, o la VM en PowerShell o en terminal según su sistema) y tiene un botón **Copiar**. Los comandos ya llevan la IP y el nombre reales de la máquina.
4. **Corrección posible:** separada y marcada como «Cambia el sistema». **El panel no la ejecuta**; la haces tú, solo si el diagnóstico lo justifica.
5. **Cómo verificar:** **Comprobar ahora** lanza una comprobación nueva. La alerta solo se cierra cuando una comprobación confirma la recuperación.

**Documentar resultado** prepara la nota de Obsidian con la interpretación prudente y los pasos de diagnóstico como casillas.

- **Comprobar ahora** fuerza una lectura nueva (no usa la que el servidor guarda 3 s). Si la consulta falla, no afirma nada: dice «No se pudo comprobar» y que se conservan los datos anteriores.
- **Correcciones condicionadas:** cada paso que cambia algo indica «Solo si:» qué debe mostrar el diagnóstico para justificarlo. En Wazuh se sigue el orden de su documentación (estado y registros del dashboard, `opensearch.hosts`, conectividad con el indexador, estado y registros del indexador) y solo se propone reiniciar el componente que se confirme caído; un indexador sano no se reinicia.
- **CPU:** el diagnóstico mide el uso durante 5 segundos. No ordena por `CPU` de `Get-Process`, que es el tiempo acumulado desde que arrancó cada proceso.

Las guías están en `js/guias.js`, separadas del resto del código para revisarlas o ampliarlas. Hay guías para:
- error 5xx (con pasos específicos para el panel de Wazuh y su indexador);
- servicio sin respuesta (Linux: SSH, servicios systemd; Windows: RDP, DNS, LDAP);
- VM interrumpida;
- VM sin IP;
- memoria o CPU altas del equipo;
- error de configuración.

## Configurar desde el panel

El botón **Configurar** abre un formulario con los umbrales de alertas, el registro del historial y, para cada máquina, su grupo, sus etiquetas y sus servicios (nombre, puerto, tipo TCP/HTTP/HTTPS y ruta).

- **Revisar cambios…** valida los datos y muestra la lista exacta de lo que cambiará antes de guardar.
- Al guardar, el servidor vuelve a validar, guarda una copia del `servicios.json` anterior en `data/copias-config/` y escribe el archivo nuevo de forma atómica. El cambio se aplica en la siguiente comprobación.
- Se conservan los textos de ayuda (`_ayuda`) del archivo. Si `servicios.json` tiene un error de formato, el panel no lo sobrescribe y pide corregirlo a mano.
- Para deshacer un cambio, copia el archivo de `data/copias-config/` que quieras sobre `servicios.json`.

## Lectura rápida del estado

- **Indicador principal:** «Atención requerida», «Todo en orden» o «Laboratorio en reposo», con alertas abiertas, VM encendidas, servicios que responden y hora de la última comprobación.
- **Alertas por tipo**, con icono, color y etiqueta coherentes:

  | Tipo | Color | Significado |
  |---|---|---|
  | Error 5xx | rojo | La aplicación responde, pero con error del servidor |
  | VM interrumpida | rojo | VirtualBox la marca como interrumpida o bloqueada |
  | Sin respuesta | naranja | El servicio no aceptó la conexión o no contestó |
  | Sin IP | naranja | Encendida, pero sin IP visible desde el equipo |
  | Recursos del equipo | índigo | Memoria o CPU del PC por encima del umbral |

  La evidencia de cada alerta se despliega con «Ver evidencia».
- **Mapa de red:** el equipo arriba, las redes compartidas en el centro y las VM abajo, con una línea por adaptador (gruesa si la VM está encendida). NAT se marca con una etiqueta en cada VM porque cada una tiene su propia red NAT aislada. La vista **Lista** muestra lo mismo como texto, y los nodos del mapa se abren con el teclado (Tab y Enter).
- **Historial filtrable** por máquina, tipo de evento y periodo.
- **Datos disponibles:** en los detalles de cada máquina, qué datos hay, de dónde salen y cuáles faltan. Por ejemplo, el uso de memoria *dentro* del sistema invitado no está disponible, y el que se muestra es la RAM de tu PC que ocupa la VM.

## Historial (SQLite)

- **Dónde:** `data/nexo-historial.db` (la carpeta `data/` está en `.gitignore`). Junto a él, `data/.historial-creado` sirve para detectar si el historial desaparece.
- **Qué guarda:**
  - cambios de estado de cada VM, con la hora que da VirtualBox;
  - cambios en el resultado de cada servicio (responde / no responde);
  - alertas que aparecen y se resuelven;
  - una muestra de CPU y memoria por minuto del equipo y de cada VM encendida;
  - las sesiones del servidor (inicio y última actividad).
- **Cuándo:** `server.py` comprueba cada 30 s mientras está abierto (aunque cierres el panel), pero **solo escribe una fila cuando algo cambia**. Las muestras de recursos son como máximo una por minuto.
- **Listas desplegables.** «Historial guardado», «Último cambio registrado por VirtualBox» y «Registro de acciones» son bloques que se abren y cierran (el navegador recuerda cuáles). Muestran las 8 entradas más recientes y «Ver 20 más» abre las siguientes, así que la página no crece con cada cambio.
- **Origen de cada cambio de estado.** El historial indica si un cambio de estado lo pidió el panel (acción, usuario y hora) o si no hay ninguna acción registrada (pudo hacerse en VirtualBox, dentro de la VM o por un fallo). Tras un cierre del servidor no afirma nada.
- **Reinicios:** el historial se conserva. Si el servidor estuvo cerrado más de 90 s, se registra un evento «Sin datos» con el intervalo, y en las tendencias ese hueco se marca en gris. Lo que cambió en ese periodo se registra al reabrir, indicando que ocurrió en algún momento del intervalo (para las VM, con la hora exacta que da VirtualBox). No se inventan cambios.
- **Retención:** 30 días por defecto. Para cambiarla, edita `"diasRetencion"` en `ajustes` de `servicios.json`; se aplica en la siguiente limpieza (una por hora).
- **Si falta o está dañado:** el panel sigue funcionando sin historial y muestra un mensaje en «Actividad» y en la consola del servidor. **Nunca se crea un archivo nuevo encima ni se borra nada.** Para empezar de cero: cierra el servidor, mueve o renombra `data/nexo-historial.db` (y, si el archivo ya no existe, borra `data/.historial-creado`) y vuelve a abrirlo.

## Notas para Obsidian

- **Documentar:** el botón «Documentar» aparece junto a cada alerta y cada entrada del historial. Abre una nota Markdown editable con las propiedades (`fecha`, `maquina`, `tipo`, `tags`), enlaces `[[máquina]]`, la evidencia y el contexto observado, y apartados vacíos para tu diagnóstico, pasos y resolución. El panel no escribe causas.
- **Siempre disponible:** «Copiar» y «Descargar .md».
- **Configurar la bóveda:**
  1. Copia `nexo.local.ejemplo.json` como `nexo.local.json`. Este archivo no se sube a Git.
  2. Escribe la ruta de tu bóveda en `"boveda"`, con las barras dobles de JSON. Por ejemplo `"C:\Users\tu-usuario\Documents\MiBoveda"`. La carpeta debe existir y contener `.obsidian`, es decir, haberse abierto como bóveda en Obsidian.
  3. Opcional: cambia `"carpeta"` (por defecto `Nexo Lab`).
  4. Vuelve a abrir la ventana «Documentar». No hace falta reiniciar el servidor.
- **«Guardar en Obsidian…»:** muestra la ruta exacta del archivo nuevo y pide confirmación antes de escribir. Las notas se guardan en `<bóveda>/Nexo Lab/<máquina>/<AAAA-MM-DD>/<HHmm - título>.md`. Si ya existe una nota con ese nombre, se crea «(2)», «(3)»… y **nunca se sobrescribe** nada. Si el texto parece contener una contraseña, un token o una clave, avisa antes de guardar.
- **Seguridad de la escritura:** es la única que hace el servidor fuera de `data/`. Solo acepta peticiones del propio panel (mismo origen y JSON) y solo dentro de la bóveda configurada.

## Cómo probarlo

1. **Historial:** abre el panel y enciende o guarda una VM en VirtualBox. En «Actividad» > «Historial guardado» aparece el cambio en unos 30 s. Cierra la ventana del servidor de Nexo Lab, espera dos minutos y ábrela con `iniciar.bat`: los eventos anteriores siguen ahí y aparece «Sin datos: el servidor estuvo cerrado…».
2. **Tendencias:** abre los detalles de una máquina encendida, sección «Tendencia guardada» (1 h, 24 h, 7 días).
3. **Obsidian sin configurar:** pulsa «Documentar» en una alerta. «Guardar en Obsidian…» aparece desactivado con las instrucciones, y «Copiar» y «Descargar .md» funcionan.
4. **Obsidian configurado:** tras crear `nexo.local.json`, pulsa «Documentar», completa el diagnóstico, «Guardar en Obsidian…», revisa la ruta y confirma. Guarda la misma nota otra vez y verás que se crea «(2)» sin tocar la primera.

## Control (acciones que cambian el laboratorio)

La sección **Control** es la única parte del panel que cambia algo. Está separada de la lectura: en la página va en un recuadro naranja («Zona de acciones») y en el código vive en `control.py`, `js/control.js` y `ops/`. `server.py` no ejecuta esas acciones por sí mismo: solo recibe las peticiones de Control, las valida (origen, token y ticket) y las delega en `control.py`.

### Cómo se protege

- **Catálogo fijo.** Solo existen estas acciones: `vm.start`, `vm.shutdown`, `vm.pause`, `vm.resume`, `vm.savestate`, `svc.recheck`, `svc.start`, `svc.restart`, `ad.unlock`, `ad.enable`, `ad.disable`, `ad.reset_password`. No hay ninguna que acepte comandos de texto, ni desde la interfaz ni desde un asistente.
- **Parámetros tipados.** Cada acción admite solo sus parámetros. Los servicios deben estar en la lista de `control.json` para esa VM. Las cuentas y los nombres se validan con expresiones estrictas. Los programas se lanzan con argumentos separados, sin shell.
- **Objetivo verificado.** La VM debe existir en VirtualBox y estar en `control.json` → `maquinas`. Su IP es la que el panel comprobó, nunca una escrita a mano. La acción debe corresponder al estado actual: no se puede encender una VM encendida ni apagar una apagada.
- **Dos pasos.** El servidor primero describe la acción y devuelve un ticket de un solo uso que caduca a los 2 minutos. La hoja de confirmación muestra el objetivo, la operación exacta, qué cambia y cómo se verificará. Al ejecutar, el servidor vuelve a validarlo todo.
- **Solicitudes protegidas.** El servidor solo escucha en `127.0.0.1` y comprueba el `Host`. Exige el mismo `Origin`, JSON y un token que solo conoce la página servida por él. Si el navegador informa `Sec-Fetch-Site`, debe ser del mismo sitio. Por eso otra web no puede lanzar acciones aunque tengas el panel abierto; no se depende solo de `localhost`.
- **Auditoría.** `data/acciones-auditoria.jsonl` registra quién (tu usuario de Windows y el identificador de sesión del servidor), qué acción, sobre qué objetivo, origen (panel o asistente), hora y resultado. Nunca registra contraseñas ni secretos.
- **Credenciales.** Están en el **Administrador de credenciales de Windows**, nunca en `control.json`, `nexo.local.json`, registros ni argumentos de procesos. El servidor solo comprueba que existan. El secreto lo lee el script de `ops/` dentro de su propio proceso.

### Disponible ya: encender, pausar y apagar VM

- **Encender** (`VBoxManage startvm`): para VM apagadas, guardadas o interrumpidas.
- **Apagado normal** (`VBoxManage controlvm … acpipowerbutton`): equivale a pulsar el botón de encendido.
- **Pausar** (`VBoxManage controlvm … pause`) y **Reanudar** (`… resume`): congelan la VM en memoria sin apagarla ni perder su estado. Mientras está en pausa sus servicios no responden; el panel los muestra como «sin comprobar» (con el motivo) y no genera alertas.
- **Guardar estado** (`VBoxManage controlvm … savestate`): escribe la memoria en disco y detiene la VM; al encenderla vuelve donde estaba. Ocupa en disco tanto como su RAM y conviene no cambiar su configuración mientras esté guardada. Para DC01 y wazuh-server suele ser preferible el apagado normal.
- **Nunca se fuerza el apagado.** Si el sistema invitado no se apaga en 3 minutos, el resultado es «Sin confirmar» y se explica por qué.
- **Verificación.** El panel muestra el progreso y vuelve a consultar VirtualBox hasta confirmar el estado final.
- **Botones desactivados.** Si una acción no corresponde al estado de la VM, su botón está desactivado e indica el motivo.

### Active Directory en DC01 (requiere configuración)

**Qué hace el panel.**
- **Consulta:** usuarios, grupos y equipos, buscando por nombre o cuenta. Muestra si la cuenta está habilitada o bloqueada, el estado de la contraseña, el último inicio de sesión y sus grupos.
- **Cambios** (desbloquear, habilitar, deshabilitar o restablecer con contraseña temporal): se confirman una a una.
- **Si DC01 no responde:** si está apagado o la consulta falla, lo dice claramente.
- **Conexión:** usa LDAP **firmado y cifrado** (no hace falta RSAT en tu PC).

**Por qué está desactivado ahora.** No existe la credencial `NexoLab:AD`. Para activarlo:

1. **Cuenta delegada.** En DC01, crea una cuenta de servicio (por ejemplo `nexo-helpdesk`). Delega solo sobre la OU de tus usuarios de laboratorio (asistente *Delegar control* en «Usuarios y equipos de Active Directory»). Permisos:
   - «Restablecer contraseña»;
   - leer y escribir `lockoutTime`;
   - leer y escribir `userAccountControl`;
   - leer y escribir `pwdLastSet`.

   **No uses Domain Admin.** Si la credencial se llama Administrator o Administrador, el panel lo advierte.
2. **Credencial en Windows.** En tu PC, guárdala en el Administrador de credenciales. El comando pide la contraseña sin mostrarla:

```bash
cmdkey /generic:NexoLab:AD /user:LAB\nexo-helpdesk /pass
```

3. **OU permitidas.** En `control.json`, escribe en `activeDirectory.ouPermitidas` la OU donde se permiten cambios, por ejemplo `"OU=Laboratorio,DC=lab,DC=local"`. Sin OU permitidas, solo se puede consultar.

**Cuentas protegidas.**
- **Administrator y krbtgt:** nunca se modifican desde el panel.
- **Cuenta que usa el propio panel:** tampoco se modifica.
- **Cuentas privilegiadas** (Domain Admins, Enterprise Admins, Administradores, operadores, `adminCount = 1`…):
  - desbloquear o habilitar exige escribir el nombre exacto de la cuenta;
  - deshabilitarlas y restablecer su contraseña no está permitido en esta versión.
- **No hay acciones destructivas:** no se borran usuarios ni grupos, no se cambian directivas y no hay acciones masivas.

**Contraseña temporal.**
- **Generación:** aleatoria (16 caracteres), en este equipo.
- **Transporte:** llega al script por la entrada estándar, no por argumentos visibles.
- **Inicio de sesión:** se marca «debe cambiarla al iniciar sesión».
- **Visualización:** se muestra **una sola vez** en la hoja de resultado. Se borra al cerrarla, o a los 3 minutos si la dejas abierta.
- **Almacenamiento:** no se guarda ni se registra.
- **Al entregarla:** cópiala y entrégala por un canal seguro.

> **No probado contra DC01 real.** Durante el desarrollo no se cambió Active Directory. La lógica se probó en modo simulación y con pruebas automáticas. La primera vez, prueba con una cuenta de laboratorio sin importancia.

### Correcciones de servicios (requieren configuración)

- **Dónde aparecen:** en Control y dentro de la **Guía de solución** de la alerta correspondiente. Muestran qué detectó el panel, qué cambiaría, en qué VM y cómo se verificará.
- **Reintentar comprobación:** siempre está disponible. Es solo lectura y no pide confirmación.
- **Iniciar o reiniciar:** solo para los servicios que asocias a un puerto en `control.json` → `correcciones`. Una alerta nunca ejecuta nada por sí sola.
- **DC01 (WinRM).**
  - Crea una credencial con permiso para gestionar esos servicios: `cmdkey /generic:NexoLab:WinRM /user:LAB\cuenta /pass`.
  - Servicios permitidos: `TermService` (RDP) y `DNS`.
  - Los servicios con dependientes no se reinician a la fuerza.
- **Linux (SSH: wazuh-server, SecSrv01).** Hoy no hay forma segura: no hay claves SSH y el agente SSH de Windows está desactivado, y el panel no usa contraseñas SSH. Para activarlo:
  1. En la VM, crea un usuario (por ejemplo `nexo-ops`) con `sudo` limitado a esos comandos exactos (`/usr/bin/systemctl start wazuh-dashboard`, etc.).
  2. En tu PC, activa el servicio «OpenSSH Authentication Agent», crea una clave y cárgala con `ssh-add`. Así queda protegida por Windows.
  3. Conecta una vez por SSH a mano para guardar la huella del servidor. El panel exige que coincida.
  4. Escribe el usuario en `control.json`.

### Asistente de diagnóstico (Hermes u OpenCode)

- **Cómo se integra.** Por intercambio manual:
  1. el panel prepara un texto con los datos de la alerta (sin credenciales y con las IP ocultas) y el catálogo de acciones permitidas;
  2. tú lo pegas en Hermes u OpenCode;
  3. pegas su respuesta JSON en el panel;
  4. Nexo Lab valida que `action_id`, VM y parámetros sean del catálogo y te muestra la propuesta. Para ejecutarla pasa por la misma confirmación que cualquier otra acción.
- **Qué puede proponer:** el asistente no puede proponer acciones de Active Directory ni cambiar el catálogo.
- **Por qué no se lanza Hermes u OpenCode desde el servidor.** Ambos son agentes con herramientas propias (terminal, edición de archivos). No se puede garantizar desde Nexo Lab que no las usen. Además, el panel no puede saber si el modelo configurado es local o externo.
- **Si sus datos salen de tu equipo.** Si tu asistente usa un proveedor externo, lo que pegues saldrá de tu equipo; el panel lo advierte. Con un modelo local (Ollama, LM Studio) se queda en tu PC.
- **Si no hay modelo:** el panel funciona igual.

### Probar sin tocar el laboratorio

En PowerShell:

```bash
$env:NEXO_SIMULAR = "1"; python server.py 8771
```

En modo simulación todas las acciones (VM, AD con un directorio ficticio, servicios) se simulan; el panel lo indica en violeta. Pruebas automáticas:

```bash
python -m unittest tests.test_control -v
```

### Aviso de seguridad detectado

En tu PC, WinRM tiene `TrustedHosts = *`, es decir, confía en cualquier equipo. Conviene limitarlo a DC01. Desde PowerShell como administrador:

```bash
Set-Item WSMan:\localhost\Client\TrustedHosts -Value 192.168.56.10
```

## Uso

- Pulsa una tarjeta, una fila o una entrada de actividad para ver los detalles de la máquina.
- Estado de VirtualBox y servicios: cada 10 segundos (y con «Actualizar»). Rendimiento: cada segundo.
- `Ctrl + K` abre las **acciones rápidas**. Desde ahí puedes ir a una sección, abrir una máquina o la guía de una alerta, actualizar, exportar, configurar o cambiar de vista. Las flechas eligen, `Enter` abre y `Esc` cierra. No ejecuta acciones de Control.
- `/` enfoca la búsqueda; `Esc` la limpia o cierra la hoja de detalles.
- Filtros, búsqueda, vista y máquina abierta se reflejan en la URL (`?estado=paused&vista=lista&m=<id>`).

## Estructura

```
index.html        Página
css/styles.css    Estilos (claro y oscuro)
js/app.js         Interfaz y lectura de /api/estado
js/guias.js       Guías de solución por tipo de alerta
js/data.js        Datos de demostración (respaldo)
server.py         Servidor local: lectura de VirtualBox, servicios, historial, Obsidian
control.py        Acciones de Control: catálogo, validación, confirmación, auditoría
control.json      Máquinas del laboratorio, AD y servicios corregibles (sin secretos)
ops/ad.ps1        Operaciones de Active Directory (LDAP cifrado)
ops/winsvc.ps1    Iniciar o reiniciar un servicio de Windows por WinRM
js/control.js     Interfaz de la sección Control
js/paleta.js      Acciones rápidas (Ctrl + K): solo navegación
tests/            Pruebas de Control: python -m unittest tests.test_control
servicios.json    Grupos, etiquetas, servicios esperados (tcp/http/https) y umbrales de alertas
data/             Historial local (nexo-historial.db); no se sube a Git
nexo.local.ejemplo.json  Plantilla de configuración local (ruta de la bóveda de Obsidian)
iniciar.bat       Atajo para Windows
DESIGN.md         Dirección de diseño
```
