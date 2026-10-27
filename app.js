/* Финансовый отчёт — localStorage, без сервера. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch, collectionGroup, getDocs } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

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
// Администраторы: видят данные всех пользователей (только чтение). Эта же почта указана в правилах Firestore.
const ADMIN_EMAILS = ['trone124@gmail.com'];
const KEY_OBJ = 'finance_objects', KEY_REP = 'finance_reports';   // старые ключи localStorage (только для переноса)
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
let db;
try { db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { db = getFirestore(fbApp); }
let viewUid = null, readOnly = false, isAdmin = false, profileEmail = '';
let userId = null, userName = '', objects = [], reports = {}, firstFromCache = false, unsubs = [];
const savedJson = {};
const stable = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.keys(x).sort().reduce((r, key) => (r[key] = x[key], r), {}) : x);
const col = name => collection(db, 'users', viewUid || userId, name);   // viewUid — админ смотрит данные другого пользователя
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
  if (!userId || readOnly) return;
  objects.forEach(o => {
    const j = stable(o);
    if (savedJson[o.id] !== j) { savedJson[o.id] = j; setDoc(doc(col('objects'), o.id), o).catch(showErr); }
  });
}
const cloudSetReport = (k, r) => { if (!readOnly) setDoc(doc(col('reports'), k), r).catch(showErr); };
const cloudDeleteReport = k => { if (!readOnly) deleteDoc(doc(col('reports'), k)).catch(showErr); };
function cloudDeleteObject(id, keys) {
  if (readOnly) return;
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
/* ---- Профиль: имя пользователя (хранится в облаке, показывается в шапке) ---- */
function renderUser() {
  $('greeting').textContent = userName ? 'Привет, ' + userName + '!' : '';
  $('userName').textContent = userName;
}
function applyProfile(snap) {
  if (viewUid) return;                                  // в режиме просмотра чужое имя не показываем
  const d = snap.docs.find(x => x.id === 'main');
  userName = (d && d.data().name) || '';
  profileEmail = (d && d.data().email) || '';
  renderUser();
}
function openNameScreen(canCancel) {
  $('nameInput').value = userName || (auth.currentUser && auth.currentUser.displayName) || '';
  $('nameErr').textContent = '';
  $('cancelNameBtn').hidden = !canCancel;
  $('nameScreen').hidden = false;
  $('nameInput').focus();
}
function saveName() {
  if (readOnly) return;
  const name = $('nameInput').value.trim().slice(0, 40);
  if (!name) { $('nameErr').textContent = 'Введите имя'; $('nameInput').focus(); return; }
  userName = name; renderUser();
  setDoc(doc(col('profile'), 'main'), { name, email: (auth.currentUser && auth.currentUser.email) || '' }).catch(showErr);
  $('nameScreen').hidden = true;
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
const state = { objId: null, date: todayIso(), snap: null, calY: 0, calM: 0, tab: 'week', stab: 'week', snapPrice: null, exp: [], bonus: {}, an: 'week', anAll: false };
const reportKey = (objId, date) => objId + '_' + date;
const curObj = () => objects.find(o => o.id === state.objId) || null;

/* ================= 5. Calculations ================= */
const DEF_TERM_PCT = 3, DEF_GOODS_PCT = 0;              // проценты по умолчанию; у каждого объекта и у каждого отчёта свои
const pct = v => Math.min(100, num(v));                 // процент: от 0 до 100
const termPctOf = r => r.terminalPct != null ? r.terminalPct : DEF_TERM_PCT;    // в старых отчётах процентов нет: 3% и товар 0%
const goodsPctOf = r => r.goodsPct != null ? r.goodsPct : DEF_GOODS_PCT;
const objTermPct = o => o.terminalPct != null ? o.terminalPct : DEF_TERM_PCT;
const objGoodsPct = o => o.goodsPct != null ? o.goodsPct : DEF_GOODS_PCT;
const round10 = n => Math.sign(n) * Math.round(Math.abs(n) / 10) * 10 || 0;   // округление до десятков: 88987 → 88990, 77953 → 77950
const snum = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };   // число со знаком (штраф бывает отрицательным)
const DEF_CATS = ['Бензин', 'Расходники', 'Ремонт'];       // статьи расходов по умолчанию; у каждого объекта свой список
const objCats = o => Array.isArray(o.expenseCats) ? o.expenseCats : DEF_CATS;
const expItems = r => Array.isArray(r.expenseItems) ? r.expenseItems : [];
// оплата сотрудника за день: фиксированная сумма или % от общей кассы, плюс премия / минус штраф
const empPay = (e, total) => (e.mode === 'pct' ? round10(total * num(e.pct) / 100) : num(e.salary)) + snum(e.bonus);
function calc(r) {
  const rent = r.people * r.rentPrice;
  const total = r.cash + r.terminal;
  const salary = r.employees.reduce((s, e) => s + empPay(e, total), 0);
  const bonus = r.employees.reduce((s, e) => s + snum(e.bonus), 0);
  const expense = num(r.expense) + expItems(r).reduce((s, x) => s + num(x.sum), 0);   // «прочие» + расходы по статьям
  const fee = round10(r.terminal * termPctOf(r) / 100);   // комиссия терминала = % от суммы по терминалу
  const goods = round10(total * goodsPctOf(r) / 100);     // товар = % от общей кассы (наличные + терминал)
  return { rent, total, salary, bonus, fee, goods, expense, other: num(r.expense), result: round10(total - goods - rent - expense - salary - fee) };
}
const getEmps = () => state.snap || curObj().employees;     // сохранённый отчёт — снимок; новый — сотрудники объекта

