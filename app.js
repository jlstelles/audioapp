'use strict';

/* ---------- utilidades ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem espaço ou bloqueado */ } }
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2));

const FONT_SIZES = [18, 21, 24, 28, 33, 40];
const THEME_COLORS = { verde: '#070b08', laranja: '#0b0907', escuro: '#0e1116', claro: '#ffffff', contraste: '#000000' };

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5l11 7L4 19z"/></svg>',
  radio: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M3.2 6.9 19.6 1l.7 1.9-9.4 3.4H20a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.8c0-.8.5-1.5 1.2-1.9zM8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 1h-3v2h3zm0 3h-3v2h3z"/></svg>',
  note: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 3v10.6A4 4 0 1 0 14 17V7h5V3z"/></svg>'
};

/* ---------- estado ---------- */
const state = {
  stations: store.get('sc.stations', []),
  settings: Object.assign(
    { fs: 2, theme: 'verde', themeV: 0, bold: true, volume: 1, shuffle: false, repeat: 'all', tab: 'radios' },
    store.get('sc.settings', {})
  ),
  previewStation: null, // rádio em prévia (vinda da busca, ainda não salva)
  tracks: [],         // [{id, name, size}]
  now: null,          // {type:'radio'|'mp3', id}
  editingId: null,
  retries: 0,
  sleepMin: 0,
  sleepTimer: null,
  objectUrl: null
};

const saveSettings = () => store.set('sc.settings', state.settings);
const saveStations = () => store.set('sc.stations', state.stations);

const audio = $('#audio');

/* ---------- banco local (IndexedDB) para MP3 ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB indisponível'));
      const r = indexedDB.open('somclaro', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('blobs', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; resolve(); };
      r.onerror = () => reject(r.error);
    });
  },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  addTrack(file) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(['meta', 'blobs'], 'readwrite');
      const m = t.objectStore('meta').add({ name: file.name, size: file.size, added: Date.now() });
      m.onsuccess = () => { t.objectStore('blobs').put({ id: m.result, blob: file }); };
      t.oncomplete = () => resolve(m.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('abortado'));
    });
  },
  listMeta() { return this.req(this.db.transaction('meta').objectStore('meta').getAll()); },
  async getBlob(id) {
    const rec = await this.req(this.db.transaction('blobs').objectStore('blobs').get(id));
    return rec ? rec.blob : null;
  },
  deleteTrack(id) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(['meta', 'blobs'], 'readwrite');
      t.objectStore('meta').delete(id);
      t.objectStore('blobs').delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  clearAll() {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(['meta', 'blobs'], 'readwrite');
      t.objectStore('meta').clear();
      t.objectStore('blobs').clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
};

/* ---------- avisos e confirmação ---------- */
let toastTimer = null;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function ask(message, yesLabel = 'Confirmar') {
  return new Promise(resolve => {
    const dlg = $('#askDialog');
    $('#askMsg').textContent = message;
    $('#askYes').textContent = yesLabel;
    const done = v => { dlg.close(); cleanup(); resolve(v); };
    const yes = () => done(true);
    const no = () => done(false);
    const cleanup = () => {
      $('#askYes').removeEventListener('click', yes);
      $('#askNo').removeEventListener('click', no);
      dlg.removeEventListener('cancel', no);
    };
    $('#askYes').addEventListener('click', yes);
    $('#askNo').addEventListener('click', no);
    dlg.addEventListener('cancel', no);
    dlg.showModal();
  });
}

