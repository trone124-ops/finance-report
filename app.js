/* Финансовый отчёт — localStorage, без сервера. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

(function () {
'use strict';

/* ================= 11. Utilities ================= */
const $ = id => document.getElementById(id);
const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const MONTHS_G = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const WD = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const WDW = ['Пт','Сб','Вс','Пн','Вт','Ср','Чт'];      // дни рабочей недели: пятница → четверг
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => y + '-' + pad(m + 1) + '-' + pad(d);          // YYYY-MM-DD, m: 0..11
const dateToIso = d => iso(d.getFullYear(), d.getMonth(), d.getDate());
const todayIso = () => dateToIso(new Date());
const parseIso = s => { const p = s.split('-').map(Number); return { y: p[0], m: p[1] - 1, d: p[2] }; };
const dmy = s => { const p = parseIso(s); return pad(p.d) + '.' + pad(p.m + 1) + '.' + p.y; };
const longDate = s => { const p = parseIso(s); return p.d + ' ' + MONTHS_G[p.m] + ' ' + p.y; };
const num = v => { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : 0; }; // отрицательные и пустые = 0
const fmt = n => (Math.round(n * 100) / 100).toLocaleString('ru-RU') + ' ₽';
const uid = () => 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const clone = o => JSON.parse(JSON.stringify(o));
const cls = n => n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero';
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
function weekRange(s) {                       // пятница..четверг недели, содержащей дату s
  const p = parseIso(s), dow = (new Date(p.y, p.m, p.d).getDay() + 2) % 7, days = [];
  for (let i = 0; i < 7; i++) days.push(dateToIso(new Date(p.y, p.m, p.d - dow + i)));
  return days;
}