function readForm() {
  const o = curObj();
  return {
    objectId: o.id, objectName: o.name, date: state.date,
    people: num($('peopleInput').value),
    rentPrice: state.snapPrice != null ? state.snapPrice : num(curObj().rentPrice),   // цена берётся из настроек объекта; в сохранённом отчёте — на день сохранения
   
    cash: num($('cashInput').value), terminal: num($('terminalInput').value),
    expense: num($('expenseInput').value),
    expenseItems: state.exp.filter(x => num(x.sum) > 0).map(x => ({ name: String(x.name || '').trim(), sum: num(x.sum) })),
    employees: clone(getEmps()).map(e => { e.bonus = state.snap ? snum(e.bonus) : snum(state.bonus[e.id]); return e; }),
    terminalPct: pct($('termPctInput').value), goodsPct: pct($('goodsPctInput').value)
  };
}
function renderCalc() {
  const f = readForm(), c = calc(f), minus = v => '−\u00a0' + fmt(v);
  $('rentTotal').textContent = fmt(c.rent);
  $('priceView').textContent = String(Math.round(f.rentPrice * 100) / 100);
  $('moneyTotal').textContent = fmt(c.total);
  $('termShare').textContent = (c.total ? String(Math.round(f.terminal / c.total * 1000) / 10).replace('.', ',') : '0') + '%';
  $('feeTotal').textContent = fmt(c.fee);
  $('goodsTotal').textContent = fmt(c.goods);
  $('salaryTotal').textContent = fmt(c.salary);
  $('expTotal').textContent = fmt(c.expense);
  $('bonusRow').hidden = !c.bonus; $('bonusTotal').textContent = (c.bonus > 0 ? '+ ' : '− ') + fmt(Math.abs(c.bonus));
  f.employees.forEach(e => { const a = $('empAmt-' + e.id); if (a) a.textContent = '= ' + fmt(empPay(e, c.total) - snum(e.bonus)); });
  $('bdTotal').textContent = fmt(c.total); $('bdGoods').textContent = minus(c.goods); $('bdRent').textContent = minus(c.rent);
  $('bdFee').textContent = minus(c.fee); $('bdExpense').textContent = minus(c.expense); $('bdSalary').textContent = minus(c.salary);
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
  $('setTermPct').value = objTermPct(o); $('setGoodsPct').value = objGoodsPct(o); $('setCats').value = objCats(o).join(', ');
  const p = parseIso(state.date); state.calY = p.y; state.calM = p.m;
  loadDate();
}
function addObject() {
  const name = (prompt('Название нового объекта:') || '').trim();
  if (!name) return;
  const o = { id: uid(), name, rentPrice: 0, terminalPct: DEF_TERM_PCT, goodsPct: DEF_GOODS_PCT, employees: [], created: Date.now() };
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
  o.terminalPct = pct($('setTermPct').value); o.goodsPct = pct($('setGoodsPct').value);
  const seen = {}; o.expenseCats = $('setCats').value.split(/[,;\n]/).map(x => x.trim()).filter(x => x && !seen[x.toLowerCase()] && (seen[x.toLowerCase()] = 1));
  if (!state.snap) { $('termPctInput').value = o.terminalPct; $('goodsPctInput').value = o.goodsPct; }   // сохранённые отчёты свои проценты не меняют
  saveObjects(); renderObjects(); $('objectSelect').value = o.id;
  renderExp(); renderCalc(); renderAll();
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
    const pay = el('div', 'emp-pay');
    const sal = el('input'); sal.type = 'number'; sal.min = 0; sal.step = 'any'; sal.setAttribute('aria-label', 'Зарплата');
    const mode = el('select'); mode.setAttribute('aria-label', 'Вид зарплаты');
    [['fix', '₽ в день'], ['pct', '% от кассы']].forEach(m => { const o = el('option', '', m[1]); o.value = m[0]; mode.appendChild(o); });
    mode.value = emp.mode === 'pct' ? 'pct' : 'fix';
    sal.value = emp.mode === 'pct' ? (emp.pct || '') : emp.salary;
    const amt = el('span', 'emp-amt', ''); amt.id = 'empAmt-' + emp.id;
    amt.hidden = emp.mode !== 'pct';
    const bonus = el('input'); bonus.type = 'number'; bonus.step = 'any'; bonus.placeholder = 'Премия / штраф ±'; bonus.setAttribute('aria-label', 'Премия или штраф за день');
    bonus.value = (state.snap ? emp.bonus : state.bonus[emp.id]) || '';
    const del = el('button', 'btn btn-danger', 'Удалить');
    if (readOnly) { name.disabled = true; sal.disabled = true; mode.disabled = true; bonus.disabled = true; }
    name.addEventListener('input', () => { emp.name = name.value; persistEmps(); });
    sal.addEventListener('input', () => {
      if (parseFloat(sal.value) < 0) sal.value = '';
      if (emp.mode === 'pct') { emp.pct = pct(sal.value); if (parseFloat(sal.value) > 100) sal.value = 100; } else emp.salary = num(sal.value);
      persistEmps(); renderCalc();
    });
    mode.addEventListener('change', () => {
      emp.mode = mode.value; if (emp.mode === 'pct' && emp.pct == null) emp.pct = 0;
      persistEmps(); renderEmps(); renderCalc();
    });
    bonus.addEventListener('input', () => {
      if (state.snap) emp.bonus = snum(bonus.value); else state.bonus[emp.id] = snum(bonus.value);   // премия/штраф относится только к этому дню
      renderCalc();
    });
    del.addEventListener('click', () => {
      if (!confirm('Удалить сотрудника «' + (emp.name || 'без имени') + '»?')) return;
      const arr = getEmps(); arr.splice(arr.indexOf(emp), 1);
      persistEmps(); renderEmps(); renderCalc();
    });
    pay.append(sal, mode, amt);
    row.append(name, pay, bonus, del);
    box.appendChild(row);
  });
}
function renderExp() {
  const box = $('expList'); box.innerHTML = '';
  const dl = $('catList'); dl.innerHTML = '';
  objCats(curObj()).forEach(c => { const o = el('option'); o.value = c; dl.appendChild(o); });
  if (!state.exp.length) box.appendChild(el('div', 'empty', 'Статей пока нет — добавьте бензин, расходники и т. п.'));
  state.exp.forEach(x => {
    const row = el('div', 'exp');
    const name = el('input'); name.type = 'text'; name.setAttribute('list', 'catList'); name.placeholder = 'Статья (например, бензин)'; name.value = x.name || ''; name.setAttribute('aria-label', 'Статья расходов');
    const sum = el('input'); sum.type = 'number'; sum.min = 0; sum.step = 'any'; sum.placeholder = 'Сумма'; sum.value = x.sum || ''; sum.setAttribute('aria-label', 'Сумма расхода');
    const del = el('button', 'btn btn-danger icon', '✕'); del.setAttribute('aria-label', 'Удалить статью');
    if (readOnly) { name.disabled = true; sum.disabled = true; }
    name.addEventListener('input', () => { x.name = name.value; });
    sum.addEventListener('input', () => { if (parseFloat(sum.value) < 0) sum.value = ''; x.sum = num(sum.value); renderCalc(); });
    del.addEventListener('click', () => { state.exp.splice(state.exp.indexOf(x), 1); renderExp(); renderCalc(); });
    row.append(name, sum, del); box.appendChild(row);
  });
}
function addExp() {
  state.exp.push({ id: uid(), name: '', sum: '' }); renderExp();
  const ins = $('expList').querySelectorAll('.exp'); const last = ins[ins.length - 1]; if (last) last.querySelector('input').focus();
}
function persistEmps() { if (!state.snap) saveObjects(); }      // снимок отчёта живёт только до «Сохранить отчёт»
function addEmployee() {
  const name = $('empNameInput').value.trim();
  if (!name) { $('empNameInput').focus(); return; }
  const pc = $('empModeInput').value === 'pct', v = $('empSalaryInput').value;
  getEmps().push(pc ? { id: uid(), name, salary: 0, mode: 'pct', pct: pct(v) } : { id: uid(), name, salary: num(v) });
  persistEmps();
  $('empNameInput').value = ''; $('empSalaryInput').value = '';
  $('empForm').hidden = true;
  renderEmps(); renderCalc();
}

