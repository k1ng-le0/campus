package com.hobson.caucampus;

import android.content.Context;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.spec.KeySpec;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 学号密码的落盘方式。
 *
 * 和网页版（Windows 上）的 DPAPI 一个思路：**密钥由系统保管，文件里只有密文**。
 * 这里用 Android Keystore 生成一把 AES-256 密钥（永不出 Keystore），
 * 每次加密现生成一个随机 IV，存成 base64(iv):base64(密文)。
 *
 * 效果：把 App 私有目录里的这个文件拷出来，在别的机器/别的应用里解不开。
 * 局限：root 过的机器、或者能在这个 App 进程里跑代码的攻击者，照样能解 ——
 *       所以它不是「绝对安全」，只是「拷走文件没用」。
 *
 * 分两层，和航院通那边一样：
 *   第一层  Keystore（最强，密钥由系统保管）
 *   第二层  ANDROID_ID + 随机盐 派生密钥（弱一档：拿到文件和这台机器的
 *          ANDROID_ID 就能解，但比「明文躺在 xml 里」好得多，
 *          更比「每次都让人重输」好得多）
 * 两层都失败时返回**具体原因**，界面必须原样告诉用户。
 *
 * 存下来的格式带前缀，读的时候按前缀选解密方式：
 *   k1:<iv>:<密文>                Keystore
 *   s1:<盐>:<iv>:<密文>           备用方式
 *   <iv>:<密文>（无前缀，旧版本）   当作 k1 处理
 */
public final class CredStore {

    private static final String PREFS = "caucampus";
    private static final String FIELD = "cred";
    private static final String SALT = "cred.salt";
    private static final String KEY_ALIAS = "caucampus.cred.v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int TAG_BITS = 128;
    private static final int PBKDF2_ROUNDS = 20000;

    private CredStore() {}

    // ------------------------------------------------------------ 存取入口

    /**
     * 存。
     *
     * @return 空串 = 存好了（Keystore）；"soft" = 存好了但走的是备用方式；
     *         "fail: xxx" = **没存上**，xxx 是给人看的原因。
     */
    public static String save(String user, String pass) {
        String json;
        try {
            JSONObject o = new JSONObject();
            o.put("u", user);
            o.put("p", pass);
            json = o.toString();
        } catch (Throwable t) {
            return "fail: 组装数据出错（" + brief(t) + "）";
        }
        return savePlain(FIELD, json);
    }

