/* Интерфейс веб-версии: пароль и расшифровка данных, форма, предпросмотр, PDF в браузере (html2canvas + jsPDF),
   история КП на этом устройстве (ред. с перечнем изменений, таблица CSV), отправка PDF руководителю и клиенту.
   Внешних сервисов нет: расчёт, PDF и история - в браузере, файлы уходят через WhatsApp. */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var state = {
    data: null, ctx: null, kp: null, pdf: null, pdfUrl: null, busy: false,
    editing: null,   // запись КП, которую меняем: следующая сборка станет её новой ред.
    saved: null,     // запись последнего сохранённого PDF
    draftUid: null, history: [],
  };
  var PW_KEY = 'kp_web_password', LOCAL_KEY = 'kp_history_local', LOCAL_LIMIT = 60;
  // Растр страниц: от чёткого к лёгкому, пока PDF не станет меньше 2 МБ (файл быстро уходит в WhatsApp по мобильной связи)
  var PDF_PRESETS = [[3, 2, 0.86], [2.5, 1.8, 0.8], [2, 1.6, 0.74]], PDF_LIMIT = 2000000;
  var SCREENS = ['lock', 'form', 'result', 'history'];

  function show(id) {
    SCREENS.forEach(function (s) { $('#' + s).hidden = s !== id; });
    var locked = id === 'lock';
    $('#nav').hidden = locked; $('#b-logout').hidden = locked;
    $('#nav-form').classList.toggle('is-active', id === 'form' || id === 'result');
    $('#nav-history').classList.toggle('is-active', id === 'history');
    window.scrollTo(0, 0);
  }
  function status(msg, kind) { var el = $('#status'); el.textContent = msg || ''; el.className = 'status' + (kind ? ' status--' + kind : ''); }
  function hStatus(msg, kind) { var el = $('#h-status'); el.textContent = msg || ''; el.className = 'status' + (kind ? ' status--' + kind : ''); }
  function esc(s) { return KP.esc(s); }

  // ---------- данные ----------
  function b64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  async function decrypt(blob, password) {
    var enc = new TextEncoder();
    var baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(blob.salt), iterations: blob.iter, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, key, b64(blob.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function unlock(password) {
    if (!window.crypto || !crypto.subtle) throw new Error('Браузер не поддерживает шифрование. Откройте страницу по https.');
    var res = await fetch('data.enc.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('Не удалось загрузить данные (' + res.status + ').');
    var blob = await res.json();
    var data;
    try { data = await decrypt(blob, password); } catch (e) { throw new Error('Пароль не подходит.'); }
    state.data = data;
    localStorage.setItem(PW_KEY, password);
    state.draftUid = newUid();
    loadHistory();
    fillForm();
    updateFormMode();
    show('form');
  }

  // ---------- история на этом устройстве ----------
  function newUid() {
    var a = new Uint8Array(12); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function localHistory() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch (e) { return []; } }
  function pushLocal(rec) {
    var list = localHistory().filter(function (r) { return !(r.uid === rec.uid && r.revision === rec.revision); });
    list.unshift(rec);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list.slice(0, LOCAL_LIMIT)));
  }
  function loadHistory() { state.history = localHistory(); return state.history; }
  function timeOf(r) { return Date.parse(r.created_at || '') || 0; }
  function whenOf(r) { return fmtWhen(r.created_at); }
  function latestRevision(uid) {
    var max = 0;
    state.history.concat(state.saved ? [state.saved] : []).forEach(function (r) { if (r.uid === uid) max = Math.max(max, Number(r.revision) || 1); });
    return max;
  }

  // ---------- форма ----------
  function option(value, label, selected) { var o = document.createElement('option'); o.value = value; o.textContent = label; if (selected) o.selected = true; return o; }
  function fillSelect(sel, items, selectedValue) { sel.innerHTML = ''; items.forEach(function (it) { sel.appendChild(option(it[0], it[1], it[0] === selectedValue)); }); }
  function nextNumber() {
    var today = KP.fmt.todayIso(); var yymmdd = today.slice(2, 4) + today.slice(5, 7) + today.slice(8, 10);
    var n = parseInt(localStorage.getItem('kp_counter_' + yymmdd) || '0', 10);
    state.history.forEach(function (r) { var m = /^KP-(\d{6})-(\d+)$/.exec(r.number || ''); if (m && m[1] === yymmdd) n = Math.max(n, parseInt(m[2], 10)); });
    return 'KP-' + yymmdd + '-' + String(n + 1).padStart(2, '0');
  }
  function bumpNumber(number) { var m = /^KP-(\d{6})-(\d+)$/.exec(number); if (m) { var key = 'kp_counter_' + m[1]; var n = parseInt(m[2], 10); if (n > parseInt(localStorage.getItem(key) || '0', 10)) localStorage.setItem(key, String(n)); } }
  function systemsFor(room) {
    var d = state.data;
    return Object.keys(d.systems).filter(function (id) { var s = d.systems[id]; return s.priced && s.room_types.indexOf(room) >= 0; });
  }
  function systemLabel(id) {
    var s = state.data.systems[id];
    return s.short + ' · ' + KP.perM2Label(s, state.data) + ' ₸/м²' + (s.th_mm ? ' · ' + s.th_mm.min + '-' + s.th_mm.max + ' мм' : '') + ' · ' + s.standard.toLowerCase();
  }
  function fillSystems() {
    var room = $('#f-room').value;
    var ids = systemsFor(room);
    var current = $('#f-system').value;
    fillSelect($('#f-system'), ids.map(function (id) { return [id, systemLabel(id)]; }), ids.indexOf(current) >= 0 ? current : ids[0]);
    fillAlt();
    fillThickness();
  }
  function fillAlt() {
    var room = $('#f-room').value, chosen = $('#f-system').value, current = $('#f-alt').value;
    var ids = systemsFor(room).filter(function (id) { return id !== chosen; });
    fillSelect($('#f-alt'), [['', 'нет']].concat(ids.map(function (id) { return [id, state.data.systems[id].short + ' · ' + state.data.systems[id].standard]; })), ids.indexOf(current) >= 0 ? current : '');
  }
  function fillThickness() {
    var s = state.data.systems[$('#f-system').value]; var wrap = $('#f-th').closest('.field');
    if (!s.th_mm) { wrap.hidden = true; $('#f-th').value = ''; return; }
    wrap.hidden = false;
    $('#f-th').min = s.th_mm.min; $('#f-th').max = s.th_mm.max; $('#f-th').step = '0.1'; $('#f-th').value = s.th_mm.default;
    $('#f-th-range').textContent = s.th_mm.min + '-' + s.th_mm.max + ' мм';
  }
  function fillAddons() {
    var d = state.data; var box = $('#addons'); box.innerHTML = '';
    Object.keys(d.addons).forEach(function (id) {
      var a = d.addons[id];
      var row = document.createElement('div'); row.className = 'addon';
      var lab = document.createElement('label'); lab.className = 'check';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = id; cb.id = 'ad-' + id;
      var label = (a.short || a.title); label = label.charAt(0).toUpperCase() + label.slice(1);
      lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + label + (a.unit === 'м²' ? ' (по площади)' : '')));
      lab.title = a.title;
      row.appendChild(lab);
      if (a.unit === 'м.п.') {
        var q = document.createElement('input'); q.type = 'text'; q.inputMode = 'decimal'; q.placeholder = 'длина, м.п.'; q.id = 'adq-' + id; q.className = 'qty';
        row.appendChild(q);
      }
      box.appendChild(row);
    });
  }
  function applyBaseSuggestion() {
    var base = state.data.base_conditions[$('#f-base').value];
    Object.keys(state.data.addons).forEach(function (id) { $('#ad-' + id).checked = base.suggest.indexOf(id) >= 0; });
  }
  function fillForm() {
    var d = state.data;
    var rooms = Object.keys(d.rooms.rooms).filter(function (k) { return systemsFor(k).length; }).map(function (k) { return [k, d.rooms.rooms[k].short]; });
    fillSelect($('#f-room'), rooms, 'warehouse');
    fillSelect($('#f-base'), Object.keys(d.base_conditions).map(function (k) { return [k, d.base_conditions[k].label]; }), 'unknown');
    fillAddons();
    fillSystems();
    fillSelect($('#f-ral'), d.palette.basics.map(function (c) { return [c.ral, c.ral + ' · ' + c.name]; }), 'RAL 7035');
    var managers = Object.keys(d.company.managers);
    fillSelect($('#f-manager'), managers.map(function (k) { return [k, d.company.managers[k].name]; }), managers[0]);
    $('#f-manager').closest('.field').hidden = managers.length < 2;
    $('#f-number').value = nextNumber();
    $('#f-valid').textContent = d.company.terms.valid_days;
  }
  function fillFromParams(p) {
    var z = p.zones[0];
    $('#f-object').value = p.client.object || '';
    $('#f-company').value = p.client.company && p.client.company !== p.client.object ? p.client.company : '';
    $('#f-area').value = String(z.area_m2 || '').replace('.', ',');
    $('#f-city').value = p.client.city || '';
    $('#f-room').value = p.room_type; fillSystems();
    $('#f-system').value = z.system; fillAlt(); fillThickness();
    if (z.th_mm) $('#f-th').value = z.th_mm;
    $('#f-base').value = p.base || 'unknown';
    Object.keys(state.data.addons).forEach(function (id) {
      var a = (z.addons || []).filter(function (x) { return x.id === id; })[0];
      $('#ad-' + id).checked = !!a;
      var q = $('#adq-' + id); if (q) q.value = a && a.qty ? String(a.qty).replace('.', ',') : '';
    });
    $('#f-alt').value = p.alternatives && p.alternatives[0] ? p.alternatives[0].system : '';
    $('#f-ral').value = (p.colour && p.colour.ral) || 'RAL 7035';
    $('#f-colour').checked = !!(p.options && p.options.show_colour_page);
    if (p.manager && state.data.company.managers[p.manager]) $('#f-manager').value = p.manager;
    $('#f-number').value = p.number;
  }
  function updateFormMode() {
    var e = state.editing;
    $('#form-title').textContent = e ? 'Изменение КП' : 'Новое КП';
    $('#form-edit').hidden = !e;
    if (e) $('#form-edit-text').textContent = e.number + ': новый PDF будет ред. ' + (latestRevision(e.uid) + 1) + ', прошлые останутся в истории.';
    $('#f-number').readOnly = !!e;
  }
  function startNew() {
    state.editing = null; state.saved = null; state.draftUid = newUid();
    ['#f-object', '#f-company', '#f-area', '#f-city'].forEach(function (s) { $(s).value = ''; });
    $('#f-colour').checked = false;
    fillForm();
    updateFormMode();
    $('#form-error').textContent = '';
    show('form');
    $('#f-object').focus();
  }
  function editRecord(rec) {
    if (!rec.params || !rec.params.zones) { hStatus('В записи нет параметров КП: изменить нельзя.', 'err'); return; }
    state.editing = rec; state.saved = null;
    fillFromParams(rec.params);
    updateFormMode();
    $('#form-error').textContent = '';
    show('form');
  }
  function readForm() {
    var number = state.editing ? state.editing.number : $('#f-number').value.trim();
    if (!/^KP-\d{6}-\d{2,3}$/.test(number)) throw new Error('Номер в виде KP-ГГММДД-NN, например KP-261124-05.');
    var area = $('#f-area').value.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(area) || Number(area) <= 0) throw new Error('Площадь: число больше нуля, не больше двух знаков после запятой.');
    var object = $('#f-object').value.trim(); if (!object) throw new Error('Заполните «Что за помещение».');
    var company = $('#f-company').value.trim() || object;
    var system = $('#f-system').value; var sys = state.data.systems[system];
    var alt = $('#f-alt').value; if (alt === system) alt = '';
    var text = [object, company, $('#f-city').value].join(' ');
    if (/(\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/.test(text) || /@/.test(text)) throw new Error('В КП не должно быть телефонов и почты клиента: уберите их из полей.');
    var zone = { name: 'Тип пола 1', area_m2: area, system: system, addons: [] };
    if (sys.th_mm) {
      var th = $('#f-th').value.trim().replace(',', '.');
      if (!/^\d+(\.\d{1,2})?$/.test(th)) throw new Error('Толщина: число в миллиметрах, например 2.5.');
      if (Number(th) < Number(sys.th_mm.min) || Number(th) > Number(sys.th_mm.max)) throw new Error('Толщина для этой конструкции: от ' + sys.th_mm.min + ' до ' + sys.th_mm.max + ' мм.');
      zone.th_mm = th;
    }
    Object.keys(state.data.addons).forEach(function (id) {
      if (!$('#ad-' + id).checked) return;
      var a = state.data.addons[id]; var item = { id: id };
      if (a.unit === 'м.п.') {
        var q = $('#adq-' + id).value.trim().replace(',', '.');
        if (!/^\d+(\.\d{1,2})?$/.test(q) || Number(q) <= 0) throw new Error('«' + a.title + '»: укажите длину в м.п.');
        item.qty = q;
      }
      zone.addons.push(item);
    });
    var uid = state.editing ? state.editing.uid : state.draftUid;
    return {
      number: number, revision: state.editing ? latestRevision(uid) + 1 : 1, uid: uid,
      date: KP.fmt.todayIso(), valid_until: null,
      client: { company: company, object: object, city: $('#f-city').value.trim() || null, addressee: null },
      room_type: $('#f-room').value, manager: $('#f-manager').value, base: $('#f-base').value,
      zones: [zone],
      alternatives: alt ? [{ system: alt }] : [],
      colour: { ral: $('#f-ral').value },
      options: { show_comparison: !!alt, show_colour_page: $('#f-colour').checked, a4_separate: false, rounding: 'excel' },
      notes: [], status: 'web',
    };
  }

  // ---------- предпросмотр ----------
  function fitPages() {
    var wrap = $('#pages'); var avail = Math.min(document.documentElement.clientWidth, 640) - 24;
    var k = Math.min(1, avail / 390);
    wrap.style.transform = 'scale(' + k + ')';
    wrap.style.height = (wrap.scrollHeight * k) + 'px';
  }
  function resetPdf() { if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl); state.pdf = null; state.pdfUrl = null; }
  function setStep(step) { $('#act-make').hidden = step !== 'make'; $('#act-ready').hidden = step !== 'ready'; $('#dl-hint').hidden = step !== 'ready'; }
  function render() {
    var kp = state.kp;
    var ctx = KP.buildContext(kp, state.data);
    state.ctx = ctx;
    resetPdf();
    $('#pages').innerHTML = KP.renderPhone(ctx);
    $('#a4').innerHTML = KP.renderA4(ctx);
    $('#pages').style.height = '';
    $('#r-title').textContent = kp.number + (kp.revision > 1 ? ' · ред. ' + kp.revision : '') + ' · ' + kp.client.object + ' · ' + ctx.zone.area_str + ' м²' + (ctx.zone.th_str ? ' · ' + ctx.zone.th_str : '');
  }
  function build() {
    state.kp = readForm();
    render();
    setStep('make');
    $('#wa-text').hidden = true;
    show('result');
    fitPages();
    var over = [];
    document.querySelectorAll('#pages .page').forEach(function (p, i) { if (p.scrollHeight > p.clientHeight + 1) over.push(i + 1); });
    if (over.length) status('Текст не влезает на страницы ' + over.join(', ') + ': сократите название помещения или компании.', 'warn');
    else if (state.ctx.zone.estimated.length) status('Оценочные цены (согласуйте с руководителем): ' + state.ctx.zone.estimated.join(', ') + '.', 'warn');
    else status('Проверьте страницы и нажмите «Получить PDF».');
  }

  // ---------- PDF ----------
  async function rasterize(el, scale, quality) {
    var canvas = await html2canvas(el, { scale: scale, backgroundColor: '#ffffff', logging: false, useCORS: true, imageTimeout: 15000, width: el.offsetWidth, height: el.offsetHeight, scrollX: 0, scrollY: -window.scrollY });
    return canvas.toDataURL('image/jpeg', quality);
  }
  function addLinks(doc, el, w, h) {
    var base = el.getBoundingClientRect(); var kx = w / base.width, ky = h / base.height;
    el.querySelectorAll('a[href]').forEach(function (a) {
      var r = a.getBoundingClientRect();
      doc.link((r.left - base.left) * kx, (r.top - base.top) * ky, r.width * kx, r.height * ky, { url: a.getAttribute('href') });
    });
  }
  async function renderPdf(wrap, preset) {
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: 'px', format: [390, 693], orientation: 'portrait', hotfixes: ['px_scaling'], compress: true });
    var pages = Array.prototype.slice.call(wrap.querySelectorAll('.page'));
    for (var i = 0; i < pages.length; i++) {
      status('Собираю страницу ' + (i + 1) + ' из ' + (pages.length + 1) + '…');
      if (i > 0) doc.addPage([390, 693], 'portrait');
      doc.addImage(await rasterize(pages[i], preset[0], preset[2]), 'JPEG', 0, 0, 390, 693, undefined, 'FAST');
      addLinks(doc, pages[i], 390, 693);
    }
    status('Собираю страницу ' + (pages.length + 1) + ' из ' + (pages.length + 1) + '…');
    var a4img = await rasterize($('#a4 .a4'), preset[1], preset[2]);
    doc.addPage('a4', 'portrait');
    doc.addImage(a4img, 'JPEG', 0, 0, doc.internal.pageSize.getWidth(), doc.internal.pageSize.getHeight(), undefined, 'FAST');
    doc.setProperties({ title: state.kp.number + (state.kp.revision > 1 ? ' ред. ' + state.kp.revision : '') + ' · ' + state.data.company.legal_name, subject: 'Коммерческое предложение', creator: 'kaztop-kp web' });
    return { blob: doc.output('blob'), pages: pages.length + 1 };
  }
  async function makePdf() {
    if (state.pdf) return state.pdf;
    if (state.busy) return null;
    state.busy = true;
    var wrap = $('#pages'); var savedTransform = wrap.style.transform, savedHeight = wrap.style.height;
    wrap.style.transform = 'none'; wrap.style.height = '';
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      var limit = window.__kpPdfLimit || PDF_LIMIT, out, preset = 0;
      for (; preset < PDF_PRESETS.length; preset++) {
        out = await renderPdf(wrap, PDF_PRESETS[preset]);
        if (out.blob.size <= limit) break;
      }
      var name = state.kp.number + (state.kp.revision > 1 ? '-ред' + state.kp.revision : '') + '.pdf';
      state.pdf = new File([out.blob], name, { type: 'application/pdf' });
      status('PDF готов: ' + out.pages + ' стр., ' + Math.round(out.blob.size / 1024) + ' КБ.', 'ok');
      window.__lastPdf = { size: out.blob.size, preset: Math.min(preset, PDF_PRESETS.length - 1) };
      return state.pdf;
    } finally {
      wrap.style.transform = savedTransform; wrap.style.height = savedHeight;
      state.busy = false;
    }
  }
  function canShareFiles() {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] })); } catch (e) { return false; }
  }
  function readyPdf(f) {
    if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = URL.createObjectURL(f);
    var a = $('#b-download'); a.href = state.pdfUrl; a.setAttribute('download', f.name);
    setStep('ready');
  }
  function nowIso() { var d = new Date(); var p = function (n) { return String(n).padStart(2, '0'); }; return KP.fmt.todayIso() + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function fmtNum(s) {
    s = String(s == null ? '' : s).replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(s)) return s;
    var p = s.split('.');
    return KP.fmt.fmtInt(BigInt(p[0])) + (p[1] && /[1-9]/.test(p[1]) ? ',' + p[1].replace(/0+$/, '') : '');
  }
  function fmtWhen(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || ''); return m ? m[3] + '.' + m[2] + '.' + m[1] + ' ' + m[4] + ':' + m[5] : String(iso || ''); }
  function addonsText(z) { return z.addons.map(function (b) { return b.short + ' ' + b.qty_str + ' ' + b.unit; }).join('; '); }
  function diffText(prev, cur) {
    var out = [];
    var add = function (label, a, b, unit) {
      a = a == null ? '' : String(a); b = b == null ? '' : String(b);
      if (a !== b) out.push(label + ': ' + (a || 'нет') + ' → ' + (b || 'нет') + (unit && b ? unit : ''));
    };
    add('Помещение', prev.object, cur.object);
    add('Компания', prev.company, cur.company);
    add('Город', prev.city, cur.city);
    add('Тип помещения', prev.room, cur.room);
    add('Площадь', fmtNum(prev.area), fmtNum(cur.area), ' м²');
    add('Конструкция', prev.system_title, cur.system_title);
    add('Толщина', fmtNum(prev.th_mm), fmtNum(cur.th_mm), ' мм');
    add('Основание', prev.base_label, cur.base_label);
    add('Допработы', prev.addons, cur.addons);
    add('Вариант', prev.alt, cur.alt);
    add('Цвет', prev.params && prev.params.colour ? prev.params.colour.ral : '', cur.params.colour.ral);
    add('Итого', fmtNum(prev.total), fmtNum(cur.total), ' ₸');
    return out.join('; ');
  }
  function buildRecord() {
    var kp = state.kp, ctx = state.ctx, z = ctx.zone, d = state.data;
    var rec = {
      uid: kp.uid, number: kp.number, revision: kp.revision, manager: kp.manager, manager_name: d.company.managers[kp.manager].name,
      object: kp.client.object, company: kp.client.company, city: kp.client.city || '', room: d.rooms.rooms[kp.room_type].short,
      area: kp.zones[0].area_m2, system: z.system.id, system_title: z.system.short, th_mm: (z.th_mm || '').replace(',', '.'),
      base_label: ctx.kp.base_note, addons: addonsText(z), alt: kp.alternatives.length ? d.systems[kp.alternatives[0].system].short : '',
      total: z.calc.total.toString(), per_m2: z.calc.per_m2.toString(), estimated: z.estimated.join(', '),
      params: kp,
    };
    rec.changes = state.editing ? diffText(state.editing, rec) : '';
    return rec;
  }
  function afterSaved(rec) {
    state.saved = rec; state.editing = rec;
    state.history = [rec].concat(state.history.filter(function (r) { return !(r.uid === rec.uid && r.revision === rec.revision); }));
    bumpNumber(rec.number);
    updateFormMode();
  }
  function saveToHistory() {
    var rec = buildRecord();
    rec.created_at = nowIso();
    pushLocal(rec);
    afterSaved(rec);
    return rec;
  }
  async function getPdf() {
    if (state.busy) return null;
    var f;
    try { f = await makePdf(); } catch (e) { status('Не удалось собрать PDF: ' + e.message, 'err'); return null; }
    if (!f) return null;
    readyPdf(f);
    return saveToHistory();
  }
  function chiefText() {
    var k = state.kp, z = state.ctx.zone, s = state.saved;
    return 'КП ' + k.number + (k.revision > 1 ? ' ред. ' + k.revision : '') + ' на согласование: ' + k.client.object + (k.client.city ? ', ' + k.client.city : '') + ', ' +
      z.area_str + ' м², ' + z.total_str + ' ₸ (' + z.per_m2_str + ' ₸/м²).' +
      (s && s.changes ? '\nИзменено: ' + s.changes : '');
  }
  function writeClipboard(text) {
    try { return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; }); }
    catch (e) { return Promise.resolve(false); }
  }
  /** WhatsApp на iPhone при отправке «файл + текст» может отправить только текст (WebKit bug 251500), поэтому файл
      уходит один, а текст в том же нажатии (до share) кладётся в буфер обмена: его вставляют подписью к файлу. */
  function sendPdf(text, who) {
    var copied = writeClipboard(text);
    var share = canShareFiles();
    if (share) navigator.share({ files: [state.pdf] }).catch(function (e) { if (e && e.name !== 'AbortError') status('Отправить не удалось: ' + e.message + '. Скачайте PDF и приложите к сообщению.', 'err'); });
    copied.then(function (ok) {
      $('#wa-text').value = text; $('#wa-text').hidden = ok;
      var how = share ? 'вставьте его подписью к файлу' : 'скачайте PDF, приложите к сообщению и вставьте текст';
      status(ok ? 'Текст ' + who + ' скопирован: ' + how + '.' : 'Скопируйте текст ниже: ' + how + '.', ok ? 'ok' : 'warn');
    });
  }
  function sendToChief() { sendPdf(chiefText(), 'для руководителя'); }
  function sendToClient() { sendPdf(KP.renderWa(state.ctx), 'для клиента'); }

  // ---------- экран истории ----------
  function groupHistory(list) {
    var groups = {}, order = [];
    list.forEach(function (r) { var k = r.uid || r.number; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(r); });
    return order.map(function (k) { return groups[k].sort(function (a, b) { return b.revision - a.revision; }); })
      .sort(function (a, b) { return timeOf(b[0]) - timeOf(a[0]); });
  }
  function card(g) {
    var r = g[0], older = g.slice(1), key = esc(r.uid) + '|' + r.revision;
    var actions = '<button type="button" class="hbtn" data-act="edit" data-key="' + key + '">Изменить</button>';
    var olderHtml = older.length ? '<details class="hcard__older"><summary>Ранние ред. (' + older.length + ')</summary><ul>' + older.map(function (o) {
      return '<li><b>ред. ' + o.revision + '</b> · ' + whenOf(o) + ' · ' + fmtNum(o.total) + ' ₸' +
        (o.changes ? '<div class="hcard__chg">' + esc(o.changes) + '</div>' : '') + '</li>';
    }).join('') + '</ul></details>' : '';
    return '<article class="hcard"><div class="hcard__top"><b>' + esc(r.number) + '</b>' + (r.revision > 1 ? ' <span class="muted-inline">ред. ' + r.revision + '</span>' : '') + '</div>' +
      '<div class="hcard__title">' + esc(r.object) + (r.city ? ' · ' + esc(r.city) : '') + '</div>' +
      '<div class="hcard__meta">' + fmtNum(r.area) + ' м² · ' + esc(r.system_title) + (r.th_mm ? ', ' + fmtNum(r.th_mm) + ' мм' : '') + (r.addons ? ' · ' + esc(r.addons) : '') + '</div>' +
      '<div class="hcard__sum"><b>' + fmtNum(r.total) + ' ₸</b> · ' + fmtNum(r.per_m2) + ' ₸/м²' + (r.estimated ? ' · <span class="warn-inline">оценочные цены</span>' : '') + '</div>' +
      (r.changes ? '<div class="hcard__chg">Изменено: ' + esc(r.changes) + '</div>' : '') +
      '<div class="hcard__when">' + whenOf(r) + (r.manager_name ? ' · ' + esc(r.manager_name) : '') + '</div>' +
      '<div class="hcard__actions">' + actions + '</div>' + olderHtml + '</article>';
  }
  function renderHistory() {
    var q = ($('#h-search').value || '').trim().toLowerCase();
    var groups = groupHistory(state.history).filter(function (g) {
      if (!q) return true;
      return g.some(function (r) { return [r.number, r.object, r.company, r.city, r.manager_name].join(' ').toLowerCase().indexOf(q) >= 0; });
    });
    $('#h-list').innerHTML = groups.length ? groups.map(card).join('') : '<p class="hint">' + (q ? 'Ничего не найдено.' : 'Пока пусто: соберите КП и нажмите «Получить PDF».') + '</p>';
  }
  function csvCell(v) { var s = v == null ? '' : String(v); return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  /** Таблица всех КП и ред. для Excel или Google Таблиц (разделитель «;», UTF-8 с BOM). */
  function exportCsv() {
    var head = ['Дата', '№ КП', 'Ред.', 'Менеджер', 'Помещение', 'Компания', 'Город', 'Тип помещения', 'Площадь, м²', 'Конструкция', 'Толщина, мм',
      'Основание', 'Допработы', 'Вариант', 'Итого, ₸', '₸/м²', 'Оценочные цены', 'Что изменилось'];
    var rows = state.history.slice().sort(function (a, b) { return timeOf(a) - timeOf(b); }).map(function (r) {
      return [whenOf(r), r.number, r.revision, r.manager_name, r.object, r.company, r.city, r.room, String(r.area || '').replace('.', ','), r.system_title,
        String(r.th_mm || '').replace('.', ','), r.base_label, r.addons, r.alt, r.total, r.per_m2, r.estimated, r.changes];
    });
    var csv = '\ufeff' + [head].concat(rows).map(function (row) { return row.map(csvCell).join(';'); }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'Kaztop-КП-история-' + KP.fmt.todayIso() + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    hStatus('Таблица выгружена: ' + rows.length + ' строк.', 'ok');
  }
  function openHistory() {
    loadHistory();
    show('history');
    renderHistory();
    hStatus('');
  }
  function findRecord(key) {
    var parts = key.split('|');
    return state.history.filter(function (r) { return r.uid === parts[0] && String(r.revision) === parts[1]; })[0] || null;
  }
  function onHistoryClick(ev) {
    var btn = ev.target.closest('button[data-act=edit]'); if (!btn) return;
    var rec = findRecord(btn.getAttribute('data-key'));
    if (rec) editRecord(rec);
  }

  // ---------- запуск ----------
  function init() {
    $('#lock-form').addEventListener('submit', async function (ev) {
      ev.preventDefault(); $('#lock-error').textContent = '';
      try { await unlock($('#password').value); } catch (e) { $('#lock-error').textContent = e.message; }
    });
    $('#kp-form').addEventListener('submit', function (ev) { ev.preventDefault(); $('#form-error').textContent = ''; try { build(); } catch (e) { $('#form-error').textContent = e.message; } });
    $('#f-room').addEventListener('change', fillSystems);
    $('#f-system').addEventListener('change', function () { fillAlt(); fillThickness(); });
    $('#f-base').addEventListener('change', applyBaseSuggestion);
    $('#b-pdf').addEventListener('click', getPdf);
    $('#b-chief').addEventListener('click', sendToChief);
    $('#b-client').addEventListener('click', sendToClient);
    $('#b-edit').addEventListener('click', function () { updateFormMode(); show('form'); });
    $('#b-new').addEventListener('click', startNew);
    $('#nav-form').addEventListener('click', function () { if (state.saved || state.editing) startNew(); else show('form'); });
    $('#nav-history').addEventListener('click', openHistory);
    $('#h-search').addEventListener('input', renderHistory);
    $('#h-list').addEventListener('click', onHistoryClick);
    $('#b-h-csv').addEventListener('click', exportCsv);
    $('#b-logout').addEventListener('click', function () { localStorage.removeItem(PW_KEY); state.data = null; state.history = []; show('lock'); });
    window.addEventListener('resize', function () { if (!$('#result').hidden) fitPages(); });
    var saved = localStorage.getItem(PW_KEY);
    if (saved) unlock(saved).catch(function () { localStorage.removeItem(PW_KEY); show('lock'); });
    else show('lock');
  }
  window.KPUI = { build: build, makePdf: makePdf, getPdf: getPdf, unlock: unlock, loadHistory: loadHistory, openHistory: openHistory, startNew: startNew, state: state };
  document.addEventListener('DOMContentLoaded', init);
})();