/* ================= 4. Daily reports ================= */
function fillForm(r) {
  $('peopleInput').value = r ? r.people : '';
  $('cashInput').value = r ? r.cash : '';
  $('terminalInput').value = r ? r.terminal : '';
  $('expenseInput').value = r ? r.expense : '';
  $('termPctInput').value = r ? termPctOf(r) : objTermPct(curObj());      // сохранённый отчёт — свои проценты; новый — проценты объекта
  $('goodsPctInput').value = r ? goodsPctOf(r) : objGoodsPct(curObj());
}
function loadDate() {                                   // открыть выбранный день выбранного объекта
  const r = reports[reportKey(state.objId, state.date)];
  state.snap = r ? clone(r.employees) : null;
  state.snapPrice = r ? r.rentPrice : null;
  state.exp = r ? clone(expItems(r)) : []; state.bonus = {};
  fillForm(r);
  $('dateInput').value = state.date;
  $('status').textContent = r ? 'Сохранённый отчёт за ' + dmy(state.date) : 'Новый отчёт';
  $('deleteReportBtn').hidden = !r;
  renderEmps(); renderExp(); renderCalc(); renderAll();
}
function setDate(d) {
  state.date = d;
  const p = parseIso(d); state.calY = p.y; state.calM = p.m;
  loadDate();
}
function openReport(d) {                               // клик по дню календаря или по записи истории
  setDate(d);
  showPage(1);                                          // календарь и история теперь на странице «Отчёты»
  const c = $('reportCard');
  if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function saveReport() {
  const r = readForm(), c = calc(r);
  r.rentTotal = c.rent; r.fee = c.fee; r.goods = c.goods; r.totalCash = c.total; r.salaryTotal = c.salary; r.dailyResult = c.result;
  r.savedAt = new Date().toISOString();
  reports[reportKey(r.objectId, r.date)] = r;
  cloudSetReport(reportKey(r.objectId, r.date), r);
  const ob = curObj(), cats = objCats(ob).slice();
  r.expenseItems.forEach(x => { if (x.name && !cats.some(c => c.toLowerCase() === x.name.toLowerCase())) cats.push(x.name); });   // новая статья попадает в список подсказок
  if (cats.length !== objCats(ob).length) { ob.expenseCats = cats; saveObjects(); }
  loadDate();
  $('status').textContent = 'Отчёт за ' + dmy(state.date) + ' сохранён';
  celebrate('save'); flash($('saveReportBtn')); flash($('resultCard'));
}
/* ---- Анимации-подтверждения: золотой перелив + галочка, которая появляется и исчезает ---- */
function celebrate(kind) {
  const fx = $('fx'); if (!fx) return;
  fx.className = ''; void fx.offsetWidth;                  // перезапуск анимации, если нажали повторно
  fx.className = 'go ' + (kind || 'save');
  clearTimeout(celebrate.t); celebrate.t = setTimeout(() => { fx.className = ''; }, 2200);
  haptic(kind === 'copy' ? 60 : [70, 60, 110]);
}
/* Тактильный отклик. Android/Chrome — navigator.vibrate. iPhone (Safari) этот метод не поддерживает совсем,
   поэтому там используется скрытый переключатель: iOS 17.4+ даёт при его нажатии лёгкий «тык». */
function haptic(p) {
  try { if (navigator.vibrate && navigator.vibrate(p || 12)) return; } catch (e) {}
  try {
    const l = $('hapt'); if (!l) return;
    const n = Array.isArray(p) ? Math.ceil(p.length / 2) : 1;
    l.click();
    for (let i = 1; i < n; i++) setTimeout(() => l.click(), i * 110);
  } catch (e) {}
}
/* Переключатель Неделя/Месяц: содержимое «влетает» со стороны, куда сдвинулась пилюля, график растёт заново */
function swapAnim(el, dir) {
  if (!el) return;
  const items = [];
  Array.from(el.children).forEach(c => { if (/\b(sgrid|week)\b/.test(c.className)) items.push.apply(items, c.children); else items.push(c); });
  items.forEach(c => c.classList.remove('swin-l', 'swin-r'));
  void el.offsetWidth;
  items.forEach((c, i) => { c.style.setProperty('--d', Math.min(i, 14) * 38 + 'ms'); c.classList.add(dir > 0 ? 'swin-l' : 'swin-r'); });
  clearTimeout(swapAnim.t); swapAnim.t = setTimeout(() => items.forEach(c => c.classList.remove('swin-l', 'swin-r')), 1200);
}
function switchPeriod(kind, val) {
  const same = state[kind] === val, dir = val === 'month' ? 1 : -1;
  state[kind] = val;
  if (kind === 'tab') { renderStats(); if (!same) swapAnim($('statsBody'), dir); }
  else { renderSalaries(); if (!same) swapAnim($('salaryBody'), dir); }
  if (!same) haptic(35);
}
/* Проверка вибрации: показывает, что поддерживает именно этот телефон и браузер */
function hapticDiag() {
  const ua = navigator.userAgent || '';
  const ios = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const has = typeof navigator.vibrate === 'function';
  const out = ['Устройство: ' + (ios ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : 'компьютер или другое')];
  out.push('Вибрация в браузере: ' + (has ? 'поддерживается' : 'не поддерживается'));
  if (has) {
    let ok = false;
    try { ok = navigator.vibrate([250, 120, 250]); } catch (e) {}
    out.push('Запуск вибрации: ' + (ok ? 'принят, телефон должен дважды вздрогнуть' : 'браузер отклонил'));
  } else {
    let done = false;
    try { const l = $('hapt'); if (l) { l.click(); setTimeout(() => l.click(), 150); setTimeout(() => l.click(), 300); done = true; } } catch (e) {}
    out.push(done ? 'Отправлено три «тыка» через переключатель (работает в Safari на iOS 17.4 и новее)' : 'Запасной способ недоступен');
    if (ios) out.push('На iPhone вибрация работает только в Safari; в Chrome и во встроенных браузерах мессенджеров её нет.');
  }
  if (has) out.push('Если телефон не вздрогнул: проверьте беззвучный режим, экономию заряда и «Вибрация при касании» в настройках телефона.');
  const box = $('hapticInfo'); box.hidden = false; box.textContent = out.join('\n');
}
function flash(el) {
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}
function clearForm() {                                  // только несохранённая форма
  state.snap = null; state.snapPrice = null; state.exp = []; state.bonus = {}; fillForm(null);
  $('status').textContent = 'Новый отчёт (форма очищена)';
  renderEmps(); renderExp(); renderCalc();
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
  const s = { days: list.length, people: 0, fee: 0, goods: 0, tp: {}, gp: {}, cash: 0, terminal: 0, total: 0, rent: 0, expense: 0, other: 0, bonus: 0, salary: 0, result: 0, best: null, worst: null, byEmp: {}, cats: {} };
  list.forEach(r => {
    const c = calc(r);
    s.people += r.people; s.fee += c.fee; s.goods += c.goods;
    if (r.terminal > 0) s.tp[String(termPctOf(r))] = 1;     // какие проценты были в периоде (для подписи в тексте отчёта)
    if (c.total > 0) s.gp[String(goodsPctOf(r))] = 1; s.cash += r.cash; s.terminal += r.terminal; s.total += c.total; s.rent += c.rent;
    s.expense += c.expense; s.other += c.other; s.bonus += c.bonus; s.salary += c.salary; s.result += c.result;
    expItems(r).forEach(i => { const n = (i.name || '').trim() || 'Без статьи', k = n.toLowerCase(); const z = s.cats[k] || (s.cats[k] = { name: n, sum: 0 }); z.sum += num(i.sum); });
    r.employees.forEach(e => {                          // зарплата каждого сотрудника (с процентом от кассы, премиями и штрафами)
      const sal = empPay(e, c.total), k = e.id || e.name;
      const x = s.byEmp[k] || (s.byEmp[k] = { name: e.name, days: 0, sum: 0, bonus: 0, last: '' });
      x.sum += sal; x.bonus += snum(e.bonus); if (sal !== 0) x.days++;
      if (r.date >= x.last) { x.last = r.date; x.name = e.name; }
    });
    if (!s.best || c.result > s.best.v) s.best = { v: c.result, date: r.date };
    if (!s.worst || c.result < s.worst.v) s.worst = { v: c.result, date: r.date };
  });
  s.avg = s.days ? round10(s.result / s.days) : 0;
  return s;
}
const empList = s => Object.keys(s.byEmp).map(k => s.byEmp[k]).filter(x => x.sum !== 0).sort((a, b) => b.sum - a.sum);
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
  $('weekBtn').parentNode.classList.toggle('is-month', state.tab === 'month');
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
    cell('Аренда', fmt(s.rent)), cell('Расходы', fmt(s.expense)), cell('Комиссия терминала', fmt(s.fee)), cell('Товар', fmt(s.goods)),
    cell('Зарплаты', fmt(s.salary)), cell('Средний итог за день', fmt(s.avg)),
    cell('Лучший день', s.best ? dmy(s.best.date) + ' · ' + fmt(s.best.v) : '—'),
    cell('Худший день', s.worst ? dmy(s.worst.date) + ' · ' + fmt(s.worst.v) : '—'),
    cell('Итог ' + unit, fmt(s.result), true, s.result < 0 ? 'neg-t' : s.result > 0 ? 'pos-t' : '')
  );
  body.appendChild(g);
}

