/* Ядро веб-версии КП Kaztop: расчёт (точная арифметика на BigInt, округление половина вверх),
   контекст и разметка страниц. Зеркало tools/calc.py, tools/build_kp.py и templates/*.j2:
   тест tests/test_web.py сверяет текст страниц и итоги с Python. Работает в браузере и в Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var NB = ' ';
  var AREA_S = 2, RATE_S = 3, PRICE_S = 2, TH_S = 2, QTY_S = 2;
  var LAYER_ROLES = ['primer', 'base', 'base_thick', 'aggregate', 'finish', 'sealer'];
  var PAGE_ORDER = ['cover', 'layers', 'colour', 'estimate', 'terms'];
  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var EXCL_REPAIR = 'ремонт трещин и выбоин: объём по результату осмотра';
  var EXCL_DELIVERY = 'доставка материалов за пределы Астаны';
  var EST_BUDGET_PX = 553, EST_GROUP_PX = 29, EST_ROW_PX = 45, EST_WRAP_PX = 18, EST_ROW_ONE_PX = 27, EST_TOTAL_PX = 31, EST_GRAND_PX = 40, EST_NAME_WRAP = 40, SCOPE_ADDONS_LISTED = 2;
  function estPages(rowNames, nAddons) {
    var systemPx = EST_GROUP_PX * 2 + rowNames.reduce(function (sum, n) { return sum + EST_ROW_PX + (n.length > EST_NAME_WRAP ? EST_WRAP_PX : 0); }, 0);
    var addonsPx = nAddons ? EST_GROUP_PX + EST_ROW_ONE_PX * nAddons + EST_TOTAL_PX * 2 : 0;
    if (systemPx + addonsPx + EST_GRAND_PX + EST_TOTAL_PX <= EST_BUDGET_PX) return [{ key: 'estimate', system: true, addons: nAddons > 0, totals: true }];
    return [{ key: 'estimate', system: true, addons: false, totals: false }, { key: 'estimate2', system: false, addons: true, totals: true }];
  }
  function capitalize(str) { return str.slice(0, 1).toUpperCase() + str.slice(1); }

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
  function fmtDecScaled(v, scale) {
    var s = v.toString();
    while (s.length < scale + 1) s = '0' + s;
    var intPart = s.slice(0, -scale), frac = s.slice(-scale).replace(/0+$/, '');
    return frac ? intPart + ',' + frac : intPart;
  }
  function fmtRate(str) { return fmtDecScaled(parseDec(str, RATE_S), RATE_S); }
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
  function thickness(system, thMm) {
    var spec = system.th_mm;
    if (!spec) return { th: null, thC: null, defC: null };
    var defC = parseDec(spec.default, TH_S);
    var thC = (thMm === null || thMm === undefined || thMm === '') ? defC : parseDec(thMm, TH_S);
    if (thC < parseDec(spec.min, TH_S) || thC > parseDec(spec.max, TH_S)) throw new Error('толщина ' + fmtDecScaled(thC, TH_S) + ' мм вне диапазона ' + spec.min + '-' + spec.max + ' для ' + system.id);
    return { th: fmtDecScaled(thC, TH_S), thC: thC, defC: defC };
  }
  function matLine(code, rateM, qtyBase, materials, kind, scaled) {
    var m = materials.items[code];
    if (!m) throw new Error('нет материала ' + code);
    if (m.price === null || m.price === undefined) throw new Error('у материала ' + code + ' нет цены: расчёт по запросу');
    var price = parseDec(m.price, PRICE_S);
    var qty = qtyBase * rateM;                     // scale 5
    var exact = qty * price;                       // scale 7
    var shown = roundHalfUp(exact, pow10(7));
    return { kind: kind, code: code, name: m.name, client_name: m.client_name || m.name, client_text: m.client_text || '', role: m.role, unit: m.unit,
      rate_str: fmtDecScaled(rateM, RATE_S), scaled: !!scaled, qty_str: fmtScaled(qty, 5, 2), price_str: fmtPrice(price), exact7: exact, shown: shown,
      sum_str: fmtInt(shown), estimated: !!m.estimated, source: m.source || '' };
  }
  function workLine(name, priceStr, qtyC, unit, kind, source) {
    var price = parseDec(priceStr, PRICE_S);
    var exact7 = qtyC * price * 1000n;             // scale 4 -> 7
    var shown = roundHalfUp(exact7, pow10(7));
    return { kind: kind, name: name, unit: unit, qty_str: fmtScaled(qtyC, QTY_S, 2), price_str: fmtPrice(price), exact7: exact7, shown: shown, sum_str: fmtInt(shown),
      estimated: (source || '').indexOf('оценка') === 0, source: source || '' };
  }
  function calcZone(areaStr, system, materials, mode, opts) {
    mode = mode || 'excel'; opts = opts || {};
    var data = opts.data || {};
    if (mode !== 'excel' && mode !== 'lines') throw new Error('режим округления ' + mode);
    if (system.quote_only) throw new Error('рецептура ' + system.id + ' считается по запросу');
    var area = parseDec(areaStr, AREA_S);
    if (area <= 0n) throw new Error('площадь должна быть больше нуля');
    var t = thickness(system, opts.th_mm);
    var mats = [];
    (system.layers || []).forEach(function (row) {
      var rateM = parseDec(row.rate, RATE_S);
      var scaled = !!row.scales && t.thC !== null && t.thC !== t.defC;
      if (scaled) rateM = roundHalfUp(rateM * t.thC, t.defC);
      mats.push(matLine(row.code, rateM, area, materials, 'layer', scaled));
    });
    (system.consumables || []).forEach(function (row) { mats.push(matLine(row.code, parseDec(row.rate, RATE_S), area, materials, 'consumable', false)); });
    var works = [];
    (system.works || []).forEach(function (w) {
      var c = typeof w === 'string' ? data.works_catalog[w] : w;
      works.push(workLine(c.name, c.price, area, 'м2', 'system', c.source));
    });
    var blocks = [];
    (opts.addons || []).forEach(function (a) {
      var defn = data.addons[a.id];
      if (!defn) throw new Error('допработа ' + a.id + ' неизвестна');
      var qtyC;
      if (defn.unit === 'м²') qtyC = area;
      else { qtyC = parseDec(a.qty || '0', QTY_S); if (qtyC <= 0n) throw new Error('для «' + defn.title + '» нужна длина в м.п.'); }
      var block = { id: defn.id, title: defn.title, short: defn.short || defn.title, client_text: defn.client_text || '', unit: defn.unit, qtyC: qtyC,
        qty_str: defn.unit === 'м.п.' ? fmtScaled(qtyC, QTY_S, 2) : fmtScaled(qtyC, QTY_S, 0), materials: [], works: [] };
      (defn.materials || []).forEach(function (mrow) {
        var line = matLine(mrow.code, parseDec(mrow.rate, RATE_S), qtyC, materials, 'addon', false);
        line.addon = defn.id; line.addon_title = defn.title; line.per_unit = defn.unit;
        block.materials.push(line); mats.push(line);
      });
      (defn.works || []).forEach(function (wrow) {
        var line = workLine(wrow.name, wrow.price, qtyC, defn.unit, 'addon', wrow.source);
        line.addon = defn.id; line.addon_title = defn.title;
        block.works.push(line); works.push(line);
      });
      block.subtotal = roundHalfUp(block.materials.concat(block.works).reduce(function (s, x) { return s + x.exact7; }, 0n), pow10(7));
      blocks.push(block);
    });
    var q = function (v7) { return roundHalfUp(v7, pow10(7)); };
    var worksTotal7 = works.reduce(function (s, w) { return s + w.exact7; }, 0n);
    var matTotal7 = mats.reduce(function (s, m) { return s + (mode === 'excel' ? m.exact7 : m.shown * pow10(7)); }, 0n);
    var total7 = worksTotal7 + matTotal7;
    var perM2 = roundHalfUp(total7, area * pow10(5));
    var sysItems = mats.filter(function (m) { return m.kind !== 'addon'; }).concat(works.filter(function (w) { return w.kind === 'system'; }));
    var sysTotal7 = sysItems.reduce(function (s, x) { return s + (mode === 'excel' ? x.exact7 : x.shown * pow10(7)); }, 0n);
    var matPct = total7 > 0n ? Number(roundHalfUp(matTotal7 * 100n, total7)) : 0;
    var est = {};
    mats.forEach(function (m) { if (m.estimated) est[m.client_name] = 1; });
    works.forEach(function (w) { if (w.estimated) est[w.name] = 1; });
    return {
      mode: mode, area: area, system_id: system.id, th_mm: t.th, materials: mats,
      layers: mats.filter(function (m) { return m.kind === 'layer' && LAYER_ROLES.indexOf(m.role) >= 0; }),
      system_materials: mats.filter(function (m) { return m.kind !== 'addon'; }), system_works: works.filter(function (w) { return w.kind === 'system'; }),
      works: works, addons: blocks,
      works_total: q(worksTotal7), materials_total: q(matTotal7), total: q(total7), per_m2: perM2, system_total: q(sysTotal7),
      materials_pct: matPct, works_pct: 100 - matPct,
      area_str: area % 100n === 0n ? fmtScaled(area, AREA_S, 0) : fmtScaled(area, AREA_S, 2),
      estimated: Object.keys(est).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; }),
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
  function scopeFor(system, data, addonIds) {
    var base = system.scope || data.scope_default;
    var included = base.included.slice();
    if (system.fresh_concrete) included = ['упрочнитель и мембрана по свежеуложенному бетону', 'материалы Kaztop в объёме по расходу', 'затирка нашей бригадой'];
    if (addonIds.length > SCOPE_ADDONS_LISTED) included.push('подготовка и дополнительно по расчёту');
    else if (addonIds.length) included.push('подготовка: ' + addonIds.map(function (id) { return data.addons[id].short || data.addons[id].title; }).join(', '));
    var excluded = [];
    if (!addonIds.some(function (id) { return id === 'cracks' || id === 'levelling' || id === 'demolition'; })) excluded.push(EXCL_REPAIR);
    excluded.push(EXCL_DELIVERY);
    var marking = addonIds.indexOf('marking') >= 0, plinth = addonIds.indexOf('plinth') >= 0;
    if (!marking && !plinth) excluded.push('разметка и плинтусы');
    else if (!marking) excluded.push('разметка');
    else if (!plinth) excluded.push('плинтусы');
    if (system.scope_note) excluded.push(system.scope_note.replace(/\.$/, '').toLowerCase());
    return { included: included, excluded: excluded };
  }
  function matRow(m) {
    var row = { code: m.code, name: m.name, client_name: m.client_name, client_text: m.client_text, role: m.role, unit: m.unit, rate_str: m.rate_str,
      qty_str: m.qty_str, price_str: m.price_str, sum_str: m.sum_str, kind: m.kind, scaled: m.scaled, estimated: m.estimated };
    if (m.kind === 'addon') { row.addon_title = m.addon_title; row.per_unit = m.per_unit; }
    return row;
  }
  function workRow(w) { return { name: w.name, unit: w.unit, qty_str: w.qty_str, price_str: w.price_str, sum_str: w.sum_str, kind: w.kind, estimated: w.estimated, addon_title: w.addon_title || null }; }
  function zoneCtx(z, data, mode) {
    var system = data.systems[z.system];
    if (!system) throw new Error('рецептура ' + z.system + ' неизвестна');
    var r = calcZone(z.area_m2, system, data.materials, mode, { th_mm: z.th_mm, addons: z.addons || [], data: data });
    var n = 0;
    var works = r.works.map(function (w) { n += 1; var row = workRow(w); row.n = n; return row; });
    var materials = [], layers = [], consumables = []; var k = 0;
    r.materials.forEach(function (m) {
      n += 1; var row = matRow(m); row.n = n; materials.push(row);
      if (m.kind === 'layer' && LAYER_ROLES.indexOf(m.role) >= 0) { k += 1; layers.push(Object.assign({}, row, { n: k })); }
      else if (m.kind === 'consumable') consumables.push(row);
    });
    var blocks = r.addons.map(function (b) {
      return { id: b.id, title: b.title, short: b.short, label: capitalize(b.short), client_text: b.client_text, unit: b.unit, qty_str: b.qty_str,
        materials: b.materials.map(matRow), works: b.works.map(workRow), subtotal_str: fmtInt(b.subtotal) };
    });
    var name = z.name || 'Тип пола 1';
    return { name: name, name_dat: name.replace('Тип пола', 'Типу пола'), area_str: r.area_str, th_mm: r.th_mm, th_str: r.th_mm !== null ? r.th_mm + NB + 'мм' : null,
      system: system, scope: scopeFor(system, data, r.addons.map(function (b) { return b.id; })),
      materials: materials, layers: layers, consumables: consumables, works: works,
      system_materials: materials.filter(function (m) { return m.kind !== 'addon'; }), system_works: works.filter(function (w) { return w.kind === 'system'; }),
      addons: blocks, system_total_str: fmtInt(r.system_total), addons_total_str: fmtInt(r.total - r.system_total), has_addons: blocks.length > 0,
      est_pages: estPages(materials.filter(function (m) { return m.kind !== 'addon'; }).map(function (m) { return m.client_name; })
        .concat(works.filter(function (w) { return w.kind === 'system'; }).map(function (w) { return w.name; })), blocks.length),
      works_total_str: fmtInt(r.works_total), materials_total_str: fmtInt(r.materials_total), total_str: fmtInt(r.total), per_m2_str: fmtInt(r.per_m2),
      materials_pct: r.materials_pct, works_pct: r.works_pct, estimated: r.estimated, calc: r };
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
  function buildContext(kp, data, opts) {
    opts = opts || {};
    var company = data.company; var o = kp.options || {}; var mode = o.rounding || 'excel';
    var z0 = kp.zones[0];
    var zone = zoneCtx(z0, data, mode);
    var alternatives = o.show_comparison ? (kp.alternatives || []).map(function (a) { return zoneCtx({ area_m2: z0.area_m2, system: a.system, name: zone.name, th_mm: a.th_mm }, data, mode); }) : [];
    var room = data.rooms.rooms[kp.room_type]; if (!room) throw new Error('тип помещения ' + kp.room_type + ' неизвестен');
    var rh = ralHex(data.palette, (kp.colour || {}).ral); var ral = rh[0], hex = rh[1];
    var svg = layersSvg(zone.layers.map(function (l) { return { role: l.role }; }), hex, 's');
    var validUntil = kp.valid_until || addDays(kp.date, company.terms.valid_days);
    var manager = company.managers[kp.manager]; if (!manager) throw new Error('менеджер ' + kp.manager + ' неизвестен');
    var waText = 'По КП ' + kp.number + ': ';
    var exclude = company.flags.exclude_photos || [];
    var roomPhotos = (data.photos.rooms[kp.room_type] || []).filter(function (p) { return exclude.indexOf(p.file.replace(/\.[a-z]+$/, '')) < 0; });
    if (!roomPhotos.length) throw new Error('нет фото для типа помещения ' + kp.room_type);
    var photo = function (p) { return { src: (opts.photoBase || 'assets/photos/') + p.file, caption: p.caption }; };
    var photos = { cover: photo(roomPhotos[0]) };
    var palette = null;
    if (o.show_colour_page) {
      palette = { basics: data.palette.basics.map(function (c) { return Object.assign({}, c, { chosen: c.ral === ral }); }),
        flakes: data.palette.flakes.slice(0, 6).map(function (f) { return { id: f.id, src: (opts.flakeBase || 'assets/flakes/') + f.file }; }),
        chosen: ral, disclaimer: data.palette.disclaimer };
    }
    var pages = [];
    PAGE_ORDER.forEach(function (p) {
      if (p === 'estimate') zone.est_pages.forEach(function (ep) { pages.push(ep.key); });
      else if (p !== 'colour' || palette) pages.push(p);
    });
    var pageNo = {}; pages.forEach(function (p, i) { pageNo[p] = i + 1; });
    var notes = kp.notes || []; var vat = data.materials.vat; var revision = parseInt(kp.revision || 1, 10);
    var baseLabel = kp.base ? data.base_conditions[kp.base].label : (notes.length ? notes[0] : 'уточняется при выезде');
    return {
      company: company, manager: manager,
      kp: { number: kp.number, date_dmy: dmy(kp.date), date_words: dateWords(kp.date), valid_until_dmy: dmy(validUntil), valid_until_words: dateWords(validUntil),
        client: kp.client, addressee: kp.client.addressee || company.addressee_default, base_note: baseLabel, notes: notes, status: kp.status || 'draft',
        revision: revision, revision_str: revision > 1 ? 'ред. ' + revision : null, show_company: kp.client.company !== kp.client.object },
      room: room, zone: zone, alternatives: alternatives, svg: svg, photos: photos,
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
  function estRow(nm, calcTxt, sum) { return '<div class="est__row"><div class="nm">' + nm + '</div><div class="ln"><span class="calc">' + calcTxt + '</span><span class="sum">' + sum + ' ₸</span></div></div>'; }
  function renderPhone(ctx) {
    var c = ctx, k = ctx.kp, z = ctx.zone, s = [];
    var li = function (x) { return '<li>' + esc(x) + '</li>'; };
    s.push('<section class="page cover">' +
      '<div class="cover__photo" style="background-image: url(\'' + esc(c.photos.cover.src) + '\')"></div><div class="cover__shade"></div>' +
      '<div class="cover__brand">' + logo('') + esc(c.company.brand) + '</div>' +
      '<div class="cover__body"><div class="cover__gap"></div><div class="eyebrow">Коммерческое предложение</div><h1 class="cover__title">' + esc(k.client.object) + '</h1>' +
      '<p class="cover__meta"><strong>' + z.area_str + ' м²</strong>' + (k.client.city ? ' · ' + esc(k.client.city) : '') + (k.show_company ? ' · ' + esc(k.client.company) : '') + '</p>' +
      '<p class="cover__sys">' + esc(z.system.title) + (z.th_str ? ', ' + z.th_str : '') + '</p>' +
      '<div class="cover__price">' + z.per_m2_str + '<small>₸ / м²</small></div>' +
      '<p class="cover__total">Итого за ' + z.area_str + ' м²: <b>' + z.total_str + NB + '₸</b></p>' +
      (z.has_addons ? '<p class="cover__note">В том числе подготовка и дополнительно: ' + z.addons_total_str + NB + '₸</p>' : '') +
      c.alternatives.map(function (a) { return '<p class="cover__alt">Вариант: <b>' + esc(a.system.title) + (a.th_str ? ', ' + a.th_str : '') + '</b> · ' + a.per_m2_str + NB + '₸/м², итого ' + a.total_str + NB + '₸</p>'; }).join('') +
      '<div class="cover__foot"><span>№ <b>' + esc(k.number) + '</b>' + (k.revision_str ? ' · ' + k.revision_str : '') + '<br>от ' + k.date_words + '</span><span>действует до<br><b>' + k.valid_until_words + '</b></span></div></div></section>');
    s.push('<section class="page">' + rh(c, 'layers') + '<h2>Конструкция пола' + (z.th_str ? ' · ' + z.th_str : '') + '</h2>' +
      '<div class="slab">' + c.svg + '</div><ul class="legend">' +
      z.layers.map(function (l) { return '<li>' + '<svg class="n" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#06171c"/><text x="12" y="16.8" text-anchor="middle" font-family="Manrope, sans-serif" font-size="14" font-weight="700" fill="#fff">' + l.n + '</text></svg>' + '<div><b>' + esc(l.client_name) + '</b> <span class="spec">· ' + l.rate_str + ' ' + esc(l.unit) + '/м²</span><div class="how">' + esc(l.client_text) + '</div></div></li>'; }).join('') + '</ul>' +
      '<p class="basebox"><b>Основание:</b> ' + esc(k.base_note) + '.' + (z.has_addons ? ' Подготовка и дополнительно - в расчёте.' : '') + '</p></section>');
    if (c.palette) {
      s.push('<section class="page">' + rh(c, 'colour') + '<h2>Цвет лицевого слоя</h2><p class="muted small">Стандартные цвета по шкале RAL. Выбранный в этом КП: <b>' + esc(c.palette.chosen) + '</b>.</p>' +
        '<ul class="ral">' + c.palette.basics.map(function (col) { return '<li class="' + (col.chosen ? 'is-chosen' : '') + '"><div class="sw" style="background: ' + esc(col.hex) + '"></div>' + esc(col.ral) + '</li>'; }).join('') + '</ul>' +
        '<div class="sect"><h3>Флоки для декоративных зон</h3><ul class="flakes">' + c.palette.flakes.map(function (f) { return '<li><div class="fl" style="background-image: url(\'' + esc(f.src) + '\')"></div>' + esc(f.id) + '</li>'; }).join('') + '</ul></div>' +
        '<p class="muted small" style="margin-top:auto">' + esc(c.palette.disclaimer) + '</p></section>');
    }
    z.est_pages.forEach(function (ep, i) {
      var n = z.est_pages.length, h = '<div class="est">';
      if (ep.system) {
        h += '<div class="est__group">Материалы</div>' +
          z.system_materials.map(function (m) { return estRow(esc(m.client_name), m.qty_str + ' ' + esc(m.unit) + ' × ' + m.price_str + ' ₸', m.sum_str); }).join('') +
          '<div class="est__group">Работы</div>' +
          z.system_works.map(function (w) { return estRow(esc(w.name), w.qty_str + ' м² × ' + w.price_str + ' ₸', w.sum_str); }).join('') +
          (z.has_addons ? '<div class="est__total"><span>Конструкция пола</span><span>' + z.system_total_str + ' ₸</span></div>' : '');
      }
      if (ep.addons) {
        h += '<div class="est__group">Подготовка и дополнительно</div>' +
          z.addons.map(function (b) { return '<div class="est__row est__row--one"><div class="nm">' + esc(b.label) + ', ' + b.qty_str + ' ' + esc(b.unit) + '</div><div class="sum">' + b.subtotal_str + ' ₸</div></div>'; }).join('') +
          '<div class="est__total"><span>Подготовка и дополнительно</span><span>' + z.addons_total_str + ' ₸</span></div>';
      }
      if (ep.totals) h += '<div class="est__total grand"><span>Итого</span><span>' + z.total_str + ' ₸</span></div><div class="est__total per"><span>За квадратный метр</span><span>' + z.per_m2_str + ' ₸</span></div>';
      h += '</div>';
      s.push('<section class="page">' + rh(c, ep.key) + '<h2>Расчёт' + (n > 1 ? ' (' + (i + 1) + '/' + n + ')' : '') + '</h2>' + h +
        '<p class="muted small" style="margin-top:auto">' + (ep.totals ? 'Смета по строкам на последней странице.' : 'Подготовка и итог на следующей странице.') + '</p></section>');
    });
    s.push('<section class="page">' + rh(c, 'terms') + '<h2>Условия</h2>' +
      '<div class="scope"><div><h3>Входит</h3><ul>' + z.scope.included.map(li).join('') + '</ul></div><div class="no"><h3>Не входит</h3><ul>' + z.scope.excluded.map(li).join('') + '</ul></div></div>' +
      '<div class="card terms"><p><b>' + esc(c.company.terms.advance) + '.</b> Цены действуют до ' + k.valid_until_words + '.</p>' +
      '<p>' + (c.cure ? 'Ввод в работу при ' + c.cure.temp + ': ' + c.cure.walk + ', полная нагрузка ' + c.cure.full + '. ' : '') + 'Срок работ уточняется после осмотра основания.</p></div>' +
      '<a class="btn" href="' + esc(c.wa.url) + '">' + WA_ICON + 'Написать в WhatsApp</a>' +
      '<p class="contact"><b>' + esc(c.manager.name) + '</b>, расчёты и выезд: <a href="' + esc(c.wa.tel) + '">' + esc(c.manager.tel_text) + '</a></p>' +
      '<p class="contact small muted">' + esc(c.company.legal_name) + ' · ' + esc(c.company.sign_title) + ' ' + esc(c.company.director) + ' · ' + esc(c.company.site) + '</p>' +
      '<p class="legal">КП № ' + esc(k.number) + (k.revision_str ? ' (' + k.revision_str + ')' : '') + ' от ' + k.date_dmy + '. ' + esc(c.company.terms.not_offer) + '</p></section>');
    return s.join('\n');
  }
  function renderA4(ctx) {
    var c = ctx, k = ctx.kp, z = ctx.zone;
    var rows = '';
    rows += '<tr class="zone"><td colspan="6">' + esc(z.name) + '</td></tr><tr class="grp"><td colspan="6">Работа</td></tr>';
    z.works.forEach(function (w) {
      rows += '<tr><td class="c">' + w.n + '</td><td>' + (w.kind === 'addon' ? esc(w.addon_title) + ': ' : '') + esc(w.name) + '</td><td class="c">' + (w.unit === 'м.п.' ? 'м.п.' : 'м²') + '</td><td class="r">' + w.qty_str + '</td><td class="r">' + w.price_str + '</td><td class="r">' + w.sum_str + '</td></tr>';
    });
    rows += '<tr class="sum"><td colspan="5">ИТОГО работы :</td><td class="r">' + z.works_total_str + '</td></tr><tr class="grp"><td colspan="6">Материалы</td></tr>';
    z.materials.forEach(function (m) {
      var per = (m.kind === 'addon' && m.per_unit === 'м.п.') ? 'м.п.' : 'м²';
      rows += '<tr><td class="c">' + m.n + '</td><td>' + (m.kind === 'addon' ? esc(m.addon_title) + ': ' : '') + esc(m.name) + ', расход ' + m.rate_str + ' ' + esc(m.unit) + '/' + per + '</td><td class="c">' + esc(m.unit) + '</td><td class="r">' + m.qty_str + '</td><td class="r">' + m.price_str + '</td><td class="r">' + m.sum_str + '</td></tr>';
    });
    rows += '<tr class="sum"><td colspan="5">ИТОГО материалы</td><td class="r">' + z.materials_total_str + '</td></tr>' +
      '<tr class="grand"><td colspan="5">ИТОГО по ' + esc(z.name_dat) + ':</td><td class="r">' + z.total_str + '</td></tr>' +
      '<tr class="per"><td colspan="5">стоимость 1 м² по ' + esc(z.name_dat) + ':</td><td class="r">' + z.per_m2_str + '</td></tr>';
    return '<div class="a4"><div class="head"><div class="head__name">' + esc(c.company.legal_name) + '</div><div class="head__addr">' + esc(c.company.address) + ' · тел. ' + esc(c.company.phone_office) + '</div></div>' +
      '<div class="to">' + esc(k.addressee) + '</div><div class="title">Коммерческое предложение<br>на работы по устройству полимерного покрытия</div>' +
      '<div class="num">№ ' + esc(k.number) + (k.revision_str ? ' (' + k.revision_str + ')' : '') + ' от ' + k.date_dmy + ' · ' + esc(k.client.object) + (k.client.city ? ', ' + esc(k.client.city) : '') + ' · ' + esc(z.system.title) + (z.th_str ? ', ' + z.th_str : '') + '</div>' +
      '<table><thead><tr><th>№</th><th>Наименование работ</th><th>Ед. изм.</th><th>Кол-во</th><th>Цена ед.</th><th>Сумма в тенге</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="terms">' + esc(c.company.terms.advance) + '</p>' +
      '<p class="legal">Цены действительны до ' + k.valid_until_dmy + '. ' + esc(c.company.terms.not_offer) + (c.vat_note ? ' ' + esc(c.vat_note) : '') + '</p>' +
      '<div class="sign"><span>' + esc(c.company.sign_title) + '</span><span>________________ ' + esc(c.company.director) + '</span></div></div>';
  }
  function renderWa(ctx) {
    var k = ctx.kp, z = ctx.zone;
    return 'Здравствуйте, это Kaztop.\nРасчёт по вашему объекту: ' + k.client.object + ', ' + z.area_str + ' м².\nВ файле: конструкция пола, стоимость за м² и итого, что входит.\nЦена действует до ' + k.valid_until_dmy + '.\nВопросы и выезд на объект: ответьте сюда.\n';
  }
  function perM2Label(system, data) { return fmtInt(calcZone('1', system, data.materials, 'excel', { data: data }).per_m2); }

  return { calcZone: calcZone, layersSvg: layersSvg, buildContext: buildContext, renderPhone: renderPhone, renderA4: renderA4, renderWa: renderWa,
    perM2Label: perM2Label, fmt: { dmy: dmy, dateWords: dateWords, addDays: addDays, todayIso: todayIso, fmtInt: fmtInt, fmtScaled: fmtScaled, parseDec: parseDec, fmtRate: fmtRate }, esc: esc, NB: NB };
});
