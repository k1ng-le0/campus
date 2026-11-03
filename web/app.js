/* CAU 校园通 · 前端逻辑
   纯原生 JS，无框架、无构建。数据来自同源的 bridge.py，
   bridge.py 再替浏览器去登录 newjw.cau.edu.cn。 */

'use strict';

const APP_VERSION = '0.1.7';
const KEY = {
  token: 'cau.token',
  data: 'cau.data',
  settings: 'cau.settings',
  notice: 'cau.notice',
  user: 'cau.lastUser',
};

const DAY_CN = ['一', '二', '三', '四', '五', '六', '日'];
const DEFAULT_TIMES = [
  ['08:00', '09:50'],
  ['10:10', '12:00'],
  ['14:00', '15:50'],
  ['16:10', '18:00'],
  ['19:00', '20:50'],
  ['21:00', '22:30'],
];

const TABS = ['schedule', 'study', 'notice', 'me'];
const SUBPAGES = ['calendar', 'settings', 'times'];
const SUB_PARENT = { calendar: 'schedule', settings: 'me', times: 'me' };

const $ = (id) => document.getElementById(id);
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escAttr(s) { return esc(s).replace(/'/g, '&#39;'); }

const store = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }
    catch (e) { return d; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

let TOKEN = (() => {
  const q = new URLSearchParams(location.search).get('k');
  if (q) {
    store.set(KEY.token, q);
    // 别让口令留在地址栏里（截图/投屏会漏）
    try { history.replaceState({}, '', location.pathname + location.hash); } catch (e) {}
    return q;
  }
  return store.get(KEY.token, '') || '';
})();

// ------------------------------------------------------------------ 状态

let DATA = store.get(KEY.data, null);
let CFG = Object.assign({
  startDate: '',
  semesterId: '',
  totalWeeks: 0,
  view: 'week',
  week: 0,
  times: null,
  hidden: [],
  studyView: 'exam',
  examSem: '',
  gradeTerm: '全部',
}, store.get(KEY.settings, {}));

let BOUND = null;      // null=还没问过 / true / false
let CRED = null;       // none / ok / broken
let SEMS = (DATA && DATA.semesters) ? DATA.semesters : [];
let EXAM_CACHE = {};
let NOTICE = store.get(KEY.notice, null);
let NOTICE_ALL = false;   // false = 隐藏招聘/招租/招标（默认）；true = 显示全部
let noticeLoading = false;
let CUR_PAGE = 'schedule';
let CUR_DAY = null;
let COURSE_INDEX = [];
let COURSE_SEL = null;
let syncing = false;

// ------------------------------------------------------------------ 时间

const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const mdDot = (d) => (d.getMonth() + 1) + '.' + pad2(d.getDate());
const parseYmd = (s) => {
  const p = String(s || '').split('-').map(Number);
  return (p.length === 3 && p[0]) ? new Date(p[0], p[1] - 1, p[2]) : null;
};
const addDays = (d, n) => {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
};
const today0 = () => {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
};
const mondayOf = (d) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return addDays(x, -((x.getDay() + 6) % 7));
};
const mondayAfter = (d) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const back = (x.getDay() + 6) % 7;
  return addDays(x, back === 0 ? 0 : 7 - back);
};
const fmtAgo = (ts) => {
  if (!ts) return '';
  const d = Math.floor(Date.now() / 1000) - Number(ts);
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  return Math.floor(d / 86400) + ' 天前';
};

function toast(msg, ms) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms || 2400);
}

// ------------------------------------------------------------------ 网络

async function api(path, body) {
  const headers = { 'X-Token': TOKEN };
  const opt = { method: body ? 'POST' : 'GET', headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(path, opt);
  } catch (e) {
    throw new Error('连不上本地服务，确认 bridge.py 还在运行');
  }
  if (r.status === 403) throw new Error('访问凭证不对，重新打开电脑启动窗口里那个带 ?k= 的地址');
  let j;
  try { j = await r.json(); }
  catch (e) { throw new Error('本地服务返回的不是 JSON'); }
  return j;
}

// ------------------------------------------------------------------ 学期 / 周次

/* 农大教务的学期写法：2026-2027学年秋季 / 春季 / 夏季。
   默认开学日：秋季 9/1、春季 2/20、夏季 7/1 之后最近的周一。
   这个值只是「没有校历时」的估算，用户可以在「我的 → 学期设置」里改。 */
function semesterBase(semester) {
  const s = String(semester || '');
  const m = /(\d{4})-(\d{4})\s*学年\s*(秋季|春季|夏季)/.exec(s);
  if (m) {
    const y1 = Number(m[1]);
    const y2 = Number(m[2]);
    if (m[3] === '秋季') return new Date(y1, 8, 1);
    if (m[3] === '春季') return new Date(y2, 1, 20);
    return new Date(y2, 6, 1);
  }
  // 兼容「2026-2027学年第1学期」这种写法
  const m2 = /(\d{4})-(\d{4})\s*学年\s*第?\s*([12一二])\s*学期/.exec(s);
  if (m2) {
    const y1 = Number(m2[1]);
    const y2 = Number(m2[2]);
    const term = m2[3] === '一' ? 1 : m2[3] === '二' ? 2 : Number(m2[3]);
    return term === 1 ? new Date(y1, 8, 1) : new Date(y2, 1, 20);
  }
  return null;
}

function defaultStart(semester) {
  const base = semesterBase(semester);
  if (!base) return mondayOf(today0());
  return mondayAfter(base);
}

function startDate() {
  const c = parseYmd(CFG.startDate);
  if (c) return c;
  if (DATA && DATA.semester) return defaultStart(DATA.semester);
  return mondayOf(today0());
}

function totalWeeks() {
  let n = Number(CFG.totalWeeks) || (DATA && Number(DATA.totalWeeks)) || 18;
  if (n < 1) n = 18;
  if (n > 30) n = 30;
  return n;
}

function weekOf(date) {
  const start = mondayOf(startDate());
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const n = Math.floor((d - start) / (7 * 86400000)) + 1;
  if (n < 1) return 1;
  if (n > totalWeeks()) return totalWeeks();
  return n;
}

function currentWeek() {
  return weekOf(today0());
}

function weekRange(w) {
  const mon = addDays(mondayOf(startDate()), (w - 1) * 7);
  return { mon, sun: addDays(mon, 6) };
}

function semesterLabel() {
  if (!DATA || !DATA.semester) return '未绑定';
  return DATA.semester + (DATA.semesterId ? ' · ' + totalWeeks() + ' 周' : '');
}

// ------------------------------------------------------------------ 课程工具

function times() {
  const t = CFG.times || (DATA && DATA.times) || DEFAULT_TIMES;
  if (!Array.isArray(t) || t.length < 1) return DEFAULT_TIMES;
  return t.map((x) => (Array.isArray(x) && x.length >= 2) ? [x[0], x[1]] : ['', '']);
}
function unitCount() {
  const n = (DATA && Number(DATA.unitCount)) || times().length || 6;
  return Math.max(1, Math.min(10, n));
}
function courseKey(c) {
  return [c.name, c.code, c.teacher, c.room].join('|');
}
function isHidden(c) {
  const key = c.code || c.name;
  return (CFG.hidden || []).includes(key);
}
function visibleCourses() {
  return ((DATA && DATA.courses) || []).filter((c) => !isHidden(c));
}
function coursesAt(day, period, week) {
  return visibleCourses().filter((c) =>
    (c.weeks || []).includes(week) &&
    (c.slots || []).some((s) => s.day === day && s.period === period));
}
function displayName(c) {
  return String(c.name || '').replace(/^\([^)]+\)/, '');
}
function courseColor(c) {
  let h = 0;
  const s = String(c.name || '') + String(c.code || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'c' + (h % 8);
}
function compressWeeks(weeks) {
  const arr = (weeks || []).slice().sort((a, b) => a - b);
  if (!arr.length) return '';
  const out = [];
  let a = arr[0], b = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === b + 1) { b = arr[i]; continue; }
    out.push(a === b ? String(a) : a + '-' + b);
    a = b = arr[i];
  }
  out.push(a === b ? String(a) : a + '-' + b);
  return out.join(',') + ' 周';
}
function slotsText(c) {
  return (c.slots || []).map((s) => '周' + DAY_CN[s.day] + ' 第' + (s.period + 1) + '大节').join('；');
}
function teacherFirst(c) {
  return String(c.teacher || '').split(',')[0].replace(/\*$/, '');
}