/* ---------- aparência ---------- */
function applyAppearance() {
  const s = state.settings;
  s.fs = Math.min(FONT_SIZES.length - 1, Math.max(0, s.fs));
  const root = document.documentElement;
  root.style.setProperty('--fs', FONT_SIZES[s.fs] + 'px');
  root.dataset.theme = s.theme;
  root.dataset.bold = s.bold ? '1' : '0';
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[s.theme] || '#0e1116';

  $$('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeSet === s.theme)));
  const bt = $('#boldToggle');
  bt.setAttribute('aria-pressed', String(s.bold));
  bt.textContent = 'Letras em negrito: ' + (s.bold ? 'sim' : 'não');
  $('#fsDown').disabled = $('#fsDown2').disabled = s.fs === 0;
  $('#fsUp').disabled = $('#fsUp2').disabled = s.fs === FONT_SIZES.length - 1;
  saveSettings();
}

function changeFont(delta) {
  state.settings.fs += delta;
  applyAppearance();
}

/* ---------- abas ---------- */
function showTab(name) {
  state.settings.tab = name;
  $$('[role="tab"]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('main > section').forEach(sec => { sec.hidden = sec.id !== 'tab-' + name; });
  $('#main').scrollTop = 0;
  if (name === 'ajustes') updateStorageInfo();
  saveSettings();
}

/* ---------- renderização ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sortedStations() {
  return state.stations.slice().sort((a, b) =>
    (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || a.name.localeCompare(b.name, 'pt', { sensitivity: 'base' }));
}

function renderStations() {
  const ul = $('#stationList');
  const list = sortedStations();
  if (!list.length) {
    ul.innerHTML = '<li class="empty">Nenhuma rádio cadastrada ainda.<br>Toque em “Buscar rádios na internet” para encontrar e adicionar, ou em “+ Adicionar pelo link”.</li>';
    return;
  }
  ul.innerHTML = list.map(s => {
    const playing = state.now && state.now.type === 'radio' && state.now.id === s.id;
    return `<li class="item${playing ? ' playing' : ''}" data-id="${esc(s.id)}">
      <button type="button" class="main-btn" data-act="play" aria-label="Tocar ${esc(s.name)}">
        ${ICON.radio}<span class="txt"><span class="name">${esc(s.name)}</span>${playing ? '<span class="badge">TOCANDO</span>' : ''}</span>
      </button>
      <div class="acts">
        <button type="button" data-act="fav" aria-pressed="${!!s.fav}">${s.fav ? '★ Favorita' : '☆ Favoritar'}</button>
        <button type="button" data-act="edit">Editar</button>
        <button type="button" class="del" data-act="del">Excluir</button>
      </div>
    </li>`;
  }).join('');
}

function prettyName(fileName) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || fileName;
}

function filteredTracks() {
  const q = $('#trackFilter').value.trim().toLowerCase();
  const all = state.tracks.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt', { numeric: true, sensitivity: 'base' }));
  return q ? all.filter(t => prettyName(t.name).toLowerCase().includes(q)) : all;
}

function renderTracks() {
  const ul = $('#trackList');
  const list = filteredTracks();
  const total = state.tracks.length;
  $('#clearTracks').hidden = total === 0;
  $('#trackCount').textContent = total
    ? (list.length === total ? `${total} música${total > 1 ? 's' : ''}` : `${list.length} de ${total} músicas`)
    : '';
  if (!total) {
    ul.innerHTML = '<li class="empty">Nenhuma música ainda.<br>Toque em “+ Adicionar músicas” e escolha arquivos MP3 do aparelho. Eles ficam guardados aqui dentro do app.</li>';
    return;
  }
  if (!list.length) {
    ul.innerHTML = '<li class="empty">Nenhuma música com esse nome.</li>';
    return;
  }
  ul.innerHTML = list.map(t => {
    const playing = state.now && state.now.type === 'mp3' && state.now.id === t.id;
    return `<li class="item${playing ? ' playing' : ''}" data-id="${t.id}">
      <button type="button" class="main-btn" data-act="play" aria-label="Tocar ${esc(prettyName(t.name))}">
        ${ICON.note}<span class="txt"><span class="name">${esc(prettyName(t.name))}</span>${playing ? '<span class="badge">TOCANDO</span>' : ''}</span>
      </button>
      <div class="acts">
        <button type="button" class="del" data-act="del">Remover</button>
      </div>
    </li>`;
  }).join('');
}

/* ---------- player ---------- */
function fmt(t) {
  if (!isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function setStatus(msg) { $('#nowSub').textContent = msg; }

function currentStation() {
  if (!state.now || state.now.type !== 'radio') return null;
  return state.stations.find(s => s.id === state.now.id) ||
    (state.previewStation && state.previewStation.id === state.now.id ? state.previewStation : null);
}
function currentTrack() {
  return state.now && state.now.type === 'mp3' ? state.tracks.find(t => t.id === state.now.id) : null;
}

function updatePlayerUI() {
  const st = currentStation(), tr = currentTrack();
  const isMp3 = !!tr;
  $('#nowTitle').textContent = st ? st.name : tr ? prettyName(tr.name) : 'Nada tocando';
  $('#seekBox').hidden = !isMp3;
  $('#shuffleBtn').hidden = !isMp3;
  $('#repeatBtn').hidden = !isMp3;
  const playing = !audio.paused && !audio.ended && !!state.now;
  $('#playBtn').innerHTML = playing ? ICON.pause : ICON.play;
  $('#playBtn').setAttribute('aria-label', playing ? 'Pausar' : 'Tocar');
  $('#prevBtn').innerHTML = ICON.prev;
  $('#nextBtn').innerHTML = ICON.next;
  $('#prevBtn').setAttribute('aria-label', st ? 'Rádio anterior' : 'Música anterior');
  $('#nextBtn').setAttribute('aria-label', st ? 'Próxima rádio' : 'Próxima música');
  const sh = $('#shuffleBtn');
  sh.setAttribute('aria-pressed', String(state.settings.shuffle));
  sh.textContent = 'Aleatório';
  $('#repeatBtn').textContent = { off: 'Sem repetir', all: 'Repetir todas', one: 'Repetir esta' }[state.settings.repeat];
  $('#sleepBtn').textContent = state.sleepMin ? 'Timer ' + state.sleepMin + ' min' : 'Timer: não';
  document.title = (st || tr) && playing ? (st ? st.name : prettyName(tr.name)) + ' — AudioApp' : 'AudioApp';
  renderStations();
  renderTracks();
}

function releaseObjectUrl() {
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
}

function setMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const st = currentStation(), tr = currentTrack();
  if (!st && !tr) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: st ? st.name : prettyName(tr.name),
      artist: st ? 'Rádio ao vivo' : 'Minhas músicas',
      album: 'AudioApp',
      artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }]
    });
  } catch { /* navegador sem suporte completo */ }
}

