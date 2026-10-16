/* 分隊核心邏輯(純函式,無 DOM 依賴,可在瀏覽器與 Node 共用) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeamLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_TEAMS = 26;
  const DEFAULT_MAX_RETRIES = 100;
  const FEMALE_RE = /^(女|女生|女性|f|female|girl|v|o|y|yes|是|true|1|✓|✔)$/i;
  const MALE_RE = /^(男|男生|男性|m|male|boy|x|n|no|否|false|0)$/i;

  /** 隊伍索引 -> 隊名(0 -> A) */
  function teamName(i) {
    return String.fromCharCode(65 + i);
  }

  /** 解析 CSV(支援引號、跨行欄位、CRLF) */
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    const s = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { cell += '"'; i++; }
          else inQuotes = false;
        } else cell += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim() !== ''));
  }

  /** 儲存格內多個對象以逗號/頓號/分號/換行分隔 */
  function splitList(cell) {
    return String(cell || '')
      .split(/[,，、;；\n\r]+/)
      .map(x => x.trim())
      .filter(Boolean);
  }

  /**
   * 由 CSV 列建立模型。
   * 欄位:姓名 | 不同隊對象 | 綁定對象(依標題辨識,找不到則用第 1/2/3 欄)
   * 回傳 { names, apart, bind, units, errors }
   *  - apart: 展開後所有「不能同隊」的人員配對 [i,j](含經由綁定衍生者)
   *  - bind : 綁定配對 [i,j]
   *  - units: 分配單位(綁定視為一組),每個為人員索引陣列
   */
  function buildModel(rows) {
    const errors = [];
    if (!rows || !rows.length) return { names: [], apart: [], bind: [], units: [], errors: ['名單是空的'] };

    const header = rows[0].map(x => String(x).trim());
    const find = (re, fallback) => {
      const i = header.findIndex(h => re.test(h));
      return i >= 0 ? i : fallback;
    };
    const hasHeader = header.some(h => /姓名|名字|name/i.test(h));
    const nameCol = hasHeader ? find(/姓名|名字|name/i, 0) : 0;
    const apartCol = hasHeader ? find(/不同隊|不能同隊|apart/i, 1) : 1;
    const bindCol = hasHeader ? find(/綁定|bind/i, 2) : 2;
    // 性別欄(選填):女生填「女」,留空或填「男」視為男生
    const genderCol = hasHeader ? find(/性別|男女|女生|gender|sex/i, -1) : 3;
    const dataRows = hasHeader ? rows.slice(1) : rows;

    const names = [];
    const female = [];
    const index = new Map();
    const rawApart = [];
    const rawBind = [];

    dataRows.forEach((r, k) => {
      const name = String(r[nameCol] || '').trim();
      if (!name) return;
      if (index.has(name)) { errors.push(`姓名重複:「${name}」`); return; }
      index.set(name, names.length);
      names.push(name);
      const g = genderCol >= 0 ? String(r[genderCol] || '').trim() : '';
      if (g && !FEMALE_RE.test(g) && !MALE_RE.test(g)) errors.push(`「${name}」的性別「${g}」看不懂,女生請填「女」,男生留空或填「男」`);
      female.push(FEMALE_RE.test(g));
      rawApart.push({ name, targets: splitList(r[apartCol]), row: k + (hasHeader ? 2 : 1) });
      rawBind.push({ name, targets: splitList(r[bindCol]), row: k + (hasHeader ? 2 : 1) });
    });

    const lookup = (from, to, kind) => {
      if (to === from) { errors.push(`「${from}」的${kind}對象不能是自己`); return -1; }
      if (!index.has(to)) { errors.push(`「${from}」的${kind}對象「${to}」不在名單中`); return -1; }
      return index.get(to);
    };

    // 綁定:有綁定關係的人串成一組(人數不限),整組放同一隊
    const bindSet = new Set();
    const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
    const bind = [];
    rawBind.forEach(({ name, targets }) => {
      const a = index.get(name);
      targets.forEach(t => {
        const b = lookup(name, t, '綁定');
        if (b < 0) return;
        const key = pairKey(a, b);
        if (bindSet.has(key)) return;
        bindSet.add(key);
        bind.push([Math.min(a, b), Math.max(a, b)]);
      });
    });
    const parent = names.map((_, i) => i);
    const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    bind.forEach(([a, b]) => { parent[root(a)] = root(b); });
    const groupOf = names.map((_, i) => root(i));
    const members = new Map();
    groupOf.forEach((g, i) => { if (!members.has(g)) members.set(g, []); members.get(g).push(i); });

    // 不同隊(雙向),再依綁定展開衍生配對
    const apartSet = new Set();
    const directApart = [];
    rawApart.forEach(({ name, targets }) => {
      const a = index.get(name);
      targets.forEach(t => {
        const b = lookup(name, t, '不同隊');
        if (b < 0) return;
        const key = pairKey(a, b);
        if (apartSet.has(key)) return;
        apartSet.add(key);
        directApart.push([a, b]);
      });
    });
    // 矛盾:同一綁定組內的兩人被要求不同隊
    directApart.forEach(([a, b]) => {
      if (groupOf[a] === groupOf[b]) {
        errors.push(`「${names[a]}」與「${names[b]}」在同一個綁定組,卻被要求「不同隊」`);
      }
    });
    // 「A 不同隊 B」延伸到雙方整個綁定組
    const expanded = new Set();
    directApart.forEach(([a, b]) => {
      if (groupOf[a] === groupOf[b]) return;
      members.get(groupOf[a]).forEach(x => members.get(groupOf[b]).forEach(y => expanded.add(pairKey(x, y))));
    });
    const apart = [...expanded].map(k => k.split('-').map(Number));

    const units = [...members.values()];

    return {
      names, apart, bind, units, female,
      errors: [...new Set(errors)],
    };
  }

  /** 檢查隊數設定是否可行 */
  function validateConfig(model, teams) {
    const errors = [];
    const n = model.names.length;
    if (!Number.isInteger(teams) || teams < 2) errors.push('隊數至少要 2 隊');
    else if (teams > MAX_TEAMS) errors.push(`隊數最多 ${MAX_TEAMS} 隊(A–Z)`);
    else {
      if (n % teams !== 0) errors.push(`${n} 人無法平均分成 ${teams} 隊`);
      else {
        const size = n / teams;
        model.units.filter(u => u.length > size).forEach(u => {
          errors.push(`每隊只有 ${size} 人,放不下 ${u.length} 人的綁定組(${u.map(i => model.names[i]).join('、')})`);
        });
      }
    }
    if (n < 2) errors.push('名單至少要 2 人');
    return errors;
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 單次嘗試:隨機貪婪放置,失敗回傳 null */
  function attempt(model, teams, rng) {
    const n = model.names.length;
    const size = n / teams;
    const conflicts = Array.from({ length: n }, () => new Set());
    model.apart.forEach(([a, b]) => { conflicts[a].add(b); conflicts[b].add(a); });

    const assign = new Array(n).fill(-1);
    const load = new Array(teams).fill(0);
    const members = Array.from({ length: teams }, () => []);

    // 限制最多(不同隊對象最多)的單位優先放置,其次大單位(綁定組),同條件內隨機。
    // 若先放綁定組,常把名額佔滿,最後互斥的人沒地方放,導致有解卻誤報無解。
    const deg = u => u.reduce((s, p) => s + conflicts[p].size, 0);
    const units = shuffle(model.units, rng).sort((a, b) => deg(b) - deg(a) || b.length - a.length);
    for (const u of units) {
      const candidates = [];
      for (let t = 0; t < teams; t++) {
        if (load[t] + u.length > size) continue;
        const clash = u.some(p => members[t].some(m => conflicts[p].has(m)));
        if (!clash) candidates.push(t);
      }
      if (!candidates.length) return null;
      const t = candidates[Math.floor(rng() * candidates.length)];
      u.forEach(p => { assign[p] = t; members[t].push(p); });
      load[t] += u.length;
    }
    return assign;
  }

  /**
   * 男女平均(軟性):在不違反「不同隊」與「綁定」的前提下,反覆互換兩隊中人數相同、
   * 女生數不同的單位,直到各隊女生數無法更平均。綁定組造成的偏差可接受。
   */
  function balanceGender(model, teams, assignment, rng) {
    const fem = model.female || [];
    if (!fem.some(Boolean)) return assignment;
    const a = assignment.slice();
    const conflicts = Array.from({ length: a.length }, () => new Set());
    model.apart.forEach(([x, y]) => { conflicts[x].add(y); conflicts[y].add(x); });
    const units = model.units.map(u => ({ u, f: u.filter(p => fem[p]).length }));
    const fCount = new Array(teams).fill(0);
    a.forEach((t, p) => { if (fem[p]) fCount[t]++; });
    // 單位 u 移到隊 t 時(對方單位 v 會離開 t),是否與 t 的其他人衝突
    const fits = (u, t, v) => u.every(p => a.every((tt, m) => tt !== t || v.includes(m) || !conflicts[p].has(m)));

    for (let round = 0; round < 50; round++) {
      let improved = false;
      const order = shuffle(units, rng);
      for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const U = order[i], V = order[j];
          const tu = a[U.u[0]], tv = a[V.u[0]];
          if (tu === tv || U.u.length !== V.u.length || U.f === V.f) continue;
          const d = V.f - U.f; // tu 女生數變化;tv 為 -d
          const before = fCount[tu] ** 2 + fCount[tv] ** 2;
          const after = (fCount[tu] + d) ** 2 + (fCount[tv] - d) ** 2;
          if (after >= before) continue;
          if (!fits(U.u, tv, V.u) || !fits(V.u, tu, U.u)) continue;
          U.u.forEach(p => { a[p] = tv; });
          V.u.forEach(p => { a[p] = tu; });
          fCount[tu] += d; fCount[tv] -= d;
          improved = true;
        }
      }
      if (!improved) break;
    }
    return a;
  }

  /** 各隊女生人數(沒有性別資料時回傳 null) */
  function femaleCounts(model, assignment, teams) {
    if (!model.female || !model.female.some(Boolean)) return null;
    const c = new Array(teams).fill(0);
    assignment.forEach((t, p) => { if (model.female[p]) c[t]++; });
    return c;
  }

  /**
   * 隨機分隊。僅在規則衝突(放不下)時自動重試,上限 maxRetries 次。
   * 回傳 { ok, assignment?, attempts, errors? }
   */
  function generate(model, teams, opts) {
    const o = opts || {};
    const rng = o.rng || Math.random;
    const maxRetries = o.maxRetries || DEFAULT_MAX_RETRIES;
    // 存在 localStorage 的模型沒有 errors(載入時已檢查過),要容許
    const pre = [...(model.errors || []), ...validateConfig(model, teams)];
    if (pre.length) return { ok: false, attempts: 0, errors: pre };
    for (let i = 1; i <= maxRetries; i++) {
      const a = attempt(model, teams, rng);
      if (a) return { ok: true, assignment: balanceGender(model, teams, a, rng), attempts: i };
    }
    return {
      ok: false,
      attempts: maxRetries,
      errors: [`嘗試 ${maxRetries} 次仍無法同時滿足所有條件,條件可能無解。請檢查「不同隊對象」與「綁定對象」,或調整隊數。`],
    };
  }

  /** 檢查目前分配違反哪些條件 */
  function checkViolations(model, assignment) {
    const v = [];
    model.apart.forEach(([a, b]) => {
      if (assignment[a] === assignment[b]) v.push({ type: 'apart', a, b });
    });
    model.bind.forEach(([a, b]) => {
      if (assignment[a] !== assignment[b]) v.push({ type: 'bind', a, b });
    });
    return v;
  }

  function describeViolation(model, v, assignment) {
    const A = model.names[v.a];
    const B = model.names[v.b];
    if (v.type === 'apart') {
      const t = assignment ? `目前都在 ${teamName(assignment[v.a])} 隊` : '目前同隊';
      return `「${A}」與「${B}」不能同隊,但${t}`;
    }
    const t = assignment ? `(${teamName(assignment[v.a])} / ${teamName(assignment[v.b])})` : '';
    return `「${A}」與「${B}」要綁定同隊,但目前分開了${t}`;
  }

  /** 互換兩人隊伍 */
  function swap(assignment, i, j) {
    const a = assignment.slice();
    [a[i], a[j]] = [a[j], a[i]];
    return a;
  }

  /** 產生可複製的結果文字 */
  function resultText(model, assignment, teams) {
    const lines = [];
    for (let t = 0; t < teams; t++) {
      const m = model.names.filter((_, i) => assignment[i] === t);
      lines.push(`【${teamName(t)} 隊】${m.join('、')}`);
    }
    return lines.join('\n');
  }

  /* ---------- 分享連結編碼(結果放在網址 hash,不需要伺服器) ---------- */
  function b64urlEncode(str) {
    const b = btoa(unescape(encodeURIComponent(str)));
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b + '==='.slice((b.length + 3) % 4);
    return decodeURIComponent(escape(atob(pad)));
  }
  function encodeShare(names, assignment) {
    const a = assignment.map(teamName).join('');
    return b64urlEncode(JSON.stringify({ n: names, a }));
  }
  /** 解碼失敗回傳 null */
  function decodeShare(code) {
    try {
      const o = JSON.parse(b64urlDecode(code));
      if (!Array.isArray(o.n) || typeof o.a !== 'string' || o.n.length !== o.a.length) return null;
      if (!/^[A-Z]+$/.test(o.a)) return null;
      const assignment = [...o.a].map(c => c.charCodeAt(0) - 65);
      return { names: o.n.map(String), assignment, teams: Math.max(...assignment) + 1 };
    } catch (e) {
      return null;
    }
  }

  return {
    MAX_TEAMS, DEFAULT_MAX_RETRIES,
    teamName, parseCSV, splitList, buildModel, validateConfig,
    generate, femaleCounts, checkViolations, describeViolation, swap, resultText,
    encodeShare, decodeShare,
  };
});