/* ================= 1. Storage: Firebase (вход Google + облачная база Firestore) ================= */
// Ключи веб-приложения Firebase (не секретные; защита — правила Firestore).
const firebaseConfig = {
  apiKey: "AIzaSyDXcx3AeKt93D0O4rLLKWami1RN6011zrw",
  authDomain: "finance-report-83f04.firebaseapp.com",
  projectId: "finance-report-83f04",
  storageBucket: "finance-report-83f04.firebasestorage.app",
  messagingSenderId: "122405068957",
  appId: "1:122405068957:web:afbfcfb805401b276c3474"
};
const KEY_OBJ = 'finance_objects', KEY_REP = 'finance_reports';   // старые ключи localStorage (только для переноса)
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
let db;
try { db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { db = getFirestore(fbApp); }
let userId = null, objects = [], reports = {}, firstFromCache = false, unsubs = [];
const savedJson = {};
const stable = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.keys(x).sort().reduce((r, key) => (r[key] = x[key], r), {}) : x);
const col = name => collection(db, 'users', userId, name);
const legacy = k => { try { const v = localStorage.getItem(k); return v === null ? null : JSON.parse(v); } catch (e) { return null; } };
function showErr(e) {
  console.error(e);
  const b = $('banner'); b.textContent = 'Ошибка облака: ' + ((e && (e.code || e.message)) || e); b.hidden = false;
}
async function commitOps(ops) {                                   // пакетная запись/удаление (по 400)
  for (let i = 0; i < ops.length; i += 400) {
    const bt = writeBatch(db);
    ops.slice(i, i + 400).forEach(op => op.data ? bt.set(op.ref, op.data) : bt.delete(op.ref));
    await bt.commit();
  }
}
let flushTimer = null;
function saveObjects() { clearTimeout(flushTimer); flushTimer = setTimeout(flushObjects, 500); }   // с задержкой, чтобы не писать на каждую букву
function flushObjects() {
  clearTimeout(flushTimer);
  if (!userId) return;
  objects.forEach(o => {
    const j = stable(o);
    if (savedJson[o.id] !== j) { savedJson[o.id] = j; setDoc(doc(col('objects'), o.id), o).catch(showErr); }
  });
}
const cloudSetReport = (k, r) => setDoc(doc(col('reports'), k), r).catch(showErr);
const cloudDeleteReport = k => deleteDoc(doc(col('reports'), k)).catch(showErr);
function cloudDeleteObject(id, keys) {
  delete savedJson[id];
  const ops = keys.map(k => ({ ref: doc(col('reports'), k) }));
  ops.push({ ref: doc(col('objects'), id) });
  commitOps(ops).catch(showErr);
}
function listen(name, apply) {                                    // живая подписка: изменения с другого устройства приходят сами
  return new Promise((resolve, reject) => {
    let first = true;
    unsubs.push(onSnapshot(col(name), snap => {
      if (!first && snap.metadata.hasPendingWrites) return;         // свои же записи пропускаем
      apply(snap, first);
      if (first) { first = false; resolve(); }
    }, e => { if (first) { first = false; reject(e); } else showErr(e); }));
  });
}
function applyObjects(snap, first) {
  const list = snap.docs.map(d => d.data())
    .sort((a, b) => (a.created || 0) - (b.created || 0) || String(a.name).localeCompare(String(b.name)));
  list.forEach(o => { savedJson[o.id] = stable(o); });
  if (first) { objects = list; firstFromCache = snap.metadata.fromCache; return; }
  if (stable(list) === stable(objects)) return;
  objects = list;
  if (!objects.length) return;
  renderObjects();
  if (!curObj()) { selectObject(objects[0].id); return; }
  $('objectSelect').value = state.objId;
  if (!state.snap) renderEmps();
  renderCalc(); renderAll();
}
function applyReports(snap, first) {
  const m = {};
  snap.docs.forEach(d => { m[d.id] = d.data(); });
  if (first) { reports = m; return; }
  if (stable(m) === stable(reports)) return;
  reports = m;
  renderAll();
  $('deleteReportBtn').hidden = !reports[reportKey(state.objId, state.date)];
}
async function migrateLocal() {                                    // перенос данных из localStorage этого браузера в облако
  const lo = legacy(KEY_OBJ) || [], lr = legacy(KEY_REP) || {}, ops = [], now = Date.now();
  const newObjs = lo.map((o, i) => ({ id: o.id, name: o.name, rentPrice: num(o.rentPrice), created: now + i,
    employees: (o.employees || []).map(e => ({ id: e.id || uid(), name: e.name || '', salary: num(e.salary) })) }));
  newObjs.forEach(o => { ops.push({ ref: doc(col('objects'), o.id), data: o }); savedJson[o.id] = stable(o); });
  Object.keys(lr).forEach(k => ops.push({ ref: doc(col('reports'), k), data: lr[k] }));
  objects = objects.filter(o => !newObjs.some(n => n.id === o.id)).concat(newObjs);
  Object.assign(reports, lr);
  await commitOps(ops);
  localStorage.setItem('finance_migrated', '1');
}
async function firstRun() {                                        // облако пустое: перенос из браузера или демо-объект
  if (firstFromCache) { showErr({ message: 'нет соединения, данные не загружены. Проверьте интернет и обновите страницу' }); return false; }
  const lo = legacy(KEY_OBJ);
  if (Array.isArray(lo) && lo.length && confirm('Найдены отчёты, сохранённые в этом браузере. Перенести их в облако?')) {
    try { await migrateLocal(); } catch (e) { showErr(e); return false; }
    return true;
  }
  const d = { id: 'jungle', name: 'Джунгли', rentPrice: 80, created: Date.now(),
    employees: [{ id: 'e1', name: 'Артур', salary: 1500 }, { id: 'e2', name: 'Степа', salary: 3000 }] };
  objects = [d]; savedJson[d.id] = stable(d);
  setDoc(doc(col('objects'), d.id), d).catch(showErr);
  return true;
}

/* ================= State ================= */
const state = { objId: null, date: todayIso(), snap: null, calY: 0, calM: 0, tab: 'week' };
const reportKey = (objId, date) => objId + '_' + date;
const curObj = () => objects.find(o => o.id === state.objId) || null;