function handlePlayFailure(err) {
  if (err && err.name === 'AbortError') return; // troca de faixa: normal
  const st = currentStation();
  if (st && location.protocol === 'https:' && /^http:\/\//i.test(st.url)) {
    setStatus('Este link usa http e o app está em https; o navegador bloqueia. Procure o link https da rádio.');
  } else if (err && err.name === 'NotAllowedError') {
    setStatus('O navegador pediu um toque para liberar o som. Toque em Tocar.');
  } else {
    setStatus('Não consegui tocar. Confira o link ou a internet.');
  }
  updatePlayerUI();
}

function startPlayback() {
  const p = audio.play();
  if (p && p.catch) p.catch(handlePlayFailure);
}

function playRadio(id) {
  const st = state.stations.find(s => s.id === id);
  if (!st) return;
  startRadio(st);
}

function playPreview(st) {
  state.previewStation = { id: 'preview:' + st.uuid, name: st.name, url: st.url };
  startRadio(state.previewStation);
}

function startRadio(st) {
  const id = st.id;
  state.now = { type: 'radio', id };
  state.retries = 0;
  releaseObjectUrl();
  audio.src = st.url;
  setStatus('Conectando…');
  setMediaSession();
  updatePlayerUI();
  startPlayback();
}

async function playTrack(id) {
  const tr = state.tracks.find(t => t.id === id);
  if (!tr) return;
  let blob;
  try { blob = await DB.getBlob(id); } catch { blob = null; }
  if (!blob) { toast('Não encontrei este arquivo no aparelho.'); return; }
  state.now = { type: 'mp3', id };
  releaseObjectUrl();
  state.objectUrl = URL.createObjectURL(blob);
  audio.src = state.objectUrl;
  setStatus('Tocando música');
  setMediaSession();
  updatePlayerUI();
  startPlayback();
}

