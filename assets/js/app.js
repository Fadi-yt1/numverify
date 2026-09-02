/* ============================================================
   Phone Number Validator — index page.
   Number validation via numverify. Shared helpers, transports and
   settings live in core.js (window.NV); the DNC checker has its
   own page in dnc.html.
   ============================================================ */
(function () {
  'use strict';

  var NV = window.NV;
  var $ = NV.$, $$ = NV.$$, esc = NV.esc, flagFor = NV.flagFor;
  var readLS = NV.readLS, writeLS = NV.writeLS, apiKey = NV.apiKey, toast = NV.toast;
  var ICONS = NV.ICONS, cell = NV.cell, stripInternal = NV.stripInternal;
  var runTransports = NV.runTransports;

  // ---------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------
  var API_PATH   = 'apilayer.net/api/validate';
  var LS_HISTORY = 'nv.history';
  var LS_COUNTRY = 'nv.country';
  var MAX_HISTORY = 8;

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
    105: 'This numverify key is limited to the plain-HTTP endpoint, which a secure page cannot call. ' +
         'Use a key whose plan allows HTTPS, or run the site behind your own proxy.',
    106: 'No results — the number could not be processed.',
    210: 'No phone number was supplied.',
    211: 'The phone number supplied is not numeric.'
  };

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
    dialPrefix.hidden = ownPrefix;
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
  // numverify client
  // ---------------------------------------------------------
  function apiError(code, error) {
    var err = new Error(API_ERRORS[code] || (error && error.info) || 'The validation service rejected the request.');
    err.code = code;
    err.__api = true;
    // There is no relay to retry against, so a key the plan will not serve over
    // HTTPS (105) fails as finally as an invalid, inactive or exhausted one.
    err.__fatal = (code === 101 || code === 102 || code === 104 || code === 105);
    return err;
  }

  /* numverify, called directly and only directly. */
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
    var url = 'https://' + API_PATH + '?' + buildQuery(raw).qs;
    return runTransports(url, url, interpretNumverify);
  }

  // ---------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------
  var resultRegion = $('#resultRegion');

  function renderNotice(kind, title, message) { NV.renderNotice(resultRegion, kind, title, message); }

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
          'Queried numverify directly — the key went to no one else.' +
        '</span>' +
        '<button type="button" class="link-btn raw-toggle" data-raw>Show raw JSON</button>' +
      '</div>' +
      '<pre class="raw-json" hidden>' + esc(JSON.stringify(stripInternal(data), null, 2)) + '</pre>';

    resultRegion.innerHTML = '<div class="result-card">' + head + grid + foot + '</div>';
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

  function submit() {
    if (busy) return;
    var raw = numberInput.value.trim();
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

    busy = true;
    submitBtn.classList.add('is-loading');
    submitBtn.disabled = true;
    $('.btn-label', submitBtn).textContent = 'Checking';

    lookup(raw)
      .then(function (data) {
        renderResult(data);
        pushHistory(data);
      })
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
        $('.btn-label', submitBtn).textContent = 'Validate';
      });
  }

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
    countrySelect.value = '';
    syncPrefix();
    numberInput.value = '+' + item.getAttribute('data-number');
    toggleClear();
    submit();
  });

  form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });

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
  NV.initTheme();
  NV.initKeyDialog();
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
