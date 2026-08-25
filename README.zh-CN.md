# USC Brightspace Downloader

[English](README.md) | 简体中文

只读、本地运行的 USC Brightspace 课程文件下载 CLI 和 TUI。默认扫描全部可访问课程，保留 Brightspace 模块目录结构并执行增量同步；浏览器会话在本地加密保存，CLI 不会要求或读取 USC 密码。

> 这是非官方的概念验证项目，与 USC 或 D2L 无隶属关系。

## 已实现范围

- 默认扫描所有 active、accessible 的 Course Offering。
- 递归保留课程模块目录结构，只下载可见的 `ActivityType=File`。
- 内容接口只发送 GET；不会提交作业、修改课程或绕过权限。
- 用 Topic ID、修改时间和本地 manifest 做增量更新。
- 临时文件流式下载、SHA-256 校验、成功后原子移动。
- 本地文件被修改时不覆盖，而是另存远端版本。
- 默认并行下载数为 3，可配置为 1–8。
- 浏览器会话只允许 `brightspace.usc.edu` cookie/local storage。
- 会话以 AES-256-GCM 加密，随机密钥放在 macOS Keychain；磁盘不保存明文会话。
- OAuth + refresh token 后端仍保留，但必须显式选择。
- 提供课程列表、课程文件树、文件详情、同步计划和同步进度多级 TUI。
- TUI 显示已同步、新文件、线上更新三种主状态，并支持文件级选择和课程级下载目录。

普通 `usc-bs` 命令和 TUI 共用同一个同步引擎、认证后端、路径规则和 manifest。

## 安装

要求 macOS、Node.js 24+。只有密码保存和自动填充功能需要安装 Google Chrome。

```bash
git clone https://github.com/poolyone1/usc-brightspace-downloader.git
cd usc-brightspace-downloader
npm install
npx playwright install chromium
npm run check
npm link
```

## 第一次使用浏览器会话

```bash
usc-bs configure --method browser-session
usc-bs auth login
```

接受默认设置后，会出现一个全新的隔离 Chromium 窗口：

1. 在窗口中完成 USC NetID 登录。
2. 手动完成 Duo。
3. 等待进入 Brightspace；不要复制 cookie 或 token。
4. CLI 会用只读 enrollment API 判断登录完成，随后自动关闭窗口并加密保存仅属于 Brightspace 的会话。

然后验证和预览同步：

```bash
usc-bs auth status
usc-bs doctor
usc-bs --dry-run
```

同步全部可访问课程，并在下载前确认：

```bash
usc-bs
```

跳过确认，直接同步全部可访问课程：

```bash
usc-bs -y
```

若 USC/D2L 使会话过期，交互式运行会重新打开登录窗口。

## 可选：让 Chrome 保存并自动填充密码

该流程已经在 USC 登录页面完成实际验证。它只使用本工具自己的 Google Chrome 配置，不会接触你的日常 Chrome 配置：

```bash
usc-bs auth login --remember-password
```

第一次登录时：

1. 正常输入 USC NetID 和密码。
2. Chrome 弹出询问时选择“保存”。
3. 手动完成 Duo。
4. CLI 提示登录成功后，保持窗口打开 15 秒。

以后会话过期时，这个专用 Chrome 窗口可以自动填充 USC 登录信息；Duo 仍需手动确认。

CLI 不会读取密码输入框或 Chrome 保存的密码内容。工具加密保存 Brightspace 会话后，会清除专用 Chrome 配置中的网站 cookie 和站点存储，但保留 Chrome 密码管理器记录。不要在这个专用配置中登录 Google 账号。

查看状态或删除专用密码配置：

```bash
usc-bs auth status
usc-bs auth forget-password
```

`auth forget-password` 会删除整个专用 Chrome 配置并关闭自动填充，但保留加密 Brightspace 会话和下载文件。

## 多级 TUI

```bash
usc-bs tui
```

界面层级：

```text
课程列表 → 课程文件树 → 文件详情
    └────→ 同步计划 → 同步进度 → 同步结果
```

主要按键：

```text
↑/↓       移动
Enter     进入课程、展开模块或查看文件详情
Space     选择课程、模块或文件
d         为当前课程设置下载根目录
f         强制下载当前文件
1/2/3     显示全部 / 新文件 / 线上更新
s         查看同步计划
r         刷新本地同步状态
Esc       返回上一级
q         退出；同步中为安全停止
```

状态规则：

- **新文件**：本地没有 manifest 记录，或本地文件缺失。
- **线上更新**：本地文件存在，但 Brightspace 修改时间已经变化。
- **已同步**：本地文件存在，且线上修改时间与记录一致。

## 常用命令

```bash
usc-bs                              # 扫描并同步全部可访问课程
usc-bs -y                           # 不询问，直接同步全部课程
usc-bs --course CSCI-570            # 按课程 ID、代码或名称筛选
usc-bs --output "/path/to/courses"  # 临时指定下载根目录
usc-bs --force                      # 即使元数据未变化也重新下载
usc-bs tui                          # 打开课程/文件管理界面
usc-bs auth status                  # 查看本地认证状态
usc-bs auth logout                  # 删除加密 Brightspace 会话
usc-bs auth forget-password         # 删除专用 Chrome 配置
```

`auth logout` 删除加密会话文件及其 macOS Keychain 密钥，但保留下载内容和可选的 Chrome 密码配置。

## 本地文件

```text
~/Library/Application Support/usc-bs/config.json
~/Library/Application Support/usc-bs/browser-session.enc
~/Library/Application Support/usc-bs/chrome-login-profile/  # 仅在开启密码自动填充后存在
~/Library/Application Support/usc-bs/tui-profile.json
<下载目录>/.usc-bs-manifest.json
```

`browser-session.enc` 使用 AES-256-GCM 加密，随机密钥存放在 macOS Keychain 中；工具不会把明文会话写入磁盘。加密会话只保留精确属于 `brightspace.usc.edu` 的 cookie 和 origin storage，不包含 Microsoft 或 Duo 会话。manifest 不含认证信息。

详细实现与安全验证条件见[浏览器会话设计](docs/browser-session-design.md)。

## OAuth（可选）

只有拿到 USC 注册的 Brightspace OAuth `client_id` / `client_secret` 后才选择：

```bash
usc-bs configure --method oauth
usc-bs auth login
```

需要 scopes：

- `enrollment:own_enrollment:read`
- `content:toc:read`
- `content:file:read`

应用还必须被允许签发 refresh token。

## 安全边界与当前限制

- 下载器对课程和内容接口只执行只读请求。
- 不会提交作业、修改课程，也不会绕过权限、release condition、隐藏内容或日期限制。
- 只下载可见的 `ActivityType=File`。
- 登录页面会正常执行 USC、Microsoft 和 Duo 自身的认证请求。
- USC 或 D2L 可以随时使会话失效，此时需要重新认证。
