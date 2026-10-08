// Panel Nexo Lab.
// Fuente principal: /api/estado (server.py lee VirtualBox y comprueba servicios en solo lectura).
// Si no responde, usa js/data.js (demo) y lo dice. Todo texto que viene de los datos se inserta con textContent.
(function () {
  'use strict';

  const DEMO = window.NEXO_DATA;
  const POLL_MS = 10000;
  // Versión de los archivos que cargó esta página (parámetro ?v= de su <script>); el servidor informa de la actual.
  const UI_V = (() => { try { return new URL(document.currentScript.src).searchParams.get('v') || '?'; } catch (e) { return '?'; } })();
  const RT_MS = 1000;
  const SERIES_LEN = 60;
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';

  // ---------- utilidades de DOM ----------
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v; else n.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false || kid === '') continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }
  const clean = (list) => list.flat(Infinity).filter((x) => x != null && x !== false && x !== '');

  const PATHS = {
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
    clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
    monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
    check: 'M20 6 9 17l-5-5',
    power: 'M12 3v9M6.3 6.8a8 8 0 1 0 11.4 0',
    pause: 'M9 5v14M15 5v14',
    warn: 'M12 4 2.5 20h19zM12 10v4M12 17h.01',
    x: 'M6 6l12 12M18 6 6 18',
    minus: 'M6 12h12',
    chevron: 'M9 6l6 6-6 6',
    info: 'M12 16v-4M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
    net: 'M12 3v6M5 21v-4h14v4M12 9v8M8 3h8',
    pulse: 'M3 12h4l3-7 4 14 3-7h4',
    note: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
    book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7M8 11h5',
    copy: 'M9 9h11v11H9zM5 15V4h11'
  };
  function icon(name, cls) {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', PATHS[name]);
    s.append(p);
    return s;
  }

  // ---------- vocabulario ----------
  const STATES = {
    running: { label: 'Encendida', icon: 'check', plural: 'Encendidas', hint: 'En ejecución' },
    paused: { label: 'En pausa', icon: 'pause', plural: 'En pausa', hint: 'Guardada o pausada: al iniciarla vuelve donde estaba' },
    stopped: { label: 'Apagada', icon: 'power', plural: 'Apagadas', hint: 'Apagada por completo' },
    alert: { label: 'Con problemas', icon: 'warn', plural: 'Con problemas', hint: 'Interrumpida, bloqueada o con alertas' }
  };
  const VBOX_STATES = {
    running: ['running', 'Encendida'], paused: ['paused', 'Pausada'], saved: ['paused', 'Guardada'],
    poweroff: ['stopped', 'Apagada'], aborted: ['alert', 'Interrumpida'], aborted_saved: ['alert', 'Interrumpida'], 'aborted-saved': ['alert', 'Interrumpida'],
    stuck: ['alert', 'Bloqueada'], gurumeditation: ['alert', 'Error grave'],
    starting: ['running', 'Iniciando'], stopping: ['running', 'Apagándose'], saving: ['running', 'Guardando'],
    restoring: ['paused', 'Restaurando']
  };
  const SVC = {
    up: { label: 'Responde', icon: 'check' },
    down: { label: 'No responde', icon: 'x' },
    pending: { label: 'Arrancando', icon: 'clock' },
    unchecked: { label: 'Sin comprobar', icon: 'minus' }
  };
  const NIC = { nat: 'NAT', natnetwork: 'Red NAT', hostonly: 'Solo anfitrión', hostonlynet: 'Solo anfitrión', bridged: 'Puente', intnet: 'Red interna', generic: 'Genérico' };
  const NET_HELP = {
    nat: 'Cada VM sale a internet a través de este equipo. Son redes separadas: las VM no se ven entre sí por NAT y este equipo no puede entrar a ellas por aquí.',
    natnetwork: 'Red NAT compartida: las VM conectadas se ven entre sí y salen a internet a través de este equipo.',
    hostonly: 'Red privada entre este equipo y las VM. Es la que usa el panel para comprobar servicios.',
    bridged: 'La VM aparece en tu red física como un equipo más.',
    intnet: 'Solo se ven entre sí las VM conectadas. Este equipo no tiene acceso, así que no puede comprobar sus servicios.'
  };
  const IP_ORIGIN = {
    guest: 'Informada por la propia VM (Guest Additions)',
    dhcp: 'Concesión del DHCP de VirtualBox (la VM no tiene Guest Additions completas)',
    arp: 'Tabla ARP de este equipo (puede estar desactualizada)'
  };
  // Tipo de alerta: etiqueta breve, icono y color coherentes en todo el panel.
  // sev: severidad visible en la interfaz (crítica: un servicio no está disponible; advertencia: requiere revisión).
  const ALERT_CAT = {
    http5xx: { label: 'Error 5xx', icon: 'x', cls: 'c-err', sev: 'crit', hint: 'La aplicación responde, pero con un error del servidor' },
    noresponse: { label: 'Sin respuesta', icon: 'minus', cls: 'c-warn', sev: 'crit', hint: 'El servicio no aceptó la conexión o no contestó' },
    vm: { label: 'VM interrumpida', icon: 'power', cls: 'c-err', sev: 'warn', hint: 'VirtualBox la marca como interrumpida o bloqueada' },
    noip: { label: 'Sin IP', icon: 'net', cls: 'c-warn', sev: 'warn', hint: 'Encendida, pero sin IP visible desde este equipo' },
    resources: { label: 'Recursos del equipo', icon: 'pulse', cls: 'c-res', sev: 'warn', hint: 'Memoria o CPU del PC por encima del umbral' },
    config: { label: 'Configuración', icon: 'info', cls: 'c-gray', sev: 'info', hint: 'Problema al leer servicios.json' }
  };
  const SEV = { crit: 'Crítica', warn: 'Advertencia', info: 'Información' };
  const ACT = { gap: ['minus', 'Sin datos'], alert: ['warn', 'Problema'], on: ['check', 'Encendida'], off: ['power', 'Apagada'], pause: ['pause', 'En pausa'], info: ['info', 'Información'], svcup: ['check', 'Servicio'], svcdown: ['x', 'Servicio'] };

  const fmtDate = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtFull = new Intl.DateTimeFormat('es', { dateStyle: 'long', timeStyle: 'short' });
  const fmtTime = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
  const pct = (v) => v + ' %';
  const fmtNum = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });
  const gb = (v) => fmtNum.format(v) + ' GB';
  function ago(date) {
    const s = Math.round((date - Date.now()) / 1000);
    const a = Math.abs(s);
    if (a < 60) return rtf.format(s, 'second');
    if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
  }
  function dur(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return 'menos de 1 min';
    if (m < 60) return m + ' min';
    const hrs = Math.floor(m / 60);
    if (hrs < 24) return hrs + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    return Math.floor(hrs / 24) + ' d' + (hrs % 24 ? ' ' + (hrs % 24) + ' h' : '');
  }

  // ---------- estado de la interfaz ----------
  const state = {
    filter: 'all', group: 'all', query: '', view: 'cards', open: null,
    source: 'loading', error: null, fetchedAt: null, vboxVersion: '', localIps: [],
    machines: [], alerts: [], vboxActivity: [], history: [], track: new Map(),
    rt: null, series: new Map(),  // métricas en tiempo real y últimos 60 s por máquina
    events: [], ajustes: {}, histInfo: null, docs: new Map(), trendHours: 24,
    netView: 'map', expanded: new Set(), hist: { maquina: '', tipo: '', horas: '' }, histFiltered: null
  };
  const byId = (id) => state.machines.find((m) => m.id === id);
  const isLive = () => state.source === 'live' || state.source === 'stale';

  const qs = new URLSearchParams(location.search);
  if (STATES[qs.get('estado')]) state.filter = qs.get('estado');
  if (qs.get('vista') === 'lista') state.view = 'list';
  if (qs.get('grupo')) state.group = qs.get('grupo').slice(0, 40);
  state.query = (qs.get('q') || '').slice(0, 80);
  state.open = qs.get('m');
  function syncUrl() {
    const p = new URLSearchParams();
    if (state.filter !== 'all') p.set('estado', state.filter);
    if (state.group !== 'all') p.set('grupo', state.group);
    if (state.query) p.set('q', state.query);
    if (state.view === 'list') p.set('vista', 'lista');
    if (state.open) p.set('m', state.open);
    history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : '') + location.hash);
  }

  // ---------- normalización ----------
  const svcFromApi = (s) => ({ ...s, checkedAt: s.checkedAt ? new Date(s.checkedAt) : null });
  const vboxVer = (v) => v.replace(/r\d+$/, '');

  function fromApi(d) {
    const host = d.host;
    const machines = [{
      id: 'host', name: host.name, kind: 'host', os: host.os, ips: [], state: 'running', stateLabel: 'Encendido',
      stateRaw: null, since: null, platform: 'Anfitrión · VirtualBox ' + vboxVer(d.vboxVersion),
      vcpu: host.vcpu, ramGB: host.ramGB, diskGB: host.diskGB, cpu: host.cpu, mem: host.mem, disk: host.disk,
      nics: [], services: [], group: host.group, tags: host.tags || []
    }];
    for (const v of d.vms) {
      const [group, label] = VBOX_STATES[v.state] || ['alert', 'Estado desconocido (' + v.state + ')'];
      machines.push({
        id: v.id, name: v.name, kind: 'vm', os: v.os, state: group, stateLabel: label, stateRaw: v.state,
        ips: v.ips.length ? v.ips : (v.ipsHost || []).map((x) => x.ip),
        ipOrigin: v.ips.length ? 'guest' : (v.ipsHost || [])[0]?.origin,
        since: v.since ? new Date(v.since.replace(/(\.\d{3})\d*$/, '$1') + 'Z') : null,
        platform: 'VirtualBox ' + vboxVer(d.vboxVersion), vcpu: v.vcpu, ramGB: v.ramMB / 1024, cpu: null, mem: null, disk: null,
        nics: v.nics, services: (v.services || []).map(svcFromApi), group: v.group, tags: v.tags || [], booting: v.booting,
        checkedIp: v.checkedIp,
        note: group === 'alert' ? 'Se cerró de forma inesperada o no responde' : null
      });
    }
    return machines;
  }

  function fromDemo() {
    const map = { ok: 'up', warn: 'pending', down: 'down' };
    return DEMO.machines.map((m) => ({
      ...m, ips: [m.ip], stateLabel: STATES[m.state].label, since: null, nics: [], group: m.kind === 'host' ? 'Equipo principal' : 'Ejemplo', tags: [],
      services: m.services.map((s) => ({ name: s.name, port: s.port, status: map[s.status], reason: 'Dato de ejemplo', checkedAt: null }))
    }));
  }

  // Historial guardado por server.py en SQLite (datos/nexo-historial.db).
  const vbLabel = (raw) => (raw ? (VBOX_STATES[raw] || [null, raw])[1] : '?');
  const svcLabel = (st) => (SVC[st] ? SVC[st].label : st || '?');
  function fromEvents(events) {
    return (events || []).map((e) => {
      const base = { when: new Date(e.ts), machine: e.machine, name: e.name, duration: e.durationS != null ? e.durationS * 1000 : null };
      if (e.tipo === 'estado') {
        const g = (VBOX_STATES[e.after] || ['alert'])[0];
        return { ...base, kind: 'estado', type: { running: 'on', paused: 'pause', stopped: 'off', alert: 'alert' }[g],
          text: `${e.name}: ${vbLabel(e.before).toLowerCase()} → ${vbLabel(e.after).toLowerCase()}`, detail: e.detail };
      }
      if (e.tipo === 'servicio') {
        const [svc, ...rest] = (e.detail || '').split(': ');
        return { ...base, kind: 'servicio', type: e.after === 'up' ? 'svcup' : 'svcdown',
          text: `${e.name} · ${svc}: ${svcLabel(e.before).toLowerCase()} → ${svcLabel(e.after).toLowerCase()}`, detail: rest.join(': ') };
      }
      if (e.tipo === 'sin_datos') return { ...base, kind: 'sin_datos', type: 'gap', text: e.after, detail: e.detail };
      if (e.tipo === 'alerta') return { ...base, kind: 'alerta', type: 'alert', text: e.after, detail: 'Comprobado: ' + (e.detail || '') };
      return { ...base, kind: 'resuelta', type: 'svcup', text: e.after, detail: e.detail };
    });
  }

  // Devuelve true si se leyó el estado actual y false si falló (en ese caso se conservan los datos anteriores).
  // force: ignora la caché de 3 s del servidor y vuelve a comprobar todo.
  async function load(manual, force) {
    let ok = false;
    try {
      if (location.protocol === 'file:') throw new Error('abierto como archivo: inicia el panel con iniciar.bat');
      const r = await fetch('/api/estado' + (force ? '?forzar=1' : ''), { cache: 'no-store' });
      if (!(r.headers.get('content-type') || '').includes('json')) {
        throw new Error('el servidor abierto no es server.py; cierra la ventana anterior de iniciar.bat y vuelve a abrirlo');
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'el servicio local respondió con un error');
      state.machines = fromApi(d);
      state.alerts = (d.alerts || []).map((a) => ({ ...a, at: a.at ? new Date(a.at) : null }));
      state.localIps = d.localIps || [];
      state.vboxActivity = state.machines.filter((m) => m.since).sort((a, b) => b.since - a.since).map((m) => ({
        when: m.since, machine: m.id, type: { running: 'on', paused: 'pause', stopped: 'off', alert: 'alert' }[m.state],
        text: `${m.name}: ${m.stateLabel.toLowerCase()}`
      }));
      applyRt();
      state.events = fromEvents(d.events);
      state.ajustes = d.ajustes || {};
      state.histInfo = d.history || null;
      state.source = 'live';
      state.uiOutdated = !!(d.assets && d.assets.version && UI_V !== '?' && String(d.assets.version) !== String(UI_V));
      state.uiServer = d.assets ? String(d.assets.version) : null;
      state.vboxVersion = vboxVer(d.vboxVersion);
      state.fetchedAt = new Date();
      state.error = null;
      ok = true;
      if (manual) toast('Leído de VirtualBox y servicios comprobados a las ' + fmtTime.format(state.fetchedAt) + '.');
    } catch (err) {
      state.error = err.message;
      if (isLive()) {
        state.source = 'stale';
      } else {
        state.source = 'demo';
        state.machines = fromDemo();
        state.alerts = [];
        state.events = [];
        state.vboxActivity = DEMO.activity.map((a) => ({ ...a, when: null }));
      }
      if (manual) toast('No se pudo leer VirtualBox: ' + err.message);
    }
    render();
    return ok;
  }

  // ---------- componentes ----------
  const pill = (m) => h('span', { class: 'pill s-' + m.state }, icon(STATES[m.state].icon), m.stateLabel);
  const kindIcon = (m, big) => h('span', { class: 'kind k-' + m.state + (big ? ' big' : '') }, icon(m.kind === 'host' ? 'monitor' : 'server'));
  const ipText = (m) => m.ips && m.ips.length ? m.ips.join(', ')
    : m.kind === 'host' ? 'Este equipo' : m.state === 'running' ? 'IP no disponible' : 'Sin IP (no está encendida)';
  const nicLabel = (n) => (NIC[n.type] || n.type) + (n.type === 'intnet' && n.target ? ' «' + n.target + '»' : '');
  const svcChip = (s, m) => h('li', { class: 'svc v-' + s.status, title: s.reason || '' },
    icon(SVC[s.status].icon), s.name, h('span', { class: 'vh' }, `: ${SVC[s.status].label.toLowerCase()}` + (m ? ` en ${m.name}` : '')));

  // live = { id, k } enlaza el medidor con las métricas en tiempo real (se actualiza sin redibujar).
  function meter(label, value, detail, live) {
    const el = h('div', { class: 'meter', 'data-m-id': live && live.id, 'data-m-k': live && live.k },
      h('div', { class: 'meter-top' },
        h('span', { class: 'meter-l' }, label),
        h('span', { class: 'meter-v' }, h('span', { class: 'mv' }), h('span', { class: 'meter-d' }))),
      h('div', { class: 'track', 'aria-hidden': 'true' }, h('div', { class: 'fill' })));
    setMeter(el, value, detail);
    return el;
  }
  function setMeter(el, value, detail) {
    const has = value != null;
    // CSSOM: permitido por la CSP (el atributo style en línea no). transform es más barato que width.
    el.querySelector('.fill').style.transform = 'scaleX(' + (has ? Math.min(value, 100) / 100 : 0) + ')';
    el.classList.toggle('hot', has && value >= 90);
    el.classList.toggle('warn', has && value >= 75 && value < 90);
    el.querySelector('.mv').textContent = has ? pct(Math.round(value)) : 'Sin datos';
    el.querySelector('.meter-d').textContent = detail ? ' ' + detail : '';
  }

  // ---------- tiempo real ----------
  const memText = (m) => m.kind === 'host'
    ? (m.memUsedGB != null ? `${gb(m.memUsedGB)} de ${gb(m.memTotalGB)}` : '')
    : (m.memMB != null ? `${gb(m.memMB / 1024)} de ${gb(m.ramGB)}` : '');
  const cpuText = (m) => (m.kind === 'vm' && m.cpu != null ? 'del equipo' : '');
  const liveOn = (m) => isLive() && (m.kind === 'host' || m.state === 'running');
  const ioText = (b) => (b == null ? 'No disponible' : b < 1024 ? b + ' B/s' : b < 1048576 ? Math.round(b / 1024) + ' KB/s' : fmtNum.format(b / 1048576) + ' MB/s');

  function spark(id, k, w, hgt, cls) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'spark ' + (cls || '') + ' k-' + k);
    svg.setAttribute('aria-hidden', 'true');
    svg.dataset.sId = id; svg.dataset.sK = k; svg.dataset.w = w; svg.dataset.h = hgt;
    for (const c of ['area', 'line']) {
      const el = document.createElementNS(SVG, c === 'area' ? 'polygon' : 'polyline');
      el.setAttribute('class', c);
      svg.append(el);
    }
    drawSpark(svg);
    return svg;
  }
  function drawSpark(svg) {
    const data = (state.series.get(svg.dataset.sId) || {})[svg.dataset.sK] || [];
    const w = +svg.dataset.w, hg = +svg.dataset.h;
    const pts = data.map((v, i) => [w - (data.length - 1 - i) * (w / (SERIES_LEN - 1)), hg - (Math.min(v, 100) / 100) * (hg - 2) - 1]);
    const line = pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    svg.querySelector('.line').setAttribute('points', line);
    svg.querySelector('.area').setAttribute('points', pts.length ? `${pts[0][0].toFixed(1)},${hg} ${line} ${pts[pts.length - 1][0].toFixed(1)},${hg}` : '');
  }

  function applyRt() {
    const rt = state.rt;
    if (!rt) return;
    for (const m of state.machines) {
      if (m.kind === 'host') {
        if (rt.host.cpu != null) m.cpu = rt.host.cpu;
        m.mem = rt.host.mem; m.memUsedGB = rt.host.memUsedGB; m.memTotalGB = rt.host.memTotalGB;
        continue;
      }
      const r = rt.vms[m.id.toLowerCase()];
      if (r && m.state === 'running') {
        m.cpu = r.cpu; m.memMB = r.memMB; m.io = r.ioBps;
        m.mem = m.ramGB ? Math.min(100, (r.memMB / (m.ramGB * 1024)) * 100) : null;
      } else if (isLive()) {
        m.cpu = m.mem = m.memMB = m.io = null;
      }
    }
  }

  function updateLive() {
    document.querySelectorAll('.meter[data-m-id]').forEach((el) => {
      const m = byId(el.dataset.mId);
      if (!m) return;
      const k = el.dataset.mK;
      setMeter(el, m[k], k === 'mem' ? memText(m) : cpuText(m));
    });
    document.querySelectorAll('svg.spark[data-s-id]').forEach(drawSpark);
    document.querySelectorAll('[data-io-id]').forEach((el) => { const m = byId(el.dataset.ioId); if (m) el.textContent = ioText(m.io); });
    document.querySelectorAll('[data-rt-at]').forEach((el) => { el.textContent = state.rt ? '· medido a las ' + fmtTime.format(new Date(state.rt.at)) : ''; });
  }

  let rtBusy = false;
  async function pollMetrics() {
    if (rtBusy || document.hidden || !isLive()) return;
    rtBusy = true;
    try {
      const r = await fetch('/api/metricas', { cache: 'no-store' });
      if (!r.ok) throw new Error('métricas no disponibles');
      state.rt = await r.json();
      applyRt();
      for (const m of state.machines) {
        if (!liveOn(m) || m.cpu == null) continue;
        const sr = state.series.get(m.id) || { cpu: [], mem: [] };
        sr.cpu.push(m.cpu); sr.mem.push(m.mem ?? 0);
        if (sr.cpu.length > SERIES_LEN) { sr.cpu.shift(); sr.mem.shift(); }
        state.series.set(m.id, sr);
      }
      updateLive();
    } catch { /* la siguiente lectura completa (cada 10 s) informará si se perdió la conexión */ }
    rtBusy = false;
  }

  const specs = (m) => h('p', { class: 'specs' },
    h('span', null, h('b', null, m.vcpu), m.kind === 'host' ? ' núcleos' : ' vCPU'),
    h('span', null, h('b', null, gb(m.ramGB)), ' RAM'),
    m.since && h('span', { class: 'since' }, m.stateLabel + ' ' + ago(m.since)));

  const tagLine = (m) => (m.group || m.tags.length) && h('p', { class: 'tags' },
    m.group && h('span', { class: 'tag-group' }, m.group), m.tags.map((t) => h('span', { class: 'tag' }, t)));

  const opener = (m) => h('button', { type: 'button', class: 'hit', 'data-open': m.id, 'aria-haspopup': 'dialog' },
    m.name, h('span', { class: 'vh' }, ', ver detalles'));
  const hasUsage = (m) => liveOn(m) || !isLive();
  const ORIGIN_CPU = { host: 'CPU total de este equipo, medida cada segundo', vm: 'Parte de la CPU de tu PC que usa esta VM (proceso VirtualBoxVM.exe). No es la CPU vista dentro del sistema invitado.' };
  const ORIGIN_MEM = { host: 'Memoria RAM de este equipo en uso', vm: 'RAM de tu PC ocupada por esta VM, sobre la asignada. No es el uso de memoria dentro del sistema invitado.' };
  // En la vista grande la gráfica lleva ejes: porcentaje (0-100 %) y ventana de los últimos 60 s.
  const withAxes = (svg) => h('div', { class: 'chart' },
    h('div', { class: 'y-ax', 'aria-hidden': 'true' }, h('span', null, '100 %'), h('span', null, '50 %'), h('span', null, '0 %')), svg,
    h('div', { class: 'x-ax', 'aria-hidden': 'true' }, h('span', null, 'hace 60 s'), h('span', null, 'ahora')));
  const sparkFor = (m, k, big) => liveOn(m) && (big ? withAxes(spark(m.id, k, 120, 48)) : spark(m.id, k, 120, 26));
  const perf = (m, big) => h('div', { class: 'perf' + (big ? ' big' : '') },
    h('div', { class: 'perf-item', title: ORIGIN_CPU[m.kind] }, meter('CPU', m.cpu, cpuText(m), { id: m.id, k: 'cpu' }), sparkFor(m, 'cpu', big)),
    h('div', { class: 'perf-item', title: ORIGIN_MEM[m.kind] }, meter('Memoria', m.mem, memText(m), { id: m.id, k: 'mem' }), sparkFor(m, 'mem', big)));

  function card(m) {
    return h('article', { class: 'machine st-' + m.state },
      h('header', null, kindIcon(m),
        h('div', { class: 'ident' }, h('h3', null, opener(m)), h('p', null, m.os)),
        pill(m)),
      tagLine(m),
      hasUsage(m) ? perf(m) : specs(m),
      m.services.length > 0 && h('ul', { class: 'svcs', 'aria-label': 'Servicios de ' + m.name }, m.services.map((s) => svcChip(s, m))),
      h('footer', null,
        h('span', { class: 'ip mono', translate: 'no' }, ipText(m)),
        m.note ? h('span', { class: 'note' }, icon('warn'), m.note) : h('span', { class: 'more' }, 'Detalles', icon('chevron'))));
  }

  function svcSummary(m) {
    if (!m.services.length) return h('span', { class: 'cell-text' }, 'Ninguno');
    const up = m.services.filter((s) => s.status === 'up').length;
    const checked = m.services.filter((s) => s.status === 'up' || s.status === 'down').length;
    return checked
      ? h('span', { class: 'cell-text svc-count' + (up < checked ? ' bad' : '') }, `${up} de ${checked} responden`)
      : h('span', { class: 'cell-text' }, 'Sin comprobar');
  }

  function row(m) {
    return h('div', { class: 'row st-' + m.state, role: 'row' },
      h('div', { class: 'r-name', role: 'cell' }, kindIcon(m),
        h('div', { class: 'ident' }, h('h3', null, opener(m)), h('p', null, m.group ? m.group + ' · ' + m.os : m.os))),
      h('div', { class: 'r-state', role: 'cell' }, pill(m)),
      h('div', { class: 'r-ip mono', role: 'cell', translate: 'no' }, ipText(m)),
      h('div', { class: 'r-svc', role: 'cell' }, svcSummary(m)),
      h('div', { class: 'r-meter', role: 'cell' }, hasUsage(m) ? meter('CPU', m.cpu, '', { id: m.id, k: 'cpu' }) : h('span', { class: 'cell-text' }, m.vcpu + ' vCPU · ' + gb(m.ramGB))),
      h('div', { class: 'r-go', role: 'cell' }, icon('chevron')));
  }

  // ---------- documentar evento: nota Markdown compatible con Obsidian ----------
  // El panel solo rellena hechos observados; el diagnóstico lo escribe la persona.
  let docSeq = 0;
  function docButton(src) {
    const id = 'd' + (++docSeq);
    state.docs.set(id, src);
    return h('button', { type: 'button', class: 'doc-btn', 'data-doc': id, 'aria-haspopup': 'dialog', title: 'Preparar una nota para Obsidian' },
      icon('note'), h('span', null, 'Documentar'), h('span', { class: 'vh' }, ': ' + src.title));
  }
  const slug = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'evento';
  const yaml = (t) => '"' + String(t ?? '').replace(/["\\]/g, '\\$&') + '"';
  function isoLocal(d) {
    const pad = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      + `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  }
  function buildNote(src) {
    const m = src.machine ? state.machines.find((x) => x.id.toLowerCase() === String(src.machine).toLowerCase()) : null;
    const when = src.when || new Date();
    const name = m ? m.name : 'Laboratorio';
    const svcs = m && m.services.length ? m.services.map((x) => `${x.name} (${x.port}): ${SVC[x.status].label.toLowerCase()}`).join(' · ') : null;
    const lines = [
      '---',
      `fecha: ${isoLocal(when)}`,
      `maquina: ${yaml(name)}`,
      `tipo: ${src.kind}`,
      'estado: abierto',
      `tags: [homelab, nexo-lab, ${src.kind}${m ? ', vm/' + slug(m.name) : ''}]`,
      'fuente: "Nexo Lab"',
      '---',
      '',
      `# ${src.title}`,
      '',
      '## Qué detectó el panel',
      `- **Fecha:** ${fmtFull.format(when)}`,
      `- **Máquina:** ${m ? `[[${m.name}]]` : 'No asociada a una máquina'}${m && m.group ? ` (${m.group}${m.tags.length ? ': ' + m.tags.join(', ') : ''})` : ''}`,
      `- **Evento:** ${src.title}`,
      src.detail ? `- **Evidencia:** ${src.detail}` : null,
      '',
      '## Contexto al documentar',
      `- **Hora de la nota:** ${fmtFull.format(new Date())}`,
      m && m.stateRaw ? `- **Estado en VirtualBox:** ${m.stateLabel} (${m.stateRaw})${m.since ? ', desde ' + fmtFull.format(m.since) : ''}` : null,
      m ? `- **IP:** ${ipText(m)}` : null,
      svcs ? `- **Servicios:** ${svcs}` : null,
      m && m.cpu != null ? `- **Uso medido desde el equipo:** CPU ${Math.round(m.cpu)} %, memoria ${memText(m) || Math.round(m.mem) + ' %'}` : null,
      '',
      src.guide ? '## Interpretación prudente (guía del panel)' : null,
      src.guide ? `- **Qué significa:** ${src.guide.means}` : null,
      src.guide ? `- **Qué no demuestra:** ${src.guide.notProves}` : null,
      src.guide ? '' : null,
      '## Diagnóstico',
      '> Pendiente. Escribe aquí qué revisaste y qué encontraste. El panel no deduce causas.',
      '',
      '## Pasos realizados',
      ...(src.guide ? src.guide.diag.map((st) => `- [ ] ${st.title}${st.cmd ? ': `' + st.cmd.replace(/`/g, "'") + '`' : ''}`) : ['- [ ] ']),
      '',
      '## Resolución',
      ...(src.guide ? ['- Corrección aplicada (manual): ', `- Verificación: ${src.guide.verify}`] : ['- ']),
      '',
      '## Relacionado',
      `- [[Nexo Lab]]${m ? ` · [[${m.name}]]` : ''}`,
      ''
    ];
    const pad = (n) => String(n).padStart(2, '0');
    const file = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())} - ${slug(name)} - ${slug(src.title).slice(0, 40).replace(/-+$/, '')}.md`;
    return { text: lines.filter((l) => l !== null).join('\n'), file };
  }
  const noteDlg = $('dlg-nota');
  let noteFile = 'nota.md', noteSrc = null, vault = null;
  // Aviso (no bloqueo) si el texto parece incluir credenciales antes de guardarlo.
  const SECRET_RE = /(contrase(ñ|n)a|password|passwd|pwd|token|secret|api[_ -]?key|clave)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
  async function refreshVault() {
    const status = $('n-boveda'), btn = $('n-obsidian');
    btn.disabled = true;
    if (!isLive()) { status.textContent = 'Guardar en Obsidian requiere el servidor local (abre el panel con iniciar.bat). Puedes copiar o descargar la nota.'; return; }
    try {
      const r = await fetch('/api/obsidian', { cache: 'no-store' });
      vault = await r.json();
      btn.disabled = !vault.available;
      status.className = 'vault-status ' + (vault.available ? 'ok' : 'off');
      status.textContent = vault.available
        ? `Bóveda: ${vault.vault} · carpeta «${vault.folder}».`
        : vault.message + ' Mientras tanto puedes copiar o descargar la nota.';
    } catch {
      status.textContent = 'No se pudo consultar la configuración de la bóveda. Puedes copiar o descargar la nota.';
    }
  }
  function noteRequest() {
    const m = noteSrc.machine ? state.machines.find((x) => x.id.toLowerCase() === String(noteSrc.machine).toLowerCase()) : null;
    return { maquina: m ? m.name : 'Laboratorio', fecha: isoLocal(noteSrc.when || new Date()), titulo: noteSrc.title, contenido: $('n-texto').value };
  }
  async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({ error: 'Respuesta no válida del servidor' }));
    if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
    return d;
  }
  $('n-obsidian').addEventListener('click', async () => {
    try {
      const plan = await postJson('/api/obsidian/plan', noteRequest());
      $('n-ruta').textContent = plan.path;
      const warn = SECRET_RE.test($('n-texto').value);
      $('n-aviso').hidden = !warn;
      $('n-aviso').textContent = warn ? 'Atención: el texto parece contener una contraseña, token o clave. Revísalo antes de guardar; no se recomienda guardar credenciales en notas.' : '';
      $('n-confirmar').hidden = false;
      $('n-acciones').hidden = true;
      $('n-confirmar-btn').focus();
    } catch (err) { toast('No se puede guardar en Obsidian: ' + err.message); refreshVault(); }
  });
  $('n-cancelar').addEventListener('click', () => { $('n-confirmar').hidden = true; $('n-acciones').hidden = false; $('n-obsidian').focus(); });
  $('n-confirmar-btn').addEventListener('click', async () => {
    const b = $('n-confirmar-btn');
    b.disabled = true;
    try {
      const res = await postJson('/api/obsidian/guardar', noteRequest());
      $('n-confirmar').hidden = true; $('n-acciones').hidden = false;
      $('n-boveda').className = 'vault-status ok';
      $('n-boveda').textContent = 'Guardada en la bóveda: ' + res.relative;
      toast('Nota guardada en Obsidian: ' + res.relative);
    } catch (err) {
      toast('No se guardó la nota: ' + err.message);
    }
    b.disabled = false;
  });
  function openNote(src) {
    const n = buildNote(src);
    noteSrc = src;
    noteFile = n.file;
    $('n-confirmar').hidden = true;
    $('n-acciones').hidden = false;
    refreshVault();
    $('n-texto').value = n.text;
    $('n-archivo').textContent = n.file;
    hidePeek();
    noteDlg.showModal();
    $('n-texto').focus();
    $('n-texto').setSelectionRange(0, 0);
    $('n-texto').scrollTop = 0;
  }
  $('n-cerrar').addEventListener('click', () => noteDlg.close());
  $('n-copiar').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('n-texto').value); toast('Nota copiada. Pégala en una nota nueva de Obsidian.'); }
    catch { $('n-texto').select(); toast('No se pudo copiar automáticamente: el texto quedó seleccionado, usa Ctrl+C.'); }
  });
  $('n-descargar').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([$('n-texto').value], { type: 'text/markdown;charset=utf-8' }));
    const a = h('a', { href: url, download: noteFile });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Nota guardada como «' + noteFile + '» en Descargas. Muévela a tu bóveda de Obsidian.');
  });

  // ---------- guía de solución por alerta ----------
  const guideDlg = $('dlg-guia');
  let guideKey = null;
  function guideContext(a) {
    const m = a.machine ? state.machines.find((x) => x.id.toLowerCase() === String(a.machine).toLowerCase()) : null;
    const port = a.key && a.key.startsWith('svc:') ? Number(a.key.split(':').pop()) : null;
    const s = m && port ? m.services.find((x) => x.port === port) : null;
    const sub24 = (ip) => ip.split('.').slice(0, 3).join('.');
    const ip = (s && s.ip) || (m && (m.checkedIp || m.ips.find((x) => state.localIps.some((l) => sub24(l) === sub24(x))) || m.ips[0])) || null;
    return {
      cat: a.cat, alertText: a.text, check: a.check, vmName: m ? m.name : '', os: m ? m.os : '', windows: !!(m && /windows/i.test(m.os)),
      vmState: m && m.stateRaw, port, ip, svcName: s ? s.name : '', method: s && s.method, httpCode: s && s.httpStatus, reason: s && s.reason
    };
  }
  function stepList(steps, ctx, fix) {
    return h('ol', { class: 'g-steps' + (fix ? ' fix' : '') }, steps.map((st) => h('li', null,
      h('div', { class: 'st-head' }, h('strong', null, st.title),
        h('span', { class: 'where w-' + st.where }, st.where === 'vm' ? `Dentro de la VM (${ctx.windows ? 'PowerShell' : 'terminal'})` : NEXO_GUIAS.WHERE[st.where]),
        st.changes && h('span', { class: 'changes' }, 'Cambia el sistema')),
      st.onlyIf && h('p', { class: 'only-if' }, h('strong', null, 'Solo si: '), st.onlyIf),
      st.note && h('p', { class: 'st-note' }, st.note),
      st.cmd && h('div', { class: 'cmd' }, h('code', { translate: 'no' }, st.cmd),
        h('button', { type: 'button', class: 'copy-btn', 'data-copy': st.cmd, 'aria-label': 'Copiar comando: ' + st.title }, icon('copy'), h('span', null, 'Copiar'))))));
  }
  function renderGuide(a) {
    const ctx = guideContext(a);
    const g = NEXO_GUIAS(ctx);
    const cat = ALERT_CAT[a.cat] || ALERT_CAT.config;
    const m = ctx.vmName ? ctx.vmName : a.machine === 'host' ? 'Equipo principal' : '';
    $('g-cuerpo').replaceChildren(...clean([
      h('div', { class: 'g-head alert-item ' + cat.cls + ' sev-' + cat.sev }, h('span', { class: 'cat-ic' }, icon(cat.icon)),
        h('div', null, h('h2', { id: 'g-titulo' }, a.text), h('p', { class: 'alert-meta' }, h('span', { class: 'sev' }, SEV[cat.sev]), h('span', { class: 'cat-chip' }, cat.label), m && h('span', null, m)))),
      h('section', { class: 'g-sec' }, h('h3', null, h('span', { class: 'n' }, '1'), 'Qué detectó el panel'),
        h('ul', { class: 'group' },
          h('li', { class: 'g-row' }, h('span', { class: 'g-l' }, 'Hora'), h('span', { class: 'g-v' }, a.at ? fmtFull.format(a.at) : 'Desconocida')),
          h('li', { class: 'g-row' }, h('span', { class: 'g-l' }, 'Evidencia'), h('span', { class: 'g-v ev-text' }, a.check)))),
      h('section', { class: 'g-sec' }, h('h3', null, h('span', { class: 'n' }, '2'), 'Qué significa y qué no demuestra'),
        h('div', { class: 'g-box' }, h('p', null, h('strong', null, 'Significa: '), g.means), h('p', { class: 'not' }, h('strong', null, 'Límite: '), g.notProves))),
      h('section', { class: 'g-sec' }, h('h3', null, h('span', { class: 'n' }, '3'), 'Diagnóstico ', h('small', null, 'solo lectura, de lo más simple a lo más detallado')),
        stepList(g.diag, ctx, false)),
      h('section', { class: 'g-sec fix-sec' }, h('h3', null, h('span', { class: 'n' }, '4'), 'Corrección posible ', h('small', null, 'la haces tú, solo si el diagnóstico lo justifica')),
        h('p', { class: 'fix-warn' }, icon('warn'), 'Estos pasos cambian la máquina o el servicio. El panel no los ejecuta. Anota lo que hagas para poder deshacerlo.'),
        stepList(g.fix, ctx, true),
        window.NEXO_CONTROL ? window.NEXO_CONTROL.guideBlock(a.key) : null),
      h('section', { class: 'g-sec' }, h('h3', null, h('span', { class: 'n' }, '5'), 'Cómo verificar'),
        h('p', null, g.verify),
        g.verifyCmd && h('div', { class: 'verify-cmd' }, h('span', { class: 'where w-' + g.verifyCmd.where }, g.verifyCmd.where === 'vm' ? `Dentro de la VM (${ctx.windows ? 'PowerShell' : 'terminal'})` : NEXO_GUIAS.WHERE[g.verifyCmd.where]),
          g.verifyCmd.note && h('p', { class: 'st-note' }, g.verifyCmd.note),
          h('div', { class: 'cmd' }, h('code', { translate: 'no' }, g.verifyCmd.cmd),
            h('button', { type: 'button', class: 'copy-btn', 'data-copy': g.verifyCmd.cmd, 'aria-label': 'Copiar comando de verificación' }, icon('copy'), h('span', null, 'Copiar')))),
        h('div', { class: 'verify-row' },
          h('button', { type: 'button', class: 'btn primary', id: 'g-comprobar' }, 'Comprobar ahora'),
          h('span', { id: 'g-resultado', class: 'verify-res', role: 'status', 'aria-live': 'polite' }))),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn', id: 'g-documentar' }, icon('note'), 'Documentar resultado'))
    ]));
    $('g-comprobar').addEventListener('click', async () => {
      const b = $('g-comprobar');
      b.disabled = true;
      $('g-resultado').textContent = 'Comprobando…';
      const before = state.fetchedAt;
      const ok = await load(false, true);
      const res = $('g-resultado');
      if (!ok) {
        // La consulta falló: no se sabe si sigue activa. Se conservan los datos anteriores y se dice claramente.
        res.className = 'verify-res unk';
        res.textContent = `No se pudo comprobar: ${state.error || 'sin respuesta del servidor'}. Se conservan los datos anteriores${before ? ' (de las ' + fmtTime.format(before) + ')' : ''}; no se puede confirmar si la alerta sigue activa o ya está resuelta.`;
      } else {
        const still = state.alerts.find((x) => x.key === guideKey);
        res.className = 'verify-res ' + (still ? 'bad' : 'ok');
        res.textContent = still
          ? `Sigue activa (comprobado a las ${fmtTime.format(state.fetchedAt)}). ${still.check}`
          : `Resuelta: la comprobación de las ${fmtTime.format(state.fetchedAt)} ya no la detecta.`;
      }
      b.disabled = false;
    });
    $('g-documentar').addEventListener('click', () => {
      guideDlg.close();
      openNote({ title: a.text, machine: a.machine, kind: 'alerta', when: a.at, detail: 'Comprobado: ' + a.check, guide: g });
    });
  }
  function openGuide(key) {
    const a = state.alerts.find((x) => x.key === key);
    if (!a) { toast('Esta alerta ya no está activa.'); return; }
    guideKey = key;
    hidePeek();
    if (sheet.open) sheet.close();   // una sola hoja a la vez
    renderGuide(a);
    guideDlg.showModal();
    guideDlg.querySelector('.sheet-body').scrollTop = 0;
  }
  $('g-cerrar').addEventListener('click', () => guideDlg.close());

  // ---------- tendencias guardadas ----------
  function trendChart(points, hours, gaps) {
    const W = 600, H = 120, now = Date.now(), from = now - hours * 3600e3;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'trend-svg');
    svg.setAttribute('aria-hidden', 'true');
    for (const y of [0, H / 2, H]) {
      const l = document.createElementNS(SVG, 'line');
      l.setAttribute('x1', 0); l.setAttribute('x2', W); l.setAttribute('y1', y); l.setAttribute('y2', y);
      l.setAttribute('class', 'grid');
      svg.append(l);
    }
    for (const g of gaps || []) {
      // Periodo sin datos: el servidor estaba cerrado (no se dibuja nada inventado, solo se marca el hueco).
      const x1 = Math.max(0, (new Date(g.from).getTime() - from) / (now - from) * W);
      const x2 = Math.min(W, (new Date(g.to).getTime() - from) / (now - from) * W);
      if (x2 <= x1) continue;
      const r = document.createElementNS(SVG, 'rect');
      r.setAttribute('x', x1.toFixed(1)); r.setAttribute('y', 0); r.setAttribute('width', (x2 - x1).toFixed(1)); r.setAttribute('height', H);
      r.setAttribute('class', 'gap');
      svg.append(r);
    }
    for (const k of ['mem', 'cpu']) {
      // Se corta la línea cuando hay huecos de más de 3 minutos (servidor cerrado o VM apagada).
      let seg = [], prevT = null;
      const flush = () => {
        if (seg.length > 1) { const pl = document.createElementNS(SVG, 'polyline'); pl.setAttribute('points', seg.join(' ')); pl.setAttribute('class', 'tl k-' + k); svg.append(pl); }
        seg = [];
      };
      for (const p of points) {
        const t = new Date(p.ts).getTime();
        if (p[k] == null) continue;
        if (prevT && t - prevT > 180e3) flush();
        seg.push(((t - from) / (now - from) * W).toFixed(1) + ',' + (H - Math.min(p[k], 100) / 100 * H).toFixed(1));
        prevT = t;
      }
      flush();
    }
    return svg;
  }
  async function loadTrend(m) {
    const box = $('d-trend');
    if (!box) return;
    const hours = state.trendHours;
    try {
      const r = await fetch(`/api/tendencias?maquina=${encodeURIComponent(m.id)}&horas=${hours}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      if (!$('d-trend') || state.open !== m.id) return;
      const pts = d.points;
      const stat = (k) => {
        const v = pts.map((p) => p[k]).filter((x) => x != null);
        return v.length ? `media ${Math.round(v.reduce((a, b) => a + b, 0) / v.length)} %, máx. ${Math.round(Math.max(...v))} %` : 'sin datos';
      };
      const fmt = new Intl.DateTimeFormat('es', hours > 24 ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
      $('d-trend').replaceChildren(...clean([
        pts.length < 2
          ? h('p', { class: 'g-sub' }, 'Aún no hay suficientes muestras en este periodo. El servidor guarda una por minuto mientras está abierto y la máquina está encendida.')
          : [h('div', { class: 'chart' },
               h('div', { class: 'y-ax', 'aria-hidden': 'true' }, h('span', null, '100 %'), h('span', null, '50 %'), h('span', null, '0 %')),
               trendChart(pts, hours, d.gaps),
               h('div', { class: 'x-ax' }, h('span', null, fmt.format(new Date(Date.now() - hours * 3600e3))), h('span', null, 'ahora'))),
             h('p', { class: 'trend-legend' },
               h('span', { class: 'lg k-cpu' }, 'CPU: ' + stat('cpu')),
               h('span', { class: 'lg k-mem' }, 'Memoria: ' + stat('mem')))],
        d.gaps && d.gaps.length > 0 && h('p', { class: 'trend-gaps' }, h('span', { class: 'gap-swatch' }),
          'Sin datos (servidor cerrado): ' + d.gaps.map((g) => `${fmtDate.format(new Date(g.from))} a ${fmtDate.format(new Date(g.to))}`).join(' · ')),
        d.historySince && new Date(d.historySince) > new Date(Date.now() - hours * 3600e3) &&
          h('p', { class: 'g-sub' }, 'El historial empieza el ' + fmtFull.format(new Date(d.historySince)) + '; antes no hay datos.'),
        d.error && h('p', { class: 'g-sub err' }, d.error),
        h('p', { class: 'g-sub' }, `${pts.length} muestras (una por minuto con el servidor abierto). Origen: ${d.origin || (m.kind === 'host' ? 'sistema operativo del equipo' : 'proceso de la VM en este equipo')}.`)
      ]));
    } catch (err) {
      if ($('d-trend')) $('d-trend').replaceChildren(h('p', { class: 'g-sub' }, 'No se pudo leer el historial: ' + (err.message || 'error')));
    }
  }
  function trendSection(m) {
    const seg = h('span', { class: 'segmented small trend-range', role: 'group', 'aria-label': 'Periodo de la tendencia' },
      [[1, '1 h'], [24, '24 h'], [168, '7 días']].map(([v, l]) => h('button', { type: 'button', 'data-hours': v, 'aria-pressed': String(state.trendHours === v) }, l)));
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-hours]');
      if (!b) return;
      state.trendHours = +b.dataset.hours;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      loadTrend(m);
    });
    return [h('div', { class: 'g-title-row' }, h('h3', { class: 'g-title' }, 'Tendencia guardada'), seg),
      h('div', { class: 'group trend', id: 'd-trend' }, h('p', { class: 'g-sub' }, 'Cargando…'))];
  }

  // ---------- hoja de detalles ----------
  const sheet = $('detalle');
  let lastOpener = null;
  const groupRow = (label, value) => h('li', { class: 'g-row' }, h('span', { class: 'g-l' }, label), h('span', { class: 'g-v' }, value));

  function detail(m) {
    const live = isLive();
    const hist = state.events.filter((a) => a.machine && a.machine.toLowerCase() === m.id.toLowerCase()).slice(0, 12);
    const used = (p, total) => (p == null || !total ? '' : '· ' + gb((p / 100) * total) + ' de ' + gb(total));
    const alerts = state.alerts.filter((a) => a.machine === m.id);
    return clean([
      h('div', { class: 'd-head' }, kindIcon(m, true),
        h('div', null, h('h2', { id: 'd-titulo' }, m.name), h('p', null, m.os)), pill(m)),
      m.note && h('p', { class: 'callout' }, icon('warn'), m.note),
      alerts.map((a) => h('div', { class: 'callout with-doc' }, icon('warn'), h('span', null, a.text),
        h('button', { type: 'button', class: 'guide-btn', 'data-guide': a.key, 'aria-haspopup': 'dialog' }, icon('book'), 'Guía'),
        docButton({ title: a.text, machine: m.id, kind: 'alerta', when: a.at, detail: 'Comprobado: ' + a.check }))),

      h('h3', { class: 'g-title' }, 'General'),
      h('ul', { class: 'group' }, clean([
        groupRow('Tipo', m.kind === 'host' ? 'Equipo físico (anfitrión)' : 'Máquina virtual'),
        m.group && groupRow('Grupo', m.group),
        m.tags.length > 0 && groupRow('Etiquetas', m.tags.join(', ')),
        m.stateRaw && groupRow('Estado en VirtualBox', h('span', null, m.stateLabel, ' ', h('span', { class: 'mono raw' }, '(' + m.stateRaw + ')'))),
        m.since && groupRow('En este estado desde', `${fmtFull.format(m.since)} (${ago(m.since)})`),
        groupRow(m.kind === 'host' ? 'Función' : 'Plataforma', m.platform),
        groupRow('Dirección IP', h('span', { class: 'mono', translate: 'no' }, ipText(m))),
        m.ipOrigin && groupRow('Origen de la IP', IP_ORIGIN[m.ipOrigin]),
        m.uptime !== undefined && groupRow('Tiempo encendida', m.uptime || 'Apagada, sin datos')
      ])),

      m.services.length > 0 && [
        h('h3', { class: 'g-title' }, 'Servicios'),
        h('ul', { class: 'group' }, m.services.map((s) => h('li', { class: 'g-svc' },
          h('div', { class: 'g-row-in' },
            h('span', { class: 'g-l' }, s.name, s.port && h('span', { class: 'port mono' }, ' :' + s.port),
              s.method && h('span', { class: 'method' }, s.method === 'tcp' ? 'TCP' : `${s.method.toUpperCase()} ${s.path || '/'}`)),
            h('span', { class: 'g-v svc-state v-' + s.status }, icon(SVC[s.status].icon), SVC[s.status].label)),
          h('p', { class: 'g-sub' }, clean([
            s.reason,
            s.ip && ` · ${s.ip}:${s.port}`,
            s.ms != null && ` · ${s.ms} ms`,
            s.checkedAt && ` · ${fmtTime.format(s.checkedAt)}`
          ]).join(''))))),
        live && h('p', { class: 'g-foot' }, 'TCP solo confirma que el puerto acepta la conexión. HTTP/HTTPS hace un GET sin credenciales y confirma que la aplicación contesta (un código menor que 500). Se configura en servicios.json.')
      ],

      liveOn(m) && [
        h('h3', { class: 'g-title' }, 'Rendimiento en tiempo real ', h('span', { class: 'rt-at', 'data-rt-at': '' })),
        h('div', { class: 'group charts' }, perf(m, true),
          m.kind === 'vm' && h('p', { class: 'io-row' }, h('span', null, 'E/S del proceso (disco y red)'), h('span', { class: 'mono', 'data-io-id': m.id }, ioText(m.io)))),
        h('p', { class: 'g-foot' }, m.kind === 'vm'
          ? 'Medido desde este equipo cada segundo, como el Administrador de tareas: CPU es el porcentaje de la CPU total de tu PC que usa esta VM; Memoria es la RAM de tu PC que ocupa, sobre la asignada. Gráficas de los últimos 60 s.'
          : 'CPU y memoria de este equipo, medidas cada segundo. Gráficas de los últimos 60 s.')
      ],
      h('h3', { class: 'g-title' }, m.kind === 'host' ? 'Capacidad' : 'Recursos asignados'),
      h('ul', { class: 'group' }, clean([
        groupRow(m.kind === 'host' ? 'Núcleos lógicos' : 'Procesadores', m.vcpu + (m.kind === 'host' ? '' : ' vCPU')),
        groupRow('Memoria', gb(m.kind === 'host' && m.memTotalGB ? m.memTotalGB : m.ramGB)),
        m.disk != null && h('li', { class: 'g-meter' }, meter('Disco', m.disk, used(m.disk, m.diskGB))),
        !live && h('li', { class: 'g-meter' }, meter('CPU', m.cpu)),
        !live && h('li', { class: 'g-meter' }, meter('Memoria', m.mem))
      ])),

      live && trendSection(m),

      m.nics.length > 0 && [h('h3', { class: 'g-title' }, 'Red'),
        h('ul', { class: 'group' }, m.nics.map((n) => groupRow('Adaptador ' + n.slot, h('span', null, nicLabel(n),
          n.target && n.type !== 'intnet' && n.target !== 'nat' ? h('span', { class: 'raw' }, ' · ' + n.target) : null))))],

      hist.length > 0 && [h('h3', { class: 'g-title' }, 'Historial guardado'),
        h('ul', { class: 'group' }, hist.map((a) => h('li', { class: 'g-row hist-row a-' + a.type },
          h('span', { class: 'g-l' }, h('span', { class: 'act-ic' }, icon(ACT[a.type][0])),
            h('span', { class: 'act-t' }, a.text, a.duration != null && h('span', { class: 'act-sub' }, 'Estado anterior durante ' + dur(a.duration)))),
          h('span', { class: 'hist-end' }, h('time', { class: 'g-v mono' }, fmtDate.format(a.when)),
            docButton({ title: a.text, machine: a.machine, kind: a.kind, when: a.when, detail: a.detail })))))],

      live && [h('h3', { class: 'g-title' }, 'Datos disponibles'),
        h('ul', { class: 'group data-avail' }, dataRows(m).map(([label, ok, text]) => h('li', { class: 'g-row' + (ok ? '' : ' missing') },
          h('span', { class: 'g-l' }, icon(ok ? 'check' : 'minus', 'avail-ic'), label), h('span', { class: 'g-v' }, text))))],

      h('p', { class: 'sheet-foot' }, live
        ? `Leído de VirtualBox a las ${fmtTime.format(state.fetchedAt)}. Este panel solo lee: no puede encender, pausar, apagar ni modificar máquinas.`
        : 'Datos de demostración. Este panel solo muestra información: no puede encender, apagar ni modificar máquinas.')
    ]);
  }

  // Qué se sabe de la máquina, de dónde sale y qué falta (para no confundir dato ausente con valor cero).
  function dataRows(m) {
    const t = state.fetchedAt ? fmtTime.format(state.fetchedAt) : '?';
    const rtAt = state.rt ? fmtTime.format(new Date(state.rt.at)) : null;
    const checked = m.services.filter((s) => s.status === 'up' || s.status === 'down');
    const rows = [];
    if (m.kind === 'vm') rows.push(['Estado de la VM', true, `VirtualBox (VBoxManage), leído a las ${t}`]);
    rows.push(['Dirección IP', m.ips.length > 0 || m.kind === 'host',
      m.kind === 'host' ? 'Este equipo' : m.ips.length ? IP_ORIGIN[m.ipOrigin] || 'Informada por VirtualBox'
        : m.state === 'running' ? 'No disponible: sin Guest Additions, sin concesión DHCP ni entrada ARP' : 'No disponible: la VM no está encendida']);
    rows.push([m.kind === 'host' ? 'CPU y memoria' : 'CPU y memoria en el equipo', liveOn(m) && m.cpu != null,
      liveOn(m) && m.cpu != null ? `En vivo cada segundo${rtAt ? ' (última: ' + rtAt + ')' : ''}` : 'No disponible: la VM no está encendida']);
    if (m.kind === 'vm') rows.push(['Uso dentro del sistema invitado', false, 'No disponible: requiere activar las métricas de VirtualBox y Guest Additions completas']);
    rows.push(['Servicios', checked.length > 0,
      !m.services.length ? 'No hay servicios configurados (botón Configurar)'
        : checked.length ? `${checked.length} de ${m.services.length} comprobados a las ${t}`
        : 'No comprobados: ' + (m.services[0].reason || '').replace(/^No se comprobó: /, '')]);
    rows.push(['Tendencia guardada', !!(state.histInfo && state.histInfo.since),
      state.histInfo && state.histInfo.error ? 'No disponible: el historial no se pudo abrir'
        : state.histInfo && state.histInfo.since ? 'Muestras por minuto desde ' + fmtFull.format(new Date(state.histInfo.since)) : 'Aún sin muestras']);
    return rows;
  }

  function openDetail(id, from) {
    const m = byId(id);
    if (!m) { state.open = null; syncUrl(); return; }
    if (from) lastOpener = from;
    state.open = id;
    $('d-cuerpo').replaceChildren(...detail(m));
    sheet.querySelector('.sheet-demo').hidden = isLive();
    if (!sheet.open) { sheet.showModal(); $('d-cuerpo').scrollTop = 0; }
    if (isLive()) loadTrend(m);
    syncUrl();
  }

  sheet.addEventListener('close', () => {
    const id = state.open;
    state.open = null;
    syncUrl();
    const back = lastOpener && document.contains(lastOpener) ? lastOpener : document.querySelector(`.hit[data-open="${CSS.escape(id || '')}"]`);
    lastOpener = null;
    if (back) back.focus();
  });
  $('d-cerrar').addEventListener('click', () => sheet.close());
  for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  document.addEventListener('click', (e) => {
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      navigator.clipboard.writeText(cp.dataset.copy).then(() => {
        const label = cp.querySelector('span');
        if (label) { label.textContent = 'Copiado'; setTimeout(() => { label.textContent = 'Copiar'; }, 1500); }
      }).catch(() => toast('No se pudo copiar automáticamente: selecciona el comando y usa Ctrl+C.'));
      return;
    }
    const gd = e.target.closest('[data-guide]');
    if (gd) { openGuide(gd.dataset.guide); return; }
    const d = e.target.closest('[data-doc]');
    if (d) { const src = state.docs.get(d.dataset.doc); if (src) openNote(src); return; }
    const b = e.target.closest('[data-open]');
    if (b) openDetail(b.dataset.open, b);
  });

  // ---------- renderizado ----------
  const matches = (m) =>
    (state.filter === 'all' || m.state === state.filter) &&
    (state.group === 'all' || (m.group || 'Sin grupo') === state.group) &&
    (!state.query || [m.name, m.os, m.group, ...m.tags, ...(m.ips || [])].join(' ').toLowerCase().includes(state.query.toLowerCase()));

  function renderSource() {
    const note = $('demo-banner');
    note.className = 'demo-note src-' + state.source;
    const t = state.fetchedAt ? fmtTime.format(state.fetchedAt) : '';
    const msg = {
      loading: [null, 'Leyendo VirtualBox y comprobando servicios…'],
      live: ['Conectado a VirtualBox ' + state.vboxVersion + '.', ' Los datos se leen en solo lectura y se actualizan cada 10 segundos; las acciones están en Control.'],
      stale: ['Sin conexión con el servicio local.', ` Se muestran los últimos datos reales, de las ${t}. (${state.error})`],
      demo: ['Modo demo.', ` No se pudo leer VirtualBox (${state.error}). Los datos son de ejemplo y no corresponden a tus máquinas.`]
    }[state.source];
    note.replaceChildren(...clean([msg[0] && h('strong', null, msg[0]), msg[1], state.source === 'live' && UI_V !== '?' && h('span', { class: 'ui-v' }, ' Interfaz v' + UI_V + '.')]));
    const ua = $('ui-aviso');
    ua.hidden = !state.uiOutdated;
    if (state.uiOutdated) ua.replaceChildren(h('strong', null, 'Estás viendo una versión antigua de la interfaz.'), ` Esta página cargó la v${UI_V} y el servidor tiene la v${state.uiServer}. Pulsa Ctrl + F5 para recargarla con los cambios (por ejemplo, el botón «Guía de solución» de las alertas).`);
    $('side-demo').hidden = state.source !== 'demo';
    const conn = $('side-conn');
    if (conn) conn.replaceChildren(h('span', { class: 'dot ' + ({ live: 'ok', stale: 'warn', demo: 'err' }[state.source] || '') }),
      { live: 'VirtualBox ' + state.vboxVersion, stale: 'Sin conexión: datos de las ' + t, demo: 'Sin conexión con VirtualBox', loading: 'Conectando…' }[state.source]);
    document.querySelectorAll('.chip-demo').forEach((c) => { c.hidden = state.source !== 'demo'; });
    $('ultima').textContent = state.source === 'loading' ? '' :
      (state.source === 'demo' ? 'Datos de ejemplo' : 'Actualizado a las ' + t + (state.source === 'stale' ? ' · desactualizado' : ''));
  }

  function renderSummary() {
    const count = (st) => state.machines.filter((m) => m.state === st).length;
    const host = state.machines.find((m) => m.kind === 'host');
    const svcs = state.machines.flatMap((m) => m.services);
    const up = svcs.filter((s) => s.status === 'up').length;
    const checked = svcs.filter((s) => s.status === 'up' || s.status === 'down').length;
    $('tiles').replaceChildren(...clean([
      Object.keys(STATES).map((st) =>
        h('div', { class: 'tile t-' + st },
          h('div', { class: 'tile-top' }, h('span', { class: 'tile-ic' }, icon(STATES[st].icon)), h('span', { class: 'tile-l' }, STATES[st].plural)),
          h('p', { class: 'tile-n' }, count(st), h('small', null, ' de ' + state.machines.length)),
          h('p', { class: 'tile-h' }, STATES[st].hint))),
      h('div', { class: 'tile t-svc' + (up < checked ? ' bad' : '') },
        h('div', { class: 'tile-top' }, h('span', { class: 'tile-ic' }, icon('pulse')), h('span', { class: 'tile-l' }, 'Servicios')),
        h('p', { class: 'tile-n' }, up, h('small', null, ' de ' + checked + ' responden')),
        h('p', { class: 'tile-h' }, `${svcs.length - checked} sin comprobar (máquinas apagadas o sin IP alcanzable)`)),
      host && h('div', { class: 'tile t-usage' },
        h('div', { class: 'tile-top' }, h('span', { class: 'tile-ic' }, icon('monitor')), h('span', { class: 'tile-l' }, 'Equipo principal')),
        perf(host),
        h('p', { class: 'tile-h' }, isLive() ? host.name + ' · datos reales' : 'Datos de ejemplo'))
    ]));

    const problems = count('alert');
    const badge = (href, n, warn, label) => {
      const link = document.querySelector(`nav a[href="${href}"]`);
      link.querySelector('.nav-n')?.remove();
      if (n != null) link.append(h('span', { class: 'nav-n' + (warn ? ' warn' : '') }, n, label && h('span', { class: 'vh' }, label)));
    };
    badge('#maquinas', state.machines.length, problems > 0, problems ? `, ${problems} con problemas` : '');
    badge('#alertas', state.alerts.length || null, true, ' alertas');

    const og = $('estado-general');
    const on = count('running');
    const al = state.alerts.length;
    og.className = 'overall ' + (al ? 's-alert' : on ? 's-running' : 's-idle');
    og.replaceChildren(icon(al ? 'warn' : on ? 'check' : 'pause'),
      al ? `${al} ${al === 1 ? 'alerta' : 'alertas'} de salud` : on ? `${on} en ejecución, sin alertas` : 'Ninguna máquina virtual en ejecución');
  }

  function renderHero() {
    const hero = $('hero');
    const al = state.alerts.length;
    const on = state.machines.filter((m) => m.kind === 'vm' && m.state === 'running').length;
    const vms = state.machines.filter((m) => m.kind === 'vm').length;
    const svcs = state.machines.flatMap((m) => m.services);
    const up = svcs.filter((s) => s.status === 'up').length;
    const checked = svcs.filter((s) => s.status === 'up' || s.status === 'down').length;
    const [cls, ic, title] = state.source === 'demo' ? ['h-demo', 'info', 'Modo demo']
      : state.source === 'loading' ? ['h-idle', 'clock', 'Comprobando…']
      : al ? ['h-alert', 'warn', 'Atención requerida']
      : on ? ['h-ok', 'check', 'Todo en orden'] : ['h-idle', 'pause', 'Laboratorio en reposo'];
    hero.className = 'hero ' + cls;
    const facts = state.source === 'demo' ? ['Datos de ejemplo: no corresponden a tus máquinas']
      : state.source === 'loading' ? [] : clean([
        al ? `${al} ${al === 1 ? 'alerta abierta' : 'alertas abiertas'}` : 'Sin alertas',
        `${on} de ${vms} VM encendidas`,
        checked ? `${up} de ${checked} servicios responden` : null,
        state.fetchedAt && 'Última comprobación ' + fmtTime.format(state.fetchedAt) + (state.source === 'stale' ? ' (sin conexión)' : '')
      ]);
    hero.replaceChildren(...clean([
      h('span', { class: 'hero-ic' }, icon(ic)),
      h('div', { class: 'hero-t' }, h('strong', null, title), facts.length > 0 && h('p', null, facts.join(' · '))),
      al > 0 && h('a', { class: 'btn hero-go', href: '#alertas' }, 'Ver alertas')]));
  }

  function renderAlerts() {
    const list = $('lista-alertas');
    const aj = state.ajustes;
    $('alertas-hint').textContent = state.source === 'demo' ? 'Disponibles solo conectado a VirtualBox.'
      : state.fetchedAt ? 'Última comprobación a las ' + fmtTime.format(state.fetchedAt) + '. Cada aviso dice qué se comprobó.' : '';
    $('umbrales').textContent = isLive() && aj.avisoMemoriaEquipo != null
      ? `Umbrales (se cambian con el botón Configurar): memoria del equipo ≥ ${aj.avisoMemoriaEquipo} % durante ${aj.minutosMemoriaAlta} min · CPU ≥ ${aj.avisoCpuEquipo} % durante ${aj.minutosCpuAlta} min · VM interrumpida ≥ ${aj.avisarInterrumpidaTrasDias} días · gracia tras arrancar ${aj.graciaArranqueSegundos} s.`
      : '';
    if (!isLive()) { list.replaceChildren(h('li', { class: 'g-row empty-row' }, state.source === 'demo' ? 'Sin datos reales: no hay alertas que mostrar.' : 'Comprobando…')); return; }
    if (!state.alerts.length) { list.replaceChildren(h('li', { class: 'g-row ok-row' }, h('span', { class: 'g-l' }, h('span', { class: 'act-ic ok' }, icon('check')), 'Todo en orden: ninguna comprobación falló.'))); return; }
    const order = ['http5xx', 'noresponse', 'vm', 'noip', 'resources', 'config'];
    const sevRank = (a) => ['crit', 'warn', 'info'].indexOf((ALERT_CAT[a.cat] || ALERT_CAT.config).sev);
    const sorted = [...state.alerts].sort((a, b) => sevRank(a) - sevRank(b) || order.indexOf(a.cat) - order.indexOf(b.cat));
    list.replaceChildren(...sorted.map((a, i) => {
      const cat = ALERT_CAT[a.cat] || ALERT_CAT.config;
      const m = a.machine ? byId(a.machine) || state.machines.find((x) => x.id.toLowerCase() === String(a.machine).toLowerCase()) : null;
      const open = state.expanded.has(a.key);
      const evId = 'ev-' + i;
      const toggle = h('button', { type: 'button', class: 'ev-btn', 'aria-expanded': String(open), 'aria-controls': evId },
        open ? 'Ocultar evidencia' : 'Ver evidencia');
      toggle.addEventListener('click', () => {
        if (state.expanded.has(a.key)) state.expanded.delete(a.key); else state.expanded.add(a.key);
        renderAlerts();
        const again = document.querySelector(`[aria-controls="${evId}"]`);
        if (again) again.focus();
      });
      return h('li', { class: 'alert-item ' + cat.cls + ' sev-' + cat.sev },
        h('div', { class: 'alert-line' },
          h(a.machine ? 'button' : 'div', a.machine ? { type: 'button', class: 'alert-row', 'data-open': a.machine, 'aria-haspopup': 'dialog' } : { class: 'alert-row' },
            h('span', { class: 'cat-ic', title: cat.hint }, icon(cat.icon)),
            h('span', { class: 'alert-t' },
              h('span', { class: 'alert-main' }, a.text),
              h('span', { class: 'alert-meta' }, h('span', { class: 'sev' }, SEV[cat.sev]), h('span', { class: 'cat-chip' }, cat.label),
                m && h('span', null, m.name), a.at && h('span', { class: 'mono' }, fmtTime.format(a.at)))),
            a.machine && icon('chevron', 'chev')),
          h('span', { class: 'alert-actions' },
            h('button', { type: 'button', class: 'guide-btn', 'data-guide': a.key, 'aria-haspopup': 'dialog' }, icon('book'), 'Guía de solución'),
            toggle,
            docButton({ title: a.text, machine: a.machine, kind: 'alerta', when: a.at, detail: 'Comprobado: ' + a.check }))),
        h('p', { class: 'alert-ev', id: evId, hidden: open ? false : '' }, h('strong', null, 'Comprobado: '), a.check));
    }));
  }

  function radioGroup(boxId, name, opts, current, onChange) {
    const box = $(boxId);
    box.querySelectorAll('label').forEach((l) => l.remove());
    for (const [val, label, n] of opts) {
      const id = name + '-' + val.replace(/\W+/g, '_');
      const input = h('input', { type: 'radio', name, id, value: val });
      input.checked = current === val;
      input.addEventListener('change', () => onChange(val));
      box.append(h('label', { for: id }, input, h('span', null, label, n != null && [' ', h('b', null, n)])));
    }
  }

  function renderFilters() {
    radioGroup('filtros', 'estado', [['all', 'Todas', state.machines.length],
      ...Object.keys(STATES).map((k) => [k, STATES[k].plural, state.machines.filter((m) => m.state === k).length])],
      state.filter, (v) => { state.filter = v; renderList(); });
    const groups = [...new Set(state.machines.map((m) => m.group || 'Sin grupo'))];
    if (state.group !== 'all' && !groups.includes(state.group)) state.group = 'all';
    radioGroup('grupos', 'grupo', [['all', 'Todos los grupos', null],
      ...groups.map((g) => [g, g, state.machines.filter((m) => (m.group || 'Sin grupo') === g).length])],
      state.group, (v) => { state.group = v; renderList(); });
  }

  function renderList() {
    syncUrl();
    const items = state.machines.filter(matches);
    const box = $('lista');
    box.className = 'machines ' + (state.view === 'cards' ? 'as-cards' : 'as-list');
    $('conteo').textContent = state.source === 'loading' ? '' : `Mostrando ${items.length} de ${state.machines.length} máquinas`;
    box.removeAttribute('role'); box.removeAttribute('aria-label');
    if (state.source === 'loading') { box.replaceChildren(h('div', { class: 'empty' }, h('p', null, 'Leyendo VirtualBox…'))); return; }
    if (!items.length) {
      box.replaceChildren(h('div', { class: 'empty' }, h('p', null, 'Ninguna máquina coincide con la búsqueda o los filtros.'),
        h('button', { type: 'button', class: 'btn', id: 'reset' }, 'Quitar filtros')));
      $('reset').addEventListener('click', () => {
        state.filter = 'all'; state.group = 'all'; state.query = ''; $('buscar').value = ''; renderFilters(); renderList();
      });
      return;
    }
    if (state.view === 'list') {
      box.setAttribute('role', 'table'); box.setAttribute('aria-label', 'Máquinas');
      box.replaceChildren(h('div', { class: 'row head-row', role: 'row' },
        ...['Máquina', 'Estado', 'IP', 'Servicios', 'CPU'].map((t) => h('span', { role: 'columnheader' }, t)),
        h('span', { role: 'columnheader' }, h('span', { class: 'vh' }, 'Detalles'))), ...items.map(row));
    } else {
      box.replaceChildren(...items.map(card));
    }
  }

  // Red: agrupa los adaptadores de VirtualBox por red y muestra quién está conectado.
  function renderNetworks() {
    const box = $('redes');
    if (!isLive()) { box.replaceChildren(h('p', { class: 'empty' }, 'La vista de red usa los adaptadores reales de VirtualBox y no está disponible en modo demo.')); renderNetMap([], null); return; }
    const nets = new Map();
    const host = state.machines.find((m) => m.kind === 'host');
    const sub24 = (ip) => ip.split('.').slice(0, 3).join('.');
    for (const m of state.machines.filter((x) => x.kind === 'vm')) {
      for (const n of m.nics) {
        const key = n.type === 'nat' ? 'nat' : n.type + '|' + n.target;
        if (!nets.has(key)) nets.set(key, { type: n.type, target: n.target, members: [] });
        nets.get(key).members.push(m);
      }
    }
    const order = { hostonly: 0, hostonlynet: 0, bridged: 1, natnetwork: 2, intnet: 3, nat: 4 };
    const cards = [...nets.values()].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9)).map((net) => {
      // Una IP pertenece a una red de este equipo si comparte /24 con alguna IP local; si no, es la interna de NAT.
      const isLocal = (ip) => state.localIps.some((l) => sub24(l) === sub24(ip));
      const memberIps = (m) => {
        if (net.type === 'nat') return m.ips.filter((ip) => !isLocal(ip));
        if (net.type === 'intnet') return [];
        return m.ips.filter(isLocal);
      };
      const allIps = net.members.flatMap(memberIps);
      const hostIp = ['hostonly', 'hostonlynet', 'bridged'].includes(net.type)
        ? state.localIps.find((l) => allIps.some((ip) => sub24(ip) === sub24(l))) : null;
      const rows = [];
      if (['hostonly', 'hostonlynet', 'bridged'].includes(net.type) && host) {
        rows.push(h('li', { class: 'net-member is-host' },
          h('button', { type: 'button', class: 'net-row', 'data-open': 'host', 'aria-haspopup': 'dialog' },
            kindIcon(host), h('span', { class: 'net-name' }, host.name, h('span', { class: 'raw' }, ' · este equipo')),
            h('span', { class: 'mono net-ip', translate: 'no' }, hostIp || 'IP en esta red no determinada'))));
      }
      for (const m of net.members) {
        const ips = memberIps(m);
        rows.push(h('li', { class: 'net-member' },
          h('button', { type: 'button', class: 'net-row', 'data-open': m.id, 'aria-haspopup': 'dialog' },
            kindIcon(m), h('span', { class: 'net-name' }, m.name), pill(m),
            h('span', { class: 'mono net-ip', translate: 'no' },
              ips.length ? ips.join(', ') : net.type === 'intnet' ? 'No visible desde este equipo' : m.state === 'running' ? 'IP no disponible' : 'Sin IP'))));
      }
      return h('article', { class: 'net net-' + net.type },
        h('header', null,
          h('span', { class: 'net-ic' }, icon('net')),
          h('div', null,
            h('h3', null, net.type === 'nat' ? 'NAT (una red por VM)' : nicLabel(net) + (net.type !== 'intnet' && net.target ? ' · ' + net.target : '')),
            h('p', null, NET_HELP[net.type] || 'Tipo de red de VirtualBox: ' + net.type))),
        h('ul', { class: 'net-list' }, rows),
        net.type === 'nat' && allIps.length !== new Set(allIps).size && h('p', { class: 'net-note' }, icon('info'),
          'Varias VM muestran la misma IP NAT (por ejemplo 10.0.2.15). Es normal: cada VM con NAT tiene su propia red aislada con el mismo rango, así que no es un conflicto de IP.'));
    });
    const legend = h('article', { class: 'net net-legend' },
      h('header', null, h('span', { class: 'net-ic' }, icon('info')), h('div', null, h('h3', null, 'Leyenda de adaptadores'), h('p', null, 'Tipos de red de VirtualBox y qué significan.'))),
      h('ul', { class: 'net-list' }, ['hostonly', 'nat', 'natnetwork', 'intnet', 'bridged'].map((t) =>
        h('li', { class: 'net-member legend-row' }, h('strong', null, NIC[t]), h('span', null, NET_HELP[t])))));
    renderNetMap([...nets.values()], host);
    box.replaceChildren(...(cards.length ? [...cards, legend] : [h('p', { class: 'empty' }, 'Ninguna VM tiene adaptadores de red configurados.')]));
  }

  // Diagrama: equipo arriba, redes en el centro y VM abajo, con una línea por adaptador.
  function renderNetMap(nets, host) {
    const box = $('mapa-red');
    $('mapa-red').hidden = state.netView !== 'map';
    $('redes').hidden = state.netView !== 'list';
    $('red-mapa').setAttribute('aria-pressed', String(state.netView === 'map'));
    $('red-lista').setAttribute('aria-pressed', String(state.netView === 'list'));
    if (!isLive() || !nets.length) { box.replaceChildren(h('p', { class: 'empty' }, 'El mapa usa los adaptadores reales de VirtualBox y no está disponible en modo demo.')); return; }
    const NS = (tag, attrs, ...kids) => {
      const el = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v);
      for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
      return el;
    };
    const order = { hostonly: 0, hostonlynet: 0, bridged: 1, natnetwork: 2, intnet: 3, nat: 4 };
    nets = [...nets].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
    const vms = state.machines.filter((m) => m.kind === 'vm');
    const W = Math.max(760, vms.length * 132 + 40), H = 380;
    const hubY = 170, vmY = 300, hostY = 52;
    const hubX = (i) => (W / (nets.length + 1)) * (i + 1);
    const vmX = (i) => 20 + (W - 40) / vms.length * (i + 0.5);
    const sub24 = (ip) => ip.split('.').slice(0, 3).join('.');
    const isLocal = (ip) => state.localIps.some((l) => sub24(l) === sub24(ip));
    const svg = NS('svg', { viewBox: `0 0 ${W} ${H}`, class: 'netmap-svg', width: W, height: H, role: 'img',
      'aria-label': 'Mapa de red: ' + nets.map((n) => `${n.type === 'nat' ? 'NAT' : nicLabel(n)} con ${n.members.map((m) => m.name).join(', ')}`).join('; ') + '. La vista Lista muestra lo mismo como texto.' });
    const links = NS('g', { class: 'links' });
    svg.append(links);
    // Equipo anfitrión, conectado a las redes que comparte con las VM.
    const hostNode = NS('g', { class: 'node host-node', 'data-open': 'host', tabindex: 0, role: 'button', 'aria-label': `${host.name}, este equipo. Ver detalles` },
      NS('rect', { x: W / 2 - 90, y: hostY - 24, width: 180, height: 48, rx: 12 }),
      NS('text', { x: W / 2, y: hostY - 2, class: 'n-name' }, host.name),
      NS('text', { x: W / 2, y: hostY + 14, class: 'n-sub' }, 'Este equipo'));
    nets.forEach((n, i) => {
      const x = hubX(i);
      const reach = ['hostonly', 'hostonlynet', 'bridged'].includes(n.type);
      if (reach || n.type === 'nat') {
        links.append(NS('path', { d: `M${W / 2} ${hostY + 24} C ${W / 2} ${hostY + 70}, ${x} ${hubY - 70}, ${x} ${hubY - 20}`,
          class: 'link host-link t-' + n.type + (n.type === 'nat' ? ' dashed' : '') }));
      }
      const label = n.type === 'nat' ? 'NAT' : nicLabel(n);
      const sub = n.type === 'nat' ? `${n.members.length} VM, cada una aislada` : n.type === 'intnet' ? 'sin acceso desde el equipo' : (n.target || '').replace('VirtualBox ', '').slice(0, 26);
      svg.append(NS('g', { class: 'hub t-' + n.type },
        NS('rect', { x: x - 82, y: hubY - 20, width: 164, height: 40, rx: 20 }),
        NS('text', { x, y: hubY - 2, class: 'h-name' }, label),
        NS('text', { x, y: hubY + 12, class: 'h-sub' }, sub)));
      // NAT no es una red compartida: cada VM tiene la suya. Se marca en la propia VM en vez de unirlas con líneas.
      if (n.type === 'nat') return;
      n.members.forEach((m) => {
        const vx = vmX(vms.indexOf(m));
        links.append(NS('path', { d: `M${x} ${hubY + 20} C ${x} ${hubY + 70}, ${vx} ${vmY - 80}, ${vx} ${vmY - 28}`,
          class: 'link t-' + n.type + (m.state === 'running' ? ' live' : ' idle') }));
      });
    });
    svg.append(hostNode);
    vms.forEach((m, i) => {
      const x = vmX(i);
      const ip = m.ips.find(isLocal) || (m.state === 'running' ? 'IP no visible' : 'Sin IP');
      svg.append(NS('g', { class: 'node vm-node s-' + m.state, 'data-open': m.id, tabindex: 0, role: 'button', 'aria-label': `${m.name}, ${m.stateLabel}. Ver detalles` },
        NS('rect', { x: x - 60, y: vmY - 28, width: 120, height: 64, rx: 12 }),
        NS('circle', { cx: x - 44, cy: vmY - 12, r: 4, class: 'st-dot' }),
        NS('text', { x: x + 4, y: vmY - 8, class: 'n-name' }, m.name.length > 15 ? m.name.slice(0, 14) + '…' : m.name),
        NS('text', { x, y: vmY + 10, class: 'n-sub' }, m.stateLabel),
        NS('text', { x, y: vmY + 26, class: 'n-ip' }, ip),
        m.nics.some((n) => n.type === 'nat') && NS('g', { class: 'nat-tag' },
          NS('rect', { x: x + 22, y: vmY - 40, width: 34, height: 16, rx: 8 }),
          NS('text', { x: x + 39, y: vmY - 28.5 }, 'NAT'))));
    });
    const legend = h('ul', { class: 'netmap-legend', 'aria-label': 'Leyenda del mapa' },
      ['hostonly', 'nat', 'intnet'].filter((t) => nets.some((n) => n.type === t)).map((t) => t === 'nat' ? h('li', { class: 't-nat' }, h('span', { class: 'lg-tag' }, 'NAT'), 'La VM tiene salida NAT propia (no comparte red con las demás)')
        : h('li', { class: 't-' + t }, h('span', { class: 'lg-line' }), NIC[t])),
      h('li', { class: 'lg-live' }, h('span', { class: 'lg-line' }), 'Línea gruesa: VM encendida'),
      h('li', null, 'Pulsa una máquina para ver sus detalles; pasa el ratón para un resumen.'));
    box.replaceChildren(h('div', { class: 'netmap-scroll' }, svg), legend);
  }
  $('red-mapa').addEventListener('click', () => { state.netView = 'map'; renderNetworks(); });
  $('red-lista').addEventListener('click', () => { state.netView = 'list'; renderNetworks(); });
  // Los nodos del mapa son elementos SVG con role=button: Enter o Espacio los abren como un clic.
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('g[data-open]')) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });

  function actRow(a, timeText) {
    return h('li', { class: 'a-' + a.type },
      h('button', { type: 'button', class: 'act-row', 'data-open': a.machine, 'aria-haspopup': 'dialog' },
        h('span', { class: 'act-ic' }, icon(ACT[a.type][0])),
        h('span', { class: 'act-t' }, h('span', { class: 'vh' }, ACT[a.type][1] + ': '), a.text,
          a.duration != null && h('span', { class: 'act-sub' }, 'Estado anterior durante ' + dur(a.duration))),
        h('time', { class: 'mono' }, timeText),
        icon('chevron', 'chev')));
  }

  function renderActivity() {
    const hi = state.histInfo;
    $('hist-foot').textContent = isLive()
      ? `Lo registra server.py cada ${state.ajustes.intervaloRegistroSegundos || 30} s mientras está abierto (aunque cierres el panel) en ${hi ? hi.file : 'data/nexo-historial.db'}. Solo guarda cuando algo cambia. Los periodos con el servidor cerrado aparecen como «Sin datos»: no se sabe qué pasó en ellos. Se conserva ${state.ajustes.diasRetencion || 30} días (diasRetencion en servicios.json).`
      : 'El historial guardado solo está disponible conectado a VirtualBox.';
    $('act').replaceChildren(...(state.vboxActivity.length
      ? state.vboxActivity.map((a) => actRow(a, a.when ? fmtDate.format(a.when) : a.time))
      : [h('li', { class: 'g-row empty-row' }, 'Sin actividad registrada')]));
    if (hi && hi.error) {
      $('historial').replaceChildren(h('li', { class: 'g-row hist-error' }, h('span', { class: 'g-l' }, h('span', { class: 'act-ic warn' }, icon('warn')), hi.error)));
      return;
    }
    const filtering = histActive();
    const evs = filtering ? state.histFiltered || [] : state.events.slice(0, 40);
    $('hf-conteo').textContent = filtering ? (state.histFiltered ? `${evs.length} eventos con estos filtros` : 'Buscando…') : '';
    $('historial').replaceChildren(...(evs.length
      ? evs.map((a) => h('li', { class: 'with-doc a-' + a.type },
          a.machine
            ? h('button', { type: 'button', class: 'act-row', 'data-open': a.machine, 'aria-haspopup': 'dialog' },
                h('span', { class: 'act-ic' }, icon(ACT[a.type][0])),
                h('span', { class: 'act-t' }, a.text, a.duration != null && h('span', { class: 'act-sub' }, 'Estado anterior durante ' + dur(a.duration))),
                h('time', { class: 'mono' }, fmtDate.format(a.when)), icon('chevron', 'chev'))
            : h('div', { class: 'act-row' }, h('span', { class: 'act-ic' }, icon(ACT[a.type][0])), h('span', { class: 'act-t' }, a.text), h('time', { class: 'mono' }, fmtDate.format(a.when))),
          docButton({ title: a.text, machine: a.machine, kind: a.kind, when: a.when, detail: a.detail })))
      : [h('li', { class: 'g-row empty-row' }, filtering ? 'Ningún evento coincide con los filtros.' : isLive()
          ? 'Todavía no hay cambios guardados. Aparecerán al encender, apagar o pausar una VM, o cuando cambie un servicio o una alerta.'
          : 'El historial solo funciona conectado a VirtualBox.')]));
  }

  const histActive = () => !!(state.hist.maquina || state.hist.tipo || state.hist.horas);
  function fillHistMachines() {
    const sel = $('hf-maquina');
    const opts = [['', 'Todas'], ...state.machines.map((m) => [m.id, m.name])];
    if (sel.options.length === opts.length && [...sel.options].every((o, i) => o.value === opts[i][0])) return;
    sel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = state.hist.maquina;
  }
  async function loadHistory() {
    if (!histActive() || !isLive()) { state.histFiltered = null; renderActivity(); return; }
    const p = new URLSearchParams({ limite: 500 });
    for (const [k, v] of Object.entries(state.hist)) if (v) p.set(k, v);
    try {
      const r = await fetch('/api/historial?' + p, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      state.histFiltered = fromEvents(d.events);
    } catch (err) {
      state.histFiltered = [];
      toast('No se pudo filtrar el historial: ' + (err.message || 'error'));
    }
    renderActivity();
  }
  for (const [id, key] of [['hf-maquina', 'maquina'], ['hf-tipo', 'tipo'], ['hf-horas', 'horas']]) {
    $(id).addEventListener('change', (e) => { state.hist[key] = e.target.value; state.histFiltered = null; renderActivity(); loadHistory(); });
  }

  function renderLegend() {
    $('leyenda').replaceChildren(
      ...Object.keys(STATES).map((k) => h('li', { class: 'g-row' }, pill({ state: k, stateLabel: STATES[k].label }), h('span', { class: 'g-v' }, STATES[k].hint))),
      ...Object.keys(SVC).map((k) => h('li', { class: 'g-row' },
        h('span', { class: 'svc v-' + k }, icon(SVC[k].icon), 'Servicio'),
        h('span', { class: 'g-v' }, { up: 'Respondió (TCP: aceptó la conexión; HTTP: contestó la aplicación)', down: 'No respondió, o la aplicación devolvió un error 5xx', pending: 'La VM acaba de arrancar; se volverá a comprobar', unchecked: 'No se pudo comprobar: VM apagada o sin IP alcanzable' }[k]))));
  }

  function render() {
    state.docs.clear();   // los botones «Documentar» se vuelven a crear en cada redibujado
    renderSource(); renderSummary(); renderHero(); renderAlerts(); fillHistMachines(); renderFilters(); renderList(); renderNetworks(); renderActivity();
    if (state.open && byId(state.open)) openDetail(state.open);
    else if (state.open && state.source !== 'loading') { if (sheet.open) sheet.close(); else { state.open = null; syncUrl(); } }
    if (exportDlg.open) updatePreview();
    if (histActive()) loadHistory();
    updateLive();
    refreshPeek();
    if (window.NEXO_CONTROL) window.NEXO_CONTROL.onData();
  }

  function toast(msg) {
    const t = $('aviso');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.id);
    toast.id = setTimeout(() => { t.hidden = true; }, 4500);
  }

  // ---------- exportar ----------
  const exportDlg = $('dlg-exportar');
  function buildReport() {
    const hideIp = $('e-ip').checked, hideHost = $('e-host').checked;
    const withSvc = $('e-svc').checked, withAlerts = $('e-alert').checked;
    const fmt = document.querySelector('input[name="e-fmt"]:checked').value;
    const host = state.machines.find((m) => m.kind === 'host');
    const ipRe = /\b\d{1,3}(\.\d{1,3}){3}\b/g;
    const priv = (text) => {
      let t = String(text ?? '');
      if (hideIp) t = t.replace(ipRe, '[IP oculta]');
      if (hideHost && host && host.name) t = t.split(host.name).join('Equipo principal');
      return t;
    };
    const generated = new Date();
    const machines = state.machines.map((m) => ({
      nombre: priv(m.name), tipo: m.kind === 'host' ? 'equipo físico' : 'máquina virtual', grupo: m.group || null,
      etiquetas: m.tags, estado: m.stateLabel, estadoVirtualBox: m.stateRaw, desde: m.since ? m.since.toISOString() : null,
      vcpu: m.vcpu, ramGB: Math.round(m.ramGB * 10) / 10, ip: m.ips.length ? priv(m.ips.join(', ')) : null,
      servicios: withSvc ? m.services.map((s) => ({ nombre: s.name, puerto: s.port, estado: SVC[s.status].label, detalle: priv(s.reason || '') })) : undefined
    }));
    const alerts = withAlerts ? state.alerts.map((a) => ({ texto: priv(a.text), comprobado: priv(a.check), hora: a.at ? a.at.toISOString() : null })) : undefined;
    const source = isLive() ? `VirtualBox ${state.vboxVersion} (solo lectura), leído a las ${fmtTime.format(state.fetchedAt)}` : 'Datos de ejemplo (modo demo): no corresponden a máquinas reales';
    if (fmt === 'json') {
      return { name: 'nexo-lab-reporte.json', type: 'application/json', text: JSON.stringify({ generado: generated.toISOString(), fuente: source, maquinas: machines, alertas: alerts }, null, 2) };
    }
    const count = (st) => state.machines.filter((m) => m.state === st).length;
    const cell = (v) => String(v ?? '').replace(/\|/g, '/');
    const lines = [
      '# Reporte de Nexo Lab', '',
      `Generado: ${fmtFull.format(generated)}  `, `Fuente: ${source}`, '',
      '## Resumen', '',
      `- Encendidas: ${count('running')} · En pausa: ${count('paused')} · Apagadas: ${count('stopped')} · Con problemas: ${count('alert')}`
    ];
    if (withSvc) {
      const svcs = state.machines.flatMap((m) => m.services);
      lines.push(`- Servicios: ${svcs.filter((s) => s.status === 'up').length} responden, ${svcs.filter((s) => s.status === 'down').length} no responden, ${svcs.filter((s) => s.status === 'unchecked' || s.status === 'pending').length} sin comprobar`);
    }
    if (withAlerts) {
      lines.push('', `## Alertas de salud (${alerts.length})`, '');
      lines.push(...(alerts.length ? alerts.map((a) => `- ${a.texto}. Comprobado: ${a.comprobado}`) : ['- Ninguna']));
    }
    lines.push('', '## Máquinas', '', '| Máquina | Grupo | Estado | Desde | vCPU | RAM | IP |', '|---|---|---|---|---|---|---|');
    for (const m of machines) {
      lines.push(`| ${cell(m.nombre)} | ${cell(m.grupo || '')} | ${cell(m.estado)} | ${m.desde ? fmtDate.format(new Date(m.desde)) : ''} | ${m.vcpu} | ${m.ramGB} GB | ${cell(m.ip || '')} |`);
    }
    if (withSvc) {
      lines.push('', '## Servicios', '', '| Máquina | Servicio | Puerto | Estado | Detalle |', '|---|---|---|---|---|');
      for (const m of machines) for (const s of m.servicios) lines.push(`| ${cell(m.nombre)} | ${cell(s.nombre)} | ${s.puerto} | ${s.estado} | ${cell(s.detalle)} |`);
    }
    lines.push('', '---', 'Este reporte es de solo lectura: se generó sin ejecutar acciones de Control. El uso de CPU y memoria por VM no está disponible sin activar las métricas de VirtualBox.');
    return { name: 'nexo-lab-reporte.md', type: 'text/markdown', text: lines.join('\n') + '\n' };
  }
  function updatePreview() { $('e-vista').value = buildReport().text; }
  $('exportar').addEventListener('click', () => { updatePreview(); exportDlg.showModal(); });
  $('e-cerrar').addEventListener('click', () => exportDlg.close());
  exportDlg.addEventListener('change', updatePreview);
  exportDlg.addEventListener('close', () => $('exportar').focus());
  $('e-descargar').addEventListener('click', () => {
    const r = buildReport();
    const url = URL.createObjectURL(new Blob([r.text], { type: r.type + ';charset=utf-8' }));
    const a = h('a', { href: url, download: r.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Reporte guardado como ' + r.name + ' en tu carpeta de descargas.');
  });
  $('e-copiar').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(buildReport().text); toast('Reporte copiado al portapapeles.'); }
    catch { $('e-vista').select(); toast('No se pudo copiar automáticamente: el texto quedó seleccionado, usa Ctrl+C.'); }
  });

  // ---------- vista previa al pasar el ratón (o al enfocar con el teclado) ----------
  // Muestra un resumen en vivo de la máquina sin hacer clic. No es interactiva: el clic sigue abriendo la hoja.
  const peek = h('div', { class: 'peek', id: 'peek', role: 'tooltip', hidden: '' });
  document.body.append(peek);
  const PEEK_HOSTS = '.machine, .row, .net-row, .act-row, .alert-row';
  let peekTimer = null, peekId = null, peekAnchor = null;

  function peekContent(m) {
    const up = m.services.filter((s) => s.status === 'up').length;
    const checked = m.services.filter((s) => s.status === 'up' || s.status === 'down').length;
    return clean([
      h('div', { class: 'peek-head' }, kindIcon(m),
        h('div', { class: 'peek-id' }, h('strong', null, m.name), h('span', null, m.os)), pill(m)),
      liveOn(m) ? perf(m) : h('p', { class: 'peek-line' }, m.kind === 'vm'
        ? `${m.stateLabel}${m.since ? ' ' + ago(m.since) : ''} · ${m.vcpu} vCPU · ${gb(m.ramGB)} RAM asignados`
        : 'Sin datos en vivo'),
      h('dl', { class: 'peek-facts' }, clean([
        h('dt', null, 'IP'), h('dd', { class: 'mono', translate: 'no' }, ipText(m)),
        m.group && [h('dt', null, 'Grupo'), h('dd', null, m.group + (m.tags.length ? ' · ' + m.tags.join(', ') : ''))],
        m.kind === 'vm' && liveOn(m) && [h('dt', null, 'E/S'), h('dd', { class: 'mono', 'data-io-id': m.id }, ioText(m.io))],
        m.services.length > 0 && [h('dt', null, 'Servicios'), h('dd', null, checked ? `${up} de ${checked} responden` : 'Sin comprobar')]
      ])),
      m.services.length > 0 && h('ul', { class: 'svcs' }, m.services.map((s) => svcChip(s, m))),
      state.alerts.filter((a) => a.machine === m.id).map((a) => h('p', { class: 'peek-alert' }, icon('warn'), a.text)),
      h('p', { class: 'peek-hint' }, 'Clic para ver todos los detalles')
    ]);
  }

  function placePeek() {
    if (!peekAnchor) return;
    const box = (peekAnchor.closest(PEEK_HOSTS) || peekAnchor).getBoundingClientRect();
    const pw = peek.offsetWidth, ph = peek.offsetHeight, gap = 10, vw = innerWidth, vh = innerHeight;
    let x = box.right + gap, y = box.top;
    if (x + pw > vw - 8) x = box.left - pw - gap;                 // a la izquierda si no cabe
    if (x < 8) { x = Math.min(Math.max(8, box.left), vw - pw - 8); y = box.bottom + gap; }  // debajo como último recurso
    // Siempre dentro de la ventana, alineada con la parte visible del elemento.
    y = Math.min(Math.max(y, 8), vh - ph - 8);
    x = Math.min(Math.max(x, 8), vw - pw - 8);
    peek.style.left = Math.round(x) + 'px';
    peek.style.top = Math.round(Math.max(8, y)) + 'px';
  }

  function showPeek(anchor) {
    const m = byId(anchor.dataset.open);
    if (!m || sheet.open || exportDlg.open) return;
    peekId = m.id; peekAnchor = anchor;
    peek.replaceChildren(...peekContent(m));
    peek.hidden = false;
    placePeek();
    anchor.setAttribute('aria-describedby', 'peek');
  }
  function hidePeek() {
    clearTimeout(peekTimer);
    peek.hidden = true;
    if (peekAnchor) peekAnchor.removeAttribute('aria-describedby');
    peekId = null; peekAnchor = null;
  }
  // Tras redibujar (cada 10 s) el elemento original desaparece: se busca su sustituto en el mismo tipo de bloque.
  function refreshPeek() {
    if (!peekId) return;
    if (!document.contains(peekAnchor)) {
      const host = peekAnchor.closest(PEEK_HOSTS);
      const sel = host ? '.' + host.classList[0] : '';
      peekAnchor = [...document.querySelectorAll(`[data-open="${CSS.escape(peekId)}"]`)].find((a) => !sel || a.closest(sel)) || null;
      if (!peekAnchor) { hidePeek(); return; }
    }
    const m = byId(peekId);
    if (!m) { hidePeek(); return; }
    peek.replaceChildren(...peekContent(m));
    placePeek();
  }

  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse' || !finePointer.matches) return;
    const a = e.target.closest('[data-open]');
    if (!a || a.closest('dialog')) return;
    if (a === peekAnchor) { clearTimeout(peekTimer); return; }
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => showPeek(a), peekAnchor ? 80 : 350);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const from = e.target.closest('[data-open]');
    const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-open]');
    if (from && from !== to) { clearTimeout(peekTimer); peekTimer = setTimeout(hidePeek, 120); }
  });
  document.addEventListener('focusin', (e) => {
    const a = e.target.closest && e.target.closest('[data-open]');
    if (a && !a.closest('dialog') && a.matches(':focus-visible')) showPeek(a); else if (!a) hidePeek();
  });
  document.addEventListener('focusout', (e) => { if (e.target === peekAnchor) hidePeek(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !peek.hidden) hidePeek(); });
  document.addEventListener('scroll', () => { if (!peek.hidden) placePeek(); }, { passive: true, capture: true });
  addEventListener('resize', () => { if (!peek.hidden) placePeek(); });
  document.addEventListener('click', hidePeek, true);

  // ---------- configurar servicios y umbrales (escribe servicios.json tras confirmar) ----------
  const cfgDlg = $('dlg-config');
  const AJ_INFO = {
    avisoMemoriaEquipo: ['Memoria del equipo', '%', 'Avisar cuando la memoria del PC supere este porcentaje…'],
    minutosMemoriaAlta: ['…durante', 'min', 'Minutos seguidos por encima del umbral antes de avisar (0 = al momento).'],
    avisoCpuEquipo: ['CPU del equipo', '%', 'Avisar cuando la CPU del PC supere este porcentaje…'],
    minutosCpuAlta: ['…durante', 'min', 'Minutos seguidos por encima del umbral antes de avisar.'],
    avisarInterrumpidaTrasDias: ['VM interrumpida', 'días', 'Días en estado interrumpido antes de avisar.'],
    graciaArranqueSegundos: ['Gracia tras arrancar', 's', 'Tiempo tras encender una VM sin avisar de servicios caídos.'],
    tiempoLimiteSegundos: ['Tiempo de espera', 's', 'Cuánto esperar la respuesta de cada servicio.'],
    intervaloRegistroSegundos: ['Registro del historial', 's', 'Cada cuánto comprueba y guarda el servidor (aunque el panel esté cerrado).'],
    diasRetencion: ['Retención del historial', 'días', 'Días que se conservan eventos y muestras.']
  };
  let cfgOriginal = null, cfgLimits = {};

  function svcRow(sv) {
    const row = h('div', { class: 'svc-row' },
      h('label', null, h('span', { class: 'vh' }, 'Nombre del servicio'), h('input', { type: 'text', class: 'f-nombre', value: sv.nombre || '', placeholder: 'Nombre (p. ej. SSH)', maxlength: 40, required: '' })),
      h('label', null, h('span', { class: 'vh' }, 'Puerto'), h('input', { type: 'number', class: 'f-puerto', value: sv.puerto || '', placeholder: 'Puerto', min: 1, max: 65535, inputmode: 'numeric', required: '' })),
      h('label', null, h('span', { class: 'vh' }, 'Tipo de comprobación'),
        h('select', { class: 'f-tipo' }, ['tcp', 'http', 'https'].map((t) => h('option', { value: t }, t.toUpperCase())))),
      h('label', null, h('span', { class: 'vh' }, 'Ruta HTTP'), h('input', { type: 'text', class: 'f-ruta', value: sv.ruta || '/', placeholder: '/', maxlength: 200 })),
      h('button', { type: 'button', class: 'btn plain del-svc', 'aria-label': 'Quitar servicio ' + (sv.nombre || '') }, icon('x')));
    row.querySelector('.f-tipo').value = sv.tipo || 'tcp';
    const syncRuta = () => { row.querySelector('.f-ruta').disabled = row.querySelector('.f-tipo').value === 'tcp'; };
    row.querySelector('.f-tipo').addEventListener('change', syncRuta);
    syncRuta();
    row.querySelector('.del-svc').addEventListener('click', () => row.remove());
    return row;
  }

  function buildCfgForm(cfg) {
    const form = $('c-form');
    const names = [...new Set([...state.machines.filter((m) => m.kind === 'vm').map((m) => m.name), ...Object.keys(cfg.maquinas).filter((n) => n !== 'host')])];
    const thr = h('fieldset', { class: 'cfg-block' }, h('legend', null, 'Umbrales de alertas y registro'),
      h('div', { class: 'thr-grid' }, Object.entries(AJ_INFO).map(([k, [label, unit, help]]) => {
        const [lo, hi] = cfgLimits[k] || [0, 9999];
        return h('label', { class: 'thr' }, h('span', { class: 'thr-l' }, label),
          h('span', { class: 'thr-in' }, h('input', { type: 'number', name: k, value: cfg.ajustes[k], min: lo, max: hi, step: k === 'tiempoLimiteSegundos' ? 0.1 : 1, required: '' }), h('span', { class: 'unit' }, unit)),
          h('span', { class: 'thr-h' }, `${help} (${lo}-${hi})`));
      })));
    const machines = names.map((name) => {
      const c = cfg.maquinas[name] || {};
      const list = h('div', { class: 'svc-list' }, (c.servicios || []).map(svcRow));
      const add = h('button', { type: 'button', class: 'btn plain add-svc' }, '+ Añadir servicio');
      add.addEventListener('click', () => { const r = svcRow({ tipo: 'tcp' }); list.append(r); r.querySelector('.f-nombre').focus(); });
      return h('fieldset', { class: 'cfg-block cfg-vm', 'data-name': name }, h('legend', null, name),
        h('div', { class: 'vm-meta' },
          h('label', null, 'Grupo', h('input', { type: 'text', class: 'f-grupo', value: c.grupo || '', maxlength: 40, placeholder: 'p. ej. Seguridad' })),
          h('label', null, 'Etiquetas (separadas por comas)', h('input', { type: 'text', class: 'f-etiquetas', value: (c.etiquetas || []).join(', '), placeholder: 'p. ej. Linux, SIEM' }))),
        h('p', { class: 'svc-head', 'aria-hidden': 'true' }, h('span', null, 'Servicio'), h('span', null, 'Puerto'), h('span', null, 'Tipo'), h('span', null, 'Ruta (HTTP)')),
        list, add);
    });
    const hostC = cfg.maquinas.host || {};
    form.replaceChildren(thr, h('fieldset', { class: 'cfg-block', 'data-name': 'host' }, h('legend', null, 'Equipo principal'),
      h('div', { class: 'vm-meta' },
        h('label', null, 'Grupo', h('input', { type: 'text', class: 'f-grupo', value: hostC.grupo || '', maxlength: 40 })),
        h('label', null, 'Etiquetas (separadas por comas)', h('input', { type: 'text', class: 'f-etiquetas', value: (hostC.etiquetas || []).join(', ') })))),
      h('p', { class: 'g-foot' }, 'TCP comprueba que el puerto acepta la conexión. HTTP/HTTPS hace un GET sin credenciales a la ruta y confirma que la aplicación contesta. Solo se comprueban IPs de tus VM encendidas.'),
      ...machines);
  }

  function readCfgForm() {
    const form = $('c-form');
    const ajustes = {};
    for (const k of Object.keys(AJ_INFO)) ajustes[k] = Number(form.querySelector(`[name="${k}"]`).value);
    const maquinas = {};
    form.querySelectorAll('fieldset[data-name]').forEach((fs) => {
      const item = {};
      const grupo = fs.querySelector('.f-grupo').value.trim();
      const tags = fs.querySelector('.f-etiquetas').value.split(',').map((t) => t.trim()).filter(Boolean);
      if (grupo) item.grupo = grupo;
      if (tags.length) item.etiquetas = tags;
      const svcs = [...fs.querySelectorAll('.svc-row')].map((r) => {
        const sv = { nombre: r.querySelector('.f-nombre').value.trim(), puerto: Number(r.querySelector('.f-puerto').value), tipo: r.querySelector('.f-tipo').value };
        if (sv.tipo !== 'tcp') sv.ruta = r.querySelector('.f-ruta').value.trim() || '/';
        return sv;
      });
      if (svcs.length) item.servicios = svcs;
      maquinas[fs.dataset.name] = item;
    });
    return { ajustes, maquinas };
  }

  // Resumen legible de lo que cambiará (y validación básica antes de enviar).
  function diffCfg(a, b) {
    const out = [];
    for (const k of Object.keys(AJ_INFO)) {
      if (Number(a.ajustes[k]) !== Number(b.ajustes[k])) out.push(`${AJ_INFO[k][0].replace('…', '')} (${k}): ${a.ajustes[k]} → ${b.ajustes[k]} ${AJ_INFO[k][1]}`);
    }
    const names = new Set([...Object.keys(a.maquinas), ...Object.keys(b.maquinas)]);
    const key = (s) => `${s.nombre}|${s.puerto}|${s.tipo || 'tcp'}|${s.tipo && s.tipo !== 'tcp' ? s.ruta || '/' : ''}`;
    const fmt = (s) => `${s.nombre} (${s.puerto}, ${(s.tipo || 'tcp').toUpperCase()}${s.tipo && s.tipo !== 'tcp' ? ' ' + (s.ruta || '/') : ''})`;
    for (const n of names) {
      const x = a.maquinas[n] || {}, y = b.maquinas[n] || {};
      const label = n === 'host' ? 'Equipo principal' : n;
      if ((x.grupo || '') !== (y.grupo || '')) out.push(`${label}: grupo «${x.grupo || '-'}» → «${y.grupo || '-'}»`);
      if ((x.etiquetas || []).join(',') !== (y.etiquetas || []).join(',')) out.push(`${label}: etiquetas «${(x.etiquetas || []).join(', ') || '-'}» → «${(y.etiquetas || []).join(', ') || '-'}»`);
      const xs = new Map((x.servicios || []).map((s) => [key(s), s])), ys = new Map((y.servicios || []).map((s) => [key(s), s]));
      for (const [k, s] of ys) if (!xs.has(k)) out.push(`${label}: añadir ${fmt(s)}`);
      for (const [k, s] of xs) if (!ys.has(k)) out.push(`${label}: quitar ${fmt(s)}`);
    }
    return out;
  }
  function checkCfg(c) {
    for (const [k, [lo, hi]] of Object.entries(cfgLimits)) {
      if (!(c.ajustes[k] >= lo && c.ajustes[k] <= hi)) return `«${AJ_INFO[k] ? AJ_INFO[k][0].replace('…', '') : k}» debe estar entre ${lo} y ${hi}.`;
    }
    for (const [n, m] of Object.entries(c.maquinas)) for (const s of m.servicios || []) {
      if (!s.nombre) return `${n}: hay un servicio sin nombre.`;
      if (!(s.puerto >= 1 && s.puerto <= 65535)) return `${n}: el puerto de «${s.nombre}» debe estar entre 1 y 65535.`;
      if (s.tipo !== 'tcp' && !/^\/\S*$/.test(s.ruta || '/')) return `${n}: la ruta de «${s.nombre}» debe empezar por / y no tener espacios.`;
    }
    return null;
  }

  async function openConfig() {
    if (!isLive()) { toast('La configuración se edita con el servidor local en marcha (abre el panel con iniciar.bat).'); return; }
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      if (d.error) throw new Error(d.error + ' Corrígelo a mano antes de editarlo desde el panel.');
      cfgOriginal = d.config; cfgLimits = d.limits;
      buildCfgForm(cfgOriginal);
      $('c-confirmar').hidden = true; $('c-acciones').hidden = false; $('c-error').hidden = true;
      hidePeek();
      cfgDlg.showModal();
    } catch (err) { toast('No se pudo abrir la configuración: ' + (err.message || 'error')); }
  }
  $('configurar').addEventListener('click', openConfig);
  $('c-cerrar').addEventListener('click', () => cfgDlg.close());
  cfgDlg.addEventListener('close', () => $('configurar').focus());
  $('c-revisar').addEventListener('click', () => {
    const next = readCfgForm();
    const err = checkCfg(next);
    $('c-error').hidden = !err;
    $('c-error').textContent = err || '';
    if (err) return;
    const changes = diffCfg(cfgOriginal, next);
    if (!changes.length) { $('c-error').hidden = false; $('c-error').textContent = 'No hay cambios que guardar.'; return; }
    $('c-cambios').replaceChildren(...changes.map((c) => h('li', null, c)));
    $('c-confirmar').hidden = false; $('c-acciones').hidden = true;
    $('c-guardar').focus();
  });
  $('c-volver').addEventListener('click', () => { $('c-confirmar').hidden = true; $('c-acciones').hidden = false; });
  $('c-guardar').addEventListener('click', async () => {
    const b = $('c-guardar');
    b.disabled = true;
    try {
      const res = await postJson('/api/config', { config: readCfgForm() });
      cfgDlg.close();
      toast('Configuración guardada.' + (res.backup ? ' Copia anterior: ' + res.backup : ''));
      await load(false);
    } catch (err) {
      $('c-error').hidden = false;
      $('c-error').textContent = 'No se guardó: ' + err.message;
    }
    b.disabled = false;
  });

  // ---------- eventos ----------
  $('buscar').addEventListener('input', (e) => { state.query = e.target.value.trim(); renderList(); });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const anyOpen = sheet.open || exportDlg.open || noteDlg.open || cfgDlg.open || guideDlg.open;
    if (e.key === '/' && !typing && !anyOpen && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); $('buscar').focus(); }
  });
  $('buscar').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('buscar').value) { $('buscar').value = ''; state.query = ''; renderList(); }
  });

  function setView(v) {
    state.view = v;
    $('v-tarjetas').setAttribute('aria-pressed', String(v === 'cards'));
    $('v-lista').setAttribute('aria-pressed', String(v === 'list'));
    renderList();
  }
  $('v-tarjetas').addEventListener('click', () => setView('cards'));
  $('v-lista').addEventListener('click', () => setView('list'));

  $('actualizar').addEventListener('click', async () => {
    const b = $('actualizar');
    b.disabled = true; b.setAttribute('aria-busy', 'true');
    await load(true);
    b.disabled = false; b.removeAttribute('aria-busy');
  });

  // Consulta periódica solo con la pestaña visible.
  setInterval(() => { if (!document.hidden && state.source !== 'demo') load(false); }, POLL_MS);
  setInterval(pollMetrics, RT_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && isLive()) load(false); });

  if ('IntersectionObserver' in window) {
    const links = [...document.querySelectorAll('nav a')];
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => (a.getAttribute('href') === '#' + e.target.id ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
      }
    }, { rootMargin: '-20% 0px -60% 0px' });
    ['resumen', 'alertas', 'maquinas', 'red', 'actividad', 'control'].forEach((id) => $(id) && io.observe($(id)));
  }

  // Utilidades que usa js/control.js (sección «Control», separada de la lectura).
  window.NEXO_APP = { h, icon, clean, toast, state, isLive, fmtTime, fmtFull, reload: (force) => load(false, force),
    closeGuide: () => guideDlg.open && guideDlg.close(), openDetail: (id) => openDetail(id), openGuide: (key) => openGuide(key),
    setView: (v) => setView(v), alertInfo: (a) => ({ ...(ALERT_CAT[a.cat] || ALERT_CAT.config), sevLabel: SEV[(ALERT_CAT[a.cat] || ALERT_CAT.config).sev] }) };
  document.querySelectorAll('nav a[data-icon]').forEach((a) => a.prepend(icon(a.dataset.icon)));
  $('buscar').value = state.query;
  $('v-tarjetas').setAttribute('aria-pressed', String(state.view === 'cards'));
  $('v-lista').setAttribute('aria-pressed', String(state.view === 'list'));
  renderLegend();
  render();
  load(false);
})();
