/* Ядро веб-версии КП Kaztop: расчёт (точная арифметика на BigInt, округление половина вверх),
   контекст и разметка страниц. Зеркало tools/calc.py, tools/build_kp.py и templates/*.j2:
   тест tests/test_web.py сверяет текст страниц и итоги с Python. Работает в браузере и в Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var NB = ' ';
  var AREA_S = 2, RATE_S = 3, PRICE_S = 2;
  var LAYER_ROLES = ['primer', 'base', 'base_thick', 'aggregate', 'finish', 'sealer'];
  var PAGE_ORDER = ['cover', 'object', 'layers', 'price', 'estimate', 'compare', 'why', 'process', 'colour', 'next'];
  var FACT_KEYS = ['production', 'stock', 'shipping', 'delivery_astana_free', 'own_crew', 'lab', 'cert_stkz'];
  var MAX_FACTS = 4;
  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  // ---------- точные числа ----------
  function pow10(n) { return 10n ** BigInt(n); }
  function parseDec(str, scale) {
    var s = String(str).trim().replace(',', '.').replace(/\s/g, '');
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('не число: ' + str);
    var parts = s.split('.');
    var frac = parts[1] || '';
    if (frac.length > scale) throw new Error('слишком много знаков после запятой: ' + str);
    while (frac.length < scale) frac += '0';
    return BigInt(parts[0]) * pow10(scale) + BigInt(frac || '0');
  }
  function roundHalfUp(v, div) { return (2n * v + div) / (2n * div); }
  function group(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, NB); }
  function fmtScaled(v, scale, nd) {
    var r = roundHalfUp(v, pow10(scale - nd));
    var s = r.toString();
    while (s.length < nd + 1) s = '0' + s;
    var intPart = nd ? s.slice(0, -nd) : s;
    var frac = nd ? s.slice(-nd) : '';
    return nd ? group(intPart) + ',' + frac : group(intPart);
  }
  function fmtPrice(priceC) { return priceC % 100n === 0n ? fmtScaled(priceC, PRICE_S, 0) : fmtScaled(priceC, PRICE_S, 2); }
  function fmtRate(str) {
    var s = String(str).replace(',', '.');
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s.replace('.', ',');
  }
  function fmtInt(v) { return group(v.toString()); }
  function pl(n, one, few, many) {
    var k = Math.abs(Number(n));
    if (k % 10 === 1 && k % 100 !== 11) return one;
    if (k % 10 >= 2 && k % 10 <= 4 && !(k % 100 >= 12 && k % 100 <= 14)) return few;
    return many;
  }
  function isoParts(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); if (!m) throw new Error('дата не ISO: ' + iso); return [+m[1], +m[2], +m[3]]; }
  function dmy(iso) { var p = isoParts(iso); return String(p[2]).padStart(2, '0') + '.' + String(p[1]).padStart(2, '0') + '.' + p[0]; }
  function dateWords(iso) { var p = isoParts(iso); return p[2] + ' ' + MONTHS[p[1] - 1] + ' ' + p[0]; }
  function addDays(iso, days) {
    var p = isoParts(iso); var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function todayIso() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ---------- расчёт ----------
  function calcZone(areaStr, system, materials, mode) {
    mode = mode || 'excel';
    if (mode !== 'excel' && mode !== 'lines') throw new Error('режим округления ' + mode);
    var area = parseDec(areaStr, AREA_S);
    if (area <= 0n) throw new Error('площадь должна быть больше нуля');
    var mats = [];
    var groups = [['layer', system.layers || []], ['consumable', system.consumables || []]];
    groups.forEach(function (g) {
      g[1].forEach(function (row) {
        var m = materials.items[row.code];
        if (!m) throw new Error('нет материала ' + row.code);
        var rate = parseDec(row.rate, RATE_S);
        var price = parseDec(m.price, PRICE_S);
        var qty = area * rate;                 // scale 5
        var exact = qty * price;               // scale 7
        var shown = roundHalfUp(exact, pow10(7));
        mats.push({ kind: g[0], code: row.code, name: m.name, client_name: m.client_name || m.name, client_text: m.client_text || '',
          role: m.role, unit: m.unit, rate: row.rate, rate_str: fmtRate(row.rate), qty_str: fmtScaled(qty, 5, 2),
          price_str: fmtPrice(price), exact7: exact, shown: shown, sum_str: fmtInt(shown) });
      });
    });
    var works = [];
    system.works.forEach(function (w) {
      var price = parseDec(w.price, PRICE_S);
      var exact7 = area * price * 1000n;       // scale 4 -> 7
      var shown = roundHalfUp(exact7, pow10(7));
      works.push({ name: w.name, unit: 'м2', qty_str: fmtScaled(area, AREA_S, 2), price_str: fmtPrice(price), exact7: exact7, shown: shown, sum_str: fmtInt(shown) });
    });
    var worksTotal7 = works.reduce(function (a, w) { return a + w.exact7; }, 0n);
    var matTotal7 = mats.reduce(function (a, m) { return a + (mode === 'excel' ? m.exact7 : m.shown * pow10(7)); }, 0n);
    var total7 = worksTotal7 + matTotal7;
    var perM2 = roundHalfUp(total7, area * pow10(5));
    var matPct = total7 > 0n ? Number(roundHalfUp(matTotal7 * 100n, total7)) : 0;
    var q = function (v7) { return roundHalfUp(v7, pow10(7)); };
    return {
      mode: mode, area: area, system_id: system.id, materials: mats,
      layers: mats.filter(function (m) { return LAYER_ROLES.indexOf(m.role) >= 0; }),
      works: works,
      works_total: q(worksTotal7), materials_total: q(matTotal7), total: q(total7), per_m2: perM2,
      materials_pct: matPct, works_pct: 100 - matPct,
      area_str: area % 100n === 0n ? fmtScaled(area, AREA_S, 0) : fmtScaled(area, AREA_S, 2),
    };
  }

  // ---------- схема слоёв ----------
  var SVG = { W: 350, X0: 36, XR: 252, DX: 62, DY: -30, STEP: 24, PAD_TOP: 8, PAD_BOT: 10, CONCRETE_H: 54 };
  var HEIGHTS = { primer: 16, base: 30, base_thick: 58, aggregate: 22, finish: 26, sealer: 12 };
  var COLORS = { concrete: ['#b9bec0', '#a0a6a9', '#d0d4d5'], primer: ['#bfe6ee', '#9fd0da', '#d8f0f5'], base: ['#d9c9a6', '#c3b28e', '#e6dabd'],
    base_thick: ['#8e9da2', '#78878c', '#a4b1b5'], aggregate: ['#e3d7b8', '#ccbf9e', '#ece3cb'], sealer: ['#eef6f8', '#d5e3e7', '#f7fbfc'] };
  function shade(hex, k) {
    var h = hex.replace('#', ''); var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    if (k < 0) { var f = 1 + k; r = Math.floor(r * f); g = Math.floor(g * f); b = Math.floor(b * f); }
    else { r = Math.floor(r + (255 - r) * k); g = Math.floor(g + (255 - g) * k); b = Math.floor(b + (255 - b) * k); }
    var hx = function (n) { return n.toString(16).padStart(2, '0'); };
    return '#' + hx(r) + hx(g) + hx(b);
  }
  function faces(x0, y, h, front, side, top, pattern, p) {
    var XR = SVG.XR, DX = SVG.DX, DY = SVG.DY; var out = [];
    out.push('<polygon points="' + x0 + ',' + y + ' ' + (x0 + DX) + ',' + (y + DY) + ' ' + (XR + DX) + ',' + (y + DY) + ' ' + XR + ',' + y + '" fill="' + top + '"/>');
    out.push('<polygon points="' + XR + ',' + y + ' ' + (XR + DX) + ',' + (y + DY) + ' ' + (XR + DX) + ',' + (y + h + DY) + ' ' + XR + ',' + (y + h) + '" fill="' + side + '"/>');
    out.push('<rect x="' + x0 + '" y="' + y + '" width="' + (XR - x0) + '" height="' + h + '" fill="' + front + '"/>');
    if (pattern) {
      out.push('<rect x="' + x0 + '" y="' + y + '" width="' + (XR - x0) + '" height="' + h + '" fill="url(#' + p + '-' + pattern + ')"/>');
      out.push('<polygon points="' + x0 + ',' + y + ' ' + (x0 + DX) + ',' + (y + DY) + ' ' + (XR + DX) + ',' + (y + DY) + ' ' + XR + ',' + y + '" fill="url(#' + p + '-' + pattern + ')" opacity="0.7"/>');
    }
    out.push('<path d="M' + x0 + ',' + y + ' H' + XR + ' L' + (XR + DX) + ',' + (y + DY) + ' M' + XR + ',' + y + ' V' + (y + h) + '" fill="none" stroke="rgba(6,23,28,0.22)" stroke-width="1"/>');
    return out.join('\n');
  }
  function layersSvg(layers, finishHex, prefix) {
    var p = prefix || 'l';
    var roles = layers.map(function (l) { return l.role; });
    var totalH = SVG.CONCRETE_H + roles.reduce(function (a, r) { return a + (HEIGHTS[r] || 24); }, 0);
    var H = SVG.PAD_TOP - SVG.DY + totalH + SVG.PAD_BOT;
    var defs = '<defs>' +
      '<pattern id="' + p + '-speckle" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="3" cy="4" r="1.3" fill="#7d868a" opacity="0.55"/><circle cx="9" cy="9" r="1" fill="#7d868a" opacity="0.4"/><circle cx="7" cy="2" r="0.7" fill="#fff" opacity="0.6"/></pattern>' +
      '<pattern id="' + p + '-quartz" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="2" cy="3" r="1.3" fill="#fff" opacity="0.7"/><circle cx="7" cy="7" r="1" fill="#a98b5c" opacity="0.6"/></pattern>' +
      '<pattern id="' + p + '-crumb" width="14" height="14" patternUnits="userSpaceOnUse"><rect x="2" y="3" width="4" height="3" fill="#5f6d72" opacity="0.5" transform="rotate(20 4 4)"/><rect x="8" y="8" width="3" height="4" fill="#c9d3d6" opacity="0.6" transform="rotate(-25 9 10)"/></pattern>' +
      '<pattern id="' + p + '-sand" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="#b89a6a" opacity="0.7"/><circle cx="6" cy="5" r="0.9" fill="#fff" opacity="0.8"/><circle cx="3" cy="6" r="0.6" fill="#8f7445" opacity="0.6"/></pattern>' +
      '<linearGradient id="' + p + '-gloss" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.55" stop-color="#fff" stop-opacity="0.08"/><stop offset="1" stop-color="#fff" stop-opacity="0.35"/></linearGradient>' +
      '</defs>';
    var body = [];
    var y = H - SVG.PAD_BOT;
    y -= SVG.CONCRETE_H;
    var c = COLORS.concrete;
    body.push(faces(SVG.X0, y, SVG.CONCRETE_H, c[0], c[1], c[2], 'speckle', p));
    var badges = []; var x = SVG.X0;
    roles.forEach(function (role, idx) {
      var h = HEIGHTS[role] || 24; y -= h; x += SVG.STEP;
      var front, side, top, pattern = null;
      if (role === 'finish') { front = finishHex; side = shade(finishHex, -0.22); top = shade(finishHex, 0.18); }
      else { var cc = COLORS[role] || COLORS.base; front = cc[0]; side = cc[1]; top = cc[2]; pattern = { base: 'quartz', base_thick: 'crumb', aggregate: 'sand' }[role] || null; }
      body.push(faces(x, y, h, front, side, top, pattern, p));
      if (role === 'finish') body.push('<polygon points="' + x + ',' + y + ' ' + (x + SVG.DX) + ',' + (y + SVG.DY) + ' ' + (SVG.XR + SVG.DX) + ',' + (y + SVG.DY) + ' ' + SVG.XR + ',' + y + '" fill="url(#' + p + '-gloss)"/>');
      badges.push([idx + 1, x, y + h / 2]);
    });
    badges.forEach(function (b) {
      var bx = 14, cy = b[2].toFixed(1);
      body.push('<line x1="' + (bx + 11) + '" y1="' + cy + '" x2="' + (b[1] - 2) + '" y2="' + cy + '" stroke="#06171c" stroke-width="1" opacity="0.5"/>');
      body.push('<circle cx="' + bx + '" cy="' + cy + '" r="11" fill="#06171c"/>');
      body.push('<text x="' + bx + '" y="' + (b[2] + 4.2).toFixed(1) + '" text-anchor="middle" font-family="Manrope, sans-serif" font-size="12" font-weight="700" fill="#fff">' + b[0] + '</text>');
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + SVG.W + ' ' + H + '" width="100%" role="img" aria-label="Схема слоёв пола">' + defs + '\n' + body.join('\n') + '</svg>';
  }

  // ---------- контекст ----------
  function ralHex(palette, ral) {
    var all = palette.basics.concat(palette.colors);
    for (var i = 0; i < all.length; i++) if (all[i].ral === ral) return [all[i].ral, all[i].hex];
    return [palette.basics[1].ral, palette.basics[1].hex];
  }
  function zoneCtx(z, data, mode) {
    var system = data.systems[z.system];
    if (!system) throw new Error('рецептура ' + z.system + ' неизвестна');
    var r = calcZone(z.area_m2, system, data.materials, mode);
    var works = r.works.map(function (w, i) { return { n: i + 1, name: w.name, qty_str: w.qty_str, price_str: w.price_str, sum_str: w.sum_str }; });
    var materials = [], layers = [], consumables = []; var k = 0;
    r.materials.forEach(function (m, i) {
      var row = { n: works.length + 1 + i, code: m.code, name: m.name, client_name: m.client_name, client_text: m.client_text, role: m.role, unit: m.unit,
        rate_str: m.rate_str, qty_str: m.qty_str, price_str: m.price_str, sum_str: m.sum_str };
      materials.push(row);
      if (LAYER_ROLES.indexOf(m.role) >= 0) { k += 1; layers.push(Object.assign({}, row, { n: k })); } else consumables.push(row);
    });
    var name = z.name || 'Тип пола 1';
    return { name: name, name_dat: name.replace('Тип пола', 'Типу пола'), area_str: r.area_str, system: system, materials: materials, layers: layers,
      consumables: consumables, works: works, works_total_str: fmtInt(r.works_total), materials_total_str: fmtInt(r.materials_total),
      total_str: fmtInt(r.total), per_m2_str: fmtInt(r.per_m2), materials_pct: r.materials_pct, works_pct: r.works_pct, calc: r };
  }
  function cureCtx(zone, data) {
    if (data.company.flags.show_cure_times === false) return null;
    var top = zone.layers.length ? zone.layers[zone.layers.length - 1] : null;
    if (!top) return null;
    var m = data.materials.items[top.code]; var cure = m.cure;
    if (!cure || cure.temps_c.indexOf(20) < 0) return null;
    var i = cure.temps_c.indexOf(20); var full = cure.full_load_days[i];
    var out = { material: m.client_name, temp: '+' + cure.temps_c[i] + NB + '°C', walk: 'ходить через ' + cure.walk[i], full: 'через ' + full + ' ' + pl(full, 'сутки', 'суток', 'суток'), chem: null };
    if (cure.chem_days) { var d = cure.chem_days[i]; out.chem = 'через ' + d + ' ' + pl(d, 'сутки', 'суток', 'суток'); }
    return out;
  }
  function photoSrc(file, base) { return (base || 'assets/photos/') + file; }
  function buildContext(kp, data, opts) {
    opts = opts || {};
    var company = data.company; var o = kp.options || {}; var mode = o.rounding || 'excel';
    var zone = zoneCtx(kp.zones[0], data, mode);
    var alternatives = o.show_comparison ? (kp.alternatives || []).map(function (a) { return zoneCtx({ area_m2: kp.zones[0].area_m2, system: a.system, name: zone.name }, data, mode); }) : [];
    var room = data.rooms.rooms[kp.room_type]; if (!room) throw new Error('тип помещения ' + kp.room_type + ' неизвестен');
    var rh = ralHex(data.palette, (kp.colour || {}).ral); var ral = rh[0], hex = rh[1];
    var svg = layersSvg(zone.layers.map(function (l) { return { role: l.role }; }), hex, 's');
    var validUntil = kp.valid_until || addDays(kp.date, company.terms.valid_days);
    var manager = company.managers[kp.manager]; if (!manager) throw new Error('менеджер ' + kp.manager + ' неизвестен');
    var waText = 'По КП ' + kp.number + ': ';
    var exclude = company.flags.exclude_photos || [];
    var roomPhotos = (data.photos.rooms[kp.room_type] || []).filter(function (p) { return exclude.indexOf(p.file.replace(/\.[a-z]+$/, '')) < 0; });
    if (!roomPhotos.length) throw new Error('нет фото для типа помещения ' + kp.room_type);
    var photo = function (p) { return { src: photoSrc(p.file, opts.photoBase), caption: p.caption }; };
    var showObjects = company.flags.show_objects !== false;
    var photos = { cover: photo(roomPhotos[0]), similar: showObjects ? roomPhotos.slice(1, 3).map(photo) : [] };
    var projects = showObjects ? data.projects.items.filter(function (p) { return p.rooms.indexOf(kp.room_type) >= 0; }).slice(0, 3) : [];
    var facts = FACT_KEYS.filter(function (k) { return company.facts[k]; }).map(function (k) { return company.facts[k]; });
    [['years', 'show_years'], ['warranty', 'show_warranty'], ['iso', 'show_iso']].forEach(function (pair) { if (company.flags[pair[1]] && company.facts[pair[0]]) facts.push(company.facts[pair[0]]); });
    facts = facts.slice(0, MAX_FACTS);
    var palette = null;
    if (o.show_colour_page) {
      palette = { basics: data.palette.basics.map(function (c) { return Object.assign({}, c, { chosen: c.ral === ral }); }),
        flakes: data.palette.flakes.slice(0, 6).map(function (f) { return { id: f.id, src: (opts.flakeBase || 'assets/flakes/') + f.file }; }),
        chosen: ral, disclaimer: data.palette.disclaimer };
    }
    var pages = PAGE_ORDER.filter(function (p) { return (p !== 'compare' || alternatives.length) && (p !== 'colour' || palette); });
    var pageNo = {}; pages.forEach(function (p, i) { pageNo[p] = i + 1; });
    var notes = kp.notes || []; var vat = data.materials.vat;
    return {
      company: company, manager: manager,
      kp: { number: kp.number, date_dmy: dmy(kp.date), date_words: dateWords(kp.date), valid_until_dmy: dmy(validUntil), valid_until_words: dateWords(validUntil),
        client: kp.client, addressee: kp.client.addressee || company.addressee_default, base_note: notes.length ? notes[0] : 'уточняется при выезде', notes: notes, status: kp.status || 'draft' },
      room: room, zone: zone, alternatives: alternatives, svg: svg, photos: photos, projects: projects, facts: facts, steps: data.process.steps,
      cure: cureCtx(zone, data), palette: palette, pages: pages, page_no: pageNo, page_total: pages.length,
      wa: { url: 'https://wa.me/' + manager.whatsapp + '?text=' + encodeURIComponent(waText), text: waText, tel: 'tel:' + manager.tel },
      vat_note: vat ? 'Цены указаны ' + vat + '.' : null, ral: { code: ral, hex: hex }, mode: mode,
    };
  }

  // ---------- разметка (зеркало templates/kp_phone.html.j2) ----------
  var LOGO = '<svg class="__CLS__" viewBox="0 0 100 100" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"><line x1="50" y1="4" x2="10.16" y2="27"/><line x1="10.16" y1="27" x2="10.16" y2="73"/><line x1="10.16" y1="73" x2="50" y2="96"/><line x1="50" y1="96" x2="89.84" y2="73"/><line x1="89.84" y1="73" x2="89.84" y2="27"/><line x1="89.84" y1="27" x2="50" y2="4"/><line x1="67.02" y1="20.52" x2="32.98" y2="20.52"/><line x1="32.98" y1="20.52" x2="15.96" y2="50"/><line x1="15.96" y1="50" x2="32.98" y2="79.48"/><line x1="32.98" y1="79.48" x2="67.02" y2="79.48"/><line x1="67.02" y1="79.48" x2="84.04" y2="50"/><line x1="84.04" y1="50" x2="67.02" y2="20.52"/><line x1="50" y1="4" x2="32.98" y2="20.52"/><line x1="50" y1="4" x2="67.02" y2="20.52"/><line x1="10.16" y1="27" x2="15.96" y2="50"/><line x1="10.16" y1="27" x2="32.98" y2="20.52"/><line x1="10.16" y1="73" x2="32.98" y2="79.48"/><line x1="10.16" y1="73" x2="15.96" y2="50"/><line x1="50" y1="96" x2="32.98" y2="79.48"/><line x1="50" y1="96" x2="67.02" y2="79.48"/><line x1="89.84" y1="73" x2="67.02" y2="79.48"/><line x1="89.84" y1="73" x2="84.04" y2="50"/><line x1="89.84" y1="27" x2="67.02" y2="20.52"/><line x1="89.84" y1="27" x2="84.04" y2="50"/></svg>';
  var WA_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M.06 24l1.69-6.16a11.87 11.87 0 0 1-1.6-5.95C.15 5.32 5.5 0 12.06 0a11.82 11.82 0 0 1 8.42 3.49 11.78 11.78 0 0 1 3.48 8.4c0 6.55-5.35 11.88-11.91 11.88a12 12 0 0 1-5.71-1.45L.06 24zm6.54-3.8c1.68 1 3.28 1.59 5.45 1.59 5.45 0 9.89-4.42 9.89-9.88a9.8 9.8 0 0 0-2.9-7 9.72 9.72 0 0 0-6.98-2.9c-5.46 0-9.9 4.43-9.9 9.88a9.78 9.78 0 0 0 1.51 5.26l-1 3.65 3.93-1.6zm11.3-5.6c-.07-.12-.27-.2-.56-.34s-1.76-.87-2.03-.97-.47-.15-.67.15-.77.96-.94 1.16-.34.22-.63.08a8.13 8.13 0 0 1-2.39-1.47 9 9 0 0 1-1.66-2.06c-.17-.3 0-.46.13-.6s.3-.34.44-.52a2 2 0 0 0 .3-.5.55.55 0 0 0-.03-.52c-.07-.15-.67-1.62-.92-2.22s-.49-.5-.67-.51h-.57a1.1 1.1 0 0 0-.8.37 3.35 3.35 0 0 0-1.04 2.49 5.8 5.8 0 0 0 1.22 3.09 13.3 13.3 0 0 0 5.1 4.5c.71.31 1.27.5 1.7.63.72.23 1.37.2 1.88.12.58-.09 1.76-.72 2-1.41s.26-1.29.18-1.42z"/></svg>';
  function logo(cls) { return LOGO.replace('__CLS__', cls || ''); }
  function rh(ctx, page) {
    return '<div class="rh"><span class="rh__brand">' + logo('') + esc(ctx.company.brand) + '</span><span class="rh__num">' + esc(ctx.kp.number) + ' · ' + ctx.page_no[page] + ' / ' + ctx.page_total + '</span></div>';
  }
  function ticks(items) { return '<ul class="ticks">' + items.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>'; }
  function renderPhone(ctx) {
    var c = ctx, k = ctx.kp, z = ctx.zone, s = [];
    s.push('<section class="page cover">' +
      '<div class="cover__photo" style="background-image: url(\'' + esc(c.photos.cover.src) + '\')"></div><div class="cover__shade"></div>' +
      '<div class="cover__brand">' + logo('') + esc(c.company.brand) + '</div>' +
      '<div class="cover__body"><div class="eyebrow">Коммерческое предложение</div><h1 class="cover__title">' + esc(k.client.object) + '</h1>' +
      '<p class="cover__meta"><strong>' + z.area_str + ' м²</strong>' + (k.client.city ? ' · ' + esc(k.client.city) : '') + ' · ' + esc(k.client.company) + '</p>' +
      '<p class="cover__sys">Пол: <b>' + esc(z.system.title) + '</b></p>' +
      '<div class="cover__foot"><span>№ <b>' + esc(k.number) + '</b><br>от ' + k.date_words + '</span><span>действует до<br><b>' + k.valid_until_words + '</b></span></div></div></section>');
    s.push('<section class="page">' + rh(c, 'object') + '<h2>Ваш объект</h2><div class="card"><dl class="kv">' +
      '<dt>Помещение</dt><dd>' + esc(k.client.object) + '</dd><dt>Тип</dt><dd>' + esc(c.room.short) + '</dd><dt>Площадь</dt><dd>' + z.area_str + ' м²</dd>' +
      (k.client.city ? '<dt>Город</dt><dd>' + esc(k.client.city) + '</dd>' : '') + '<dt>Основание</dt><dd>' + esc(k.base_note) + '</dd></dl></div>' +
      '<div class="sect"><h3>Что важно для такого пола</h3>' + ticks(c.room.adv.slice(0, 4)) + '</div>' +
      '<div class="sect"><h3>Предлагаем</h3><p class="lead">' + esc(z.system.title) + '</p><p class="small gives">' + z.system.gives.map(esc).join('; ') + '.</p></div></section>');
    s.push('<section class="page">' + rh(c, 'layers') + '<h2>Конструкция пола</h2><p class="muted small">Слои снизу вверх, расход по техлистам Kaztop.</p>' +
      '<div class="slab">' + c.svg + '</div><ul class="legend">' +
      z.layers.map(function (l) { return '<li><span class="n">' + l.n + '</span><div><b>' + esc(l.client_name) + '</b> <span class="spec">· ' + l.rate_str + ' ' + esc(l.unit) + '/м²</span><div class="how">' + esc(l.client_text) + '</div></div></li>'; }).join('') + '</ul>' +
      (z.consumables.length ? '<p class="muted small">Подготовка: ' + z.consumables.map(function (x) { return esc(x.client_text); }).join('; ') + '.</p>' : '') + '</section>');
    s.push('<section class="page page--dark">' + rh(c, 'price') + '<div class="eyebrow">Стоимость</div><div class="price__big">' + z.per_m2_str + '<small>₸ / м²</small></div>' +
      '<p class="price__total">Итого за ' + z.area_str + ' м²: <b>' + z.total_str + ' ₸</b></p>' +
      '<div class="bar"><div class="bar__m" style="width: ' + z.materials_pct + '%"></div><div class="bar__w" style="width: ' + z.works_pct + '%"></div></div>' +
      '<div class="bar-legend"><span>Материалы <b>' + z.materials_total_str + ' ₸</b></span><span>Работы <b>' + z.works_total_str + ' ₸</b></span></div>' +
      '<div class="terms"><b>' + esc(c.company.terms.advance) + '.</b><br>Цены действуют до ' + k.valid_until_words + '.</div>' +
      '<div class="scope"><div><h3>Входит</h3><ul>' + z.system.scope.included.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' +
      '<div class="no"><h3>Не входит</h3><ul>' + z.system.scope.excluded.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div></div>' +
      '<p class="muted small" style="margin-top:auto">Расчёт по строкам на следующей странице.</p></section>');
    var est = '<div class="est"><div class="est__group">Материалы</div>' +
      z.materials.map(function (m) { return '<div class="est__row"><div><div class="nm">' + esc(m.client_name) + '</div><div class="calc">' + m.qty_str + ' ' + esc(m.unit) + ' × ' + m.price_str + ' ₸</div></div><div class="sum">' + m.sum_str + ' ₸</div></div>'; }).join('') +
      '<div class="est__total"><span>Материалы</span><span>' + z.materials_total_str + ' ₸</span></div><div class="est__group">Работы</div>' +
      z.works.map(function (w) { return '<div class="est__row"><div><div class="nm">' + esc(w.name) + '</div><div class="calc">' + w.qty_str + ' м² × ' + w.price_str + ' ₸</div></div><div class="sum">' + w.sum_str + ' ₸</div></div>'; }).join('') +
      '<div class="est__total"><span>Работы</span><span>' + z.works_total_str + ' ₸</span></div>' +
      '<div class="est__total grand"><span>Итого</span><span>' + z.total_str + ' ₸</span></div>' +
      '<div class="est__total per"><span>За квадратный метр</span><span>' + z.per_m2_str + ' ₸</span></div></div>';
    s.push('<section class="page">' + rh(c, 'estimate') + '<h2>Расчёт</h2>' + est + '<p class="muted small" style="margin-top:auto">Количество материала: площадь ' + z.area_str + ' м² × расход по техлистам.</p></section>');
    if (c.alternatives.length) {
      var opt = function (zz, tag, main) {
        return '<div class="opt' + (main ? ' opt--main" style="margin-top:12px' : '') + '"><div class="opt__tag">' + tag + '</div><div class="opt__title">' + esc(zz.system.title) + '</div>' +
          '<div class="opt__num">' + zz.per_m2_str + '<small>₸ / м²</small></div><div class="opt__total">итого ' + zz.total_str + ' ₸</div><div class="opt__note">' + esc(zz.system.compare_note) + '</div></div>';
      };
      s.push('<section class="page">' + rh(c, 'compare') + '<h2>Варианты для этого объекта</h2><p class="muted small">Одна площадь, разная конструкция. Цифры за ' + z.area_str + ' м².</p>' +
        opt(z, 'Предлагаем', true) + c.alternatives.map(function (a) { return opt(a, 'Вариант', false); }).join('') +
        '<p class="muted small" style="margin-top:auto">Какой вариант подходит, решаем после осмотра основания и нагрузок.</p></section>');
    }
    s.push('<section class="page">' + rh(c, 'why') + '<h2>Почему Kaztop</h2><ul class="facts">' + c.facts.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' +
      (c.photos.similar.length ? '<div class="sect"><h3>Похожие объекты</h3><div class="gallery">' + c.photos.similar.map(function (ph) { return '<figure><div class="ph" style="background-image: url(\'' + esc(ph.src) + '\')"></div><figcaption>' + esc(ph.caption) + '</figcaption></figure>'; }).join('') + '</div></div>' : '') +
      (c.projects.length ? '<ul class="projects" style="margin-top:8px">' + c.projects.map(function (p) { return '<li><b>' + esc(p.name) + '</b> <span>· ' + esc(p.city) + ' · ' + esc(p.meta) + '</span></li>'; }).join('') + '</ul>' : '') + '</section>');
    var cureBox = c.cure
      ? '<div class="cure" style="margin-top:auto"><b>Ввод в работу: ' + c.cure.walk + ', полная нагрузка ' + c.cure.full + (c.cure.chem ? ', химическая стойкость ' + c.cure.chem : '') + '.</b><div class="t">При ' + c.cure.temp + ' по техлисту ' + esc(c.cure.material) + '. Срок работ уточняется после осмотра основания.</div></div>'
      : '<div class="cure" style="margin-top:auto"><b>Срок работ уточняется после осмотра основания.</b></div>';
    s.push('<section class="page">' + rh(c, 'process') + '<h2>Как пойдёт работа</h2><ol class="steps">' +
      c.steps.map(function (st) { return '<li><span class="n">' + esc(st.num) + '</span><div><b>' + esc(st.title) + '</b><p>' + esc(st.desc) + '</p></div></li>'; }).join('') + '</ol>' + cureBox + '</section>');
    if (c.palette) {
      s.push('<section class="page">' + rh(c, 'colour') + '<h2>Цвет лицевого слоя</h2><p class="muted small">Стандартные цвета по шкале RAL. Выбранный в этом КП: <b>' + esc(c.palette.chosen) + '</b>.</p>' +
        '<ul class="ral">' + c.palette.basics.map(function (col) { return '<li class="' + (col.chosen ? 'is-chosen' : '') + '"><div class="sw" style="background: ' + esc(col.hex) + '"></div>' + esc(col.ral) + '</li>'; }).join('') + '</ul>' +
        '<div class="sect"><h3>Флоки для декоративных зон</h3><ul class="flakes">' + c.palette.flakes.map(function (f) { return '<li><div class="fl" style="background-image: url(\'' + esc(f.src) + '\')"></div>' + esc(f.id) + '</li>'; }).join('') + '</ul></div>' +
        '<p class="muted small" style="margin-top:auto">' + esc(c.palette.disclaimer) + '</p></section>');
    }
    s.push('<section class="page">' + rh(c, 'next') + '<h2>Следующий шаг</h2><p class="lead">Ответьте в WhatsApp: согласуем выезд на объект и дату начала.</p>' +
      '<a class="btn" href="' + esc(c.wa.url) + '">' + WA_ICON + 'Написать в WhatsApp</a>' +
      '<p class="contact"><b>' + esc(c.manager.name) + '</b>, расчёты и выезд<br><a href="' + esc(c.wa.tel) + '">' + esc(c.manager.tel_text) + '</a></p>' +
      '<p class="contact small muted">' + esc(c.company.legal_name) + '<br>' + esc(c.company.address) + '<br>тел. ' + esc(c.company.phone_office) + ' · ' + esc(c.company.site) + '</p>' +
      '<p class="sign">' + esc(c.company.sign_title) + ' <b>' + esc(c.company.director) + '</b></p>' +
      '<p class="legal">КП № ' + esc(k.number) + ' от ' + k.date_dmy + ', действует до ' + k.valid_until_dmy + '. ' + esc(c.company.terms.not_offer) + '</p></section>');
    return s.join('\n');
  }
  function renderA4(ctx) {
    var c = ctx, k = ctx.kp, z = ctx.zone;
    var rows = '';
    rows += '<tr class="zone"><td colspan="6">' + esc(z.name) + '</td></tr><tr class="grp"><td colspan="6">Работа</td></tr>';
    z.works.forEach(function (w) { rows += '<tr><td class="c">' + w.n + '</td><td>' + esc(w.name) + '</td><td class="c">м²</td><td class="r">' + w.qty_str + '</td><td class="r">' + w.price_str + '</td><td class="r">' + w.sum_str + '</td></tr>'; });
    rows += '<tr class="sum"><td colspan="5">ИТОГО работы :</td><td class="r">' + z.works_total_str + '</td></tr><tr class="grp"><td colspan="6">Материалы</td></tr>';
    z.materials.forEach(function (m) { rows += '<tr><td class="c">' + m.n + '</td><td>' + esc(m.name) + ', расход ' + m.rate_str + ' ' + esc(m.unit) + '/м²</td><td class="c">' + esc(m.unit) + '</td><td class="r">' + m.qty_str + '</td><td class="r">' + m.price_str + '</td><td class="r">' + m.sum_str + '</td></tr>'; });
    rows += '<tr class="sum"><td colspan="5">ИТОГО материалы</td><td class="r">' + z.materials_total_str + '</td></tr>' +
      '<tr class="grand"><td colspan="5">ИТОГО по ' + esc(z.name_dat) + ':</td><td class="r">' + z.total_str + '</td></tr>' +
      '<tr class="per"><td colspan="5">стоимость 1 м² по ' + esc(z.name_dat) + ':</td><td class="r">' + z.per_m2_str + '</td></tr>';
    return '<div class="a4"><div class="head"><div class="head__name">' + esc(c.company.legal_name) + '</div><div class="head__addr">' + esc(c.company.address) + ' · тел. ' + esc(c.company.phone_office) + '</div></div>' +
      '<div class="to">' + esc(k.addressee) + '</div><div class="title">Коммерческое предложение<br>на работы по устройству полимерного покрытия</div>' +
      '<div class="num">№ ' + esc(k.number) + ' от ' + k.date_dmy + ' · ' + esc(k.client.object) + (k.client.city ? ', ' + esc(k.client.city) : '') + '</div>' +
      '<table><thead><tr><th>№</th><th>Наименование работ</th><th>Ед. изм.</th><th>Кол-во</th><th>Цена ед.</th><th>Сумма в тенге</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="terms">' + esc(c.company.terms.advance) + '</p>' +
      '<p class="legal">Цены действительны до ' + k.valid_until_dmy + '. ' + esc(c.company.terms.not_offer) + (c.vat_note ? ' ' + esc(c.vat_note) : '') + '</p>' +
      '<div class="sign"><span>' + esc(c.company.sign_title) + '</span><span>________________ ' + esc(c.company.director) + '</span></div></div>';
  }
  function renderWa(ctx) {
    var k = ctx.kp, z = ctx.zone;
    return 'Здравствуйте, это Kaztop.\nРасчёт по вашему объекту: ' + k.client.object + ', ' + z.area_str + ' м².\nВ файле: конструкция пола, стоимость за м² и итого, что входит.\nЦена действует до ' + k.valid_until_dmy + '.\nВопросы и выезд на объект: ответьте сюда.\n';
  }
  function perM2Label(system, materials) { return fmtInt(calcZone('1', system, materials, 'excel').per_m2); }

  return { calcZone: calcZone, layersSvg: layersSvg, buildContext: buildContext, renderPhone: renderPhone, renderA4: renderA4, renderWa: renderWa,
    perM2Label: perM2Label, fmt: { dmy: dmy, dateWords: dateWords, addDays: addDays, todayIso: todayIso, fmtInt: fmtInt, fmtScaled: fmtScaled, parseDec: parseDec }, esc: esc, NB: NB };
});