/* ================= Страница 3: зарплаты (неделя / месяц) ================= */
function renderSalaries() {
  const body = $('salaryBody');
  body.innerHTML = '';
  $('salWeekBtn').classList.toggle('active', state.stab === 'week');
  $('salMonthBtn').classList.toggle('active', state.stab === 'month');
  $('salWeekBtn').parentNode.classList.toggle('is-month', state.stab === 'month');
  let from, to, title;
  if (state.stab === 'week') { const d = weekRange(state.date); from = d[0]; to = d[6]; title = 'Неделя ' + dmy(from) + ' – ' + dmy(to); }
  else { const bnd = monthBounds(state.date), p = parseIso(state.date); from = bnd[0]; to = bnd[1]; title = MONTHS[p.m] + ' ' + p.y; }
  const s = summarize(inRange(from, to));
  const g = el('div', 'sgrid');
  g.append(cell('Всего зарплат', fmt(s.salary), true, 'pos-t'));
  body.append(el('p', 'hint', title), g);
  const emps = empList(s);
  const box = el('div', 'week');
  if (!emps.length) box.appendChild(el('div', 'empty', 'Нет данных за этот период'));
  emps.forEach(x => {
    const row = el('div');
    row.append(el('span', '', x.name || 'Без имени'), el('b', '', x.days + ' дн. · ' + fmt(x.sum) + (x.bonus ? ' (' + (x.bonus > 0 ? 'премии +' : 'штрафы −') + fmt(Math.abs(x.bonus)) + ')' : '')));
    box.appendChild(row);
  });
  body.append(el('h3', '', 'По сотрудникам'), box);
}

