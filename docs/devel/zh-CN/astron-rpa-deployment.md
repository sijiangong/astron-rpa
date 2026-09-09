# astron-rpa 服务端独立部署指南

> 适用：只部署 **astron-rpa 服务端**（不含 Astron Agent），在**一台全新的 Linux 服务器**上从零部署。
> 覆盖两种数据库形态：
> - **方案 A：使用 docker compose 自带的 MySQL**（新机器最省事，推荐）
> - **方案 B：使用一台已有的/本机原生 MySQL**（数据库不跑在容器里）
>
> 编写依据：仓库 `docker/docker-compose.yml`（自带 MySQL 版）+ 官方 v1.1.6 release compose（外接 MySQL 版）+ github main 的 `.env.example` 结构。

---

## 0. 部署前置

| 项 | 要求 |
|---|---|
| 服务器 | Linux（本指南以 Ubuntu 系为例），建议 ≥ 8 核 / 16G（<10 用户时 4C/8G 也够） |
| Docker | Docker Engine + compose 插件（v2） |
| 源码 | astron-rpa 1.1.6 源码，含 `docker/` 目录（compose、`.env.example`、`volumes/`） |
| 对外端口 | `32742`(前端)、`8000`(casdoor)；自带 MySQL 版不对外开 3306 |
| 网络 | 需能拉取 `ghcr.io` 与 `docker.io` 镜像（国内见 §6） |

---

## 1. 方案 A：用 docker compose 自带的 MySQL（推荐，全新机器最省事）

### 1.1 准备源码与目录

```bash
# 以你选择的部署用户（见文末"账号与权限建议"）操作
mkdir -p /opt/astron-rpa && cd /opt/astron-rpa
# 把 astron-rpa 源码中的 docker/ 内容放进来（compose/.env.example/volumes）
# 例如：cp -r <源码>/docker/* .
```

确保 `docker/` 下有以下内容：
```
docker-compose.yml          # 自带 mysql 版（含 mysql/atlas/redis/minio/nginx/casdoor/5个业务服务）
.env.example
volumes/mysql/              # schema.sql + 4 个 init_*.sql（自动建 rpa 库表+种子）
volumes/casdoor/init_data_dump.json   # casdoor 初始数据（首启自动导入）
volumes/nginx/  volumes/atlas/
```

### 1.2 生成 `.env`（关键）

```bash
cp .env.example .env
vim .env
```

按下面**改/补**（`rpa123456` 等请换成你的强密码；`<外网IP>` 换成服务器对客户端可访问的 IP）：

```dotenv
# ---- Mysql（app 服务 + mysql 容器初始化用）----
DATABASE_USERNAME="root"
DATABASE_PASSWORD="rpa123456"          # ← 改成你的强密码（首次初始化才生效）
DATABASE_HOST="rpa-opensource-mysql"   # 自带 mysql 的服务名，不要改
DATABASE_PORT=3306
DATABASE_NAME="rpa"
ATLAS_URL=mysql://root:rpa123456@rpa-opensource-mysql:3306/rpa?charset=utf8mb4&parseTime=True
ATLAS_HOST_URL=mysql://root:rpa123456@localhost:3306/rpa?charset=utf8mb4&parseTime=True

# ---- Casdoor Mysql Config（casdoor 用；v1.1.6 的 .env.example 遗漏，github main 已补，务必加上）----
CASDOOR_DATABASE_HOST="rpa-opensource-mysql"
CASDOOR_DATABASE_PORT=3306
CASDOOR_DATABASE_USERNAME="root"
CASDOOR_DATABASE_PASSWORD="rpa123456"   # 与上面一致
CASDOOR_DATABASE_NAME="casdoor"

# ---- 其余保持（按需改）----
CASDOOR_EXTERNAL_ENDPOINT="http://<外网IP>:8000"
```

> ⚠️ 密码**不要含 `@` `:` `/` 等 URL 特殊字符**（Python 服务把 `DATABASE_PASSWORD` 直接拼进 `mysql+aiomysql://` 连接串，含 `@` 会导致解析错乱 —— 见 §5.2）。建议用字母数字 + 下划线，如 `Rpa_2026`。
> ⚠️ `ATLAS_URL`/`ATLAS_HOST_URL` 若密码有特殊字符需 URL 编码；用无特殊字符密码则不需要。

