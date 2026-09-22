# HC RPA 客户端：编译打包与日志查看

> 适用：桌面客户端（Electron）的日常开发、打包与问题排查。
> 相关目录：`frontend/`（pnpm workspace 根）、`frontend/packages/electron-app`（客户端主进程，包名仍为 `astron-rpa`）、`frontend/packages/web-app`（渲染层 `@rpa/web-app`）。

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

- 引擎段需要 Python **3.13** + 7-Zip，默认找 `C:\Program Files\Python313\python.exe` 与 `C:\Program Files\7-Zip\7z.exe`，可用参数覆盖；仓库自带的 `resources\7zr.exe` 可当 7-Zip 用：
  `build.bat --python-exe %APPDATA%\uv\python\cpython-3.13-windows-x86_64-none\python.exe --sevenz-exe resources\7zr.exe`
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

---

## 6. 用户数据目录（重装/排查常用）

位置：`%APPDATA%\<productName>`，当前为 **`%APPDATA%\hc-rpa`**。

| 内容 | 说明 |
|---|---|
| `python_core/` | 引擎运行环境，由安装包内 `resources/python_core.7z` 解压而来 |
| `python_core.7z.sha256.txt` | 校验文件，用于判断是否需要重新解压 |
| `venvs/`、`logs/`、`.setting.json`、`.cookie.json` 等 | 虚拟环境、日志、客户端设置 |
| `python_core.temp/` | **解压中的临时目录**；若它与 `python_core/` 同时"只剩 temp"，说明重命名失败（旧版会卡在 90%） |

要点：
- **删除该目录 = 强制重新解压 python 环境**（首次启动会解压数百 MB，属正常，耗时数十秒）
- 改名（`productName`）会改变该目录名 → 旧数据不会被复用，会重新解压

---

## 7. 常见问题速查

| 现象 | 处理 |
|---|---|
| 启动进度条停在 80~90% 不动 | 看 `main.log` 的解压/重命名日志；新版会弹窗并提供「打开日志目录」 |
| 打包报 `rcedit ... Unable to commit changes` | 输出目录改到工作区外（见 4.1） |
| 打包报 `icon.ico must be at least 256x256` | 按 4.2 重新生成 ICO |
| 装完引擎起不来 | 检查 `<用户数据目录>\python_core\python.exe` 是否存在 |
| 想干净重装 | 卸载程序 → 删除 `%APPDATA%\hc-rpa` → 重新安装 |