function togglePlay() {
  if (!state.now) {
    // nada selecionado: tenta a última rádio ou a primeira da lista
    const last = store.get('sc.last', null);
    if (last && last.type === 'radio' && state.stations.some(s => s.id === last.id)) return playRadio(last.id);
    if (last && last.type === 'mp3' && state.tracks.some(t => t.id === last.id)) return playTrack(last.id);
    const first = sortedStations()[0];
    if (first) return playRadio(first.id);
    const tr = filteredTracks()[0];
    if (tr) return playTrack(tr.id);
    toast('Adicione uma rádio ou música primeiro.');
    return;
  }
  if (audio.paused || audio.ended) {
    if (state.now.type === 'radio' && (audio.ended || audio.error || !audio.src)) {
      playRadio(state.now.id);   // ao vivo: reconecta do ponto atual
    } else {
      startPlayback();
    }
  } else {
    audio.pause();
  }
}

function step(dir) {
  if (!state.now) return;
  if (state.now.type === 'radio') {
    const list = sortedStations();
    if (!list.length) return;
    let i = list.findIndex(s => s.id === state.now.id);
    i = (i + dir + list.length) % list.length;
    playRadio(list[i].id);
    return;
  }
  const list = filteredTracks();
  if (!list.length) return;
  if (dir < 0 && audio.currentTime > 5) { audio.currentTime = 0; return; }
  let i = list.findIndex(t => t.id === state.now.id);
  if (state.settings.shuffle && list.length > 1 && dir > 0) {
    let j;
    do { j = Math.floor(Math.random() * list.length); } while (j === i);
    i = j;
  } else {
    i += dir;
    if (i >= list.length) i = 0;
    if (i < 0) i = list.length - 1;
  }
  playTrack(list[i].id);
}

audio.addEventListener('play', () => { if (state.now) store.set('sc.last', state.now); updatePlayerUI(); });
audio.addEventListener('pause', updatePlayerUI);
audio.addEventListener('playing', () => {
  state.retries = 0;
  setStatus(state.now && state.now.type === 'radio' ? 'AO VIVO' : 'Tocando música');
  updatePlayerUI();
});
audio.addEventListener('waiting', () => { if (state.now) setStatus('Carregando…'); });
audio.addEventListener('stalled', () => { if (state.now && state.now.type === 'radio' && !audio.paused) setStatus('Sinal fraco…'); });

audio.addEventListener('error', () => {
  if (!state.now || !audio.src) return;
  if (state.now.type === 'radio' && state.retries < 3) {
    state.retries++;
    setStatus(`Reconectando (${state.retries}/3)…`);
    const id = state.now.id;
    setTimeout(() => {
      if (state.now && state.now.type === 'radio' && state.now.id === id) {
        const st = currentStation();
        if (st) { audio.src = st.url; startPlayback(); }
      }
    }, 2500);
  } else {
    handlePlayFailure(audio.error);
  }
});

audio.addEventListener('ended', () => {
  if (!state.now) return;
  if (state.now.type === 'radio') {
    // transmissão ao vivo não deveria terminar: reconecta
    if (state.retries < 3) { state.retries++; const st = currentStation(); if (st) { audio.src = st.url; startPlayback(); } }
    return;
  }
  const r = state.settings.repeat;
  if (r === 'one') { audio.currentTime = 0; startPlayback(); return; }
  const list = filteredTracks();
  const i = list.findIndex(t => t.id === state.now.id);
  if (r === 'off' && !state.settings.shuffle && i === list.length - 1) { updatePlayerUI(); return; }
  step(1);
});

audio.addEventListener('timeupdate', () => {
  if (!state.now || state.now.type !== 'mp3') return;
  const seek = $('#seek');
  if (document.activeElement !== seek) seek.value = audio.currentTime;
  $('#curTime').textContent = fmt(audio.currentTime);
});
audio.addEventListener('loadedmetadata', () => {
  if (!state.now || state.now.type !== 'mp3') return;
  $('#seek').max = Math.floor(audio.duration) || 0;
  $('#durTime').textContent = fmt(audio.duration);
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && isFinite(audio.duration)) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: 0, playbackRate: 1 }); } catch { /* ignora */ }
  }
});

