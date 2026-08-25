# USC Brightspace Downloader — browser-session proof of concept

只读、本地运行的 USC Brightspace 文件下载器。默认方案会打开一个隔离的 Chromium 窗口，由你亲自完成 USC NetID 和 Duo 登录；工具只保存 `brightspace.usc.edu` 的会话数据，不读取或保存用户名、密码、Microsoft/Duo 会话。

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

TUI 和自定义课程/模块映射尚未实现；它们可以复用当前的认证与同步引擎。

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

## 常用选项

```bash
usc-bs --course CSCI-570
usc-bs --output "/path/to/courses"
usc-bs --force
usc-bs auth logout
```

`auth logout` 删除加密会话文件及其 Keychain 密钥，但保留下载内容。

## 本地文件

```text
~/Library/Application Support/usc-bs/config.json
~/Library/Application Support/usc-bs/browser-session.enc
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