### 1.3 首次启动（空卷，自动初始化）

```bash
docker compose up -d
```

首启会自动完成（**务必用空卷**，勿复用旧卷）：
1. `mysql` 容器：按 `MYSQL_ROOT_PASSWORD` 设 root 密码 → 自动建 `rpa` 库 → 跑 `volumes/mysql/*.sql`（表结构 + 种子数据）
2. `casdoor`：连上 mysql 的 `casdoor` 库（无则自建）→ 导入 `init_data_dump.json`（组织/应用/内置数据）
3. `redis`/`minio`/`atlas` 初始化 → 5 个业务服务起来

查看状态：
```bash
docker compose ps
# 期望：mysql/redis/minio healthy；nginx/resource/robot/ai/openapi/rpa-auth/casdoor Up
```

### 1.4 验证

```bash
curl -s -o /dev/null -w "nginx 入口: %{http_code}\n" http://127.0.0.1:32742/health   # 期望 200
curl -s -o /dev/null -w "casdoor: %{http_code}\n" http://127.0.0.1:8000/             # 期望 200（或 302 登录跳转）
```
> 说明：本 compose 的 nginx 只反代 API，`/` 返回 404 属正常（**不内置 Web 控制台静态页**）。真正的“前端”是 **HC RPA 桌面客户端**（连 `http://<IP>:32742`）或另行部署的 Web 控制台；`/health` 与各 `/api/*` 通即服务端正常。

> ⚠️ **首启成功后建议重启一次 `rpa-auth`**：casdoor 导入 `init_data_dump.json` 与 `rpa-auth` 的分类数据预热存在启动竞态（rpa-auth 可能先于 casdoor 建好组织就跑，只看到 built-in）。casdoor 就绪后执行 `docker compose restart rpa-auth`，让预热器对 `example-org` 等组织补跑。详见 §5.6。

登录验证：用 casdoor 账号（默认 admin/123 或 init_data_dump 里的账号）访问 `http://<外网IP>:8000`（若改端口见 §5.5），客户端连 `http://<外网IP>:32742`。

---

## 2. 方案 B：用已有的/本机原生 MySQL

> 适用：你已有一台 MySQL（本机原生或独立服务器），不希望 MySQL 跑在容器里。
> 该形态对应**官方 v1.1.6 release 的 compose**（不含 mysql 服务）；如果你用的是"自带 mysql 版" compose，需要先改造（见 §2.3）。

### 2.1 在目标 MySQL 上准备库与账号

用 root 或管理账号在**外部 MySQL** 上执行：

```sql
-- 建业务库 rpa（若没有）
CREATE DATABASE IF NOT EXISTS `rpa` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
-- 建 casdoor 库
CREATE DATABASE IF NOT EXISTS `casdoor` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

-- 建应用账号（可选，推荐用专用账号；授权两个库）
CREATE USER 'rpa'@'%' IDENTIFIED BY 'Rpa_2026';   -- 密码别含 @ : /
GRANT ALL PRIVILEGES ON `rpa`.* TO 'rpa'@'%';
GRANT ALL PRIVILEGES ON `casdoor`.* TO 'rpa'@'%';
FLUSH PRIVILEGES;
```

**初始化 `rpa` 库**（表结构 + 种子数据，利用 compose 里的 SQL 文件，按序执行）：
```bash
# 在服务器源码 docker/volumes/mysql/ 下，用 mysql 客户端导入（目标=外部库）
mysql -h<MYSQL_IP> -urpa -p'Rpa_2026' rpa < schema.sql
mysql -h<MYSQL_IP> -urpa -p'Rpa_2026' rpa < init_app_market_dict_data.sql
mysql -h<MYSQL_IP> -urpa -p'Rpa_2026' rpa < init_his_data_enum_data.sql
mysql -h<MYSQL_IP> -urpa -p'Rpa_2026' rpa < init_sample_template_data.sql
mysql -h<MYSQL_IP> -urpa -p'Rpa_2026' rpa < init_c_atom_meta_new_data.sql
```

**`casdoor` 库**：**只需建空库 + 授权**，不用导 SQL —— casdoor 容器首启会自建表并导入挂载的 `init_data_dump.json`（见 §2.2 compose 挂载）。

### 2.2 使用"外接 MySQL 版" compose + `.env`

