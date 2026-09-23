# HC RPA 客户端：编译打包与日志查看

> 适用：桌面客户端（Electron）的日常开发、打包与问题排查。
> 相关目录：`frontend/`（pnpm workspace 根）、`frontend/packages/electron-app`（客户端主进程，包名仍为 `astron-rpa`）、`frontend/packages/web-app`（渲染层 `@rpa/web-app`）。
> 相关：已知问题台账见 [`known-issues.md`](./known-issues.md)。

---

## 1. 环境要求

| 项 | 要求 |
|---|---|
| Node | `>= 22` |
| pnpm | `>= 9` |
| 系统 | 打 Windows 包需在 **Windows** 上执行 |
| 首次准备 | 在 `frontend/` 执行 `pnpm install` |
| 引擎段（首次克隆，或改过 `engine/` 时） | Python **3.13** + 7-Zip，由根目录 `build.bat` 驱动（见 3.1） |

> 注意：客户端包的 npm 名字仍是 `astron-rpa`（未随品牌改名），因此各类脚本里的 `--filter astron-rpa` 是正确的，不要改。

---

## 2. 常用脚本速查（在 `frontend/` 执行）

| 命令 | 作用 |
|---|---|
| `pnpm dev:web` | 只起渲染层（浏览器里预览，走"浏览器 fallback"，与客户端表现不完全一致） |
| `pnpm dev:desktop` | Electron 开发模式（改代码热更新） |
| `pnpm build:web` | 只构建 `@rpa/web-app` |
| `pnpm build:desktop` | 打 Windows 客户端安装包（= `electron-app` 的 `build:win`）；**只含前端段**，完整打包用根目录 `build.bat`（见 3.1） |
| `pnpm set-env` / `set-env:saas` / `set-env:enterprise` | 按 `.env.<mode>` 生成 `.env`，并把 `app_auth_type`/`app_edition` 合并进 `resources/conf.yaml` |

---

## 3. 打包流程

完整打包 = **引擎段** + **前端段**：引擎段产出 `resources/python_core.7z`，前端段把它连同 `resources/` 一起打进安装包。

### 3.1 完整打包：根目录 `build.bat`（首次克隆 / 改过 `engine/` 时必跑）

`resources/python_core.7z`（引擎运行环境，约 100MB）**不入库**（被 `.gitignore` 忽略），只能由 `build.bat` 生成。electron-builder 用 `extraFiles` **整目录**拷贝 `resources/`，所以**这个文件缺失时不会报错**，只会悄悄打出一个“装完引擎起不来”的安装包（现象见 5.3）。

```bat
build.bat                  REM 引擎段 + 前端段（完整打包）
build.bat --skip-frontend  REM 只做引擎段（改了 engine/ 时；实测约 149s）
build.bat --help           REM 查看 PYTHON_EXE / SEVENZ_EXE / PYPI_INDEX_URL 等参数
```

- 引擎段需要 Python **3.13** + 7-Zip，默认找 `C:\Program Files\Python313\python.exe` 与 `C:\Program Files\7-Zip\7z.exe`，可用参数覆盖；仓库自带的 `resources\7zr.exe` 可当 7-Zip 用。

  ⚠️ **`--python-exe` / `--sevenz-exe` 必须传「绝对路径」（含盘符）。**
  脚本的路径校验发生在 `cd` 之前、真正调用 7z 发生在 `cd /d build\python_core` **之后**，
  因此相对路径在调用时会失效；又因为紧接着的 `cd /d "%SCRIPT_DIR%"` 把 errorlevel 重置为 0，
  那次失败**不会被报告**——脚本照样打印 `compressed successfully`，而 `resources/python_core.7z`
  **还是旧的那一份**（只重算了 `.sha256.txt`，看起来哈希还对得上，极易误判）。

  ```bat
  build.bat --skip-frontend ^
    --python-exe %APPDATA%\uv\python\cpython-3.13-windows-x86_64-none\python.exe ^
    --sevenz-exe D:\workspace-vscode\astron-rpa\resources\7zr.exe
  ```

  **判断是否真的重建**：看 `resources/python_core.7z` 的**修改时间**，或按 3.3 核对归档内文件日期。

- 在 Git Bash 里通过 `cmd //c` 调用时**不要给路径加引号**（会被转义成 `\"`，报 “Local Python environment not found”）；路径不含空格时无需引号。
- 依赖安装源用 `PYPI_INDEX_URL` 覆盖（默认清华源）；镜像返 403 时换 `https://mirrors.aliyun.com/pypi/simple/`。
- 副作用：过程中会临时改写 `engine/pyproject.toml`（追加 `[tool.uv.workspace]`）、重写 `engine/requirements.txt`、覆盖 `resources\python_core.7z` 与同名 `.sha256.txt`；正常结束会还原，仅被强杀时可能残留 `engine/pyproject.toml.backup`。