// ------------------------------------------------------------------ 今日概览

// 未夹取的学期周数。weekOf() 是给「翻周浏览」用的，会硬夹在 1..totalWeeks，
// 概览要判断「现在到底在不在学期里」，必须用真实周数：假期里它 <1 或 >totalWeeks。
function rawWeekOf(date) {
  const start = mondayOf(startDate());
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((d - start) / (7 * 86400000)) + 1;
}

function toMin(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// 把「今天」的课展开成 [{period,start,end,course}]（分钟制，按开始时间排）。
// 🔴 纯计算、不碰 DOM：todayState 依赖它，jsdom 测试直接调。
function todayLessons(now, week) {
  const day = (now.getDay() + 6) % 7;   // slots.day 里 0 = 周一
  const tms = times();
  const out = [];
  visibleCourses().forEach((c) => {
    if (!(c.weeks || []).includes(week)) return;
    (c.slots || []).forEach((s) => {
      if (s.day !== day) return;
      const t = tms[s.period];
      const a = t ? toMin(t[0]) : null;
      const b = t ? toMin(t[1]) : null;
      if (a == null || b == null || b <= a) return;
      out.push({ period: s.period, start: a, end: b, course: c });
    });
  });
  out.sort((x, y) => x.start - y.start);
  return out;
}

// 今日概览状态。纯函数：jsdom 里 mock DATA/CFG 后直接调，逐场景断言。
// mode: now=正在上 / next=今天还有课 / done=今天的课上完了 / free=今天没课 /
//       before=学期未开始 / after=学期已结束
function todayState(now) {
  if (!DATA || !Array.isArray(DATA.courses) || !DATA.courses.length) return null;
  const week = rawWeekOf(now);
  const wk = totalWeeks();
  const st = { week: week, mode: '', lesson: null, minutes: 0, exam: null, next: null };

  // 考试倒计时：和「学业-考试」同一份来源，取当前学期最近一场未开始的
  const ex = EXAM_CACHE[DATA.semesterId] || DATA.exams || null;
  const items = (ex && ex.exams) || [];
  const t0 = today0();
  st.exam = items.filter((e) => e.date && parseYmd(e.date) >= t0)[0] || null;

  if (week < 1) { st.mode = 'before'; return st; }
  if (week > wk) { st.mode = 'after'; return st; }

  const min = now.getHours() * 60 + now.getMinutes();
  const lessons = todayLessons(now, week);
  const cur = lessons.find((l) => min >= l.start && min < l.end);
  if (cur) {
    st.mode = 'now';
    st.lesson = cur;
    st.minutes = cur.end - min;
    return st;
  }
  const next = lessons.find((l) => l.start > min);
  if (next) {
    st.mode = 'next';
    st.lesson = next;
    st.minutes = next.start - min;
    return st;
  }
  // 课上完 / 今天没课：往后找 7 天里最近一节，让周末的人知道周几有课
  st.mode = lessons.length ? 'done' : 'free';
  for (let i = 1; i <= 7; i++) {
    const d = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), i);
    const w2 = rawWeekOf(d);
    if (w2 < 1 || w2 > wk) break;      // 走出学期就停
    const day2 = (d.getDay() + 6) % 7;
    const has = visibleCourses().some((c) => (c.weeks || []).includes(w2) &&
      (c.slots || []).some((s) => s.day === day2));
    if (has) { st.next = { in: i, day: day2 }; break; }
  }
  return st;
}

function renderTodayBar() {
  const bar = $('todayBar');
  if (!bar) return;
  const st = todayState(new Date());
  if (!st) { bar.hidden = true; return; }
  bar.hidden = false;
  const l = st.lesson;
  const tms = times();
  let main = '', badge = '', sub = '', now = false;
  const nextTxt = () => st.next
    ? '下节课 周' + DAY_CN[st.next.day] + (st.next.in === 1 ? '（明天）' : '（' + st.next.in + ' 天后）')
    : '这学期没课了';

  if (st.mode === 'now') {
    now = true;
    main = '正在上 · ' + esc(displayName(l.course));
    badge = '还剩 ' + st.minutes + ' 分钟';
    sub = (tms[l.period] ? tms[l.period][1] : '') + ' 下课' +
      (l.course.room ? ' · ' + esc(l.course.room) : '');
  } else if (st.mode === 'next') {
    main = '下节课 · ' + esc(displayName(l.course));
    badge = st.minutes >= 60
      ? '还有 ' + Math.floor(st.minutes / 60) + ' 小时' + (st.minutes % 60 ? ' ' + (st.minutes % 60) + ' 分' : '')
      : '还有 ' + st.minutes + ' 分钟';
    sub = (tms[l.period] ? tms[l.period][0] : '') + ' 上课' +
      (l.course.room ? ' · ' + esc(l.course.room) : '') +
      ' · 第 ' + (l.period + 1) + ' 大节';
  } else if (st.mode === 'done') {
    main = '今天的课已结束';
    sub = nextTxt();
  } else if (st.mode === 'free') {
    main = '今天没课';
    sub = st.next ? nextTxt() : '近期没有排课';
  } else if (st.mode === 'before') {
    main = '学期还没开始';
    sub = '第 1 周从 ' + ymd(weekRange(1).mon) + ' 开始，课表已就绪';
  } else if (st.mode === 'after') {
    main = '本学期课程已结束';
    sub = '新学期课表发布后，到「我的」里同步一次';
  }

  let html = '<div class="tb-top"><span class="tb-main">' + main + '</span>' +
    (badge ? '<span class="tb-badge">' + badge + '</span>' : '') + '</div>' +
    (sub ? '<div class="tb-sub">' + sub + '</div>' : '');
  if (st.exam) {
    const d = Math.round((parseYmd(st.exam.date) - today0()) / 86400000);
    const when = d === 0 ? '今天 ' + (st.exam.begin || '') : d === 1 ? '明天' : '还有 ' + d + ' 天';
    html += '<div class="tb-exam">距 <b>' + esc(st.exam.name) + '</b> 考试 ' + when +
      (st.exam.date ? '<span class="nums"> · ' + esc(st.exam.date) + '</span>' : '') + '</div>';
  }
  bar.classList.toggle('now', now);
  bar.innerHTML = html;
}

// ------------------------------------------------------------------ 页面切换

function showPage(name) {
  TABS.concat(SUBPAGES).forEach((t) => {
    const el = $('page-' + t);
    if (el) el.hidden = (t !== name);
  });
  CUR_PAGE = name;
  const hl = SUB_PARENT[name] || name;
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === hl));
}

function switchTab(name) {
  showPage(name);
  if (name === 'schedule') { renderSchedule(); window.scrollTo(0, 0); }
  if (name === 'study') { renderStudy(); window.scrollTo(0, 0); }
  if (name === 'notice') { renderNotice(); window.scrollTo(0, 0); }
  if (name === 'me') { renderMe(); window.scrollTo(0, 0); }
}