/* ================= Текстовый отчёт (копируется в буфер обмена) ================= */
const n2 = n => String(Math.round(n * 100) / 100);
function blockText(name, s, withEmps) {
  const pl = (set, amount, base) => { const k = Object.keys(set); return k.length === 1 ? k[0] : n2(base ? Math.round(amount / base * 1000) / 10 : 0); };
  const L = [name, 'Людей ' + n2(s.people), 'Аренда ' + n2(s.rent), 'Касса ' + n2(s.total), 'Нал ' + n2(s.cash),
    'Тер ' + n2(s.terminal) + ' (' + pl(s.tp, s.fee, s.terminal) + '%=' + n2(s.fee) + ')'];
  if (s.goods > 0) L.push('Товар ' + n2(s.total) + ' (' + pl(s.gp, s.goods, s.total) + '%=' + n2(s.goods) + ')');
  L.push('Зп ' + n2(s.salary), 'Расход ' + n2(s.expense));
  const cl = Object.keys(s.cats).map(k => s.cats[k]).filter(z => z.sum > 0);
  if (cl.length) L.push('Статьи: ' + cl.map(z => z.name + ' ' + n2(z.sum)).join(', '));
  L.push('Остаток ' + n2(s.result));
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
  celebrate('copy');
  const old = btn.textContent; btn.textContent = 'Скопировано ✓';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

const compact = n => {                                   // 7750 → 7,8к
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  return (n / 1000).toFixed(a >= 10000 ? 0 : 1).replace('.', ',').replace(',0', '') + 'к';
};
/* ================= Аналитика ================= */
const addDaysIso = (s, n) => { const p = parseIso(s); return dateToIso(new Date(p.y, p.m, p.d + n)); };
const daysBetween = (a, b) => { const x = parseIso(a), y = parseIso(b); return Math.round((Date.UTC(y.y, y.m, y.d) - Date.UTC(x.y, x.m, x.d)) / 86400000); };
const nf = n => (Math.round(n * 100) / 100).toLocaleString('ru-RU');
const rub = n => fmt(Math.round(n));
const sg = n => n > 0 ? '+' : n < 0 ? '−' : '';
const allReports = () => Object.keys(reports).map(k => reports[k]);
const anList = (from, to) => allReports().filter(r => r.date >= from && r.date <= to && (state.anAll || r.objectId === state.objId));
function anBounds(shift) {                                // [от, до] текущего (0) или прошлого (-1) периода; неделя пт–чт
  if (state.an === 'week') { const w = weekRange(addDaysIso(state.date, 7 * shift)); return [w[0], w[6]]; }
  const p = parseIso(state.date), q = new Date(p.y, p.m + shift, 1);
  return monthBounds(iso(q.getFullYear(), q.getMonth(), 1));
}
const anTitle = b => state.an === 'week' ? dmy(b[0]) + ' – ' + dmy(b[1]) : MONTHS[parseIso(b[0]).m] + ' ' + parseIso(b[0]).y;
const avgCheck = s => s.people ? s.total / s.people : 0;      // средний чек = касса на одного человека
function deltaChip(now, was, inverse, money) {
  const d = now - was, p = was ? Math.round(d / Math.abs(was) * 1000) / 10 : null;
  const good = inverse ? d < 0 : d > 0;                  // для расходов рост — плохо
  const c = el('span', 'chip ' + (d === 0 ? 'flat' : good ? 'up' : 'down'));
  const val = money ? rub(Math.abs(d)) : nf(Math.abs(d));
  c.textContent = d === 0 ? 'без изменений' : (d > 0 ? '▲ ' : '▼ ') + val + (p !== null ? ' · ' + String(Math.abs(p)).replace('.', ',') + '%' : '');
  return c;
}
function renderCmp() {
  const bc = anBounds(0), bp = anBounds(-1);
  const a = summarize(anList(bc[0], bc[1])), b = summarize(anList(bp[0], bp[1]));
  $('cmpSub').textContent = anTitle(bc) + ' к ' + anTitle(bp) + ' · дней с отчётами: ' + a.days + ' и ' + b.days;
  const box = $('cmpBody'); box.innerHTML = '';
  if (!a.days && !b.days) { box.appendChild(el('div', 'empty', 'За эти периоды нет сохранённых отчётов')); return; }
  [['Касса', a.total, b.total, true, false], ['Итог', a.result, b.result, true, false],
   ['Расходы', a.expense, b.expense, true, true], ['Зарплаты', a.salary, b.salary, true, true],
   ['Людей', a.people, b.people, false, false], ['Средний итог за день', a.avg, b.avg, true, false],
   ['Средний чек', avgCheck(a), avgCheck(b), true, false]].forEach(r => {
    const row = el('div', 'cmp');
    row.append(el('span', 'nm', r[0]), el('b', 'now', r[3] ? rub(r[1]) : nf(r[1])),
      el('span', 'was', 'было ' + (r[3] ? rub(r[2]) : nf(r[2]))), deltaChip(r[1], r[2], r[4], r[3]));
    box.appendChild(row);
  });
}
function renderPlan() {
  const o = curObj(), pl = o.plan || {};
  [['planDay', 'day'], ['planWeek', 'week'], ['planMonth', 'month']].forEach(p => { const i = $(p[0]); if (document.activeElement !== i) i.value = pl[p[1]] || ''; });
  const box = $('planBody'); box.innerHTML = '';
  const wk = weekRange(state.date), mb = monthBounds(state.date), today = todayIso(), pm = parseIso(state.date);
  const fact = (from, to) => allReports().filter(r => r.objectId === o.id && r.date >= from && r.date <= to).reduce((s, r) => s + calc(r).total, 0);
  [{ label: 'День · ' + dmy(state.date), plan: num(pl.day), from: state.date, to: state.date, fc: false },
   { label: 'Неделя · ' + dmy(wk[0]) + ' – ' + dmy(wk[6]), plan: num(pl.week), from: wk[0], to: wk[6], fc: true },
   { label: MONTHS[pm.m] + ' ' + pm.y, plan: num(pl.month), from: mb[0], to: mb[1], fc: true }].forEach(it => {
    const f = fact(it.from, it.to), row = el('div', 'plan'), top = el('div', 'plan-top');
    const pv = it.plan ? f / it.plan * 100 : 0;
    top.append(el('b', '', it.label), el('span', '', it.plan ? rub(f) + ' из ' + rub(it.plan) + ' · ' + Math.round(pv) + '%' : rub(f) + ' · план не задан'));
    const bar = el('div', 'bar' + (it.plan && f >= it.plan ? ' done' : '')), fill = el('i'); bar.appendChild(fill);
    const len = daysBetween(it.from, it.to) + 1;
    const elapsed = today > it.to ? len : today < it.from ? 0 : daysBetween(it.from, today) + 1;
    const live = it.fc && elapsed > 0 && elapsed < len;     // период идёт прямо сейчас
    if (live && it.plan) { const mk = el('span', 'mark'); mk.style.left = (elapsed / len * 100) + '%'; bar.appendChild(mk); }
    row.append(top, bar);
    const note = el('div', 'plan-note'), parts = [];
    if (it.plan) parts.push(f >= it.plan ? '<span class="ok">План выполнен</span>, сверх плана <b>' + rub(f - it.plan) + '</b>' : 'Осталось до плана: <b>' + rub(it.plan - f) + '</b>');
    if (live) {
      const fc = f / elapsed * len;                       // прогноз по текущему темпу: выручка за прошедшие дни ÷ их число × длина периода
      parts.push('Прогноз к концу периода: <b>' + rub(fc) + '</b>' + (it.plan ? (fc >= it.plan ? ' — <span class="ok">хватит с запасом ' + rub(fc - it.plan) + '</span>' : ' — <span class="bad">не хватит ' + rub(it.plan - fc) + '</span>') : ''));
    }
    if (parts.length) { note.innerHTML = parts.join('<br>'); row.appendChild(note); }
    box.appendChild(row);
    requestAnimationFrame(() => { fill.style.width = Math.min(100, pv) + '%'; });
  });
}
function renderEff() {
  const b = anBounds(0), s = summarize(anList(b[0], b[1])), box = $('effBody');
  $('effSub').textContent = anTitle(b) + ' · дней с отчётами: ' + s.days;
  box.innerHTML = '';
  if (!s.days) { box.appendChild(el('div', 'empty', 'За этот период нет сохранённых отчётов')); return; }
  const g = el('div', 'eff');
  g.append(cell('Средний чек (касса на человека)', rub(avgCheck(s))), cell('Чистыми на человека', rub(s.people ? s.result / s.people : 0)),
    cell('Людей в день', nf(Math.round(s.people / s.days * 10) / 10)), cell('Касса в день', rub(s.total / s.days)));
  box.appendChild(g);
}
const WDAT = ['понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам', 'воскресеньям'];
function renderWd() {
  const to = state.date, list = anList(addDaysIso(to, -90), to), box = $('wdBody');
  $('wdSub').textContent = 'Средний итог по дням недели за последние 90 дней · дней с отчётами: ' + list.length;
  box.innerHTML = '';
  const acc = [0, 1, 2, 3, 4, 5, 6].map(() => ({ sum: 0, n: 0 })); let all = 0;
  list.forEach(r => { const p = parseIso(r.date), i = (new Date(p.y, p.m, p.d).getDay() + 6) % 7, v = calc(r).result; acc[i].sum += v; acc[i].n++; all += v; });
  const have = acc.map((a, i) => ({ i, n: a.n, avg: a.n ? a.sum / a.n : 0 })).filter(x => x.n);
  if (have.length < 2) { box.appendChild(el('div', 'empty', 'Нужны отчёты хотя бы за два разных дня недели')); return; }
  const mean = all / list.length, best = have.reduce((a, x) => x.avg > a.avg ? x : a), worst = have.reduce((a, x) => x.avg < a.avg ? x : a);
  const mx = Math.max.apply(null, have.map(x => Math.abs(x.avg)).concat(1));
  [4, 5, 6, 0, 1, 2, 3].forEach(i => {                      // порядок как в рабочей неделе: пт … чт
    const x = have.find(h => h.i === i);
    const row = el('div', 'wd' + (x && x.i === best.i ? ' best' : x && x.i === worst.i && best.i !== worst.i ? ' worst' : '') + (x && x.avg < 0 ? ' neg' : ''));
    const tr = el('div', 'tr'), fill = el('i'); tr.appendChild(fill);
    const v = el('b', '', x ? rub(x.avg) : '—'); if (x) v.appendChild(el('small', '', x.n + ' дн.'));
    row.append(el('span', 'd', WD[i]), tr, v); box.appendChild(row);
    if (x) requestAnimationFrame(() => { fill.style.width = Math.max(3, Math.abs(x.avg) / mx * 100) + '%'; });
  });
  const say = el('div', 'wd-say'), pc = d => mean ? ' (' + sg(d) + Math.abs(Math.round(d / Math.abs(mean) * 100)) + '%)' : '';
  if (best.avg - mean > 0) say.appendChild(el('p', '', 'По ' + WDAT[best.i] + ' вы зарабатываете чистыми в среднем ' + rub(best.avg) + ' — на ' + rub(best.avg - mean) + pc(best.avg - mean) + ' больше обычного дня.'));
  if (best.i !== worst.i && mean - worst.avg > 0) say.appendChild(el('p', '', 'Слабее всего по ' + WDAT[worst.i] + ': ' + rub(worst.avg) + ', на ' + rub(mean - worst.avg) + pc(worst.avg - mean) + ' меньше обычного дня.'));
  if (say.children.length) box.appendChild(say);
}
const PIE_COLORS = ['#ffc61a', '#6ea8fe', '#ff6b6f', '#b98cff', '#5eead4', '#ff9f0a', '#f472b6', '#a3e635', '#94a3b8', '#fb923c'];
function renderPie() {
  const b = anBounds(0), s = summarize(anList(b[0], b[1])), box = $('pieBody');
  $('pieSub').textContent = anTitle(b) + (state.anAll ? ' · все объекты' : '') + ' · из чего складывается касса';
  box.innerHTML = '';
  const parts = [['Товар', s.goods], ['Аренда', s.rent], ['Комиссия терминала', s.fee], ['Зарплаты', s.salary]];
  Object.keys(s.cats).forEach(k => parts.push([s.cats[k].name, s.cats[k].sum]));
  parts.push(['Прочие расходы', s.other]);
  const out = parts.filter(p => p[1] > 0), spent = out.reduce((a, p) => a + p[1], 0), left = s.total - spent;
  if (!s.days || (!s.total && !spent)) { box.appendChild(el('div', 'empty', 'За этот период нет данных для диаграммы')); return; }
  const items = out.map((p, i) => ({ name: p[0], v: p[1], c: PIE_COLORS[i % PIE_COLORS.length] }));
  if (left > 0) items.push({ name: 'Остаётся (итог)', v: left, c: '#3ddc84' });
  const den = Math.max(s.total, spent), NS = 'http://www.w3.org/2000/svg';
  const wrap = el('div', 'pie-wrap'), pie = el('div', 'pie'), svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 42 42'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Диаграмма расходов');
  const bg = document.createElementNS(NS, 'circle'); bg.setAttribute('cx', 21); bg.setAttribute('cy', 21); bg.setAttribute('r', 15.9155);
  bg.setAttribute('fill', 'none'); bg.setAttribute('stroke', 'rgba(255,255,255,.06)'); bg.setAttribute('stroke-width', 6); svg.appendChild(bg);
  let acc = 0;
  items.forEach((it, i) => {
    const p = it.v / den * 100, c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', 'pie-seg'); c.setAttribute('cx', 21); c.setAttribute('cy', 21); c.setAttribute('r', 15.9155);
    c.setAttribute('stroke', it.c); c.setAttribute('stroke-dashoffset', -acc); const gap = items.length > 1 ? 0.4 : 0; c.style.strokeDasharray = Math.max(0, p - gap) + ' ' + (100 - Math.max(0, p - gap));
    c.style.animationDelay = (i * 0.09) + 's'; svg.appendChild(c); acc += p;
  });
  const mid = el('div', 'pie-mid'); mid.append(el('small', '', 'Ушло'), el('b', '', rub(spent)), el('small', '', 'из ' + rub(s.total)));
  pie.append(svg, mid);
  const lg = el('div', 'legend2');
  items.forEach(it => {
    const r = el('div', 'lg2'), dot = el('i'); dot.style.background = it.c;
    const val = el('b', '', rub(it.v)); val.appendChild(el('em', '', String(Math.round(it.v / den * 1000) / 10).replace('.', ',') + '%'));
    r.append(dot, el('span', '', it.name), val); lg.appendChild(r);
  });
  wrap.append(pie, lg); box.appendChild(wrap);
}
function renderAnalytics() {
  if (!curObj()) return;
  $('anWeekBtn').classList.toggle('active', state.an === 'week'); $('anMonthBtn').classList.toggle('active', state.an === 'month');
  $('anWeekBtn').parentNode.classList.toggle('is-month', state.an === 'month');
  $('anAllChk').checked = state.anAll;
  $('anSub').textContent = (state.anAll ? 'Все объекты' : curObj().name) + ' · период по дате ' + dmy(state.date);
  if (!$('expMonth').value) $('expMonth').value = state.date.slice(0, 7);
  renderCmp(); renderPlan(); renderEff(); renderWd(); renderPie();
}
function switchAn(val) {
  const same = state.an === val; state.an = val; renderAnalytics();
  if (!same) { ['cmpBody', 'effBody', 'pieBody'].forEach(id => swapAnim($(id), val === 'month' ? 1 : -1)); haptic(35); }
}