$('#seek').addEventListener('input', e => {
  audio.currentTime = Number(e.target.value);
  $('#curTime').textContent = fmt(audio.currentTime);
});

function seekBy(sec) {
  if (state.now && state.now.type === 'mp3' && isFinite(audio.duration)) {
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + sec));
  }
}

if ('mediaSession' in navigator) {
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* ação sem suporte */ } };
  set('play', () => { if (state.now) startPlayback(); else togglePlay(); });
  set('pause', () => audio.pause());
  set('previoustrack', () => step(-1));
  set('nexttrack', () => step(1));
  set('seekbackward', () => seekBy(-10));
  set('seekforward', () => seekBy(10));
}

/* ---------- botões do player ---------- */
$('#playBtn').addEventListener('click', togglePlay);
$('#prevBtn').addEventListener('click', () => step(-1));
$('#nextBtn').addEventListener('click', () => step(1));

$('#shuffleBtn').addEventListener('click', () => {
  state.settings.shuffle = !state.settings.shuffle;
  saveSettings(); updatePlayerUI();
});
$('#repeatBtn').addEventListener('click', () => {
  const order = ['all', 'one', 'off'];
  state.settings.repeat = order[(order.indexOf(state.settings.repeat) + 1) % order.length];
  saveSettings(); updatePlayerUI();
});

/* timer para dormir: o app pausa sozinho */
$('#sleepBtn').addEventListener('click', () => {
  const opts = [0, 15, 30, 60, 90];
  state.sleepMin = opts[(opts.indexOf(state.sleepMin) + 1) % opts.length];
  clearTimeout(state.sleepTimer);
  if (state.sleepMin) {
    state.sleepTimer = setTimeout(() => {
      audio.pause();
      state.sleepMin = 0;
      updatePlayerUI();
      toast('Timer encerrado: áudio pausado.');
    }, state.sleepMin * 60000);
    toast(`O áudio vai pausar em ${state.sleepMin} minutos.`);
  }
  updatePlayerUI();
});

/* ---------- rádios: lista e formulário ---------- */
$('#stationList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const st = state.stations.find(s => s.id === id);
  if (!st) return;
  switch (btn.dataset.act) {
    case 'play':
      if (state.now && state.now.type === 'radio' && state.now.id === id && !audio.paused) audio.pause();
      else playRadio(id);
      break;
    case 'fav':
      st.fav = !st.fav; saveStations(); renderStations(); break;
    case 'edit':
      openStationDialog(st); break;
    case 'del':
      if (await ask(`Excluir a rádio “${st.name}”?`, 'Excluir')) {
        if (state.now && state.now.type === 'radio' && state.now.id === id) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.now = null; }
        state.stations = state.stations.filter(s => s.id !== id);
        saveStations(); updatePlayerUI();
      }
      break;
  }
});

const stDlg = $('#stationDialog');
function updateStationWarning() {
  const url = $('#stUrl').value.trim();
  const w = $('#stWarn');
  if (location.protocol === 'https:' && /^http:\/\//i.test(url)) {
    w.textContent = 'Atenção: link http não toca quando o app é aberto em https. Se a rádio não tocar, procure o link https dela.';
    w.hidden = false;
  } else { w.hidden = true; }
}
function openStationDialog(st) {
  state.editingId = st ? st.id : null;
  $('#stationDialogTitle').textContent = st ? 'Editar rádio' : 'Adicionar rádio';
  $('#stName').value = st ? st.name : '';
  $('#stUrl').value = st ? st.url : '';
  updateStationWarning();
  stDlg.showModal();
  $('#stName').focus();
}
$('#addStation').addEventListener('click', () => openStationDialog(null));
$('#stCancel').addEventListener('click', () => stDlg.close());
$('#stUrl').addEventListener('input', updateStationWarning);
$('#stationForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#stName').value.trim();
  let url = $('#stUrl').value.trim();
  if (!name) { toast('Digite o nome da rádio.'); $('#stName').focus(); return; }
  if (!/^https?:\/\/\S+$/i.test(url)) { toast('O link precisa começar com https:// ou http://'); $('#stUrl').focus(); return; }
  if (state.editingId) {
    const st = state.stations.find(s => s.id === state.editingId);
    if (st) {
      const changed = st.url !== url;
      st.name = name; st.url = url;
      if (changed && state.now && state.now.type === 'radio' && state.now.id === st.id) playRadio(st.id);
    }
  } else {
    state.stations.push({ id: uid(), name, url, fav: false });
  }
  saveStations();
  stDlg.close();
  updatePlayerUI();
});


