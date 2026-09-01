/* ============================================================
   DNC database — a local store of every number you have checked.

   This site has no backend, so "database" here means a real database
   in the visitor's own browser: IndexedDB, with a localStorage
   fallback for private windows and older browsers. Records never
   leave the machine, are not shared between browsers or devices, and
   survive reloads until they are deleted or the site's data is
   cleared. Export/import is how a list moves anywhere else.

   Record shape (keyed by the 10-digit number):
     { number, reported, complaints, scanned, scope, lastSubject,
       lastComplaintDate, checkedAt, note, flagged }
   ============================================================ */
(function () {
  'use strict';

  var DB_NAME = 'nv-dnc';
  var DB_VERSION = 1;
  var STORE = 'numbers';
  var LS_FALLBACK = 'nv.dncdb';

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('no indexeddb'));
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { return reject(e); }

      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: 'number' });
          store.createIndex('checkedAt', 'checkedAt');
          store.createIndex('reported', 'reported');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexeddb open failed')); };
      // Safari private mode can leave the request hanging rather than erroring.
      setTimeout(function () { reject(new Error('indexeddb open timed out')); }, 3000);
    }).catch(function (err) {
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  }

  // ---- localStorage fallback -------------------------------------------
  function lsAll() {
    try { return JSON.parse(localStorage.getItem(LS_FALLBACK) || '[]') || []; }
    catch (e) { return []; }
  }
  function lsWrite(rows) {
    try { localStorage.setItem(LS_FALLBACK, JSON.stringify(rows)); return true; }
    catch (e) { return false; }
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        t.oncomplete = function () {
          // Unwrap the IDBRequest by its shape, not by whether `result` is set:
          // a miss has result === undefined, and returning the request itself
          // there would hand callers a truthy object for a row that is absent.
          var isRequest = out && typeof out === 'object' && 'result' in out;
          resolve(isRequest ? out.result : out);
        };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  var api = {
    /* Whichever backend actually answered, so the page can say so. */
    backend: 'unknown',

    all: function () {
      return tx('readonly', function (store) { return store.getAll(); })
        .then(function (rows) {
          api.backend = 'IndexedDB';
          return rows || [];
        })
        .catch(function () {
          api.backend = 'localStorage';
          return lsAll();
        });
    },

    put: function (record) {
      record.checkedAt = record.checkedAt || Date.now();
      return tx('readwrite', function (store) { return store.put(record); })
        .then(function () { api.backend = 'IndexedDB'; return record; })
        .catch(function () {
          api.backend = 'localStorage';
          var rows = lsAll().filter(function (r) { return r.number !== record.number; });
          rows.unshift(record);
          lsWrite(rows);
          return record;
        });
    },

    /* Merge into an existing row so a re-check keeps the note and flag. */
    upsert: function (record) {
      return api.get(record.number).then(function (existing) {
        if (existing) {
          if (record.note === undefined) record.note = existing.note;
          if (record.flagged === undefined) record.flagged = existing.flagged;
          record.firstCheckedAt = existing.firstCheckedAt || existing.checkedAt;
        } else {
          record.firstCheckedAt = Date.now();
        }
        return api.put(record);
      });
    },

    get: function (number) {
      return tx('readonly', function (store) { return store.get(number); })
        .catch(function () {
          return lsAll().filter(function (r) { return r.number === number; })[0] || undefined;
        });
    },

    remove: function (number) {
      return tx('readwrite', function (store) { return store.delete(number); })
        .catch(function () { return lsWrite(lsAll().filter(function (r) { return r.number !== number; })); });
    },

    clear: function () {
      return tx('readwrite', function (store) { return store.clear(); })
        .catch(function () { return lsWrite([]); })
        .then(function () { lsWrite([]); });
    },

    /* Import merges by number: an incoming row replaces a stored one.
       Returns how many rows were written. */
    importRows: function (rows) {
      if (!Array.isArray(rows)) return Promise.reject(new Error('Import file is not a list of records.'));
      var clean = rows
        .map(function (r) {
          var digits = String(r && r.number || '').replace(/\D/g, '');
          if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
          if (digits.length !== 10) return null;
          return {
            number: digits,
            reported: !!r.reported,
            complaints: Number(r.complaints) || 0,
            scanned: Number(r.scanned) || 0,
            scope: String(r.scope || ''),
            lastSubject: String(r.lastSubject || ''),
            lastComplaintDate: String(r.lastComplaintDate || ''),
            note: String(r.note || ''),
            flagged: !!r.flagged,
            checkedAt: Number(r.checkedAt) || Date.now(),
            firstCheckedAt: Number(r.firstCheckedAt) || Number(r.checkedAt) || Date.now()
          };
        })
        .filter(Boolean);
      if (!clean.length) return Promise.reject(new Error('No valid 10-digit US numbers found in that file.'));
      return clean.reduce(function (chain, row) {
        return chain.then(function () { return api.put(row); });
      }, Promise.resolve()).then(function () { return clean.length; });
    }
  };

  window.NV_DNCDB = api;
})();
