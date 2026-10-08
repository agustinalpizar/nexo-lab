// Nexo Lab · sección «Control»: acciones que CAMBIAN el laboratorio.
// Separada de app.js (lectura). Nada se ejecuta sin pasar por el servidor (catálogo fijo, ticket de un solo
// uso) y por la confirmación de esta hoja. Todo el texto que llega de datos se inserta con textContent.
(function () {
  'use strict';
  const A = window.NEXO_APP;
  if (!A) return;
  const { h, icon, clean, toast, fmtTime } = A;
  const $ = (id) => document.getElementById(id);
  const dlg = $('dlg-accion');

  const ctl = { data: null, error: null, lastFetch: 0, loading: false, ad: { tipo: 'users', q: '', items: null, sel: null, msg: '', busy: false },
    assist: { alert: '', packet: null, proposal: null, msg: '' }, log: [] };

  // ---------- comunicación con el servidor ----------
  async function api(url, body) {
    const opts = { cache: 'no-store', headers: { 'X-Nexo-Token': ctl.data ? ctl.data.token : '' } };
    if (body) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    const d = await r.json().catch(() => ({ error: 'Respuesta no válida del servidor' }));
    if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
    return d;
  }

  async function refresh(force) {
    if (!A.isLive()) { ctl.data = null; render(); return; }
    if (ctl.loading || (!force && Date.now() - ctl.lastFetch < 8000)) return;
    ctl.loading = true;
    try {
      const r = await fetch('/api/control', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
      ctl.data = d; ctl.error = null; ctl.lastFetch = Date.now();
      const lg = await api('/api/control/registro').catch(() => null);
      if (lg) { ctl.log = lg.items; ctl.logFile = lg.file; }
    } catch (e) {
      ctl.error = 'No se pudo leer el estado de Control: ' + e.message;
    }
    ctl.loading = false;
    render();
  }

  // ---------- piezas ----------
  const row = (label, value, cls) => h('li', { class: 'g-row' + (cls ? ' ' + cls : '') }, h('span', { class: 'g-l' }, label), h('span', { class: 'g-v' }, value));
  const why = (text) => text && h('p', { class: 'ctl-why' }, icon('info'), h('span', null, text));
  const note = (cls, ic, ...kids) => h('p', { class: cls }, icon(ic), h('span', null, ...kids));
  const stateText = { running: 'Encendida', poweroff: 'Apagada', saved: 'Guardada', paused: 'En pausa', aborted: 'Interrumpida', 'aborted-saved': 'Interrumpida', starting: 'Arrancando' };
  function actBtn(label, enabled, onClick, kind) {
    const b = h('button', { type: 'button', class: 'btn' + (kind ? ' ' + kind : ''), 'aria-haspopup': 'dialog' }, label);
    b.disabled = !enabled;
    if (enabled) b.addEventListener('click', onClick);
    return b;
  }
  const mech = (ok, title, detail, reason) => h('li', { class: 'g-row mech ' + (ok ? 'on' : 'off') },
    h('span', { class: 'mech-ic' }, icon(ok ? 'check' : 'minus')),
    h('span', { class: 'mech-t' }, h('strong', null, title), h('span', { class: 'mech-d' }, ok ? detail : reason)));

  function render() {
    const banner = $('ctl-banner'), body = $('ctl-cuerpo');
    const d = ctl.data;
    if (!A.isLive() || !d) {
      banner.className = 'ctl-banner off';
      banner.textContent = !A.isLive()
        ? 'Control necesita el servidor local con datos reales de VirtualBox (abre el panel con iniciar.bat). En modo demo no hay acciones.'
        : (ctl.error || 'Consultando qué acciones están disponibles…');
      body.hidden = true;
      return;
    }
    body.hidden = false;
    banner.className = 'ctl-banner ' + (d.simulado ? 'sim' : 'live');
    banner.replaceChildren(...clean([
      d.simulado ? h('strong', null, 'MODO SIMULACIÓN: ') : h('strong', null, 'Acciones reales. '),
      d.simulado ? 'las acciones se simulan y no cambian VirtualBox, Active Directory ni servicios. '
        : 'Lo que confirmes aquí cambia tu laboratorio. ',
      `Sesión local: ${d.usuario} · ${d.sesion}.`,
      d.configError && h('span', { class: 'ctl-err' }, ' ' + d.configError)
    ]));
    // Solo se redibuja lo que cambió: así no se pierde lo que estás escribiendo ni el foco al actualizar.
    const a = ctl.ad, s = ctl.assist;
    put('mec', [d.ad, d.correcciones], () => renderMechanisms(d));
    put('vms', d.vms, () => renderVms(d));
    put('ad', [d.ad, a.tipo, a.items, a.sel, a.msg, a.busy], () => renderAd(d));
    put('fix', d.fixes, () => renderFixes(d));
    put('as', [(A.state.alerts || []).map((x) => [x.key, x.text]), s.alert, s.packet && s.packet.texto, s.proposal, s.msg], () => renderAssistant(d));
    put('log', [ctl.log, ctl.logFile], renderLog);
  }
  const sigs = {};
  function put(id, value, fn) {
    const sig = JSON.stringify(value);
    if (sigs[id] === sig) return;
    sigs[id] = sig;
    fn();
  }

  function renderMechanisms(d) {
    const corr = Object.entries(d.correcciones);
    $('ctl-mecanismos').replaceChildren(
      mech(true, 'VirtualBox: encender y apagado normal', 'Con VBoxManage en este equipo, solo para las VM listadas en control.json.'),
      mech(d.ad.disponible, 'Active Directory en ' + (d.ad.vm || 'DC01'),
        `LDAP firmado y cifrado contra ${d.ad.servidor} con la credencial de Windows «${d.ad.credencial}» (${d.ad.usuarioCredencial || '?'}).`,
        d.ad.motivo),
      ...corr.map(([vm, c]) => mech(c.disponible, `Servicios en ${vm} (${c.metodo === 'winrm' ? 'WinRM' : 'SSH'})`,
        `${c.via}. Servicios permitidos: ${[...new Set(Object.values(c.servicios))].join(', ')}.`, c.motivo)),
      mech(true, 'Asistente (Hermes u OpenCode)', 'Por intercambio manual: tú copias los datos de la alerta y pegas su propuesta. El panel no envía nada a ningún modelo ni le da acceso al sistema.')
    );
  }

  function renderVms(d) {
    $('ctl-vms').replaceChildren(...d.vms.map((v) => {
      const startWhy = v.rules['vm.start'], stopWhy = v.rules['vm.shutdown'];
      return h('li', { class: 'g-row ctl-vm' + (v.inLab ? '' : ' out') },
        h('span', { class: 'ctl-vm-t' }, h('strong', null, v.name),
          h('span', { class: 'ctl-sub' }, (stateText[v.state] || v.state) + (v.inLab ? '' : ' · fuera del laboratorio') + (v.busy ? ' · acción en curso' : ''))),
        h('span', { class: 'ctl-btns' },
          actBtn('Encender…', !startWhy, () => openAction({ action_id: 'vm.start', objetivo: { vm: v.id }, parametros: { modo: 'gui' } })),
          actBtn('Pausar…', !v.rules['vm.pause'], () => openAction({ action_id: 'vm.pause', objetivo: { vm: v.id } })),
          actBtn('Reanudar…', !v.rules['vm.resume'], () => openAction({ action_id: 'vm.resume', objetivo: { vm: v.id } })),
          actBtn('Guardar estado…', !v.rules['vm.savestate'], () => openAction({ action_id: 'vm.savestate', objetivo: { vm: v.id } })),
          actBtn('Apagar…', !stopWhy, () => openAction({ action_id: 'vm.shutdown', objetivo: { vm: v.id } }))));
    }));
  }

  // ---------- Active Directory ----------
  function renderAd(d) {
    const box = $('ctl-ad');
    const ad = ctl.ad;
    const parts = [];
    parts.push(note('ctl-scope', 'info',
      'Consultar es solo lectura. Desbloquear, habilitar, deshabilitar y restablecer cambian la cuenta y se confirman una a una. ',
      'No hay borrado, cambios de directivas ni acciones masivas.'));
    if (!d.ad.disponible) {
      parts.push(h('div', { class: 'ctl-off' }, h('strong', null, 'Active Directory no está disponible. '), d.ad.motivo));
      box.replaceChildren(...parts);
      return;
    }
    if (d.ad.avisoCuenta) parts.push(note('ctl-warn', 'warn', d.ad.avisoCuenta));
    parts.push(h('p', { class: 'ctl-sub' }, d.ad.ouPermitidas.length
      ? 'Cambios permitidos solo en: ' + d.ad.ouPermitidas.join(' · ')
      : 'Sin OU permitidas en control.json: puedes consultar, pero los cambios quedan deshabilitados.'));
    const sel = h('select', { id: 'ad-tipo', 'aria-label': 'Qué buscar' },
      h('option', { value: 'users' }, 'Usuarios'), h('option', { value: 'groups' }, 'Grupos'), h('option', { value: 'computers' }, 'Equipos'));
    sel.value = ad.tipo;
    const input = h('input', { id: 'ad-q', type: 'search', autocomplete: 'off', placeholder: 'Nombre o cuenta…', maxlength: '64', 'aria-label': 'Nombre o cuenta' });
    input.value = ad.q;
    input.addEventListener('input', () => { ad.q = input.value; });
    const go = h('button', { type: 'submit', class: 'btn primary' }, 'Buscar');
    go.disabled = ad.busy;
    const form = h('form', { class: 'ad-form', role: 'search' }, sel, input, go);
    sel.addEventListener('change', () => { ad.tipo = sel.value; });
    form.addEventListener('submit', (e) => { e.preventDefault(); ad.tipo = sel.value; ad.q = input.value.trim(); adSearch(); });
    parts.push(form);
    parts.push(h('p', { class: 'ad-msg', role: 'status', 'aria-live': 'polite' }, ad.msg));
    if (ad.items) {
      parts.push(h('ul', { class: 'group ad-list' }, ad.items.length ? ad.items.map((it) => h('li', null,
        h('button', { type: 'button', class: 'ad-row' + (ad.sel && ad.sel.sam === it.sam ? ' sel' : '') },
          h('span', { class: 'ad-n' }, h('strong', null, it.name), h('span', { class: 'mono ctl-sub' }, it.sam)),
          h('span', { class: 'ad-flags' }, clean([
            it.enabled === false && h('span', { class: 'flag off' }, 'Deshabilitada'),
            (it.locked || it.lockedHint) && h('span', { class: 'flag warn' }, 'Bloqueada'),
            it.privileged && h('span', { class: 'flag priv' }, 'Privilegiada'),
            it.os && h('span', { class: 'flag' }, it.os)])),
          icon('chevron', 'chev')))) : [h('li', { class: 'g-row' }, 'Sin resultados.')]));
      parts.at(-1).querySelectorAll('.ad-row').forEach((b, i) => b.addEventListener('click', () => adOpen(ad.items[i].sam)));
    }
    if (ad.sel) parts.push(adDetail(ad.sel));
    box.replaceChildren(...parts);
  }

  async function adSearch() {
    const ad = ctl.ad;
    if (!ad.q) { ad.msg = 'Escribe un nombre o una cuenta.'; render(); return; }
    ad.busy = true; ad.msg = 'Consultando Active Directory…'; ad.sel = null; render();
    try {
      const r = await api(`/api/ad/buscar?tipo=${encodeURIComponent(ad.tipo)}&q=${encodeURIComponent(ad.q)}`);
      ad.items = r.items;
      ad.msg = `${r.items.length} resultado${r.items.length === 1 ? '' : 's'} (máximo 50) · ${fmtTime.format(new Date())}`;
    } catch (e) {
      ad.items = null;
      ad.msg = 'La consulta falló: ' + e.message;
    }
    ad.busy = false; render();
    const q = $('ad-q'); if (q) q.focus();
  }

  async function adOpen(sam) {
    const ad = ctl.ad;
    ad.msg = 'Leyendo la cuenta…'; render();
    try {
      ad.sel = (await api('/api/ad/cuenta?cuenta=' + encodeURIComponent(sam))).item;
      ad.msg = `Datos leídos de Active Directory a las ${fmtTime.format(new Date())}.`;
    } catch (e) {
      ad.sel = null; ad.msg = 'No se pudo leer la cuenta: ' + e.message;
    }
    render();
    const det = document.querySelector('.ad-detail'); if (det) det.scrollIntoView({ block: 'nearest' });
  }

  const KIND = { user: 'Usuario', group: 'Grupo', computer: 'Equipo' };
  const dt = (iso) => (iso ? A.fmtFull.format(new Date(iso)) : 'Nunca o desconocido');
  function adDetail(it) {
    const acts = it.actions || {};
    const btn = (id, label, cls) => {
      const w = acts[id];
      return h('div', { class: 'ad-act' }, actBtn(label, !w, () => openAction({ action_id: id, parametros: { cuenta: it.sam } }), cls), why(w));
    };
    return h('div', { class: 'ad-detail' + (it.privileged ? ' priv' : '') },
      h('h4', null, it.name, ' ', h('span', { class: 'mono ctl-sub' }, it.sam)),
      it.privileged && note('ctl-warn', 'warn', 'Cuenta privilegiada: ' + (it.privilegedBy || []).join(', ') + '. Cualquier cambio exige escribir su nombre para confirmar; deshabilitarla o restablecer su contraseña no está permitido en esta versión.'),
      h('ul', { class: 'group' }, clean([
        row('Tipo', KIND[it.kind] || it.kind),
        row('Ubicación', h('span', { class: 'mono' }, it.dn)),
        it.kind !== 'group' && row('Estado', it.enabled ? 'Habilitada' : 'Deshabilitada'),
        it.kind === 'user' && row('Bloqueo', it.locked ? 'Bloqueada por intentos fallidos' : 'No bloqueada'),
        it.kind === 'user' && row('Contraseña', it.mustChange ? 'Debe cambiarla al iniciar sesión' : it.pwdExpired ? 'Caducada' : 'Último cambio: ' + dt(it.pwdLastSet)),
        it.kind !== 'group' && row('Último inicio de sesión', dt(it.lastLogon) + ' (aprox., se replica cada ~14 días)'),
        it.kind === 'user' && row('Grupos', (it.groups || []).join(', ') || 'Ninguno directo'),
        it.kind === 'group' && row('Miembros', `${(it.members || []).join(', ') || 'Ninguno'}${it.memberCount > 50 ? ` (y ${it.memberCount - 50} más)` : ''}`),
        it.kind === 'computer' && row('Sistema', it.os || '?'),
        it.description && row('Descripción', it.description)
      ])),
      it.kind === 'user' && h('div', { class: 'ad-acts' },
        btn('ad.unlock', 'Desbloquear…'), btn('ad.enable', 'Habilitar…'), btn('ad.disable', 'Deshabilitar…', 'danger'),
        btn('ad.reset_password', 'Restablecer contraseña…', 'danger')));
  }

  // ---------- correcciones de servicios ----------
  function fixCard(f, compact) {
    if (!f.unit && !compact) {
      return h('div', { class: 'fix fix-none' },
        h('span', { class: 'ctl-vm-t' }, h('strong', null, `${f.service || 'Servicio'} (${f.port}) en ${f.vmName}`),
          h('span', { class: 'ctl-sub' }, 'Sin acción de corrección definida en control.json. Sigue la guía de la alerta.')),
        actBtn('Reintentar comprobación', true, () => openAction({ action_id: 'svc.recheck', objetivo: { vm: f.vm } })));
    }
    const svcAct = (id, label) => {
      const a = f.actions.find((x) => x.action_id === id);
      return actBtn(label, !!a && !f.why, () => openAction({ action_id: id, objetivo: { vm: f.vm }, parametros: a.params }), id === 'svc.restart' ? 'danger' : '');
    };
    return h('div', { class: 'fix' + (compact ? ' compact' : '') },
      !compact && h('h4', null, `${f.service || 'Servicio'} (${f.port}) en ${f.vmName}`),
      h('ul', { class: 'group' },
        row('Qué detectó el panel', f.detected || '?'),
        row('Qué cambiaría', f.unit ? `Iniciar o reiniciar el servicio «${f.unit}»` : 'Nada: no hay acción definida'),
        row('Dónde', f.vmName + (f.via ? ' · ' + f.via : '')),
        row('Cómo se verifica', 'Se consulta el estado del servicio en la VM y se repite la comprobación del puerto ' + f.port + '.')),
      why(f.why),
      h('div', { class: 'ctl-btns' },
        actBtn('Reintentar comprobación', true, () => openAction({ action_id: 'svc.recheck', objetivo: { vm: f.vm } })),
        svcAct('svc.start', 'Iniciar servicio…'), svcAct('svc.restart', 'Reiniciar servicio…')));
  }

  function renderFixes(d) {
    $('ctl-fixes').replaceChildren(...(d.fixes.length
      ? d.fixes.map((f) => h('li', { class: 'fix-li' }, fixCard(f)))
      : [h('li', { class: 'g-row' }, 'No hay alertas de servicios activas.')]));
  }

  // Bloque dentro de la «Guía de solución» de una alerta (app.js lo pide al dibujar la guía).
  function guideBlock(alertKey) {
    const f = ctl.data && ctl.data.fixes.find((x) => x.alertKey === alertKey);
    if (!f) return null;
    return h('div', { class: 'guide-ctl' },
      h('p', { class: 'guide-ctl-t' }, icon('power'), h('strong', null, 'Acción predefinida en Nexo Lab. '),
        'Úsala solo si el diagnóstico de arriba lo justifica. Se te pedirá confirmación.'),
      fixCard(f, true));
  }

  // ---------- asistente por intercambio manual ----------
  function renderAssistant(d) {
    const s = ctl.assist;
    const alerts = (A.state.alerts || []).filter((a) => a.machine && a.machine !== 'host');
    const sel = h('select', { id: 'as-alerta', 'aria-label': 'Alerta para el asistente' },
      h('option', { value: '' }, alerts.length ? 'Elige una alerta…' : 'No hay alertas activas'),
      ...alerts.map((a) => h('option', { value: a.key }, a.text)));
    sel.value = alerts.some((a) => a.key === s.alert) ? s.alert : '';
    sel.addEventListener('change', () => { s.alert = sel.value; s.packet = null; s.proposal = null; s.msg = ''; render(); });
    const prep = actBtn('Preparar datos para el asistente', !!sel.value, async () => {
      try { s.packet = await api('/api/asistente/paquete?alerta=' + encodeURIComponent(s.alert)); s.msg = ''; }
      catch (e) { s.msg = e.message; }
      render();
    });
    const parts = [
      note('ctl-scope', 'info',
        'Nexo Lab no se conecta a Hermes, OpenCode ni a ningún modelo, y no les da acceso a tu equipo. Tú copias los datos de la alerta (sin credenciales y con las IP ocultas) y los pegas en el asistente. ',
        h('strong', null, 'Si tu asistente usa un proveedor externo (OpenAI, Anthropic, OpenRouter, Nous Portal…), esos datos saldrán de tu equipo; '),
        'con un modelo local (Ollama, LM Studio) se quedan en él. Luego pegas aquí su respuesta: el panel solo acepta acciones del catálogo y te pide confirmación.'),
      h('div', { class: 'ad-form' }, sel, prep)
    ];
    if (s.packet) {
      const ta = h('textarea', { class: 'preview', rows: '10', readonly: '', spellcheck: 'false', 'aria-label': 'Texto para el asistente' });
      ta.value = s.packet.texto;
      parts.push(h('p', { class: 'ctl-sub' }, '1. Copia este texto y pégalo en Hermes u OpenCode:'), ta,
        h('div', { class: 'ctl-btns' }, h('button', { type: 'button', class: 'copy-btn', 'data-copy': s.packet.texto }, icon('copy'), h('span', null, 'Copiar'))));
      const ans = h('textarea', { class: 'preview', rows: '6', spellcheck: 'false', id: 'as-respuesta', 'aria-label': 'Respuesta del asistente', placeholder: '2. Pega aquí la respuesta JSON del asistente…' });
      ans.value = s.answer || '';
      ans.addEventListener('input', () => { s.answer = ans.value; });
      const val = h('button', { type: 'button', class: 'btn' }, 'Validar propuesta');
      val.addEventListener('click', async () => {
        try { s.proposal = await api('/api/asistente/validar', { respuesta: ans.value }); s.msg = ''; }
        catch (e) { s.proposal = null; s.msg = 'Propuesta descartada: ' + e.message; }
        render();
      });
      parts.push(ans, h('div', { class: 'ctl-btns' }, val));
    }
    if (s.msg) parts.push(h('p', { class: 'ctl-err', role: 'alert' }, s.msg));
    if (s.proposal) {
      const p = s.proposal;
      parts.push(h('div', { class: 'fix proposal' },
        h('h4', null, 'Propuesta del asistente (no ejecutada)'),
        h('ul', { class: 'group' },
          row('Acción', `${p.titulo} (${p.action_id})`), row('VM', p.vmName),
          Object.keys(p.parametros).length ? row('Parámetros', Object.entries(p.parametros).map(([k, v]) => `${k} = ${v}`).join(', ')) : null,
          row('Motivo según el asistente', p.motivo || '(sin motivo)')),
        p.diagnostico_previo.length && h('div', null, h('p', { class: 'ctl-sub' }, 'Antes, el asistente sugiere comprobar:'),
          h('ul', { class: 'plain-list' }, p.diagnostico_previo.map((x) => h('li', null, x)))),
        h('p', { class: 'ctl-sub' }, 'El asistente puede equivocarse: contrasta su propuesta con la guía de la alerta.'),
        h('div', { class: 'ctl-btns' }, actBtn('Revisar y confirmar…', true, () => openAction({
          action_id: p.action_id, objetivo: { vm: p.vm }, parametros: p.parametros, origen: 'asistente', motivo: p.motivo })))));
    }
    $('ctl-asistente').replaceChildren(...clean(parts));
  }

  // ---------- registro ----------
  const RES = { ok: 'Correcto', error: 'Error', sin_confirmar: 'Sin confirmar' };
  function renderLog() {
    $('ctl-registro-hint').textContent = ctl.logFile ? `Se guarda en ${ctl.logFile} (sin contraseñas ni secretos).` : '';
    const items = ctl.log.slice(0, 30);
    $('ctl-registro').replaceChildren(...(items.length ? items.map((e) => h('li', { class: 'g-row log-row r-' + (e.resultado || e.evento) },
      h('time', { class: 'mono' }, A.fmtFull.format(new Date(e.ts))),
      h('span', { class: 'log-t' },
        h('strong', null, `${e.accion} · ${e.objetivo}`),
        h('span', { class: 'ctl-sub' }, (e.evento === 'confirmada' ? 'Confirmada' : RES[e.resultado] || e.resultado) +
          ` · ${e.usuario} (sesión ${e.sesion})` + (e.origen === 'asistente' ? ' · propuesta del asistente' : '') + (e.simulado ? ' · simulación' : '')),
        e.detalle && h('span', { class: 'ctl-sub' }, e.detalle))))
      : [h('li', { class: 'g-row' }, 'Todavía no se ha ejecutado ninguna acción.')]));
  }

  // ---------- hoja de confirmación y progreso ----------
  let current = null;   // { req, plan, pwInput }
  function body(...kids) { $('a-cuerpo').replaceChildren(...clean(kids)); }

  async function openAction(req) {
    A.closeGuide();
    current = { req };
    $('a-titulo').textContent = 'Confirmar acción';
    body(h('p', { class: 'hint' }, 'Validando la acción en el servidor…'));
    if (!dlg.open) dlg.showModal();
    let plan;
    try {
      plan = await api('/api/control/preparar', req);
    } catch (e) {
      body(h('p', { class: 'ctl-err', role: 'alert' }, 'No se puede ejecutar: ' + e.message),
        h('p', { class: 'hint' }, 'No se ha cambiado nada.'),
        h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', id: 'a-ok' }, 'Entendido')));
      $('a-ok').addEventListener('click', closeDlg);
      return;
    }
    current.plan = plan;
    if (!plan.cambia) { run(plan, ''); return; }   // solo lectura (reintentar comprobación): sin confirmación
    $('a-titulo').textContent = plan.titulo;
    const typed = plan.confirmarTexto && h('input', { type: 'text', id: 'a-texto', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'a-texto-h' });
    const go = h('button', { type: 'button', class: 'btn primary danger', id: 'a-ejecutar' }, plan.titulo + ' ahora');
    if (typed) {
      go.disabled = true;
      typed.addEventListener('input', () => { go.disabled = typed.value.trim() !== plan.confirmarTexto; });
    }
    const left = h('span', { class: 'ctl-sub', id: 'a-caduca' });
    const until = Date.now() + plan.caduca * 1000;
    const tick = () => {
      const s = Math.round((until - Date.now()) / 1000);
      if (!current || current.plan !== plan || !document.contains(left)) return;
      left.textContent = s > 0 ? `Esta confirmación caduca en ${s} s.` : 'La confirmación caducó: ciérrala y vuelve a empezar.';
      if (s <= 0) go.disabled = true; else setTimeout(tick, 1000);
    };
    body(
      h('div', { class: 'confirm-box' },
        h('p', { class: 'confirm-q' }, h('strong', null, `¿${plan.titulo} en «${plan.objetivo}»?`)),
        h('ul', { class: 'group' }, clean([
          row('Objetivo', plan.objetivo + (plan.estadoActual ? ` (ahora: ${stateText[plan.estadoActual] || plan.estadoActual})` : '')),
          row('Operación exacta', h('code', { class: 'mono' }, plan.operacion)),
          row('Qué cambia', plan.efecto),
          plan.via && row('Cómo se conecta', plan.via),
          row('Cómo se verificará', plan.verificacion),
          plan.origen === 'asistente' && row('Origen', 'Propuesta del asistente' + (plan.motivo ? ': ' + plan.motivo : ''))
        ])),
        plan.advertencias.length && h('ul', { class: 'confirm-warns' }, plan.advertencias.map((w) => h('li', null, icon('warn'), w))),
        typed && h('label', { class: 'typed', for: 'a-texto' }, h('span', { id: 'a-texto-h' }, `Escribe «${plan.confirmarTexto}» para confirmar:`), typed),
        h('p', { class: 'ctl-sub' }, 'Quedará registrada con tu usuario local, la hora y el resultado. ', left)),
      h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', id: 'a-cancelar' }, 'Cancelar'), go));
    tick();
    $('a-cancelar').addEventListener('click', closeDlg);
    go.addEventListener('click', () => run(plan, typed ? typed.value : ''));
    (typed || $('a-cancelar')).focus();
  }

  async function run(plan, typed) {
    $('a-titulo').textContent = plan.titulo + ' · ' + plan.objetivo;
    const steps = h('ol', { class: 'job-steps' });
    const status = h('p', { class: 'job-status running', role: 'status', 'aria-live': 'polite' }, 'Ejecutando…');
    body(status, steps);
    let res;
    try {
      res = await api('/api/control/ejecutar', { ticket: plan.ticket, confirmacion: typed });
    } catch (e) {
      finish({ estado: 'error', resultado: e.message }, status);
      return;
    }
    if (res.job) {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        let j;
        try { j = await api('/api/control/trabajo?id=' + encodeURIComponent(res.job)); }
        catch (e) { status.textContent = 'No se pudo consultar el progreso: ' + e.message; continue; }
        steps.replaceChildren(...j.pasos.map((p) => h('li', null, h('time', { class: 'mono' }, fmtTime.format(new Date(p.t))), ' ', p.texto)));
        if (j.estado !== 'en_curso') { finish(j, status); break; }
        status.textContent = 'En curso… ' + (j.pasos.at(-1) || {}).texto;
      }
    } else {
      finish(res, status);
    }
  }

  function finish(res, status) {
    const cls = { ok: 'ok', error: 'bad', sin_confirmar: 'unk' }[res.estado] || 'unk';
    status.className = 'job-status ' + cls;
    status.textContent = ({ ok: 'Hecho. ', error: 'No se completó. ', sin_confirmar: 'Sin confirmar. ' }[res.estado] || '') + (res.resultado || '');
    const extra = [];
    if (res.password) {
      // La contraseña solo existe en esta hoja: no se guarda en el estado del panel y se borra al cerrar.
      const pw = h('input', { type: 'text', readonly: '', class: 'mono pw', id: 'a-pw', 'aria-label': 'Contraseña temporal', autocomplete: 'off', spellcheck: 'false' });
      pw.value = res.password;
      res.password = null;
      current.pwInput = pw;
      wipe.timer = setTimeout(() => {   // por si la hoja se queda abierta: se borra sola a los 3 minutos
        if (current && current.pwInput === pw) { pw.value = ''; pw.replaceWith(h('span', { class: 'ctl-sub' }, 'Contraseña borrada de la pantalla (pasaron 3 minutos).')); current.pwInput = null; }
      }, 180000);
      const copy = h('button', { type: 'button', class: 'btn' }, icon('copy'), 'Copiar');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(pw.value); toast('Copiada. Pégala donde corresponda y luego copia otra cosa para vaciar el portapapeles.'); }
        catch { pw.select(); toast('Selecciónala y usa Ctrl+C.'); }
      });
      extra.push(h('div', { class: 'pw-box' },
        h('p', null, h('strong', null, 'Contraseña temporal: se muestra una sola vez.')),
        h('div', { class: 'pw-row' }, pw, copy),
        h('p', { class: 'ctl-sub' }, 'Cópiala ahora y entrégala por un canal seguro (en persona o en un gestor de contraseñas). No la pegues en chats, correos ni notas. ',
          'El usuario deberá cambiarla al iniciar sesión. Nexo Lab no la guarda ni la registra: al cerrar esta hoja desaparece.')));
    }
    const close = h('button', { type: 'button', class: 'btn primary', id: 'a-fin' }, 'Cerrar');
    $('a-cuerpo').append(...extra, h('div', { class: 'sheet-actions' }, close));
    close.addEventListener('click', closeDlg);
    if (res.cuenta) ctl.ad.sel = res.cuenta;   // la cuenta releída tras el cambio
    A.reload(true).finally(() => refresh(true));
  }

  // Borra la hoja (y la contraseña temporal, si la hay). Se llama ANTES de cerrar, sin depender del evento
  // «close» del navegador, y también desde ese evento (Esc o clic fuera de la hoja).
  function wipe() {
    if (current && current.pwInput) { current.pwInput.value = ''; current.pwInput.remove(); }
    clearTimeout(wipe.timer);
    $('a-cuerpo').replaceChildren();
    current = null;
  }
  function closeDlg() { wipe(); if (dlg.open) dlg.close(); }
  dlg.addEventListener('close', () => { wipe(); refresh(true); });
  dlg.addEventListener('cancel', wipe);
  $('a-cerrar').addEventListener('click', closeDlg);

  window.NEXO_CONTROL = { onData: () => refresh(false), guideBlock };
  refresh(true);
})();