/* ---------- busca de rádios na internet (diretório público Radio Browser) ---------- */
// Servidores do diretório. Tenta em ordem e lembra o primeiro que responder.
const RB_HOSTS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info', 'nl1.api.radio-browser.info', 'all.api.radio-browser.info'];

async function rbFetch(path) {
  const saved = store.get('sc.rbhost', null);
  const hosts = saved ? [saved].concat(RB_HOSTS.filter(h => h !== saved)) : RB_HOSTS;
  let lastErr = new Error('sem servidor');
  for (const h of hosts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch('https://' + h + path, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      store.set('sc.rbhost', h);
      return data;
    } catch (e) { clearTimeout(timer); lastErr = e; }
  }
  throw lastErr;
}

const search = { tag: '', results: [] };
const sDlg = $('#searchDialog');

function openSearch() {
  sDlg.showModal();
  if (!search.results.length && !$('#sResults').children.length) runSearch();
  $('#sQuery').focus();
}

function normalizeStation(r) {
  const url = String(r.url_resolved || r.url || '').trim();
  const name = String(r.name || '').replace(/\s+/g, ' ').trim();
  if (!name || !/^https?:\/\/\S+$/i.test(url)) return null;
  return {
    uuid: String(r.stationuuid || url),
    name: name.slice(0, 120),
    url,
    meta: [r.countrycode, [r.codec, r.bitrate ? r.bitrate + ' kbps' : ''].filter(Boolean).join(' '), String(r.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 3).join(', ')]
      .filter(Boolean).join(' · ')
  };
}

async function runSearch() {
  const q = $('#sQuery').value.trim();
  const params = new URLSearchParams({ hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: '100' });
  if (q) params.set('name', q);
  if (search.tag) params.set('tag', search.tag);
  const cc = $('#sCountry').value;
  if (cc) params.set('countrycode', cc);
  const onlyHttps = $('#sHttps').checked;
  const status = $('#sStatus');
  status.textContent = 'Buscando…';
  $('#sGo').disabled = true;
  try {
    const raw = await rbFetch('/json/stations/search?' + params.toString());
    const seen = new Set();
    const list = [];
    for (const r of Array.isArray(raw) ? raw : []) {
      const s = normalizeStation(r);
      if (!s || seen.has(s.url)) continue;
      if (onlyHttps && location.protocol === 'https:' && !/^https:/i.test(s.url)) continue;
      seen.add(s.url);
      list.push(s);
      if (list.length >= 40) break;
    }
    search.results = list;
    status.textContent = list.length
      ? `${list.length} rádio${list.length > 1 ? 's' : ''} encontrada${list.length > 1 ? 's' : ''}, da mais ouvida para a menos.`
      : 'Nenhuma rádio encontrada. Tente outro nome, outro país ou desmarque “só https”.';
    renderSearchResults();
  } catch (e) {
    search.results = [];
    $('#sResults').innerHTML = '';
    status.textContent = 'Não consegui acessar o diretório de rádios agora. Verifique a internet e tente de novo; ou adicione a rádio pelo link.';
  } finally {
    $('#sGo').disabled = false;
  }
}

function renderSearchResults() {
  const have = new Set(state.stations.map(s => s.url));
  $('#sResults').innerHTML = search.results.map((s, i) => {
    const added = have.has(s.url);
    return `<li class="item" data-i="${i}">
      <div class="pad"><span class="name">${esc(s.name)}</span><span class="meta">${esc(s.meta)}</span></div>
      <div class="acts">
        <button type="button" data-act="preview">▶ Ouvir</button>
        <button type="button" data-act="add" ${added ? 'disabled' : ''}>${added ? '✓ Já adicionada' : '+ Adicionar'}</button>
      </div>
    </li>`;
  }).join('');
}

