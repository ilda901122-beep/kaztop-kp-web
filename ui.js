/* Интерфейс веб-версии: пароль и расшифровка данных, форма, предпросмотр, PDF в браузере (html2canvas + jsPDF),
   общая история выгрузок (Google Apps Script: PDF на Диске, строка в таблице) или история этого устройства,
   ред. КП с перечнем изменений и статусы «согласовано» / «отправлено клиенту». */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var state = {
    data: null, ctx: null, kp: null, pdf: null, pdfUrl: null, busy: false,
    editing: null,   // запись КП, которую меняем: следующая сборка станет её новой ред.
    saved: null,     // запись последнего сохранённого PDF
    draftUid: null, history: [], sheetUrl: null, suggested: null,
  };
  var PW_KEY = 'kp_web_password', LOCAL_KEY = 'kp_history_local', LOCAL_LIMIT = 60;
  var SCALE_PHONE = 3, SCALE_A4 = 2, JPEG_Q = 0.86;
  var SCREENS = ['lock', 'form', 'result', 'history'];
  var STATUS_NEXT = { 'создано': ['согласовано'], 'согласовано': ['отправлено клиенту'] };

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
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

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
    fillForm();
    updateFormMode();
    show('form');
    loadHistory().then(suggestNumber).catch(function () { /* нет связи: номер остаётся по счётчику устройства */ });
  }

  // ---------- история: сервер или это устройство ----------
  function historyApi() { var h = state.data && state.data.history; return h && h.url && h.token ? h : null; }
  function newUid() {
    var a = new Uint8Array(12); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  async function call(action, payload, timeoutMs) {
    var h = historyApi();
    var ms = timeoutMs || 60000;
    var ctrl = new AbortController(); var timer = setTimeout(function () { ctrl.abort(); }, ms);
    try {
      // тело text/plain без своих заголовков: простой запрос без предварительного OPTIONS, как требует Apps Script
      var res = await fetch(h.url, { method: 'POST', body: JSON.stringify(Object.assign({ token: h.token, action: action }, payload || {})), signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error('сервер истории ответил ' + res.status);
      var text = await res.text();
      try { return JSON.parse(text); } catch (e) { throw new Error('сервер истории ответил не данными: у развёртывания должен быть доступ «Все»'); }
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('сервер истории не ответил за ' + Math.round(ms / 1000) + ' с');
      if (e instanceof TypeError) throw new Error('нет связи с сервером истории (интернет или доступ развёртывания «Все»)');
      throw e;
    } finally { clearTimeout(timer); }
  }
  function errorText(out) {
    var map = { auth: 'ключ истории не подходит, страницу нужно пересобрать', bad_json: 'сервер не понял запрос', too_big: 'PDF слишком большой', not_pdf: 'файл не PDF',
      not_found: 'запись не найдена', bad_status: 'недопустимый статус', unknown_action: 'сервер истории устарел' };
    if (out.error === 'bad_record') return 'ошибка в данных КП' + (out.message ? ' (' + out.message + ')' : '');
    if (out.error === 'server') return 'ошибка сервера истории' + (out.message ? ': ' + out.message : '');
    return map[out.error] || ('сервер истории: ' + (out.error || 'пустой ответ'));
  }
  function localHistory() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch (e) { return []; } }
  function pushLocal(rec) {
    var list = localHistory().filter(function (r) { return !(r.uid === rec.uid && r.revision === rec.revision); });
    list.unshift(rec);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list.slice(0, LOCAL_LIMIT)));
  }
  async function loadHistory() {
    if (!historyApi()) { state.history = localHistory(); return state.history; }
    var out = await call('list', {}, 30000);
    if (!out.ok) throw new Error(errorText(out));
    state.history = out.records.filter(function (r) { return r.status !== 'тест'; });
    state.sheetUrl = out.sheet_url || null;
    return state.history;
  }
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
  function suggestNumber() {
    if (state.editing) return;
    var f = $('#f-number');
    if (!f.value || f.value === state.suggested) { state.suggested = nextNumber(); f.value = state.suggested; }
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
    state.suggested = nextNumber();
    $('#f-number').value = state.suggested;
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
  async function rasterize(el, scale) {
    var canvas = await html2canvas(el, { scale: scale, backgroundColor: '#ffffff', logging: false, useCORS: true, imageTimeout: 15000, width: el.offsetWidth, height: el.offsetHeight, scrollX: 0, scrollY: -window.scrollY });
    return canvas.toDataURL('image/jpeg', JPEG_Q);
  }
  function addLinks(doc, el, w, h) {
    var base = el.getBoundingClientRect(); var kx = w / base.width, ky = h / base.height;
    el.querySelectorAll('a[href]').forEach(function (a) {
      var r = a.getBoundingClientRect();
      doc.link((r.left - base.left) * kx, (r.top - base.top) * ky, r.width * kx, r.height * ky, { url: a.getAttribute('href') });
    });
  }
  async function makePdf() {
    if (state.pdf) return state.pdf;
    if (state.busy) return null;
    state.busy = true;
    var wrap = $('#pages'); var savedTransform = wrap.style.transform, savedHeight = wrap.style.height;
    wrap.style.transform = 'none'; wrap.style.height = '';
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      var jsPDF = window.jspdf.jsPDF;
      var doc = new jsPDF({ unit: 'px', format: [390, 693], orientation: 'portrait', hotfixes: ['px_scaling'], compress: true });
      var pages = Array.prototype.slice.call(wrap.querySelectorAll('.page'));
      for (var i = 0; i < pages.length; i++) {
        status('Собираю страницу ' + (i + 1) + ' из ' + (pages.length + 1) + '…');
        if (i > 0) doc.addPage([390, 693], 'portrait');
        var img = await rasterize(pages[i], SCALE_PHONE);
        doc.addImage(img, 'JPEG', 0, 0, 390, 693, undefined, 'FAST');
        addLinks(doc, pages[i], 390, 693);
      }
      status('Собираю страницу ' + (pages.length + 1) + ' из ' + (pages.length + 1) + '…');
      var a4img = await rasterize($('#a4 .a4'), SCALE_A4);
      doc.addPage('a4', 'portrait');
      var pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
      doc.addImage(a4img, 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
      doc.setProperties({ title: state.kp.number + (state.kp.revision > 1 ? ' ред. ' + state.kp.revision : '') + ' · ' + state.data.company.legal_name, subject: 'Коммерческое предложение', creator: 'kaztop-kp web' });
      var blob = doc.output('blob');
      var name = state.kp.number + (state.kp.revision > 1 ? '-ред' + state.kp.revision : '') + '.pdf';
      state.pdf = new File([blob], name, { type: 'application/pdf' });
      status('PDF готов: ' + (pages.length + 1) + ' стр., ' + Math.round(blob.size / 1024) + ' КБ.', 'ok');
      window.__lastPdfSize = blob.size;
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
    $('#b-share').hidden = !canShareFiles();
    $('#linkbox').hidden = true; $('#b-retry').hidden = true;
    setStep('ready');
  }
  function fileToB64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = function () { reject(new Error('не удалось прочитать PDF')); };
      r.readAsDataURL(file);
    });
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
      params: kp, test: !!window.__kpTest,
    };
    rec.changes = state.editing ? diffText(state.editing, rec) : '';
    return rec;
  }
  function showLink(url) {
    $('#pdf-link').href = url; $('#pdf-link').textContent = url.replace(/^https?:\/\//, '');
    $('#linkbox').hidden = !url;
  }
  function afterSaved(rec) {
    state.saved = rec; state.editing = rec;
    state.history = [rec].concat(state.history.filter(function (r) { return !(r.uid === rec.uid && r.revision === rec.revision); }));
    bumpNumber(rec.number);
    updateFormMode();
  }
  async function saveToHistory() {
    var rec = buildRecord();
    if (!historyApi()) {
      rec.created_at = nowIso(); rec.status = 'создано'; rec.pdf_url = '';
      pushLocal(rec);
      afterSaved(rec);
      status('PDF готов. Общая история не подключена: запись сохранена только на этом устройстве.', 'warn');
      return rec;
    }
    status('Сохраняю PDF в общую историю…');
    try {
      for (var attempt = 0; attempt < 3; attempt++) {
        var out = await call('save', { record: rec, pdf_b64: await fileToB64(state.pdf) }, 120000);
        if (out.ok) {
          pushLocal(out.record);
          afterSaved(out.record);
          showLink(out.record.pdf_url);
          $('#b-retry').hidden = true;
          if (out.warning) status('PDF сохранён в истории, но ' + out.warning, 'warn');
          else status('PDF сохранён в истории: ссылку можно отправить руководителю, она откроется и без пароля.', 'ok');
          return out.record;
        }
        if (out.error !== 'conflict') throw new Error(errorText(out));
        if (out.number) { state.kp.number = out.number; if (!state.editing) $('#f-number').value = out.number; }
        if (out.revision) state.kp.revision = out.revision;
        status('Номер или ред. уже заняты, собираю PDF заново как ' + state.kp.number + (state.kp.revision > 1 ? ' ред. ' + state.kp.revision : '') + '…', 'warn');
        render();
        readyPdf(await makePdf());
        rec = buildRecord();
      }
      throw new Error('номер занят несколько раз подряд, откройте историю и попробуйте снова');
    } catch (e) {
      $('#b-retry').hidden = false;
      status('PDF готов, но в историю не сохранился: ' + e.message + '. Файл можно скачать или нажать «Сохранить в историю ещё раз».', 'err');
      return null;
    }
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
      (s && s.changes ? '\nИзменено: ' + s.changes : '') + (s && s.pdf_url ? '\nPDF: ' + s.pdf_url : '');
  }
  async function copy(text, okMsg, report) {
    try { await navigator.clipboard.writeText(text); report(okMsg, 'ok'); return true; }
    catch (e) { window.prompt('Скопируйте:', text); return false; }
  }
  function sendToChief() {
    var text = chiefText();
    if (state.saved && state.saved.pdf_url) { window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener'); return; }
    if (canShareFiles()) { navigator.share({ files: [state.pdf], text: text }).catch(function (e) { if (e && e.name !== 'AbortError') status('Отправить не удалось: ' + e.message, 'err'); }); return; }
    copy(text, 'Текст для руководителя скопирован. Файл скачайте кнопкой «Скачать PDF» и приложите.', status);
  }
  function shareFile() {
    navigator.share({ files: [state.pdf], title: state.pdf.name, text: KP.renderWa(state.ctx) })
      .catch(function (e) { if (e && e.name !== 'AbortError') status('Поделиться не удалось: ' + e.message, 'err'); });
  }
  async function copyClientText() {
    try { await navigator.clipboard.writeText(KP.renderWa(state.ctx)); status('Текст для клиента скопирован.', 'ok'); }
    catch (e) { $('#wa-text').hidden = false; $('#wa-text').value = KP.renderWa(state.ctx); }
  }

  // ---------- экран истории ----------
  function groupHistory(list) {
    var groups = {}, order = [];
    list.forEach(function (r) { var k = r.uid || r.number; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(r); });
    return order.map(function (k) { return groups[k].sort(function (a, b) { return b.revision - a.revision; }); })
      .sort(function (a, b) { return String(b[0].created_at).localeCompare(String(a[0].created_at)); });
  }
  function statusClass(st) { return { 'согласовано': 'ok', 'отправлено клиенту': 'sent', 'отказ': 'no' }[st] || 'new'; }
  function card(g) {
    var r = g[0], older = g.slice(1), key = esc(r.uid) + '|' + r.revision;
    var actions = (r.pdf_url ? '<a class="hbtn" href="' + esc(r.pdf_url) + '" target="_blank" rel="noopener">Открыть PDF</a><button type="button" class="hbtn" data-act="copy" data-key="' + key + '">Ссылка</button>' : '') +
      '<button type="button" class="hbtn" data-act="edit" data-key="' + key + '">Изменить</button>' +
      (historyApi() ? (STATUS_NEXT[r.status] || []).map(function (st) { return '<button type="button" class="hbtn hbtn--st" data-act="status" data-status="' + st + '" data-key="' + key + '">' + cap(st) + '</button>'; }).join('') : '');
    var olderHtml = older.length ? '<details class="hcard__older"><summary>Ранние ред. (' + older.length + ')</summary><ul>' + older.map(function (o) {
      return '<li><b>ред. ' + o.revision + '</b> · ' + fmtWhen(o.created_at) + ' · ' + fmtNum(o.total) + ' ₸' + (o.pdf_url ? ' · <a href="' + esc(o.pdf_url) + '" target="_blank" rel="noopener">PDF</a>' : '') +
        (o.changes ? '<div class="hcard__chg">' + esc(o.changes) + '</div>' : '') + '</li>';
    }).join('') + '</ul></details>' : '';
    return '<article class="hcard"><div class="hcard__top"><b>' + esc(r.number) + '</b>' + (r.revision > 1 ? ' <span class="muted-inline">ред. ' + r.revision + '</span>' : '') +
      '<span class="chip chip--' + statusClass(r.status) + '">' + esc(r.status || 'создано') + '</span></div>' +
      '<div class="hcard__title">' + esc(r.object) + (r.city ? ' · ' + esc(r.city) : '') + '</div>' +
      '<div class="hcard__meta">' + fmtNum(r.area) + ' м² · ' + esc(r.system_title) + (r.th_mm ? ', ' + fmtNum(r.th_mm) + ' мм' : '') + (r.addons ? ' · ' + esc(r.addons) : '') + '</div>' +
      '<div class="hcard__sum"><b>' + fmtNum(r.total) + ' ₸</b> · ' + fmtNum(r.per_m2) + ' ₸/м²' + (r.estimated ? ' · <span class="warn-inline">оценочные цены</span>' : '') + '</div>' +
      (r.changes ? '<div class="hcard__chg">Изменено: ' + esc(r.changes) + '</div>' : '') +
      '<div class="hcard__when">' + fmtWhen(r.created_at) + (r.manager_name ? ' · ' + esc(r.manager_name) : '') + '</div>' +
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
  function historyNote() {
    $('#h-note').innerHTML = historyApi()
      ? 'Все КП менеджеров: кто, когда, какой расчёт и что менялось. PDF по ссылке открывается без пароля.' + (state.sheetUrl ? ' <a href="' + esc(state.sheetUrl) + '" target="_blank" rel="noopener">Таблица истории</a> (доступ у руководителя).' : '')
      : 'Общая история пока не подключена: здесь только КП с этого устройства, без файлов PDF.';
  }
  async function openHistory() {
    show('history');
    historyNote();
    renderHistory();
    hStatus('Обновляю…');
    try { await loadHistory(); historyNote(); renderHistory(); hStatus(''); }
    catch (e) { hStatus('Не удалось загрузить историю: ' + e.message, 'err'); }
  }
  function findRecord(key) {
    var parts = key.split('|');
    return state.history.filter(function (r) { return r.uid === parts[0] && String(r.revision) === parts[1]; })[0] || null;
  }
  async function onHistoryClick(ev) {
    var btn = ev.target.closest('button[data-act]'); if (!btn) return;
    var rec = findRecord(btn.getAttribute('data-key')); if (!rec) return;
    var act = btn.getAttribute('data-act');
    if (act === 'edit') { editRecord(rec); return; }
    if (act === 'copy') { copy(rec.pdf_url, 'Ссылка на PDF ' + rec.number + ' скопирована.', hStatus); return; }
    if (act === 'status') {
      var st = btn.getAttribute('data-status');
      btn.disabled = true;
      try {
        var out = await call('status', { uid: rec.uid, revision: rec.revision, status: st }, 30000);
        if (!out.ok) throw new Error(errorText(out));
        rec.status = st; renderHistory(); hStatus(rec.number + ': ' + st + '.', 'ok');
      } catch (e) { btn.disabled = false; hStatus('Статус не изменён: ' + e.message, 'err'); }
    }
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
    $('#b-share').addEventListener('click', shareFile);
    $('#b-retry').addEventListener('click', function () { $('#b-retry').hidden = true; saveToHistory(); });
    $('#b-link-copy').addEventListener('click', function () { copy($('#pdf-link').href, 'Ссылка на PDF скопирована.', status); });
    $('#b-copy').addEventListener('click', copyClientText);
    $('#b-edit').addEventListener('click', function () { updateFormMode(); show('form'); });
    $('#b-new').addEventListener('click', startNew);
    $('#nav-form').addEventListener('click', function () { if (state.saved || state.editing) startNew(); else show('form'); });
    $('#nav-history').addEventListener('click', openHistory);
    $('#b-h-refresh').addEventListener('click', openHistory);
    $('#h-search').addEventListener('input', renderHistory);
    $('#h-list').addEventListener('click', onHistoryClick);
    $('#b-logout').addEventListener('click', function () { localStorage.removeItem(PW_KEY); state.data = null; state.history = []; show('lock'); });
    window.addEventListener('resize', function () { if (!$('#result').hidden) fitPages(); });
    var saved = localStorage.getItem(PW_KEY);
    if (saved) unlock(saved).catch(function () { localStorage.removeItem(PW_KEY); show('lock'); });
    else show('lock');
  }
  window.KPUI = { build: build, makePdf: makePdf, getPdf: getPdf, unlock: unlock, loadHistory: loadHistory, openHistory: openHistory, startNew: startNew, state: state };
  document.addEventListener('DOMContentLoaded', init);
})();
