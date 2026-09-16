# 上游补丁跟踪台账（HC RPA ← iflytek/astron-rpa）

> 本仓库是 `iflytek/astron-rpa` 的**产品化二次开发版**：不向上游回贡，也**不做全量 merge**。
> 上游只作为"补丁来源"，按需 `cherry-pick`。本文件是独一无二的吸收记录入口 —— **每移植或评估一个上游提交，都必须更新本文件**，否则一年后没人说得清某个改动从哪来、哪个补丁还没进来。

---

## 1. 基线与仓库拓扑

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/iflytek/astron-rpa`（**只读**，push 已禁用） |
| 本仓库（fork） | `git@github.com:sijiangong/astron-rpa` |
| **冻结基线** | tag **`vendor/v1.1.6`** → `8b015bc1`（上游 v1.1.6，2026-02-25） |
| 基线校验 | 2026-09-16：`git ls-remote --tags upstream` 得到官方 `v1.1.6` = `8b015bc1b15d23fbdc55c78ff1de9af4bb65fba6`，与冻结基线**完全一致**（官方未重打 tag） |
| 开发主线 | `feature/v1.1.6-base`（相对基线 18 提交 / 53 文件 / +1249 −254） |
| 上游现状 | 无新 release（仍 `v1.1.6`）；`upstream/main` 领先基线 **61** 提交，`upstream/dev` 领先 **522**（dev 是另一条线，**挑拣一律以 main 为准**） |

一次性配置（只读上游）：

```bash
git remote add upstream https://github.com/iflytek/astron-rpa.git
git remote set-url --push upstream DISABLED   # 物理防误推
git fetch upstream --tags --prune             # 实测 2.7s / 425 objects / 444 KiB
```

> 为什么要冻结 `vendor/v1.1.6`：上游 tag 可能被删除或改写，一旦丢失就再也无法回答"我改了什么"。

---

## 2. 已吸收的上游提交

| 上游提交 | 标题 | 上游分支 | 本仓库提交 | 吸收日期 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| `5bae24aa` | feat(ai-service): add pytz dependency for timezone support | main | `a6ad64d3` | 2026-09-16 | 分支 `fix/ai-service-pytz`，**待合并** | 等价提交：dev 线为 `53b7b02b`，两者 pyproject 指纹一致（`83393786…`）。官方 **v1.1.6 tag 未含此修复** → 线上 ai-service 启动即崩（502）。**额外做了上游没做的事**：同步 `uv.lock`（上游 main 的锁文件至今仍缺 pytz） |
| `03b4ad0b` | fix(client): protect terminal credentials in logs and generation (#866) | main | `dfe30cab` | 2026-09-16 | 分支 `fix/terminal-credential-logging`，**待合并** | 两处：①终端注册日志曾把整个请求体（含 `osPwd`）写进 `logs/scheduler-*.log` → 改为只记录 `terminalId`/`status`；②终端密码由 `random.choice` 改 `secrets.choice`。上游自带单测在本仓库通过（2 passed，含"密码出现在请求体、不出现在日志"断言），`ruff format --check` 通过。**移植前专门核过底层 logger 是 loguru**（支持 `{}` 占位 + 参数）——若为 stdlib logging 的 `%` 风格，这种写法会静默丢日志 |

---

## 3. 待评估的上游提交（候选池）

来源：`git log --oneline vendor/v1.1.6..upstream/main`（61 个提交，以下为与本产品相关的部分）。

| 上游提交 | 标题 | 价值 | 备注 |
|---|---|---|---|
| `684021b0` | fix(ai-service): preserve versioned API base paths (#828) | 高 · 接口兼容 | ai-service 仅此两个候选 |
| `9b654dc9` | feat: restrict scheduler access to local clients (#809) | 高 · 安全 | 引擎调度器仅本地可访问 |
| `be240e5f` | Update router binary with LAN access guard (#811) | 高 · 安全 | 与上条同批 |
| `35e14f15` | fix: off-by-one error in task retry handling (#845) | 中 · 稳定性 | 任务重试次数 |
| `6d8e4848` | fix(script): return Python module result | 中 · 功能缺陷 | 脚本组件返回值 |
| `10cb0d95` | fix: browser plugin event listen and element in iframe (#808) | 中 · 元素拾取 | 影响浏览器自动化 |
| `6077f913` | fix(engine): fix CUA LLM interface (#617) | 中 · AI 能力 | CUA 接口 |
| `c9cdc9c3` | fix(installer): extract Python core to user directory (#706) | 待比对 | 与本仓库 `281ada15`（python 解压加固）**可能重叠，需人工比对后再决定** |
| `00cfa7d8` | fix(client): preserve remote run parameter files and types (#867) | 待评估 | 远程运行参数 |
| `5e4c5950` | fix(params): need_parse 类型 boolean → string (#633) | 待评估 | 可能改变既有行为 |
| `48dde0ae` | fix(email): sort received mails by date / IMAP UTF-7 | 低 · 边缘 | 邮件组件 |

---

## 4. 已评估但不吸收

| 上游提交 | 标题 | 结论 | 原因 |
|---|---|---|---|
| （暂无） | | | |

---

## 5. 移植流程（每次照做）

```bash
git fetch upstream --tags --prune

# 1) 只看关心的领域，不做全量扫描
git log --oneline vendor/v1.1.6..upstream/main -- backend/ai-service engine/ frontend/packages/web-app

