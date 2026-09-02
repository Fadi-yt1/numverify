/* ============================================================
   Shared core — helpers, transports, the FTC complaint client,
   theme and API-key settings. Loaded by every page; exposed as
   window.NV so index.html and dnc.html share one implementation.
   ============================================================ */
(function () {
  'use strict';

  // ---------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------
  var DNC_DEMO_KEY = 'jkzgzmORpKYNKiqMNcBeYUPess4APxhKUMbeWXFA';
  var DNC_PATH     = 'api.ftc.gov/v0/dnc-complaints';
  var DNC_PAGE     = 50;      // the endpoint caps a response at 50 records
  var DNC_WINDOW_DAYS = 30;

  var LS_KEY     = 'nv.apikey';
  var LS_DNC_KEY = 'nv.dnckey';
  var LS_THEME   = 'nv.theme';
  var TIMEOUT_MS = 15000;

  var DEMO_KEY   = 'c2ebb50af59ed2f763aeb27b5ad21d5b';

  /* Public, like the API keys: a no-login static site has to ship whatever it
     calls with. Restrict this key to the site's own origin in the corsproxy.io
     dashboard — that, not secrecy, is what stops other sites spending the quota. */
  var CORSPROXY_KEY = '12d4731b';

  /* numverify serves HTTPS on paid plans only. On the free plan the encrypted
     endpoint answers with error 105, and a plain-HTTP call from an HTTPS page is
     blocked by the browser as mixed content. So: always try the encrypted
     endpoint first, and only if it is unavailable relay the request through a
     proxy that can reach the plain-HTTP endpoint.

     One relay, not three. The keyless public proxies used before could not be
     relied on and each failure cost a timeout before the next was tried; a
     single keyed relay fails fast and keeps the API keys away from services we
     have no account with. The cost is a single point of failure: if corsproxy
     is down or over quota, the relay path is gone and only the direct call
     remains. */
  var TRANSPORTS = [
    { name: 'direct', direct: true, wrap: function (url) { return url; } },
    { name: 'relay-corsproxy',
      wrap: function (url) {
        return 'https://corsproxy.io/?key=' + CORSPROXY_KEY + '&url=' + encodeURIComponent(url);
      } }
  ];

  // ---------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function flagFor(iso) {
    if (!iso || !/^[A-Za-z]{2}$/.test(iso)) return '🌐';
    var cps = iso.toUpperCase().split('').map(function (c) { return 0x1F1E6 + c.charCodeAt(0) - 65; });
    return String.fromCodePoint.apply(String, cps);
  }

  function readLS(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function writeLS(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  function apiKey() {
    var custom = readLS(LS_KEY, '');
    return (typeof custom === 'string' && custom.length >= 16) ? custom : DEMO_KEY;
  }

  function dncKey() {
    var custom = readLS(LS_DNC_KEY, '');
    return (typeof custom === 'string' && custom.length >= 16) ? custom : DNC_DEMO_KEY;
  }

  function snippet(text, max) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    max = max || 180;
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  function toast(message) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2200);
  }

  // ---------------------------------------------------------
  // Network
  // ---------------------------------------------------------
  function fetchJson(url) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    var opts = { method: 'GET', mode: 'cors', cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;

    var status = 0;
    return fetch(url, opts)
      .then(function (res) { status = res.status; return res.text(); })
      .then(function (text) {
        clearTimeout(timer);
        var data;
        try { data = JSON.parse(text); }
        catch (e) {
          // Carry the status and a slice of the body: an opaque "unreadable
          // response" tells nobody whether this was a 404, an HTML error page
          // or a relay failure.
          throw new Error('HTTP ' + status + ' — response was not JSON: ' + snippet(text));
        }
        if (!data || typeof data !== 'object') throw new Error('HTTP ' + status + ' — empty response.');
        data.__status = status;
        return data;
      })
      .catch(function (err) {
        clearTimeout(timer);
        throw err;
      });
  }


  /* Walk the transport chain until one produces a usable answer. The first
     transport fetches `directUrl` as-is; every relay wraps `relayUrl` instead,
     because numverify's free plan needs its plain-HTTP URL there while the
     direct call must stay on HTTPS. `interpret` turns a parsed body into a
     result or throws; an error marked __fatal ends the chain immediately,
     since it would fail the same way on every transport. */
  /* Keep the most informative failure: a real answer from the API beats a
     later relay timeout, which would otherwise overwrite it and leave the user
     with a generic connection message. */
  function keepError(prev, next) {
    if (!prev) return next;
    if (next && next.__api && !prev.__api) return next;
    return prev;
  }

  function runTransports(directUrl, relayUrl, interpret) {
    var lastError = null;

    function attempt(i) {
      if (i >= TRANSPORTS.length) {
        return Promise.reject(lastError || new Error('Could not reach the service.'));
      }
      var t = TRANSPORTS[i];

      return fetchJson(t.direct ? directUrl : t.wrap(relayUrl))
        .then(function (data) {
          var result = interpret(data);
          result.__transport = t.name;
          result.__secure = !!t.direct;
          return result;
        })
        .catch(function (err) {
          if (err && err.__fatal) throw err;
          lastError = keepError(lastError, err);
          return attempt(i + 1);
        });
    }

    return attempt(0);
  }

  // ---------------------------------------------------------
  // Shared rendering primitives
  // ---------------------------------------------------------
  var resultRegion = $('#resultRegion');

  var ICONS = {
    carrier: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/></svg>',
    line:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
    globe:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    pin:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    hash:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/></svg>',
    check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    cross:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    alert:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    copy:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
  };

  function cell(icon, key, value, opts) {
    opts = opts || {};
    var has = value !== null && value !== undefined && String(value).trim() !== '';
    var body;
    if (!has) {
      body = '<span class="v empty">Not published</span>';
    } else if (opts.badge) {
      body = '<span class="v"><span class="badge ' + esc(opts.badge) + '">' + esc(value) + '</span>' +
             (opts.note ? ' <span class="micro">' + esc(opts.note) + '</span>' : '') + '</span>';
    } else {
      body = '<span class="v' + (opts.mono ? ' mono' : '') + '">' + esc(value) + '</span>';
    }
    return '<div class="cell"><span class="k">' + icon + esc(key) + '</span>' + body + '</div>';
  }

  function stripInternal(data) {
    var out = {};
    Object.keys(data).forEach(function (k) { if (k.indexOf('__') !== 0) out[k] = data[k]; });
    return out;
  }

  function renderNotice(target, kind, title, message) {
    target.innerHTML =
      '<div class="notice ' + kind + '">' + ICONS.alert +
        '<div><h3>' + esc(title) + '</h3><p>' + esc(message) + '</p></div>' +
      '</div>';
  }

  // ---------------------------------------------------------
  // DNC complaint check (FTC / api.data.gov)
  // ---------------------------------------------------------

  /* Reduce anything the user typed to the 10 NANP digits, dropping a leading
     country code. Returns '' when the input cannot be a US number. */
  function usDigits(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }

  /* The exact JSON shape of the FTC endpoint is not pinned down here, so read
     it defensively: rows may arrive as a bare array, or under data/results/
     records, and each row's fields may sit directly on the row or under a
     JSON:API `attributes` object. */
  function dncRows(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.results)) return data.results;
    if (data && Array.isArray(data.records)) return data.records;
    return null;
  }

  /* Field names differ between hyphenated, snake and camel spellings across FTC
     datasets, so match on letters and digits alone. */
  function dncField(row, names) {
    var src = (row && typeof row.attributes === 'object' && row.attributes) ? row.attributes : row;
    if (!src || typeof src !== 'object') return '';
    var keys = Object.keys(src);
    var norm = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); };
    for (var i = 0; i < names.length; i++) {
      var want = norm(names[i]);
      for (var j = 0; j < keys.length; j++) {
        if (norm(keys[j]) === want && src[keys[j]] != null && src[keys[j]] !== '') return src[keys[j]];
      }
    }
    return '';
  }

  function dncDate(value) {
    if (!value) return { label: '', time: 0 };
    var str = String(value);
    var t = Date.parse(str);
    if (isNaN(t)) {
      var us = str.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);   // MM/DD/YYYY
      if (us) t = Date.parse(us[3] + '-' + ('0' + us[1]).slice(-2) + '-' + ('0' + us[2]).slice(-2));
    }
    if (isNaN(t)) return { label: str, time: 0 };
    return { label: new Date(t).toISOString().slice(0, 10), time: t };
  }

  function normaliseComplaint(row) {
    var date = dncDate(dncField(row, ['created-date', 'date-received', 'violation-date', 'created', 'date']));
    var robo = String(dncField(row, ['recorded-message-or-robocall', 'robocall', 'recorded-message'])).toLowerCase();
    return {
      phone:   String(dncField(row, ['company-phone-number', 'phone-number', 'caller-id-number', 'phone'])).replace(/\D/g, ''),
      date:    date.label,
      time:    date.time,
      subject: String(dncField(row, ['subject', 'topic', 'complaint-subject']) || ''),
      city:    String(dncField(row, ['consumer-city', 'city']) || ''),
      state:   String(dncField(row, ['consumer-state', 'state']) || ''),
      robocall: robo === 'y' || robo === 'yes' || robo === 'true' || robo === '1'
    };
  }

  /* Pull a human message out of whichever error envelope came back:
     api.data.gov uses {"error":{code,message}}, while the FTC's JSON:API layer
     uses {"errors":[{status,title,detail}]}. Missing this second shape is what
     made a plain 400 surface as "unexpected payload". */
  function dncError(data) {
    if (!data || typeof data !== 'object') return null;

    if (Array.isArray(data.errors) && data.errors.length) {
      var first = data.errors[0] || {};
      var text = first.detail || first.title || first.message || 'The FTC API rejected the request.';
      var e = new Error(String(text));
      e.__api = true;
      e.__fatal = String(first.status || '') === '403';
      return e;
    }
    if (data.error) {
      var code = String(data.error.code || '');
      var msg = typeof data.error === 'string'
        ? data.error
        : String(data.error.message || data.error.detail || 'The FTC API rejected the request.');
      var err = new Error(msg);
      err.__api = true;
      err.__fatal = /API_KEY|OVER_RATE_LIMIT/i.test(code);
      return err;
    }
    return null;
  }

  function interpretDnc(data) {
    var err = dncError(data);
    if (err) throw err;
    var rows = dncRows(data);
    if (!rows) {
      throw new Error('HTTP ' + (data.__status || '?') + ' — no complaint records in the response: ' +
                      snippet(JSON.stringify(data)));
    }
    return { rows: rows, raw: data };
  }

  function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

  /* The API has no filter for the number that placed the call — company-phone-
     number is a response field only. The documented filters are the created
     date, state, area_code and is_robocall, so the closest we can get is to
     pull a recent window of complaints for the number's own area code and look
     for it among them. Each entry is a fallback for the one before it, so an
     unsupported parameter degrades the scope instead of failing the lookup. */
  function dncQueries(digits) {
    var area = digits.slice(0, 3);
    var now = Date.now();
    var from = isoDay(now - DNC_WINDOW_DAYS * 864e5);
    var to = isoDay(now);
    return [
      { params: { area_code: area, created_date_from: from, created_date_to: to },
        scope: 'area code ' + area + ', ' + from + ' to ' + to },
      { params: { area_code: area },
        scope: 'area code ' + area + ', most recent complaints' },
      { params: {},
        scope: 'most recent complaints nationwide' }
    ];
  }

  function dncLookup(raw) {
    var digits = usDigits(raw);
    var queries = dncQueries(digits);
    var lastError = null;

    function attempt(i) {
      if (i >= queries.length) {
        return Promise.reject(lastError || new Error('Could not reach the FTC complaint API.'));
      }
      var q = queries[i];
      var params = { api_key: dncKey(), items_per_page: String(DNC_PAGE) };
      Object.keys(q.params).forEach(function (k) { params[k] = q.params[k]; });
      var url = 'https://' + DNC_PATH + '?' + new URLSearchParams(params).toString();

      return runTransports(url, url, interpretDnc)
        .then(function (res) {
          var scanned = res.rows.map(normaliseComplaint);
          return {
            number: digits,
            areaCode: digits.slice(0, 3),
            scope: q.scope,
            scanned: scanned,
            matches: scanned.filter(function (c) { return c.phone === digits; }),
            raw: res.raw,
            __secure: res.__secure
          };
        })
        .catch(function (err) {
          if (err && err.__fatal) throw err;
          lastError = keepError(lastError, err);
          return attempt(i + 1);
        });
    }

    return attempt(0);
  }

  function dncSummary(rows) {
    var subjects = {}, states = {}, robo = 0, latest = 0, latestLabel = '';
    rows.forEach(function (c) {
      if (c.robocall) robo++;
      if (c.subject) subjects[c.subject] = (subjects[c.subject] || 0) + 1;
      if (c.state) states[c.state] = (states[c.state] || 0) + 1;
      if (c.time > latest) { latest = c.time; latestLabel = c.date; }
    });
    var top = function (map, n) {
      return Object.keys(map)
        .sort(function (a, b) { return map[b] - map[a]; })
        .slice(0, n);
    };
    return {
      count: rows.length,
      robocalls: robo,
      latest: latestLabel || (rows.length ? rows[0].date : ''),
      topSubject: top(subjects, 1)[0] || '',
      states: top(states, 3).join(', ')
    };
  }

  // ---------------------------------------------------------
  // API key dialog
  // ---------------------------------------------------------
  function initKeyDialog() {
    var keyDialog = $('#keyDialog');
    var keyInput  = $('#keyInput');

    var dncKeyInput = $('#dncKeyInput');

    function openKeyDialog() {
      var custom = readLS(LS_KEY, '');
      var customDnc = readLS(LS_DNC_KEY, '');
      keyInput.value = typeof custom === 'string' ? custom : '';
      dncKeyInput.value = typeof customDnc === 'string' ? customDnc : '';
      if (typeof keyDialog.showModal === 'function') keyDialog.showModal();
      else keyDialog.setAttribute('open', '');
      keyInput.focus();
    }
    function closeKeyDialog() {
      if (typeof keyDialog.close === 'function') keyDialog.close();
      else keyDialog.removeAttribute('open');
    }

    ['#openKeyDialog', '#openKeyDialog2'].forEach(function (sel) {
      var el = $(sel);
      if (el) el.addEventListener('click', openKeyDialog);
    });

    $('#keyCancel').addEventListener('click', closeKeyDialog);

    function saveKey() {
      var v = keyInput.value.trim();
      var d = dncKeyInput.value.trim();
      if ((v && v.length < 16) || (d && d.length < 16)) { toast('That key looks too short'); return; }
      writeLS(LS_KEY, v);
      writeLS(LS_DNC_KEY, d);
      closeKeyDialog();
      toast((v || d) ? 'Using your access keys' : 'Using the demo keys');
    }

    /* Save is a submit button, so this covers both the click and Enter. The
       dialog uses method="dialog", which would otherwise close without keeping
       what was typed. */
    $('#keyForm').addEventListener('submit', function (e) { e.preventDefault(); saveKey(); });

    $('#keyReset').addEventListener('click', function () {
      writeLS(LS_KEY, '');
      writeLS(LS_DNC_KEY, '');
      keyInput.value = '';
      dncKeyInput.value = '';
      closeKeyDialog();
      toast('Using the demo keys');
    });
  }

  // ---------------------------------------------------------
  // Theme
  // ---------------------------------------------------------
  function initTheme() {
    var themeToggle = $('#themeToggle');

    function applyTheme(theme) {
      if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
      else document.documentElement.removeAttribute('data-theme');
    }

    var savedTheme = readLS(LS_THEME, null);
    if (savedTheme) applyTheme(savedTheme);
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) applyTheme('light');

    themeToggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
      writeLS(LS_THEME, next);
    });
  }

  // ---------------------------------------------------------
  // Exports
  // ---------------------------------------------------------
  /* Only what the pages actually consume; the rest stays internal. */
  window.NV = {
    $: $, $$: $$, esc: esc, flagFor: flagFor, toast: toast,
    readLS: readLS, writeLS: writeLS, apiKey: apiKey,
    runTransports: runTransports,
    ICONS: ICONS, cell: cell, stripInternal: stripInternal, renderNotice: renderNotice,
    usDigits: usDigits, dncLookup: dncLookup, dncSummary: dncSummary,
    initTheme: initTheme, initKeyDialog: initKeyDialog
  };
})();
