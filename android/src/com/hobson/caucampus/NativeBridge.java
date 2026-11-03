package com.hobson.caucampus;

import android.content.Intent;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JS 与原生之间唯一的通道。
 *
 * 分工：这里**只负责发 HTTP 和带 cookie**，登录/解析全在 web/localapi.js 里。
 * 之所以不把解析也搬过来：那边的正则和 cau_jw.py 是同一套（开发期两边跑过
 * 同一批真实页面对过账），搬进 Java 就等于要维护第二份解析，迟早漂。
 *
 * 🔴 请求必须异步回：Android.req2 是阻塞调用，如果让 JS 同步等，登录加同步
 *    要十几秒，整页会僵住 —— 转圈动画都不动，用户会以为死机了。
 *    所以这里丢线程池，完成后用 evaluateJavascript 回调 window.__nativeDone。
 */
public class NativeBridge {

    /** 教务系统。课表/成绩/考试都在这一个域名下。 */
    private static final String BASE = "https://newjw.cau.edu.cn";

    /**
     * 和 cau_jw.py 的 UA 保持一致（桌面 Chrome）。
     * 强智不看 UA，但两边一样的话，出问题时对比日志能少一个变量。
     */
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    private final WebView web;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    public NativeBridge(WebView web) {
        this.web = web;
    }

    /** 发一个请求，结果异步回给 JS。参数与 localapi.js 里的 nativeReq 一一对应。 */
    @JavascriptInterface
    public void req(final int id, final String method, final String path,
                    final String body, final String referer) {
        req2(id, method, path, body, referer, null);
    }

