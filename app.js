/* 分隊小幫手 — 介面與狀態 */
(function () {
  'use strict';
  const L = window.TeamLogic;
  const STORE_KEY = 'team-splitter-v1';
  const $ = (id) => document.getElementById(id);

  // 加密保存的試算表連結:在「連結」欄輸入代碼(不分大小寫)就會解開並載入,連結不會出現在畫面或原始碼。
  // PBKDF2-SHA256(600000 次) + AES-GCM;內容為 salt(16) | iv(12) | 密文。
  const SHEET_VAULT = { iter: 600000, data: 'rYXtREassoW01yLmuyqVj7kXRWvOdMWxf8KehFDbc1Fb6s7VrMWUlLkMB5wFHO158iaWQMslJLfMZH4GyU+8iq9znCmjW+J/5JCrW7pk9hK6NxBZL014185zXHZ72cjPRMrUSidL/v0Q9nGf8g9Pg69aBo0uLwjZY7gas37JA7f0as/ZkjkE+Jv0R81usDLj' };

  /** 用代碼解開加密的連結;代碼錯誤回傳 null,環境不支援加密(非 https)丟出錯誤 */
  async function openVault(code) {
    if (!window.crypto || !crypto.subtle) throw new Error('這個連線無法解開代碼（需要 https 網址），請直接貼上試算表連結。');
    try {
      const raw = Uint8Array.from(atob(SHEET_VAULT.data), (c) => c.charCodeAt(0));
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code.trim().toUpperCase()), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: raw.slice(0, 16), iterations: SHEET_VAULT.iter, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(16, 28) }, key, raw.slice(28));
      return new TextDecoder().decode(plain);
    } catch (e) { return null; }
  }

  const DEMO_CSV = [
    '姓名,不同隊對象,綁定對象',
    '小明,小華,',
    '小華,,',
    '小美,,小強',
    '小強,,',
    '阿凱,小明,',
    '小雯,,阿宏',
    '阿宏,,',
    '小傑,小美,',
    '佩珊,,',
    '志豪,,',
    '雅婷,,',
    '冠宇,,',
  ].join('\n');

  const state = {
    model: null,        // { names, apart, bind, units }(分享模式為 null)
    names: [],
    assignment: [],
    teams: 0,
    url: '',
    view: 'list',
    adjust: false,
    selected: -1,
    open: new Set(),
    query: '',
    shared: false,
  };

  /* ---------- 小工具 ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(c => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c)); });
    return el;
  }
  const hue = (t) => Math.round((t * 137.508 + 252) % 360); // 黃金角,相鄰隊伍色相差距大

  let toastTimer;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast is-show' + (kind ? ' is-' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-show'), kind === 'warn' || kind === 'error' ? 4200 : 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = h('textarea', { style: 'position:fixed;opacity:0;left:-999px' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  /* ---------- 偏好(每台裝置各自記住,分享頁也適用) ---------- */
  const PREFS_KEY = 'team-splitter-prefs';
  const prefs = { gacha: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (e) { /* 忽略 */ }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 儲存 ---------- */
  function save() {
    if (state.shared) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        model: state.model, assignment: state.assignment, teams: state.teams, url: state.url,
      }));
    } catch (e) { /* 隱私模式下可能失敗,忽略 */ }
  }
  function loadSaved() {
    try {
      const o = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!o || !o.model || !Array.isArray(o.assignment) || o.assignment.length !== o.model.names.length) return false;
      state.model = o.model;
      state.names = o.model.names;
      state.assignment = o.assignment;
      state.teams = o.teams;
      state.url = o.url || '';
      return true;
    } catch (e) { return false; }
  }

  /* ---------- 違規 ---------- */
  function violations() {
    if (!state.model) return [];
    return L.checkViolations(state.model, state.assignment);
  }

  /* ---------- 繪製 ---------- */
  function updateToggleAll() {
    $('btn-toggle-all').textContent = state.open.size >= state.names.length ? '全部收合' : '全部展開';
  }

  /** 只切換卡片的開合狀態,不重建名單(避免整頁重繪、進場動畫重播) */
  function setCardOpen(i, open) {
    const card = $('view').querySelector(`.person[data-i="${i}"]`);
    if (!card) return;
    card.classList.toggle('is-open', open);
    card.querySelector('.person-head').setAttribute('aria-expanded', open);
  }

  /** opts.animate:新結果/切換分頁時才播放進場動畫 */
  function render(opts) {
    const animate = !!(opts && opts.animate);
    document.body.classList.toggle('is-share', state.shared);
    document.body.classList.toggle('no-data', !state.names.length);
    $('banner-share').hidden = !state.shared;

    const n = state.names.length;
    $('meta').textContent = n ? `${n} 人 · ${state.teams} 隊${state.shared ? ' · 唯讀' : ''}` : '尚未載入名單';

    document.querySelector('.tabs').dataset.view = state.view;
    document.body.dataset.view = state.view;
    document.querySelectorAll('.tab').forEach(t => {
      const on = t.dataset.view === state.view;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on);
    });
    $('btn-toggle-all').hidden = state.view !== 'list' || state.adjust;
    updateToggleAll();

    // 微調提示與違規清單
    const vs = state.adjust ? violations() : [];
    const banner = $('banner-adjust');
    banner.hidden = !state.adjust;
    if (state.adjust) {
      banner.replaceChildren();
      banner.append(state.selected >= 0
        ? h('span', {}, '已選 ', h('b', {}, state.names[state.selected]), '，再點另一個人即可互換隊伍')
        : '微調模式：依序點兩個人，互換他們的隊伍');
    }
    const vbox = $('violations');
    vbox.hidden = !(state.adjust && vs.length);
    if (!vbox.hidden) {
      vbox.replaceChildren(h('strong', {}, `⚠ 目前有 ${vs.length} 項條件未滿足（僅提醒，可繼續）`),
        h('ul', {}, vs.map(v => h('li', {}, L.describeViolation(state.model, v, state.assignment)))));
    }

    const bad = new Set();
    vs.forEach(v => { bad.add(v.a); bad.add(v.b); });

    const view = $('view');
    view.classList.toggle('adjusting', state.adjust);
    view.classList.toggle('is-entering', animate);
    view.replaceChildren();
    if (!n) {
      view.append(h('div', { class: 'empty' },
        h('h2', {}, '先載入名單吧'),
        h('p', {}, '貼上 Google 試算表的 CSV 連結，或先用範例資料體驗看看。'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: openSheet }, '載入名單')));
      return;
    }
    $('adjust-toggle').checked = state.adjust;
    renderTeamPicker();
    if (state.view === 'list') renderList(view, bad); else renderTeams(view, bad);
  }

  /** 名單畫面上的「分幾隊」:只列出能平均分配的隊數,放不下綁定組的會停用 */
  function renderTeamPicker() {
    const box = $('team-picker');
    const n = state.names.length;
    box.hidden = !state.model || state.shared;
    if (box.hidden) return;
    const options = [];
    for (let t = 2; t <= Math.min(L.MAX_TEAMS, n / 2); t++) if (n % t === 0) options.push(t);
    box.replaceChildren(h('span', { class: 'team-picker-label' }, '分幾隊'), ...options.map(t => {
      const why = L.validateConfig(state.model, t)[0];
      // 不能選的隊數不用 disabled(手機點了沒反應),改成點了提示原因
      return h('button', {
        type: 'button', class: 'team-chip' + (t === state.teams ? ' is-current' : '') + (why ? ' is-unavailable' : ''),
        title: why || `分成 ${t} 隊（每隊 ${n / t} 人）`, 'aria-disabled': !!why,
        'aria-pressed': t === state.teams, onclick: () => (why ? toast(why, 'warn') : changeTeams(t)),
      }, String(t));
    }));
  }

  function changeTeams(t) {
    if (t === state.teams) return;
    if (!confirm(`改成 ${t} 隊（每隊 ${state.names.length / t} 人）會重新分隊，取代目前的結果，確定嗎？`)) return;
    const r = doGenerate(state.model, t);
    if (!r.ok) { toast(r.errors[0], 'error'); return; }
    state.teams = t;
    state.assignment = r.assignment;
    state.open = new Set(); state.selected = -1;
    save(); render({ animate: true });
    toast(`已改成 ${t} 隊並重新分隊`);
  }

  function renderList(view, bad) {
    const q = state.query.trim().toLowerCase();
    const items = state.names.map((name, i) => ({ name, i })).filter(x => !q || x.name.toLowerCase().includes(q));
    if (!items.length) {
      view.append(h('div', { class: 'empty' }, h('h2', {}, '找不到這個名字'), h('p', {}, '換個關鍵字，或清除搜尋。')));
      return;
    }
    const list = h('div', { class: 'list' });
    items.forEach(({ name, i }, k) => {
      const t = state.assignment[i];
      const open = state.open.has(i) && !state.adjust;
      const card = h('article', {
        'data-i': i,
        class: 'person' + (open ? ' is-open' : '') + (state.selected === i ? ' is-selected' : '') + (bad.has(i) ? ' has-violation' : ''),
        style: `--h:${hue(t)};--i:${Math.min(k, 20)}`,
      },
        h('button', {
          class: 'person-head', type: 'button', 'aria-expanded': open,
          onclick: () => onPersonTap(i),
        },
          h('span', { class: 'person-name' }, name),
          h('span', { class: 'badge' }, L.teamName(t), h('span', { class: 'badge-suffix' }, ' 隊')),
          chevron()));
      list.append(card);
    });
    view.append(list);
  }

  function chevron() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'person-chev');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'm6 9 6 6 6-6');
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2.4'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    s.append(p);
    return s;
  }

  function renderTeams(view, bad) {
    const wrap = h('div', { class: 'teams' });
    const fc = state.model ? L.femaleCounts(state.model, state.assignment, state.teams) : null;
    for (let t = 0; t < state.teams; t++) {
      const members = state.names.map((name, i) => ({ name, i })).filter(x => state.assignment[x.i] === t);
      wrap.append(h('section', { class: 'team', style: `--h:${hue(t)};--i:${t}` },
        h('div', { class: 'team-head' },
          h('span', { class: 'team-letter' }, L.teamName(t)),
          h('span', { class: 'team-title' }, `${L.teamName(t)} 隊`),
          h('span', { class: 'team-count' }, fc ? `${members.length} 人 · 女 ${fc[t]}` : `${members.length} 人`)),
        h('ul', { class: 'team-members' }, members.map(({ name, i }) => h('li', {},
          h(state.adjust ? 'button' : 'span', {
            class: 'member' + (state.selected === i ? ' is-selected' : '') + (bad.has(i) ? ' has-violation' : ''),
            type: state.adjust ? 'button' : null,
            style: `--h:${hue(t)}`,
            onclick: state.adjust ? () => onPersonTap(i) : null,
          }, name))))));
    }
    view.append(wrap);
  }

  /* ---------- 互動 ---------- */
  function onPersonTap(i) {
    if (!state.adjust) {
      // 已揭曉的卡片點一下收合;未揭曉的進扭蛋機
      if (state.open.has(i)) {
        state.open.delete(i);
        setCardOpen(i, false);
      } else if (prefs.gacha) {
        openGacha(i);
        return;
      } else {
        state.open.add(i);
        setCardOpen(i, true);
      }
      updateToggleAll();
      return;
    }
    if (state.shared) return;
    if (state.selected < 0) { state.selected = i; render(); return; }
    if (state.selected === i) { state.selected = -1; render(); return; }
    const a = state.selected;
    const same = state.assignment[a] === state.assignment[i];
    state.selected = -1;
    if (same) { toast('兩人已在同一隊，互換不會有變化', 'warn'); render(); return; }
    const before = violations().length;
    state.assignment = L.swap(state.assignment, a, i);
    save();
    const after = violations().length;
    render();
    const msg = `已互換：${state.names[a]} → ${L.teamName(state.assignment[a])} 隊、${state.names[i]} → ${L.teamName(state.assignment[i])} 隊`;
    if (after > 0 && after >= before) toast(`${msg}\n⚠ 目前有 ${after} 項條件未滿足`, 'warn');
    else toast(msg + (after === 0 && before > 0 ? '，條件已全部滿足' : ''));
  }

  function setView(v) { state.view = v; render({ animate: true }); }

  /* ---------- 扭蛋機 ---------- */
  // 扭蛋外殼與機台裡的球都用固定糖果色,跟隊伍顏色無關,打開前不會洩漏隊伍
  const BALL_COLORS = ['#ff8fb1', '#ffc46b', '#7be0c3', '#8fb8ff', '#c59bff', '#ff9f7a', '#f7e36b', '#6fd6ff', '#ff7fd1', '#9be37b'];
  const BALL_SPOTS = [[62, 150], [108, 160], [152, 146], [40, 112], [84, 118], [130, 110], [170, 100], [60, 72], [106, 72], [150, 62]];
  const GACHA_HINT = { ready: '點扭蛋機，轉一下！', turning: '喀啦喀啦…', dropped: '掉出來了！點扭蛋打開', open: '' };
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let gachaIndex = -1;
  let gachaTimer;

  function buildGacha() {
    $('gacha-balls').replaceChildren(...BALL_SPOTS.map(([x, y], k) => h('span', {
      class: 'ball', style: `left:${x - 23}px;top:${y - 23}px;--c:${BALL_COLORS[k]};--r:${(k * 67) % 360}deg;--k:${k}`,
    })));
    $('gacha-sparks').replaceChildren(...Array.from({ length: 14 }, (_, k) => h('span', { class: 'spark', style: `--a:${k * (360 / 14)}deg` })));
    $('gacha-machine').addEventListener('click', turnGacha);
    $('gacha-capsule').addEventListener('click', openCapsule);
    $('gacha').addEventListener('close', () => { clearTimeout(gachaTimer); gachaIndex = -1; });
  }

  function setGachaStage(stage) {
    $('gacha').dataset.stage = stage;
    $('gacha-hint').textContent = GACHA_HINT[stage];
  }

  function openGacha(i) {
    const t = state.assignment[i];
    gachaIndex = i;
    $('gacha').style.setProperty('--h', hue(t));
    $('gacha-name').textContent = state.names[i];
    $('gacha-letter').textContent = L.teamName(t);
    $('gacha-team').textContent = `${L.teamName(t)} 隊`;
    setGachaStage('ready');
    $('gacha').showModal();
    $('gacha-machine').focus();
  }

  function turnGacha() {
    if ($('gacha').dataset.stage !== 'ready') return;
    setGachaStage('turning');
    clearTimeout(gachaTimer);
    gachaTimer = setTimeout(() => {
      setGachaStage('dropped');
      $('gacha-capsule').focus();
    }, reduceMotion() ? 0 : 850);
  }

  function openCapsule() {
    if ($('gacha').dataset.stage !== 'dropped' || gachaIndex < 0) return;
    setGachaStage('open');
    state.open.add(gachaIndex);
    setCardOpen(gachaIndex, true);
    updateToggleAll();
    $('gacha-close').focus();
  }

  /* ---------- 分隊 / 載入 ---------- */
  function doGenerate(model, teams) {
    const r = L.generate(model, teams);
    return r;
  }

  function csvUrlFor(input) {
    const url = input.trim();
    if (!url) return '';
    // 一般分享連結 -> 轉成 gviz CSV(需「知道連結的人可檢視」)
    const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?!\/e\/)/);
    if (m && !/\/d\/e\//.test(url) && !/output=csv|format=csv|tqx=out:csv/.test(url)) {
      const gid = (url.match(/[?#&]gid=(\d+)/) || [])[1];
      return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv${gid ? '&gid=' + gid : ''}`;
    }
    return url;
  }

  function showSheetErrors(list) {
    const ul = $('sheet-errors');
    ul.hidden = !list.length;
    ul.replaceChildren(...list.map(e => h('li', {}, e)));
  }

  async function loadAndSplit() {
    const btn = $('btn-load');
    const teams = parseInt($('in-teams').value, 10);
    const pasted = $('in-csv').value.trim();
    const urlInput = $('in-url').value.trim();
    showSheetErrors([]);
    if (!pasted && !urlInput) { showSheetErrors(['請貼上試算表 CSV 連結，或展開「改用貼上 CSV 內容」']); return; }
    btn.disabled = true; btn.textContent = '載入中…';
    let usedCode = false;
    try {
      let text = pasted;
      if (!text) {
        let sheetUrl = urlInput;
        if (!/^https?:\/\//i.test(urlInput)) {
          // 不是網址就當成代碼;解開的連結只在記憶體中使用,不顯示也不存檔
          sheetUrl = await openVault(urlInput);
          if (!sheetUrl) throw new Error('這不是試算表連結，也不是正確的代碼。');
          usedCode = true;
        }
        let res;
        try { res = await fetch(csvUrlFor(sheetUrl), { cache: 'no-store' }); }
        catch (e) { throw new Error('無法連線到試算表。請確認連結正確且已「發佈到網路」(CSV)，或改用貼上 CSV 內容。'); }
        if (!res.ok) throw new Error(`讀取試算表失敗(HTTP ${res.status})，請確認已發佈到網路。`);
        text = await res.text();
        if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('取得的不是 CSV。請在「發佈到網路」中選擇 CSV 格式，而不是網頁。');
      }
      const model = L.buildModel(L.parseCSV(text));
      const result = doGenerate(model, teams);
      if (!result.ok) { showSheetErrors(result.errors); return; }
      applyResult(model, teams, result.assignment, usedCode ? '' : urlInput);
      $('sheet').close();
      toast(result.attempts > 1 ? `分隊完成（因條件衝突重試了 ${result.attempts} 次）` : '分隊完成');
    } catch (e) {
      showSheetErrors([e.message]);
    } finally {
      btn.disabled = false; btn.textContent = '載入並分隊';
    }
  }

  function applyResult(model, teams, assignment, url) {
    state.model = { names: model.names, apart: model.apart, bind: model.bind, units: model.units, female: model.female };
    state.names = model.names;
    state.assignment = assignment;
    state.teams = teams;
    state.url = url || '';
    state.open = new Set();
    state.selected = -1;
    state.adjust = false;
    state.query = ''; $('search').value = '';
    state.shared = false;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    save();
    render({ animate: true });
  }

  // 防呆:不是為了保密,只是避免手滑把已經公布的結果洗掉
  const REROLL_WORD = 'MARK';
  const rerollMatches = () => $('reroll-input').value.trim().toUpperCase() === REROLL_WORD;

  /** 開啟確認視窗;輸入正確的確認字才會真的重新分隊 */
  function reroll() {
    if (!state.model) return;
    $('reroll-input').value = '';
    $('reroll-confirm').disabled = true;
    $('reroll-dialog').showModal();
    $('reroll-input').focus();
  }

  function initRerollGuard() {
    $('reroll-input').addEventListener('input', () => { $('reroll-confirm').disabled = !rerollMatches(); });
    $('reroll-cancel').addEventListener('click', () => $('reroll-dialog').close());
    $('reroll-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!rerollMatches()) return;   // 按 Enter 也要擋
      $('reroll-dialog').close();
      doReroll();
    });
  }

  function doReroll() {
    if (!state.model) return;
    const r = doGenerate(state.model, state.teams);
    if (!r.ok) { toast(r.errors[0], 'error'); return; }
    state.assignment = r.assignment;
    state.open = new Set(); state.selected = -1;
    save(); render({ animate: true });
    toast(r.attempts > 1 ? `已重新分隊（重試 ${r.attempts} 次）` : '已重新分隊');
  }

  async function copyResult() {
    const text = state.model
      ? L.resultText(state.model, state.assignment, state.teams)
      : L.resultText({ names: state.names }, state.assignment, state.teams);
    toast((await copyText(text)) ? '結果已複製' : '複製失敗，請手動選取', 'ok');
  }

  async function shareLink() {
    const code = L.encodeShare(state.names, state.assignment);
    const link = `${location.origin}${location.pathname}#r=${code}`;
    if (location.protocol === 'file:') toast('提醒：file:// 開啟的連結無法分享給他人，請先部署到網路上', 'warn');
    if (navigator.share) {
      try { await navigator.share({ title: '分隊結果', text: '點開連結，找到自己的名字看隊伍', url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    if (await copyText(link)) { if (location.protocol !== 'file:') toast('唯讀分享連結已複製'); }
    else toast('複製失敗：' + link, 'error');
  }

  /* ---------- 設定面板 ---------- */
  function openSheet() {
    $('in-url').value = state.url;
    $('in-teams').value = state.teams || 3;
    showSheetErrors([]);
    $('sheet').showModal();
  }

  /* ---------- 啟動 ---------- */
  function readHash() {
    const m = location.hash.match(/^#r=([A-Za-z0-9_-]+)$/);
    if (!m) return false;
    const d = L.decodeShare(m[1]);
    if (!d) { toast('分享連結已損壞，無法開啟', 'error'); return false; }
    state.shared = true;
    state.model = null;
    state.names = d.names;
    state.assignment = d.assignment;
    state.teams = d.teams;
    state.adjust = false;
    return true;
  }

  function init() {
    buildGacha();
    initRerollGuard();
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));
    $('btn-settings').addEventListener('click', openSheet);
    $('btn-load').addEventListener('click', loadAndSplit);
    $('btn-demo').addEventListener('click', () => {
      $('in-csv').value = DEMO_CSV;
      $('in-csv').closest('details').open = true;
      $('in-teams').value = 3;
      loadAndSplit();
    });
    $('btn-reroll').addEventListener('click', reroll);
    $('btn-copy').addEventListener('click', copyResult);
    $('btn-share').addEventListener('click', shareLink);
    $('search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
    $('btn-toggle-all').addEventListener('click', () => {
      const open = state.open.size < state.names.length;
      state.open = open ? new Set(state.names.map((_, i) => i)) : new Set();
      state.names.forEach((_, i) => setCardOpen(i, open));
      updateToggleAll();
    });
    $('gacha-toggle').checked = prefs.gacha;
    $('gacha-toggle').addEventListener('change', (e) => {
      prefs.gacha = e.target.checked;
      savePrefs();
      toast(prefs.gacha ? '扭蛋機已開啟：點名字會轉扭蛋' : '扭蛋機已關閉：點名字直接顯示隊伍');
    });
    $('adjust-toggle').addEventListener('change', (e) => {
      state.adjust = e.target.checked; state.selected = -1; render();
    });
    window.addEventListener('hashchange', () => {
      if (readHash()) { state.open = new Set(); render({ animate: true }); }
    });

    if (!readHash()) loadSaved();
    render({ animate: true });
    if (!state.names.length) openSheet();

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 離線功能失敗不影響使用 */ });
    }
  }

  // 供測試/除錯
  window.__app = { state, render };
  init();
})();
