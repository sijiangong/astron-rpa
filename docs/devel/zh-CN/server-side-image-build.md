# 在服务器上自建后端镜像并上线（操作手册）

> **适用场景**：服务器上只有 `docker-compose.yml` + `.env`（没有源码），需要把**某个后端服务**换成
> "从本仓库源码构建的镜像"。
> **首次实例**：ai-service —— 上游 `ghcr.io/iflytek/astron-rpa/ai-service:v1.1.6` 缺 `pytz`，
> worker 全崩但容器仍 `Up` → 8010 无监听 → 客户端 AI 功能全 502（见 `known-issues.md` KI-10、
> `ai-capabilities-and-ai-service.md` §2.6）。
> **实测环境**：Linux 服务器，`docker compose` v2，部署目录 `/opt/hc-rpa/docker`，
> 源码目录 `/opt/hc-rpa/src`（2026-09-22 全流程验证通过）。

---

## 0. 先选路线

| 路线 | 服务器要源码 | 需要 registry | 优点 | 代价 | 建议 |
|---|---|---|---|---|---|
| **A. 服务器上构建** | ✅（一个子目录） | ❌ | 不改部署模式、无 registry 依赖 | 每次改代码都要"重传源码 + rebuild" | **本手册主线** |
| B. CI 构建推 GHCR | ❌ | ✅ `ghcr.io` | 服务器继续 `compose pull`；构建不占服务器 | 需一次性配好 GHCR 认证与 tag | 改动频繁时首选 |
| C. 本地构建 + `save`/`load` | ❌ | ❌ | 完全不碰服务器构建链 | 每次传 200-400MB tar；占本地磁盘 | 服务器出网受限时的兜底 |

> 判断 A 是否可行：先做 §1 的三条探测。任一条不通 → 先按 §4 换源；仍不通 → 改走 C。

---

## 1. 构建前置探测（3 条，必须全通）

```bash
docker --version && docker compose version          # 期望 compose v2.x（插件形式：docker compose）
docker pull python:3.13-slim                        # 基础镜像在 Docker Hub（不是 GHCR）
docker run --rm python:3.13-slim pip download --no-deps -d /tmp pytz
docker run --rm python:3.13-slim sh -c 'apt-get update -qq && echo apt-ok'
```

| 不通的探测 | 含义 | 处置 |
|---|---|---|
| 拉不到 `python:3.13-slim` | 服务器访问 Docker Hub 受限 | 配 registry 加速器，或把 Dockerfile 的基础镜像换成国内镜像仓库 |
| `pip download` 失败/极慢 | 访问 PyPI 受限 | 用 §4 的 `PIP_INDEX_URL` 换国内源 |
| `apt-get update` 失败 | 访问 Debian 源受限 | 用 §4 的 `APT_MIRROR` 换国内源 |

> 宿主机的 Python 版本**无关**：构建全程在容器内，`requires-python = ">=3.13"` 由镜像的
> `FROM python:3.13-slim` 满足。（宿主 Python 只在 `docker-compose` v1 时才会被用到。）

---

## 2. 目录约定（最容易错的一步）

- Dockerfile 里的 `COPY` 路径是**相对仓库根**写的（如 `COPY backend/ai-service/pyproject.toml ...`），
  所以 `build.context` 必须指向"包含 `backend/<svc>/` 的那一级"。
- 服务器目录约定：

  ```
  /opt/hc-rpa/src/backend/ai-service/{Dockerfile,app,pyproject.toml,uv.lock,README.md}
  /opt/hc-rpa/docker/{docker-compose.yml, docker-compose.hc.yml, .env}
  ```

  即 `context: ../src`（相对 `docker/` 的上一级）。

- ⚠️ **`context` 的相对路径按"基础 compose 文件所在目录"解析**，不是当前 shell 目录。上游
  `docker-compose.yml` 的注释里写的是 `context: ..`，直接取消注释会去找 `/opt/hc-rpa/backend`：

  ```
  resolve : lstat /opt/hc-rpa/backend: no such file or directory
  ```

- 自检（`config` 会展开成绝对路径，最稳妥）：

  ```bash
  cd /opt/hc-rpa/docker
  docker compose config | grep -A6 'ai-service:' | grep -E 'image|context|dockerfile'
  ```

