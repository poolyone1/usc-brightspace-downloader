# USC Brightspace Downloader — browser session + TUI proof of concept

只读、本地运行的 USC Brightspace 文件下载器。默认方案会打开一个隔离的 Chromium 窗口，由你亲自完成 USC NetID 和 Duo 登录；工具只保存 `brightspace.usc.edu` 的会话数据，不读取用户名、密码或 Duo 内容。也可以显式开启专用 Chrome 配置，让 Chrome 自己保存并自动填充密码。

## 已实现范围

- 默认扫描所有 active、accessible 的 Course Offering。
- 递归保留课程模块目录结构，只下载可见的 `ActivityType=File`。
- 内容接口只发送 GET；不会提交作业、修改课程或绕过权限。
- 用 Topic ID、修改时间和本地 manifest 做增量更新。
- 临时文件流式下载、SHA-256 校验、成功后原子移动。
- 本地文件被修改时不覆盖，而是另存远端版本。
- 浏览器会话只允许 `brightspace.usc.edu` cookie/local storage。
- 会话以 AES-256-GCM 加密，随机密钥放在 macOS Keychain；磁盘不保存明文会话。
- OAuth + refresh token 后端仍保留，但必须显式选择。
- 提供课程列表、课程文件树、文件详情、同步计划和同步进度多级 TUI。
- TUI 显示已同步、新文件、线上更新三种主状态，并支持文件级选择和课程级下载目录。

普通 `usc-bs` 命令和 TUI 共用同一个同步引擎、认证后端、路径规则和 manifest。

## 安装

要求 macOS、Node.js 24+。

```bash
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

接受默认设置后，会出现一个全新的 Chromium 窗口：

1. 在窗口中完成 USC NetID 登录。
2. 完成 Duo。
3. 等待进入 Brightspace；不要复制 cookie 或 token。
4. CLI 会用只读 enrollment API 判断登录完成，随后自动关闭窗口并加密保存会话。

然后验证和下载：

```bash
usc-bs auth status
usc-bs doctor
usc-bs --dry-run
usc-bs -y
```

以后直接运行 `usc-bs` 即可。若 USC/D2L 使会话过期，交互式运行会重新打开登录窗口。

### 可选：让 Chrome 保存并自动填充密码

```bash
usc-bs auth login --remember-password
```

这个命令会使用一个仅供本工具登录的 Google Chrome 配置。第一次登录时：

1. 正常输入 USC NetID 和密码；Chrome 弹出询问时选择“保存”。
2. 完成 Duo，并在 CLI 提示登录成功后保持窗口打开 15 秒。
3. 以后会话过期时，这个专用窗口可以自动填充密码；Duo 仍需手动确认。

工具不会读取 Chrome 密码库。登录状态保存到加密会话后，会清除此专用配置里的网站 cookie 和站点存储，但保留 Chrome 密码管理器中的登录信息。不要在这个专用 Chrome 配置中登录 Google 账号。

要删除该配置及其中的已保存密码：

```bash
usc-bs auth forget-password
```

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

状态规则：本地没有 manifest 记录或文件缺失为“新文件”；本地存在但 Brightspace 修改时间变化为“线上更新”；本地存在且线上修改时间一致为“已同步”。

## 常用选项

```bash
usc-bs --course CSCI-570
usc-bs --output "/path/to/courses"
usc-bs --force
usc-bs auth logout
usc-bs auth forget-password
```

`auth logout` 删除加密会话文件及其 Keychain 密钥，但保留下载内容和可选的 Chrome 密码配置。`auth forget-password` 只删除专用 Chrome 配置，不删除加密会话或已下载文件。

## 本地文件

```text
~/Library/Application Support/usc-bs/config.json
~/Library/Application Support/usc-bs/browser-session.enc
~/Library/Application Support/usc-bs/chrome-login-profile/  # 仅在开启密码自动填充后存在
~/Library/Application Support/usc-bs/tui-profile.json
<下载目录>/.usc-bs-manifest.json
```

`browser-session.enc` 是密文；manifest 不含认证信息。详细安全设计和实测门槛见 [`docs/browser-session-design.md`](docs/browser-session-design.md)。

## OAuth（可选）

只有拿到 USC 注册的 Brightspace OAuth `client_id` / `client_secret` 后才选择：

```bash
usc-bs configure --method oauth
usc-bs auth login
```

需要 scopes：`enrollment:own_enrollment:read`、`content:toc:read`、`content:file:read`，并启用 refresh token。
