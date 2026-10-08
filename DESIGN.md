# Nexo Lab · dirección de diseño

Consola de operaciones para un laboratorio doméstico. Debe parecer una herramienta profesional: limpia, precisa y fácil de leer bajo presión. No copia logos, textos ni pantallas de ningún producto.

## Referencias (solo como criterio, no como modelo a copiar)
- **Claridad y orden** (estilo de las herramientas modernas de gestión): navegación lateral compacta y agrupada, paneles con borde fino en lugar de sombras, tipografía pequeña y jerarquía clara.
- **Acciones rápidas** (estilo lanzador de comandos): paleta `Ctrl + K` para ir a secciones, máquinas y guías. Solo navega y abre; nunca ejecuta acciones que cambien el laboratorio.
- **Métricas sobrias** (estilo paneles de observabilidad): paneles de estadística con etiqueta en mayúsculas, número grande tabular y unidad; gráficas con ejes (0–100 %, ventana de tiempo).

## Sistema
- **Paleta neutral** con un acento (azul índigo) y colores de estado fijos en todo el panel:
  - verde: encendida o responde;
  - violeta: en pausa o guardada;
  - gris: apagada o sin comprobar;
  - ámbar: advertencia;
  - rojo: crítica o no responde.
- **Severidad de alertas:** crítica (un servicio no responde o devuelve 5xx), advertencia (VM interrumpida, sin IP, recursos) e información (configuración). La severidad colorea la barra lateral, el icono y la etiqueta.
- **Datos técnicos** (IP, horas, porcentajes, comandos) en monoespaciada con cifras tabulares.
- **Radios:** 7 px en controles y 10 px en paneles. Botones de 32 px de alto (40 px en táctil).
- **Temas:** claro y oscuro según el sistema; el modo de alto contraste refuerza bordes y texto secundario.
- **Movimiento:** solo transiciones cortas de color y la entrada de hojas; todo se desactiva con «reducir movimiento».

## Distribución
- **Monitoreo:** Resumen, Alertas, Máquinas, Red y Actividad.
- **Operaciones:** Control, en un recuadro naranja separado de la lectura. Una futura sección de Directorio iría aquí. No se muestra hasta que exista.
- **Detalle de máquina:** panel lateral derecho en escritorio y hoja inferior en móvil.
- **Móvil:** la barra lateral pasa a barra inferior y las acciones de cada alerta bajan a su propia fila.