$('#searchStations').addEventListener('click', openSearch);
$('#sClose').addEventListener('click', () => sDlg.close());
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch(); });
$('#sCountry').addEventListener('change', runSearch);
$('#sHttps').addEventListener('change', runSearch);
$('#sTags').addEventListener('click', e => {
  const b = e.target.closest('button[data-tag]');
  if (!b) return;
  const same = search.tag === b.dataset.tag;
  search.tag = same ? '' : b.dataset.tag;
  $$('#sTags button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.tag === search.tag)));
  runSearch();
});
$('#sResults').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  const s = search.results[Number(btn.closest('.item').dataset.i)];
  if (!s) return;
  if (btn.dataset.act === 'preview') {
    playPreview(s);
  } else if (btn.dataset.act === 'add') {
    if (!state.stations.some(x => x.url === s.url)) {
      const id = uid();
      state.stations.push({ id, name: s.name, url: s.url, fav: false });
      saveStations();
      // se esta rádio está tocando como prévia, passa a ser a rádio salva
      if (state.previewStation && state.now && state.now.id === state.previewStation.id && state.previewStation.url === s.url) {
        state.now = { type: 'radio', id };
        state.previewStation = null;
      }
      toast(`“${s.name}” adicionada às suas rádios.`);
      updatePlayerUI();
      renderSearchResults();
    }
  }
});

/* ---------- músicas ---------- */
$('#addFiles').addEventListener('click', () => $('#fileInput').click());
$('#addFolder').addEventListener('click', () => $('#folderInput').click());
$('#trackFilter').addEventListener('input', renderTracks);

async function importFiles(fileList) {
  const files = Array.from(fileList).filter(f =>
    f.type.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|opus|flac|wav)$/i.test(f.name));
  if (!files.length) { toast('Nenhum arquivo de áudio encontrado.'); return; }
  let ok = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    toast(`Guardando ${i + 1} de ${files.length}…`, 60000);
    try { await DB.addTrack(files[i]); ok++; } catch { fail++; if (fail >= 3) break; }
  }
  await loadTracks();
  toast(fail
    ? `${ok} guardada(s). ${fail} falhou(aram); o espaço do aparelho pode ter acabado.`
    : `${ok} música${ok > 1 ? 's' : ''} adicionada${ok > 1 ? 's' : ''}.`, 5000);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
$('#fileInput').addEventListener('change', async e => { await importFiles(e.target.files); e.target.value = ''; });
$('#folderInput').addEventListener('change', async e => { await importFiles(e.target.files); e.target.value = ''; });

async function loadTracks() {
  try { state.tracks = await DB.listMeta(); } catch { state.tracks = []; }
  renderTracks();
}

$('#trackList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.item').dataset.id);
  const tr = state.tracks.find(t => t.id === id);
  if (!tr) return;
  if (btn.dataset.act === 'play') {
    if (state.now && state.now.type === 'mp3' && state.now.id === id && !audio.paused) audio.pause();
    else if (state.now && state.now.type === 'mp3' && state.now.id === id) startPlayback();
    else playTrack(id);
  } else if (btn.dataset.act === 'del') {
    if (await ask(`Remover “${prettyName(tr.name)}” do app? (O arquivo original no aparelho não é apagado.)`, 'Remover')) {
      if (state.now && state.now.type === 'mp3' && state.now.id === id) { audio.pause(); audio.removeAttribute('src'); audio.load(); releaseObjectUrl(); state.now = null; }
      await DB.deleteTrack(id);
      await loadTracks();
      updatePlayerUI();
    }
  }
});

$('#clearTracks').addEventListener('click', async () => {
  if (await ask('Apagar todas as músicas guardadas no app? Os arquivos originais no aparelho não são apagados.', 'Apagar tudo')) {
    if (state.now && state.now.type === 'mp3') { audio.pause(); audio.removeAttribute('src'); audio.load(); releaseObjectUrl(); state.now = null; }
    await DB.clearAll();
    await loadTracks();
    updatePlayerUI();
  }
});