/* ---- Выгрузка за месяц: Excel (.xlsx без внешних библиотек) и PDF (через печать) ---- */
function monthData(ym) {
  const p = ym.split('-').map(Number), y = p[0], m = p[1], from = iso(y, m - 1, 1), to = iso(y, m - 1, new Date(y, m, 0).getDate()), groups = [];
  objects.forEach(o => {
    const l = allReports().filter(r => r.objectId === o.id && r.date >= from && r.date <= to).sort((a, b) => a.date < b.date ? -1 : 1);
    if (l.length) groups.push({ name: o.name, list: l, s: summarize(l) });
  });
  return { title: MONTHS[m - 1] + ' ' + y, ym, groups, all: summarize(groups.reduce((a, g) => a.concat(g.list), [])) };
}
const XH = ['Дата', 'День', 'Людей', 'Аренда', 'Наличные', 'Терминал', 'Касса', 'Комиссия терминала', 'Товар', 'Расходы', 'Зарплаты', 'Итог'];
const XS = ['Объект', 'Дней', 'Людей', 'Аренда', 'Касса', 'Комиссия терминала', 'Товар', 'Расходы', 'Зарплаты', 'Итог'];
const r2 = n => Math.round(n * 100) / 100;
function dayRow(r) {
  const c = calc(r), q = parseIso(r.date);
  return [dmy(r.date), WD[(new Date(q.y, q.m, q.d).getDay() + 6) % 7], r.people, c.rent, r.cash, r.terminal, c.total, c.fee, c.goods, c.expense, c.salary, c.result].map(v => typeof v === 'number' ? r2(v) : v);
}
const totRow = s => ['Итого', '', s.people, s.rent, s.cash, s.terminal, s.total, s.fee, s.goods, s.expense, s.salary, s.result].map(v => typeof v === 'number' ? r2(v) : v);
const sumRow = (name, s) => [name, s.days, s.people, s.rent, s.total, s.fee, s.goods, s.expense, s.salary, s.result].map(v => typeof v === 'number' ? r2(v) : v);
function catRows(s) {                                      // расходы по статьям и зарплаты по сотрудникам
  const cr = []; if (s.other > 0) cr.push(['Прочие расходы (без статьи)', r2(s.other)]);
  Object.keys(s.cats).forEach(k => cr.push([s.cats[k].name, r2(s.cats[k].sum)]));
  return { cats: cr, emps: empList(s).map(x => [x.name || 'Без имени', x.days, r2(x.sum), r2(x.bonus)]) };
}
const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC_T[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) {                                 // zip без сжатия: для xlsx этого достаточно
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  const u16 = n => [n & 255, (n >> 8) & 255], u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  files.forEach(f => {
    const nm = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data), sz = data.length;
    parts.push(new Uint8Array([0x50, 0x4b, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0].concat(u32(crc), u32(sz), u32(sz), u16(nm.length), [0, 0])), nm, data);
    cen.push(new Uint8Array([0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0].concat(u32(crc), u32(sz), u32(sz), u16(nm.length), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], u32(off))), nm);
    off += 30 + nm.length + sz;
  });
  const cs = cen.reduce((a, c) => a + c.length, 0);
  return new Blob(parts.concat(cen, [new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0].concat(u16(files.length), u16(files.length), u32(cs), u32(off), [0, 0]))]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const xe = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = i => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