### 3.2 只改前端时：`pnpm build:desktop`

```
pnpm build:desktop
  └─ electron-app 的 build:win = npm run build && electron-builder --win
       └─ npm run build
            ├─ build:sdk   (tsdown → client-sdk.js)
            ├─ typecheck   (node + web，失败会中断构建)
            ├─ electron-vite build
            └─ build:web   (构建 @rpa/web-app + copy:renderer 拷到 out/renderer)
```

### 3.3 验证引擎改动真的进了包（别只看退出码）

```bash
# 1) 安装包内的归档与刚构建的是同一份（sha256 必须一致；Windows 无 sha256sum 可用 certutil -hashfile <文件> SHA256）
sha256sum <输出目录>/win-unpacked/resources/python_core.7z resources/python_core.7z

# 2) 解压出来的环境里能看到你的改动（<改动特征> 取一段你改过的代码/字符串）
grep -r -c "<改动特征>" build/python_core/Lib/site-packages/<对应模块路径>
```

> 已安装的客户端可再查 `<用户数据目录>\python_core\Lib\site-packages\...`（首启按 `python_core.7z.sha256.txt` 决定是否重新解压，见 §6）。

**关键配置**

- `frontend/packages/electron-app/electron-builder.json`
  - `productName` / `appId`：决定 **exe 名、默认安装目录、用户数据目录**（当前为 `hc-rpa`）
  - `artifactName`：安装包文件名（当前 `hc-rpa-${version}-${arch}.${ext}`）
  - `nsis.shortcutName` / `uninstallDisplayName`：快捷方式与"添加/删除程序"显示名（保持 `HC RPA`）
- `resources/`（仓库根）通过 `extraFiles` 打进安装包 → `resources/conf.yaml`
  - 字段：`remote_addr`（要连的 RPA 服务端）、`skip_engine_start`、`app_auth_type`、`app_edition`

**产物**（默认输出目录 `electron-app/dist/`）

| 产物 | 说明 |
|---|---|
| `hc-rpa-<version>-<arch>.exe` | NSIS 安装包 |
| `win-unpacked/` | 免安装目录（主程序 `hc-rpa.exe`），可直接运行验证 |
| `latest.yml` + `.blockmap` | 自动更新元数据 |

---

## 4. ⚠️ 打包踩坑与推荐做法

### 4.1 `rcedit ... Fatal error: Unable to commit changes`

- **现象**：打包到 "packaging" 阶段反复重试后失败，`rcedit-x64.exe` 报 `Unable to commit changes`。
- **原因**：写 exe 资源（版本信息/图标）时目标文件被外部进程短暂占用。实测**输出目录位于本仓库工作区内时必现**（工作区被索引/监视类进程影响），输出到工作区外则成功。
- **推荐做法**：把输出目录放到工作区外

```bash
cd frontend/packages/electron-app
npm run build
npx electron-builder --win -c.directories.output=D:\astron-build
```

> 日志里出现少量 `retrying N more times` 但最终成功，属正常（重试后恢复）。

### 4.2 `image ...\icon.ico must be at least 256x256`

- **原因**：`frontend/public/icons/icon.ico` 必须是**真实 ICO**且包含 ≥256×256 的图层。曾出现把 BMP 直接改名成 `.ico`（32×32）导致失败。
- **修复**：用源图 `icon.png`（256×256）重新生成多尺寸 ICO

```python
from PIL import Image
src = Image.open('frontend/public/icons/icon.png').convert('RGBA')
src.save('frontend/public/icons/icon.ico', format='ICO',
         sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
```

### 4.3 typecheck 中断构建

`npm run build` 内含 `typecheck`（node/web 两套 tsconfig）。类型错误会让打包直接失败——先本地跑通 `npm run typecheck`。

### 4.4 覆盖安装后启动失败：孤儿进程锁住 `python_core`

**现象**：不卸载旧版本、直接覆盖安装后启动，`main.log` 里：

```
hash不匹配: python_core.7z            ← 正常：安装包换了，需要重新解压
[重试 1/5] 清理解压目录 失败 (EPERM): unlink '...\python_core\python3.dll'
...
[启动失败] Python 运行环境初始化失败，客户端无法启动
```

随后 `closeSubProcess` 还会报 `Failed to import encodings module`。

**原因**：上次客户端被强杀（或覆盖安装时旧实例仍在跑），它启动的
`python_core\python.exe` / `route.exe` / 插件进程成了孤儿，一直存活并锁着
`python313.dll` / `python3.dll`，导致目录删不掉 → 重新解压失败。
**它们不会自己退出**，必须手工结束。