    /**
     * 带自定义请求头的版本。`headersJson` 形如 `{"X-Requested-With":"XMLHttpRequest"}`。
     *
     * 为什么需要单独一个方法而不是给 req 加参数：req 是既有接口，
     * 前端几十处调用都按 5 个参数写，改签名要全动一遍，风险不值得。
     *
     * 🔴 强智取登录种子的那个请求要带 `X-Requested-With: XMLHttpRequest`，
     *    没有这个重载就发不出去 —— 表现是「拿不到加密种子」。
     */
    @JavascriptInterface
    public void req2(final int id, final String method, final String path,
                     final String body, final String referer, final String headersJson) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                String text;
                try {
                    text = doReq(method, path, body, referer, headersJson);
                } catch (Throwable t) {
                    text = fail(String.valueOf(t));
                }
                final String json = text;
                // evaluateJavascript 必须在 UI 线程
                web.post(new Runnable() {
                    @Override
                    public void run() {
                        web.evaluateJavascript(
                                "window.__nativeDone(" + id + "," + JSONObject.quote(json) + ")",
                                null);
                    }
                });
            }
        });
    }

    private String doReq(String method, String path, String body, String referer,
                         String headersJson) throws Exception {
        // 传绝对地址（http:// 或 https:// 开头）就按原样发，否则拼在教务系统的 BASE 后面。
        // 为什么需要：校园公告要访问 www.cau.edu.cn / jwc.cau.edu.cn，
        // 它们跟教务系统不是同一个域名，写死 BASE + path 根本发不出去。
        boolean absolute = path != null
                && (path.startsWith("http://") || path.startsWith("https://"));
        String url = absolute ? path : BASE + path;

        String m = (method == null || method.isEmpty()) ? "GET" : method;
        String b = body;
        String lastUrl = url;
        int code = 0;
        String text = "";

        // 🔴 跳转自己跟，不用 setInstanceFollowRedirects(true)。
        //    内建跟法有三个坑，真机上全都踩得到：
        //      1. **https → http 的跳转它不跟**，直接把 302 和空 body 甩回来 ——
        //         表现就是「登录没成功，学校系统可能临时抽风」，而网页版好好的
        //         （Python 的 requests 什么跳转都跟）；
        //      2. 307/308 不跟；
        //      3. 跟过去之后拿不到最终地址，出错时说不清停在哪一步。
        //    ⚠️ 这里跟的同时**不重发 body**（301/302/303 按规范改成 GET），
        //       登录 POST 跳过去就是一次干净的 GET，和浏览器行为一致。
        for (int hop = 0; hop < 6; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            try {
                c.setRequestMethod(m);
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setInstanceFollowRedirects(false);
                c.setRequestProperty("User-Agent", UA);
                c.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
                c.setRequestProperty("Accept",
                        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

                // 🔴 Origin 只给教务系统带。公告站是公开页面，多一个 Origin 反而像伪造来源。
                if (url.startsWith(BASE)) c.setRequestProperty("Origin", BASE);
                if (referer != null && !referer.isEmpty()) {
                    // 绝对地址的 referer 也按原样用，不然会拼成
                    // https://newjw.cau.edu.cnhttps://www.cau.edu.cn 这种鬼东西
                    boolean refAbsolute = referer.startsWith("http://")
                            || referer.startsWith("https://");
                    c.setRequestProperty("Referer", refAbsolute ? referer : BASE + referer);
                }
                // 🔴 自定义头必须在写 body **之前**设置：getOutputStream() 会触发
                //    connect，之后再 setRequestProperty 直接抛 IllegalStateException。
                boolean hasCt = applyHeaders(c, headersJson);
                if (b != null && !b.isEmpty()) {
                    c.setDoOutput(true);
                    if (!hasCt) {
                        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                    }
                    byte[] raw = b.getBytes(StandardCharsets.UTF_8);
                    c.setFixedLengthStreamingMode(raw.length);
                    OutputStream os = c.getOutputStream();
                    os.write(raw);
                    os.close();
                }

                code = c.getResponseCode();
                lastUrl = String.valueOf(c.getURL());

                if (code >= 300 && code < 400) {
                    String loc = c.getHeaderField("Location");
                    if (loc == null || loc.isEmpty()) break;      // 没地址可跟，原样返回
                    String next = new URL(new URL(lastUrl), loc).toString();
                    if (!(code == 307 || code == 308)) {
                        m = "GET";
                        b = null;
                    }
                    url = next;
                    continue;
                }

                InputStream in = (code >= 400) ? c.getErrorStream() : c.getInputStream();
                text = readAll(in);
                break;
            } finally {
                c.disconnect();
            }
        }

        JSONObject o = new JSONObject();
        o.put("status", code);
        o.put("body", text);
        o.put("url", lastUrl);
        return o.toString();
    }

    /** 把 JS 传来的 `{"k":"v"}` 逐个设成请求头。返回是否设过 Content-Type。
     *
     *  解析失败就当没传 —— 宁可少一个头让请求正常失败（能看到 401），
     *  也不要整个请求炸掉。
     */
    private static boolean applyHeaders(HttpURLConnection c, String headersJson) {
        boolean hasCt = false;
        if (headersJson == null || headersJson.isEmpty()) return hasCt;
        try {
            JSONObject o = new JSONObject(headersJson);
            java.util.Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                String v = o.optString(k, "");
                if (k == null || k.isEmpty() || "content-length".equalsIgnoreCase(k)) continue;
                if ("content-type".equalsIgnoreCase(k)) hasCt = true;
                c.setRequestProperty(k, v);
            }
        } catch (Throwable ignored) {
            // 见上：静默跳过，但请求本身照发
        }
        return hasCt;
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        // 农专教务页面声明 charset="UTF-8"（开发期抓的样本核对过）；
        // 用 Python 版对照过，别改成平台默认编码
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String fail(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("status", 0);
            o.put("body", "");
            o.put("url", "");
            o.put("error", msg);
            return o.toString();
        } catch (Exception e) {
            return "{\"status\":0,\"body\":\"\",\"url\":\"\",\"error\":\"unknown\"}";
        }
    }

    // ---------------------------------------------------------------- 凭据
    // 不走网络，直接同步返回，省得 JS 里再包一层 Promise。

    /** 取回 {"u":"学号","p":"密码"}；没有或解不开返回空串。 */
    @JavascriptInterface
    public String loadCred() {
        return CredStore.load();
    }

    /**
     * 存凭据。
     *
     * 🔴 返回空串 = 成功，其余是原因（"soft" / "fail: xxx"）。
     *    界面必须把原因原样说出来 —— 不许再出现「提示保存成功、下次又要重输」。
     */
    @JavascriptInterface
    public String saveCred(String user, String pass) {
        return CredStore.save(user, pass);
    }

    /** "none" / "ok" / "broken"，给界面区分「没存过」和「存着但解不开」。 */
    @JavascriptInterface
    public String credState() {
        return CredStore.state();
    }

    @JavascriptInterface
    public void clearCred() {
        CredStore.clear();
    }

    /**
     * 清掉教务系统的会话 cookie（不动本机存的账号密码）。
     *
     * 直接操作全局 CookieManager（MainActivity 里 setDefault 的那个），
     * 不用 android.webkit.CookieManager —— 那一个是 WebView 的，
     * 跟 HttpURLConnection 用的不是同一个罐子。
     */
    @JavascriptInterface
    public boolean clearCookies() {
        try {
            java.net.CookieHandler h = java.net.CookieHandler.getDefault();
            if (h instanceof java.net.CookieManager) {
                ((java.net.CookieManager) h).getCookieStore().removeAll();
                return true;
            }
            return false;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 在应用内打开综合服务平台（校内通知在里面，需要登录一次）。
     *
     * 返回 "" = 打开了；"fail: xxx" = 起不来（界面会退化成系统浏览器）。
     * 为什么不复用 openUrl：那个交给系统浏览器，登录态在浏览器自己的罐子里，
     * 每次点进来都要重登，而且看完回不到 App。
     */
    @JavascriptInterface
    public String openPortal() {
        return openPortal(null);
    }

    /** 带地址的版本：主界面列表里点某条校内通知，直接开在那一页。 */
    @JavascriptInterface
    public String openPortal(String url) {
        try {
            Intent it = new Intent(web.getContext(), PortalActivity.class);
            if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                it.putExtra(PortalActivity.EXTRA_URL, url);
            }
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            web.getContext().startActivity(it);
            return "";
        } catch (Throwable t) {
            return "fail: " + t;
        }
    }

    /**
     * 读门户那边同步下来的校内通知。返回 `{"at":秒,"items":[...]}`，没同步过返回空串。
     *
     * 🔴 这份数据是 PortalActivity 里注入脚本抓的（见 res/raw/portal_scrape.js）。
     *    抓不到就是空串 —— 界面必须按「没有」处理，不许编数据。
     */
    @JavascriptInterface
    public String loadPortalNotices() {
        try {
            android.content.SharedPreferences p = web.getContext()
                    .getSharedPreferences("caucampus", android.content.Context.MODE_PRIVATE);
            String items = p.getString("portal.notices", "");
            if (items == null || items.isEmpty()) return "";
            long at = p.getLong("portal.at", 0);
            return "{\"at\":" + at + ",\"items\":" + items + "}";
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 用系统浏览器打开一个链接（公告原文走这里）。
     *
     * 🔴 为什么不在 WebView 里直接跳：公告原文里有一堆附件、图片、外链，
     *    在浏览器里打开是它本来该有的样子；而且跳出去之后「返回」就回到 App，
     *    用户不会在 App 里迷路。
     *
     * 只放行 http/https：别的 scheme（file:、intent:、javascript:）一律不接，
     * 免得以后哪份公告被人改成跳板，变成一个能执行任意 Intent 的后门。
     */
    @JavascriptInterface
    public void openUrl(final String url) {
        if (url == null) return;
        String u = url.trim();
        if (!(u.startsWith("http://") || u.startsWith("https://"))) return;
        try {
            Intent it = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            web.getContext().startActivity(it);
        } catch (Throwable t) {
            // 没有浏览器 / 被系统拦了：静默失败。总比弹一个 Java 异常框强。
        }
    }
}
