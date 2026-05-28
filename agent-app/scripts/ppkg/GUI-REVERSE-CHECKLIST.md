# PPKG GUI 反向工程 Checklist（你 RDP 进 Win10 desktop 跑）

> 目标：用 ICD GUI 设三段 customization 各一组样本（Certificate / WiFi / Accounts），
> Export 出 customizations.xml，scp 回 Mac 让 Claude 填实
> `app/services/admin/enrollment-ppkg.ts` 三个 throw 501 的 helper。

## 前置

- Win10 192.168.50.68（cogrow 帐号 RDP，不是 SSH 的 Administrator）
- ADK ICD 已装：`C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Imaging and Configuration Designer\x86\ICDStarter.exe`

## 步骤（顺序很关键 — Workplace enrollment 一定留，三段在它之外加）

### 1. 启动 ICD GUI（cogrow 帐号 desktop）

```powershell
& "C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Imaging and Configuration Designer\x86\ICDStarter.exe"
```

GUI 启动后：
- 主页 → **Advanced provisioning**（不要选 Provision desktop wizard，wizard 会丢 schema 细节）
- Project name: `cogrow-ppkg-w4-reverse`
- 下一步 → **All Windows editions** → Next
- 跳过 "Import a provisioning package" → Finish

进入 Available customizations 树形界面。

### 2. 设 Workplace enrollment（与现有 OnPremise 等价，但要保留作为完整样本）

左侧 Runtime settings → Workplace → Enrollments：
- UPN 栏输入 `enrollment@cogrow-reverse.local` → **Add**
- 展开新增的 UPN 条目，填：
  - AuthPolicy: **OnPremise**
  - DiscoveryServiceFullUrl: `https://placeholder.example.com/EnrollmentServer/Discovery.svc`
  - Secret: `reverse-engineering-secret-placeholder`

> 这段我们已有，但 export 时 GUI 总是一起吐出来，方便比对节点排序。

### 3. 设 ConnectivityProfiles/WLAN/WLANXmlSettings（WiFi）

左侧 Runtime settings → ConnectivityProfiles → WLAN → **WLANXmlSettings**：
- SSID 栏输入 `CoGrowReverseWiFi` → **Add**
- 展开新增的 SSID，填：
  - SecurityType: **WPA2-Personal**
  - SecurityKey: `wifipassword-reverse-12345`
  - AutoConnect: **true**
  - HiddenNetwork: **false**

> 这是真正要反向工程的段 — node 名 / attribute 嵌套 / SecurityType 枚举字面值
> 都需要从 export 的 XML 反推。

### 4. 设 Accounts/Users（本机帐号）

左侧 Runtime settings → Accounts → Users：
- UserName 栏输入 `student-reverse` → **Add**
- 展开新增的 user，填：
  - Password: `StudentPass!123`
  - UserGroup: `Users`
  - HomeDir 留空（除非反向工程发现必填）

> 第二段反向工程目标 — `<User>` 节点是属性式还是元素式？UserName 是 attribute
> 还是 sub-element？需 export 才知。

### 5. （可选）Certificate root cert 段 — 仅当我们打算未来支援 Certificate authPolicy

如果 admin 端将来要走 Certificate authPolicy，需要在 PPKG 里 pre-install root cert。
路径：Runtime settings → Certificates → ClientCertificates 或 RootCertificates。

ICD GUI 的 ClientCertificates 需要真的 .pfx 文件（密码加密），ICD 把它编入 XML 时
用 base64 嵌入。我们没有现成 cert 可放，**这段先跳过**，未来确实要做 Certificate
enrollment 时单独反向工程。

> 当前 `renderEnrollmentSection` 内的 Certificate throw 501 比较合理 — 因为业务
> 决定还没敲定（Certificate 真的要不要支援？OnPremise 已经够用）。GUI 反向工程
> 也建议**到这一步为止**，留 Certificate 给业务确认后再做。

### 6. Export

主菜单 → **File → Save**
主菜单 → **Export → Provisioning package**
- Package name: `cogrow-ppkg-w4-reverse`
- Owner: OEM
- Rank: 0
- 加密 / 签名都 **跳过**（导出最干净 XML）
- Build → 等几秒

完成后，customizations.xml 位置：

```
C:\Users\cogrow\Documents\Windows Imaging and Configuration Designer (WICD)\cogrow-ppkg-w4-reverse\customizations.xml
```

### 7. 拷回 Mac

**选项 A（你 RDP 里直接 scp）**：

```powershell
scp 'C:\Users\cogrow\Documents\Windows Imaging and Configuration Designer (WICD)\cogrow-ppkg-w4-reverse\customizations.xml' hj@<MAC-IP>:/tmp/ppkg-reverse.xml
```

**选项 B（Mac 端 scp 拉，需要先把文件挪到 Administrator 可访问目录）**：

```powershell
# Win10 上（cogrow 帐号）
Copy-Item 'C:\Users\cogrow\Documents\Windows Imaging and Configuration Designer (WICD)\cogrow-ppkg-w4-reverse\customizations.xml' C:\Users\Public\Documents\
```

```bash
# Mac 端（Claude 跑）
scp -i ~/.ssh/win10_mdm_test -o UserKnownHostsFile=$HOME/.ssh/known_hosts.win10mdm \
  'Administrator@192.168.50.68:C:/Users/Public/Documents/customizations.xml' \
  /tmp/ppkg-reverse.xml
```

后者更稳（cogrow 帐号无需 SSH 配置）。

### 8. 完工标志

通知 Claude："customizations.xml 已落 `/tmp/ppkg-reverse.xml`，开始填实 helper"。
Claude 会：
1. 解析 XML，比对预判节点名
2. 替换 `renderWifiSection` / `renderAccountsSection` 的 501 throw 为真实渲染
3. 新增正向 unit test（XML 包含 SSID/UserName/SecurityType 等关键字段）
4. 保留 disable 路径 = `wifi==null` / `localAccounts==null` 仍走快路径
5. 跑 `deno task test` 确认全绿
6. commit

## 估时

- GUI 操作: 10-15 分钟（首次熟悉 GUI 树）
- scp + Claude 填实: 5-10 分钟

## 不要做什么

- ❌ 不要在 ICD CLI 里尝试编辑 customizations.xml 反向工程（无关变量乱入）
- ❌ 不要 build .ppkg（我们只要 customizations.xml，build 的 .ppkg 是 binary WIM 没用）
- ❌ 不要给 Certificate 段填 placeholder cert，等业务确认是否真要 Certificate 模式
- ❌ 不要重命名 GUI 自动生成的内部 ID（PackageConfig/ID 那个 GUID，留 GUI 默认值）