**手工恢复**（旧版本遇到时）

```powershell
# 1. 找出占用进程（确认列表里都是 hc-rpa 的进程）
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -like "$env:APPDATA\hc-rpa*" } |
  Select-Object ProcessId, ExecutablePath

# 2. 结束它们
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -like "$env:APPDATA\hc-rpa*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

```powershell
# 3. 删掉已被删坏的环境，让它重新解压（设置/日志/venvs 不受影响）
Remove-Item -Recurse -Force "$env:APPDATA\hc-rpa\python_core", "$env:APPDATA\hc-rpa\python_core.temp"
Remove-Item -Force "$env:APPDATA\hc-rpa\python_core.7z.sha256.txt"
```

然后重新启动客户端（首次会重新解压，需数十秒）。

**当前版本的处理**（不必再手工介入）

- 先在**临时目录**完整解压，成功后才动旧环境；不再“先删旧目录再解压”，
  因此不会出现“删了一半、既起不来又无法自动恢复”的坏死环境
- 让旧环境让位时**优先改名旁置**（`python_core.old`），改名失败才结束占用进程重试，
  最后才退化为删除；替换失败还会把旁置的旧环境还原回去
- 清理/替换被占用时，会**自动结束可执行文件位于用户目录下的残留进程**再重试
  （日志出现 `已结束 N 个占用进程`）

---

## 5. 日志查看

### 5.1 主进程日志（electron-log，最常用）

配置见 `frontend/packages/electron-app/src/main/log.ts`：日志写入 **`<appWorkPath>/logs/main.log`**。

`appWorkPath`（`src/main/path.ts`）= 打包后为**用户数据目录**，未打包（开发模式）为 `<项目目录>/data`。因此：

| 运行方式 | 日志路径 |
|---|---|
| 安装版 / 免安装版 | `%APPDATA%\<productName>\logs\main.log` → 当前为 **`%APPDATA%\hc-rpa\logs\main.log`**（改名前的旧版本是 `%APPDATA%\astron-rpa\logs\main.log`） |
| 开发模式（`pnpm dev:desktop`） | `frontend/packages/electron-app/data/logs/main.log` |

实时查看：

```powershell
# PowerShell
Get-Content -Wait "$env:APPDATA\hc-rpa\logs\main.log"
```

```bash
# Git Bash
tail -f "/c/Users/<用户名>/AppData/Roaming/hc-rpa/logs/main.log"
```

### 5.2 引擎（Python）日志

主进程以 `cwd: appWorkPath` 启动：

```
<用户数据目录>\python_core\python.exe -m astronverse.scheduler --conf="<安装目录>\resources\conf.yaml"
```

引擎自身配置 `log_path = "./logs/"`（`engine/servers/astronverse-executor/.../config.py`），相对工作目录 → 即**用户数据目录下的 `logs/`**（与 `main.log` 同目录）。

> 若该目录里没有引擎日志，通常说明引擎**根本没起来**（多半是 `python_core\python.exe` 缺失），先看 5.3 的关键词。

### 5.3 排查关键词速查

| 关键词 | 含义 |
|---|---|
| `解压/安装失败`、`[重试 N/5] ... 失败 (EPERM)` | python 环境解压/重命名异常（被杀软/索引占用） |
| `重命名目录最终失败，改用「复制+删除」兜底` | 已走兜底路径，最终可能仍成功 |
| `python 运行环境就绪` / `python 运行环境缺失` | 启动前的环境校验结果 |
| `解压文件不存在` / `用户数据目录hash文件不存在` / `hash不匹配` | 会触发重新解压 |
| `系统找不到指定的路径` | 典型是 `python_core\python.exe` 不存在 |
| `exited with error code` | 引擎异常退出（新版会弹窗提示） |
| `[启动失败]` | 已触发失败弹窗（含「打开日志目录」） |
| `port precheck failed` / `启动失败：客户端所需端口不可用` | 端口被占用或被系统保留，见 5.4 |
| `rpa_route is not health, start recover`（在 `scheduler-*.log` 里） | 本地路由端口绑不上，引擎反复重启，见 5.4 |
| `清理解压目录 失败 (EPERM)` / `文件被占用` | 残留进程锁着 `python_core` 下的 dll，见 4.4 |
| `旁置旧环境` / `已结束 N 个占用进程` | 旧环境或残留进程被自动处理，属正常自愈 |
| `临时目录被占用，无法清理` | 连临时目录都清不掉、解压无法开始（多为杀软或残留进程） |

### 5.4 启动失败：端口被占用或被系统保留

**现象**：进度条停在最后不动；`main.log` 最后一行是 `正在启动服务`、之后再无输出；同时 `logs/scheduler-<日期>.log` 里持续刷：

```
rpa_route is not health, start recover
cmd: [...\core\route\win\route.exe', '--port=13159', ...]
```

**原因**：引擎所需的本地端口**无法绑定**，`route.exe` 一起来就退出，调度器于是每几秒重启一次、无限循环——引擎永远不会返回“就绪”，界面就一直停在启动页。

端口不可用分两种，**处理方式完全不同**：

| 类型 | 判断依据 | 处理 |
|---|---|---|
| **被其它程序占用** | 端口能连上（有进程在监听） | 关掉占用端口的程序：`netstat -ano \| findstr :<端口>` 找到 PID |
| **被操作系统保留** | 连不上、也绑不上（bind 报 `WSAEACCES` 10013） | 见下方 winnat 处理 |

保留端口是 Windows 上 Hyper-V / WSL2 / Docker Desktop 抢走动态端口段造成的，典型报错：

```
listen tcp :13159: bind: An attempt was made to access a socket in a way forbidden by its access permissions.
```

**排查**

```bat
netsh int ipv4 show excludedportrange protocol=tcp
netsh int ipv4 show dynamicport tcp
```

如果所需端口（默认 `13159`、`9082`、`11001`）落在“端口排除范围”里，就是这个原因。

**修复**（管理员命令行）

```bat
net stop winnat
net start winnat
netsh int ipv4 show excludedportrange protocol=tcp    :: 复查保留段是否已释放
```

根治建议把动态端口范围改回默认（被改成低位起点时，Hyper-V 会反复抢占 1xxxx 段）：

```bat
net stop winnat
netsh int ipv4 set dynamic tcp start=49152 num=16384
net start winnat
```

> Docker Desktop / WSL 每次启动都可能重新占用，重启机器后建议复查一次。

**版本行为差异**

- 新版：引擎启动前会**预检**所有必需端口，不可用时弹出原生告警窗（正文含具体端口、原因与上面这段修复命令），用户关闭后退出，**不再无限卡在启动页**。
- 旧版：无预检，表现为进度条停住且无任何提示。

**代码位置**（便于对照修改）

| 位置 | 作用 |
|---|---|
| `engine/.../scheduler/utils/utils.py` | `classify_port()` 区分 `free`/`occupied`/`reserved`；注意 `check_port()` 只判断“有没有人监听”，**不能**用来判断保留端口 |
| `engine/.../scheduler/core/svc.py` | `collect_bound_ports()` 端口清单、`precheck_ports_message()` 组装提示文案 |
| `engine/.../scheduler/start.py` | 启动流程中调用预检，失败则 `emit_to_front(ALERT)` + `sys.exit(4)` |
| `frontend/packages/electron-app/src/main/server.ts` | 捕获引擎上报的告警文案，作为启动失败弹窗正文 |

---

## 6. 用户数据目录（重装/排查常用）

位置：`%APPDATA%\<productName>`，当前为 **`%APPDATA%\hc-rpa`**。

| 内容 | 说明 |
|---|---|
| `python_core/` | 引擎运行环境，由安装包内 `resources/python_core.7z` 解压而来 |
| `python_core.7z.sha256.txt` | 校验文件，用于判断是否需要重新解压 |
| `venvs/`、`logs/`、`.setting.json`、`.cookie.json` 等 | 虚拟环境、日志、客户端设置 |
| `python_core.temp/` | **解压中的临时目录**（见 4.4） |
| `python_core.old/` | 被替换下来的**上一份**引擎环境；正常情况会自动删除，若残留说明其中文件仍被占用，可手工删除 |

要点：
- **删除该目录 = 强制重新解压 python 环境**（首次启动会解压数百 MB，属正常，耗时数十秒）
- 改名（`productName`）会改变该目录名 → 旧数据不会被复用，会重新解压

---

## 7. 常见问题速查

| 现象 | 处理 |
|---|---|
| 启动进度条停在 80~90% 不动 | 看 `main.log`：有 `解压/安装失败` 则为环境解压问题；停在 `正在启动服务` 之后且无输出，则看 `scheduler-*.log` 的 `rpa_route is not health`（端口问题，见 5.4）。新版两种情况都会弹窗 |
| 提示「客户端所需端口不可用」 | 按 5.4 区分“被占用”还是“被系统保留”，后者需重置 winnat |
| 打包报 `rcedit ... Unable to commit changes` | 输出目录改到工作区外（见 4.1） |
| 打包报 `icon.ico must be at least 256x256` | 按 4.2 重新生成 ICO |
| 装完引擎起不来 | 检查 `<用户数据目录>\python_core\python.exe` 是否存在 |
| 想干净重装 | 卸载程序 → 删除 `%APPDATA%\hc-rpa` → 重新安装 |