---

## 3. 源码包：怎么打、怎么放

```bash
# 本地（仓库根）。必须加 -c core.autocrlf=false —— Windows 上 core.autocrlf=true 会让
# git archive 产出 CRLF 文件；Dockerfile 的 RUN 续行/ARG 值可能带上 \r
git -c core.autocrlf=false archive --format=tar.gz -o ai-service-src.tgz HEAD backend/ai-service
scp ai-service-src.tgz <user>@<server>:/tmp/

# 服务器
mkdir -p /opt/hc-rpa/src && tar xzf /tmp/ai-service-src.tgz -C /opt/hc-rpa/src
ls /opt/hc-rpa/src/backend/ai-service/          # Dockerfile app pyproject.toml uv.lock README.md
```

> 用 `git archive`（只含提交内容、无 `__pycache__`、行尾可控）优于直接 `tar` 工作区。
> 只上传 `backend/<svc>/` 这棵子树就够——Dockerfile 的 `COPY` 路径都是这一层之下的。

---

## 4. 覆盖层：不污染上游 compose

新建 `docker/docker-compose.hc.yml`（随 `docker/` 目录一起分发，因此**本地打包不会覆盖它**）：

```yaml
services:
  ai-service:
    image: ${AI_SERVICE_IMAGE:-hc-rpa/ai-service:deepseek-flash}
    build:
      context: ../src
      dockerfile: backend/ai-service/Dockerfile
      args:
        APT_MIRROR: ${APT_MIRROR:-mirrors.aliyun.com}
        PIP_INDEX_URL: ${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}
```

启用方式（二选一）：

```bash
# 显式
docker compose -f docker-compose.yml -f docker-compose.hc.yml up -d --force-recreate --no-build --no-deps ai-service

# 或写进 .env，之后普通 docker compose ... 命令自动带上覆盖层
COMPOSE_FILE=docker-compose.yml:docker-compose.hc.yml
```

**`image:` 必须用本地名**（`hc-rpa/...`）。若沿用 `ghcr.io/iflytek/...`，本地构建结果会占用该名字，
之后任何 `docker compose pull` 都会把上游镜像（缺修复）拉回来覆盖 → 故障复发。

Dockerfile 侧的换源参数（默认值保持官方源，行为不变）：

```dockerfile
ARG APT_MIRROR=deb.debian.org
ARG PIP_INDEX_URL=https://pypi.org/simple

RUN set -eux; \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        if [ -f "$f" ]; then sed -i "s|deb.debian.org|${APT_MIRROR}|g" "$f"; fi; \
    done; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip -i "${PIP_INDEX_URL}"
RUN pip install --no-cache-dir -i "${PIP_INDEX_URL}" -e .
```

---

## 5. 构建 → 上线 → 验证

```bash
cd /opt/hc-rpa/docker
cp .env .env.bak.$(date +%F); cp docker-compose.yml docker-compose.yml.bak.$(date +%F)

# ⚠️ 先改 .env（环境变量在创建容器时注入，必须早于 up -d）

docker compose build ai-service                  # 首次 2-3 分钟（换源后）；有缓存约 1 分钟
docker compose up -d --force-recreate --no-build --no-deps ai-service
docker compose restart openresty-nginx           # 必须：容器 IP 变了

# 验证
docker inspect rpa-opensource-ai-service --format 'image={{.Config.Image}} status={{.State.Status}} restarts={{.RestartCount}}'
docker exec rpa-opensource-ai-service python -V
docker exec rpa-opensource-ai-service python -c "import pytz, app.main; print('ok', pytz.__version__)"
docker exec rpa-opensource-ai-service printenv AICHAT_BASE_URL
docker exec rpa-opensource-ai-service python -c "import os,json,urllib.request as u; r=u.Request(os.environ['AICHAT_BASE_URL'].rstrip('/')+'/models',headers={'Authorization':'Bearer '+os.environ['AICHAT_API_KEY']}); print([m['id'] for m in json.load(u.urlopen(r,timeout=10))['data']])"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:32742/api/rpa-ai-service/v1/models   # 401/403 也算链路通，只要不是 502
```

