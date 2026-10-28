## 上游嵌入

- 上游：tabtin-ai/TabTin，许可证 **AGPL-3.0**（2026-08 建仓，Public Preview）
- 上游原生平台：桌面 ✅（Electron 壳 `apps/tabtin-electron`）| 网页 ✅（`apps/tabtin-web` Vite SPA）| 移动 ⚠️ 配套入口（`apps/tabtin-ios` / `tabtin-android`）
  - Agnx 只接**网页形态**（`tabtin-web` + Django 后端）；Electron 壳与移动原生壳不复用，故 `platforms.mobile = unsupported`
  - 移动端定性依据（上游 README 原文）：「当前移动端是 TabTin 桌面端的配套入口，**不提供独立的 Agent 执行环境**。
    要从移动端发起或控制 Agent 任务，需要先在桌面端完成执行环境配置与设备绑定，并在任务运行时保持该电脑在线。」
    —— 即有 iOS/Android 壳，但离不开桌面端，不算独立移动形态，`mobile=unsupported` 成立。
- 工作方式：**嵌 + 薄胶水** — 前端用上游 `tabtin-web`，后端用上游 `tabtin_django`，不重写任何 UI
- 上游改动清单：**无**（未改任何上游 `.ts`/`.tsx`/`.py`；只注入启动参数与环境变量）

### 挂载

- 挂载：`guest.auth=none` / 策略 `auto`（direct-iframe）
- 启动：`ensureTool=.agnx/tools/ensure-tabtin-web.mjs`，对外端口 **8107**
- 双服务结构：

  | 服务 | 上游入口 | 端口 |
  | --- | --- | --- |
  | 前端 | `apps/tabtin-web` → `vite --port 8107` | 8107（对外） |
  | 后端 | `apps/tabtin_django` → `daphne tabtin.asgi:application` | 6060（内部） |

  前端 `/api`、`/auth` 由 Vite 反代到 6060，所以 Agnx 只需一个 origin。

- 面板与 Tab：`tabtin.main`（走 `ensureTool`），命令 `tabtin.open`，侧栏 order 60
- 数据落盘：`$AGNX_HOME/apps/data/tabtin/`（`community-secrets/`、`venv/` 等）
  - 另有部分运行数据仍在仓内（`apps/tabtin_django/logs/*.log`、本地 sqlite）：上游未提供数据根环境变量，
    强改需动 `settings.py`，违反「上游几乎不动」，故如实保留；Agnx 侧的侧车状态与探针目录走 `--work-dir`。

### ⚠️ 端口纪律：8100 冲突已规避

上游 `scripts/dev.mjs` 的社区模式固定使用三个端口：Django **6060**、Collab daemon **4100**、Centrifugo **8100**。
其中 **8100 已被同批子应用 `openhands` 占用**（OpenHands ingress 常驻该端口）。

本接入的做法：**只起 Django(6060) + 前端(8107)**，不起 Centrifugo 与 collab daemon。
理由：这两个服务只服务于「实时多人协同」，而 Agnx 单用户场景下打开 Tab 看主界面不需要它；
一旦需要，再按需错开端口（如 Centrifugo 换 8113）拉起即可。

### 依赖安装（必须 3.11 + 跳过 PyMuPDF）

```bash
cd apps/tabtin_django
uv venv --python 3.11          # 系统 python3.14 装不上（setuptools.build_meta 失败）
uv pip install -r <(grep -v '^PyMuPDF' requirements.txt)
```

- 上游 `requirements.txt` 里 `PyMuPDF>=1.24.0` 会解析到 `pymupdf==2.0`，而该版本的
  包元数据名是 `pymupdf-lite`，导致 `Package metadata name does not match` 安装失败。
- 影响面：仅 PDF 解析（日志里 `[DocParse] pdf_parser 加载失败`），其余功能不受影响。
- 若需要 PDF：`uv pip install PyMuPDF==1.24.4`（指定旧版即可）。

### 环境变量（启动参数，非改上游）

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `DEBUG` | `true` | 开发模式；缺它则上游强制要求 `SECRET_KEY` |
| `TABTIN_API_BASE_URL` / `VITE_API_BASE_URL` | `http://127.0.0.1:6060/api` | **必填**，缺失时 Vite 直接拒绝启动 |
| `TABTIN_PUBLIC_WEB_BASE_URL` / `VITE_PUBLIC_WEB_BASE_URL` | `http://127.0.0.1:8107` | 生成分享链接的基址 |

ensure-tool 已内置注入，不依赖 `.env` 存在。

### 验收实测（2026-10-19）

```text
$ node .agnx/tools/ensure-tabtin-web.mjs --port 8107 --work-dir /tmp/tabtin-probe3
[phase spawn.backend] [phase spawn.frontend]
{"ok":true,"reused":false,"port":8107,"pid":30708,"origin":"http://127.0.0.1:8107","backend":"http://127.0.0.1:6060"}

# 复用
{"ok":true,"reused":true,"port":8107,"pid":30708,...}

$ curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8107/        → 200（<title>TabTin</title>）
$ curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8107/api/    → 200（反代到 Django）
$ curl -o /dev/null -w '%{http_code}' http://127.0.0.1:6060/health  → 200
```

- 构建胶水：`node .agnx/scripts/build.mjs` → `.agnx/dist/index.js`（4.5KB，含 `tabtin` 符号）
- manifest：`python3 -m json.tool .agnx/manifest.json` 通过

**二次复核（独立冷启动，2026-10-19 19:54）**：先 `kill` 掉 6060 与 8107 上的全部进程，再用
`--work-dir /tmp/tabtin-probe` 从零拉起，双进程各自就绪、`ok:true` 退出码 0；随后复跑同一命令
走复用分支返回 `"reused":true`。补测前端资源可编译性：

```text
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8107/src/main.tsx    → 200（Vite 能编译入口模块）
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8107/runtime-env.js  → 200
$ curl -s http://127.0.0.1:6060/health                                          → {"status": "healthy", ...}
```

> 注意 `/api/health` 经 Vite 代理为 **404**：上游 health 在根路径 `/health`（Django 6060），
> 不在 `/api` 前缀下。ensure-tool 因此**直接探后端 6060**，比探前端代理更准。

### 踩过的坑（给后来人）

1. **ensure 不能把子进程 stdio 设成 pipe**：子进程继承管道句柄后，ensure 即使 `unref()` 也无法退出，
   `ensure | tail` 会永久挂住。改为重定向到日志文件（`.agnx-runtime/tabtin-vite.log`、`tabtin-django.log`）。
2. **Vite 启动强校验 `API_BASE_URL`**：`packages/tabtin-config` 的 `requireApiBaseUrl` 缺变量直接抛错，
   且报错发生在 `loadConfigFromFile` 阶段，表现为「端口一直不通」而非明显报错。
3. 系统 `python3` 是 3.14，装不上上游依赖，必须显式 `--python 3.11`。

## 嵌页宿主能力缺口

| 上游能力 | 信号位置 | 嵌后风险 | 处置 | 主路径 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 实时协同（Centrifugo WS） | `VITE_CENTRIFUGO_WS_URL` | 未启动，协同不可用 | D：按需错端口拉起 | 主界面 | 单用户浏览不需要 |
| Collab daemon | `:4100` | 未启动 | E：不补做 | — | 同上下 |
| 桌面通知 / 角标 | Electron 壳 | iframe 拿不到 | E：不补做 | Web 形态 | 上游 web 形亦然 |
| 文件上传 | `/api` | 同源代理，风险低 | A：guest 透传 | Guest Surface | 单 origin |