function openSub(name) {
  showPage(name);
  if (name === 'calendar') renderCalendar();
  if (name === 'settings') renderSettings();
  if (name === 'times') renderTimes();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ 课表

function renderSchedule() {
  $('semesterLabel').textContent = semesterLabel();
  renderTodayBar();
  const hasData = !!(DATA && Array.isArray(DATA.courses));
  const hasCourses = hasData && DATA.courses.length > 0;
  $('weekbar').hidden = !hasData;
  $('scheduleWrap').hidden = !hasCourses;
  $('scheduleEmpty').hidden = hasCourses;

  const stale = $('staleBar');
  if (hasData && DATA.syncedAt && (Date.now() / 1000 - DATA.syncedAt) > 12 * 3600) {
    stale.hidden = false;
    stale.textContent = '显示的是 ' + fmtAgo(DATA.syncedAt) + '同步的数据，连上教务系统后点刷新';
  } else {
    stale.hidden = true;
  }

  if (!hasCourses) {
    const title = $('scheduleEmptyTitle');
    const text = $('scheduleEmptyText');
    if (BOUND === null) {
      title.textContent = '正在检查账号…';
      text.textContent = '马上就好。';
    } else if (!BOUND) {
      title.textContent = '还没有绑定教务账号';
      text.textContent = '绑定后会自动同步课表、考试和成绩。';
    } else if (hasData) {
      title.textContent = '这学期没有课表';
      text.textContent = '教务系统里这个学期没有排课，或者你切到了未来学期。';
    } else {
      title.textContent = '还没有课表数据';
      text.textContent = '账号已绑定，点下面的按钮取一次课表。';
    }
    $('goBind1').textContent = BOUND ? (hasData ? '刷新数据' : '去同步') : '去绑定';
    return;
  }

  if (!CFG.week || CFG.week < 1 || CFG.week > totalWeeks()) {
    CFG.week = currentWeek();
    saveCfg();
  }
  const w = CFG.week;
  const r = weekRange(w);
  $('weekNum').textContent = '第 ' + w + ' 周';
  $('weekRange').textContent = mdDot(r.mon) + ' – ' + mdDot(r.sun);
  const todayW = currentWeek();
  $('todayBtn').textContent = (w === todayW) ? '本周' : '今天';

  if (CFG.view === 'day') {
    $('weekView').hidden = true;
    $('dayView').hidden = false;
    renderDayView();
  } else {
    $('weekView').hidden = false;
    $('dayView').hidden = true;
    renderWeekHead(r.mon);
    renderWeekGrid(r.mon);
  }
}

function renderWeekHead(mon) {
  let html = '<div></div>';
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const isToday = ymd(d) === ymd(today0());
    html += '<button class="day-head' + (isToday ? ' today' : '') + '" data-date="' + ymd(d) + '">' +
      '<div class="dn">周' + DAY_CN[i] + '</div>' +
      '<div class="dd">' + mdDot(d) + '</div>' +
      '</button>';
  }
  $('weekHead').innerHTML = html;
}

function sameCourseAt(c, day, period, week) {
  if (period < 0 || period >= unitCount()) return false;
  return coursesAt(day, period, week).some((x) => courseKey(x) === courseKey(c));
}

function renderWeekGrid(mon) {
  const w = CFG.week;
  const n = unitCount();
  const ts = times();
  const todayStr = ymd(today0());
  COURSE_INDEX = [];
  let html = '';
  for (let p = 0; p < n; p++) {
    const t = ts[p] || ['', ''];
    html += '<div class="gutter"><b>第' + (p + 1) + '节</b>' +
      esc(t[0]) + '<br>' + esc(t[1]) + '</div>';
    for (let d = 0; d < 7; d++) {
      const date = addDays(mon, d);
      const todayCls = ymd(date) === todayStr ? ' today-col' : '';
      const list = coursesAt(d, p, w);
      html += '<div class="slot' + todayCls + '">';
      if (list.length) {
        list.forEach((c) => {
          const idx = COURSE_INDEX.push(c) - 1;
          const top = sameCourseAt(c, d, p - 1, w);
          const bottom = sameCourseAt(c, d, p + 1, w);
          const cls = 'course-block ' + courseColor(c) +
            (top ? ' cont-top' : '') + (bottom ? ' cont-bottom' : '') +
            (list.length > 1 ? ' multi' : '');
          html += '<button class="' + cls + '" data-ci="' + idx + '">' +
            '<span class="cn">' + esc(displayName(c)) + '</span>' +
            (c.room ? '<span class="cr">' + esc(c.room) + '</span>' : '') +
            (list.length > 1 ? '<span class="more">+' + (list.length - 1) + '</span>' : '') +
            '</button>';
        });
      }
      html += '</div>';
    }
  }
  $('weekGrid').innerHTML = html;
}

function renderDayView() {
  const mon = mondayOf(addDays(mondayOf(startDate()), (CFG.week - 1) * 7));
  let d = mondayOf(CUR_DAY);
  if (ymd(d) !== ymd(mon)) d = mon;
  const day = Math.round((new Date(CUR_DAY.getFullYear(), CUR_DAY.getMonth(), CUR_DAY.getDate()) - mon) / 86400000);
  const dayIdx = Math.max(0, Math.min(6, day));
  const date = addDays(mon, dayIdx);
  const w = CFG.week;
  const ts = times();
  const n = unitCount();

  let html = '<div class="day-hero"><b>' + (date.getMonth() + 1) + '月' + date.getDate() + '日</b>' +
    '<span>周' + DAY_CN[dayIdx] + ' · 第 ' + w + ' 周</span></div>' +
    '<div class="day-list">';
  for (let p = 0; p < n; p++) {
    const t = ts[p] || ['', ''];
    const list = coursesAt(dayIdx, p, w);
    html += '<div class="day-row">' +
      '<div class="day-time"><b>' + (p + 1) + '</b>' + esc(t[0]) + '<br>' + esc(t[1]) + '</div>' +
      '<div class="day-cell' + (list.length ? '' : ' empty') + '">';
    if (!list.length) {
      html += '';
    } else {
      list.forEach((c) => {
        const idx = COURSE_INDEX.push(c) - 1;
        html += '<button class="day-course ' + courseColor(c) + '" data-ci="' + idx + '">' +
          '<div class="n">' + esc(displayName(c)) + '</div>' +
          '<div class="m">' + [c.room, teacherFirst(c)].filter(Boolean).map(esc).join(' · ') + '</div>' +
          '</button>';
      });
    }
    html += '</div></div>';
  }
  html += '</div>';
  $('dayView').innerHTML = html;
}

function openCourse(c) {
  if (!c) return;
  COURSE_SEL = c;
  const hidden = isHidden(c);
  $('courseTitle').textContent = displayName(c);
  $('courseBody').innerHTML =
    '<div class="course-detail">' +
      '<div class="cd-code">' + esc([c.code, c.classNo].filter(Boolean).join(' · ') || '课程代码未知') + '</div>' +
      '<div class="cd-rows">' +
        '<div class="cd-row"><div class="k">教师</div><div class="v">' + esc(c.teacher || '—') + '</div></div>' +
        '<div class="cd-row"><div class="k">教室</div><div class="v">' + esc(c.room || '—') + '</div></div>' +
        '<div class="cd-row"><div class="k">周次</div><div class="v">' + esc(compressWeeks(c.weeks) || '—') + '</div></div>' +
        '<div class="cd-row"><div class="k">节次</div><div class="v">' + esc(slotsText(c) || '—') + '</div></div>' +
      '</div>' +
      '<button class="btn ' + (hidden ? '' : 'danger') + ' block" id="btnHideCourse">' +
        (hidden ? '恢复这门课' : '隐藏这门课') +
      '</button>' +
      '<p class="hint tiny">隐藏的是整门课（按课程代码），这个学期所有时段一起消失。恢复在「我的」页。</p>' +
    '</div>';
  $('courseSheet').hidden = false;
}

function toggleHideCourse() {
  const c = COURSE_SEL;
  if (!c) return;
  const key = c.code || c.name;
  const arr = Array.isArray(CFG.hidden) ? CFG.hidden.slice() : [];
  const i = arr.indexOf(key);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(key);
  CFG.hidden = arr;
  saveCfg();
  $('courseSheet').hidden = true;
  renderSchedule();
  renderMe();
  toast(i >= 0 ? '已恢复这门课' : '已隐藏这门课');
}

// ------------------------------------------------------------------ 学业：考试 / 成绩 / 学分

function renderStudy() {
  const view = CFG.studyView || 'exam';
  document.querySelectorAll('#studySeg .seg-btn').forEach((b) =>
    b.classList.toggle('on', b.dataset.view === view));
  $('studyExam').hidden = view !== 'exam';
  $('studyGrade').hidden = view !== 'grade';
  $('studyCredit').hidden = view !== 'credit';
  if (view === 'exam') renderExams();
  if (view === 'grade') renderGrades();
  if (view === 'credit') renderCredit();
}

