/* Интерфейс веб-версии: пароль и расшифровка данных, форма, предпросмотр, PDF в браузере (html2canvas + jsPDF). */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var state = { data: null, ctx: null, kp: null, pdf: null, busy: false };
  var PW_KEY = 'kp_web_password';
  var SCALE_PHONE = 3, SCALE_A4 = 2, JPEG_Q = 0.86;
  var BASE_OPTIONS = ['уточняется при выезде', 'новый бетон', 'старый бетон с дефектами', 'другое покрытие, нужен демонтаж'];

  function show(id) { ['lock', 'form', 'result'].forEach(function (s) { $('#' + s).hidden = s !== id; }); window.scrollTo(0, 0); }
  function status(msg, kind) { var el = $('#status'); el.textContent = msg || ''; el.className = 'status' + (kind ? ' status--' + kind : ''); }

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
    fillForm();
    show('form');
  }

  // ---------- форма ----------
  function option(value, label, selected) { var o = document.createElement('option'); o.value = value; o.textContent = label; if (selected) o.selected = true; return o; }
  function fillSelect(sel, items, selectedValue) { sel.innerHTML = ''; items.forEach(function (it) { sel.appendChild(option(it[0], it[1], it[0] === selectedValue)); }); }
  function nextNumber() {
    var today = KP.fmt.todayIso(); var yymmdd = today.slice(2, 4) + today.slice(5, 7) + today.slice(8, 10);
    var key = 'kp_counter_' + yymmdd; var n = parseInt(localStorage.getItem(key) || '0', 10) + 1;
    return 'KP-' + yymmdd + '-' + String(n).padStart(2, '0');
  }
  function bumpNumber(number) { var m = /^KP-(\d{6})-(\d+)$/.exec(number); if (m) { var key = 'kp_counter_' + m[1]; var n = parseInt(m[2], 10); if (n > parseInt(localStorage.getItem(key) || '0', 10)) localStorage.setItem(key, String(n)); } }
  function fillForm() {
    var d = state.data;
    var rooms = Object.keys(d.rooms.rooms).map(function (k) { return [k, d.rooms.rooms[k].short]; });
    fillSelect($('#f-room'), rooms, 'warehouse');
    var systems = Object.keys(d.systems).filter(function (id) { return d.systems[id].priced; });
    fillSelect($('#f-system'), systems.map(function (id) { return [id, d.systems[id].short + ' · ' + KP.perM2Label(d.systems[id], d.materials) + ' ₸/м²']; }), systems[0]);
    fillSelect($('#f-alt'), [['', 'нет']].concat(systems.map(function (id) { return [id, d.systems[id].short]; })), '');
    fillSelect($('#f-base'), BASE_OPTIONS.map(function (b) { return [b, b]; }), BASE_OPTIONS[0]);
    fillSelect($('#f-ral'), d.palette.basics.map(function (c) { return [c.ral, c.ral + ' · ' + c.name]; }), 'RAL 7035');
    var managers = Object.keys(d.company.managers);
    fillSelect($('#f-manager'), managers.map(function (k) { return [k, d.company.managers[k].name]; }), managers[0]);
    $('#f-manager').closest('.field').hidden = managers.length < 2;
    $('#f-number').value = nextNumber();
    $('#f-valid').textContent = d.company.terms.valid_days;
    $('#f-area').focus();
  }
  function readForm() {
    var number = $('#f-number').value.trim();
    if (!/^KP-\d{6}-\d{2,3}$/.test(number)) throw new Error('Номер в виде KP-ГГММДД-NN, например KP-261124-05.');
    var area = $('#f-area').value.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(area) || Number(area) <= 0) throw new Error('Площадь: число больше нуля, не больше двух знаков после запятой.');
    var object = $('#f-object').value.trim(); if (!object) throw new Error('Заполните «Что за помещение».');
    var company = $('#f-company').value.trim() || object;
    var alt = $('#f-alt').value; var system = $('#f-system').value;
    if (alt === system) alt = '';
    var text = [object, company, $('#f-city').value].join(' ');
    if (/(\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/.test(text) || /@/.test(text)) throw new Error('В КП не должно быть телефонов и почты клиента: уберите их из полей.');
    return {
      number: number, date: KP.fmt.todayIso(), valid_until: null,
      client: { company: company, object: object, city: $('#f-city').value.trim() || null, addressee: null },
      room_type: $('#f-room').value, manager: $('#f-manager').value,
      zones: [{ name: 'Тип пола 1', area_m2: area, system: system }],
      alternatives: alt ? [{ system: alt }] : [],
      colour: { ral: $('#f-ral').value },
      options: { show_cover_price: false, show_comparison: !!alt, show_colour_page: $('#f-colour').checked, a4_separate: false, rounding: 'excel' },
      notes: [$('#f-base').value], status: 'web',
    };
  }

  // ---------- предпросмотр ----------
  function fitPages() {
    var wrap = $('#pages'); var avail = Math.min(document.documentElement.clientWidth, 640) - 24;
    var k = Math.min(1, avail / 390);
    wrap.style.transform = 'scale(' + k + ')';
    wrap.style.height = (wrap.scrollHeight * k) + 'px';
  }
  function build() {
    var kp = readForm();
    var ctx = KP.buildContext(kp, state.data);
    state.kp = kp; state.ctx = ctx; state.pdf = null;
    $('#pages').innerHTML = KP.renderPhone(ctx);
    $('#a4').innerHTML = KP.renderA4(ctx);
    $('#pages').style.height = '';
    $('#r-title').textContent = kp.number + ' · ' + kp.client.object + ' · ' + ctx.zone.area_str + ' м²';
    $('#b-share').hidden = !(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }));
    show('result');
    fitPages();
    status('Проверьте страницы и нажмите «Скачать PDF».');
    var over = [];
    document.querySelectorAll('#pages .page').forEach(function (p, i) { if (p.scrollHeight > p.clientHeight + 1) over.push(i + 1); });
    if (over.length) status('Текст не влезает на страницы ' + over.join(', ') + ': сократите название помещения или компании.', 'warn');
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
      var a4 = $('#a4 .a4');
      var a4img = await rasterize(a4, SCALE_A4);
      doc.addPage('a4', 'portrait');
      var pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
      doc.addImage(a4img, 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
      doc.setProperties({ title: state.kp.number + ' · ' + state.data.company.legal_name, subject: 'Коммерческое предложение', creator: 'kaztop-kp web' });
      var blob = doc.output('blob');
      state.pdf = new File([blob], state.kp.number + '.pdf', { type: 'application/pdf' });
      bumpNumber(state.kp.number);
      status('PDF готов: ' + (pages.length + 1) + ' стр., ' + Math.round(blob.size / 1024) + ' КБ.', 'ok');
      window.__lastPdfSize = blob.size;
      return state.pdf;
    } finally {
      wrap.style.transform = savedTransform; wrap.style.height = savedHeight;
      state.busy = false;
    }
  }
  async function download() {
    try {
      var f = await makePdf(); if (!f) return;
      var url = URL.createObjectURL(f); var a = document.createElement('a'); a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (e) { status('Не удалось собрать PDF: ' + e.message, 'err'); }
  }
  async function share() {
    try {
      var f = await makePdf(); if (!f) return;
      await navigator.share({ files: [f], title: f.name, text: KP.renderWa(state.ctx) });
    } catch (e) { if (e && e.name !== 'AbortError') status('Поделиться не удалось: ' + e.message, 'err'); }
  }
  async function copyText() {
    try { await navigator.clipboard.writeText(KP.renderWa(state.ctx)); status('Текст сообщения скопирован.', 'ok'); }
    catch (e) { $('#wa-text').hidden = false; $('#wa-text').value = KP.renderWa(state.ctx); }
  }

  // ---------- запуск ----------
  function init() {
    $('#lock-form').addEventListener('submit', async function (ev) {
      ev.preventDefault(); $('#lock-error').textContent = '';
      try { await unlock($('#password').value); } catch (e) { $('#lock-error').textContent = e.message; }
    });
    $('#kp-form').addEventListener('submit', function (ev) { ev.preventDefault(); try { build(); } catch (e) { $('#form-error').textContent = e.message; } });
    $('#b-download').addEventListener('click', download);
    $('#b-share').addEventListener('click', share);
    $('#b-copy').addEventListener('click', copyText);
    $('#b-edit').addEventListener('click', function () { show('form'); });
    $('#b-logout').addEventListener('click', function () { localStorage.removeItem(PW_KEY); state.data = null; show('lock'); });
    window.addEventListener('resize', function () { if (!$('#result').hidden) fitPages(); });
    var saved = localStorage.getItem(PW_KEY);
    if (saved) unlock(saved).catch(function () { localStorage.removeItem(PW_KEY); show('lock'); });
    else show('lock');
  }
  window.KPUI = { build: build, makePdf: makePdf, unlock: unlock, state: state };
  document.addEventListener('DOMContentLoaded', init);
})();