**compose**：使用**不含 mysql 服务**的 compose（官方 v1.1.6 release 的 `docker/docker-compose.yml` 即此形态：各服务 `DATABASE_URL` 用 `${DATABASE_HOST}`，无 `depends_on mysql`）。若源码里只有"自带 mysql 版"，按 §2.3 改造。

**`.env`**（关键差异是 host/账号指向外部 MySQL）：
```dotenv
DATABASE_USERNAME="rpa"
DATABASE_PASSWORD="Rpa_2026"           # 与 §2.1 建的账号一致
DATABASE_HOST="<MYSQL_IP>"             # 外部 MySQL 的 IP/域名（容器能访问到）
DATABASE_PORT=3306
DATABASE_NAME="rpa"
ATLAS_URL=mysql://rpa:Rpa_2026@<MYSQL_IP>:3306/rpa?charset=utf8mb4&parseTime=True
ATLAS_HOST_URL=mysql://rpa:Rpa_2026@127.0.0.1:3306/rpa?charset=utf8mb4&parseTime=True

CASDOOR_DATABASE_HOST="<MYSQL_IP>"
CASDOOR_DATABASE_PORT=3306
CASDOOR_DATABASE_USERNAME="rpa"
CASDOOR_DATABASE_PASSWORD="Rpa_2026"
CASDOOR_DATABASE_NAME="casdoor"
```
> ⚠️ casdoor 连的库是 `casdoor`；若你用的 compose 里 casdoor 服务仍以 `dataSourceName=${DATABASE_USERNAME}:${DATABASE_PASSWORD}@tcp(${DATABASE_HOST}:${DATABASE_PORT})/` 拼接（未指定库名），casdoor 会用默认库名 `casdoor`，因此 **DATABASE_HOST/USERNAME/PASSWORD 与 CASDOOR_DATABASE_* 必须指向同一台 MySQL 且账号权限一致**，两种变量别写岔。

**启动**：
```bash
docker compose up -d
# casdoor 首启：在空的 casdoor 库建表 + 导入 init_data_dump.json
```

> ⚠️ 若你的外部 MySQL 里 `casdoor` 库已存在旧数据，casdoor 不会重复导入 init_data_dump.json（空库才导）。要重置就清空 casdoor 库后重启 casdoor。

### 2.3 如果你手上只有"自带 mysql 版" compose，要改成外接版

对 `docker-compose.yml` 做三处调整：
1. **删除 `mysql` 与 `atlas` 两个 service 块**
2. **删除其余每个 service 的 `depends_on:` 里的 `mysql: condition: service_healthy`**（保留 redis/minio/casdoor 依赖）
3. 把 ai/openapi 服务 `DATABASE_URL` 里的字面 `@mysql:3306` 改成 `@${DATABASE_HOST}:${DATABASE_PORT}`

---

## 3. 通用：版本固定（强烈建议）

官方 `latest` 是浮动 tag。生产/测试固定到发布版本：
```bash
# 5 个业务镜像 :latest -> :v1.1.6
sed -i 's|ghcr.io/iflytek/astron-rpa/\(ai-service\|openapi-service\|resource-service\|robot-service\|rpa-auth\):latest|\1:v1.1.6|' docker-compose.yml
```
> 基础设施镜像（redis/minio/openresty/casdoor）官方已固定版本，无需改；`atlas:latest` 为一次性迁移工具可留。
> 验证：`docker compose config | grep image:` 应无业务镜像 `:latest`。

---

## 4. 启动 / 停止 / 升级速查

```bash
cd /opt/astron-rpa/docker
docker compose up -d            # 启动
docker compose ps               # 状态
docker compose logs -f openapi-service   # 看日志
docker compose down             # 停止（不带 -v，勿删数据卷！）

# 改了 .env / compose 后应用
docker compose up -d

# 重建后端后前端 502 → 重启 nginx
docker compose restart openresty-nginx
```

---

## 5. 常见坑（务必先读）

### 5.1 nginx 502（重建后端后）
nginx 的 `upstream` 是静态服务名，只在启动时解析一次。`docker compose up -d` 重建后端换 IP 后，nginx 仍指向旧 IP → 502。
**修复**：`docker compose restart openresty-nginx`

