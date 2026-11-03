/* CAU 校园通 · App 内的「本地服务」

   ================================================================
   这个文件是干什么的
   ================================================================
   网页版里，界面（app.js）只管画，数据由同源的 bridge.py 提供：
   它替浏览器登录 newjw.cau.edu.cn，把课表/成绩/考试/公告转成 JSON。

   装进手机后没有 Python 了。所以这一层在 WebView 里把同样的 /api/*
   实现一遍：

       界面 fetch('/api/timetable')
         → 这里接住
         → Android.req2()（原生发 HTTP，带 cookie 罐）
         → 用和 cau_jw.py 一模一样的正则解析
         → 拼成同样的 JSON 还回去

   界面代码一行都不用改 —— 它不知道自己连的是 Python 还是这个。

   ================================================================
   三条约定
   ================================================================
   1. 🔴 **网页版必须完全空转**。文件顶部那个 guard 一 return，后面全不执行：
      没有 Android 对象就说明 bridge.py 在跑，抢 fetch 会把网页版弄坏。
   2. 🔴 **解析逻辑要和 cau_jw.py 保持一致**。两边各写一套迟早会漂，
      所以这里几乎是逐行照搬（正则、字段名、默认值都一样），
      改这边就要同步改那边 —— 改完拿同一份真实课表/成绩页在两边各跑一遍对账。
   3. 🔴 **请求之间留间隔**（POLITE_DELAY）。强智对频繁请求敏感，
      网页版靠 Python 的 time.sleep 控节奏，这里换成 Promise 等。
*/

