/* ============================================================
   Phone Number Validator — client-side phone number validation & lookup
   No backend, no login. Talks to the numverify API directly.
   ============================================================ */
(function () {
  'use strict';

  // ---------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------
  var DEMO_KEY   = 'c2ebb50af59ed2f763aeb27b5ad21d5b';
  var API_PATH   = 'apilayer.net/api/validate';

  /* FTC Do Not Call complaint data, served through api.data.gov. This is the
     complaints dataset — numbers the public has REPORTED for unwanted calls —
     not the Do Not Call Registry itself, which has no public API. */
  var DNC_DEMO_KEY = 'jkzgzmORpKYNKiqMNcBeYUPess4APxhKUMbeWXFA';
  var DNC_PATH     = 'api.ftc.gov/v0/dnc-complaints';
  var DNC_PAGE     = 50;

  var LS_KEY     = 'nv.apikey';
  var LS_DNC_KEY = 'nv.dnckey';
  var LS_HISTORY = 'nv.history';
  var LS_THEME   = 'nv.theme';
  var LS_COUNTRY = 'nv.country';
  var TIMEOUT_MS = 15000;
  var MAX_HISTORY = 8;

  /* numverify serves HTTPS on paid plans only. On the free plan the encrypted
     endpoint answers with error 105, and a plain-HTTP call from an HTTPS page is
     blocked by the browser as mixed content. So: always try the encrypted
     endpoint first, and only if it is unavailable relay the request through a
     public HTTPS relay that can reach the plain-HTTP endpoint. */
  var TRANSPORTS = [
    { name: 'direct', direct: true, wrap: function (url) { return url; } },
    { name: 'relay-allorigins', wrap: function (url) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url); } },
    { name: 'relay-codetabs',   wrap: function (url) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url); } },
    { name: 'relay-corsproxy',  wrap: function (url) { return 'https://corsproxy.io/?url=' + encodeURIComponent(url); } }
  ];

  var LINE_TYPES = {
    mobile:           { label: 'Mobile',            note: 'Can receive SMS' },
    landline:         { label: 'Landline',          note: 'Fixed line — no SMS' },
    special_services: { label: 'Special services',  note: 'Service or short code' },
    toll_free:        { label: 'Toll free',         note: 'Free to the caller' },
    premium_rate:     { label: 'Premium rate',      note: 'Charged at a premium' },
    satellite:        { label: 'Satellite',         note: 'Satellite network' },
    paging:           { label: 'Paging',            note: 'Pager network' },
    voip:             { label: 'VoIP',              note: 'Internet telephony' }
  };

  var API_ERRORS = {
    101: 'The API access key is invalid or has been revoked.',
    102: 'The API account is inactive. Add your own access key to continue.',
    103: 'The requested API endpoint does not exist.',
    104: 'The monthly request quota for this access key has been used up.',
    105: 'This access key is not permitted to use the encrypted endpoint.',
    106: 'No results — the number could not be processed.',
    210: 'No phone number was supplied.',
    211: 'The phone number supplied is not numeric.'
  };

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

  function toast(message) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2200);
  }

  // ---------------------------------------------------------
  // Country select
  // ---------------------------------------------------------
  var COUNTRIES = window.NV_COUNTRIES || [];
  var byIso = {};
  COUNTRIES.forEach(function (c) { byIso[c.iso] = c; });

  var countrySelect = $('#countrySelect');
  var dialPrefix    = $('#dialPrefix');

  COUNTRIES.slice()
    .sort(function (a, b) { return a.name.localeCompare(b.name); })
    .forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.iso;
      opt.textContent = flagFor(c.iso) + '  ' + c.name + '  (+' + c.dial + ')';
      countrySelect.appendChild(opt);
    });

  function selectedCountry() {
    return countrySelect.value ? byIso[countrySelect.value] : null;
  }

  /* The prefix chip stands in for the dialling code the user has not typed.
     Once they type their own "+" (or "00") it would just be a duplicate, so
     it is hidden. */
  function syncPrefix() {
    var c = selectedCountry();
    var typed = numberInput ? numberInput.value.trim() : '';
    var ownPrefix = typed.charAt(0) === '+' || typed.slice(0, 2) === '00';
    dialPrefix.hidden = ownPrefix || mode === 'dnc';   // DNC takes bare US digits
    dialPrefix.textContent = c ? '+' + c.dial : '+';
    writeLS(LS_COUNTRY, countrySelect.value || '');
  }

  var savedCountry = readLS(LS_COUNTRY, '');
  if (typeof savedCountry === 'string' && byIso[savedCountry]) countrySelect.value = savedCountry;
  syncPrefix();
  countrySelect.addEventListener('change', syncPrefix);

  // ---------------------------------------------------------
  // Number normalisation
  // ---------------------------------------------------------
  function normalise(raw) {
    var trimmed = String(raw || '').trim();
    var international = trimmed.charAt(0) === '+' || trimmed.slice(0, 2) === '00';
    var digits = trimmed.replace(/\D/g, '');
    if (trimmed.slice(0, 2) === '00') digits = digits.replace(/^00/, '');
    return { digits: digits, international: international };
  }

  /* Decide what to send to the API. A number typed with a leading "+" (or "00")
     is already international, so the country picker is ignored; otherwise a
     picked country is passed along and the API expands the local number. */
  function buildQuery(raw) {
    var n = normalise(raw);
    var country = selectedCountry();
    var params = { access_key: apiKey(), number: n.digits, format: '1' };

    if (!n.international && country) {
      // If the local number already starts with its own dial code and is long
      // enough to be a full international number, treat it as international.
      var looksInternational = n.digits.indexOf(country.dial) === 0 &&
                               n.digits.length >= country.dial.length + 9;
      if (!looksInternational) params.country_code = country.iso;
    }

    return { qs: new URLSearchParams(params).toString(), digits: n.digits };
  }

  // ---------------------------------------------------------
  // Network
  // ---------------------------------------------------------
  function fetchJson(url) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    var opts = { method: 'GET', mode: 'cors', cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(url, opts)
      .then(function (res) { return res.text(); })
      .then(function (text) {
        clearTimeout(timer);
        var data;
        try { data = JSON.parse(text); }
        catch (e) { throw new Error('The validation service returned an unreadable response.'); }
        if (!data || typeof data !== 'object') throw new Error('The validation service returned an empty response.');
        return data;
      })
      .catch(function (err) {
        clearTimeout(timer);
        throw err;
      });
  }

  function apiError(code, error) {
    var err = new Error(API_ERRORS[code] || (error && error.info) || 'The validation service rejected the request.');
    err.code = code;
    // An invalid key, an inactive account or an exhausted quota fails the same
    // way on every transport, so there is no point retrying those.
    err.__fatal = (code === 101 || code === 102 || code === 104);
    return err;
  }

  /* Walk the transport chain until one produces a usable answer. The first
     transport fetches `directUrl` as-is; every relay wraps `relayUrl` instead,
     because numverify's free plan needs its plain-HTTP URL there while the
     direct call must stay on HTTPS. `interpret` turns a parsed body into a
     result or throws; an error marked __fatal ends the chain immediately,
     since it would fail the same way on every transport. */
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
          lastError = err;
          return attempt(i + 1);
        });
    }

    return attempt(0);
  }

  /* numverify. Error 105 (encrypted endpoint not on this plan) is not fatal —
     it is exactly the case the relays exist to cover. */
  function interpretNumverify(data) {
    if (data.success === false && data.error) {
      throw apiError(Number(data.error.code), data.error);
    }
    if (typeof data.valid === 'undefined') {
      throw new Error('The validation service returned an unexpected payload.');
    }
    return data;
  }

  function lookup(raw) {
    var qs = buildQuery(raw).qs;
    return runTransports('https://' + API_PATH + '?' + qs,
                         'http://' + API_PATH + '?' + qs,
                         interpretNumverify);
  }

  // ---------------------------------------------------------
  // Rendering
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

  function renderResult(data) {
    var valid = data.valid === true;
    var lt = LINE_TYPES[data.line_type] || null;
    var display = data.international_format || ('+' + (data.number || ''));
    var iso = data.country_code || '';

    var head =
      '<div class="result-head">' +
        '<span class="verdict ' + (valid ? 'ok' : 'bad') + '">' +
          (valid ? ICONS.check : ICONS.cross) +
          (valid ? 'Valid number' : 'Not a valid number') +
        '</span>' +
        '<span class="result-number">' +
          '<span class="result-flag" aria-hidden="true">' + flagFor(iso) + '</span>' +
          '<span class="big">' + esc(display) + '</span>' +
        '</span>' +
        (valid
          ? '<button type="button" class="copy-btn" data-copy="' + esc(data.international_format || '') + '">' +
              ICONS.copy + 'Copy E.164</button>'
          : '') +
      '</div>';

    var grid;
    if (valid) {
      grid = '<div class="result-grid">' +
        cell(ICONS.carrier, 'Carrier', data.carrier) +
        cell(ICONS.line, 'Line type', lt ? lt.label : data.line_type,
             { badge: data.line_type || '', note: lt ? lt.note : '' }) +
        cell(ICONS.globe, 'Country', data.country_name ? data.country_name + ' (' + iso + ')' : iso) +
        cell(ICONS.pin, 'Location', data.location) +
        cell(ICONS.hash, 'Country prefix', data.country_prefix, { mono: true }) +
        cell(ICONS.hash, 'Local format', data.local_format, { mono: true }) +
      '</div>';
    } else {
      grid = '<div class="result-grid">' +
        '<div class="cell" style="grid-column:1/-1">' +
          '<span class="k">' + ICONS.alert + 'What this means</span>' +
          '<span class="v" style="font-weight:400;font-size:.92rem;color:var(--text-dim)">' +
            'The number <code>' + esc(data.number || '') + '</code> does not match any active numbering range. ' +
            'Check the country code and the digit count — a missing country code is the most common cause.' +
          '</span>' +
        '</div>' +
      '</div>';
    }

    var foot =
      '<div class="result-foot">' +
        '<span class="micro">' +
          (data.__secure
            ? 'Queried directly.'
            : 'Queried via a relay.') +
        '</span>' +
        '<button type="button" class="link-btn raw-toggle" data-raw>Show raw JSON</button>' +
      '</div>' +
      '<pre class="raw-json" hidden>' + esc(JSON.stringify(stripInternal(data), null, 2)) + '</pre>';

    resultRegion.innerHTML = '<div class="result-card">' + head + grid + foot + '</div>';
  }

  function renderNotice(kind, title, message) {
    resultRegion.innerHTML =
      '<div class="notice ' + kind + '">' + ICONS.alert +
        '<div><h3>' + esc(title) + '</h3><p>' + esc(message) + '</p></div>' +
      '</div>';
  }

  resultRegion.addEventListener('click', function (e) {
    var raw = e.target.closest('[data-raw]');
    if (raw) {
      var pre = $('.raw-json', resultRegion);
      if (pre) {
        pre.hidden = !pre.hidden;
        raw.textContent = pre.hidden ? 'Show raw JSON' : 'Hide raw JSON';
      }
      return;
    }
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      var text = copy.getAttribute('data-copy');
      if (navigator.clipboard && text) {
        navigator.clipboard.writeText(text).then(
          function () { toast('Copied ' + text); },
          function () { toast('Could not copy'); }
        );
      }
    }
  });

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

  function interpretDnc(data) {
    // api.data.gov rejects bad keys and throttling with {"error":{code,message}}.
    if (data && data.error && (data.error.code || data.error.message)) {
      var code = String(data.error.code || '');
      var err = new Error(String(data.error.message || 'The FTC API rejected the request.'));
      err.__fatal = /API_KEY|OVER_RATE_LIMIT/i.test(code);
      throw err;
    }
    var rows = dncRows(data);
    if (!rows) throw new Error('The FTC complaint API returned an unexpected payload.');
    return { rows: rows, raw: data };
  }

  function dncLookup(raw) {
    var digits = usDigits(raw);
    var qs = new URLSearchParams({
      api_key: dncKey(),
      company_phone_number: digits,
      items_per_page: String(DNC_PAGE)
    }).toString();
    var url = 'https://' + DNC_PATH + '?' + qs;

    return runTransports(url, url, interpretDnc).then(function (res) {
      var all = res.rows.map(normaliseComplaint);
      // Confirm the server actually applied the phone filter. If it ignored the
      // parameter we would otherwise present unrelated complaints as this
      // number's, so keep only rows that really match and say what happened.
      var rows = all.filter(function (c) { return c.phone === digits; });
      return {
        number: digits,
        rows: rows,
        unfiltered: all.length > 0 && rows.length === 0,
        raw: res.raw,
        __secure: res.__secure
      };
    });
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

  function renderDnc(result) {
    var rows = result.rows.slice().sort(function (a, b) { return b.time - a.time; });
    var s = dncSummary(rows);
    var pretty = result.number.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3');

    var tone = s.count === 0 ? 'ok' : (s.count >= 5 ? 'bad' : 'warn');
    var verdict = s.count === 0
      ? 'No FTC complaints on file'
      : s.count + (s.count === 1 ? ' complaint filed' : ' complaints filed');

    var head =
      '<div class="result-head">' +
        '<span class="verdict ' + tone + '">' +
          (s.count === 0 ? ICONS.check : ICONS.alert) + esc(verdict) +
        '</span>' +
        '<span class="result-number">' +
          '<span class="result-flag" aria-hidden="true">🇺🇸</span>' +
          '<span class="big">' + esc(pretty) + '</span>' +
        '</span>' +
      '</div>';

    var grid = '<div class="result-grid">' +
      cell(ICONS.alert, 'Complaints', String(s.count)) +
      cell(ICONS.hash, 'Most recent', s.latest) +
      cell(ICONS.line, 'Robocalls', s.count ? s.robocalls + ' of ' + s.count : '') +
      cell(ICONS.globe, 'Reported from', s.states) +
      cell(ICONS.carrier, 'Top subject', s.topSubject) +
      cell(ICONS.pin, 'Sample size', 'Latest ' + DNC_PAGE + ' complaints') +
    '</div>';

    var list = '';
    if (rows.length) {
      list = '<div class="complaints">' +
        '<h3 class="complaints-head">Recent complaints</h3>' +
        '<ul class="complaint-list">' +
          rows.slice(0, 10).map(function (c) {
            return '<li class="complaint">' +
              '<span class="c-date">' + esc(c.date || '—') + '</span>' +
              '<span class="c-subject">' + esc(c.subject || 'No subject recorded') + '</span>' +
              '<span class="c-where">' + esc([c.city, c.state].filter(Boolean).join(', ')) + '</span>' +
              (c.robocall ? '<span class="badge voip">Robocall</span>' : '') +
            '</li>';
          }).join('') +
        '</ul>' +
      '</div>';
    }

    var warn = result.unfiltered
      ? '<div class="result-foot warn-foot">' + ICONS.alert +
        '<span class="micro">The API returned complaints but none carried this number, so the phone filter may not have applied. Check the raw JSON before trusting this result.</span>' +
        '</div>'
      : '';

    var foot =
      '<div class="result-foot">' +
        '<span class="micro">FTC consumer complaint data · ' +
          (result.__secure ? 'queried directly.' : 'queried via a relay.') +
          ' This is <strong>not</strong> a Do Not Call Registry scrub.</span>' +
        '<button type="button" class="link-btn raw-toggle" data-raw>Show raw JSON</button>' +
      '</div>' +
      '<pre class="raw-json" hidden>' + esc(JSON.stringify(result.raw, null, 2)) + '</pre>';

    resultRegion.innerHTML = '<div class="result-card">' + head + grid + list + warn + foot + '</div>';
  }

  // ---------------------------------------------------------
  // History
  // ---------------------------------------------------------
  var historySection = $('#historySection');
  var historyGrid    = $('#historyGrid');

  function renderHistory() {
    var list = readLS(LS_HISTORY, []);
    if (!Array.isArray(list) || !list.length) {
      historySection.hidden = true;
      historyGrid.innerHTML = '';
      return;
    }
    historySection.hidden = false;
    historyGrid.innerHTML = list.map(function (i) {
      return '<button type="button" class="hist-item" data-number="' + esc(i.raw) + '">' +
        '<span class="hist-flag" aria-hidden="true">' + flagFor(i.iso) + '</span>' +
        '<span class="hist-body">' +
          '<span class="hist-num">' + esc(i.number) + '</span>' +
          '<span class="hist-meta">' + esc(i.meta) + '</span>' +
        '</span>' +
        '<span class="hist-dot ' + (i.valid ? 'ok' : 'bad') + '" aria-hidden="true"></span>' +
      '</button>';
    }).join('');
  }

  function pushHistory(data) {
    var list = readLS(LS_HISTORY, []);
    if (!Array.isArray(list)) list = [];
    var entry = {
      number: data.international_format || ('+' + (data.number || '')),
      raw: data.number || '',
      iso: data.country_code || '',
      valid: data.valid === true,
      meta: [data.country_name, data.carrier,
             LINE_TYPES[data.line_type] ? LINE_TYPES[data.line_type].label : data.line_type]
              .filter(Boolean).join(' · ') || 'No details published'
    };
    list = list.filter(function (i) { return i.number !== entry.number; });
    list.unshift(entry);
    writeLS(LS_HISTORY, list.slice(0, MAX_HISTORY));
    renderHistory();
  }

  $('#clearHistory').addEventListener('click', function () {
    writeLS(LS_HISTORY, []);
    renderHistory();
    toast('History cleared');
  });

  // ---------------------------------------------------------
  // Form
  // ---------------------------------------------------------
  var form        = $('#lookupForm');
  var numberInput = $('#numberInput');
  var submitBtn   = $('#submitBtn');
  var clearBtn    = $('#clearBtn');
  var busy        = false;

  function toggleClear() {
    clearBtn.hidden = numberInput.value.length === 0;
    syncPrefix();
  }

  /* Both modes share one input, one button and one result region; `mode` picks
     which service the submit runs against. */
  var MODES = {
    validate: {
      label: 'Validate',
      busyLabel: 'Checking',
      placeholder: '14158586273',
      hint: 'Enter a number in international format (e.g. <code>+14158586273</code>), or pick a country and enter the local number.'
    },
    dnc: {
      label: 'Check DNC',
      busyLabel: 'Checking',
      placeholder: '2025550123',
      hint: 'US numbers only — enter 10 digits. Searches FTC consumer complaints filed against this number; it does <strong>not</strong> check the Do Not Call Registry.'
    }
  };
  var mode = 'validate';

  function submit() {
    if (busy) return;
    var raw = numberInput.value.trim();
    var runner;

    if (mode === 'dnc') {
      if (!usDigits(raw)) {
        renderNotice('warn', 'Enter a 10-digit US number',
          'FTC complaint data covers North American numbers only, for example 202 555 0123.');
        numberInput.focus();
        return;
      }
      runner = dncLookup(raw).then(renderDnc);
    } else {
      var n = normalise(raw);
      if (!n.digits) {
        renderNotice('warn', 'Enter a phone number',
          'Type a number in international format, or pick a country and enter the local number.');
        numberInput.focus();
        return;
      }
      if (n.digits.length < 4) {
        renderNotice('warn', 'That number looks too short',
          'A dialable number needs at least a country code and a subscriber number.');
        numberInput.focus();
        return;
      }
      runner = lookup(raw).then(function (data) {
        renderResult(data);
        pushHistory(data);
      });
    }

    busy = true;
    submitBtn.classList.add('is-loading');
    submitBtn.disabled = true;
    $('.btn-label', submitBtn).textContent = MODES[mode].busyLabel;

    runner
      .catch(function (err) {
        var fatal = !!(err && err.__fatal);
        renderNotice('error',
          fatal ? 'The API key could not be used' : 'Lookup failed',
          (err && err.message ? err.message : 'Something went wrong.') +
          (fatal
            ? ' Open “API key settings” to use your own access key.'
            : ' Please check your connection and try again.'));
      })
      .then(function () {
        busy = false;
        submitBtn.classList.remove('is-loading');
        submitBtn.disabled = false;
        $('.btn-label', submitBtn).textContent = MODES[mode].label;
      });
  }

  function setMode(next) {
    if (!MODES[next] || next === mode) return;
    mode = next;
    $$('.mode-tab').forEach(function (tab) {
      var on = tab.getAttribute('data-mode') === mode;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // DNC is US-only, so the country picker and the international samples have
    // nothing to offer there.
    $('.field-country').hidden = (mode === 'dnc');
    $('.samples').hidden = (mode === 'dnc');
    numberInput.placeholder = MODES[mode].placeholder;
    $('#inputHint').innerHTML = MODES[mode].hint;
    $('.btn-label', submitBtn).textContent = MODES[mode].label;
    resultRegion.innerHTML = '';
    toggleClear();
    numberInput.focus();
  }

  $$('.mode-tab').forEach(function (tab) {
    tab.addEventListener('click', function () { setMode(tab.getAttribute('data-mode')); });
  });

  numberInput.addEventListener('input', toggleClear);

  clearBtn.addEventListener('click', function () {
    numberInput.value = '';
    toggleClear();
    resultRegion.innerHTML = '';
    numberInput.focus();
  });

  $$('.chip[data-sample]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      countrySelect.value = '';
      syncPrefix();
      numberInput.value = '+' + chip.getAttribute('data-sample');
      toggleClear();
      submit();
    });
  });

  historyGrid.addEventListener('click', function (e) {
    var item = e.target.closest('.hist-item');
    if (!item) return;
    setMode('validate');            // history only ever holds validation results
    countrySelect.value = '';
    syncPrefix();
    numberInput.value = '+' + item.getAttribute('data-number');
    toggleClear();
    submit();
  });

  form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });

  // ---------------------------------------------------------
  // API key dialog
  // ---------------------------------------------------------
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

  // ---------------------------------------------------------
  // Theme
  // ---------------------------------------------------------
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

  // ---------------------------------------------------------
  // Stat count-up
  // ---------------------------------------------------------
  if ('IntersectionObserver' in window &&
      !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        var el = entry.target;
        var target = Number(el.getAttribute('data-count'));
        var suffix = el.textContent.indexOf('+') > -1 ? '+' : '';
        var start = performance.now();
        (function step(now) {
          var p = Math.min((now - start) / 900, 1);
          var eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(target * eased).toLocaleString() + suffix;
          if (p < 1) requestAnimationFrame(step);
        })(start);
      });
    }, { threshold: 0.4 });
    $$('.stat-num[data-count]').forEach(function (el) { io.observe(el); });
  }

  // ---------------------------------------------------------
  // Boot
  // ---------------------------------------------------------
  renderHistory();
  toggleClear();

  // Deep link support: index.html?number=+14158586273
  var qp = new URLSearchParams(location.search);
  if (qp.get('number')) {
    numberInput.value = qp.get('number');
    toggleClear();
    submit();
  }
})();