# 2) 审阅：改了什么 / 是否与我们的定制冲突 / 会不会改变既有行为
git show <sha>

# 3) 独立分支移植（-x 保留来源 sha，便于追溯与查重）
git switch -c fix/<topic> feature/v1.1.6-base
git cherry-pick -x <sha>

# 4) 若涉及依赖声明，务必同步锁文件（否则依赖扫描会报缺口）
cd backend/ai-service && uv lock     # 实测约 1m24s
cd engine && uv lock

# 5) 按第 6 节验证 → 合并 → 登记本文档第 2 节
git switch feature/v1.1.6-base && git merge --no-ff fix/<topic>
```

**替代方案（何时才考虑 merge 整个 tag）**：只有当你想成批跟进上游一次发布、且改动面覆盖大部分目录时才值得；否则 cherry-pick 更可控 —— 它不会把上游的品牌、实验性特性和你不需要的重构一起带进产品线。

---

## 6. 验证清单（缺一不可）

- [ ] **依赖完整性扫描**：`app/**.py` 的顶层 import 与 `uv.lock` 已解析包逐一比对，必须 0 缺口（脚本见附录 A）
- [ ] **构建期 import 冒烟**：建议在 Dockerfile 的 `COPY app/` 之后加 `RUN python -c "import app.main"`，缺依赖直接让构建失败
- [ ] 相关服务镜像能构建、能启动，端口有人监听（`docker exec <c> python -c "import socket;s=socket.socket();print(s.connect_ex(('127.0.0.1',<port>)))"` → 0）
- [ ] 客户端打包 + 连后端冒烟
- [ ] 黄金任务回归

> 血的教训（2026-09-16）：官方 v1.1.6 镜像因缺 `pytz` 导致 ai-service 全部功能不可用，而容器始终显示 `Up`、`restart: always` 不触发 —— 从部署到被发现瞒了 6 天。**"官方 tag 一定是好的"不成立，必须自己验证。**

---

## 7. 已知偏离与纪律

| 偏离项 | 说明 | 处理方向 |
|---|---|---|
| `resources/conf.yaml` 的 `remote_addr` | **不应进版本库**（上游在 v1.1.6→main 也改过 3 次） | 仓库保留上游值，部署时外部覆盖 |
| `docker/docker-compose.yml` | 上游改过 3 次；我们的部署改造（换 redis 镜像、去掉 dev 挂载、钉版本 tag） | 搬到 `docker-compose.override.yml`（或 `docker-compose.hc.yml`），上游文件保持原样 |
| `frontend/packages/electron-app/src/main/server.ts` | 上游改过 1 次（python 环境解压加固） | 冲突时以"上游逻辑 + 我们的加固补丁"合并 |
| `electron-builder.json` | 上游改过 1 次（品牌/标识） | 尽量收敛到少数文件 |
| `backend/ai-service/uv.lock` | 上游至今未同步 pytz（我们已同步） | **有意偏离**，勿"向对齐上游"而回退 |
| `build.bat` | 上游把 PyPI 索引**硬编码**为清华源：2026-09-16 实测该源对 `pandas` 返回 403，引擎段打包在依赖安装处直接失败（pypi.org / 阿里云均 200），而写死导致无法绕过、只能改脚本。我们参数化为 `PYPI_INDEX_URL`（**默认值仍是清华源**，行为不变；镜像不可用时用环境变量覆盖），并给 `--help` 补上了三个可覆盖变量 | **有意偏离**，勿回退；若上游日后自己做了参数化，以"保留可覆盖能力"为原则合并 |

纪律三条：

1. 环境相关改动（地址、端口、镜像 tag、凭据）**一律不进库**；
2. 上游代码尽量不改，差异集中在新文件、扩展点、配置文件；
3. 定期 `git diff --stat vendor/v1.1.6..HEAD` 审视偏离量 —— 偏离越小，将来吸收上游补丁越便宜；目前 53 文件 / +1249 −254 属健康区间。

---

## 附录 A：依赖完整性扫描脚本

用途：找出"代码里 import 了、但依赖清单里没有"的包（本次 pytz 事故即由此定位，并确认它是**唯一**缺口）。

```python
# 用法：仓库根目录执行  python scripts/check-deps.py  （或按需改 root）
import ast, re, sys, pathlib

root = pathlib.Path('backend/ai-service')
pkgs = {m.lower().replace('-', '_') for m in
        re.findall(r'^name = "([^"]+)"', (root / 'uv.lock').read_text(encoding='utf-8'), re.M)}

mods = {}
for f in root.glob('app/**/*.py'):
    for n in ast.walk(ast.parse(f.read_text(encoding='utf-8'))):
        if isinstance(n, ast.Import):
            for a in n.names:
                mods.setdefault(a.name.split('.')[0], set()).add(str(f))
        elif isinstance(n, ast.ImportFrom):
            if n.level == 0 and n.module:
                mods.setdefault(n.module.split('.')[0], set()).add(str(f))

# import 名与包名不同时的别名
ALIAS = {'dotenv': 'python_dotenv', 'jwt': 'pyjwt', 'pil': 'pillow',
         'multipart': 'python_multipart', 'yaml': 'pyyaml'}

suspects = [n for n in mods
            if n not in sys.stdlib_module_names and n != 'app'
            and n not in pkgs and ALIAS.get(n, '') not in pkgs]

print(f'uv.lock 包数 {len(pkgs)}；import 顶层模块 {len(mods)}；未声明依赖 {len(suspects)}: {suspects}')
```
