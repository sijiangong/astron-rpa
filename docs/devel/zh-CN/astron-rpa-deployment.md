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
| 网络 | 需能拉取 `ghcr.io` 镜像（国内见 §6 代理方案） |

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
curl -s -o /dev/null -w "前端: %{http_code}\n" http://127.0.0.1:32742/
curl -s -o /dev/null -w "casdoor: %{http_code}\n" http://127.0.0.1:8000/
# 前端 200、casdoor 200（或 302 登录跳转）即基本成功
```
浏览器访问 `http://<外网IP>:32742/`，用 casdoor（默认 admin/123 或 init_data_dump 里的账号）登录进入 HC RPA 控制台。

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

---

## 6. 国内拉取 ghcr 镜像慢（可选）

WSL2/国内服务器拉 `ghcr.io` 慢或断流时，给 docker daemon 配代理：
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
> 没有代理时，可用 ghcr 国内镜像源 `ghcr.nju.edu.cn`（拉取后 `docker tag` 回 `ghcr.io/...`）。

---

## 7. 账号与权限建议（生产）

- **安装/日常**：用一个带 sudo 的普通部署账号（如 `deploy`），加入 `docker` 组；不要用 root 日常操作
- 部署目录放 `/opt/astron-rpa`，属主为 deploy
- `.env` 权限收紧：`chmod 600 .env`；勿提交进 git
- 备份：定期 mysqldump `rpa` + `casdoor` 两库（casdoor 存全部账号，最重要）+ 归档 `.env`/compose

---

## 8. 核对清单（照此确认部署成功）

- [ ] `docker compose ps`：mysql/redis/minio `healthy`，nginx + 5 业务服务 + casdoor `Up`
- [ ] `curl 127.0.0.1:32742` 返回 200
- [ ] 浏览器登录 HC RPA（casdoor 账号）成功
- [ ] casdoor 库里有 init_data_dump.json 导入的数据（org/app/用户）
- [ ] `rpa` 库种子数据存在（如 `c_atom_meta_new`、`app_market_dict` 等有数据）
- [ ] 业务镜像版本非 `:latest`（若已做版本固定）