/* ================= 5. Calculations ================= */
const FEE_RATE = 0.03;                                  // комиссия терминала 3%
const round10 = n => Math.sign(n) * Math.round(Math.abs(n) / 10) * 10 || 0;   // округление до десятков: 88987 → 88990, 77953 → 77950
function calc(r) {
  const rent = r.people * r.rentPrice;
  const total = r.cash + r.terminal;
  const salary = r.employees.reduce((s, e) => s + num(e.salary), 0);
  const fee = round10(r.terminal * FEE_RATE);
  return { rent, total, salary, fee, expense: r.expense, result: round10(total - rent - r.expense - salary - fee) };
}
const getEmps = () => state.snap || curObj().employees;     // сохранённый отчёт — снимок; новый — сотрудники объекта

function readForm() {
  const o = curObj();
  return {
    objectId: o.id, objectName: o.name, date: state.date,
    people: num($('peopleInput').value), rentPrice: num($('priceInput').value),
    cash: num($('cashInput').value), terminal: num($('terminalInput').value),
    expense: num($('expenseInput').value), employees: clone(getEmps())
  };
}
function renderCalc() {
  const c = calc(readForm());
  $('rentTotal').textContent = fmt(c.rent);
  $('moneyTotal').textContent = fmt(c.total);
  $('salaryTotal').textContent = fmt(c.salary);
  $('feeTotal').textContent = fmt(c.fee);
  $('dayResult').textContent = fmt(c.result);
  $('resultCard').className = 'result ' + cls(c.result);
}

/* ================= 2. Objects ================= */
function renderObjects() {
  const sel = $('objectSelect');
  sel.innerHTML = '';
  objects.forEach(o => { const op = el('option', '', o.name); op.value = o.id; sel.appendChild(op); });
  sel.value = state.objId;
}
function selectObject(id) {
  state.objId = id;
  const o = curObj();
  $('objectSelect').value = id;
  $('setName').value = o.name;
  $('setPrice').value = o.rentPrice;
  const p = parseIso(state.date); state.calY = p.y; state.calM = p.m;
  loadDate();
}
function addObject() {
  const name = (prompt('Название нового объекта:') || '').trim();
  if (!name) return;
  const o = { id: uid(), name, rentPrice: 0, employees: [], created: Date.now() };
  objects.push(o); saveObjects(); renderObjects(); selectObject(o.id);
  $('settings').hidden = false;
}
function renameObject() {
  const o = curObj();
  const name = (prompt('Новое название объекта:', o.name) || '').trim();
  if (!name) return;
  o.name = name; saveObjects(); renderObjects(); $('objectSelect').value = o.id; $('setName').value = name; renderAll();
}
function deleteObject() {
  if (objects.length < 2) { alert('Нельзя удалить единственный объект. Сначала добавьте другой.'); return; }
  const o = curObj();
  if (!confirm('Удалить объект и все его отчёты?\n«' + o.name + '»')) return;
  const keys = Object.keys(reports).filter(k => reports[k].objectId === o.id);
  keys.forEach(k => delete reports[k]);
  objects = objects.filter(x => x.id !== o.id);
  cloudDeleteObject(o.id, keys);
  renderObjects(); selectObject(objects[0].id);
}
function saveSettings() {
  const o = curObj();
  const name = $('setName').value.trim();
  if (name) o.name = name;
  o.rentPrice = num($('setPrice').value);
  saveObjects(); renderObjects(); $('objectSelect').value = o.id;
  if (!state.snap) $('priceInput').value = o.rentPrice || '';   // сохранённые отчёты цену не меняют
  renderCalc(); renderAll();
}