function sheetXml(rows, widths) {                         // стили: 1 шапка, 2 число, 3 итог-число, 4 итог-текст, 5 заголовок
  const x = rows.map((row, ri) => '<row r="' + (ri + 1) + '">' + row.map((c, ci) => {
    if (c === null || c === undefined || c === '') return '';
    const o = typeof c === 'object' ? c : { v: c }, ref = colName(ci) + (ri + 1);
    if (typeof o.v === 'number') return '<c r="' + ref + '" s="' + (o.s != null ? o.s : 2) + '"><v>' + o.v + '</v></c>';
    return '<c r="' + ref + '" t="inlineStr"' + (o.s ? ' s="' + o.s + '"' : '') + '><is><t xml:space="preserve">' + xe(o.v) + '</t></is></c>';
  }).join('') + '</row>').join('');
  const cols = widths ? '<cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>' : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews>' + cols + '<sheetData>' + x + '</sheetData></worksheet>';
}
function makeXlsx(sheets) {
  const NSM = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', NSR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const used = {}, names = sheets.map(s => { let n = s.name.replace(/[\[\]:*?\/\\]/g, '').slice(0, 31) || 'Лист', k = n, i = 2; while (used[k.toLowerCase()]) k = n.slice(0, 28) + ' ' + i++; used[k.toLowerCase()] = 1; return k; });
  const files = [
    { name: '[Content_Types].xml', text: H + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>' },
    { name: '_rels/.rels', text: H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', text: H + '<workbook xmlns="' + NSM + '" xmlns:r="' + NSR + '"><sheets>' + names.map((n, i) => '<sheet name="' + xe(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', text: H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', text: H + '<styleSheet xmlns="' + NSM + '"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF7D56A"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color auto="1"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' }
  ];
  sheets.forEach((s, i) => files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', text: sheetXml(s.rows, s.widths) }));
  return zipStore(files);
}
const hd = a => a.map(v => ({ v, s: 1 })), tt = (a, ) => a.map((v, i) => ({ v, s: typeof v === 'number' ? 3 : 4 }));
function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function exportXlsx() {
  const ym = $('expMonth').value || state.date.slice(0, 7), d = monthData(ym);
  if (!d.groups.length) { alert('Нет сохранённых отчётов за ' + d.title + '.'); return; }
  const sheets = [{ name: 'Сводка', widths: [26, 8, 9, 12, 13, 14, 12, 12, 12, 13],
    rows: [[{ v: 'Сводка за ' + d.title, s: 5 }], [], hd(XS)].concat(d.groups.map(g => sumRow(g.name, g.s)), [tt(sumRow('Всего', d.all))]) }];
  d.groups.forEach(g => {
    const x = catRows(g.s), rows = [[{ v: g.name + ' — ' + d.title, s: 5 }], [], hd(XH)].concat(g.list.map(dayRow), [tt(totRow(g.s))]);
    if (x.cats.length) rows.push([], [{ v: 'Расходы по статьям', s: 5 }], hd(['Статья', 'Сумма'])), x.cats.forEach(c => rows.push(c));
    if (x.emps.length) rows.push([], [{ v: 'Зарплаты по сотрудникам', s: 5 }], hd(['Сотрудник', 'Дней', 'Сумма', 'в т.ч. премии/штрафы'])), x.emps.forEach(c => rows.push(c));
    sheets.push({ name: g.name, rows, widths: [26, 8, 9, 12, 13, 13, 13, 14, 12, 12, 12, 13] });
  });
  downloadBlob(makeXlsx(sheets), 'finance_report_' + ym + '.xlsx');
  celebrate('copy');
}
function printMonth() {
  const ym = $('expMonth').value || state.date.slice(0, 7), d = monthData(ym);
  if (!d.groups.length) { alert('Нет сохранённых отчётов за ' + d.title + '.'); return; }
  const area = $('printArea'); area.innerHTML = '';
  const tbl = (head, rows, totIdx, cls) => {
    const t = el('table', cls || ''), th = el('tr'); head.forEach(h => th.appendChild(el('th', '', h))); t.appendChild(th);
    rows.forEach((r, ri) => { const tr = el('tr', ri === totIdx ? 'tot' : ''); r.forEach(c => tr.appendChild(el('td', '', typeof c === 'number' ? nf(c) : String(c)))); t.appendChild(tr); });
    return t;
  };
  area.appendChild(el('h1', '', 'Финансовый отчёт — ' + d.title));
  area.appendChild(el('h2', '', 'Сводка по объектам'));
  area.appendChild(tbl(XS, d.groups.map(g => sumRow(g.name, g.s)).concat([sumRow('Всего', d.all)]), d.groups.length, 'sm'));
  d.groups.forEach(g => {
    const x = catRows(g.s);
    area.appendChild(el('h2', '', g.name));
    area.appendChild(tbl(XH, g.list.map(dayRow).concat([totRow(g.s)]), g.list.length));
    if (x.cats.length) area.appendChild(tbl(['Статья расходов', 'Сумма'], x.cats, -1, 'sm'));
    if (x.emps.length) area.appendChild(tbl(['Сотрудник', 'Дней', 'Сумма', 'в т.ч. премии/штрафы'], x.emps, -1, 'sm'));
  });
  document.body.classList.add('printing');
  const off = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', off); document.removeEventListener('pointerdown', off, true); };
  window.addEventListener('afterprint', off); document.addEventListener('pointerdown', off, true);   // страховка: вернуть обычный вид, если afterprint не сработает
  setTimeout(() => window.print(), 50);
}
function renderAll() { renderCalendar(); renderHistory(); renderStats(); renderSalaries(); renderAnalytics(); }

/* ================= Страницы и нижняя панель ================= */
function showPage(n) {
  n = ([1, 2, 3, 5].indexOf(n) >= 0 || (n === 4 && isAdmin)) ? n : 1;
  [1, 2, 3, 4, 5].forEach(i => { $('page' + i).hidden = i !== n; });
  document.querySelectorAll('.nav-btn').forEach(b => {
    const on = Number(b.dataset.page) === n;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  try { localStorage.setItem('finance_page', String(n)); } catch (e) {}
  window.scrollTo(0, 0);
  if (n === 5) renderAnalytics();
  if (n === 4) loadAdmin();                            // график рисуется только когда страница видна
}

/* ================= Events ================= */
function bind() {
  ['peopleInput','cashInput','terminalInput','expenseInput'].forEach(id => {
    $(id).addEventListener('input', e => {
      if (parseFloat(e.target.value) < 0) e.target.value = '';
      renderCalc();
    });
  });
  [['termPctInput', 'terminalPct'], ['goodsPctInput', 'goodsPct']].forEach(p => $(p[0]).addEventListener('input', e => {
    if (parseFloat(e.target.value) < 0) e.target.value = '';
    if (parseFloat(e.target.value) > 100) e.target.value = 100;
    if (!state.snap && !readOnly) { curObj()[p[1]] = pct(e.target.value); saveObjects(); }   // у нового отчёта процент запоминается за объектом
    renderCalc();
  }));
  $('objectSelect').addEventListener('change', e => selectObject(e.target.value));
  $('addObjectBtn').addEventListener('click', addObject);
  $('menuBtn').addEventListener('click', e => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; });
  document.addEventListener('click', () => { $('menu').hidden = true; });
  $('renameBtn').addEventListener('click', renameObject);
  $('settingsBtn').addEventListener('click', () => { $('setName').value = curObj().name; $('setPrice').value = curObj().rentPrice; $('setTermPct').value = objTermPct(curObj()); $('setGoodsPct').value = objGoodsPct(curObj()); $('setCats').value = objCats(curObj()).join(', '); $('settings').hidden = false; });
  $('deleteObjectBtn').addEventListener('click', deleteObject);
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('closeSettingsBtn').addEventListener('click', () => { $('settings').hidden = true; });
  $('setPrice').addEventListener('input', e => { if (parseFloat(e.target.value) < 0) e.target.value = ''; });
  $('dateInput').addEventListener('change', e => setDate(e.target.value || todayIso()));
  $('toggleEmpFormBtn').addEventListener('click', () => { $('empForm').hidden = !$('empForm').hidden; if (!$('empForm').hidden) $('empNameInput').focus(); });
  $('saveEmpBtn').addEventListener('click', addEmployee);
  $('addExpBtn').addEventListener('click', addExp);
  $('empModeInput').addEventListener('change', e => { $('empSalaryInput').placeholder = e.target.value === 'pct' ? '% от кассы' : 'Зарплата, ₽'; });
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
  $('hapticTestBtn').addEventListener('click', hapticDiag);
  $('anWeekBtn').addEventListener('click', () => switchAn('week'));
  $('anMonthBtn').addEventListener('click', () => switchAn('month'));
  $('anAllChk').addEventListener('change', e => { state.anAll = e.target.checked; renderAnalytics(); });
  ['planDay', 'planWeek', 'planMonth'].forEach(id => $(id).addEventListener('input', () => {
    if (readOnly) return;
    const o = curObj(); o.plan = { day: num($('planDay').value), week: num($('planWeek').value), month: num($('planMonth').value) };
    saveObjects(); renderPlan();
  }));
  $('xlsxBtn').addEventListener('click', exportXlsx);
  $('pdfBtn').addEventListener('click', printMonth);
  $('weekBtn').addEventListener('click', () => switchPeriod('tab', 'week'));
  $('monthBtn').addEventListener('click', () => switchPeriod('tab', 'month'));
  // кнопки копирования: если в index.html их нет (старая версия), остальное приложение всё равно работает
  [['copyDayBtn', () => 'day', false], ['copyAllBtn', () => state.tab, false], ['copyObjBtn', () => state.tab, true]].forEach(c => {
    const b = $(c[0]);
    if (b) b.addEventListener('click', () => copyReport(c[1](), c[2], b));
  });
  $('salWeekBtn').addEventListener('click', () => switchPeriod('stab', 'week'));
  $('salMonthBtn').addEventListener('click', () => switchPeriod('stab', 'month'));
  document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => { haptic(30); showPage(Number(b.dataset.page)); }));
}

function startUI() {
  renderObjects();
  const p = parseIso(state.date); state.calY = p.y; state.calM = p.m;
  selectObject(objects.some(o => o.id === state.objId) ? state.objId : objects[0].id);
  renderUser();
  if (!userName && !viewUid) openNameScreen(false);               // первый вход: спросить имя
  const lo = legacy(KEY_OBJ);
  $('importLocalBtn').hidden = !(Array.isArray(lo) && lo.length) || localStorage.getItem('finance_migrated') === '1';
}
async function connect() {                                       // подписка на данные: свои или (для админа) выбранного пользователя
  unsubs.forEach(u => u()); unsubs = [];
  const own = !viewUid;
  try { await Promise.all([listen('objects', applyObjects), listen('reports', applyReports), own ? Promise.resolve() : null, own ? listen('profile', applyProfile) : null].filter(Boolean)); }
  catch (e) { showErr(e); return false; }
  if (own && !objects.length && !(await firstRun())) return false;
  if (!objects.length) return false;
  startUI();
  const mail = (auth.currentUser && auth.currentUser.email) || '';
  if (own && userName && profileEmail !== mail) setDoc(doc(col('profile'), 'main'), { name: userName, email: mail }).catch(showErr);
  return true;
}
function setReadonlyInputs(on) {
  ['peopleInput', 'cashInput', 'terminalInput', 'expenseInput', 'termPctInput', 'goodsPctInput', 'planDay', 'planWeek', 'planMonth'].forEach(id => { $(id).disabled = on; });
}
async function viewAs(uid, label) {                               // админ: открыть данные пользователя (только чтение)
  flushObjects();
  viewUid = uid; readOnly = true; objects = []; reports = {}; state.objId = null;
  document.body.classList.add('readonly');
  $('viewLabel').textContent = label; $('viewBanner').hidden = false;
  if (!(await connect())) { alert('У этого пользователя пока нет объектов.'); await exitView(); return; }
  setReadonlyInputs(true); renderEmps(); showPage(1);
}
async function exitView() {
  viewUid = null; readOnly = false; objects = []; reports = {}; state.objId = null;
  document.body.classList.remove('readonly'); $('viewBanner').hidden = true; setReadonlyInputs(false);
  await connect(); showPage(4);
}
async function loadAdmin() {
  const box = $('adminList');
  box.innerHTML = ''; box.appendChild(el('div', 'empty', 'Загрузка…'));
  try {
    const q = await Promise.all(['profile', 'objects', 'reports'].map(n => getDocs(collectionGroup(db, n))));
    const owner = d => d.ref.parent.parent.id, users = {};
    const u = id => users[id] || (users[id] = { id, name: '', email: '', objs: [], reps: 0, last: '' });
    q[0].docs.forEach(d => { const x = u(owner(d)), v = d.data(); x.name = v.name || ''; x.email = v.email || ''; });
    q[1].docs.forEach(d => { u(owner(d)).objs.push(d.data().name); });
    q[2].docs.forEach(d => { const x = u(owner(d)), v = d.data(); x.reps++; if ((v.date || '') > x.last) x.last = v.date; });
    const list = Object.keys(users).map(k => users[k]).sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
    box.innerHTML = '';
    if (!list.length) { box.appendChild(el('div', 'empty', 'Пользователей пока нет')); return; }
    list.forEach(x => {
      const me = x.id === userId, title = x.name || ('Без имени · ' + x.id.slice(0, 6));
      const row = el('div', 'hist user-row');
      const left = el('span');
      left.append(document.createTextNode(title + (me ? ' (вы)' : '')), el('small', '', x.email || 'почта неизвестна'),
        el('small', '', 'Объекты: ' + (x.objs.length ? x.objs.join(', ') : 'нет') + ' · отчётов: ' + x.reps + (x.last ? ' · последний ' + dmy(x.last) : '')));
      row.appendChild(left);
      if (!me) { const b = el('button', 'btn btn-primary', 'Открыть'); b.addEventListener('click', () => viewAs(x.id, title + (x.email ? ' · ' + x.email : ''))); row.appendChild(b); }
      box.appendChild(row);
    });
  } catch (e) { box.innerHTML = ''; showErr(e); }
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
  $('exitViewBtn').addEventListener('click', exitView);
  $('adminRefreshBtn').addEventListener('click', loadAdmin);
  $('saveNameBtn').addEventListener('click', saveName);
  $('nameInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveName();
    if (e.key === 'Escape' && !$('cancelNameBtn').hidden) $('nameScreen').hidden = true;
  });
  $('cancelNameBtn').addEventListener('click', () => { $('nameScreen').hidden = true; });
  $('editNameBtn').addEventListener('click', () => openNameScreen(true));
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
showPage(Number(localStorage.getItem('finance_page')) || 1);
onAuthStateChanged(auth, async user => {
  $('boot').hidden = true;                              // приложение запустилось — убираем экран загрузки
  unsubs.forEach(u => u()); unsubs = [];
  if (!user) {
    userId = null; userName = ''; objects = []; reports = {}; state.objId = null;
    viewUid = null; readOnly = false; isAdmin = false; document.body.classList.remove('readonly'); $('viewBanner').hidden = true; setReadonlyInputs(false);
    $('adminNavBtn').hidden = true; $('nameScreen').hidden = true; renderUser();
    $('login').hidden = false; $('appMain').hidden = true;
    return;
  }
  userId = user.uid;
  $('login').hidden = true; $('appMain').hidden = false; $('userEmail').textContent = user.email || '';
  isAdmin = ADMIN_EMAILS.indexOf((user.email || '').toLowerCase()) >= 0;
  $('adminNavBtn').hidden = !isAdmin;
  await connect();
});
})();