最后一步的判定：**不是 502 就是通**（该路由需要平台登录态，所以 401/403 属正常）。

---

## 6. 踩坑速查（实测汇总）

| 现象 | 根因 | 处置 |
|---|---|---|
| `resolve : lstat /opt/hc-rpa/backend: no such file or directory` | `context: ..` —— 相对**基础 compose 文件目录**解析 | 改 `context: ../src`，并用 `docker compose config` 复核 |
| apt 那步耗时 153s | `deb.debian.org` 直连慢 | Dockerfile `ARG APT_MIRROR` + `build.args` 指定国内源 |
| `up -d <svc>` 把 mysql / casdoor 也重建了 | `up` 会把该服务的 **`depends_on` 依赖**一并纳入本次操作，`--force-recreate` 对它们同样生效 | 加 `--no-deps`（数据在卷里，重建本身无损失） |
| 构建成功，过段时间又坏了 | `image:` 沿用了 registry 名，被 `pull` 覆盖 | `image:` 用本地名 |
| 容器 `Up` 但对外 502 | 只有"进程活着"信号，没有"依赖齐全/端口在听"信号 | Dockerfile 加 import 冒烟 + compose 加 healthcheck（§7） |
| 换容器后仍 502 | nginx 在启动时缓存了上游容器 IP | `up -d` 后**必须** `restart openresty-nginx` |
| 包内 Dockerfile 变成 CRLF | Windows `core.autocrlf=true` 影响 `git archive` | 打包加 `-c core.autocrlf=false` |
| 改了 `.env` 但不生效 | 环境变量在**创建容器**时注入 | 先改 `.env` 再 `up -d --force-recreate` |

---

## 7. 加固（长期，建议随镜像一起做）

1. **Dockerfile 加 import 冒烟**：`RUN python -c "import app.main"` —— 构建期就能发现"缺依赖"（KI-10 的根因）
2. **compose 加 healthcheck**：`docker compose ps` 才能显示 `healthy`，而不是只显示 `Up`
3. **部署脚本固定 `restart openresty-nginx`**
4. 改动频繁 → 转路线 B（CI + GHCR）：`workflow_dispatch` 选 `services=<svc>`、`push_images=true`；
   公开仓库的 Actions 分钟数与容器镜像存储/带宽当前均免费，服务器继续 `compose pull` 即可

---

## 8. 可复用 Checklist

- [ ] 三条前置探测全通（基础镜像 / pip / apt）
- [ ] 服务器目录就位：`/opt/hc-rpa/src/backend/<svc>/`
- [ ] 源码包用 `git -c core.autocrlf=false archive`（不是 `tar` 工作区）
- [ ] 覆盖层 `image:` 用**本地名**，`context: ../src`，并用 `docker compose config` 复核展开路径
- [ ] 改 `.env` **早于** `up -d`
- [ ] `build` → `up -d --force-recreate --no-build --no-deps` → `restart openresty-nginx`
- [ ] 验证：`restarts=0` + 依赖 import 通过 + 关键环境变量非空 + 业务探测 200
- [ ] 备份文件保留原地（`.env.bak.YYYY-MM-DD`、`docker-compose.yml.bak.YYYY-MM-DD`）
- [ ] 服务器上的改动同步回仓库（覆盖层文件、Dockerfile）
- [ ] 台账登记：`known-issues.md`（KI-xx）+ `upstream-tracking.md`（偏离，如适用）

---

## 9. 相关文档

| 文档 | 内容 |
|---|---|
| [`known-issues.md`](./known-issues.md) KI-10 | 本次事件的记录（现象/根因/处置） |
| [`ai-capabilities-and-ai-service.md`](./ai-capabilities-and-ai-service.md) §2.6 / §4 | AI 能力侧落地记录、修复方案对比（A/B/C/D 四条路径） |
| [`upstream-tracking.md`](./upstream-tracking.md) §7 | 偏离台账（覆盖层、Dockerfile 换源 ARG、默认模型等） |
| [`astron-rpa-deployment.md`](./astron-rpa-deployment.md) | 服务端整体部署 |
