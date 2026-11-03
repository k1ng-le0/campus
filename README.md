# CAU 校园通

中国农业大学学生的课表 / 考试 / 成绩 / 公告查询工具。

一句话说明它是什么：把你登录教务系统（newjw.cau.edu.cn）后能看到的那些信息，做成一个手机上好查好看的界面。**它只读不写**——不能选课、不能评教、不能替你交任何东西，只把你自己的数据展示出来。

- **装在手机上（APK，推荐）**：不需要电脑，所有数据在手机里直接抓取
- **电脑上用（网页版）**：电脑开个小服务，手机浏览器打开，适合不想装 App 的情况

两种方式界面完全一样，凭据都只存在你自己的设备上。

---

## 一、安装（手机版）

1. **下载**：打开 [Releases 页面](https://github.com/k1ng-le0/campus/releases/latest)，下载 `caucampus-vX.Y.Z.apk`
2. **安装**：点开下载的文件。系统提示「未知来源应用」时选择允许（不同手机叫法略有差异，一般在安装确认页直接点「仍要安装」）
3. **登录**：打开 App → 底部「我的」→「绑定教务账号」，输入**教务系统的学号和密码**（就是登录 newjw.cau.edu.cn 那套），绑定后会自动同步一次

之后每次打开 App，下拉或进「我的」点同步即可更新数据。

### ⚠️ 必须知道的前提

**教务系统只在校内网开放。** 手机必须满足以下任一条件，否则 App 无法抓取新数据：

- 连接**校园网 Wi-Fi**
- 或先连**学校 VPN** 再打开 App

不在校内时，App 仍能查看之前同步下来的课表/成绩/考试（数据存在手机里，断网也能看），但公告和「同步」按钮会失败。

---

## 二、日常使用

**「课表」页**：本学期课表，周视图/日视图，左右翻周。点任意课程看教师、教室、周次；长按或在详情里可隐藏不上的课。顶部的「今日概览」卡片会告诉你：正在上什么课还剩几分钟、下节课几点在哪、以及考试倒计时——不用自己算。

**「学业」页**：考试安排（带倒计时，可切换学期）、成绩（按学期分组）、学分统计（按已出成绩自动算）。

**「公告」页**：合并了学校主页「通知公告」和本科生院首页的通知，自动过滤招聘/招租/招标类噪音（底部注明隐藏了多少条，可展开看全部）。顶部的「校内通知」入口是综合服务平台（one.cau.edu.cn）的通知，第一次点进去用统一身份认证登录一次即可，之后自动抓取。

**「我的」页**：重新同步、学期设置（开学日期 / 总周数）、上课时间、解除绑定。

### 常见问题

<details>
<summary><b>打开 App 一直转圈 / 同步失败</b></summary>

99% 是不在校内网。连校园网 Wi-Fi 或学校 VPN 后重试。检查方法：手机浏览器能打开 `newjw.cau.edu.cn` 就说明网络通。
</details>

<details>
<summary><b>密码安全吗？会不会被上传？</b></summary>

密码用系统级加密（Android Keystore / Windows DPAPI）存在你自己的设备上，只有本设备能解开。没有统计、没有上报、不经过任何第三方服务器，源码全部公开可查。
</details>

<details>
<summary><b>课表里的「今天」不对 / 第 1 周日期不对</b></summary>

开学日期是按学期名推算的，可能和校历差一周。去「我的 → 学期设置」里把开学日期改成实际日期即可。
</details>

<details>
<summary><b>浏览器里的教务系统突然要重新登录</b></summary>

强智教务系统是**会话独占**的：App 登录会把浏览器里的登录挤下线，反过来也一样。这是学校系统的行为，不是 App 出了问题。
</details>

<details>
<summary><b>考试页显示「这学期还没排考」</b></summary>

教务系统还没发布考试安排时就是这样，不是没有考试。教务发布了 App 里就有了。
</details>

<details>
<summary><b>想换账号 / 不用了</b></summary>

「我的 → 解除绑定」，本机的账号密码会被删除。
</details>

<details>
<summary><b>怎么更新到新版本</b></summary>

App 内暂无自动更新。有新版本时到 [Releases 页面](https://github.com/k1ng-le0/campus/releases/latest) 重新下载安装，覆盖安装不会丢已同步的数据。
</details>

---

## 三、电脑上用（网页版）

1. 下载本仓库源码（Code → Download ZIP，或 `git clone`）
2. 双击 **`启动.bat`**，它会自动找一个 Python 启动本地服务并打开浏览器
3. 和手机版一样绑定教务账号

手机也能用：电脑和手机连同一个 Wi-Fi，用启动窗口显示的 `http://电脑IP:8790/?k=...` 在手机浏览器打开。

详细说明（命令行参数、自定义 Python 解释器等）见文件说明表下的备注。

---

## 四、隐私

- 学号密码加密后只存本机（App 用 Android Keystore，网页版用 Windows DPAPI），拷走文件在别的设备上也解不开
- 不上报、不统计、无任何第三方服务器
- 本仓库代码与文档不含任何使用者的个人信息

---

## 五、版本与更新内容

每个版本改了什么，见 [RELEASE-NOTES.md](RELEASE-NOTES.md) 或 Releases 页的发布说明。

## 六、给开发者

<details>
<summary>自己打 APK</summary>

不需要 Android Studio / Gradle，需要 Android 命令行工具（JDK 17、build-tools 34、platform 33）：

```bash
python android/build_apk.py                # 产物在 android/dist/，并复制一份到项目根目录
python android/build_apk.py --clean        # 先清中间产物
CAU_SDK=<工具目录> python android/build_apk.py   # 工具不在约定位置时用环境变量指过去
```

签名 keystore 不在仓库里（在 SDK 目录同级的 `keystore/` 下），换机器打包要先有自己的 keystore。图标由 `python android/tools/make_icons.py` 生成，改配色/换字只需改常量。

发新版本：打 tag 推送后在 Releases 发布，附件命名 `caucampus-vX.Y.Z.apk`。
</details>

<details>
<summary>文件结构</summary>

| 文件 | 作用 |
| --- | --- |
| `bridge.py` | 网页版本地服务：HTTP、凭据加密、静态页面、API。所有 POST 接口校验 token，数据类 GET 也要求 token |
| `cau_jw.py` | 强智教务客户端与解析器（登录、课表、成绩、考试、学期） |
| `notice_cau.py` | 学校通知公告抓取 |
| `web/` | 手机端界面（纯原生 JS，无框架、无构建）；`localapi.js` 在 App 内顶替 bridge.py 的 `/api/*`，界面两边完全一致 |
| `android/` | APK 壳：MainActivity（发 assets）、NativeBridge（HTTP）、CredStore（Keystore 加密）、build_apk.py（打包脚本） |
| `version.json` | 当前 APK 版本 / 大小 / sha256，打包时自动写 |
| `启动.bat` | 网页版一键启动 |

教务登录采用强智的 `scode#sxh` 编码算法；公告抓取只依赖公开页面结构。细节直接读源码，注释写全了。
</details>

## 许可与声明

本软件不包含选课、评教、提交作业、签到、绕过验证码等写操作，只把你自己在教务系统里能看到的数据换个更适合手机的方式展示。校徽图案为学校注册商标，仅限自用。
