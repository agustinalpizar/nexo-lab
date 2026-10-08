// Guías de solución para cada tipo de alerta de Nexo Lab.
//
// Reglas de estas guías:
// - Primero lo que NO cambia nada (comprobaciones de solo lectura), de lo más simple a lo más detallado.
// - Las correcciones van aparte, marcadas como acciones que hace la persona. El panel nunca las ejecuta.
// - Se explica qué demuestra la alerta y, sobre todo, qué NO demuestra, para no saltar a conclusiones.
// - Una alerta solo se da por resuelta cuando una nueva comprobación del panel lo confirma.
//
// Cada paso: { title, where, cmd?, note?, changes? }
//   where: 'pc' (PowerShell en tu equipo), 'vm' (terminal dentro de la VM), 'panel' o 'vbox' (VirtualBox).
//   changes: true si el comando modifica algo (solo en «Corrección»).
(function (root) {
  'use strict';

  const q = (s) => '"' + String(s).replace(/"/g, '') + '"';

  function svcLinux(ctx) {
    const n = ctx.svcName.toLowerCase();
    if (n.includes('ssh') || ctx.port === 22) return { unit: 'ssh', alt: 'sshd' };
    if (n.includes('panel de wazuh') || (n.includes('wazuh') && ctx.port === 443)) return { unit: 'wazuh-dashboard' };
    if (n.includes('api de wazuh') || ctx.port === 55000) return { unit: 'wazuh-manager' };
    if (n.includes('nginx')) return { unit: 'nginx' };
    if (n.includes('apache')) return { unit: 'apache2' };
    if (n.includes('gns3')) return { unit: 'gns3-server' };
    return { unit: null };
  }

  function svcWindows(ctx) {
    if (ctx.port === 3389) return { svc: 'TermService', label: 'Servicios de Escritorio remoto' };
    if (ctx.port === 53) return { svc: 'DNS', label: 'Servidor DNS' };
    if (ctx.port === 389 || ctx.port === 636) return { svc: 'NTDS', label: 'Servicios de dominio de Active Directory' };
    return { svc: null, label: ctx.svcName };
  }

  const reachability = (ctx) => ({
    title: `Comprobar desde tu PC si el puerto ${ctx.port} responde`,
    where: 'pc',
    cmd: `Test-NetConnection ${ctx.ip || '<IP de la VM>'} -Port ${ctx.port}`,
    note: 'TcpTestSucceeded: True significa que algo escucha en ese puerto. Si PingSucceeded es False pero el puerto responde, el ping está bloqueado y no importa.'
  });

  // ---------- servicio que responde con error 5xx ----------
  // Para Wazuh se sigue el orden de la guía oficial (Troubleshooting > «Wazuh dashboard server is not ready yet»):
  // estado y registros del dashboard, su configuración hacia el indexador, conectividad y estado/registros del indexador.
  // Solo se propone reiniciar el componente que el diagnóstico confirme como caído, y verificarlo después.
  function http5xx(ctx) {
    const u = svcLinux(ctx).unit;
    const isWazuh = u === 'wazuh-dashboard';
    const diag = [
      { title: 'Confirmar la respuesta desde tu PC (sin credenciales)', where: 'pc', cmd: `curl.exe -k -s -o NUL -w "%{http_code}\\n" https://${ctx.ip || '<IP>'}:${ctx.port}/`, note: 'Debería devolver el mismo código que vio el panel. -k acepta el certificado autofirmado del laboratorio.' }
    ];
    const fix = [];
    if (isWazuh) {
      diag.push(
        { title: '1. Ver si wazuh-dashboard está activo', where: 'vm', cmd: 'systemctl status wazuh-dashboard --no-pager', note: 'Fíjate en «Active:». Si dice «activating» o se reinicia solo, está en un bucle de errores. El mensaje «server is not ready yet» es normal justo después de iniciar o reiniciar el dashboard.' },
        { title: '2. Buscar errores en sus registros', where: 'vm', cmd: 'sudo journalctl -u wazuh-dashboard -n 300 --no-pager | grep -i -E "error|warn"', note: 'Busca fallos de conexión con el indexador («ECONNREFUSED», «Unable to connect», «Request Timeout»).' },
        { title: '3. Ver a qué indexador apunta el dashboard', where: 'vm', cmd: 'sudo grep -E "^opensearch.hosts" /etc/wazuh-dashboard/opensearch_dashboards.yml', note: 'Solo muestra esa línea (no el archivo entero, que contiene credenciales). Debe ser https://<IP del indexador>:9200 con la IP correcta.' },
        { title: '4. Comprobar que el dashboard alcanza al indexador', where: 'vm', cmd: 'curl -v telnet://<IP del paso 3>:9200', note: 'Sustituye la IP por la del paso 3. «Connected» significa que el puerto responde; «Connection refused» o un cuelgue apuntan al indexador o a la red.' },
        { title: '5. Ver si wazuh-indexer está activo', where: 'vm', cmd: 'systemctl status wazuh-indexer --no-pager', note: 'Si está caído, la guía oficial indica investigar sus errores antes de actuar.' },
        { title: '6. Buscar errores en los registros del indexador', where: 'vm', cmd: 'sudo grep -h -E "ERROR|WARN|Caused" /var/log/wazuh-indexer/*.log | tail -n 60', note: 'Causas frecuentes: poca memoria para Java (heap), disco lleno o un índice dañado.' },
        { title: '7. Revisar memoria y disco dentro de la VM', where: 'vm', cmd: 'free -m && df -h', note: 'El indexador necesita bastante memoria; si la VM va justa, puede caerse.' }
      );
      fix.push(
        { title: 'Si el paso 3 muestra una IP de indexador equivocada: corregir opensearch.hosts', where: 'vm', changes: true, onlyIf: 'el paso 3 muestra una IP que no es la del indexador', note: 'Edita /etc/wazuh-dashboard/opensearch_dashboards.yml (haz antes una copia) y reinicia después solo el dashboard.' },
        { title: 'Si el indexador está caído (paso 5): iniciarlo y esperar a que arranque', where: 'vm', cmd: 'sudo systemctl start wazuh-indexer', changes: true, onlyIf: 'el paso 5 muestra wazuh-indexer inactivo, y ya revisaste sus registros (paso 6)', note: 'Si cayó por falta de memoria o disco, arréglalo antes: volvería a caerse. Espera 1-2 minutos y comprueba que está activo.' },
        { title: 'Si solo el dashboard falla (indexador sano): reiniciar únicamente el dashboard', where: 'vm', cmd: 'sudo systemctl restart wazuh-dashboard', changes: true, onlyIf: 'el paso 1 muestra el dashboard inactivo o en bucle, y el indexador está activo y accesible (pasos 4 y 5)', note: 'No reinicies el indexador si está sano: interrumpiría el acceso a los datos y a otros servicios que dependen de él.' },
        { title: 'Si falta memoria o disco, liberarlo o ampliar la VM', where: 'vbox', changes: true, onlyIf: 'el paso 7 muestra poca memoria o el disco casi lleno', note: 'Por ejemplo, subir la RAM asignada con la VM apagada. Es un cambio de configuración que decides tú.' }
      );
    } else {
      if (u) {
        diag.push(
          { title: `Ver el estado del servicio ${u}`, where: 'vm', cmd: `systemctl status ${u} --no-pager` },
          { title: 'Leer sus últimos registros', where: 'vm', cmd: `sudo journalctl -u ${u} -n 100 --no-pager`, note: 'Busca líneas con error, timeout o fallos de conexión con sus dependencias.' }
        );
        fix.push({ title: `Reiniciar solo ${u}`, where: 'vm', cmd: `sudo systemctl restart ${u}`, changes: true, onlyIf: `el diagnóstico confirma que ${u} está caído o con errores`, note: 'Reiniciar corta sus conexiones activas. No reinicies servicios de los que dependa otros si no están afectados.' });
      }
      diag.push({ title: 'Revisar memoria y disco dentro de la VM', where: 'vm', cmd: 'free -m && df -h', note: 'Poca memoria o un disco lleno impiden que muchas aplicaciones arranquen.' });
      fix.push({ title: 'Si falta memoria o disco, liberarlo o ampliar la VM', where: 'vbox', changes: true, onlyIf: 'el diagnóstico muestra poca memoria o el disco casi lleno', note: 'Por ejemplo, subir la RAM asignada con la VM apagada.' });
    }
    return {
      means: `El puerto ${ctx.port} acepta conexiones y la aplicación contestó, pero con un error del servidor (${ctx.httpCode || '5xx'}). La máquina y la red funcionan; el problema está en la aplicación o en algo de lo que depende.`,
      notProves: isWazuh
        ? 'No demuestra que el panel de Wazuh esté «roto» ni que se hayan perdido datos. Un 503 suele aparecer mientras el servicio arranca o cuando el dashboard no consigue hablar con el indexador (wazuh-indexer), que puede ser el componente con el problema.'
        : 'No demuestra que la aplicación esté caída del todo ni qué componente falla. Puede ser un arranque en curso o una dependencia no disponible.',
      diag,
      fix,
      verify: `Después de cada acción, comprueba el servicio afectado y pulsa «Comprobar ahora». La alerta se cerrará cuando la petición ${ctx.method ? ctx.method.toUpperCase() : 'HTTPS'} a ${ctx.ip || 'la VM'}:${ctx.port} devuelva un código menor que 500. Puede tardar 1-2 minutos tras iniciar o reiniciar un servicio.`,
      verifyCmd: isWazuh ? { where: 'vm', cmd: 'systemctl is-active wazuh-indexer wazuh-dashboard', note: 'Debe mostrar «active» en las dos líneas.' }
        : u ? { where: 'vm', cmd: `systemctl is-active ${u}`, note: 'Debe mostrar «active».' } : null
    };
  }

  // ---------- servicio sin respuesta ----------
  function noresponse(ctx) {
    if (ctx.windows) {
      const w = svcWindows(ctx);
      const rdp = ctx.port === 3389;
      return {
        means: `Desde tu PC no se pudo abrir una conexión TCP a ${ctx.ip || 'la VM'}:${ctx.port} (${ctx.reason || 'sin respuesta'}).`,
        notProves: `No demuestra que el servicio ${w.label} esté detenido. Puede estar activo pero bloqueado por el firewall de Windows, escuchando solo en otra red, o el puerto puede estar filtrado. Tampoco demuestra que la VM esté caída: otros servicios de la misma máquina pueden responder.`,
        diag: [
          reachability(ctx),
          w.svc && { title: `Ver si el servicio ${w.label} está en marcha`, where: 'vm', cmd: `Get-Service ${w.svc} | Select-Object Name, Status, StartType` },
          { title: `Ver si algo escucha en el puerto ${ctx.port}`, where: 'vm', cmd: `Get-NetTCPConnection -LocalPort ${ctx.port} -State Listen -ErrorAction SilentlyContinue` },
          rdp && { title: 'Ver si el Escritorio remoto está permitido', where: 'vm', cmd: "Get-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections", note: 'fDenyTSConnections = 1 significa que las conexiones de Escritorio remoto están desactivadas.' },
          { title: 'Revisar las reglas del firewall para ese puerto', where: 'vm',
            cmd: rdp ? "Get-NetFirewallRule -DisplayGroup 'Escritorio remoto','Remote Desktop' -ErrorAction SilentlyContinue | Select-Object DisplayName, Enabled, Profile"
              : `Get-NetFirewallPortFilter -Protocol TCP | Where-Object LocalPort -eq ${ctx.port} | Get-NetFirewallRule | Select-Object DisplayName, Enabled, Profile`,
            note: 'Fíjate en el perfil (Domain, Private, Public): la red solo anfitrión suele quedar como «Public».' }
        ],
        fix: [
          rdp && { title: 'Activar el Escritorio remoto', where: 'vm', note: 'Configuración > Sistema > Escritorio remoto, o desde PowerShell como administrador:', cmd: "Set-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0", changes: true },
          w.svc && { title: `Iniciar el servicio ${w.label}`, where: 'vm', cmd: `Start-Service ${w.svc}`, changes: true, note: 'Solo si el diagnóstico mostró que estaba detenido.' },
          { title: 'Permitir el puerto en el firewall para la red del laboratorio', where: 'vm',
            cmd: rdp ? "Enable-NetFirewallRule -DisplayGroup 'Escritorio remoto'" : null, changes: true,
            note: rdp ? 'En Windows en inglés el grupo se llama «Remote Desktop». Limítalo a la red del laboratorio si puedes.' : `Crea o habilita una regla de entrada para TCP ${ctx.port}, limitada a la red del laboratorio.` },
          { title: 'Si no necesitas este servicio, deja de comprobarlo', where: 'panel', note: 'Quítalo en «Configurar» para que no genere una alerta que no aporta.' }
        ],
        verify: `Pulsa «Comprobar ahora». La alerta se cerrará cuando la conexión TCP a ${ctx.ip || 'la VM'}:${ctx.port} se acepte.`
      };
    }
    const u = svcLinux(ctx);
    const ssh = u.unit === 'ssh';
    return {
      means: `Desde tu PC no se pudo abrir una conexión TCP a ${ctx.ip || 'la VM'}:${ctx.port} (${ctx.reason || 'sin respuesta'}).`,
      notProves: 'No demuestra que el servicio esté detenido. Puede estar activo pero escuchando solo en localhost, bloqueado por el firewall o en otra interfaz. Tampoco demuestra que la VM esté caída.'
        + (ssh && /kali/i.test(ctx.vmName + ' ' + ctx.os) ? ' En Kali, SSH viene desactivado por defecto: puede que simplemente nunca se haya activado.' : ''),
      diag: [
        reachability(ctx),
        u.unit && { title: `Ver el estado del servicio ${u.unit}`, where: 'vm', cmd: `systemctl status ${u.unit} --no-pager${u.alt ? ` || systemctl status ${u.alt} --no-pager` : ''}` },
        { title: `Ver qué escucha en el puerto ${ctx.port} y en qué dirección`, where: 'vm', cmd: `sudo ss -tlnp | grep ':${ctx.port} '`, note: 'Si aparece 127.0.0.1:' + ctx.port + ', solo acepta conexiones locales.' },
        { title: 'Revisar el firewall de la VM (solo listar)', where: 'vm', cmd: 'sudo ufw status verbose 2>/dev/null || sudo nft list ruleset 2>/dev/null | head -50' },
        u.unit && { title: 'Leer los últimos registros del servicio', where: 'vm', cmd: `sudo journalctl -u ${u.unit} -n 50 --no-pager` }
      ],
      fix: [
        u.unit && { title: `Activar e iniciar ${u.unit}`, where: 'vm', cmd: `sudo systemctl enable --now ${u.unit}`, changes: true,
          note: ssh ? 'Antes, asegúrate de usar contraseñas fuertes o claves; SSH abre la máquina a conexiones remotas.' : 'Solo si el diagnóstico mostró que estaba detenido.' },
        { title: `Permitir el puerto ${ctx.port} en el firewall`, where: 'vm', cmd: `sudo ufw allow from 192.168.56.0/24 to any port ${ctx.port} proto tcp`, changes: true, note: 'Solo si usas ufw. Limítalo a la red del laboratorio.' },
        { title: 'Si no necesitas este servicio, deja de comprobarlo', where: 'panel', note: 'Quítalo en «Configurar» para que no genere una alerta que no aporta.' }
      ],
      verify: `Pulsa «Comprobar ahora». La alerta se cerrará cuando la conexión TCP a ${ctx.ip || 'la VM'}:${ctx.port} se acepte.`
    };
  }

  // ---------- VM interrumpida ----------
  function vm(ctx) {
    return {
      means: `VirtualBox marca «${ctx.vmName}» como interrumpida (estado «${ctx.vmState || 'aborted'}»): su proceso terminó de forma inesperada.`,
      notProves: 'No demuestra qué la detuvo ni que el disco virtual esté dañado. Las causas habituales son falta de memoria en el anfitrión, un cierre forzado del equipo, un error del hipervisor o falta de espacio en disco.',
      diag: [
        { title: 'Confirmar el estado y la hora del último cambio', where: 'pc', cmd: `& "$env:ProgramFiles\\Oracle\\VirtualBox\\VBoxManage.exe" showvminfo ${q(ctx.vmName)} --machinereadable | Select-String 'VMState'` },
        { title: 'Leer el final del registro de VirtualBox de esa VM', where: 'pc', cmd: `& "$env:ProgramFiles\\Oracle\\VirtualBox\\VBoxManage.exe" showvminfo ${q(ctx.vmName)} --log 0 | Select-Object -Last 60`, note: 'Busca «Guru Meditation», «out of memory», «VERR_» o el último mensaje antes del corte.' },
        { title: 'Comprobar el espacio libre en el disco del anfitrión', where: 'pc', cmd: 'Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, @{n="LibreGB";e={[int]($_.SizeRemaining/1GB)}}, @{n="TotalGB";e={[int]($_.Size/1GB)}}' },
        { title: 'Comprobar la memoria libre del anfitrión', where: 'pc', cmd: 'Get-CimInstance Win32_OperatingSystem | Select-Object @{n="LibreMB";e={[int]($_.FreePhysicalMemory/1KB)}}, @{n="TotalMB";e={[int]($_.TotalVisibleMemorySize/1KB)}}', note: 'Compáralo con la RAM asignada a la VM antes de volver a encenderla.' },
        { title: 'Revisar la tendencia de memoria del equipo', where: 'panel', note: 'En los detalles de «Equipo principal» > Tendencia guardada, mira si la memoria estaba al límite.' }
      ],
      fix: [
        { title: 'Liberar recursos antes de arrancarla', where: 'pc', note: 'Cierra programas o guarda otras VM si la memoria del equipo está alta.', changes: true },
        { title: 'Iniciar la VM desde VirtualBox', where: 'vbox', note: 'Hazlo tú desde la ventana de VirtualBox para ver cualquier mensaje de error. Si vuelve a fallar, conserva el registro antes de cambiar nada.', changes: true },
        { title: 'Si no la usas, apágala por completo', where: 'vbox', note: 'Una VM apagada no genera esta alerta.', changes: true }
      ],
      verify: 'Pulsa «Comprobar ahora». La alerta se cerrará cuando VirtualBox informe un estado distinto de «aborted» (encendida, guardada o apagada).'
    };
  }

  function noip(ctx) {
    return {
      means: `«${ctx.vmName}» está encendida, pero este equipo no ve ninguna IP suya: ni la informa la propia VM, ni hay concesión DHCP de VirtualBox, ni aparece en la tabla ARP.`,
      notProves: 'No demuestra que la VM no tenga red. Puede tener una IP fija sin tráfico reciente, no tener Guest Additions, o estar solo en una red interna o NAT que este equipo no ve.',
      diag: [
        { title: 'Ver las direcciones IP dentro de la VM', where: 'vm', cmd: ctx.windows ? 'ipconfig' : 'ip -brief address' },
        { title: 'Ver qué adaptadores tiene en VirtualBox', where: 'panel', note: 'En los detalles de la máquina, sección «Red».' },
        { title: 'Comprobar la tabla ARP de tu PC', where: 'pc', cmd: 'arp -a | Select-String "192.168.56."' }
      ],
      fix: [
        { title: 'Instalar las Guest Additions (o virtualbox-guest-utils en Linux)', where: 'vm', cmd: ctx.windows ? null : 'sudo apt install virtualbox-guest-utils', changes: true, note: 'Permite que la VM informe su IP exacta a VirtualBox.' },
        { title: 'Si debe tener IP en la red solo anfitrión, revisar su configuración de red', where: 'vm', changes: true }
      ],
      verify: 'Pulsa «Comprobar ahora». La alerta se cerrará cuando el panel vea una IP de la VM.'
    };
  }

  function resources(ctx) {
    const mem = /memoria/i.test(ctx.alertText);
    return {
      means: `${mem ? 'La memoria' : 'La CPU'} de tu equipo lleva varios minutos por encima del umbral configurado.`,
      notProves: 'No demuestra que una VM concreta sea la causa ni que haya un problema: el sistema puede estar usando memoria para caché. Tampoco indica qué cerrar.',
      diag: [
        { title: 'Ver la tendencia en el panel', where: 'panel', note: 'Detalles de «Equipo principal» > Tendencia guardada (1 h / 24 h). ¿Es un pico o algo sostenido?' },
        { title: 'Ver cuánto ocupa cada VM', where: 'panel', note: 'Pasa el ratón sobre cada VM encendida: «Memoria» es la RAM de tu PC que ocupa.' },
        mem
          ? { title: 'Listar los procesos que más memoria usan', where: 'pc', cmd: 'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 Name, Id, @{n="MB";e={[int]($_.WorkingSet64/1MB)}}' }
          : { title: 'Medir qué procesos usan más CPU ahora (durante 5 segundos)', where: 'pc',
              cmd: `$n = [Environment]::ProcessorCount; $a = @{}; Get-Process | ForEach-Object { $a[$_.Id] = [double]$_.CPU }; Start-Sleep 5; Get-Process | Where-Object { $a.ContainsKey($_.Id) } | ForEach-Object { [pscustomobject]@{ Proceso = $_.Name; Id = $_.Id; 'CPU %' = [math]::Round((([double]$_.CPU - $a[$_.Id]) / 5 / $n) * 100, 1) } } | Sort-Object 'CPU %' -Descending | Select-Object -First 12`,
              note: 'Mide el uso durante un intervalo y lo expresa como % de la CPU total de tu PC. No se usa «Sort-Object CPU» porque esa propiedad es el tiempo de procesador acumulado desde que arrancó cada proceso, no el uso actual. Cada «VirtualBoxVM» es una VM: el panel indica cuál al pasar el ratón sobre ella.' }
      ],
      fix: [
        { title: 'Cerrar programas que no uses o guardar VM que no necesites ahora', where: 'pc', changes: true, note: 'Decide tú qué cerrar a partir de la lista; no cierres procesos del sistema.' },
        { title: 'Reducir la RAM asignada a alguna VM', where: 'vbox', changes: true, note: 'Con la VM apagada, en su configuración de VirtualBox.' },
        { title: 'Ajustar el umbral si este nivel es normal para tu equipo', where: 'panel', note: 'En «Configurar» > Memoria del equipo.' }
      ],
      verify: 'Pulsa «Comprobar ahora». La alerta se cerrará cuando el valor medido baje del umbral.'
    };
  }

  function config(ctx) {
    return {
      means: 'El servidor no pudo leer servicios.json, así que usa valores por defecto.',
      notProves: 'No afecta a tus máquinas: solo a qué se comprueba y cuándo se avisa.',
      diag: [{ title: 'Ver el error exacto', where: 'panel', note: ctx.alertText }],
      fix: [{ title: 'Corregir el JSON o restaurar una copia de data/copias-config/', where: 'pc', changes: true }],
      verify: 'Pulsa «Comprobar ahora». La alerta desaparece cuando el archivo vuelve a ser válido.'
    };
  }

  const BY_CAT = { http5xx, noresponse, vm, noip, resources, config };

  root.NEXO_GUIAS = function guide(ctx) {
    const g = (BY_CAT[ctx.cat] || config)(ctx);
    const keep = (list) => list.filter(Boolean);
    return { ...g, diag: keep(g.diag), fix: keep(g.fix) };
  };
  root.NEXO_GUIAS.WHERE = {
    pc: 'En tu PC (PowerShell)',
    vm: 'Dentro de la VM',
    vbox: 'En VirtualBox',
    panel: 'En este panel'
  };
})(typeof self !== 'undefined' ? self : this);
