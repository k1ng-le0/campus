package com.hobson.caucampus;

import android.annotation.SuppressLint;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.app.Activity;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * CAU 校园通 · 唯一的一个界面。
 *
 * 界面本身是 WebView 里那套 HTML/CSS/JS（和网页版同一份代码），
 * 原生这边只干三件网页干不了的事：
 *   1. 用 https://app.local/ 把 assets 里的页面当「同源网页」发出去；
 *      直接从 file:// 加载的话，localStorage 在部分 WebView 版本上不可靠，
 *      而课表/成绩缓存全靠它。
 *   2. 提供 Android.req2()：真正的 HTTP 请求（带 cookie），见 NativeBridge。
 *   3. 提供 Keystore 加密的凭据存取，见 CredStore。
 *
 * 这套壳是从「航院通」搬过来的（那边已经跑了三十几个版本），
 * 换掉的只有包名、UA 尾巴和教务地址 —— 网页版那一层照旧由 web/localapi.js
 * 顶替 bridge.py，界面代码一行没动。
 */
public class MainActivity extends Activity {

    /**
     * UA 尾巴。
     *
     * 🔴 `build_apk.py` 用正则 `CauCampus/([\d.]+)` **从这一行**读版本号，
     *    再跟 app.js / version.json 对账。改版本号时这里必须跟着改，
     *    而且**不能删掉这段字符串**（正则找不到会直接判构建失败）。
     */
    public static final String UA_TAG = " CauCampus/0.1.7";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        // Cookie 由 HttpURLConnection 全局共享一份 —— 登录拿到的 JSESSIONID
        // 后续每个请求都要带上，否则教务系统一律当没登录。
        java.net.CookieManager cm = new java.net.CookieManager(null, java.net.CookiePolicy.ACCEPT_ALL);
        java.net.CookieHandler.setDefault(cm);

        web = new WebView(this);
        web.setBackgroundColor(bgColor());
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // localStorage：课表/成绩/设置都存这儿
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(false);       // 页面自己做了响应式，别再缩放
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + UA_TAG);

        // 页面全在 assets 里，用不着访问手机上的文件。
        // 关掉能减少「万一页面被注入，借 file:// 读本地文件」这条路。
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // 别让 WebView 存表单/密码（凭据自己用 Keystore 管，不走这里）
        s.setSaveFormData(false);

        web.addJavascriptInterface(new NativeBridge(web), "Android");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                String host = req.getUrl().getHost();
                if (!"app.local".equals(host)) return null;
                String path = req.getUrl().getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                try {
                    InputStream in = getAssets().open("web" + path);
                    return new WebResourceResponse(mimeOf(path), charsetOf(path), in);
                } catch (IOException e) {
                    // 缺文件就回 404，别让 WebView 去真网络上找 app.local（会挂很久）
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                            null, new ByteArrayInputStream(("404 " + path).getBytes()));
                }
            }

            /**
             * 页面只该待在 app.local 里。任何往外跳的链接一律拦下，
             * 交给系统浏览器 —— 公告原文是公开页面，在浏览器里看更省事，
             * 也免得页面 origin 从 app.local 变成别人的站。
             */
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String host = req.getUrl().getHost();
                if ("app.local".equals(host)) return false;
                try {
                    android.content.Intent it = new android.content.Intent(
                            android.content.Intent.ACTION_VIEW, req.getUrl());
                    it.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(it);
                } catch (Throwable ignored) {
                    // 没浏览器/被系统拦了：静默失败，总比让 WebView 白屏强
                }
                return true;
            }
        });

        applySystemBars();
        web.loadUrl("https://app.local/index.html");
    }

    /** 状态栏跟着明暗模式走。硬写一个色的话，深色模式下顶上会挂一条亮白。 */
    private void applySystemBars() {
        Window w = getWindow();
        boolean dark = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        if (Build.VERSION.SDK_INT >= 21) {
            w.setStatusBarColor(dark ? Color.parseColor("#0f1013") : Color.parseColor("#f2f2f7"));
            w.setNavigationBarColor(dark ? Color.parseColor("#1c1c1e") : Color.parseColor("#ffffff"));
        }
        if (Build.VERSION.SDK_INT >= 23) {
            // 「浅色状态栏」= 深色图标。系统 API 里名字是反的，容易搞混。
            View dv = w.getDecorView();
            int flags = dv.getSystemUiVisibility();
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            dv.setSystemUiVisibility(flags);
        }
    }

    private int bgColor() {
        boolean dark = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        return Color.parseColor(dark ? "#0f1013" : "#f2f2f7");
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        return "application/octet-stream";
    }

    /** 文本类要给 charset，否则中文会变乱码（尤其 js/css）。 */
    private static String charsetOf(String path) {
        String m = mimeOf(path);
        if (m.startsWith("text/") || m.equals("application/javascript") || m.equals("application/json")) {
            return "utf-8";
        }
        return null;
    }

    /**
     * 从「校内通知」那个窗口回来时，让网页重画一次公告页。
     *
     * 门户窗口在后台可能已经抓到了新通知（存进 SharedPreferences），
     * 不重画的话用户回来看到的还是旧列表，会以为没同步上。
     * 网页里那个钩子不存在（老版本 / 网页版）就什么都不做。
     */
    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.evaluateJavascript("window.appPortalSynced && window.appPortalSynced()", null);
        }
    }

    @Override
    public void onConfigurationChanged(Configuration cfg) {
        super.onConfigurationChanged(cfg);
        applySystemBars();
        web.setBackgroundColor(bgColor());
    }

    /**
     * 返回键先交给网页处理：关浮层 → 回课表 → 才真退出。
     *
     * 网页那边 window.appBack() 返回 true 表示「我处理了」（app.js 里就有这个函数，
     * 关浮层、退子页都走它）。
     * 用 evaluateJavascript 拿返回值是异步的，所以这里只能同步等一下 ——
     * 但这是个纯 JS 表达式，几毫秒就回来了，不会卡。
     * targetSdk 33 且没开 enableOnBackInvokedCallback，onBackPressed 仍然有效。
     */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.appBack && window.appBack()) ? '1' : '0'",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String v) {
                        if (!"\"1\"".equals(v)) finish();
                    }
                });
    }
}
