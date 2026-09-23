# 已知问题台账（Known Issues）

> 登记本仓库**已知但尚未解决、或已解决但值得留痕**的问题与环境陷阱。
> 与专题文档的分工：**详细排查步骤放专题文档，本文只做登记与指路**，避免同一份内容两处维护。

## 维护约定

1. 新发现的问题**就地追加**，分配 `KI-xx` 编号；**编号永不复用**（删掉的也不回收）。
2. 修好后把状态改成「已修」并补上 commit / 文档位置，**不要删除条目**——保留是为了让后来人搜得到。
3. 「影响面」固定用这几类：客户端 / 构建打包 / 开发环境 / 服务端 / 集成。
4. 写根因时给出**代码位置或实测命令**，不要只写结论——否则半年后无法判断这条是否还成立。

## 索引

| 编号 | 问题 | 影响面 | 状态 |
|---|---|---|---|
| [KI-01](#ki-01-启动卡在进度条所需端口被-windows-保留或被占用) | 启动卡在进度条：所需端口被 Windows 保留或被占用 | 客户端 | 已修 `102d3a2a` |
| [KI-02](#ki-02-覆盖安装后启动失败孤儿进程锁住-python_core) | 覆盖安装后启动失败：孤儿进程锁住 `python_core` | 客户端 | 已修 `55eeca57` |
| [KI-03](#ki-03-自动更新功能实际不可用每次启动都报错) | **自动更新功能实际不可用**，每次启动都报错 | 客户端 + 服务端 | **未修** |
| [KI-04](#ki-04-buildbat-传相对路径会假成功产出仍是旧归档) | `build.bat` 传相对路径会「假成功」，产出仍是旧归档 | 构建打包 | 已修 `3b24a853` |
| [KI-05](#ki-05-打包失败-rcedit--unable-to-commit-changes) | 打包失败 `rcedit ... Unable to commit changes` | 构建打包 | 绕行 |
| [KI-06](#ki-06-打包失败-iconico-must-be-at-least-256x256) | 打包失败 `icon.ico must be at least 256x256` | 构建打包 | 已修 `68e9138c` |
| [KI-07](#ki-07-裸-node-命令是需要-tty-的-shim) | 裸 `node` 命令是需要 tty 的 shim | 开发环境 | 环境限制 |
| [KI-08](#ki-08-git-bash-下-cmd-c-传带引号的路径被转义) | Git Bash 下 `cmd //c` 传带引号的路径被转义 | 开发环境 | 环境限制 |
| [KI-09](#ki-09-rpa-发版--开通外部调用) | RPA「发版」≠「开通外部调用」，agent 看不到应用 | 集成 | 已知行为 |
| [KI-10](#ki-10-上游-ai-servicev116-缺-pytz容器-up-但-8010-无监听) | 上游 `ai-service:v1.1.6` 缺 `pytz`：容器 `Up` 但 8010 无监听 → AI 功能全 502 | 服务端部署 | 已绕过（自建镜像） |

---

## KI-01 启动卡在进度条：所需端口被 Windows 保留或被占用

**现象**：进度条停在最后不动；`main.log` 停在 `正在启动服务` 之后没有下文；同时
`logs/scheduler-*.log` 里持续刷 `rpa_route is not health, start recover`，
`route.exe` 每次刚起来就退出。旧版本无任何提示，只能干等。

**根因（两层）**

1. `engine/servers/astronverse-scheduler/.../utils/utils.py` 的 `check_port()` 用
   `connect_ex` 判断端口是否可用——**只判断"有没有程序在监听"**。被系统**保留**的端口
   既没人监听、也无法 bind，会被误判为可用，于是引擎拿着一个绑不上的端口启动。
2. Windows 的保留段（`netsh int ipv4 show excludedportrange`）由 Hyper-V / WSL2 / Docker
   从**动态端口范围**内圈占。本机 TCP 动态范围曾被设为 `10000 + 15536`（Windows 默认是
   `49152 + 16384`），于是 `13xxx`、`11xxx` 整段被圈走，`13159~13164`、`11001` 全部中招。

对照证据：同一台机器的 UDP 仍是默认范围 `49152 + 16384`，保留段就都落在 `5xxxx+`——
说明保留段确实是跟着动态端口范围走的。

**处置**

- 代码侧（已修 `102d3a2a`）：启动前预检全部必需端口，`classify_port()` 区分
  `free` / `occupied` / `reserved`，不可用时弹告警（正文含修复命令）并以退出码 4 退出。
  刻意**不做动态端口规避**——被占用的动态端口仍由原有分配逻辑跳过，只有"绑不上"才阻断。
- 环境侧（根治，管理员 CMD）：

  ```bat
  net stop winnat
  netsh int ipv4 set dynamicport tcp start=49152 num=16384
  net start winnat
  netsh int ipv4 show excludedportrange protocol=tcp    :: 复查：不应再有段覆盖 13159 / 11001
  ```

  若希望高位端口（如 `65534`/`65535`）**永不被临时端口占用**，把 `num` 调到 `16000`
  → 动态范围变为 `49152–65151`，`65152–65535` 就落在动态范围之外，显式绑定必然成功。

**易错点**：保留段是**禁止绑定**的。不要试图用 `netsh add excludedportrange` 去"保护"
自己的端口，方向正好相反，会让它更绑不上。

详见 `client-build-and-logs.md` §5.4。

---

## KI-02 覆盖安装后启动失败：孤儿进程锁住 `python_core`

**现象**：不卸载旧版本直接覆盖安装后启动，`main.log` 里：

```
hash不匹配: python_core.7z                                  ← 正常：安装包换了，需要重新解压
[重试 1/5] 清理解压目录 失败 (EPERM): unlink '...\python_core\python3.dll'
...
[启动失败] Python 运行环境初始化失败，客户端无法启动
```

随后 `closeSubProcess` 还会报 `Failed to import encodings module`。

**根因（两个缺陷叠加）**

1. 上次客户端被强杀（或覆盖安装时旧实例仍在运行），它启动的 `python_core\python.exe`、
   `route.exe`、插件进程成了**孤儿**，一直存活并锁着 `python313.dll` / `python3.dll`。
   **它们不会自行退出**。
2. `server.ts` 的 `extractAndCleanFile()` 原实现是「**先删旧目录、再解压**」。删除是破坏性
   操作且**会部分成功**——删到被占用的 dll 才失败，此时旧环境已被删掉一半
   （`python.exe` 还在、`Lib/encodings` 已丢），既起不来又无法自动恢复，必须手工清理。

**处置**（已修 `55eeca57`）

- 顺序反转为「先解压到临时目录**成功** → 再让旧环境让位 → 新环境顶上」，
  解压成功前旧环境完全不动。
- 让旧环境让位优先**改名旁置**（`python_core.old`，原子且不破坏内容），失败则结束占用
  进程重试，最后才退化为删除；替换失败会把旁置的旧环境**还原**回去。
- 清理/替换被占用时自动结束「可执行文件位于用户数据目录下」的残留进程，
  日志会出现 `已结束 N 个占用进程`。

**旧版本的手工恢复**（仍可能遇到）见 `client-build-and-logs.md` §4.4。

---

## KI-03 自动更新功能实际不可用，每次启动都报错

**状态：未修**（2026-09-23 评估后决定暂不处理）

**现象**：每次启动 `main.log` 出现（`noCache` 值每次不同）：

```
[info]  Checking for update
[error] Error: Error: Cannot parse update info from latest.yml in the latest release artifacts
        (http://<server>:32742/api/robot/client-version-update/update-check/win32/x64/<版本>/latest.yml?noCache=xxx):
        rawData: null
```

**影响**

- **自动更新功能实际不可用**——永远拿不到更新信息，客户端既不提示也无法升级。
- 对其它功能**无影响**：`updater.ts` 用 `await-to-js` 的 `to()` 包住了
  `autoUpdater.checkForUpdates()`，失败即返回 `{ couldUpdate: false }`（等价于"无更新"），
  不会崩、不阻塞启动。
- 副作用：每次启动写一段错误堆栈，容易掩盖真正的错误。

**根因：服务端返回了 electron-updater 无法识别的"无更新"表达**

1. 服务端在"无新版本"时返回 **HTTP 200 + 空响应体**（实测 `Content-Length: 0`）：
   - `backend/robot-service/.../base/controller/ClientVersionUpdateController.java`
     → `ResponseEntity.ok().build()`
   - `backend/robot-service/.../base/service/impl/ClientVersionUpdateServiceImpl.java`
     → `checkVersionSimple()` 里有两处 `return null`（无版本记录 / 版本相同）
2. electron-updater **无法把空响应理解为"无更新"**：
   - `GenericProvider.getLatestVersion()` → `parseUpdateInfo(httpRequest(url), ...)`
   - `parseUpdateInfo` 在 `rawData == null` 时**必然抛** `ERR_UPDATER_INVALID_UPDATE_INFO`
   - 已安装客户端内打包的该版本**没有 204 分支**，返回 `204` 也一样会报错
3. electron-updater 判断"无更新"的**唯一**途径是拿到一份合法 YAML、且版本号与当前相等：
   - `AppUpdater.isUpdateAvailable()` → `semver.parse(updateInfo.version)` 必须合法
   - `semver.eq(latest, current)` 成立 → 返回 false → 走 `update-not-available` 分支
     （干净路径，不报错）

**处置方向（尚未实施）**

| # | 改动 | 位置 |
|---|---|---|
| 1 | 去掉两处 `return null`，**始终**返回最新版本的 `latest.yml` URL，由客户端自己比版本号 | `ClientVersionUpdateServiceImpl.checkVersionSimple()` |
| 2 | 302 重定向可行——`builder-util-runtime/out/httpExecutor.js` 的 `maxRedirects = 10`，重定向会被跟随，所以"重定向到真实 yml"这条路是通的 | 无需改动 |
| 3 | `client_update_version` 需存在 `os='win32'`、`arch='x64'`、`deleted=0` 的记录（`getLatestVersion` 按这三个条件查、`version_num DESC` 取首条）；其 `download_url` 指向真实可访问的 `latest.yml`，同目录需有 `hc-rpa-<版本>-x64.exe` 与 `.blockmap` | 表数据 + 服务器部署 |
| 4 | `latest.yml` 需含 `version` 与 `files[]`（每项 `url`/`sha512`/`size`）——`getFileList()` 依赖它 | 文件内容 |

> 备注：以上判定基于**已安装客户端内打包的 electron-updater 版本**
> （`resources/app/node_modules/electron-updater`）。升级该依赖后需重新确认。

---

## KI-04 `build.bat` 传相对路径会「假成功」，产出仍是旧归档

**现象**：`build.bat` 打印 `Python_core directory compressed successfully`、退出码 0，
但 `resources/python_core.7z` 的**修改时间、大小、哈希全都没变**（只重算了 `.sha256.txt`），
于是打出的安装包引擎段还是旧的——**极易误判为构建成功**。

**根因**

1. `--sevenz-exe` 传相对路径（如 `resources\7zr.exe`）时：脚本在**仓库根**校验它存在 →
   通过；但真正调用发生在 `cd /d build\python_core` **之后**，相对路径此时无法解析。
2. 紧随其后的 `cd /d "%SCRIPT_DIR%"` 把 errorlevel 重置为 0，导致 `if errorlevel 1`
   不触发 → 压缩失败被吞掉，脚本继续去算**旧文件**的哈希（哈希自洽，看起来一切正常）。

**处置**（已修 `3b24a853`）

- 启动即 `cd` 到脚本所在目录，从任意 cwd 调用行为一致；
- `PYTHON_EXE` / `SEVENZ_EXE` 归一化为绝对路径；
- 压缩失败的错误码先存变量再 `cd`；
- 补上进入 `python_core` 目录的失败检查。

**自查纪律**：不要只看退出码或成功日志，**核对 `python_core.7z` 的修改时间**，
或按 `client-build-and-logs.md` §3.3 比对归档内文件日期。

---

## KI-05 打包失败：`rcedit ... Unable to commit changes`

**现象**：打包到 packaging 阶段反复重试后失败，`rcedit-x64.exe` 报 `Unable to commit changes`。

**根因**：写 exe 资源（版本信息/图标）时目标文件被外部进程短暂占用。实测**输出目录位于本仓库
工作区内时必现**（受工作区索引/监视类进程影响），输出到工作区外则成功。

**处置**（绕行）：输出目录放到工作区外。

```bash
cd frontend/packages/electron-app
npm run build
npx electron-builder --win -c.directories.output=D:\astron-build
```

日志里出现少量 `retrying N more times` 但最终成功属正常。

---

## KI-06 打包失败：`icon.ico must be at least 256x256`

**根因**：`frontend/public/icons/icon.ico` 必须是**真实 ICO** 且包含 ≥256×256 的图层。
历史版本里出现过把 32×32 的 BMP 直接改名成 `.ico` 的情况。

**处置**（已修 `68e9138c`）：由 `icon.png` 重新生成多尺寸 ICO，生成代码见
`client-build-and-logs.md` §4.2。

---

## KI-07 裸 `node` 命令是需要 tty 的 shim

**现象**：`node script.js > out.txt` 或 `node script.js | tail` 时，程序只输出
`stdout is not a tty` 且退出码为 1；**不重定向时正常**。

**影响**：只影响临时脚本的跑法，`npm` / `pnpm` 不受影响（它们内部调用不受此限制）。

**处置**：跑临时 node 脚本时不要重定向 stdout、不要接管道；需要落盘就让脚本自己写文件，
再单独 `cat` 那个文件。

---

## KI-08 Git Bash 下 `cmd //c` 传带引号的路径被转义

**现象**：

```bash
cmd //c 'build.bat --python-exe "C:\...\python.exe"'     # ❌
```

报 `Local Python environment not found: \"C:\...\python.exe\"`——引号被转义成了 `\"`，
参数里混进了反斜杠，导致路径不存在。

**处置**：路径不含空格时**不要加引号**：

```bash
cmd //c 'build.bat --python-exe %APPDATA%\uv\python\cpython-3.13-windows-x86_64-none\python.exe --sevenz-exe D:\path\to\7zr.exe'
```

---

## KI-09 RPA「发版」≠「开通外部调用」

**现象**：在客户端「发版」后，Astron Agent 的资源管理/晓悟RPA 列表里看不到该应用。

**根因**：agent 只读 `openai_workflows` 表，而该表**唯一写入入口**是
`POST /api/rpa-openapi/workflows/upsert`，客户端里只有「外部调用配置」会调用它；
「发版」走 robot-service，**不写**这张表。

**处置**：执行器 → 应用列表 → 目标应用所在行末尾 `⋯` → 「外部调用配置」→
打开「允许外部调用」→ 保存。**该入口仅在「来源=本地」的应用行上出现**。

详见 `astron-agent-integration-deployment.md` §7.1。

---

## KI-10 上游 `ai-service:v1.1.6` 缺 `pytz`：容器 `Up` 但 8010 无监听

**现象**：客户端「编辑应用 → 智能组件 → 优化提问」报 **502 Bad Gateway**；
`docker compose ps` 里 ai-service 显示 `Up`（无 healthcheck，看不出异常）；
nginx 错误日志是 `connect() failed (111: Connection refused) while connecting to upstream`。

**根因**

1. `backend/ai-service/app/models/point.py:4` 使用 `pytz`，但上游 `pyproject.toml`/`uv.lock`
   **未声明**该依赖（由 `3556a3d6` 引入），Dockerfile 只做 `pip install -e .` → 镜像里没有 pytz；
2. uvicorn `--workers 4` 下，每个 worker 在 `import app.main` 时
   `ModuleNotFoundError: No module named 'pytz'` 直接退出，调用链：
   `main.py:8 → internal/admin.py:3 → dependencies/__init__.py:7 → services/point.py:11 → models/point.py:4`；
3. supervisor 不断重启子进程（日志里 `Process SpawnProcess-116:` / `Child process died`），
   父进程不退出 → **容器状态一直是 `Up`**，`restart: always` 不会触发；
4. ai-service **没有 healthcheck**（compose 里只有 mysql/redis/minio/openresty 有）→ 编排层也不认为它坏了。

结果：8010 无人监听 → nginx 502 → **全部 AI 能力不可用**（智能组件、MultiChat、对话/合同/文档/招聘原子、
CUA、通用 OCR、打码）；未受影响：模板 OCR（本身不可用，见 KI 待办）、外部 Agent 原子（Dify/星辰直连）。

**处置**

- 源码侧：cherry-pick 上游 `5bae24aa`（等价 `03b4ad0b` 一族的 `53b7b02b`）补 `pytz` + 同步 `uv.lock`
  → 提交 `a6ad64d3`，merge `8f441b4c`；
- 镜像侧（正式环境）：**在服务器上自建 ai-service 镜像并替换**，步骤见 `server-side-image-build.md`；
  实测（2026-09-22）：`restarts=0`、容器内 Python 3.13.15、`pytz 2026.3.post1`、`/models` 探测返回
  `['deepseek-flash', 'deepseek-v4-pro']`；
- 同期发现并另记：`openresty-nginx` 启动时若解析不到上游名会 `[emerg] host not found in upstream "ai-service:8010"`
  直接退出 → **全站 502**（不只 AI），加固建议见 `ai-capabilities-and-ai-service.md` §4.5。

**教训**：① 上游 tag 不代表没有缺陷；② 判断容器是否健康不能只看 `Up`，要看依赖是否齐全、
端口是否真的在监听；③ 换容器后必须 `docker compose restart openresty-nginx`（nginx 启动时会缓存上游 IP）。

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-23 | 首次建立：KI-01 ~ KI-09 |
| 2026-09-23 | 新增 KI-10（上游 ai-service 缺 pytz → AI 功能 502），并新增专题文档 `server-side-image-build.md` |
