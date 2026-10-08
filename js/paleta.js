// Nexo Lab · paleta de acciones rápidas (Ctrl + K).
// Solo navega y abre lo que ya existe en el panel: secciones, máquinas, guías de alertas, actualizar, exportar,
// configurar y cambiar de vista. No ejecuta acciones de la sección Control (esas siempre piden confirmación allí).
(function () {
  'use strict';
  const A = window.NEXO_APP;
  if (!A) return;
  const { h, icon } = A;
  const $ = (id) => document.getElementById(id);
  const dlg = $('paleta'), input = $('pal-q'), list = $('pal-lista');
  let items = [], shown = [], sel = 0, opener = null;

  const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const go = (id) => () => { const el = $(id); if (el) { history.replaceState(null, '', '#' + id); el.scrollIntoView({ block: 'start' }); } };
  const click = (id) => () => { const el = $(id); if (el && !el.disabled) el.click(); };
  const STATE_DOT = { running: 'ok', paused: '', stopped: '', alert: 'warn' };

  function build() {
    const st = A.state;
    const out = [];
    const sec = (group, ic, title, desc, run, dot) => out.push({ group, ic, title, desc, run, dot, key: norm(title + ' ' + (desc || '') + ' ' + group) });
    for (const [id, label] of [['resumen', 'Resumen'], ['alertas', 'Alertas de salud'], ['maquinas', 'Máquinas'], ['red', 'Red del laboratorio'], ['actividad', 'Actividad e historial'], ['control', 'Control']]) {
      if ($(id)) sec('Ir a', 'chevron', label, id === 'control' ? 'acciones que cambian el laboratorio' : 'sección', go(id));
    }
    for (const a of st.alerts || []) {
      const info = A.alertInfo(a);
      sec('Alertas', 'book', 'Guía: ' + a.text, info.sevLabel, () => A.openGuide(a.key), info.sev === 'crit' ? 'err' : info.sev === 'warn' ? 'warn' : '');
    }
    for (const m of st.machines || []) {
      sec('Máquinas', m.kind === 'host' ? 'monitor' : 'server', m.name,
        m.stateLabel + (m.ips && m.ips.length ? ' · ' + m.ips[0] : ''), () => A.openDetail(m.id), STATE_DOT[m.state]);
    }
    sec('Acciones', 'pulse', 'Actualizar ahora', 'leer VirtualBox y repetir comprobaciones', click('actualizar'));
    sec('Acciones', 'info', 'Buscar máquinas', 'nombre, IP o etiqueta', () => { go('maquinas')(); $('buscar').focus(); });
    sec('Acciones', 'grid', 'Ver máquinas como tarjetas', 'vista', () => { A.setView('cards'); go('maquinas')(); });
    sec('Acciones', 'server', 'Ver máquinas como lista', 'vista', () => { A.setView('list'); go('maquinas')(); });
    sec('Acciones', 'note', 'Exportar reporte', 'Markdown o JSON, con IP ocultables', click('exportar'));
    sec('Acciones', 'copy', 'Configurar servicios y umbrales', 'servicios.json', click('configurar'));
    return out;
  }

  function render() {
    const q = norm(input.value).split(/\s+/).filter(Boolean);
    shown = items.filter((it) => q.every((w) => it.key.includes(w))).slice(0, 60);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    if (!shown.length) {
      list.replaceChildren(h('p', { class: 'pal-empty' }, 'Sin resultados para «' + input.value + '».'));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const nodes = [];
    let last = null;
    shown.forEach((it, i) => {
      if (it.group !== last) { nodes.push(h('p', { class: 'pal-sec', role: 'presentation' }, it.group)); last = it.group; }
      const el = h('div', { class: 'pal-item', role: 'option', id: 'pal-' + i, 'aria-selected': String(i === sel) },
        icon(it.ic), it.dot != null && it.group !== 'Acciones' && it.group !== 'Ir a' ? h('span', { class: 'dot ' + (it.dot || '') }) : null,
        h('span', { class: 'pal-t' }, it.title), it.desc && h('span', { class: 'pal-d' }, it.desc));
      el.addEventListener('mousemove', () => { if (sel !== i) { sel = i; mark(); } });
      el.addEventListener('click', () => run(i));
      nodes.push(el);
    });
    list.replaceChildren(...nodes);
    mark();
  }
  function mark() {
    list.querySelectorAll('.pal-item').forEach((el) => el.setAttribute('aria-selected', String(el.id === 'pal-' + sel)));
    const cur = $('pal-' + sel);
    if (cur) { input.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
  }
  function run(i) {
    const it = shown[i];
    if (!it) return;
    close(false);
    it.run();
  }
  function open() {
    if (dlg.open || document.querySelector('dialog[open]')) return;
    opener = document.activeElement;
    items = build();
    input.value = '';
    sel = 0;
    render();
    dlg.showModal();
    input.focus();
  }
  function close(restore) {
    if (dlg.open) dlg.close();
    if (restore !== false && opener && document.contains(opener)) opener.focus();
  }

  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, shown.length); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + shown.length) % Math.max(1, shown.length); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (dlg.open) close(); else open();
    }
  });
  for (const id of ['paleta-btn', 'paleta-side']) { const b = $(id); if (b) b.addEventListener('click', open); }
})();