/* ---------- ajustes ---------- */
$('#fsDown').addEventListener('click', () => changeFont(-1));
$('#fsUp').addEventListener('click', () => changeFont(1));
$('#fsDown2').addEventListener('click', () => changeFont(-1));
$('#fsUp2').addEventListener('click', () => changeFont(1));
$('#boldToggle').addEventListener('click', () => { state.settings.bold = !state.settings.bold; applyAppearance(); });
$('#themeRow').addEventListener('click', e => {
  const b = e.target.closest('[data-theme-set]');
  if (!b) return;
  state.settings.theme = b.dataset.themeSet;
  applyAppearance();
});

function setVolume(v) {
  v = Math.min(1, Math.max(0, v));
  state.settings.volume = v;
  audio.volume = v;
  $('#volume').value = v;
  saveSettings();
}
$('#volume').addEventListener('input', e => setVolume(Number(e.target.value)));
$('#volDown').addEventListener('click', () => setVolume(state.settings.volume - 0.1));
$('#volUp').addEventListener('click', () => setVolume(state.settings.volume + 0.1));

$('#exportBtn').addEventListener('click', () => {
  const data = {
    app: 'audioapp', version: 1, exportedAt: new Date().toISOString(),
    stations: state.stations,
    settings: { fs: state.settings.fs, theme: state.settings.theme, bold: state.settings.bold, volume: state.settings.volume }
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'audioapp-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Backup salvo. Guarde o arquivo em local seguro.');
});
$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || (data.app !== 'audioapp' && data.app !== 'som-claro') || !Array.isArray(data.stations)) throw new Error('formato');
    const valid = data.stations.filter(s => s && typeof s.name === 'string' && /^https?:\/\/\S+$/i.test(String(s.url || '')));
    let added = 0;
    for (const s of valid) {
      const exists = state.stations.some(x => x.url === s.url);
      if (!exists) { state.stations.push({ id: uid(), name: s.name.trim().slice(0, 120), url: s.url, fav: !!s.fav }); added++; }
    }
    if (data.settings && typeof data.settings === 'object') {
      const d = data.settings;
      if (Number.isInteger(d.fs)) state.settings.fs = d.fs;
      if (d.theme in THEME_COLORS) state.settings.theme = d.theme;
      if (typeof d.bold === 'boolean') state.settings.bold = d.bold;
      if (typeof d.volume === 'number') setVolume(d.volume);
    }
    saveStations(); applyAppearance(); updatePlayerUI();
    toast(`Backup restaurado: ${added} rádio(s) nova(s).`);
  } catch {
    toast('Esse arquivo não parece ser um backup do AudioApp.');
  }
});

async function updateStorageInfo() {
  const el = $('#storageInfo');
  if (!(navigator.storage && navigator.storage.estimate)) { el.textContent = 'Não consigo medir o espaço neste navegador.'; return; }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const mb = n => (n / 1048576).toFixed(n > 1.07e9 ? 0 : 1);
    el.textContent = `Usado pelo app: ${mb(usage)} MB. Espaço estimado disponível ao app: ${mb(quota)} MB (varia conforme o aparelho).`;
  } catch { el.textContent = 'Não consegui medir o espaço agora.'; }
}

/* ---------- teclado (PC) ---------- */
document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space' && tag !== 'button') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') seekBy(10);
  else if (e.key === 'ArrowLeft') seekBy(-10);
  else if (e.key === 'n' || e.key === 'N') step(1);
  else if (e.key === 'p' || e.key === 'P') step(-1);
});

/* ---------- abas: clique ---------- */
$$('[role="tab"]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- inicialização ---------- */
async function init() {
  if (state.settings.themeV !== 2) { state.settings.theme = 'verde'; state.settings.themeV = 2; }  // novo visual padrão (uma vez)
  applyAppearance();
  setVolume(state.settings.volume);
  showTab(['radios', 'musicas', 'ajustes'].includes(state.settings.tab) ? state.settings.tab : 'radios');
  updatePlayerUI();
  try { await DB.open(); await loadTracks(); }
  catch { $('#addFiles').disabled = true; $('#addFolder').disabled = true; toast('Este navegador não permite guardar músicas aqui.'); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