function examSemOptions() {
  const list = Array.isArray(SEMS) ? SEMS.slice() : [];
  if (!list.length) return [];
  const curIdx = Math.max(0, list.findIndex((s) => s.value === (DATA && DATA.semesterId)));
  return list.slice(curIdx, curIdx + 6);
}

function renderExamChips() {
  const opts = examSemOptions();
  if (!opts.length) { $('examChips').hidden = true; return; }
  $('examChips').hidden = false;
  $('examChips').innerHTML = opts.map((s) =>
    '<button class="chip' + (s.value === (CFG.examSem || (DATA && DATA.semesterId)) ? ' on' : '') +
    '" data-sem="' + escAttr(s.value) + '">' + esc(s.label) + '</button>').join('');
}

function renderExams() {
  if (!DATA) {
    $('examBody').innerHTML = emptyHTML('还没有考试数据', '绑定教务账号并同步后显示考试安排。', '去绑定', 'bind');
    $('examChips').hidden = true;
    return;
  }
  const sid = CFG.examSem || DATA.semesterId || '';
  const ex = EXAM_CACHE[sid] || (sid === DATA.semesterId ? DATA.exams : null);
  renderExamChips();
  if (!ex) {
    $('examBody').innerHTML = '<div class="notice-loading">正在取这一学期的考试安排…</div>';
    loadExams(sid);
    return;
  }
  if (ex.error) {
    $('examBody').innerHTML = '<div class="notice-error">' + esc(ex.error) +
      '<div style="margin-top:12px"><button class="btn small" id="examRetry">再试一次</button></div></div>';
    return;
  }
  const items = (ex.exams || []).slice();
  if (!items.length) {
    const isCurrent = sid === (DATA.semesterId || '');
    $('examBody').innerHTML = emptyHTML(
      isCurrent ? '这学期还没排考' : '这个学期没有查到考试安排',
      isCurrent
        ? '教务系统还没发布这学期的考试安排，等通知后再刷新。'
        : '教务系统可能只保留当前学期的考试；历史学期查不到不代表没考过。',
      '刷新数据', 'sync');
    return;
  }
  const today = today0();
  const upcoming = items.filter((e) => !e.date || parseYmd(e.date) >= today);
  const past = items.filter((e) => e.date && parseYmd(e.date) < today);
  const next = upcoming[0];
  let html = '';
  if (next) {
    html += '<div class="exam-summary">下一场 <b>' + esc(next.name) + '</b>' +
      (next.date ? ' · ' + esc(next.date) + ' ' + esc(next.begin || '') : '') + '</div>';
  }
  upcoming.forEach((e) => { html += examCard(e, false); });
  if (past.length) {
    html += '<div class="section-label">已经考完</div>';
    past.forEach((e) => { html += examCard(e, true); });
  }
  $('examBody').innerHTML = html;
}

function examCard(e, past) {
  const diff = e.date ? Math.round((parseYmd(e.date) - today0()) / 86400000) : null;
  let count = '';
  if (diff != null) {
    if (diff < 0) count = '已结束<small>' + e.date + '</small>';
    else if (diff === 0) count = '今天<small>' + (e.begin || '') + '</small>';
    else if (diff === 1) count = '明天<small>' + (e.begin || '') + '</small>';
    else count = '还有 ' + diff + ' 天<small>' + e.date + '</small>';
  }
  const meta = [];
  if (e.time) meta.push(esc(e.time));
  if (e.room) meta.push('考场 ' + esc(e.room));
  if (e.seat) meta.push('座位 ' + esc(e.seat));
  if (e.session) meta.push(esc(e.session));
  if (e.campus) meta.push(esc(e.campus));
  return '<div class="exam-card' + (past ? ' exam-past' : '') + '">' +
    '<div class="exam-top"><div class="exam-name">' + esc(e.name) + '</div>' +
    (count ? '<div class="exam-count">' + count + '</div>' : '') + '</div>' +
    '<div class="exam-meta">' + meta.join(' · ') + '</div>' +
    (e.note ? '<div class="exam-meta">' + esc(e.note) + '</div>' : '') +
    '</div>';
}

async function loadExams(sid) {
  if (!sid) return;
  try {
    const r = await api('/api/exams?semester=' + encodeURIComponent(sid));
    if (r && r.ok) {
      EXAM_CACHE[sid] = r;
      if (CFG.examSem === sid) renderExams();
    } else {
      EXAM_CACHE[sid] = { ok: false, error: (r && r.error) || '取考试安排失败', exams: [], published: false };
      if (CFG.examSem === sid) renderExams();
    }
  } catch (e) {
    EXAM_CACHE[sid] = { ok: false, error: e.message || String(e), exams: [], published: false };
    if (CFG.examSem === sid) renderExams();
  }
}

function scoreClass(score) {
  const n = parseFloat(score);
  if (!isNaN(n)) {
    if (n < 60) return 'bad';
    if (n < 80) return 'mid';
    return 'good';
  }
  return 'letter';
}

function renderGrades() {
  if (!DATA || !DATA.grades || !DATA.grades.courses) {
    $('gradeBody').innerHTML = emptyHTML('还没有成绩', '绑定教务账号并同步后显示已出成绩。', '去绑定', 'bind');
    return;
  }
  const g = DATA.grades;
  const s = g.summary || {};
  const courses = g.courses || [];
  if (!courses.length) {
    $('gradeBody').innerHTML = emptyHTML('还没有已出成绩', '教务系统里还没有出成绩的课程。', '刷新数据', 'sync');
    return;
  }
  const terms = (s.byTerm || []).map((x) => x.term).filter(Boolean);
  const filter = CFG.gradeTerm || '全部';
  if (filter !== '全部' && !terms.includes(filter)) CFG.gradeTerm = '全部';
  const shown = (CFG.gradeTerm && CFG.gradeTerm !== '全部')
    ? courses.filter((c) => c.term === CFG.gradeTerm) : courses;

  let html = '<div class="grade-hero">' +
    (s.weighted != null
      ? '<div class="big">' + esc(s.weighted) + ' <small>加权平均分</small></div>'
      : '<div class="big">' + esc(s.totalCredits != null ? s.totalCredits : '—') + ' <small>已获学分</small></div>') +
    '<div class="cap">' + (s.weighted != null
      ? '按百分制成绩和学分加权；等级制课程不计入'
      : '成绩以等级制为主，未计算加权平均分') + '</div>' +
    '<div class="grade-stats">' +
      '<div class="grade-stat"><b>' + esc(s.totalCredits != null ? s.totalCredits : '—') + '</b><span>已获学分</span></div>' +
      '<div class="grade-stat"><b>' + esc(s.count || courses.length) + '</b><span>门课程</span></div>' +
      '<div class="grade-stat"><b>' + esc(Object.keys(s.letters || {}).length) + '</b><span>等级种数</span></div>' +
    '</div></div>';

  html += '<div class="chips">' +
    ['全部'].concat(terms).map((t) =>
      '<button class="chip' + (t === (CFG.gradeTerm || '全部') ? ' on' : '') +
      '" data-term="' + escAttr(t) + '">' + esc(t) + '</button>').join('') + '</div>';

  const groups = {};
  shown.forEach((c) => { (groups[c.term || '未知学期'] = groups[c.term || '未知学期'] || []).push(c); });
  const termOrder = (s.byTerm || []).map((x) => x.term);
  const order = Object.keys(groups).sort((a, b) => {
    const ia = termOrder.indexOf(a);
    const ib = termOrder.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    return b.localeCompare(a);
  });
  if (!order.length) {
    html += '<div class="notice-loading">这个学期还没有已出成绩。</div>';
  } else {
    order.forEach((term) => {
      const list = groups[term];
      const cred = list.reduce((n, c) => n + (Number(c.credit) || 0), 0);
      html += '<div class="term-block"><div class="term-head"><b>' + esc(term) + '</b>' +
        '<span>' + list.length + ' 门 · ' + (Math.round(cred * 100) / 100) + ' 学分</span></div>';
      list.forEach((c) => {
        const cls = scoreClass(c.score);
        html += '<div class="grade-row"><div class="grade-main">' +
          '<div class="grade-name">' + esc(c.name) + '</div>' +
          '<div class="grade-sub">' + esc([c.credit ? c.credit + ' 学分' : '', c.attr, c.way].filter(Boolean).join(' · ')) + '</div>' +
          '</div><div class="grade-score ' + cls + '">' + esc(c.score || '—') + '</div></div>';
      });
      html += '</div>';
    });
  }
  html += '<p class="hint tiny" style="padding:4px">只统计已出成绩的课程；在读课程不计入。</p>';
  $('gradeBody').innerHTML = html;
}