/* ================= 3. Employees ================= */
function renderEmps() {
  const box = $('employeesList');
  box.innerHTML = '';
  const list = getEmps();
  if (!list.length) box.appendChild(el('div', 'empty', 'Сотрудников пока нет'));
  list.forEach(emp => {
    const row = el('div', 'emp');
    const name = el('input'); name.type = 'text'; name.value = emp.name; name.setAttribute('aria-label', 'Имя');
    const sal = el('input'); sal.type = 'number'; sal.min = 0; sal.value = emp.salary; sal.setAttribute('aria-label', 'Зарплата');
    const del = el('button', 'btn btn-danger', 'Удалить');
    name.addEventListener('input', () => { emp.name = name.value; persistEmps(); });
    sal.addEventListener('input', () => {
      if (parseFloat(sal.value) < 0) sal.value = '';
      emp.salary = num(sal.value); persistEmps(); renderCalc();
    });
    del.addEventListener('click', () => {
      if (!confirm('Удалить сотрудника «' + (emp.name || 'без имени') + '»?')) return;
      const arr = getEmps(); arr.splice(arr.indexOf(emp), 1);
      persistEmps(); renderEmps(); renderCalc();
    });
    row.append(name, sal, del);
    box.appendChild(row);
  });
}
function persistEmps() { if (!state.snap) saveObjects(); }      // снимок отчёта живёт только до «Сохранить отчёт»
function addEmployee() {
  const name = $('empNameInput').value.trim();
  if (!name) { $('empNameInput').focus(); return; }
  getEmps().push({ id: uid(), name, salary: num($('empSalaryInput').value) });
  persistEmps();
  $('empNameInput').value = ''; $('empSalaryInput').value = '';
  $('empForm').hidden = true;
  renderEmps(); renderCalc();
}

