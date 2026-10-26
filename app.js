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
const state = { objId: null, date: todayIso(), snap: null, calY: 0, calM: 0, tab: 'week', stab: 'week', snapPrice: null };
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
function calc(r) {
  const rent = r.people * r.rentPrice;
  const total = r.cash + r.terminal;
  const salary = r.employees.reduce((s, e) => s + num(e.salary), 0);
  const fee = round10(r.terminal * termPctOf(r) / 100);   // комиссия терминала = % от суммы по терминалу
  const goods = round10(total * goodsPctOf(r) / 100);     // товар = % от общей кассы (наличные + терминал)
  return { rent, total, salary, fee, goods, expense: r.expense, result: round10(total - goods - rent - r.expense - salary - fee) };
}
const getEmps = () => state.snap || curObj().employees;     // сохранённый отчёт — снимок; новый — сотрудники объекта

function readForm() {
  const o = curObj();
  return {
    objectId: o.id, objectName: o.name, date: state.date,
    people: num($('peopleInput').value),
    rentPrice: state.snapPrice != null ? state.snapPrice : num(curObj().rentPrice),   // цена берётся из настроек объекта; в сохранённом отчёте — на день сохранения
   
    cash: num($('cashInput').value), terminal: num($('terminalInput').value),
    expense: num($('expenseInput').value), employees: clone(getEmps()),
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
  $('setTermPct').value = objTermPct(o); $('setGoodsPct').value = objGoodsPct(o);
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
  if (!state.snap) { $('termPctInput').value = o.terminalPct; $('goodsPctInput').value = o.goodsPct; }   // сохранённые отчёты свои проценты не меняют
  saveObjects(); renderObjects(); $('objectSelect').value = o.id;
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
    if (readOnly) { name.disabled = true; sal.disabled = true; }
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
  if (kind === 'tab') { chartHover = -1; renderStats(); if (same) renderChart(); else { animateChart(); swapAnim($('statsBody'), dir); } }
  else { renderSalaries(); if (!same) swapAnim($('salaryBody'), dir); }
  if (!same) haptic(35);
}
let chartP = 1, chartRaf = 0;                         // прогресс роста столбиков (0..1)
function animateChart() {
  cancelAnimationFrame(chartRaf);
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) { chartP = 1; renderChart(); return; }
  const t0 = performance.now(), dur = 750;
  const tick = now => {
    const k = Math.min(1, (now - t0) / dur);
    chartP = k; renderChart();
    if (k < 1) chartRaf = requestAnimationFrame(tick); else chartP = 1;
  };
  chartP = 0; renderChart(); chartRaf = requestAnimationFrame(tick);
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
  state.snap = null; state.snapPrice = null; fillForm(null);
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
  const s = { days: list.length, people: 0, fee: 0, goods: 0, tp: {}, gp: {}, cash: 0, terminal: 0, total: 0, rent: 0, expense: 0, salary: 0, result: 0, best: null, worst: null, byEmp: {} };
  list.forEach(r => {
    const c = calc(r);
    s.people += r.people; s.fee += c.fee; s.goods += c.goods;
    if (r.terminal > 0) s.tp[String(termPctOf(r))] = 1;     // какие проценты были в периоде (для подписи в тексте отчёта)
    if (c.total > 0) s.gp[String(goodsPctOf(r))] = 1; s.cash += r.cash; s.terminal += r.terminal; s.total += c.total; s.rent += c.rent;
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
    row.append(el('span', '', x.name || 'Без имени'), el('b', '', x.days + ' дн. · ' + fmt(x.sum)));
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
  L.push('Зп ' + n2(s.salary), 'Расход ' + n2(s.expense), 'Остаток ' + n2(s.result));
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
/* ---- График «Динамика результатов»: итог по дням недели (пт–чт) или месяца ---- */
let chartGeo = null, chartHover = -1;
const compact = n => {                                   // 7750 → 7,8к
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  return (n / 1000).toFixed(a >= 10000 ? 0 : 1).replace('.', ',').replace(',0', '') + 'к';
};
const niceStep = r => { const p = Math.pow(10, Math.floor(Math.log10(r))), f = r / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
function chartModel() {
  let dates, title;
  if (state.tab === 'week') { dates = weekRange(state.date); title = 'Неделя ' + dmy(dates[0]) + ' – ' + dmy(dates[6]); }
  else {
    const p = parseIso(state.date), n = new Date(p.y, p.m + 1, 0).getDate();
    dates = []; for (let d = 1; d <= n; d++) dates.push(iso(p.y, p.m, d));
    title = MONTHS[p.m] + ' ' + p.y;
  }
  const days = dates.map(d => {
    const r = reports[reportKey(state.objId, d)], q = parseIso(d), wd = (new Date(q.y, q.m, q.d).getDay() + 6) % 7;
    return { date: d, day: q.d, mon: q.m + 1, wd: WD[wd], fri: wd === 4, r, res: r ? calc(r).result : null };
  });
  return { days, title };
}
function renderChart() {
  const c = $('chart');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth || 600, h = 280;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
  const m = chartModel(), days = m.days, data = days.filter(d => d.res !== null);
  chartGeo = null;
  const sum = summarize(data.map(d => d.r));
  $('chartSub').textContent = data.length
    ? m.title + ' · дней с отчётами: ' + data.length + ' · итого ' + fmt(sum.result) + ' · в среднем ' + fmt(sum.avg) + ' в день'
    : m.title;
  x.font = '12px Manrope,system-ui,-apple-system,"Segoe UI",sans-serif'; x.textBaseline = 'middle';
  if (!data.length) { x.fillStyle = '#9a9aa8'; x.textAlign = 'center'; x.fillText('За этот период нет сохранённых отчётов', w / 2, h / 2); return; }
  const vals = data.map(d => d.res);
  let max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const step = niceStep((max - min || 1) / 4);
  max = Math.ceil(max / step) * step; min = Math.floor(min / step) * step;
  const L = 46, R = 8, T = 26, B = state.tab === 'week' ? 38 : 26, n = days.length, bw = (w - L - R) / n, ph = h - T - B;
  const y = v => T + (max - v) / (max - min) * ph;
  chartGeo = { L, bw, n, w };
  // сетка и подписи по вертикали
  x.textAlign = 'right';
  for (let v = min; v <= max + 1e-9; v += step) {
    const yy = y(v);
    x.strokeStyle = v === 0 ? '#6a6a78' : 'rgba(255,255,255,.07)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(L, yy); x.lineTo(w - R, yy); x.stroke();
    x.fillStyle = '#9a9aa8'; x.fillText(compact(v), L - 6, yy);
  }
  // границы недель (пятница) в месячном графике
  if (state.tab === 'month') days.forEach((d, i) => { if (d.fri && i > 0) { x.strokeStyle = 'rgba(255,198,26,.18)'; x.beginPath(); x.moveTo(L + i * bw, T); x.lineTo(L + i * bw, T + ph); x.stroke(); } });
  const best = data.reduce((a, d) => d.res > a.res ? d : a, data[0]), worst = data.reduce((a, d) => d.res < a.res ? d : a, data[0]);
  const y0 = y(0);
  days.forEach((d, i) => {
    const bx = L + i * bw + bw * 0.16, ww = Math.max(3, bw * 0.68), hov = i === chartHover;
    if (d.res === null) { x.fillStyle = 'rgba(255,255,255,.12)'; x.fillRect(bx, y0 - 1, ww, 2); }
    else {
      const pi = Math.max(0, Math.min(1, chartP * 1.7 - i / n * 0.7)), ez = 1 - Math.pow(1 - pi, 3);   // каждый столбик растёт со своей задержкой
      const y1 = y0 + (y(d.res) - y0) * ez, top = Math.min(y0, y1), hh = Math.max(2, Math.abs(y1 - y0));
      const g = x.createLinearGradient(0, top, 0, top + hh);
      if (d.res >= 0) { g.addColorStop(0, hov ? '#ffe680' : '#ffd84d'); g.addColorStop(1, '#ff9f0a'); }
      else { g.addColorStop(0, '#ff4046'); g.addColorStop(1, hov ? '#ff9a9d' : '#ff6b6f'); }
      x.fillStyle = g; x.beginPath();
      if (x.roundRect) x.roundRect(bx, top, ww, hh, 4); else x.rect(bx, top, ww, hh);
      x.fill();
      if (hov) { x.strokeStyle = '#fff'; x.lineWidth = 1.5; x.stroke(); }
      const showAll = bw >= 34;                            // подписи значений: везде, если хватает места, иначе у лучшего и худшего дня
      if (showAll || d === best || d === worst || hov) {
        x.font = (d === best || d === worst ? 'bold ' : '') + '12px Manrope,system-ui,-apple-system,"Segoe UI",sans-serif';
        x.fillStyle = d === best ? '#3ddc84' : d === worst && d.res < 0 ? '#ff6b6f' : '#f6f6f8';
        x.globalAlpha = ez; x.textAlign = 'center'; x.fillText(compact(d.res), bx + ww / 2, d.res >= 0 ? top - 9 : top + hh + 10); x.globalAlpha = 1;
        x.font = '12px Manrope,system-ui,-apple-system,"Segoe UI",sans-serif';
      }
    }
    // подписи дат
    x.textAlign = 'center'; x.fillStyle = d.fri ? '#ffc61a' : '#9a9aa8';
    if (state.tab === 'week') {
      x.fillText(d.wd, bx + ww / 2, h - 24); x.font = '11px system-ui,sans-serif';
      x.fillText(pad(d.day) + '.' + pad(d.mon), bx + ww / 2, h - 10); x.font = '12px Manrope,system-ui,-apple-system,"Segoe UI",sans-serif';
    } else if (bw >= 18 || i % 2 === 0 || i === n - 1) x.fillText(String(d.day), bx + ww / 2, h - 11);
  });
  // линия среднего по дням с отчётами
  const avg = data.reduce((a, d) => a + d.res, 0) / data.length;
  x.setLineDash([6, 4]); x.strokeStyle = 'rgba(255,198,26,.85)'; x.lineWidth = 1.4;
  x.beginPath(); x.moveTo(L, y(avg)); x.lineTo(w - R, y(avg)); x.stroke(); x.setLineDash([]);
  const at = 'ср. ' + compact(avg), aw = x.measureText(at).width + 12, ay = y(avg);   // подпись среднего — на тёмной плашке справа, чтобы не сливалась со столбиками
  x.fillStyle = 'rgba(14,14,18,.92)'; x.strokeStyle = 'rgba(255,198,26,.7)'; x.lineWidth = 1; x.beginPath();
  if (x.roundRect) x.roundRect(w - R - aw - 2, ay - 10, aw, 20, 6); else x.rect(w - R - aw - 2, ay - 10, aw, 20);
  x.fill(); x.stroke(); x.textAlign = 'center'; x.fillStyle = '#ffc61a'; x.fillText(at, w - R - aw / 2 - 2, ay);
  // подсказка по выбранному дню
  const hd = days[chartHover];
  if (hd && hd.r) {
    const cc = calc(hd.r), lines = [hd.wd + ', ' + dmy(hd.date), 'Итог: ' + fmt(cc.result), 'Касса: ' + fmt(cc.total) + ' · людей ' + hd.r.people];
    x.font = '12px Manrope,system-ui,-apple-system,"Segoe UI",sans-serif';
    const tw = Math.max.apply(null, lines.map(t => x.measureText(t).width)) + 20, th = 62;
    let tx = L + chartHover * bw + bw / 2 - tw / 2; tx = Math.max(4, Math.min(w - tw - 4, tx));
    x.fillStyle = 'rgba(12,12,16,.96)'; x.strokeStyle = '#ffc61a'; x.lineWidth = 1;
    x.beginPath(); if (x.roundRect) x.roundRect(tx, 2, tw, th, 8); else x.rect(tx, 2, tw, th); x.fill(); x.stroke();
    x.textAlign = 'left'; x.fillStyle = '#9a9aa8'; x.fillText(lines[0], tx + 10, 15);
    x.fillStyle = hd.res < 0 ? '#ff6b6f' : '#3ddc84'; x.font = 'bold 12px Manrope,system-ui,-apple-system,"Segoe UI",sans-serif'; x.fillText(lines[1], tx + 10, 32);
    x.font = '12px Manrope,system-ui,-apple-system,"Segoe UI",sans-serif'; x.fillStyle = '#f6f6f8'; x.fillText(lines[2], tx + 10, 49);
  }
}
function chartPointer(e) {
  if (!chartGeo) return;
  const r = $('chart').getBoundingClientRect(), i = Math.floor((e.clientX - r.left - chartGeo.L) / chartGeo.bw);
  const k = i >= 0 && i < chartGeo.n ? i : -1;
  if (k !== chartHover) { chartHover = k; renderChart(); }
}
function renderAll() { renderCalendar(); renderHistory(); renderStats(); renderSalaries(); renderDashboard(); chartHover = -1; renderChart(); }

/* ================= Страницы и нижняя панель ================= */
function showPage(n) {
  n = ([1, 2, 3].indexOf(n) >= 0 || (n === 4 && isAdmin)) ? n : 1;
  [1, 2, 3, 4].forEach(i => { $('page' + i).hidden = i !== n; });
  document.querySelectorAll('.nav-btn').forEach(b => {
    const on = Number(b.dataset.page) === n;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  try { localStorage.setItem('finance_page', String(n)); } catch (e) {}
  window.scrollTo(0, 0);
  if (n === 2) animateChart();
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
  $('settingsBtn').addEventListener('click', () => { $('setName').value = curObj().name; $('setPrice').value = curObj().rentPrice; $('setTermPct').value = objTermPct(curObj()); $('setGoodsPct').value = objGoodsPct(curObj()); $('settings').hidden = false; });
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
  $('hapticTestBtn').addEventListener('click', hapticDiag);
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
  $('chart').addEventListener('pointermove', chartPointer);
  $('chart').addEventListener('pointerdown', chartPointer);
  $('chart').addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && chartHover !== -1) { chartHover = -1; renderChart(); } });
  window.addEventListener('resize', renderChart);
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
  ['peopleInput', 'cashInput', 'terminalInput', 'expenseInput', 'termPctInput', 'goodsPctInput'].forEach(id => { $(id).disabled = on; });
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
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => renderChart());   // перерисовать график, когда загрузится шрифт
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