### 5.2 MySQL 密码含 `@` 导致 Python 服务 500
Python 服务把密码直接拼进 `mysql+aiomysql://user:pass@host`，密码含 `@` 会被解析错（连到 `xxxx@host`）。
**规避**：密码只用字母数字 + 下划线；若已踩坑，改密码后更新 `.env` 四处并重建服务。

### 5.3 mysql 容器只在"首次空卷"按 `.env` 初始化
之后改 `DATABASE_PASSWORD` **不会改库里密码**（要 `ALTER USER` 或删卷重建）。casdoor 库同理只在空库时导入 `init_data_dump.json`。

### 5.4 内存/自启
- 容器带 `restart: always`，机器重启自动回来（确保 `systemctl enable docker`）
- 建议给 mysql 容器加 `mem_limit`（如 2g）防 OOM

### 5.5 端口
只有 `32742`、`8000` 发布到宿主；业务服务(8010-8040)与 mysql/redis/minio 均在内部网络。如需外部直连某服务再自行 publish。

> ⚠️ **casdoor 的 `8000` 若与宿主机既有服务冲突**：把 compose 里 casdoor 的 `ports` 从 `8000:8000` 改为其它宿主端口（如 `18000:8000`），并把 `.env` 的 `CASDOOR_EXTERNAL_ENDPOINT` 同步为 `http://<IP>:18000`。容器间仍走内网 `casdoor:8000`，不受影响；只有外部浏览器访问用改后的端口。

### 5.6 首启竞态：rpa-auth 数据预热早于 casdoor 导入

首启时 `casdoor` 要先导入 `init_data_dump.json`（建出 `example-org` 等组织），而 `rpa-auth` 启动即跑分类数据预热器——它可能**比 casdoor 导入完成更早**执行，于是只看到 `built-in` 组织、漏了其它组织的数据。

**判断**：`docker compose logs rpa-auth` 中 `select name from casdoor.organization where name not in ('built-in')` 返回 `Total: 0`，但随后直接查库能看到 `example-org` 已存在。

**修复**：等 casdoor 就绪后重启一次 rpa-auth，让预热器补跑：
```bash
docker compose restart rpa-auth
docker compose logs rpa-auth --tail 15   # 应看到“分类数据导入完成”
```

---

## 6. 国内拉取镜像慢/断流（可选）

astron-rpa 镜像分两处：**5 个业务镜像在 `ghcr.io`**，**基础设施镜像（mysql/redis/minio/casdoor/openresty/atlas）在 `docker.io`**。国内按下面分别处理。

### 6.1 `docker.io` 镜像慢/断流 → registry 加速 + 自动重试

配置镜像加速（公共加速器可用性会变，多挂几个，docker 按序尝试）：
```bash
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://docker.1panel.live",
    "https://dockerproxy.net",
    "https://hub.rat.dev"
  ]
}
EOF
sudo systemctl restart docker
```

若仍偶发 `connection reset by peer`，用自动重试循环拉完（层会缓存，重试不重复下载）：
```bash
for img in \
  mysql:8.4.6 \
  redis:7-alpine \
  openresty/openresty:1.27.1.1-alpine \
  minio/minio:RELEASE.2025-06-13T11-33-47Z-cpuv1 \
  casbin/casdoor:v2.67.0 \
  arigaio/atlas:latest ; do
  echo "===== pulling $img ====="
  until docker pull "$img"; do echo "retry..."; sleep 3; done
done
```
> `docker.io` 加速对 `ghcr.io` 无效，业务镜像见下。

### 6.2 `ghcr.io` 业务镜像慢 → ghcr 镜像源 + 重打 tag

国内直连 `ghcr.io` 可能只有几 KB/s。实测南京大学镜像源 `ghcr.nju.edu.cn` 很快：拉取后 `docker tag` 回 `ghcr.io` 原名（compose 按原名引用）：
```bash
# 钉 IPv4（ghcr.nju.edu.cn 有 IPv6 解析坑，DNS 可能给到不可达地址）
echo "210.28.130.20 ghcr.nju.edu.cn" | sudo tee -a /etc/hosts

# 逐个拉取并重打为 ghcr.io 原名
for img in ai-service openapi-service resource-service robot-service rpa-auth; do
  docker pull ghcr.nju.edu.cn/iflytek/astron-rpa/${img}:v1.1.6 && \
  docker tag ghcr.nju.edu.cn/iflytek/astron-rpa/${img}:v1.1.6 ghcr.io/iflytek/astron-rpa/${img}:v1.1.6
done
```
> `arigaio/atlas` 在 ghcr 有官方同步，也可走此线：拉 `ghcr.nju.edu.cn/ariga/atlas:latest` 后 tag 回 `arigaio/atlas:latest`。
> 若镜像源无该仓库（报 manifest unknown）或仍慢，改用 6.3 或 6.4。

