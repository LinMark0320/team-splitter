const test = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');

// 可重現的偽亂數
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const csvOf = (people) =>
  '姓名,不同隊對象,綁定對象\n' + people.map(p => p.map(c => (/[,"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

function names(n) { return Array.from({ length: n }, (_, i) => `P${i + 1}`); }

test('parseCSV: 引號、逗號、CRLF、BOM', () => {
  const rows = L.parseCSV('\uFEFF姓名,不同隊對象,綁定對象\r\nA,"B,C",\r\n"D""x",,E\r\n');
  assert.deepStrictEqual(rows[1], ['A', 'B,C', '']);
  assert.deepStrictEqual(rows[2], ['D"x', '', 'E']);
});

test('splitList: 逗號/頓號/分號分隔', () => {
  assert.deepStrictEqual(L.splitList('B, C、D;E，F'), ['B', 'C', 'D', 'E', 'F']);
  assert.deepStrictEqual(L.splitList(''), []);
});

test('buildModel: 使用者情境 A不同隊B、B綁定C => A也與C不同隊(衍生)', () => {
  const m = L.buildModel(L.parseCSV(csvOf([['A', 'B', ''], ['B', '', 'C'], ['C', '', ''], ['D', '', '']])));
  assert.deepStrictEqual(m.errors, []);
  const has = (x, y) => m.apart.some(([a, b]) => (m.names[a] === x && m.names[b] === y) || (m.names[a] === y && m.names[b] === x));
  assert.ok(has('A', 'B'));
  assert.ok(has('A', 'C'), '衍生的 A-C 不同隊');
  assert.strictEqual(m.units.length, 3); // [B,C] A D
});

test('buildModel: 錯誤偵測', () => {
  const dup = L.buildModel(L.parseCSV(csvOf([['A', '', ''], ['A', '', '']])));
  assert.ok(dup.errors.some(e => e.includes('重複')));
  const unknown = L.buildModel(L.parseCSV(csvOf([['A', 'Z', ''], ['B', '', '']])));
  assert.ok(unknown.errors.some(e => e.includes('不在名單')));
  const self = L.buildModel(L.parseCSV(csvOf([['A', 'A', ''], ['B', '', '']])));
  assert.ok(self.errors.some(e => e.includes('自己')));
  const contradict = L.buildModel(L.parseCSV(csvOf([['A', 'B', 'B'], ['B', '', '']])));
  assert.ok(contradict.errors.some(e => e.includes('綁定') && e.includes('不同隊')));
  // 間接矛盾:A 綁 B、B 綁 C(同一組),卻要求 A 不同隊 C
  const indirect = L.buildModel(L.parseCSV(csvOf([['A', 'C', 'B'], ['B', '', 'C'], ['C', '', '']])));
  assert.ok(indirect.errors.some(e => e.includes('「A」與「C」') && e.includes('綁定組')));
});

test('buildModel: 多人綁定組(一人綁多人、串連)合併成一組', () => {
  // 一人綁多人:甲 綁定 乙,丙;另一組 D 綁 E、E 綁 F(串連)
  const m = L.buildModel(L.parseCSV(csvOf([
    ['甲', '', '乙,丙'], ['乙', '', ''], ['丙', '', ''],
    ['D', '', 'E'], ['E', '', 'F'], ['F', '', ''], ['G', '丙', ''], ['H', '', ''],
  ])));
  assert.deepStrictEqual(m.errors, []);
  const unitNames = m.units.map(u => u.map(i => m.names[i]).sort().join('+')).sort();
  assert.deepStrictEqual(unitNames, ['D+E+F', 'G', 'H', '丙+乙+甲']);
  // G 不同隊 丙 => 延伸為 G 與整組都不同隊
  const has = (x, y) => m.apart.some(([a, b]) => [m.names[a], m.names[b]].sort().join() === [x, y].sort().join());
  ['甲', '乙', '丙'].forEach(x => assert.ok(has('G', x), `G 應與 ${x} 不同隊`));
  assert.strictEqual(m.apart.length, 3);
  // 每隊 2 人放不下 3 人組;每隊 4 人可以
  assert.ok(L.validateConfig(m, 4).some(e => e.includes('3 人的綁定組')));
  assert.deepStrictEqual(L.validateConfig(m, 2), []);
  for (let seed = 1; seed <= 200; seed++) {
    const r = L.generate(m, 2, { rng: mulberry32(seed) });
    assert.ok(r.ok, `seed ${seed}`);
    assert.deepStrictEqual(L.checkViolations(m, r.assignment), []);
  }
});

test('buildModel: 無標題列時依欄位順序', () => {
  const m = L.buildModel(L.parseCSV('A,B,\nB,,\nC,,'));
  assert.strictEqual(m.names.length, 3);
});

test('validateConfig: 不整除/隊數範圍/綁定放不下', () => {
  const m = L.buildModel(L.parseCSV(csvOf(names(7).map(n => [n, '', '']))));
  assert.ok(L.validateConfig(m, 2).some(e => e.includes('平均')));
  assert.ok(L.validateConfig(m, 1).length > 0);
  const m27 = L.buildModel(L.parseCSV(csvOf(names(54).map(n => [n, '', '']))));
  assert.ok(L.validateConfig(m27, 27).some(e => e.includes('26')));
  const m2 = L.buildModel(L.parseCSV(csvOf([['A', '', 'B'], ['B', '', ''], ['C', '', ''], ['D', '', '']])));
  assert.ok(L.validateConfig(m2, 4).some(e => e.includes('放不下'))); // 每隊 1 人
  assert.deepStrictEqual(L.validateConfig(m2, 2), []);
});

test('generate: 滿足條件、人數平均(1000 個種子)', () => {
  const people = names(12).map(n => [n, '', '']);
  people[0][1] = 'P2';            // P1 不同隊 P2
  people[2][2] = 'P4';            // P3 綁定 P4
  people[4][1] = 'P3';            // P5 不同隊 P3(連帶 P5 不與 P4 同隊)
  people[6][2] = 'P8';            // P7 綁定 P8
  const m = L.buildModel(L.parseCSV(csvOf(people)));
  assert.deepStrictEqual(m.errors, []);
  for (let seed = 1; seed <= 1000; seed++) {
    const r = L.generate(m, 3, { rng: mulberry32(seed) });
    assert.ok(r.ok, `seed ${seed} 應成功`);
    assert.deepStrictEqual(L.checkViolations(m, r.assignment), [], `seed ${seed} 不應違規`);
    const count = [0, 0, 0];
    r.assignment.forEach(t => count[t]++);
    assert.deepStrictEqual(count, [4, 4, 4]);
  }
});

test('generate: 結果具隨機性(不同種子產生不同分法)', () => {
  const m = L.buildModel(L.parseCSV(csvOf(names(8).map(n => [n, '', '']))));
  const set = new Set();
  for (let s = 1; s <= 30; s++) set.add(L.generate(m, 2, { rng: mulberry32(s) }).assignment.join(''));
  assert.ok(set.size > 5);
});

test('generate: 條件無解 => 重試上限後回報錯誤,不會無窮迴圈', () => {
  // 3 人兩兩不同隊但只有 2 隊 => 無解
  const m = L.buildModel(L.parseCSV(csvOf([['A', 'B,C', ''], ['B', 'C', ''], ['C', '', ''], ['D', '', ''], ['E', '', ''], ['F', '', '']])));
  const r = L.generate(m, 2, { rng: mulberry32(1) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.attempts, 100);
  assert.ok(r.errors[0].includes('無解'));
});

test('generate: 重試上限可設定', () => {
  const m = L.buildModel(L.parseCSV(csvOf([['A', 'B,C', ''], ['B', 'C', ''], ['C', '', ''], ['D', '', ''], ['E', '', ''], ['F', '', '']])));
  assert.strictEqual(L.generate(m, 2, { maxRetries: 7 }).attempts, 7);
});

test('generate: 存檔後的模型(沒有 errors 欄位)也能重新分隊', () => {
  const m = L.buildModel(L.parseCSV(csvOf(names(8).map(n => [n, '', '']))));
  const saved = JSON.parse(JSON.stringify({ names: m.names, apart: m.apart, bind: m.bind, units: m.units, female: m.female }));
  assert.strictEqual(L.generate(saved, 2).ok, true);
});

test('generate: 有模型錯誤時直接回報且不重試', () => {
  const m = L.buildModel(L.parseCSV(csvOf([['A', 'Z', ''], ['B', '', '']])));
  const r = L.generate(m, 2);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.attempts, 0);
});

test('generate: 大名單(60 人 6 隊多條件)仍能在上限內成功', () => {
  const people = names(60).map(n => [n, '', '']);
  for (let i = 0; i < 10; i++) people[i * 2][2] = `P${i * 2 + 2}`;   // 10 組綁定
  for (let i = 0; i < 10; i++) people[20 + i][1] = `P${40 + i}`;     // 10 條不同隊
  const m = L.buildModel(L.parseCSV(csvOf(people)));
  assert.deepStrictEqual(m.errors, []);
  for (let seed = 1; seed <= 200; seed++) {
    const r = L.generate(m, 6, { rng: mulberry32(seed) });
    assert.ok(r.ok, `seed ${seed}`);
    assert.deepStrictEqual(L.checkViolations(m, r.assignment), []);
  }
});

test('generate: 隊長互斥 + 綁定組(緊條件)不會誤報無解', () => {
  // 24 人 6 隊(每隊 4):P1–P6 兩兩不同隊、P7–P12 兩兩不同隊,P13–P24 組成 6 組綁定,
  // 部分綁定組另與隊長互斥。有解,但舊的「綁定組優先」貪婪法約 3 成機率失敗。
  const people = names(24).map(n => [n, '', '']);
  const others = (from, to, self) => names(24).slice(from, to).filter(x => x !== self).join(',');
  for (let i = 0; i < 6; i++) people[i][1] = others(0, 6, `P${i + 1}`);
  for (let i = 6; i < 12; i++) people[i][1] = others(6, 12, `P${i + 1}`);
  for (let k = 0; k < 6; k++) people[12 + 2 * k][2] = `P${14 + 2 * k}`;
  people[12][1] = 'P1,P7';
  people[14][1] = 'P2,P8';
  people[16][1] = 'P3,P9';
  const m = L.buildModel(L.parseCSV(csvOf(people)));
  assert.deepStrictEqual(m.errors, []);
  for (let seed = 1; seed <= 300; seed++) {
    const r = L.generate(m, 6, { rng: mulberry32(seed) });
    assert.ok(r.ok, `seed ${seed} 應成功`);
    assert.deepStrictEqual(L.checkViolations(m, r.assignment), []);
  }
});

test('性別欄:只標女生,留空/男 視為男生;看不懂的值報錯;沒有性別欄時不影響', () => {
  const m = L.buildModel(L.parseCSV('姓名,不同隊對象,綁定對象,性別\nA,,,女\nB,,,\nC,,,男\nD,,,F'));
  assert.deepStrictEqual(m.errors, []);
  assert.deepStrictEqual(m.female, [true, false, false, true]);
  const bad = L.buildModel(L.parseCSV('姓名,不同隊對象,綁定對象,性別\nA,,,女\nB,,,?'));
  assert.ok(bad.errors.some(e => e.includes('「B」的性別')));
  const none = L.buildModel(L.parseCSV(csvOf([['A', '', ''], ['B', '', '']])));
  assert.deepStrictEqual(none.female, [false, false]);
  assert.strictEqual(L.femaleCounts(none, [0, 1], 2), null);
});

const withGender = (people, females) =>
  csvOf(people).replace('綁定對象', '綁定對象,性別').split('\n')
    .map((line, k) => (k === 0 ? line : line + ',' + (females.includes(people[k - 1][0]) ? '女' : ''))).join('\n');

test('男女平均:24 人 10 女分 4 隊,每隊女生 2~3 人,且條件仍成立', () => {
  const people = names(24).map(n => [n, '', '']);
  people[0][1] = 'P2,P3';   // 女生之間互斥
  people[4][2] = 'P6';      // 綁定(男女混合)
  people[10][1] = 'P20';
  const females = names(10);
  const m = L.buildModel(L.parseCSV(withGender(people, females)));
  assert.deepStrictEqual(m.errors, []);
  for (let seed = 1; seed <= 300; seed++) {
    const r = L.generate(m, 4, { rng: mulberry32(seed) });
    assert.ok(r.ok, `seed ${seed}`);
    assert.deepStrictEqual(L.checkViolations(m, r.assignment), [], `seed ${seed} 不應違規`);
    const fc = L.femaleCounts(m, r.assignment, 4);
    assert.ok(Math.max(...fc) - Math.min(...fc) <= 1, `seed ${seed} 女生分布 ${fc}`);
    const size = [0, 0, 0, 0]; r.assignment.forEach(t => size[t]++);
    assert.deepStrictEqual(size, [6, 6, 6, 6]);
  }
});

test('男女平均:三位女生綁定組造成的偏差,其餘人仍盡量平均', () => {
  // 8 女分 4 隊(目標各 2);P1~P3 三女綁定 => 該隊 3 女,其餘 5 女分到 3 隊 => 最佳為 3/2/2/1
  const people = names(24).map(n => [n, '', '']);
  people[0][2] = 'P2'; people[1][2] = 'P3';
  const m = L.buildModel(L.parseCSV(withGender(people, names(8))));
  for (let seed = 1; seed <= 300; seed++) {
    const r = L.generate(m, 4, { rng: mulberry32(seed) });
    const fc = L.femaleCounts(m, r.assignment, 4);
    assert.strictEqual(fc[r.assignment[0]], 3, `seed ${seed} 綁定組那隊不應再多女生 ${fc}`);
    assert.deepStrictEqual([...fc].sort(), [1, 2, 2, 3], `seed ${seed} 女生分布 ${fc}`);
    assert.deepStrictEqual(L.checkViolations(m, r.assignment), []);
  }
});

test('checkViolations / swap: 手動互換後能偵測違規', () => {
  const m = L.buildModel(L.parseCSV(csvOf([['A', 'B', ''], ['B', '', ''], ['C', '', 'D'], ['D', '', '']])));
  const ok = [0, 1, 0, 0].map((x, i) => x); // A:0 B:1 C:0 D:0 -> 合法
  assert.deepStrictEqual(L.checkViolations(m, ok), []);
  const s1 = L.swap(ok, 1, 2); // B<->C => B:0(與A同隊) C:1(與D拆開)
  const v = L.checkViolations(m, s1);
  assert.strictEqual(v.filter(x => x.type === 'apart').length, 1);
  assert.strictEqual(v.filter(x => x.type === 'bind').length, 1);
  assert.ok(L.describeViolation(m, v[0], s1).length > 0);
});

test('resultText: 格式', () => {
  const m = L.buildModel(L.parseCSV(csvOf([['小明', '', ''], ['小華', '', ''], ['小美', '', ''], ['小強', '', '']])));
  assert.strictEqual(L.resultText(m, [0, 1, 0, 1], 2), '【A 隊】小明、小美\n【B 隊】小華、小強');
});

test('分享連結: 中文名字編碼來回一致,壞資料回傳 null', () => {
  const ns = ['小明', 'Amy', '王 大華', 'O\'Neil'];
  const asg = [0, 1, 1, 0];
  const code = L.encodeShare(ns, asg);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(code), '需為 URL 安全字元');
  const back = L.decodeShare(code);
  assert.deepStrictEqual(back.names, ns);
  assert.deepStrictEqual(back.assignment, asg);
  assert.strictEqual(back.teams, 2);
  assert.strictEqual(L.decodeShare('%%%壞掉'), null);
  assert.strictEqual(L.decodeShare(L.encodeShare(['a'], [0]).slice(0, 5)), null);
});