function renderCredit() {
  if (!DATA || !DATA.grades || !DATA.grades.summary) {
    $('creditBody').innerHTML = emptyHTML('还没有学分数据', '成绩同步后按学期统计已获学分。', '去绑定', 'bind');
    return;
  }
  const s = DATA.grades.summary;
  const by = s.byTerm || [];
  const total = s.totalCredits || 0;
  const max = Math.max(1, ...by.map((x) => x.credits || 0));
  let html = '<div class="grade-hero"><div class="big">' + esc(total) + ' <small>已获学分</small></div>' +
    '<div class="cap">按已出成绩的课程统计，不含在读课程和培养计划要求学分</div>' +
    '<div class="grade-stats"><div class="grade-stat"><b>' + esc(s.count || 0) + '</b><span>门课程</span></div>' +
    '<div class="grade-stat"><b>' + esc(by.length) + '</b><span>个学期</span></div></div></div>';
  if (!by.length) {
    html += '<div class="notice-loading">还没有可统计的学期。</div>';
  } else {
    html += '<div class="card"><div class="card-title"><b>每学期学分</b><span>已出成绩</span></div><div class="credit-bars">';
    by.forEach((x) => {
      const pct = Math.max(2, Math.round((x.credits || 0) / max * 100));
      html += '<div><div class="credit-bar-head"><span>' + esc(x.term) + '</span><b>' +
        (Math.round((x.credits || 0) * 100) / 100) + '</b></div>' +
        '<div class="credit-track"><div class="credit-fill" style="width:' + pct + '%"></div></div></div>';
    });
    html += '</div></div>';
  }
  $('creditBody').innerHTML = html;
}

// ------------------------------------------------------------------ 公告

function renderNotice() {
  const body = $('noticeBody');
  if (!NOTICE) {
    body.innerHTML = '<div class="notice-loading">正在取学校通知…</div>';
    loadNotice(false);
    return;
  }
  const d = NOTICE.data || {};
  const items = d.items || [];
  /* 校内通知（实验室管理处 / 团委 / 图书馆 / 基建处那些）只在综合服务平台里，
     要登录才能看。App 里在门户那个 WebView 登录一次，它会把列表抓回来存本机，
     这里读出来排在最上面；网页版没有这个能力，读到空就不显示。 */
  const pn = portalNotices();
  let html = '<button class="notice-portal" data-action="portal">' +
    '<span class="notice-portal-t">校内通知（综合服务平台）</span>' +
    '<span class="notice-portal-s">' + esc(pn
      ? '已同步 ' + pn.items.length + ' 条 · ' + fmtAgo(pn.at || 0) + ' · 点这里打开门户'
      : '实验室管理处 / 团委 / 图书馆 / 基建处这些通知在门户里，登录一次就能同步过来') +
    '</span></button>';
  if (pn) {
    html += '<div class="hint tiny" style="padding:2px 4px 8px">校内通知 · ' +
      pn.items.length + ' 条 · 同步于 ' + fmtAgo(pn.at || 0) + '</div>';
    pn.items.forEach((it) => {
      html += '<button class="notice-row" data-portal="' + escAttr(it.url) + '">' +
        '<div class="notice-title">' + esc(it.title) + '</div>' +
        '<div class="notice-meta"><span>' + esc(it.date || '日期未知') + '</span>' +
        '<span class="dept">校内</span></div></button>';
    });
    html += '<div class="hint tiny" style="padding:14px 4px 8px">校园通知（公开页面）</div>';
  }
  if (NOTICE.error || d.ok === false) {
    html += '<div class="notice-error">没取到通知：' + esc(NOTICE.error || d.error || '未知错误') +
      '<div style="margin-top:10px"><button class="btn small" id="noticeRetry">再试一次</button></div></div>';
  }
  if (!items.length) {
    if (!html) html += emptyHTML('最近没有筛选出的通知', '学校主页通知公告里，招聘/招租/招标这类已经过滤掉了。', '刷新', 'notice');
  } else {
    /* 「已隐藏 N 条」写在最上面：不写的话，用户看到最新一条是半个月前的，
       第一反应就是「这软件不更新了」—— 其实是学校那几天只发了招聘。 */
    html += '<div class="hint tiny" style="padding:0 4px 8px">' +
      '校园通知 · 更新于 ' + fmtAgo(NOTICE.at || 0) +
      (d.cached ? ' · 本机缓存' : '') +
      ((d.hidden || 0) > 0 ? ' · 已隐藏 ' + d.hidden + ' 条招聘/招租' : '') + '</div>';
    items.forEach((it) => {
      html += '<button class="notice-row" data-url="' + escAttr(it.url) + '">' +
        '<div class="notice-title">' + esc(it.title) + '</div>' +
        '<div class="notice-meta"><span>' + esc(it.date || '日期未知') + '</span>' +
        ((it.dept || it.source) ? '<span class="dept">' + esc(it.dept || it.source) + '</span>' : '') + '</div></button>';
    });
  }
  /* 被滤掉多少条要说出来。不说的话，用户看到最新一条是半个月前的，
     只会以为「这软件不更新了」—— 其实是学校那几天只发了招聘。 */
  if ((d.hidden || 0) > 0 || NOTICE_ALL) {
    html += '<button class="btn block" style="margin-top:12px" data-action="notice-all">' +
      (NOTICE_ALL
        ? '只看学生相关（隐藏招聘 / 招租 / 招标）'
        : '显示全部（含 ' + (d.hidden || 0) + ' 条招聘 / 招租 / 招标）') +
      '</button>';
  }
  body.innerHTML = html;
}

/* 门户那边同步下来的校内通知：{at, items:[{title,url,date}]}。
   读不到就返回 null —— 网页版没有这个能力，也不能编数据。 */
function portalNotices() {
  try {
    if (!window.Android || typeof window.Android.loadPortalNotices !== 'function') return null;
    const raw = window.Android.loadPortalNotices();
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.items || !o.items.length) return null;
    return o;
  } catch (e) { return null; }
}

function openPortal(url) {
  const target = url || 'https://one.cau.edu.cn/tp_up/view?m=up';
  if (window.Android && typeof window.Android.openPortal === 'function') {
    const r = window.Android.openPortal(target);
    if (!r) return;                       // "" = 已经在应用内打开了
    // 后端返回 "fail: xxx"，把前缀去掉再显示（不用正则，免得转义出岔子）
    toast('打不开综合服务平台：' + String(r).split('fail:').join('').trim(), 4200);
  }
  window.open(target, '_blank', 'noopener'); // 网页版 / 起不来时退到浏览器
}

/* 从门户窗口回来时，MainActivity 会调一下这个：把刚同步到的通知渲染出来。 */
window.appPortalSynced = function () {
  try { renderNotice(); } catch (e) { /* 页面还没准备好就算了，下次切 tab 会重画 */ }
  return true;
};

async function loadNotice(force) {
  if (noticeLoading) return;
  noticeLoading = true;
  try {
    const r = await api('/api/notice?limit=40' + (NOTICE_ALL ? '&all=1' : '') +
      (force ? '&force=1' : ''));
    if (r && r.ok) {
      NOTICE = { at: r.at || Math.floor(Date.now() / 1000), data: r, error: '' };
    } else {
      NOTICE = NOTICE || { at: 0, data: { items: [] } };
      NOTICE.error = (r && r.error) || '取公告失败';
    }
  } catch (e) {
    NOTICE = NOTICE || { at: 0, data: { items: [] } };
    NOTICE.error = e.message || String(e);
  }
  store.set(KEY.notice, NOTICE);
  noticeLoading = false;
  renderNotice();
}

