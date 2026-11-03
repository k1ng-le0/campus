/* 在综合服务平台（one.cau.edu.cn）页面里跑：把「通知公告」那块的通知抠出来，
   交给原生存起来，主界面的公告页就能显示。

   ================================================================
   为什么不写死选择器
   ================================================================
   门户是金智 tp_up 那套 SPA，DOM 结构随版本变，class 名还是自动生成的
   （一堆 `gp-f16`、`boxshadow` 这种）。写死 `.notice-list li .title` 这种，
   学校一升级就静默失效 —— 而静默失效最难查：界面只是"没有新通知"。

   所以这里按**形状**找，不按名字找：
     一行里同时有「日期」和「一个够长的链接」→ 那就是一条通知。
   宁可多抓几条（用户一眼能看出不对），也不要悄悄抓不到。

   三道筛子（前两道是被假页面测出来的）：
     1. 可见性 —— 非当前 tab 的容器是 display:none，里面的链接也有日期；
     2. 标题不能只剩日期 —— 导航里那种「2026-10-30 校历」会被误判；
     3. 这一行得有**同样带日期的兄弟行** —— 通知列表是一条条排下来的，
        导航栏/页脚不是。第 3 条先严格，一条都没抓到时再放宽重试。

   入口：原生注入，跑完调 PortalBridge.save(json) / PortalBridge.fail(原因)。
*/
(function () {
  var API = window.PortalBridge;
  if (!API) return;

  try {
    var DATE = /(20\d{2}|\d{2})\s*[-.\/年]\s*(\d{1,2})\s*[-.\/月]\s*(\d{1,2})/;
    var DATE_G = new RegExp(DATE.source, 'g');

    function txt(el) {
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function normDate(m) {
      var y = m[1].length === 2 ? '20' + m[1] : m[1];
      return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    }

    /* 非当前 tab 的容器是 display:none。用 computed style 往上查，而不是量尺寸：
       量尺寸在无头环境里全是 0，会把整页判成不可见。 */
    function visible(el) {
      var node = el;
      var guard = 0;
      while (node && node.nodeType === 1 && guard++ < 40) {
        var st = null;
        try { st = window.getComputedStyle(node); } catch (e) { st = null; }
        if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
        node = node.parentElement;
      }
      return true;
    }

    /* 这一行是不是「列表里的一行」：至少还有一个兄弟行也带日期。
       导航栏、页脚、侧边栏都过不了这一关。 */
    function hasDatedSibling(row) {
      var parent = row && row.parentElement;
      if (!parent) return false;
      var kids = parent.children;
      var dated = 0;
      for (var i = 0; i < kids.length && i < 30; i++) {
        if (kids[i] === row) continue;
        if (DATE.test(txt(kids[i]))) dated++;
      }
      return dated >= 1;
    }

    function collect(requireList) {
      var out = [];
      var seen = {};
      var links = document.querySelectorAll('a[href]');

      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var href = a.href || '';
        if (!href || href.indexOf('javascript:') === 0) continue;

        var t = txt(a);
        if (t.length < 6 || t.length > 160) continue;   // 太短是图标/按钮，太长是整段
        if (!visible(a)) continue;

        // 往上找「这一行」：最近的、文本里带日期的祖先，最多 5 层
        var row = a;
        var date = '';
        var guard = 0;
        while (row && guard++ < 5) {
          var rt = txt(row);
          if (rt.length > 400) { row = null; break; }    // 已经找到整页了，收手
          var m = DATE.exec(rt);
          if (m) { date = normDate(m); break; }
          row = row.parentElement;
        }
        if (!date || !row) continue;
        if (requireList && !hasDatedSibling(row)) continue;

        // 同一行里有多个链接时，取文本最长的当标题（部门名通常很短）
        var best = a, bestT = t;
        var inner = row.querySelectorAll('a[href]');
        for (var k = 0; k < inner.length; k++) {
          var it = txt(inner[k]);
          if (it.length > bestT.length) { best = inner[k]; bestT = it; }
        }

        // 「2026-10-30 校历」这种：标题里除了日期就没剩几个字 → 不是通知
        if (DATE.test(bestT)) {
          var clean = bestT.replace(DATE_G, ' ').replace(/\s+/g, ' ').trim();
          if (clean.length < 4) continue;
        }

        var url = best.href;
        if (!url || seen[url]) continue;
        seen[url] = 1;

        out.push({ title: bestT, url: url, date: date });
        if (out.length >= 80) break;
      }
      return out;
    }

    // 先按严格规则来；一条都没有（学校改版成别的排版）就放宽重试
    var items = collect(true);
    if (!items.length) items = collect(false);

    items.sort(function (x, y) {
      var a1 = x.date || '0000-00-00', b1 = y.date || '0000-00-00';
      return a1 < b1 ? 1 : a1 > b1 ? -1 : 0;
    });

    if (API.save) API.save(JSON.stringify(items));
  } catch (e) {
    if (API.fail) API.fail(String(e));
  }
})();