/* ================= 4. Daily reports ================= */
function fillForm(r) {
  $('peopleInput').value = r ? r.people : '';
  $('priceInput').value = r ? r.rentPrice : (curObj().rentPrice || '');
  $('cashInput').value = r ? r.cash : '';
  $('terminalInput').value = r ? r.terminal : '';
  $('expenseInput').value = r ? r.expense : '';
}
function loadDate() {                                   // открыть выбранный день выбранного объекта
  const r = reports[reportKey(state.objId, state.date)];
  state.snap = r ? clone(r.employees) : null;
  fillForm(r);
  $('dateInput').value = state.date;
  $('status').textContent = r ? 'Сохранённый отчёт за ' + dmy(state.date) : 'Новый отчёт';
  $('deleteReportBtn').hidden = !r;
  renderEmps(); renderCalc(); renderAll();
}
function setDate(d) {
  state.date = d;
  const p = parseIso(d); state.calY = p.y; state.calM = p.m;
  loadDate();
}
function openReport(d) {                               // клик по дню календаря или по записи истории
  setDate(d);
  const c = $('reportCard');
  if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function saveReport() {
  const r = readForm(), c = calc(r);
  r.rentTotal = c.rent; r.fee = c.fee; r.totalCash = c.total; r.salaryTotal = c.salary; r.dailyResult = c.result;
  r.savedAt = new Date().toISOString();
  reports[reportKey(r.objectId, r.date)] = r;
  cloudSetReport(reportKey(r.objectId, r.date), r);
  loadDate();
  $('status').textContent = 'Отчёт за ' + dmy(state.date) + ' сохранён';
}
function clearForm() {                                  // только несохранённая форма
  state.snap = null; fillForm(null);
  $('status').textContent = 'Новый отчёт (форма очищена)';
  renderEmps(); renderCalc();
}
function deleteReport() {
  if (!confirm('Удалить сохранённый отчёт за ' + dmy(state.date) + '?')) return;
  const k = reportKey(state.objId, state.date);
  delete reports[k]; cloudDeleteReport(k); loadDate();
}

/* ================= 7. History helpers ================= */
function objReports() {                                 // отчёты только текущего объекта, новые первыми
  return Object.keys(reports).map(k => reports[k]).filter(r => r.objectId === state.objId)
    .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
}
function renderHistory() {
  const box = $('historyList');
  box.innerHTML = '';
  const list = objReports();
  if (!list.length) { box.appendChild(el('div', 'empty', 'Сохранённых отчётов пока нет')); return; }
  list.forEach(r => {
    const res = calc(r).result;
    const b = el('button', 'hist' + (r.date === state.date ? ' sel' : ''));
    const left = el('span'); left.append(document.createTextNode(longDate(r.date)), el('small', '', r.objectName));
    b.append(left, el('b', cls(res) === 'neg' ? 'neg-t' : cls(res) === 'pos' ? 'pos-t' : '', 'Итог: ' + fmt(res)));
    b.addEventListener('click', () => openReport(r.date));
    box.appendChild(b);
  });
}

/* ================= 6. Calendar ================= */
function renderCalendar() {
  const y = state.calY, m = state.calM, grid = $('calGrid');
  $('calTitle').textContent = MONTHS[m] + ' ' + y;
  grid.innerHTML = '';
  const has = new Set(objReports().map(r => r.date));
  const offset = (new Date(y, m, 1).getDay() + 6) % 7, n = new Date(y, m + 1, 0).getDate(), today = todayIso();
  for (let i = 0; i < offset; i++) grid.appendChild(el('span'));
  for (let d = 1; d <= n; d++) {
    const s = iso(y, m, d);
    const b = el('button', 'day' + (has.has(s) ? ' has' : '') + (s === today ? ' today' : '') + (s === state.date ? ' sel' : ''), String(d));
    b.title = has.has(s) ? 'Есть отчёт' : '';
    b.addEventListener('click', () => openReport(s));
    grid.appendChild(b);
  }
}
function shiftMonth(delta) {
  const d = new Date(state.calY, state.calM + delta, 1);
  state.calY = d.getFullYear(); state.calM = d.getMonth(); renderCalendar();
}

/* ================= 8–9. Weekly / monthly statistics (из сохранённых дней) ================= */
function summarize(list) {                              // list — дневные отчёты
  const s = { days: list.length, people: 0, fee: 0, cash: 0, terminal: 0, total: 0, rent: 0, expense: 0, salary: 0, result: 0, best: null, worst: null, byEmp: {} };
  list.forEach(r => {
    const c = calc(r);
    s.people += r.people; s.fee += c.fee; s.cash += r.cash; s.terminal += r.terminal; s.total += c.total; s.rent += c.rent;
    s.expense += c.expense; s.salary += c.salary; s.result += c.result;
    r.employees.forEach(e => {                          // зарплата каждого сотрудника
      const sal = num(e.salary), k = e.id || e.name;
      const x = s.byEmp[k] || (s.byEmp[k] = { name: e.name, days: 0, sum: 0, last: '' });
      x.sum += sal; if (sal > 0) x.days++;
      if (r.date >= x.last) { x.last = r.date; x.name = e.name; }
    });
    if (!s.best || c.result > s.best.v) s.best = { v: c.result, date: r.date };
    if (!s.worst || c.result < s.worst.v) s.worst = { v: c.result, date: r.date };
  });
  s.avg = s.days ? round10(s.result / s.days) : 0;
  return s;
}
const empList = s => Object.keys(s.byEmp).map(k => s.byEmp[k]).filter(x => x.sum > 0).sort((a, b) => b.sum - a.sum);
const inRange = (from, to) => objReports().filter(r => r.date >= from && r.date <= to);
function monthBounds(s) { const p = parseIso(s); return [iso(p.y, p.m, 1), iso(p.y, p.m, new Date(p.y, p.m + 1, 0).getDate())]; }
function cell(label, value, wide, colored) {
  const d = el('div', 'calc' + (wide ? ' wide' : ''));
  d.append(el('span', '', label), el('b', colored || '', value));
  return d;
}
function renderStats() {
  const body = $('statsBody');
  body.innerHTML = '';
  $('weekBtn').classList.toggle('active', state.tab === 'week');
  $('monthBtn').classList.toggle('active', state.tab === 'month');
  let list, title;
  if (state.tab === 'week') {
    const days = weekRange(state.date);
    list = inRange(days[0], days[6]);
    title = 'Неделя ' + dmy(days[0]) + ' – ' + dmy(days[6]);
    const wk = el('div', 'week');
    days.forEach((d, i) => {
      const r = reports[reportKey(state.objId, d)];
      const row = el('div'); row.append(el('span', '', WDW[i] + ', ' + dmy(d)));
      row.append(el('b', r ? (calc(r).result < 0 ? 'neg-t' : calc(r).result > 0 ? 'pos-t' : '') : '', r ? fmt(calc(r).result) : '—'));
      wk.appendChild(row);
    });
    body.append(el('p', 'hint', title), wk);
  } else {
    const b = monthBounds(state.date);
    list = inRange(b[0], b[1]);
    const p = parseIso(state.date);
    title = MONTHS[p.m] + ' ' + p.y;
    body.append(el('p', 'hint', title));
  }
  const s = summarize(list), g = el('div', 'sgrid'), unit = state.tab === 'week' ? 'недели' : 'месяца';
  g.append(
    cell('Дней с отчётами', String(s.days)), cell('Наличные', fmt(s.cash)),
    cell('Терминал', fmt(s.terminal)), cell('Всего', fmt(s.total)),
    cell('Аренда', fmt(s.rent)), cell('Расходы', fmt(s.expense)), cell('Комиссия 3%', fmt(s.fee)),
    cell('Зарплаты', fmt(s.salary)), cell('Средний итог за день', fmt(s.avg)),
    cell('Лучший день', s.best ? dmy(s.best.date) + ' · ' + fmt(s.best.v) : '—'),
    cell('Худший день', s.worst ? dmy(s.worst.date) + ' · ' + fmt(s.worst.v) : '—'),
    cell('Итог ' + unit, fmt(s.result), true, s.result < 0 ? 'neg-t' : s.result > 0 ? 'pos-t' : '')
  );
  body.appendChild(g);
  const emps = empList(s);
  const box = el('div', 'week');
  if (!emps.length) box.appendChild(el('div', 'empty', 'Нет данных за этот период'));
  emps.forEach(x => {
    const row = el('div');
    row.append(el('span', '', x.name || 'Без имени'), el('b', '', x.days + ' дн. · ' + fmt(x.sum)));
    box.appendChild(row);
  });
  if (emps.length) { const t = el('div'); t.append(el('span', '', 'Всего зарплат'), el('b', '', fmt(s.salary))); box.appendChild(t); }
  body.append(el('h3', '', 'Зарплаты по сотрудникам'), box);
}

/* ================= Текстовый отчёт (копируется в буфер обмена) ================= */
const n2 = n => String(Math.round(n * 100) / 100);
function blockText(name, s, withEmps) {
  const L = [name, 'Людей ' + n2(s.people), 'Аренда ' + n2(s.rent), 'Касса ' + n2(s.total), 'Нал ' + n2(s.cash),
    'Тер ' + n2(s.terminal) + ' (3%=' + n2(s.fee) + ')', 'Зп ' + n2(s.salary), 'Расход ' + n2(s.expense), 'Остаток ' + n2(s.result)];
  const emps = withEmps ? empList(s) : [];
  if (emps.length) {
    L.push('', 'Зп по сотрудникам:');
    emps.forEach(x => L.push((x.name || 'Без имени') + ' ' + n2(x.sum) + ' (' + x.days + ' дн.)'));
  }
  return L.join('\n');
}
function buildReportText(kind, onlyCur) {            // kind: day | week | month
  let from, to, title;
  if (kind === 'day') { from = to = state.date; title = 'Отчёт за ' + dmy(state.date); }
  else if (kind === 'week') { const d = weekRange(state.date); from = d[0]; to = d[6]; title = 'Неделя ' + dmy(from) + ' – ' + dmy(to); }
  else { const b = monthBounds(state.date), p = parseIso(state.date); from = b[0]; to = b[1]; title = MONTHS[p.m] + ' ' + p.y; }
  const list = Object.keys(reports).map(k => reports[k])
    .filter(r => r.date >= from && r.date <= to && (!onlyCur || r.objectId === state.objId));
  const groups = [];
  objects.forEach(o => { const l = list.filter(r => r.objectId === o.id); if (l.length) groups.push({ name: o.name, list: l }); });
  if (!groups.length) return '';
  const parts = [title];
  groups.forEach(g => parts.push(blockText(g.name, summarize(g.list), kind !== 'day')));
  if (groups.length > 1) parts.push(blockText('Всего', summarize(groups.reduce((a, g) => a.concat(g.list), [])), false));
  return parts.join('\n\n');
}
async function copyReport(kind, onlyCur, btn) {
  const text = buildReportText(kind, onlyCur);
  if (!text) { alert('Нет сохранённых отчётов за этот период.'); return; }
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch (e) {
    const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    t.remove();
  }
  if (!ok) { prompt('Скопируйте текст отчёта:', text); return; }
  const old = btn.textContent; btn.textContent = 'Скопировано ✓';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

/* ================= 10. Dashboard + chart ================= */
function renderDashboard() {
  const t = todayIso(), wk = weekRange(t), mb = monthBounds(t);
  const rt = reports[reportKey(state.objId, t)];
  const set = (id, sub, v, text) => {
    const e = $(id); e.textContent = fmt(v); e.className = 'big ' + (v < 0 ? 'neg-t' : v > 0 ? 'pos-t' : '');
    $(id + 'Sub').textContent = text;
  };
  set('dashToday', 0, rt ? calc(rt).result : 0, rt ? 'Отчёт сохранён' : 'Отчёта за сегодня нет');
  const w = summarize(inRange(wk[0], wk[6])), m = summarize(inRange(mb[0], mb[1]));
  set('dashWeek', 0, w.result, 'Дней с отчётами: ' + w.days);
  set('dashMonth', 0, m.result, 'Дней с отчётами: ' + m.days);
}
function renderChart() {
  const c = $('chart'), dpr = window.devicePixelRatio || 1, w = c.clientWidth || 600, h = 220;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
  const p = parseIso(state.date), n = new Date(p.y, p.m + 1, 0).getDate(), vals = [];
  $('chartSub').textContent = MONTHS[p.m] + ' ' + p.y + ' · итог по дням';
  for (let d = 1; d <= n; d++) { const r = reports[reportKey(state.objId, iso(p.y, p.m, d))]; vals.push(r ? calc(r).result : null); }
  const nums = vals.filter(v => v !== null);
  x.font = '12px sans-serif'; x.fillStyle = '#9a9aa5';
  if (!nums.length) { x.textAlign = 'center'; x.fillText('Нет сохранённых отчётов за этот месяц', w / 2, h / 2); return; }
  const max = Math.max(0, ...nums), min = Math.min(0, ...nums), range = (max - min) || 1;
  const L = 56, B = 22, T = 12, ph = h - B - T, y = v => T + (max - v) / range * ph, bw = (w - L - 6) / n;
  x.strokeStyle = '#2d2d35'; x.beginPath(); x.moveTo(L, y(0)); x.lineTo(w - 6, y(0)); x.stroke();
  x.textAlign = 'right';
  x.fillText(Math.round(max).toLocaleString('ru-RU'), L - 6, y(max) + 4);
  if (min < 0) x.fillText(Math.round(min).toLocaleString('ru-RU'), L - 6, y(min) + 4);
  x.fillText('0', L - 6, y(0) + 4);
  x.textAlign = 'center';
  vals.forEach((v, i) => {
    const bx = L + i * bw + bw * 0.15, ww = bw * 0.7;
    if (v !== null) {
      x.fillStyle = v < 0 ? '#ff5a5f' : '#ffc61a';
      const y0 = y(0), y1 = y(v);
      x.fillRect(bx, Math.min(y0, y1), ww, Math.max(2, Math.abs(y1 - y0)));
    }
    if (bw >= 16 || i % 2 === 0) { x.fillStyle = '#9a9aa5'; x.fillText(String(i + 1), bx + ww / 2, h - 6); }
  });
}
function renderAll() { renderCalendar(); renderHistory(); renderStats(); renderDashboard(); renderChart(); }

/* ================= Events ================= */
function bind() {
  ['peopleInput','priceInput','cashInput','terminalInput','expenseInput'].forEach(id => {
    $(id).addEventListener('input', e => {
      if (parseFloat(e.target.value) < 0) e.target.value = '';
      renderCalc();
    });
  });
  $('objectSelect').addEventListener('change', e => selectObject(e.target.value));
  $('addObjectBtn').addEventListener('click', addObject);
  $('menuBtn').addEventListener('click', e => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; });
  document.addEventListener('click', () => { $('menu').hidden = true; });
  $('renameBtn').addEventListener('click', renameObject);
  $('settingsBtn').addEventListener('click', () => { $('setName').value = curObj().name; $('setPrice').value = curObj().rentPrice; $('settings').hidden = false; });
  $('deleteObjectBtn').addEventListener('click', deleteObject);
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('closeSettingsBtn').addEventListener('click', () => { $('settings').hidden = true; });
  $('setPrice').addEventListener('input', e => { if (parseFloat(e.target.value) < 0) e.target.value = ''; });
  $('dateInput').addEventListener('change', e => setDate(e.target.value || todayIso()));
  $('toggleEmpFormBtn').addEventListener('click', () => { $('empForm').hidden = !$('empForm').hidden; if (!$('empForm').hidden) $('empNameInput').focus(); });
  $('saveEmpBtn').addEventListener('click', addEmployee);
  $('empSalaryInput').addEventListener('keydown', e => { if (e.key === 'Enter') addEmployee(); });
  $('saveReportBtn').addEventListener('click', saveReport);
  $('clearBtn').addEventListener('click', clearForm);
  $('deleteReportBtn').addEventListener('click', deleteReport);
  $('toggleCalBtn').addEventListener('click', () => {
    const box = $('historyBox'); box.hidden = !box.hidden;
    $('savedBox').hidden = !box.hidden;               // пока открыт календарь, список отчётов скрыт
    $('toggleCalBtn').textContent = box.hidden ? '📅 Открыть календарь' : '📅 Скрыть календарь';
  });
  $('prevMonthBtn').addEventListener('click', () => shiftMonth(-1));
  $('nextMonthBtn').addEventListener('click', () => shiftMonth(1));
  $('weekBtn').addEventListener('click', () => { state.tab = 'week'; renderStats(); });
  $('monthBtn').addEventListener('click', () => { state.tab = 'month'; renderStats(); });
  // кнопки копирования: если в index.html их нет (старая версия), остальное приложение всё равно работает
  [['copyDayBtn', () => 'day', false], ['copyAllBtn', () => state.tab, false], ['copyObjBtn', () => state.tab, true]].forEach(c => {
    const b = $(c[0]);
    if (b) b.addEventListener('click', () => copyReport(c[1](), c[2], b));
  });
  window.addEventListener('resize', renderChart);
}

function startUI() {
  renderObjects();
  const p = parseIso(state.date); state.calY = p.y; state.calM = p.m;
  selectObject(objects.some(o => o.id === state.objId) ? state.objId : objects[0].id);
  const lo = legacy(KEY_OBJ);
  $('importLocalBtn').hidden = !(Array.isArray(lo) && lo.length) || localStorage.getItem('finance_migrated') === '1';
}
function bindAccount() {
  $('loginBtn').addEventListener('click', async () => {
    $('loginErr').textContent = '';
    const provider = new GoogleAuthProvider();
    try { await signInWithPopup(auth, provider); }
    catch (e) {
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') signInWithRedirect(auth, provider);
      else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') $('loginErr').textContent = 'Не удалось войти: ' + (e.code || e.message);
    }
  });
  $('logoutBtn').addEventListener('click', () => { flushObjects(); signOut(auth); });
  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ objects, reports }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'finance-backup-' + todayIso() + '.json';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('importLocalBtn').addEventListener('click', async () => {
    if (!confirm('Перенести отчёты из этого браузера в облако? Объекты с теми же названиями-ключами будут обновлены.')) return;
    try { await migrateLocal(); startUI(); } catch (e) { showErr(e); }
  });
  window.addEventListener('pagehide', flushObjects);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushObjects(); });
}
bind();
bindAccount();
onAuthStateChanged(auth, async user => {
  unsubs.forEach(u => u()); unsubs = [];
  if (!user) {
    userId = null; objects = []; reports = {}; state.objId = null;
    $('login').hidden = false; $('appMain').hidden = true;
    return;
  }
  userId = user.uid;
  $('login').hidden = true; $('appMain').hidden = false; $('userEmail').textContent = user.email || '';
  try { await Promise.all([listen('objects', applyObjects), listen('reports', applyReports)]); }
  catch (e) { showErr(e); return; }
  if (!objects.length && !(await firstRun())) return;
  startUI();
});
})();