// ------------------------------------------------------------------ 我的

function renderMe() {
  const p = (DATA && DATA.profile) || {};
  const name = p.name || '';
  const sid = p.studentId || '';
  const initial = name ? name.slice(0, 1) : '?';
  const bound = !!BOUND;
  const hidden = (CFG.hidden || []).slice();
  const hiddenCourses = ((DATA && DATA.courses) || []).filter((c) => hidden.includes(c.code || c.name));

  let html = '<div class="profile-card">' +
    '<div class="avatar">' + esc(initial) + '</div>' +
    '<div class="profile-main">' +
      '<div class="profile-name">' + esc(name || (bound ? '已绑定' : '未绑定')) + '</div>' +
      '<div class="profile-sub">' + (sid ? '学号 ' + esc(sid) : '绑定教务账号后同步课表和成绩') + '</div>' +
      '<div class="profile-status' + (bound ? '' : ' off') + '">' +
        (bound ? '已绑定 · 数据只存本机' : '未绑定') + '</div>' +
    '</div>' +
    (bound
      ? '<button class="btn small" data-action="sync"' + (syncing ? ' disabled' : '') + '>同步</button>'
      : '<button class="btn primary small" data-action="bind">绑定</button>') +
    '</div>';

  html += '<div class="section-label">账号</div><div class="list-card">' +
    '<button class="list-row" data-action="sync">' +
      '<span class="list-ico ico-blue"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg></span>' +
      '<span class="list-main"><span class="list-title">同步教务数据</span>' +
      '<span class="list-sub">' + (DATA && DATA.syncedAt ? '上次 ' + fmtAgo(DATA.syncedAt) : '课表 / 考试 / 成绩') + '</span></span>' +
      '<span class="list-go">›</span></button>' +
    '<button class="list-row" data-action="bind">' +
      '<span class="list-ico ico-gray"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/></svg></span>' +
      '<span class="list-main"><span class="list-title">' + (bound ? '重新绑定 / 切换账号' : '绑定教务账号') + '</span>' +
      '<span class="list-sub">用 newjw.cau.edu.cn 的学号密码</span></span><span class="list-go">›</span></button>' +
    '<button class="list-row" data-action="unbind">' +
      '<span class="list-ico ico-red"><svg viewBox="0 0 24 24"><path d="M6 7h12M9 7V5h6v2M8 7l1 13h6l1-13"/></svg></span>' +
      '<span class="list-main"><span class="list-title" style="color:var(--red)">解除绑定</span>' +
      '<span class="list-sub">删除本机保存的学号密码和课表数据</span></span><span class="list-go">›</span></button>' +
    '</div>';

  html += '<div class="section-label">课表</div><div class="list-card">' +
    '<button class="list-row" data-action="settings">' +
      '<span class="list-ico ico-orange"><svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 3v3M16 3v3"/></svg></span>' +
      '<span class="list-main"><span class="list-title">学期设置</span>' +
      '<span class="list-sub">开学日期 · 总周数</span></span><span class="list-go">›</span></button>' +
    '<button class="list-row" data-action="times">' +
      '<span class="list-ico ico-teal"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg></span>' +
      '<span class="list-main"><span class="list-title">上课时间</span>' +
      '<span class="list-sub">6 个大节的起止时间</span></span><span class="list-go">›</span></button>' +
    '</div>';

  if (hiddenCourses.length) {
    html += '<div class="section-label">隐藏的课程</div><div class="list-card">';
    hiddenCourses.forEach((c) => {
      html += '<div class="list-row"><span class="list-main">' +
        '<span class="list-title">' + esc(displayName(c)) + '</span>' +
        '<span class="list-sub">' + esc(c.code || '') + '</span></span>' +
        '<button class="btn small" data-restore="' + escAttr(c.code || c.name) + '">恢复</button></div>';
    });
    html += '</div>';
  }

  html += '<div class="section-label">关于</div><div class="list-card">' +
    '<div class="list-row"><span class="list-main"><span class="list-title">CAU 校园通</span>' +
    '<span class="list-sub">版本 ' + APP_VERSION + ' · 只读客户端</span></span></div>' +
    '<div class="list-row"><span class="list-main"><span class="list-title">数据来源</span>' +
    '<span class="list-sub">newjw.cau.edu.cn（教务）· cau.edu.cn（公告）</span></span></div>' +
    '<div class="list-row"><span class="list-main"><span class="list-title">隐私</span>' +
    '<span class="list-sub">学号密码用 Windows DPAPI 加密存本机；不上传、无统计</span></span></div>' +
    '</div>' +
    '<p class="about">本软件只读：不选课、不评教、不代交作业、不绕过验证码。<br>' +
    '强智教务是会话独占的，登录后可能把浏览器里的教务挤下线。</p>';

  $('meBody').innerHTML = html;
}

// ------------------------------------------------------------------ 校历 / 设置 / 时间

function renderCalendar() {
  if (!DATA) {
    $('calendarBody').innerHTML = emptyHTML('还没有校历', '绑定教务账号后按学期推算周次。', '去绑定', 'bind');
    return;
  }
  const n = totalWeeks();
  const nowW = currentWeek();
  let html = '<div class="hint" style="padding:0 4px 10px">' +
    esc(DATA.semester || '') + ' · 共 ' + n + ' 周<br>' +
    '周次按开学日期推算；如果和学校校历差一周，在「我的 → 学期设置」里改开学日期。</div>';
  for (let w = 1; w <= n; w++) {
    const r = weekRange(w);
    html += '<button class="calendar-row' + (w === nowW ? ' now' : '') + '" data-week="' + w + '">' +
      '<b>第 ' + w + ' 周' + (w === nowW ? ' <span class="now-tag">本周</span>' : '') + '</b>' +
      '<span>' + mdDot(r.mon) + ' – ' + mdDot(r.sun) + '</span></button>';
  }
  $('calendarBody').innerHTML = html;
}

function renderSettings() {
  const d = startDate();
  $('settingsBody').innerHTML =
    '<div class="setting-group">' +
      '<div class="setting-row"><div class="setting-label">当前学期</div>' +
      '<div class="setting-desc">' + esc((DATA && DATA.semester) || '还没同步') + '</div></div>' +
      '<div class="setting-row"><div class="setting-label">开学第一周的周一</div>' +
      '<div class="setting-desc">用来算「现在第几周」；不确定就按默认值。</div>' +
      '<input class="setting-input" id="setStart" type="date" value="' + ymd(d) + '"></div>' +
      '<div class="setting-row"><div class="setting-label">总周数</div>' +
      '<div class="setting-desc">默认取课表里最晚出现的周次；学校校历更长就改这里。</div>' +
      '<input class="setting-input" id="setWeeks" type="number" min="1" max="30" value="' + totalWeeks() + '"></div>' +
    '</div>' +
    '<button class="btn primary block" id="saveSettings">保存</button>' +
    '<button class="btn block" id="resetSettings">按学期名恢复默认</button>' +
    '<p class="hint tiny" style="padding:12px 4px">只改本机显示，不改教务系统的数据。</p>';
}

function saveSettings() {
  const s = $('setStart') && $('setStart').value;
  const n = Number($('setWeeks') && $('setWeeks').value);
  if (!s) { toast('选一个开学日期'); return; }
  if (!(n >= 1 && n <= 30)) { toast('总周数填 1–30'); return; }
  CFG.startDate = s;
  CFG.totalWeeks = n;
  saveCfg();
  renderSchedule();
  toast('已保存');
}

function resetSettings() {
  CFG.startDate = DATA && DATA.semester ? ymd(defaultStart(DATA.semester)) : '';
  CFG.totalWeeks = (DATA && DATA.totalWeeks) || 18;
  saveCfg();
  renderSettings();
  renderSchedule();
  toast('已按学期名恢复');
}