    /** 取。解不开一律返回空串（当作没绑），绝不把异常抛给 JS。 */
    public static String load() {
        String json = loadPlain(FIELD);
        if (json.isEmpty()) return "";
        try {
            JSONObject o = new JSONObject(json);
            String u = o.optString("u", "");
            String p = o.optString("p", "");
            if (u.isEmpty() || p.isEmpty()) return "";
            JSONObject out = new JSONObject();
            out.put("u", u);
            out.put("p", p);
            return out.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 本机凭据的状态，给界面用来说人话。
     *
     *   "none"    从来没存上过（或者被清掉了）
     *   "ok"      存着，而且解得开
     *   "broken"  存着，但解不开 —— 系统密钥库被重置过（换机恢复、升级、
     *             清过「凭据存储」），旧密文就废了。这种情况必须让用户重输，
     *             而且不该说成「没保存」—— 那是两回事。
     */
    public static String state() {
        if (readBlob(FIELD).isEmpty()) return "none";
        return load().isEmpty() ? "broken" : "ok";
    }

    public static void clear() {
        try {
            prefs().edit().remove(FIELD).commit();
        } catch (Throwable ignored) {
            // 清不掉也没别的办法；至少别让「解除绑定」按钮报错
        }
    }

    // ------------------------------------------------------------ 加解密

    private static String savePlain(String field, String plain) {
        // 第一层：Keystore
        String whyKeystore = null;
        try {
            String blob = "k1:" + encryptWithKeystore(plain);
            if (prefs().edit().putString(field, blob).commit()) return "";
            whyKeystore = "写文件失败";
        } catch (Throwable t) {
            whyKeystore = brief(t);
        }

        // 第二层：软件密钥
        try {
            String blob = "s1:" + encryptWithSoftware(plain);
            if (prefs().edit().putString(field, blob).commit()) return "soft";
            return "fail: 写文件失败（Keystore：" + whyKeystore + "）";
        } catch (Throwable t) {
            return "fail: 系统密钥库不可用（" + whyKeystore + "），备用方式也失败（" + brief(t) + "）";
        }
    }

    private static String loadPlain(String field) {
        String blob = readBlob(field);
        if (blob.isEmpty()) return "";
        try {
            if (blob.startsWith("s1:")) return decryptWithSoftware(blob.substring(3));
            if (blob.startsWith("k1:")) return decryptWithKeystore(blob.substring(3));
            return decryptWithKeystore(blob);            // 旧版本没有前缀
        } catch (Throwable t) {
            return "";
        }
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    private static String encryptWithKeystore(String plain) throws Exception {
        byte[] iv = newIv();
        Cipher c = Cipher.getInstance(TRANSFORM);
        c.init(Cipher.ENCRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
        byte[] ct = c.doFinal(plain.getBytes("UTF-8"));
        return b64(iv) + ":" + b64(ct);
    }

    private static String decryptWithKeystore(String body) throws Exception {
        int i = body.indexOf(':');
        if (i <= 0) throw new IllegalArgumentException("格式不对");
        byte[] iv = unB64(body.substring(0, i));
        byte[] ct = unB64(body.substring(i + 1));
        Cipher c = Cipher.getInstance(TRANSFORM);
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
        return new String(c.doFinal(ct), "UTF-8");
    }

    /** 盐只在第一次生成，之后复用 —— 换了盐旧密文就解不开了。 */
    private static byte[] salt() {
        SharedPreferences p = prefs();
        String s = p.getString(SALT, "");
        if (s != null && !s.isEmpty()) {
            try {
                return unB64(s);
            } catch (Throwable ignored) {
                // 盐坏了就只能换一个（旧密文随之作废，等于让用户重输一次）
            }
        }
        byte[] fresh = new byte[16];
        new SecureRandom().nextBytes(fresh);
        p.edit().putString(SALT, b64(fresh)).commit();
        return fresh;
    }

    private static SecretKey softwareKey(byte[] salt) throws Exception {
        Context ctx = App.ctx();
        if (ctx == null) throw new IllegalStateException("应用上下文为空");
        String id = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ANDROID_ID);
        if (id == null) id = "";
        KeySpec spec = new PBEKeySpec((id + "|caucampus.cred").toCharArray(),
                salt, PBKDF2_ROUNDS, 256);
        SecretKeyFactory f = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1");
        return new SecretKeySpec(f.generateSecret(spec).getEncoded(), "AES");
    }

    private static String encryptWithSoftware(String plain) throws Exception {
        byte[] s = salt();
        byte[] iv = newIv();
        Cipher c = Cipher.getInstance(TRANSFORM);
        c.init(Cipher.ENCRYPT_MODE, softwareKey(s), new GCMParameterSpec(TAG_BITS, iv));
        byte[] ct = c.doFinal(plain.getBytes("UTF-8"));
        return b64(s) + ":" + b64(iv) + ":" + b64(ct);
    }

    private static String decryptWithSoftware(String body) throws Exception {
        String[] parts = body.split(":");
        if (parts.length != 3) throw new IllegalArgumentException("格式不对");
        byte[] s = unB64(parts[0]);
        byte[] iv = unB64(parts[1]);
        byte[] ct = unB64(parts[2]);
        Cipher c = Cipher.getInstance(TRANSFORM);
        c.init(Cipher.DECRYPT_MODE, softwareKey(s), new GCMParameterSpec(TAG_BITS, iv));
        return new String(c.doFinal(ct), "UTF-8");
    }

    // ------------------------------------------------------------ 小工具

    private static SharedPreferences prefs() {
        Context ctx = App.ctx();
        if (ctx == null) throw new IllegalStateException("应用上下文为空");
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String readBlob(String field) {
        try {
            String b = prefs().getString(field, "");
            return b == null ? "" : b;
        } catch (Throwable t) {
            return "";
        }
    }

    private static byte[] newIv() {
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        return iv;
    }

    private static String b64(byte[] b) {
        return Base64.encodeToString(b, Base64.NO_WRAP);
    }

    private static byte[] unB64(String s) {
        return Base64.decode(s, Base64.NO_WRAP);
    }

    /** 异常压成一行短话，别把整段堆栈塞进界面。也绝不带出密码。 */
    private static String brief(Throwable t) {
        String m = t.getMessage();
        String s = t.getClass().getSimpleName() + (m == null ? "" : ": " + m);
        return s.length() > 80 ? s.substring(0, 80) + "…" : s;
    }
}
