/* Общая история КП без своего сервера.
   Запись КП и PDF шифруются в браузере (AES-GCM) и уходят в релей ntfy.sh: сообщения он хранит 12 ч, файлы 3 ч.
   GitHub Actions каждые 10 минут переносит их без расшифровки в ветку history репозитория страницы
   (читается через raw.githubusercontent.com). Тема релея и ключ истории лежат в зашифрованных данных страницы,
   ключ PDF - только в записи и в ссылке на просмотр (после #, на сервер не уходит). */
(function (root) {
  'use strict';
  var ENV_RE = /^KP([01])\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
  var MAX_MESSAGE = 3900;            // ntfy хранит текст до 4096 байт, длиннее превращает в файл на 3 ч
  var MAX_FILE = 2 * 1024 * 1024;    // лимит файла ntfy.sh для анонимной отправки
  var canZip = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

  function b64u(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
  }
  function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
  async function through(bytes, Stream) {
    var out = new Blob([bytes]).stream().pipeThrough(new Stream('deflate-raw'));
    return new Uint8Array(await new Response(out).arrayBuffer());
  }
  function config(h) {
    if (!h || h.mode !== 'relay' || !h.topic || !h.key) return null;
    return {
      relay: h.relay || 'https://ntfy.sh', topic: h.topic, archive: h.archive, viewer: h.viewer || 'p.html',
      keyP: crypto.subtle.importKey('raw', unb64u(h.key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
      defaults: { relay: 'https://ntfy.sh', archive: h.archive_default || h.archive },
    };
  }

  async function seal(cfg, obj) {
    var data = new TextEncoder().encode(JSON.stringify(obj));
    var zip = canZip ? 1 : 0;
    if (zip) data = await through(data, CompressionStream);
    var iv = rand(12);
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, await cfg.keyP, data));
    return 'KP' + zip + '.' + b64u(iv) + '.' + b64u(ct);
  }
  async function unseal(cfg, text) {
    var m = ENV_RE.exec(text || '');
    if (!m) return null;
    try {
      var pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(m[2]) }, await cfg.keyP, unb64u(m[3])));
      if (m[1] === '1') pt = await through(pt, DecompressionStream);
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (e) { return null; }
  }

  async function request(url, opts, ms, what) {
    var ctrl = new AbortController(); var timer = setTimeout(function () { ctrl.abort(); }, ms || 60000);
    try {
      var res = await fetch(url, Object.assign({ signal: ctrl.signal, cache: 'no-store' }, opts || {}));
      if (res.status === 429) throw new Error(what + ': слишком много отправок, попробуйте через несколько минут');
      if (res.status === 413) throw new Error(what + ': файл больше 2 МБ');
      return res;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(what + ': нет ответа');
      if (e instanceof TypeError) throw new Error(what + ': нет связи');
      throw e;
    } finally { clearTimeout(timer); }
  }
  async function postJson(url, body, what) {
    var res = await request(url, { method: 'POST', body: body }, 120000, what);
    if (!res.ok) throw new Error(what + ': ответ ' + res.status);
    return res.json();
  }

  /** PDF: шифруется своим ключом, уходит в релей файлом. Возвращает ссылку на файл и ключ для записи. */
  async function publishPdf(cfg, file) {
    var key = rand(32), iv = rand(12);
    var k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, new Uint8Array(await file.arrayBuffer())));
    if (ct.length > MAX_FILE) throw new Error('PDF больше 2 МБ, отправить в историю нельзя');
    var res = await postJson(cfg.relay + '/' + cfg.topic + '?filename=kp.bin', ct, 'отправка PDF');
    if (!res.attachment || !res.id) throw new Error('отправка PDF: релей не принял файл');
    return { msg: res.id, key: b64u(key), iv: b64u(iv), size: file.size, name: file.name };
  }
  /** Запись КП или смена статуса: одно зашифрованное сообщение. */
  async function publish(cfg, obj) {
    var text = await seal(cfg, obj);
    if (text.length > MAX_MESSAGE) throw new Error('запись слишком длинная для истории');
    return postJson(cfg.relay + '/' + cfg.topic, text, 'отправка записи');
  }

  async function lines(text) {
    var out = [];
    String(text || '').split('\n').forEach(function (l) { if (l.trim()) { try { out.push(JSON.parse(l)); } catch (e) { /* строка не JSON */ } } });
    return out;
  }
  /** Архив (ветка history) + свежие сообщения релея за 12 ч, без повторов. */
  async function entries(cfg) {
    var byId = {};
    var res = await request(cfg.archive + '/log.jsonl?t=' + Date.now(), {}, 30000, 'архив истории');
    if (res.ok) (await lines(await res.text())).forEach(function (e) { if (e && e.id) byId[e.id] = e; });
    else if (res.status !== 404) throw new Error('архив истории: ответ ' + res.status);
    var recent = await request(cfg.relay + '/' + cfg.topic + '/json?poll=1&since=12h', {}, 30000, 'свежая история');
    if (!recent.ok) throw new Error('свежая история: ответ ' + recent.status);
    (await lines(await recent.text())).forEach(function (m) {
      if (!m || m.event !== 'message' || !m.id) return;
      var known = byId[m.id];
      if (m.attachment) byId[m.id] = Object.assign({ id: m.id, time: m.time }, known || {}, { relay_file: true });
      else if (!known) byId[m.id] = { id: m.id, time: m.time, m: m.message };
    });
    return Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) { return a.time - b.time; });
  }
  /** Записи КП с последним статусом; файлы PDF: где лежат (архив и/или релей). */
  async function load(cfg) {
    var list = await entries(cfg);
    var records = [], statuses = [], files = {};
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.file || e.relay_file) { files[e.id] = { archived: !!e.file && !e.expired, relay: !!e.relay_file }; continue; }
      if (!e.m) continue;
      var obj = await unseal(cfg, e.m);
      if (!obj) continue;
      if (obj.t === 'kp' && obj.rec && obj.rec.uid) {
        var rec = obj.rec; rec.msg = e.id; rec.time = e.time; rec.status = 'создано';
        records.push(rec);
      } else if (obj.t === 'status' && obj.uid) statuses.push({ uid: obj.uid, revision: Number(obj.revision), status: String(obj.status), time: e.time });
    }
    statuses.forEach(function (s) {
      records.forEach(function (r) { if (r.uid === s.uid && Number(r.revision) === s.revision) r.status = s.status; });
    });
    return { records: records, files: files };
  }
  function viewerUrl(cfg, pdf, pageBase) {
    var q = [];
    if (cfg.relay !== cfg.defaults.relay) q.push('r=' + encodeURIComponent(cfg.relay));
    if (cfg.archive !== cfg.defaults.archive) q.push('a=' + encodeURIComponent(cfg.archive));
    var name = b64u(new TextEncoder().encode(pdf.name || 'KP.pdf'));
    return new URL(cfg.viewer + (q.length ? '?' + q.join('&') : '') + '#' + [pdf.msg, pdf.key, pdf.iv, name].join('.'), pageBase).href;
  }

  root.KPH = { config: config, publishPdf: publishPdf, publish: publish, load: load, viewerUrl: viewerUrl, seal: seal, unseal: unseal, b64u: b64u, unb64u: unb64u, MAX_FILE: MAX_FILE };
})(typeof self !== 'undefined' ? self : this);