function renderTimes() {
  const t = times();
  let html = '<div class="setting-group">';
  for (let i = 0; i < Math.max(6, t.length); i++) {
    const row = t[i] || ['', ''];
    html += '<div class="times-row"><div class="lbl">第' + (i + 1) + '大节</div>' +
      '<input type="time" data-p="' + i + '" data-k="0" value="' + escAttr(row[0] || '') + '">' +
      '<input type="time" data-p="' + i + '" data-k="1" value="' + escAttr(row[1] || '') + '"></div>';
  }
  html += '</div>' +
    '<button class="btn primary block" id="saveTimes">保存</button>' +
    '<button class="btn block" id="resetTimes">恢复默认</button>' +
    '<p class="hint tiny" style="padding:12px 4px">教务系统只给 6 个大节的起止时间；这里改的是本机显示，不影响学校排课。</p>';
  $('timesBody').innerHTML = html;
}

function collectTimes() {
  const arr = [];
  document.querySelectorAll('#timesBody input[type="time"]').forEach((el) => {
    const p = Number(el.dataset.p);
    const k = Number(el.dataset.k);
    if (!arr[p]) arr[p] = ['', ''];
    arr[p][k] = el.value;
  });
  return arr;
}

function saveTimes() {
  const arr = collectTimes();
  for (let i = 0; i < arr.length; i++) {
    if (!arr[i] || !arr[i][0] || !arr[i][1]) { toast('第 ' + (i + 1) + ' 大节时间没填完'); return; }
    if (arr[i][0] >= arr[i][1]) { toast('第 ' + (i + 1) + ' 大节结束时间要晚于开始时间'); return; }
  }
  CFG.times = arr;
  saveCfg();
  renderSchedule();
  toast('已保存');
}

function resetTimes() {
  CFG.times = null;
  saveCfg();
  renderTimes();
  renderSchedule();
  toast('已恢复默认时间');
}

// ------------------------------------------------------------------ 绑定 / 同步

function saveCfg() {
  store.set(KEY.settings, CFG);
}

function showLogin(msg) {
  $('loginSheet').hidden = false;
  $('loginMsg').textContent = msg || '';
  $('loginMsg').className = 'form-msg';
  $('loginUser').value = store.get(KEY.user, '') || (DATA && DATA.profile && DATA.profile.studentId) || '';
  $('loginPass').value = '';
  setTimeout(() => $('loginUser').focus(), 120);
}

function hideLogin() {
  $('loginSheet').hidden = true;
  $('loginPass').value = '';
}

async function doBind() {
  const user = $('loginUser').value.trim();
  const pass = $('loginPass').value;
  const msg = $('loginMsg');
  if (!user || !pass) {
    msg.textContent = '学号和密码都要填';
    return;
  }
  const btn = $('btnLogin');
  btn.disabled = true;
  msg.className = 'form-msg';
  msg.textContent = '正在登录并同步，约 10–20 秒…';
  try {
    const r = await api('/api/login', { username: user, password: pass, remember: true });
    if (r && r.ok) {
      store.set(KEY.user, user);
      applyPayload(r);
      hideLogin();
      toast('绑定成功，已同步');
      switchTab('schedule');
      if (r.saved && String(r.saved).indexOf('fail:') === 0) {
        toast('课表已同步，但密码没存住：' + r.saved.slice(6), 4200);
      }
    } else {
      msg.textContent = (r && r.error) || '登录失败';
      if (r && r.kind === 'net') msg.textContent += '（网络问题，不是密码错，换个网再试）';
    }
  } catch (e) {
    msg.textContent = e.message || String(e);
  } finally {
    btn.disabled = false;
  }
}

function applyPayload(p) {
  if (!p || !p.ok) return;
  DATA = p;
  SEMS = p.semesters || [];
  EXAM_CACHE = {};
  if (p.exams) EXAM_CACHE[p.semesterId || ''] = p.exams;
  CFG.examSem = p.semesterId || '';
  CFG.gradeTerm = '全部';
  CFG.studyView = CFG.studyView || 'exam';
  // 新学期/第一次绑定：按学期名推一个开学日；用户手动改过就保留
  if (!CFG.startDate || CFG.semesterId !== p.semesterId) {
    CFG.startDate = p.semester ? ymd(defaultStart(p.semester)) : '';
    CFG.semesterId = p.semesterId || '';
  }
  CFG.totalWeeks = p.totalWeeks || CFG.totalWeeks || 18;
  CFG.week = currentWeek();
  BOUND = true;
  CRED = 'ok';
  saveCfg();
  store.set(KEY.data, DATA);
  renderAll();
}

async function probeBound() {
  if (!TOKEN) {
    BOUND = false;
    CRED = 'none';
    renderSchedule();
    renderMe();
    return;
  }
  try {
    const r = await api('/api/state');
    BOUND = !!(r && r.bound);
    CRED = (r && r.credState) || 'none';
  } catch (e) {
    BOUND = false;
    CRED = 'none';
  }
  renderSchedule();
  renderMe();
  if (BOUND && !DATA) {
    // 已绑定但手机上没有数据：不自动重登，等用户点同步
  }
}

async function doSync(opts) {
  opts = opts || {};
  if (syncing) return;
  if (!BOUND) {
    showLogin('');
    return;
  }
  syncing = true;
  document.querySelectorAll('#btnRefreshSchedule,#btnRefreshStudy').forEach((b) => b.classList.add('busy'));
  renderMe();
  try {
    const r = await api('/api/sync', {});
    if (r && r.ok) {
      applyPayload(r);
      if (!opts.silent) toast('同步完成');
    } else if (r && r.needBind) {
      BOUND = false;
      showLogin('本机没有保存的凭据，重新输入一次');
    } else if (r && r.authFail) {
      showLogin('教务系统不认这个密码，可能改过了');
    } else if (!opts.silent) {
      toast('同步失败：' + ((r && r.error) || '未知错误'), 4200);
    }
  } catch (e) {
    if (!opts.silent) toast('同步失败：' + (e.message || e), 4200);
  } finally {
    syncing = false;
    document.querySelectorAll('#btnRefreshSchedule,#btnRefreshStudy').forEach((b) => b.classList.remove('busy'));
    renderMe();
  }
}

async function doUnbind() {
  if (!confirm('解除绑定会删除本机保存的学号密码和课表数据，确定吗？')) return;
  try {
    await api('/api/unbind', {});
  } catch (e) { /* 本地清干净更重要 */ }
  DATA = null;
  SEMS = [];
  EXAM_CACHE = {};
  BOUND = false;
  CRED = 'none';
  store.del(KEY.data);
  renderAll();
  toast('已解除绑定');
}

function restoreCourse(code) {
  const arr = (CFG.hidden || []).slice();
  const i = arr.indexOf(code);
  if (i >= 0) arr.splice(i, 1);
  CFG.hidden = arr;
  saveCfg();
  renderSchedule();
  renderMe();
  toast('已恢复');
}

// ------------------------------------------------------------------ 小组件

function emptyHTML(title, text, btn, action) {
  return '<div class="empty" style="min-height:44vh">' +
    '<div class="empty-ico"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/></svg></div>' +
    '<h2>' + esc(title) + '</h2><p>' + esc(text) + '</p>' +
    (btn ? '<button class="btn primary" data-action="' + action + '">' + esc(btn) + '</button>' : '') +
    '</div>';
}

function renderAll() {
  renderSchedule();
  renderStudy();
  renderNotice();
  renderMe();
  if (CUR_PAGE === 'calendar') renderCalendar();
  if (CUR_PAGE === 'settings') renderSettings();
  if (CUR_PAGE === 'times') renderTimes();
}

// ------------------------------------------------------------------ 事件

