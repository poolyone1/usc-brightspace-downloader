# USC Brightspace Downloader — OAuth proof of concept

这是一个只读的本地命令行原型。它使用 Brightspace 官方 OAuth 2.0 API：首次通过 USC NetID 和 Duo 登录，随后用轮换 refresh token 自动认证，并下载当前账号可访问课程中的 File Topic。

## 当前范围

- Brightspace 内容 API 只发送 GET 请求。
- 默认扫描所有 active、accessible 的 Course Offering。
- 递归保留课程模块目录结构。
- 只下载 `ActivityType=File`；跳过 LTI、Quiz、Discussion、外链和隐藏/锁定内容。
- 用 Topic ID、`LastModifiedDate` 和本地 manifest 判断更新。
- 下载到临时文件，计算 SHA-256 后原子替换。
- 检测到本地文件被修改时不覆盖，另存远端版本。
- OAuth client secret 和 refresh token 存入 macOS Keychain。

TUI 和自定义课程/模块目录映射不在这个 oneshot 中；它们会在 API 链路实测通过后复用同一个同步引擎。

无法取得 USC OAuth 应用凭据时，可参考 [`docs/browser-session-design.md`](docs/browser-session-design.md) 中的手动登录一次并加密保存 Brightspace 会话方案。该方案当前位于 `browser-session-poc` 分支，尚未声称通过 USC 实测。

## USC 需要注册的 OAuth 应用

必须先从 USC Brightspace 管理员处取得 `client_id` 和 `client_secret`：

```text
Grant type: Authorization Grant
Redirect URI: https://localhost:3001/oauth/callback
Scopes:
  enrollment:own_enrollment:read
  content:toc:read
  content:file:read
Enable refresh tokens: Yes
```

回调地址必须和 USC 注册的值完全一致。原型会生成仅用于本机回调的自签名证书，因此首次回调时浏览器可能显示一次 localhost 证书警告。

## 安装和运行

要求 macOS 和 Node.js 24+。

```bash
npm install
npm run check
npm link

usc-bs configure
usc-bs login
usc-bs doctor
usc-bs
```

无参数运行会扫描全部当前可访问课程，显示课程与文件数量，并默认确认下载。

其他命令：

```bash
usc-bs --dry-run
usc-bs --course CSCI-570
usc-bs --output "/path/to/courses"
usc-bs status
usc-bs logout
```

设置保存在：

```text
~/Library/Application Support/usc-bs/config.json
```

下载状态保存在下载根目录的 `.usc-bs-manifest.json`。其中不含 OAuth token。
