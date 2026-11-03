/* Marketlab tracker. First-party only. Does nothing until the visitor consents.
   Sends: experiment id, random visitor id (localStorage), event type, timestamp, source tag (?src=).
   mlAction also sends the small payload object the page passes in. No IP handling, no third parties. */
(function () {
  'use strict';
  var KEY_CONSENT = 'ml_consent';
  var KEY_VID = 'ml_vid';

  function meta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el ? el.getAttribute('content') : '';
  }
  var WORKER = meta('ml-worker-url');
  var EXP = meta('ml-experiment-id');

  function store(op, k, v) {
    try { return op === 'get' ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch (e) { return null; }
  }
  function consented() { return store('get', KEY_CONSENT) === 'granted'; }
  function configured() {
    return WORKER && WORKER.indexOf('MARKET_WORKER_URL') === -1 && EXP && EXP.indexOf('EXPERIMENT_ID') === -1;
  }
  function visitorId() {
    var v = store('get', KEY_VID);
    if (v) return v;
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    v = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    store('set', KEY_VID, v);
    return v;
  }
  function source() {
    var m = /[?&]src=([A-Za-z0-9_-]{1,32})/.exec(location.search);
    return m ? m[1] : '';
  }
  function post(path, body) {
    if (!consented() || !configured()) return;
    try {
      fetch(WORKER.replace(/\/+$/, '') + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }
  function base(type) {
    return { experiment_id: EXP, visitor_id: visitorId(), type: String(type), ts: new Date().toISOString(), src: source() };
  }

  window.mlTrack = function (type, payload) {
    // payload is accepted for API symmetry but not sent: events carry only the fields listed above.
    post('/e', base(type));
  };
  window.mlAction = function (payload) {
    var b = base('action');
    b.payload = payload && typeof payload === 'object' ? payload : {};
    post('/action', b);
  };

  function setBanner(visible) {
    var el = document.querySelector('[data-consent]');
    if (el) el.hidden = !visible;
  }
  document.addEventListener('DOMContentLoaded', function () {
    var c = store('get', KEY_CONSENT);
    setBanner(c !== 'granted' && c !== 'declined');
    var yes = document.querySelector('[data-consent-accept]');
    var no = document.querySelector('[data-consent-decline]');
    if (yes) yes.addEventListener('click', function () {
      store('set', KEY_CONSENT, 'granted'); setBanner(false); window.mlTrack('view');
    });
    if (no) no.addEventListener('click', function () {
      store('set', KEY_CONSENT, 'declined'); setBanner(false);
    });
    var cta = document.querySelector('[data-action]');
    if (cta) cta.addEventListener('click', function () { window.mlAction({ cta: cta.getAttribute('data-action') }); });
    if (consented()) window.mlTrack('view');
  });
})();