### 6.3 有可用代理 → docker daemon 全局代理（docker.io 与 ghcr.io 通吃）

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/http-proxy.conf <<'EOF'
[Service]
Environment="HTTP_PROXY=http://<代理IP>:<端口>"
Environment="HTTPS_PROXY=http://<代理IP>:<端口>"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
```

### 6.4 兜底：离线导入

在能正常拉取的机器上 `docker pull` + `docker save` 成 tar，传到服务器 `docker load`。适合"加速源全不通 / 镜像源没有该仓库"时，对少量镜像最可靠。

---

## 7. 账号与权限建议（生产）

**职责划分：root 只做一次性系统安装/配置；日常 `docker compose` 全部由普通部署账号 `deploy` 执行（无需 sudo）。**

### 7.1 一次性系统配置（root 执行）

```bash
# 1) 安装 Docker（官方 apt 源，含 compose v2 插件；见 §0 部署前置）
apt update && apt install -y ca-certificates curl gnupg
#   …按 Docker 官方 Ubuntu 22.04 步骤添加 apt 源后：
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# 2) 建部署账号并加入 docker 组（加组后需重新登录或 newgrp docker 才生效）
useradd -m -s /bin/bash deploy
usermod -aG docker deploy

# 3) 部署目录交给 deploy（含以后 compose 挂载的宿主机目录，统一归 deploy 最省心）
mkdir -p /opt/astron-rpa
chown -R deploy:deploy /opt/astron-rpa

# 4) 放行对外端口（按需）
ufw allow 32742/tcp && ufw allow 8000/tcp
```

> ⚠️ 目录归属很关键：`volumes/mysql/`、`logs/` 等宿主机挂载目录若属 root，容器内以普通 uid 写入会权限不足 → 整体 `chown deploy` 后再起容器。

### 7.2 日常操作（deploy 执行，不需要 sudo）

```bash
su - deploy                     # 或直接用 deploy 登录
cd /opt/astron-rpa
docker compose up -d            # docker 组已授权，无需 sudo
docker compose ps / logs -f ...
```

- 拷入源码 `docker/` 后先 `chown -R deploy:deploy .` 再操作
- `.env` 属主为 deploy 并收紧权限：`chmod 600 .env`；**勿提交进 git**
- 无需 root/sudo 跑 compose：docker 组授权已覆盖日常所有 docker 命令

### 7.3 什么时候才需要 sudo（备用钥匙）

只有偶尔的系统级操作才用 sudo：改 docker daemon 代理后 `systemctl restart docker`、写 `/etc/hosts`（ghcr 镜像钉 IP）、装 mysql 客户端（§2 方案 B 导 SQL）、看 `journalctl`。因此 `deploy` 保留 sudo 是"备用"，日常用不到。

> ⚠️ **风险提示**：`docker` 组成员实际≈root（可挂载宿主目录、起特权容器）。单机自用没问题；若多人共用一台服务器，加入 docker 组即等于授 root 能力，需谨慎对待。

### 7.4 备份

- 定期 `mysqldump` `rpa` + `casdoor` 两库（casdoor 存全部账号，最重要）
- 归档 `.env` 与 `docker-compose.yml`（恢复环境依赖这两份文件）

---

## 8. 核对清单（照此确认部署成功）

- [ ] `docker compose ps`：mysql/redis/minio `healthy`，nginx + 5 业务服务 + casdoor `Up`
- [ ] `curl 127.0.0.1:32742` 返回 200
- [ ] 浏览器登录 HC RPA（casdoor 账号）成功
- [ ] casdoor 库里有 init_data_dump.json 导入的数据（org/app/用户）
- [ ] `rpa` 库种子数据存在（如 `c_atom_meta_new`、`app_market_dict` 等有数据）
- [ ] 业务镜像版本非 `:latest`（若已做版本固定）