(function () {
  'use strict';

  var A = window.Android;
  if (!A || typeof A.req2 !== 'function') return;   // 网页版：什么都不做

  var BASE = 'https://newjw.cau.edu.cn';
  var JSXS = '/jsxsd';
  var POLITE_DELAY = 800;      // 毫秒。和 cau_jw.py 的 POLITE_DELAY 对齐
  var NOTICE_TTL = 30 * 60 * 1000;

  /* ---------------------------------------------------------------- 小工具 */

  var ENT = {
    nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    middot: '\u00b7', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
    ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019'
  };

  /* html.unescape 的够用版。教务页面里实际只会出现 &nbsp; &amp; 和数字实体。 */
  function unescapeHtml(s) {
    return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
      function (all, e) {
        if (e.charAt(0) === '#') {
          var code = e.charAt(1) === 'x' || e.charAt(1) === 'X'
            ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          if (!isNaN(code) && code > 0) {
            try { return String.fromCodePoint(code); } catch (err) { return all; }
          }
          return all;
        }
        var v = ENT[e.toLowerCase()];
        return v === undefined ? all : v;
      });
  }

  function cleanText(s) {
    s = String(s == null ? '' : s);
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = unescapeHtml(s);
    s = s.replace(/\u00a0/g, ' ');
    return s.replace(/[ \t]+/g, ' ').trim();
  }

  function cellText(s) { return cleanText(s).replace(/\s+/g, ' ').trim(); }

  /* 公告那边用的是另一套清洗（notice_cau.py 的 _clean）：**所有空白都压成一个空格**，
     换行也算。标题里常有 <br/>，用 cleanText 会留下换行，和网页版显示不一致。 */
  function noticeClean(s) {
    return unescapeHtml(String(s == null ? '' : s).replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ').trim();
  }

  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* 取所有捕获组 1。每次新建正则，别复用带 g 的对象（lastIndex 会串）。 */
  function matchAll(s, re) {
    var out = [], m;
    while ((m = re.exec(s)) !== null) {
      out.push(m[1]);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  }

  function tableById(html, id) {
    var m = new RegExp('<table[^>]*\\bid=["\']' + escRe(id) +
      '["\'][^>]*>[\\s\\S]*?</table>', 'i').exec(html);
    return m ? m[0] : '';
  }

  /* 按 div 深度配对取 class 含 cls 的块。普通非贪婪正则会在内层 </div> 停住，
     一个格子里有多门课时就会漏掉第二门 —— cau_jw.py 里踩过。 */
  function divBlocks(html, cls) {
    var out = [];
    var pat = new RegExp('<div\\b[^>]*\\bclass=["\'][^"\']*\\b' + escRe(cls) +
      '\\b[^"\']*["\'][^>]*>', 'gi');
    var m;
    while ((m = pat.exec(html)) !== null) {
      var start = pat.lastIndex;
      var depth = 1;
      var tagRe = /<div\b|<\/div\s*>/gi;
      tagRe.lastIndex = start;
      var t;
      while ((t = tagRe.exec(html)) !== null) {
        if (t[0].toLowerCase().indexOf('</') === 0) {
          depth--;
          if (depth === 0) { out.push(html.slice(start, t.index)); break; }
        } else {
          depth++;
        }
      }
    }
    return out;
  }

  /* 1-11(周) / 5,7-16(周) / 14(周) → [1..11] / [5,7..16] / [14] */
  function parseWeeks(text) {
    var m = /([\d,\-]+)\s*\(\s*周\s*\)/.exec(text || '');
    if (!m) return [];
    var set = {}, i;
    var parts = m[1].split(',');
    for (i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (!part) continue;
      if (part.indexOf('-') >= 0) {
        var ab = part.split('-');
        var a = parseInt(ab[0], 10), b = parseInt(ab[1], 10);
        if (isNaN(a) || isNaN(b)) continue;
        for (var w = a; w <= b; w++) set[w] = 1;
      } else {
        var n = parseInt(part, 10);
        if (!isNaN(n)) set[n] = 1;
      }
    }
    return Object.keys(set).map(Number).sort(function (x, y) { return x - y; });
  }

  /* [01-02节] / [05-06-07-08节] / [09-10-11节] → [1,2] / [5,6,7,8] / [9,10,11] */
  function parsePeriods(text) {
    var m = /\[([\d\-]+)\s*节\]/.exec(text || '');
    if (!m) return [];
    var out = [];
    var parts = m[1].split('-');
    for (var i = 0; i < parts.length; i++) {
      var n = parseInt(parts[i], 10);
      if (!isNaN(n)) out.push(n);
    }
    return out;
  }

  /* <select name="xnxq01id"> 的学期选项 → {list, current} */
  function semesterOptions(html) {
    var block = '';
    var names = ['xnxq01id', 'xnxqid'];
    for (var k = 0; k < names.length; k++) {
      var m = new RegExp('<select[^>]*(?:id|name)=["\']' + escRe(names[k]) +
        '["\'][^>]*>([\\s\\S]*?)</select>', 'i').exec(html);
      if (m) { block = m[1]; break; }
    }
    if (!block) return { list: [], current: null };

    var list = [], current = null;
    var re = /<option([^>]*)>([\s\S]*?)<\/option>/gi, om;
    while ((om = re.exec(block)) !== null) {
      var attrs = om[1];
      var vm = /value=["']([^"']*)["']/i.exec(attrs);
      var label = cellText(om[2]);
      if (!label) continue;
      var item = {
        value: vm ? vm[1] : '',
        label: label,
        current: attrs.toLowerCase().indexOf('selected') >= 0
      };
      list.push(item);
      if (item.current) current = item;
    }
    if (!current && list.length) current = list[0];
    return { list: list, current: current };
  }

  function looksLogin(html) {
    return /id=["']loginForm["']/i.test(html) ||
      /请输入密码|请先登录系统|用户登录/.test(html);
  }

  /* 强智登录编码：学号%%%密码 的前 20 个字符之后，按 sxh 逐位插入 scode。
     🔴 和 cau_jw.py 的 encode_password 必须一字不差 —— 差一位就是「密码不对」。 */
  function encodePassword(user, pwd, scode, sxh) {
    var code = user + '%%%' + pwd;
    var enc = '';
    for (var i = 0; i < code.length; i++) {
      if (i >= 20) { enc += code.slice(i); break; }
      var n = parseInt(sxh.charAt(i), 10);
      if (isNaN(n)) { enc += code.slice(i); break; }
      enc += code.charAt(i);
      enc += scode.slice(0, n);
      scode = scode.slice(n);
    }
    return enc;
  }

  /* ---------------------------------------------------------------- 解析器 */

  function CauError(msg, kind) {
    this.name = 'CauError';
    this.message = msg;
    this.kind = kind || 'net';
  }
  CauError.prototype = Object.create(Error.prototype);
  CauError.prototype.constructor = CauError;

  /* 课表页 → 统一 schema。CAU 是 6 个「大节」×7 天，
     每格有一份可见的 kbcontent1 和一份隐藏的 kbcontent（多教师/周次节次），
     解析隐藏那份。 */
  function parseTimetable(html) {
    var so = semesterOptions(html);
    var semesters = so.list, current = so.current;

    var m = /<table[^>]*\bid=["']timetable["'][^>]*>[\s\S]*?<\/table>/i.exec(html);
    var table = m ? m[0] : '';
    if (!table) throw new CauError('课表页面里没有 timetable 表格，学校可能改版了', 'parse');

    var rows = matchAll(table, /<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    if (!rows.length) throw new CauError('课表表格是空的', 'parse');

    var times = [], periodToBig = {}, bigRows = [];
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var th = /<th[^>]*>([\s\S]*?)<\/th>/i.exec(row);
      if (!th) continue;
      var head = cleanText(th[1]);
      var tm = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.exec(head);
      var pm = /\(([\d,]+)\s*小节\)/.exec(head);
      /* 表尾的「备注:」行也有 <th>，但没有 7 个 <td>，不能算大节 */
      if (!tm && !pm) continue;
      if ((row.match(/<td[^>]*>/gi) || []).length < 7) continue;
      bigRows.push({ row: row, head: head, tm: tm, pm: pm });
    }

    var bigSmall = [];
    for (var b = 0; b < bigRows.length; b++) {
      var br = bigRows[b];
      times.push(br.tm ? [br.tm[1], br.tm[2]] : ['', '']);
      var smalls = [];
      if (br.pm) {
        var xs = br.pm[1].split(',');
        for (var s = 0; s < xs.length; s++) {
          var n = parseInt(xs[s], 10);
          if (!isNaN(n)) smalls.push(n);
        }
      }
      bigSmall.push(smalls);
      for (var q = 0; q < smalls.length; q++) periodToBig[smalls[q]] = b;
    }

    var merged = {}, order = [];
    for (var r = 0; r < bigRows.length; r++) {
      var tds = matchAll(bigRows[r].row, /<td[^>]*>([\s\S]*?)<\/td>/gi);
      for (var day = 0; day < Math.min(7, tds.length); day++) {
        var blocks = divBlocks(tds[day], 'kbcontent');
        for (var bi = 0; bi < blocks.length; bi++) {
          /* 一个格子里可能撞两门课，用 --------------------- 分隔 */
          var parts = blocks[bi].split(/-{5,}/);
          for (var pi = 0; pi < parts.length; pi++) {
            var part = parts[pi];
            if (!part.trim()) continue;
            if (part.indexOf('&nbsp;') >= 0 && !cleanText(part)) continue;

            var teacherM = /<font[^>]*title=['"]教师['"][^>]*>([\s\S]*?)<\/font>/i.exec(part);
            var weeksM = /<font[^>]*title=['"]周次\(节次\)['"][^>]*>([\s\S]*?)<\/font>/i.exec(part);
            var roomM = /<font[^>]*title=['"]教室['"][^>]*>([\s\S]*?)<\/font>/i.exec(part);
            var teacher = teacherM ? cleanText(teacherM[1]) : '';
            var weeksText = weeksM ? cleanText(weeksM[1]) : '';
            var room = roomM ? cleanText(roomM[1]) : '';

            var headPart = part.split('<font')[0];
            headPart = headPart.replace(/<div[^>]*>/gi, '');
            var rawLines = headPart.split(/<br\s*\/?>/i);
            var lines = [];
            for (var li = 0; li < rawLines.length; li++) {
              var t = cellText(rawLines[li]);
              if (t) lines.push(t);
            }
            if (!lines.length) continue;

            var name = lines[0];
            var code = '', classNo = '';
            if (lines.length > 1) {
              var cm = /^([0-9A-Za-z]+)\s+(\S+)?/.exec(lines[1]);
              if (cm) { code = cm[1]; classNo = cm[2] || ''; }
              else code = lines[1];
            }
            var extra = lines.slice(2);

            var weeks = parseWeeks(weeksText);
            if (!weeks.length) continue;

            var periods = parsePeriods(weeksText);
            var slotsBig;
            if (periods.length) {
              var set = {};
              for (var pj = 0; pj < periods.length; pj++) {
                var v = periodToBig[periods[pj]];
                set[v === undefined ? r : v] = 1;
              }
              slotsBig = Object.keys(set).map(Number).sort(function (x, y) { return x - y; });
            } else {
              slotsBig = [r];
            }
            var slots = slotsBig.map(function (bb) { return { day: day, period: bb }; });

            var campus = '';
            var cm2 = /^\(([^)]+)\)/.exec(name);
            if (cm2) campus = cm2[1];

            var key = [name, code, teacher, room, weeks.join(',')].join('\u0001');
            if (merged[key]) {
              for (var sk = 0; sk < slots.length; sk++) {
                var found = false;
                for (var ek = 0; ek < merged[key].slots.length; ek++) {
                  if (merged[key].slots[ek].day === slots[sk].day &&
                    merged[key].slots[ek].period === slots[sk].period) { found = true; break; }
                }
                if (!found) merged[key].slots.push(slots[sk]);
              }
            } else {
              merged[key] = {
                name: name, code: code, classNo: classNo, teacher: teacher,
                room: room, campus: campus, weeks: weeks, slots: slots, extra: extra
              };
              order.push(key);
            }
          }
        }
      }
    }

    var courses = order.map(function (k) { return merged[k]; });
    courses.sort(function (a, b) {
      var d = a.slots[0].day - b.slots[0].day;
      if (d) return d;
      var p = a.slots[0].period - b.slots[0].period;
      if (p) return p;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    var totalWeeks = 0;
    for (var ci = 0; ci < courses.length; ci++) {
      var wk = courses[ci].weeks;
      for (var wi = 0; wi < wk.length; wi++) if (wk[wi] > totalWeeks) totalWeeks = wk[wi];
    }

    return {
      semester: current ? current.label : '',
      semesterId: current ? current.value : '',
      semesters: semesters,
      unitCount: times.length,
      times: times,
      totalWeeks: totalWeeks,
      courses: courses
    };
  }

  function parseGrades(html) {
    var table = tableById(html, 'dataList');
    if (!table) throw new CauError('成绩页面里没有 dataList 表格，学校可能改版了', 'parse');
    var rows = matchAll(table, /<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    if (!rows.length) {
      return {
        courses: [],
        summary: { count: 0, totalCredits: 0, weighted: null, byTerm: [], letters: {} }
      };
    }

    var headers = matchAll(rows[0], /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi).map(cellText);
    function idx() {
      var names = arguments;
      for (var i = 0; i < headers.length; i++) {
        for (var j = 0; j < names.length; j++) {
          if (headers[i].indexOf(names[j]) >= 0) return i;
        }
      }
      return -1;
    }
    var iTerm = idx('开课学期'), iCode = idx('课程编号'), iName = idx('课程名称'),
      iCredit = idx('学分'), iScore = idx('成绩'), iWay = idx('修读方式'),
      iAttr = idx('课程属性'), iGroup = idx('课组类别'), iNote = idx('备注');

    var courses = [];
    for (var ri = 1; ri < rows.length; ri++) {
      var cells = matchAll(rows[ri], /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi).map(cellText);
      if (cells.length < 5 || !cells.some(function (x) { return !!x; })) continue;
      if (cells.length === 1 && cells[0].indexOf('未查询到') >= 0) continue;

      function at(i) { return (i >= 0 && i < cells.length) ? cells[i] : ''; }
      var creditRaw = at(iCredit);
      var credit = 0;
      var crm = /-?\d+(?:\.\d+)?/.exec(creditRaw);
      if (crm) credit = parseFloat(crm[0]);

      var score = at(iScore);
      var scoreNum = null;
      var sm = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(score);
      if (sm) scoreNum = parseFloat(sm[1]);

      courses.push({
        term: at(iTerm), code: at(iCode), name: at(iName), credit: credit,
        score: score, scoreNum: scoreNum, way: at(iWay), attr: at(iAttr),
        group: at(iGroup), note: at(iNote)
      });
    }

    var totalCredits = 0, numeric = [];
    for (var c1 = 0; c1 < courses.length; c1++) {
      totalCredits += courses[c1].credit;
      if (courses[c1].scoreNum !== null && courses[c1].credit > 0) numeric.push(courses[c1]);
    }
    totalCredits = Math.round(totalCredits * 100) / 100;

    var weighted = null;
    if (numeric.length) {
      var num = 0, den = 0;
      for (var c2 = 0; c2 < numeric.length; c2++) {
        num += numeric[c2].scoreNum * numeric[c2].credit;
        den += numeric[c2].credit;
      }
      if (den) weighted = Math.round((num / den) * 100) / 100;
    }

    var byTerm = {}, termOrder = [];
    for (var c3 = 0; c3 < courses.length; c3++) {
      var c = courses[c3];
      var t = c.term || '未知学期';
      if (!byTerm[t]) {
        byTerm[t] = { term: t, count: 0, credits: 0, weightedNum: 0, weightedDen: 0 };
        termOrder.push(t);
      }
      var d = byTerm[t];
      d.count++;
      d.credits += c.credit;
      if (c.scoreNum !== null && c.credit > 0) {
        d.weightedNum += c.scoreNum * c.credit;
        d.weightedDen += c.credit;
      }
    }
    var byTermList = termOrder.map(function (t) {
      var d = byTerm[t];
      var out = {
        term: d.term, count: d.count,
        credits: Math.round(d.credits * 100) / 100,
        weighted: d.weightedDen ? Math.round((d.weightedNum / d.weightedDen) * 100) / 100 : null
      };
      return out;
    });
    byTermList.sort(function (a, b) { return a.term < b.term ? 1 : a.term > b.term ? -1 : 0; });

    var letters = {};
    for (var c4 = 0; c4 < courses.length; c4++) {
      var cc = courses[c4];
      if (cc.scoreNum === null && cc.score) {
        letters[cc.score] = (letters[cc.score] || 0) + 1;
      }
    }

    return {
      courses: courses,
      summary: {
        count: courses.length, totalCredits: totalCredits, weighted: weighted,
        byTerm: byTermList, letters: letters
      }
    };
  }

  function parseExams(html) {
    var table = tableById(html, 'dataList');
    if (!table) throw new CauError('考试页面里没有 dataList 表格，学校可能改版了', 'parse');
    var rows = matchAll(table, /<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    if (!rows.length) return { exams: [], published: false };

    var headers = matchAll(rows[0], /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi).map(cellText);
    function idx() {
      var names = arguments;
      for (var i = 0; i < headers.length; i++) {
        for (var j = 0; j < names.length; j++) {
          if (headers[i].indexOf(names[j]) >= 0) return i;
        }
      }
      return -1;
    }
    var cols = {
      campus: idx('校区'), session: idx('考试场次'), code: idx('课程编号'),
      name: idx('课程名称'), teacher: idx('授课教师'), time: idx('考试时间'),
      room: idx('考场'), seat: idx('座位号'), ticket: idx('准考证号'), note: idx('备注')
    };

    var exams = [];
    for (var ri = 1; ri < rows.length; ri++) {
      var cells = matchAll(rows[ri], /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi).map(cellText);
      if (cells.length === 1 && cells[0].indexOf('未查询到') >= 0) continue;
      if (!cells.some(function (x) { return !!x; })) continue;
      function at(k) {
        var i = cols[k];
        return (i >= 0 && i < cells.length) ? cells[i] : '';
      }
      var name = at('name');
      if (!name) continue;
      var when = at('time');
      var dateM = /(20\d{2})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/.exec(when);
      var date = '';
      if (dateM) {
        date = dateM[1] + '-' + ('0' + parseInt(dateM[2], 10)).slice(-2) +
          '-' + ('0' + parseInt(dateM[3], 10)).slice(-2);
      }
      var begin = '', end = '';
      var tm = /(\d{1,2}:\d{2})\s*[-~至]\s*(\d{1,2}:\d{2})/.exec(when);
      if (tm) { begin = tm[1]; end = tm[2]; }
      exams.push({
        campus: at('campus'), session: at('session'), code: at('code'), name: name,
        teacher: at('teacher'), time: when, date: date, begin: begin, end: end,
        room: at('room'), seat: at('seat'), ticket: at('ticket'), note: at('note')
      });
    }
    exams.sort(function (a, b) {
      var x = a.date || '9999', y = b.date || '9999';
      if (x !== y) return x < y ? -1 : 1;
      var p = a.begin || '', q = b.begin || '';
      return p < q ? -1 : p > q ? 1 : 0;
    });
    return { exams: exams, published: exams.length > 0 };
  }

  function parseProfile(html) {
    var name = '', sid = '';
    var m = /姓名[：:]\s*([^<\s]{1,20})/.exec(html);
    if (m) name = cleanText(m[1]);
    var m2 = /学号[：:]\s*([0-9A-Za-z]{4,30})/.exec(html);
    if (m2) sid = m2[1];
    return { name: name, studentId: sid };
  }

  /* ---------------------------------------------------------------- 网络层 */

  /* 原生 req2 是「发出去就不管」的，结果通过 window.__nativeDone(id, json) 回来。
     这张表把 id 映射回 Promise 的 resolve。 */
  var seq = 0;
  var waiting = {};

  window.__nativeDone = function (id, json) {
    var done = waiting[id];
    if (!done) return;
    delete waiting[id];
    var obj;
    try { obj = JSON.parse(json); }
    catch (e) { obj = { status: 0, body: '', url: '', error: '返回的不是 JSON' }; }
    done(obj);
  };

  function nativeReq(method, path, body, referer, headers) {
    return new Promise(function (resolve) {
      var id = ++seq;
      waiting[id] = resolve;
      try {
        A.req2(id, method, path, body || '', referer || '',
          headers ? JSON.stringify(headers) : '');
      } catch (e) {
        delete waiting[id];
        resolve({ status: 0, body: '', url: '', error: String(e) });
      }
    });
  }

  var lastAt = 0;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* 两次请求之间至少隔 POLITE_DELAY —— 别把学校服务器打疼。 */
  async function polite() {
    var gap = Date.now() - lastAt;
    if (gap < POLITE_DELAY) await sleep(POLITE_DELAY - gap);
    lastAt = Date.now();
  }

  /* 出错时把「哪一步、哪个地址」写进去。只写「连不上教务系统」的话，
     用户在手机上看到的就一句「网络问题」，谁也没法查。 */
  function briefPath(p) {
    var s = String(p || '');
    var i = s.indexOf('?');
    if (i >= 0) s = s.slice(0, i);
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  }

  async function http(method, path, body, referer, headers, label) {
    await polite();
    var r = await nativeReq(method, path, body, referer, headers);
    if (r.error) {
      throw new CauError((label || '连不上教务系统') + '（' + method + ' ' +
        briefPath(path) + '）：' + r.error, 'net');
    }
    return r;
  }

  function form(obj) {
    var out = [];
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] == null ? '' : obj[k]));
    }
    return out.join('&');
  }

  /* 连不上教务时多说一句人话。
     🔴 农大的教务系统（newjw.cau.edu.cn）解析到 **10.200.36.235** —— 校内地址，
        只有连校园网或学校 VPN 才通；而学校主页 www.cau.edu.cn 是公网的（202.205.x.x）。
        所以「主页能开、教务打不开」几乎一定是网络位置的问题，不是密码错、
        也不是 App 坏了。不把这句话说出来，用户只会看到「网络问题」四个字。
     只在失败时多花一个请求，平时一次都不发。 */
  async function netHint() {
    try {
      var r = await nativeReq('GET', 'https://www.cau.edu.cn/', '', '');
      if (!r.error && r.status < 500) {
        return '（学校主页能打开，但教务系统连不上 —— 教务只在校内网开放，' +
          '先连上校园网，或者用学校 VPN 再试）';
      }
      return '（学校主页也打不开，先看看手机本身有没有网）';
    } catch (e) {
      return '';
    }
  }

  /* ---------------------------------------------------------------- 更新检查 */

  /* App 内更新检查的版本源：仓库 main 分支上的 version.json ——
     build_apk.py 打包时会自动把新版本号/大小/sha256/更新说明写进去，
     推到 GitHub 之后这里就能读到。放两个源：raw.githubusercontent 在国内
     经常连不上，jsdelivr 的 CDN 一般通；按顺序试，成功一个就用。
     CDN 有几小时缓存，对「提醒有新版」这个用途无所谓 —— 它只提醒不强装。 */
  var UPDATE_SOURCES = [
    'https://raw.githubusercontent.com/k1ng-le0/campus/main/version.json',
    'https://cdn.jsdelivr.net/gh/k1ng-le0/campus@main/version.json'
  ];

  async function checkUpdateRemote() {
    for (var i = 0; i < UPDATE_SOURCES.length; i++) {
      var r = await nativeReq('GET', UPDATE_SOURCES[i], '', '', null);
      if (r.error || r.status !== 200 || !r.body) continue;
      try {
        var info = JSON.parse(r.body);
        // 🔴 只信形状对的：版本号必须是数字加点，别拿一页 HTML 当版本清单
        if (info && typeof info.version === 'string' &&
            /^[0-9]+(\.[0-9]+)*$/.test(info.version)) {
          return {
            ok: true,
            version: info.version,
            size: info.size || 0,
            sha256: info.sha256 || '',
            notes: Array.isArray(info.notes) ? info.notes : []
          };
        }
      } catch (e) { /* 这个源内容脏了，换下一个 */ }
    }
    return { ok: false, error: '版本源都连不上（也可能手机没网）' };
  }

  /* ---------------------------------------------------------------- 客户端 */

  var client = {
    loggedIn: false,
    user: '',
    pwd: '',
    semesters: null,
    current: null,
    lastTimetableHtml: ''
  };

  function resetClient() {
    client.loggedIn = false;
    client.user = '';
    client.pwd = '';
    client.semesters = null;
    client.current = null;
    client.lastTimetableHtml = '';
  }

  async function login(user, pwd) {
    // 先拿一个会话（JSESSIONID / SERVERID）
    await http('GET', JSXS + '/xsMain.jsp', '', JSXS + '/xsMain.jsp');

    // 种子在根路径，不在 /jsxsd 下（网页版 2026-10-31 实测）
    var seedResp = await http('POST', '/Logon.do?method=logon&flag=sess', '',
      JSXS + '/xsMain.jsp', { 'X-Requested-With': 'XMLHttpRequest' });
    var seed = String(seedResp.body || '').trim();
    if (seed.indexOf('#') < 0) {
      throw new CauError('没取到登录加密种子（服务器返回 ' +
        JSON.stringify(seed.slice(0, 40)) + '），学校可能改版了', 'parse');
    }
    var hash = seed.indexOf('#');
    var scode = seed.slice(0, hash), sxh = seed.slice(hash + 1);
    var encoded = encodePassword(user, pwd, scode, sxh);

    var r = await http('POST', '/Logon.do?method=logon', form({
      userAccount: user, userPassword: '', encoded: encoded, RANDOMCODE: ''
    }), JSXS + '/xsMain.jsp');

    var text = r.body || '';
    var url = r.url || '';
    var lower = url.toLowerCase();
    var ok = lower.indexOf('xsmain') >= 0 || lower.indexOf('framework') >= 0 ||
      url.indexOf('xsMain') >= 0;
    if (!ok) {
      if (text.indexOf('验证码') >= 0 || lower.indexOf('verifycode') >= 0 ||
        text.toLowerCase().indexOf('verifycode') >= 0) {
        throw new CauError('系统要求验证码：请先在浏览器登录一次，等几分钟再试', 'auth');
      }
      if (looksLogin(text)) throw new CauError('学号或密码不对', 'auth');
      if (text.indexOf('loginForm') < 0 && url.indexOf('xsMain.jsp') < 0) ok = true;
    }
    if (!ok) {
      throw new CauError('登录没成功（HTTP ' + r.status + '，停在 ' +
        (url || '未知地址') + '），学校系统可能临时抽风', 'net');
    }

    client.loggedIn = true;
    client.user = user;
    client.pwd = pwd;
    client.semesters = null;
    client.current = null;
    client.lastTimetableHtml = '';
  }

  async function ensureLogin(user, pwd) {
    if (!client.loggedIn) await login(user, pwd);
  }

  async function semesters() {
    if (client.semesters) return client.semesters;
    var r = await http('GET', JSXS + '/xskb/xskb_list.do', '', JSXS + '/xskb/xskb_list.do');
    var html = r.body || '';
    if (looksLogin(html)) {
      client.loggedIn = false;
      throw new CauError('登录态过期了，重新登录一次', 'expired');
    }
    client.lastTimetableHtml = html;
    var so = semesterOptions(html);
    if (!so.list.length) throw new CauError('课表页面里没有学期下拉框，学校可能改版了', 'parse');
    client.semesters = so.list;
    client.current = so.current;
    return so.list;
  }

  function currentSemester() {
    return client.current || { value: '', label: '', current: true };
  }

  async function timetable(semesterId, semesterName) {
    var html;
    if (!semesterId) {
      if (!client.lastTimetableHtml) {
        var r0 = await http('GET', JSXS + '/xskb/xskb_list.do', '', JSXS + '/xskb/xskb_list.do');
        client.lastTimetableHtml = r0.body || '';
      }
      html = client.lastTimetableHtml;
    } else {
      var r = await http('POST', JSXS + '/xskb/xskb_list.do',
        form({ xnxq01id: semesterId, zc: '' }), JSXS + '/xskb/xskb_list.do');
      html = r.body || '';
    }
    if (looksLogin(html)) {
      client.loggedIn = false;
      throw new CauError('登录态过期了，重新登录一次', 'expired');
    }
    var out = parseTimetable(html);
    if (semesterId && semesterName) {
      out.semester = semesterName;
      out.semesterId = semesterId;
    }
    if (out.semesters && out.semesters.length) {
      client.semesters = out.semesters;
      var cur = null;
      for (var i = 0; i < out.semesters.length; i++) {
        if (out.semesters[i].current) { cur = out.semesters[i]; break; }
      }
      if (cur) client.current = cur;
    }
    return out;
  }

  async function grades() {
    var r = await http('POST', JSXS + '/kscj/cjcx_list',
      form({ kksj: '', kcxz: '', kcmc: '', xsfs: 'all' }), JSXS + '/kscj/cjcx_list');
    var html = r.body || '';
    if (looksLogin(html)) {
      client.loggedIn = false;
      throw new CauError('登录态过期了，重新登录一次', 'expired');
    }
    return parseGrades(html);
  }

  async function exams(semesterId) {
    var list = [];
    try {
      var q = await http('GET', JSXS + '/xsks/xsksap_query', '', JSXS + '/xsks/xsksap_query');
      var so = semesterOptions(q.body || '');
      list = so.list;
      if (!semesterId && so.current) semesterId = so.current.value;
    } catch (e) { /* 查询页拿不到就用课表页的学期列表 */ }
    if (!list.length) list = await semesters();
    if (!semesterId) semesterId = currentSemester().value || '';

    var html = '';
    try {
      var r = await http('POST', JSXS + '/xsks/xsksap_list',
        form({ xqlbmc: '', xnxqid: semesterId }), JSXS + '/xsks/xsksap_list');
      html = r.body || '';
    } catch (e) { html = ''; }

    if (!html || looksLogin(html)) {
      try {
        var r2 = await http('GET', JSXS + '/xsks/xsksap_list?xnxqid=' +
          encodeURIComponent(semesterId) + '&xqlbmc=', '', JSXS + '/xsks/xsksap_list');
        html = r2.body || '';
      } catch (e) { html = ''; }
    }
    if (!html) {
      return { exams: [], published: false, semesterId: semesterId, semesters: list };
    }
    if (looksLogin(html)) {
      client.loggedIn = false;
      throw new CauError('登录态过期了，重新登录一次', 'expired');
    }
    var out = parseExams(html);
    out.semesterId = semesterId;
    out.semesters = list.length ? list : await semesters();
    return out;
  }

  async function profile() {
    var r = await http('GET', JSXS + '/framework/xsMain.jsp', '', JSXS + '/framework/xsMain.jsp');
    var html = r.body || '';
    if (looksLogin(html)) {
      client.loggedIn = false;
      throw new CauError('登录态过期了，重新登录一次', 'expired');
    }
    var p = parseProfile(html);
    if (!p.studentId) {
      try {
        var r2 = await http('GET', JSXS + '/grxx/xjxx', '', JSXS + '/grxx/xjxx');
        var p2 = parseProfile(r2.body || '');
        if (!p.name && p2.name) p.name = p2.name;
        if (!p.studentId && p2.studentId) p.studentId = p2.studentId;
      } catch (e) { /* 备用页打不开就算了，姓名学号不是必需 */ }
    }
    return p;
  }

  async function sync(username, password) {
    await login(username, password);
    var p = await profile();
    var sems = await semesters();
    var cur = currentSemester();
    var tt = await timetable(cur.value || '', cur.label || '');
    var gr = await grades();
    var ex;
    try {
      ex = await exams(cur.value || '');
    } catch (e) {
      ex = { exams: [], published: false, error: String(e && e.message || e), semesters: sems };
    }
    return {
      ok: true,
      syncedAt: Math.floor(Date.now() / 1000),
      profile: p,
      semester: cur.label || '',
      semesterId: cur.value || '',
      semesters: sems,
      unitCount: tt.unitCount,
      times: tt.times,
      totalWeeks: tt.totalWeeks,
      courses: tt.courses,
      grades: gr,
      exams: ex
    };
  }

  /* ---------------------------------------------------------------- 公告 */

  /* 学生不关心的噪音：招聘/招租/招标/采购。和 notice_cau.py 的 _DROP 同一份。 */
  var DROP = [
    '招聘', '招租', '招标', '采购', '中标', '询价', '博士后', '科研助理',
    '拟聘', '合同聘用', '人员公示', '人才派遣', '劳务派遣',
    '人才评议', '中选', '遴选', '合作经营', '公开遴选',
    '诚聘', '财务助理', '科研/财务', '院务会'
  ];

  var noticeCache = { at: 0, data: null, full: [] };

  function dropped(title) {
    for (var i = 0; i < DROP.length; i++) if (title.indexOf(DROP[i]) >= 0) return true;
    return false;
  }

  function absoluteUrl(base, href) {
    try { return new URL(href, base).toString(); } catch (e) { return href; }
  }

  function hostOf(url) {
    try { return (new URL(url).hostname || '').toLowerCase(); } catch (e) { return ''; }
  }

  function isCau(url) {
    var h = hostOf(url);
    return h === 'cau.edu.cn' || /\.cau\.edu\.cn$/.test(h);
  }

  async function fetchHtml(url) {
    var r = await http('GET', url, '', '', null, '连不上学校通知页');
    if (r.status >= 400) throw new Error('HTTP ' + r.status);
    return r.body || '';
  }

  function parseNoticeList(html, base, limit, sourceName, drop, stats) {
    var items = [];
    var blocks = divBlocks(html, 'item');
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var dm = /class=["'][^"']*\bday\b[^"']*["'][^>]*>\s*(\d{1,2})\s*</i.exec(block);
      var mm = /class=["'][^"']*\bmonth\b[^"']*["'][^>]*>\s*([\d.]{5,10})\s*</i.exec(block);
      if (!dm || !mm) continue;
      var tm = /<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
      if (!tm) continue;
      var title = noticeClean(tm[2]);
      if (!title) continue;
      if (drop !== false && dropped(title)) {
        if (stats) stats.hidden++;
        continue;
      }

      var dept = '';
      var dm2 = /<a[^>]*class=["'][^"']*\btip\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
      if (dm2) dept = noticeClean(dm2[1]);

      var date = '';
      var nums = (mm[1].match(/\d+/g) || []);
      if (nums.length >= 2) {
        date = ('0000' + parseInt(nums[0], 10)).slice(-4) + '-' +
          ('0' + parseInt(nums[1], 10)).slice(-2) + '-' +
          ('0' + parseInt(dm[1], 10)).slice(-2);
      }
      var url = absoluteUrl(base, tm[1].trim());
      if (!isCau(url)) continue;      // 只收学校域名，别变成外链跳板

      items.push({ title: title, url: url, date: date, source: sourceName, dept: dept });
      if (items.length >= limit) break;
    }
    return items;
  }

  function parseJwc(html, base, limit, drop, stats) {
    var items = [];
    var liRe = /<li[^>]*class=["'][^"']*effect[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
    var m;
    while ((m = liRe.exec(html)) !== null) {
      var block = m[1];
      var hm = /<a[^>]+href=["']([^"']+)["']/i.exec(block);
      var tm = /<h3[^>]*class=["'][^"']*bbs-title[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i.exec(block);
      if (!hm || !tm) continue;
      var title = noticeClean(tm[1]);
      if (!title) continue;
      if (drop !== false && dropped(title)) {
        if (stats) stats.hidden++;
        continue;
      }

      var date = '';
      var dm = /<span[^>]*class=["'][^"']*bbs-time[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(block);
      if (dm) {
        var raw = noticeClean(dm[1]);
        var d2 = /(\d{1,2})\/(\d{1,2}),?\s*(20\d{2})/.exec(raw);
        if (d2) {
          date = d2[3] + '-' + ('0' + parseInt(d2[1], 10)).slice(-2) +
            '-' + ('0' + parseInt(d2[2], 10)).slice(-2);
        }
      }
      var tag = '';
      var gm = /<span[^>]*class=["'][^"']*bbs-tag[^"']*["'][^>]*>[\s\S]*?<i>([\s\S]*?)<\/i>/i.exec(block);
      if (gm) tag = noticeClean(gm[1]);

      var url = absoluteUrl(base, hm[1].trim());
      if (!isCau(url)) continue;
      items.push({ title: title, url: url, date: date, source: '本科生院', dept: tag });
      if (items.length >= limit) break;
    }
    return items;
  }

  /* 取通知列表。
     🔴 学校主页「通知公告」一页 20 条里，招聘/招租/人才评议能占 18 条
        （2026-11-01 实测）。只翻一页又滤掉噪音的话，列表就剩两三条、
        最新的一条还是半个月前的 —— 用户会以为程序坏了。所以：
          · 翻 6 页，够一屏就停（少给学校服务器添麻烦）；
          · 把「藏了几条」如实报上去（hidden），界面给一个「显示全部」的开关。 */
  async function fetchNotice(limit, force, all) {
    limit = Math.max(1, Math.min(80, parseInt(limit, 10) || 40));
    var now = Date.now();
    if (!all && !force && noticeCache.data && now - noticeCache.at < NOTICE_TTL) {
      var cached = JSON.parse(JSON.stringify(noticeCache.data));
      cached.items = noticeCache.full.slice(0, limit);
      cached.total = noticeCache.full.length;
      cached.cached = true;
      return cached;
    }

    var listUrl = 'https://www.cau.edu.cn/tzgg/index.htm';
    var pages = [listUrl];
    for (var i = 1; i <= 5; i++) pages.push(absoluteUrl(listUrl, 'index' + i + '.htm'));

    var stats = { hidden: 0 };
    var items = [], seen = {}, lastErr = '', sourceCount = 0;
    for (var p = 0; p < pages.length; p++) {
      try {
        var page = await fetchHtml(pages[p]);
        var got = parseNoticeList(page, pages[p], 80, '学校通知', !all, stats);
        for (var g = 0; g < got.length; g++) {
          if (seen[got[g].url]) continue;
          seen[got[g].url] = 1;
          items.push(got[g]);
          if (items.length >= 80) break;
        }
      } catch (e) {
        lastErr = String(e && e.message || e);
      }
      if (items.length >= limit) break;   // 够一屏就不再翻下一页
    }

    try {
      var jwc = await fetchHtml('https://jwc.cau.edu.cn/');
      var got2 = parseJwc(jwc, 'https://jwc.cau.edu.cn/', 80, !all, stats);
      for (var j = 0; j < got2.length; j++) {
        if (seen[got2[j].url]) continue;
        seen[got2[j].url] = 1;
        items.push(got2[j]);
      }
      sourceCount = 2;
    } catch (e2) {
      lastErr = String(e2 && e2.message || e2);
    }

    if (!items.length) {
      return {
        ok: false, error: lastErr || '页面里没解析出通知，学校可能改版了',
        items: [], total: 0, hidden: stats.hidden
      };
    }

    items.sort(function (a, b) {
      var x = a.date || '0000-00-00', y = b.date || '0000-00-00';
      return x < y ? 1 : x > y ? -1 : 0;
    });

    var data = {
      ok: true, at: Math.floor(now / 1000), cached: false,
      total: items.length, items: items.slice(0, limit),
      sources: sourceCount || 1, hidden: stats.hidden, all: !!all
    };
    if (!all) {
      noticeCache.at = now;
      noticeCache.data = data;
      noticeCache.full = items;
    }
    return data;
  }

  /* ---------------------------------------------------------------- 凭据 */

  function loadCred() {
    try {
      var raw = A.loadCred();
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.u || !o.p) return null;
      return { u: o.u, p: o.p };
    } catch (e) { return null; }
  }

  function saveCred(user, pwd) {
    try { return String(A.saveCred(user, pwd) || ''); }
    catch (e) { return 'fail: ' + e; }
  }

  function credState() {
    try { return String(A.credState() || 'none'); } catch (e) { return 'none'; }
  }

  /* ---------------------------------------------------------------- 路由 */

  function errObj(e) {
    var out = { ok: false, error: String((e && e.message) || e) };
    if (e && e.kind) {
      out.kind = e.kind;
      if (e.kind === 'auth') out.authFail = true;
    }
    return out;
  }

  function queryOf(url) {
    var i = url.indexOf('?');
    var q = {};
    if (i < 0) return q;
    var pairs = url.slice(i + 1).split('&');
    for (var k = 0; k < pairs.length; k++) {
      if (!pairs[k]) continue;
      var eq = pairs[k].indexOf('=');
      var key = eq < 0 ? pairs[k] : pairs[k].slice(0, eq);
      var val = eq < 0 ? '' : pairs[k].slice(eq + 1);
      try { q[decodeURIComponent(key)] = decodeURIComponent(val.replace(/\+/g, ' ')); }
      catch (e) { q[key] = val; }
    }
    return q;
  }

  function pathOf(url) {
    var u = url;
    if (u.indexOf(location.origin) === 0) u = u.slice(location.origin.length);
    var i = u.indexOf('?');
    return i < 0 ? u : u.slice(0, i);
  }

  /* 每次同步/取数前都确认一次登录态：会话是「独占」的，
     别的地方登一次就把我们挤下线（学校系统的行为）。 */
  async function withLogin(fn) {
    var cred = loadCred();
    if (!cred) {
      var e = new CauError('还没绑定账号', 'auth');
      e.needBind = true;
      throw e;
    }
    await ensureLogin(cred.u, cred.p);
    try {
      return await fn(cred);
    } catch (err) {
      // 会话过期只重登一次，不循环打学校服务器
      if (err && (err.kind === 'expired')) {
        client.loggedIn = false;
        await login(cred.u, cred.p);
        return await fn(cred);
      }
      throw err;
    }
  }

  /* 🔴 q 必须从**带 query 的完整地址**里取。以前这里传进来的是 pathOf() 的结果
     （已经把 ?xxx 切掉了），于是 q.semester / q.limit / q.force 全是空 ——
     表现是「考试页切学期没反应」「公告永远按默认 40 条取」，而且不报错。
     path 和 q 分开传，谁也别替谁做决定。 */
  async function route(path, q, method, body) {
    if (path === '/api/health') return { ok: true, version: '0.1' };

    if (path === '/api/update') {
      return await checkUpdateRemote();
    }

    if (path === '/api/state') {
      var cred = loadCred();
      return {
        ok: true, bound: !!cred, username: cred ? cred.u : '',
        credState: credState()
      };
    }

    if (path === '/api/semesters') {
      var c0 = loadCred();
      if (!c0) return { ok: false, error: '还没绑定账号', needBind: true };
      var sems = await withLogin(function () { return semesters(); });
      return { ok: true, semesters: sems };
    }

    if (path === '/api/timetable') {
      var c1 = loadCred();
      if (!c1) return { ok: false, error: '还没绑定账号', needBind: true };
      var out = await withLogin(function () {
        return timetable((q.semester || '').trim(), (q.name || '').trim());
      });
      out.ok = true;
      return out;
    }

    if (path === '/api/exams') {
      var c2 = loadCred();
      if (!c2) return { ok: false, error: '还没绑定账号', needBind: true };
      var ex = await withLogin(function () {
        return exams((q.semester || '').trim());
      });
      ex.ok = true;
      return ex;
    }

    if (path === '/api/grades') {
      var c3 = loadCred();
      if (!c3) return { ok: false, error: '还没绑定账号', needBind: true };
      var gr = await withLogin(function () { return grades(); });
      gr.ok = true;
      return gr;
    }

    if (path === '/api/notice') {
      // 公告是公开页面，不需要绑定
      return fetchNotice(q.limit, q.force === '1', q.all === '1');
    }

    if (path === '/api/login') {
      var user = String((body && body.username) || '').trim();
      var pwd = String((body && body.password) || '');
      if (!user || !pwd) return { ok: false, error: '请填学号和密码' };
      resetClient();
      var payload;
      try {
        payload = await sync(user, pwd);
      } catch (e) {
        if (e && e.kind === 'net') e.message = String(e.message) + await netHint();
        throw e;
      }
      if (!body || body.remember !== false) {
        var saved = saveCred(user, pwd);
        payload.saved = saved;
      }
      return payload;
    }

    if (path === '/api/sync') {
      var cred2 = loadCred();
      if (!cred2) return { ok: false, error: '还没绑定账号', needBind: true };
      resetClient();
      try {
        return await sync(cred2.u, cred2.p);
      } catch (e) {
        if (e && e.kind === 'net') e.message = String(e.message) + await netHint();
        throw e;
      }
    }

    if (path === '/api/unbind') {
      try { A.clearCred(); } catch (e) { /* 清不掉也要把界面状态改过来 */ }
      resetClient();
      try { A.clearCookies(); } catch (e2) { /* 老壳没有这个方法就算了 */ }
      return { ok: true };
    }

    return { ok: false, error: 'not found' };
  }

  /* 假的 Response：app.js 只用 status / ok / json()，够用。 */
  function respond(status, obj) {
    return {
      ok: status >= 200 && status < 300,
      status: status,
      json: function () { return Promise.resolve(obj); },
      text: function () { return Promise.resolve(JSON.stringify(obj)); }
    };
  }

  var realFetch = window.fetch ? window.fetch.bind(window) : null;

  window.fetch = function (input, opt) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') === 0 || url.indexOf(location.origin + '/api/') === 0) {
      var method = ((opt && opt.method) || 'GET').toUpperCase();
      var body = null;
      if (opt && opt.body) {
        try { body = JSON.parse(opt.body); } catch (e) { body = null; }
      }
      var path = pathOf(url);
      var q = queryOf(url);
      return route(path, q, method, body).then(function (obj) {
        return respond(200, obj);
      }, function (err) {
        // 🔴 失败也要回 200 + ok:false：界面靠 body 里的 error/kind 说人话，
        //    回 500 只会让它显示「本地服务返回的不是 JSON」。
        return respond(200, errObj(err));
      });
    }
    if (realFetch) return realFetch(input, opt);
    return Promise.reject(new Error('没有可用的 fetch'));
  };

  /* 公告点开走系统浏览器。WebView 里的 window.open 默认什么都不做，
     点了没反应比跳出去更糟。 */
  var realOpen = window.open;
  window.open = function (url) {
    if (url && typeof A.openUrl === 'function') {
      A.openUrl(String(url));
      /* 🔴 必须返回一个「看着像窗口」的对象：app.js 拿到 null 会以为被浏览器
         拦了，弹一句「长按链接复制到浏览器打开」—— 可浏览器其实已经打开了，
         这句话纯属误导。返回个空壳就不弹了。 */
      return { closed: false, focus: function () {}, close: function () {} };
    }
    return realOpen ? realOpen.apply(window, arguments) : null;
  };

  /* ---------------------------------------------------------------- 自检 */

  /* 登录失败时最烦的是「网络问题」四个字什么都不说 —— 到底是没网、DNS 解析
     不了、证书不认、还是学校跳转把 Android 拦了，全靠猜。
     这个按钮把三个关键请求各跑一遍，把状态码/耗时/最终地址/异常原样列出来，
     截图就能定位。只在 App 里出现（网页版没有这一段，浏览器自己带开发者工具）。 */
  function mountDiag() {
    var sheet = document.getElementById('loginSheet');
    if (!sheet || document.getElementById('cauDiagBtn')) return;
    var body = sheet.querySelector('.sheet-body');
    if (!body) return;

    // 网页版那句「用 Windows 加密」在手机上是错的，改掉
    var hints = body.querySelectorAll('p.hint');
    if (hints.length) {
      hints[0].innerHTML = '用的是<strong>教务系统</strong>（newjw.cau.edu.cn）的学号密码，' +
        '不是校园网密码。密码用 Android Keystore 加密后只存本机；也可以随时解除绑定。';
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'cauDiagBtn';
    btn.className = 'btn block';
    btn.style.marginTop = '8px';
    btn.textContent = '网络自检';

    var out = document.createElement('pre');
    out.id = 'cauDiagOut';
    out.style.cssText = 'display:none;margin:10px 0 0;padding:10px;border-radius:10px;' +
      'background:rgba(120,120,128,.14);font-size:11px;line-height:1.6;white-space:pre-wrap;' +
      'word-break:break-all;max-height:230px;overflow:auto;' +
      '-webkit-user-select:text;user-select:text';

    btn.onclick = function () { runDiag(btn, out); };
    body.appendChild(btn);
    body.appendChild(out);
  }

  async function runDiag(btn, out) {
    btn.disabled = true;
    out.style.display = 'block';
    out.textContent = '正在测…（最多十几秒）';

    var lines = ['联网：' + (navigator.onLine === false ? '系统说没有网络' : '有')];
    // 三个探针分开看：学校主页通 → 网络没问题；教务首页通 → 域名和证书没问题；
    // 种子拿不到 → 才是学校改版或风控。
    var probes = [
      ['学校主页', 'GET', 'https://www.cau.edu.cn/', '', null],
      ['教务首页', 'GET', BASE + JSXS + '/xsMain.jsp', '', null],
      ['登录种子', 'POST', BASE + '/Logon.do?method=logon&flag=sess', '',
        { 'X-Requested-With': 'XMLHttpRequest' }]
    ];

    for (var i = 0; i < probes.length; i++) {
      var p = probes[i];
      var t0 = Date.now();
      var r = await nativeReq(p[1], p[2], p[3], p[4], p[5]);
      var ms = Date.now() - t0;
      if (r.error) {
        lines.push(p[0] + '：失败（' + ms + 'ms）\n  ' + r.error);
      } else {
        var extra = p[0] === '登录种子'
          ? '  内容 ' + JSON.stringify(String(r.body || '').slice(0, 40))
          : '';
        lines.push(p[0] + '：HTTP ' + r.status + '（' + ms + 'ms，' +
          String(r.body || '').length + ' 字节）' + extra + '\n  ' + (r.url || ''));
      }
      await sleep(400);   // 别连着捶学校服务器
    }

    out.textContent = lines.join('\n');
    btn.disabled = false;
  }

  /* ---------------------------------------------------------------- 启动 */

  /* 网页版靠地址栏里的 ?k= 拿到访问口令，App 里没有这回事 —— 但 app.js
     在没有口令时会直接把界面停在「未绑定」。这里先塞一个，
     它只是个「界面开关」，不是任何形式的鉴权（App 里没有网络入口可鉴）。 */
  try {
    if (!localStorage.getItem('cau.token')) {
      localStorage.setItem('cau.token', JSON.stringify('app'));
    }
  } catch (e) { /* 隐私模式下 localStorage 可能不可用，不影响主流程 */ }

  try {
    mountDiag();
  } catch (e) { /* 自检按钮是锦上添花，别因为它把整页弄挂 */ }
})();