function bindEvents() {
  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  $('prevWeek').addEventListener('click', () => {
    if (CFG.week > 1) { CFG.week--; saveCfg(); renderSchedule(); }
  });
  $('nextWeek').addEventListener('click', () => {
    if (CFG.week < totalWeeks()) { CFG.week++; saveCfg(); renderSchedule(); }
  });
  $('todayBtn').addEventListener('click', () => {
    CFG.week = currentWeek();
    CUR_DAY = today0();
    saveCfg();
    renderSchedule();
  });
  $('viewToggle').addEventListener('click', () => {
    CFG.view = CFG.view === 'day' ? 'week' : 'day';
    if (CFG.view === 'day') {
      const r = weekRange(CFG.week || currentWeek());
      const today = today0();
      CUR_DAY = (ymd(today) >= ymd(r.mon) && ymd(today) <= ymd(r.sun)) ? today : r.mon;
    }
    saveCfg();
    renderSchedule();
  });
  $('weekPick').addEventListener('click', openWeekSheet);
  $('weekClose').addEventListener('click', () => { $('weekSheet').hidden = true; });
  $('weekSettings').addEventListener('click', () => {
    $('weekSheet').hidden = true;
    openSub('settings');
  });
  $('btnCalendar').addEventListener('click', () => openSub('calendar'));
  $('btnRefreshSchedule').addEventListener('click', () => doSync());
  $('btnRefreshStudy').addEventListener('click', () => doSync());
  $('btnRefreshNotice').addEventListener('click', () => loadNotice(true));
  $('goBind1').addEventListener('click', () => { BOUND ? doSync() : showLogin(''); });

  $('weekHead').addEventListener('click', (e) => {
    const b = e.target.closest('.day-head');
    if (!b) return;
    const d = parseYmd(b.dataset.date);
    if (!d) return;
    CUR_DAY = d;
    CFG.view = 'day';
    CFG.week = weekOf(d);
    saveCfg();
    renderSchedule();
  });

  $('weekGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.course-block');
    if (!b) return;
    openCourse(COURSE_INDEX[Number(b.dataset.ci)]);
  });
  $('dayView').addEventListener('click', (e) => {
    const b = e.target.closest('.day-course');
    if (!b) return;
    openCourse(COURSE_INDEX[Number(b.dataset.ci)]);
  });

  $('studySeg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    CFG.studyView = b.dataset.view;
    saveCfg();
    renderStudy();
  });

  $('examChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    CFG.examSem = b.dataset.sem;
    saveCfg();
    renderExams();
  });
  $('examBody').addEventListener('click', (e) => {
    const retry = e.target.closest('#examRetry');
    if (retry) {
      const sid = CFG.examSem || (DATA && DATA.semesterId) || '';
      delete EXAM_CACHE[sid];
      renderExams();
      return;
    }
    const b = e.target.closest('[data-action]');
    if (!b) return;
    if (b.dataset.action === 'sync') doSync();
    if (b.dataset.action === 'bind') showLogin('');
  });

  $('gradeBody').addEventListener('click', (e) => {
    const b = e.target.closest('.chip[data-term]');
    if (b) {
      CFG.gradeTerm = b.dataset.term;
      saveCfg();
      renderGrades();
      return;
    }
    const a = e.target.closest('[data-action]');
    if (a) {
      if (a.dataset.action === 'sync') doSync();
      if (a.dataset.action === 'bind') showLogin('');
    }
  });
  $('creditBody').addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    if (a.dataset.action === 'sync') doSync();
    if (a.dataset.action === 'bind') showLogin('');
  });

  $('noticeBody').addEventListener('click', (e) => {
    const retry = e.target.closest('#noticeRetry');
    if (retry) { loadNotice(true); return; }
    const a = e.target.closest('[data-action="notice"]');
    if (a) { loadNotice(true); return; }
    const allBtn = e.target.closest('[data-action="notice-all"]');
    if (allBtn) { NOTICE_ALL = !NOTICE_ALL; loadNotice(true); return; }
    if (e.target.closest('[data-action="portal"]')) { openPortal(); return; }
    const p = e.target.closest('[data-portal]');
    if (p) { openPortal(p.dataset.portal); return; }
    const b = e.target.closest('.notice-row');
    if (!b) return;
    const url = b.dataset.url;
    if (!url) return;
    const w = window.open(url, '_blank', 'noopener');
    if (!w) toast('浏览器拦了新窗口，长按链接复制到浏览器打开', 4200);
  });

  $('meBody').addEventListener('click', (e) => {
    const r = e.target.closest('[data-restore]');
    if (r) { restoreCourse(r.dataset.restore); return; }
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    if (act === 'sync') doSync();
    if (act === 'bind') showLogin('');
    if (act === 'unbind') doUnbind();
    if (act === 'settings') openSub('settings');
    if (act === 'times') openSub('times');
  });

  $('calendarBody').addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (a) { if (a.dataset.action === 'bind') showLogin(''); return; }
    const b = e.target.closest('.calendar-row');
    if (!b) return;
    CFG.week = Number(b.dataset.week);
    saveCfg();
    switchTab('schedule');
  });

  $('settingsBody').addEventListener('click', (e) => {
    if (e.target.id === 'saveSettings') saveSettings();
    if (e.target.id === 'resetSettings') resetSettings();
  });
  $('timesBody').addEventListener('click', (e) => {
    if (e.target.id === 'saveTimes') saveTimes();
    if (e.target.id === 'resetTimes') resetTimes();
  });

  $('calBack').addEventListener('click', () => switchTab('schedule'));
  $('settingsBack').addEventListener('click', () => switchTab('me'));
  $('timesBack').addEventListener('click', () => switchTab('me'));

  $('loginClose').addEventListener('click', hideLogin);
  $('btnLogin').addEventListener('click', doBind);
  $('loginPass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doBind();
  });
  $('togglePass').addEventListener('click', (e) => {
    e.preventDefault();
    const el = $('loginPass');
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    const b = $('togglePass');
    b.setAttribute('aria-pressed', show ? 'true' : 'false');
    b.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  });
  $('courseClose').addEventListener('click', () => { $('courseSheet').hidden = true; });
  $('courseBody').addEventListener('click', (e) => {
    if (e.target.id === 'btnHideCourse') toggleHideCourse();
  });

  document.querySelectorAll('.sheet-back').forEach((back) => {
    back.addEventListener('click', (e) => {
      if (e.target === back) back.hidden = true;
    });
  });
}

function openWeekSheet() {
  const n = totalWeeks();
  const now = currentWeek();
  let html = '';
  for (let w = 1; w <= n; w++) {
    html += '<button class="week-cell' + (w === CFG.week ? ' on' : '') +
      (w === now ? ' now' : '') + '" data-week="' + w + '">第 ' + w + ' 周</button>';
  }
  $('weekPicker').innerHTML = html;
  $('weekPicker').onclick = (e) => {
    const b = e.target.closest('.week-cell');
    if (!b) return;
    CFG.week = Number(b.dataset.week);
    saveCfg();
    $('weekSheet').hidden = true;
    renderSchedule();
  };
  $('weekSheet').hidden = false;
}

// 安卓返回键（以后打包 APK 用）：先关浮层，再回 tab，最后才退出
window.appBack = function () {
  if (!$('loginSheet').hidden) { hideLogin(); return true; }
  if (!$('courseSheet').hidden) { $('courseSheet').hidden = true; return true; }
  if (!$('weekSheet').hidden) { $('weekSheet').hidden = true; return true; }
  if (SUBPAGES.includes(CUR_PAGE)) { switchTab(SUB_PARENT[CUR_PAGE]); return true; }
  if (CUR_PAGE !== 'schedule') { switchTab('schedule'); return true; }
  return false;
};

// ------------------------------------------------------------------ 启动

function boot() {
  CUR_DAY = today0();
  if (!TOKEN) {
    toast('没有访问凭证：请用电脑启动窗口里那个带 ?k= 的地址打开', 5000);
  }
  bindEvents();
  renderAll();
  // 恢复上次的考试学期；没有就用当前学期
  if (DATA && DATA.semesterId) {
    CFG.examSem = CFG.examSem || DATA.semesterId;
  }
  probeBound().then(() => {
    renderAll();
    if (BOUND && DATA && DATA.syncedAt &&
        (Date.now() / 1000 - DATA.syncedAt) > 12 * 3600) {
      doSync({ silent: true });
    }
  });
}

boot();

// 今日概览的倒计时每分钟刷新一次。只在课表页可见时才动 DOM，
// 其它页上空转，省电也省渲染。
setInterval(() => {
  if (CUR_PAGE === 'schedule') renderTodayBar();
}, 60000);
