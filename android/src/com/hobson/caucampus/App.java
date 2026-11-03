package com.hobson.caucampus;

import android.app.Application;
import android.content.Context;

/** 只为给 CredStore 一个稳定的 Context —— 存凭据的代码不该依赖 Activity 生命周期。 */
public class App extends Application {

    private static Context ctx;

    @Override
    public void onCreate() {
        super.onCreate();
        ctx = getApplicationContext();
    }

    public static Context ctx() {
        return ctx;
    }
}
