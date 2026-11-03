package com.hobson.caucampus;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.view.Gravity;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * 「校内通知」那个窗口：应用内打开综合服务平台（one.cau.edu.cn）。
 *
 * ================================================================
 * 它干两件事
 * ================================================================
 * 1. 让用户在一个**记住登录态**的地方看门户（登录一次，之后直接进）。
 * 2. 页面加载完后跑一段注入脚本（res/raw/portal_scrape.js），把「通知公告」
 *    那块的通知抠出来存到本机 —— 主界面的公告页读这份缓存，于是门户里的
 *    校内通知也能出现在 App 的列表里。
 *
 * ================================================================
 * 为什么不用"登录接口 + 抓 JSON"那条路
 * ================================================================
 * 门户走统一身份认证（onecas.cau.edu.cn/tpass），密码是 DES 加密提交的，
 * 还有登录票据和可能的验证码。把这套逆向进 App，等于要保管用户的**门户密码**
 * 并自己实现登录 —— 一旦学校改一版就全废，而且密码泄露面更大。
 *
 * 现在这条路：登录还是用户在 WebView 里自己做（浏览器怎么登它就怎么登），
 * 我们只读**已经渲染在屏幕上的东西**。代价是必须打开这个窗口才能同步一次，
 * 好处是不碰密码、不改登录逻辑，学校改版最多是抓不到（而不是登不上）。
 *
 * ================================================================
 * 三个必须处理的点
 * ================================================================
 * 1. 🔴 **第三方 cookie**。CAS 的票据要在 onecas → one 两个域之间传递，
 *    不开 setAcceptThirdPartyCookies 的话，登录完跳回来还是未登录，
 *    而且不报错 —— 表现是「登录成功又回到登录页」。
 * 2. 🔴 **target=_blank**。门户里绝大多数通知链接是新窗口打开的。
 *    WebView 默认**直接丢弃** window.open，点了没反应。见 onCreateWindow。
 * 3. 🔴 **这是个桌面站**。不开 UseWideViewPort 的话，页面会挤成一条，
 *    表格和日期全错位。这里按「桌面页缩放到屏幕宽 + 可双指放大」处理。
 */
public class PortalActivity extends Activity {

    /** 综合服务平台首页。校内通知在「校园信息 → 通知公告」那块。 */
    public static final String HOME = "https://one.cau.edu.cn/tp_up/view?m=up";

    /** 想直接打开某条通知时用它（从主界面列表点进来）。 */
    public static final String EXTRA_URL = "url";

    private static final String PREFS = "caucampus";
    private static final String KEY_ITEMS = "portal.notices";
    private static final String KEY_AT = "portal.at";

    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());

    /** 页面加载完之后的两次抓取：SPA 渲染慢，早抓会抓到空壳。 */
    private final Runnable scrape = new Runnable() {
        @Override
        public void run() {
            if (web == null) return;
            try {
                web.evaluateJavascript(readScrapeJs(), null);
            } catch (Throwable ignored) {
                // 页面正在跳转时会抛，下一次定时还会再试
            }
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        web = new WebView(this);
        web.setBackgroundColor(0xFFFFFFFF);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // 桌面站：按 980px 排版再缩到屏幕宽，能看清结构；想细看就双指放大
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        // 门户里还有些 http 的图片/脚本，不放开会一片空白
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // 🔴 见类注释第 2 条
        s.setSupportMultipleWindows(true);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (android.os.Build.VERSION.SDK_INT >= 21) {
            cm.setAcceptThirdPartyCookies(web, true);   // 🔴 见类注释第 1 条
        }

        // 抓取脚本通过这个对象把结果交回来
        web.addJavascriptInterface(new Bridge(), "PortalBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) return false;
                // tel: / mailto: / intent: 这些交给系统，别在 WebView 里当网页加载
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Throwable ignored) {
                    // 没有对应 App，静默失败比崩掉强
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                // 两次：2.5s 抓 SPA 首屏，6.5s 再抓一次（登录跳转回来的那次）
                ui.removeCallbacks(scrape);
                ui.postDelayed(scrape, 2500);
                ui.postDelayed(scrape, 6500);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            /**
             * 门户里的通知链接大多是 target=_blank。WebView 默认把这种新窗口
             * **直接扔掉**，用户看到的就是「点了没反应」。
             *
             * 做法：给它一个临时 WebView 接住，等它真要加载时把地址抢过来，
             * 在主 WebView 里打开 —— 不真的开第二个窗口，返回键行为才不会乱。
             */
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog,
                                          boolean isUserGesture, Message resultMsg) {
                final WebView temp = new WebView(PortalActivity.this);
                temp.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        web.loadUrl(req.getUrl().toString());
                        return true;
                    }
                });
                WebView.WebViewTransport transport =
                        (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(temp);
                resultMsg.sendToTarget();
                return true;
            }
        });

        String start = HOME;
        Intent it = getIntent();
        if (it != null) {
            String u = it.getStringExtra(EXTRA_URL);
            if (u != null && (u.startsWith("http://") || u.startsWith("https://"))) {
                start = u;
            }
        }
        web.loadUrl(start);
    }

    /** 把抓取脚本从 res/raw 读成字符串。放在 raw 里而不是 Java 字符串里：
     *  那段 JS 有几十行，塞进 Java 常量会变成一堆 \ 转义，改一次错一次。 */
    private String readScrapeJs() {
        InputStream in = null;
        try {
            in = getResources().openRawResource(R.raw.portal_scrape);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            return "";
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignored) { }
        }
    }

    /** JS 那边抓到东西后回调这里。跑在 JavaBridge 线程，不碰 UI。 */
    private class Bridge {
        @JavascriptInterface
        public void save(final String json) {
            if (json == null || json.length() < 3) return;
            int count = 0;
            try {
                count = new JSONArray(json).length();
            } catch (Throwable t) {
                return;                       // 不是数组就当没抓到，别存脏数据
            }
            // 🔴 少于 3 条不存。用户在门户里点进某条通知的详情页时，这个脚本也会跑，
            //    那种页面上只有一两个日期，存下去就把整份列表覆盖成一条了 ——
            //    表现是「同步完只剩一条通知」，而且下次还得再进一次门户。
            //    正常的通知列表十几条，3 条这个门槛不会误伤。
            if (count < 3) return;

            SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            p.edit()
                    .putString(KEY_ITEMS, json)
                    .putLong(KEY_AT, System.currentTimeMillis() / 1000)
                    .apply();

            // 给一句反馈，不然用户不知道「打开一下」到底同步到没有
            final int n = count;
            ui.post(new Runnable() {
                @Override
                public void run() {
                    Toast t = Toast.makeText(PortalActivity.this,
                            "已同步 " + n + " 条校内通知", Toast.LENGTH_SHORT);
                    t.setGravity(Gravity.BOTTOM, 0, 120);
                    t.show();
                }
            });
        }

        @JavascriptInterface
        public void fail(String why) {
            // 抓不到就算了：这个窗口本身还能当浏览器用，不该因为抓取失败打扰用户
        }
    }

    /** 返回键先回退网页历史，退到头才关窗口 —— 不然看完一条通知按一下就整个退出了。 */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从别的应用切回来时也补抓一次
        ui.removeCallbacks(scrape);
        ui.postDelayed(scrape, 2500);
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacks(scrape);
        if (web != null) {
            CookieManager.getInstance().flush();   // 把登录态落盘，下次不用重登
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
