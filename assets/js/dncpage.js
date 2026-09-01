/* ============================================================
   DNC checker page — single and bulk lookups, plus the browser-local
   number database. Shared helpers come from core.js (window.NV) and
   storage from dncdb.js (window.NV_DNCDB).
   ============================================================ */
(function () {
  'use strict';

  var NV = window.NV;
  var DB = window.NV_DNCDB;
  var $ = NV.$, $$ = NV.$$, esc = NV.esc, toast = NV.toast;
  var ICONS = NV.ICONS, cell = NV.cell, stripInternal = NV.stripInternal;

  var MAX_BULK = 25;

  var resultRegion = $('#resultRegion');
  var numberInput  = $('#numberInput');
  var submitBtn    = $('#submitBtn');
  var clearBtn     = $('#clearBtn');
  var busy         = false;

  function renderNotice(kind, title, message) { NV.renderNotice(resultRegion, kind, title, message); }
  function pretty(digits) { return digits.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3'); }

  // ---------------------------------------------------------
  // Result card
  // ---------------------------------------------------------
  function renderDnc(result) {
    var matches = result.matches.slice().sort(function (a, b) { return b.time - a.time; });
    var scanned = result.scanned.slice().sort(function (a, b) { return b.time - a.time; });
    var s = NV.dncSummary(scanned);
    var hit = matches.length > 0;

    /* A hit is meaningful; a miss is not a clean bill of health, because the
       sample is only a slice of the complaint stream. The wording carries that
       difference rather than flattening it into a verdict. */
    var verdict = hit
      ? 'Reported ' + matches.length + (matches.length === 1 ? ' time' : ' times') + ' in this sample'
      : 'Not found in this sample';

    var head =
      '<div class="result-head">' +
        '<span class="verdict ' + (hit ? 'bad' : 'warn') + '">' +
          (hit ? ICONS.alert : ICONS.check) + esc(verdict) +
        '</span>' +
        '<span class="result-number">' +
          '<span class="result-flag" aria-hidden="true">🇺🇸</span>' +
          '<span class="big">' + esc(pretty(result.number)) + '</span>' +
        '</span>' +
        '<span class="saved-chip">' + ICONS.check + 'Saved to database</span>' +
      '</div>';

    var grid = '<div class="result-grid">' +
      cell(ICONS.alert, 'This number', hit ? matches.length + ' complaint' + (matches.length === 1 ? '' : 's') : 'No match') +
      cell(ICONS.hash, 'Complaints scanned', String(scanned.length)) +
      cell(ICONS.line, 'Robocalls in sample', scanned.length ? s.robocalls + ' of ' + scanned.length : '') +
      cell(ICONS.globe, 'Sample scope', result.scope) +
      cell(ICONS.carrier, 'Top subject in sample', s.topSubject) +
      cell(ICONS.pin, 'Most recent in sample', s.latest) +
    '</div>';

    var rows = hit ? matches : scanned;
    var list = '';
    if (rows.length) {
      list = '<div class="complaints">' +
        '<h3 class="complaints-head">' +
          (hit ? 'Complaints naming this number' : 'Recent complaints in this sample') +
        '</h3>' +
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

    var caveat = '<div class="result-foot warn-foot">' + ICONS.alert +
      '<span class="micro">The FTC API cannot be filtered by the calling number, so this only searched ' +
      esc(result.scope) + ' (' + scanned.length + ' records). ' +
      (hit ? 'The true total is likely higher.'
           : 'A miss here does <strong>not</strong> mean the number is clean.') +
      '</span></div>';

    var foot =
      '<div class="result-foot">' +
        '<span class="micro">FTC consumer complaint data · ' +
          (result.__secure ? 'queried directly.' : 'queried via a relay.') +
          ' This is <strong>not</strong> a Do Not Call Registry scrub.</span>' +
        '<button type="button" class="link-btn raw-toggle" data-raw>Show raw JSON</button>' +
      '</div>' +
      '<pre class="raw-json" hidden>' + esc(JSON.stringify(stripInternal(result.raw), null, 2)) + '</pre>';

    resultRegion.innerHTML = '<div class="result-card">' + head + grid + list + caveat + foot + '</div>';
  }

  resultRegion.addEventListener('click', function (e) {
    var raw = e.target.closest('[data-raw]');
    if (!raw) return;
    var pre = $('.raw-json', resultRegion);
    if (!pre) return;
    pre.hidden = !pre.hidden;
    raw.textContent = pre.hidden ? 'Show raw JSON' : 'Hide raw JSON';
  });

  // ---------------------------------------------------------
  // Lookup + save
  // ---------------------------------------------------------
  function toRecord(result) {
    var matches = result.matches.slice().sort(function (a, b) { return b.time - a.time; });
    var newest = matches[0];
    return {
      number: result.number,
      reported: matches.length > 0,
      complaints: matches.length,
      scanned: result.scanned.length,
      scope: result.scope,
      lastSubject: newest ? newest.subject : '',
      lastComplaintDate: newest ? newest.date : '',
      checkedAt: Date.now()
    };
  }

  function runCheck(raw) {
    return NV.dncLookup(raw).then(function (result) {
      return DB.upsert(toRecord(result)).then(function () {
        return result;
      });
    });
  }

  function setBusy(on, label) {
    busy = on;
    submitBtn.classList.toggle('is-loading', on);
    submitBtn.disabled = on;
    $('.btn-label', submitBtn).textContent = label;
  }

  function submit() {
    if (busy) return;
    var raw = numberInput.value.trim();
    if (!NV.usDigits(raw)) {
      renderNotice('warn', 'Enter a 10-digit US number',
        'FTC complaint data covers North American numbers only, for example 202 555 0123.');
      numberInput.focus();
      return;
    }

    setBusy(true, 'Checking');
    runCheck(raw)
      .then(function (result) {
        renderDnc(result);
        return refreshDb();
      })
      .catch(function (err) {
        var fatal = !!(err && err.__fatal);
        renderNotice('error',
          fatal ? 'The API key could not be used' : 'Lookup failed',
          (err && err.message ? err.message : 'Something went wrong.') +
          (fatal ? ' Open “API key settings” to use your own api.data.gov key.'
                 : ' Please check your connection and try again.'));
      })
      .then(function () { setBusy(false, 'Check number'); });
  }

  $('#dncForm').addEventListener('submit', function (e) { e.preventDefault(); submit(); });

  numberInput.addEventListener('input', function () {
    clearBtn.hidden = numberInput.value.length === 0;
  });
  clearBtn.addEventListener('click', function () {
    numberInput.value = '';
    clearBtn.hidden = true;
    resultRegion.innerHTML = '';
    numberInput.focus();
  });

  // ---------------------------------------------------------
  // Bulk check
  // ---------------------------------------------------------
  var bulkStatus = $('#bulkStatus');

  $('#bulkRun').addEventListener('click', function () {
    if (busy) return;
    var lines = $('#bulkInput').value.split(/[\n,;]+/)
      .map(function (l) { return NV.usDigits(l); })
      .filter(Boolean);
    // De-duplicate so a pasted list does not spend quota on the same number twice.
    var seen = {}, numbers = [];
    lines.forEach(function (n) { if (!seen[n]) { seen[n] = 1; numbers.push(n); } });

    if (!numbers.length) {
      bulkStatus.textContent = 'No valid 10-digit US numbers found.';
      return;
    }
    if (numbers.length > MAX_BULK) {
      bulkStatus.textContent = 'Too many — checking the first ' + MAX_BULK + '.';
      numbers = numbers.slice(0, MAX_BULK);
    }

    setBusy(true, 'Checking');
    var done = 0, failed = 0, lastResult = null;

    // Sequential on purpose: the shared api.data.gov key is rate limited, and a
    // burst of parallel requests is the fastest way to exhaust it.
    numbers.reduce(function (chain, n) {
      return chain.then(function () {
        bulkStatus.textContent = 'Checking ' + (done + 1) + ' of ' + numbers.length + '…';
        return runCheck(n)
          .then(function (r) { lastResult = r; done++; })
          .catch(function () { failed++; });
      });
    }, Promise.resolve()).then(function () {
      bulkStatus.textContent = 'Checked ' + done + ' of ' + numbers.length +
        (failed ? ' — ' + failed + ' failed.' : '.');
      if (lastResult) renderDnc(lastResult);
      setBusy(false, 'Check number');
      return refreshDb();
    });
  });

  // ---------------------------------------------------------
  // Database view
  // ---------------------------------------------------------
  var dbBody   = $('#dbBody');
  var dbEmpty  = $('#dbEmpty');
  var dbSearch = $('#dbSearch');
  var dbFilter = $('#dbFilter');
  var rowsCache = [];
  var sortKey = 'checkedAt';
  var sortDir = -1;

  function fmtDate(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    return isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
  }

  function visibleRows() {
    var q = dbSearch.value.trim().toLowerCase();
    var mode = dbFilter.value;
    return rowsCache.filter(function (r) {
      if (mode === 'reported' && !r.reported) return false;
      if (mode === 'clean' && r.reported) return false;
      if (mode === 'flagged' && !r.flagged) return false;
      if (!q) return true;
      return (r.number + ' ' + (r.lastSubject || '') + ' ' + (r.note || '')).toLowerCase().indexOf(q) > -1;
    }).sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (typeof x === 'string' || typeof y === 'string') {
        x = String(x || ''); y = String(y || '');
        return x.localeCompare(y) * sortDir;
      }
      return ((Number(x) || 0) - (Number(y) || 0)) * sortDir;
    });
  }

  function renderDb() {
    var rows = visibleRows();
    dbEmpty.hidden = rows.length > 0;
    dbEmpty.textContent = rowsCache.length
      ? 'No rows match this search or filter.'
      : 'No numbers yet. Check one above and it will appear here.';

    dbBody.innerHTML = rows.map(function (r) {
      return '<tr data-number="' + esc(r.number) + '"' + (r.flagged ? ' class="is-flagged"' : '') + '>' +
        '<td class="mono">' + esc(pretty(r.number)) + '</td>' +
        '<td>' + (r.reported
          ? '<span class="badge premium_rate">Reported</span>'
          : '<span class="badge landline">Not found</span>') + '</td>' +
        '<td class="mono">' + esc(String(r.complaints || 0)) + '</td>' +
        '<td class="mono">' + esc(r.lastComplaintDate || '—') + '</td>' +
        '<td>' + esc(r.lastSubject || '—') + '</td>' +
        '<td class="mono">' + esc(fmtDate(r.checkedAt)) + '</td>' +
        '<td><input class="db-note" type="text" value="' + esc(r.note || '') +
             '" placeholder="Add a note" aria-label="Note for ' + esc(r.number) + '"></td>' +
        '<td class="db-actions">' +
          '<button type="button" class="icon-mini" data-act="flag" title="Flag this number" aria-label="Flag ' + esc(r.number) + '">' +
            (r.flagged ? '★' : '☆') + '</button>' +
          '<button type="button" class="icon-mini" data-act="recheck" title="Check again" aria-label="Re-check ' + esc(r.number) + '">⟳</button>' +
          '<button type="button" class="icon-mini danger" data-act="delete" title="Remove from database" aria-label="Delete ' + esc(r.number) + '">✕</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    $('#dbTotal').textContent = String(rowsCache.length);
    $('#dbReported').textContent = String(rowsCache.filter(function (r) { return r.reported; }).length);
    $('#dbFlagged').textContent = String(rowsCache.filter(function (r) { return r.flagged; }).length);
    $('#dbBackend').textContent = DB.backend;
  }

  function refreshDb() {
    return DB.all().then(function (rows) {
      rowsCache = rows || [];
      renderDb();
    });
  }

  dbSearch.addEventListener('input', renderDb);
  dbFilter.addEventListener('change', renderDb);

  function sortBy(th) {
    var key = th.getAttribute('data-sort');
    if (sortKey === key) sortDir = -sortDir;
    else { sortKey = key; sortDir = (key === 'number' || key === 'lastSubject') ? 1 : -1; }
    $$('.db-table th[data-sort]').forEach(function (o) {
      o.removeAttribute('data-dir');
      o.removeAttribute('aria-sort');
    });
    th.setAttribute('data-dir', sortDir === 1 ? 'asc' : 'desc');
    th.setAttribute('aria-sort', sortDir === 1 ? 'ascending' : 'descending');
    renderDb();
  }

  $$('.db-table th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () { sortBy(th); });
    // The headers are focusable, so they have to answer the keyboard too.
    th.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        sortBy(th);
      }
    });
  });

  dbBody.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var number = btn.closest('tr').getAttribute('data-number');
    var act = btn.getAttribute('data-act');

    if (act === 'delete') {
      DB.remove(number).then(refreshDb).then(function () { toast('Removed ' + pretty(number)); });
    } else if (act === 'flag') {
      DB.get(number).then(function (row) {
        if (!row) return;
        row.flagged = !row.flagged;
        return DB.put(row).then(refreshDb);
      });
    } else if (act === 'recheck') {
      if (busy) return;
      setBusy(true, 'Checking');
      runCheck(number)
        .then(function (r) { renderDnc(r); return refreshDb(); })
        .catch(function (err) {
          renderNotice('error', 'Lookup failed', (err && err.message) || 'Something went wrong.');
        })
        .then(function () { setBusy(false, 'Check number'); });
    }
  });

  // Notes save on blur so a half-typed note is not written on every keystroke.
  dbBody.addEventListener('change', function (e) {
    if (!e.target.classList.contains('db-note')) return;
    var number = e.target.closest('tr').getAttribute('data-number');
    var note = e.target.value;
    DB.get(number).then(function (row) {
      if (!row) return;
      row.note = note;
      return DB.put(row).then(refreshDb);
    });
  });

  // ---------------------------------------------------------
  // Export / import / clear
  // ---------------------------------------------------------
  function download(filename, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  $('#dbExportCsv').addEventListener('click', function () {
    if (!rowsCache.length) { toast('Database is empty'); return; }
    var cols = ['number', 'reported', 'complaints', 'scanned', 'lastComplaintDate', 'lastSubject', 'scope', 'note', 'flagged', 'checkedAt'];
    var lines = [cols.join(',')].concat(visibleRows().map(function (r) {
      return cols.map(function (c) {
        return csvCell(c === 'checkedAt' ? fmtDate(r[c]) : r[c]);
      }).join(',');
    }));
    download('dnc-database.csv', lines.join('\n'), 'text/csv');
  });

  $('#dbExportJson').addEventListener('click', function () {
    if (!rowsCache.length) { toast('Database is empty'); return; }
    download('dnc-database.json', JSON.stringify(visibleRows(), null, 2), 'application/json');
  });

  $('#dbImport').addEventListener('click', function () { $('#dbFile').click(); });

  $('#dbFile').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); }
      catch (err) { toast('That file is not valid JSON'); return; }
      DB.importRows(Array.isArray(parsed) ? parsed : parsed && parsed.rows)
        .then(function (n) { toast('Imported ' + n + ' number' + (n === 1 ? '' : 's')); return refreshDb(); })
        .catch(function (err) { toast(err.message || 'Import failed'); });
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  $('#dbClear').addEventListener('click', function () {
    if (!rowsCache.length) { toast('Database is already empty'); return; }
    if (!window.confirm('Delete all ' + rowsCache.length + ' saved numbers? This cannot be undone.')) return;
    DB.clear().then(refreshDb).then(function () { toast('Database cleared'); });
  });

  // ---------------------------------------------------------
  // Boot
  // ---------------------------------------------------------
  NV.initTheme();
  NV.initKeyDialog();
  refreshDb();

  var qp = new URLSearchParams(location.search);
  if (qp.get('number')) {
    numberInput.value = qp.get('number');
    clearBtn.hidden = false;
    submit();
  }
})();
