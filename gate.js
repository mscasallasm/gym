(() => {
  'use strict';
  const IDLE_MS = 15 * 60e3;
  const $ = (id) => document.getElementById(id);
  const ls = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {  } },
    del: (k) => { try { localStorage.removeItem(k); } catch {  } },
  };
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  window.__gate = {
    getMode: () => (ls.get('gym.lockMode') === 'always' ? 'always' : 'idle'),
    setMode: (m) => ls.set('gym.lockMode', m === 'always' ? 'always' : 'idle'),
    relock: () => { ls.set('gym.locked', '1'); location.reload(); },
  };

  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('gym-llave', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('k');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function keyGet() {
    try {
      const d = await db();
      return await new Promise((res) => {
        const q = d.transaction('k').objectStore('k').get('llave');
        q.onsuccess = () => res(q.result || null);
        q.onerror = () => res(null);
      });
    } catch { return null; }
  }
  async function keyPut(k) {
    try {
      const d = await db();
      await new Promise((res) => {
        const t = d.transaction('k', 'readwrite');
        t.objectStore('k').put(k, 'llave');
        t.oncomplete = res; t.onerror = res; t.onabort = res;
      });
    } catch {  }
  }

  async function derive(pw, p) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64(p.salt), iterations: p.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  async function openPkg(key, p) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(p.iv) }, key, b64(p.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function run(bundle) {
    const files = bundle.files;
    const style = document.createElement('style');
    style.textContent = files['styles.css'] || '';
    document.head.appendChild(style);
    document.body.innerHTML = files['body.html'] || '';
    const urls = {};
    const load = (path) => {
      if (urls[path]) return urls[path];
      if (!(path in files)) throw new Error('Falta ' + path);
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
      const src = files[path].replace(/(\bfrom\s*)(['"])\.\/([\w./-]+\.js)\2/g, (m, pre, q, name) => pre + q + load(dir + name) + q);
      urls[path] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      return urls[path];
    };
    return import(load(bundle.entry || 'js/app.js'));
  }

  async function enter(bundle) {
    ls.del('gym.locked');
    ls.set('gym.lastActive', String(Date.now()));
    await run(bundle);
  }

  const fails = () => { try { return JSON.parse(ls.get('gym.fails')) || { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; } };
  const setFails = (f) => ls.set('gym.fails', JSON.stringify(f));
  const waitAfter = (n) => (n < 5 ? 0 : Math.min(30 * 60e3, 30e3 * 2 ** (n - 5)));
  const mmss = (ms) => { const t = Math.ceil(ms / 1000); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

  function msg(text, info = false) {
    const m = $('gMsg');
    if (!m) return;
    m.textContent = text;
    m.classList.toggle('info', info);
  }
  let timer = null;
  function paintWait() {
    const f = fails();
    const left = f.until - Date.now();
    const blocked = left > 0;
    $('gIn').disabled = blocked;
    $('gBtn').disabled = blocked;
    if (blocked) {
      msg(`Demasiados intentos. Espera ${mmss(left)}`);
      clearTimeout(timer);
      timer = setTimeout(paintWait, 500);
    } else if (/Espera/.test($('gMsg').textContent)) {
      msg('');
      $('gIn').focus();
    }
  }

  let pkg = null;
  let busy = false;

  function showForm(note) {
    $('gWait').hidden = true;
    $('gForm').hidden = false;
    $('gForgot').hidden = false;
    if (note) msg(note, true);
    paintWait();
    if (!$('gIn').disabled) setTimeout(() => $('gIn').focus(), 60);
  }
  function fatal(text) {
    if (!$('gWait')) { document.body.textContent = text; return; }
    $('gWait').hidden = false;
    $('gWait').textContent = text;
    $('gWait').classList.remove('info');
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    if (fails().until > Date.now()) return paintWait();
    const pw = $('gIn').value;
    if (!pw) return;
    busy = true;
    $('gBtn').disabled = true;
    msg('Abriendo…', true);
    let bundle = null, key = null;
    try {
      key = await derive(pw, pkg);
      bundle = await openPkg(key, pkg);
    } catch { bundle = null; }
    if (!bundle) {
      const f = fails();
      f.n += 1;
      f.until = Date.now() + waitAfter(f.n);
      setFails(f);
      busy = false;
      $('gIn').value = '';
      $('gBtn').disabled = false;
      const form = $('gForm');
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
      msg(f.n >= 3 ? `Clave incorrecta (${f.n} intentos)` : 'Clave incorrecta');
      paintWait();
      return;
    }
    setFails({ n: 0, until: 0 });
    await keyPut(key);
    try { await enter(bundle); } catch (err) { busy = false; fatal('No se pudo abrir la app: ' + err.message); }
  }

  async function start() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    $('gForm').addEventListener('submit', onSubmit);
    $('gForgot').addEventListener('click', () => { $('gHelp').hidden = !$('gHelp').hidden; });
    if (!(window.crypto && crypto.subtle)) return fatal('Abre la app desde su dirección https.');
    try {
      const r = await fetch('app.enc', { cache: 'no-cache' });
      if (!r.ok) throw new Error(String(r.status));
      pkg = await r.json();
    } catch {
      return fatal('No se pudo cargar la app. La primera vez hay que abrirla con internet.');
    }
    const locked = ls.get('gym.locked') === '1';
    const idle = Date.now() - Number(ls.get('gym.lastActive') || 0);
    if (!locked && window.__gate.getMode() === 'idle' && idle < IDLE_MS) {
      const key = await keyGet();
      let bundle = null;
      if (key) {
        try { bundle = await openPkg(key, pkg); } catch {  }
      }
      if (bundle) {
        try { return await enter(bundle); } catch (err) { return fatal('No se pudo abrir la app: ' + err.message); }
      }
    }
    showForm(locked ? 'La app se bloqueó. Escribe la clave.' : '');
  }

  start();
})();
