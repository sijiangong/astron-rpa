# Astron Agent × astron-rpa 集成部署记录

> 记录时间：2026-09-05
> 部署方式：**复用现有 astron-rpa 的 Casdoor 与 RPA 后端**，在 WSL2 单独部署 Astron Agent 核心，实现 Agent 通过 RPA OpenAPI 调用现有 RPA 流程。
> 适用对象：在已有 astron-rpa 部署环境上二次接入 Astron Agent 的运维/开发人员。
>
> 📌 **脱敏说明**：为便于入库提交，文中真实环境值已替换为占位符，按需替换为你自己的值：
> `<server_ip>` 部署机地址 · `<wsl_gateway_ip>` WSL2 默认网关 · `<DB_PASSWORD>` 数据库密码 · `<RPA_API_KEY>` RPA OpenAPI API Key · `<CASDOOR_CLIENT_ID>` casdoor 应用 Client ID。

---

## 1. 部署架构

```
Windows (开发机/浏览器)
   │  浏览器访问 http://<server_ip>/   (astron-agent 控制台)
   │  浏览器访问 http://<server_ip>:32742/ (astron-rpa 前端，HC RPA)
   ▼
WSL2 (<server_ip>)
 ├─ astron-rpa  (docker/astron-rpa-1.1.6/docker)
 │    ├─ openresty-nginx   32742 → 80
 │    ├─ casdoor           8000        ← 复用的认证中心
 │    ├─ openapi/ai/resource/robot/rpa-auth  (内部网络)
 │    └─ 原生 MySQL        3306
 │
 └─ astron-agent (docker/astron-agent/docker/astronAgent)
      ├─ nginx             80    (控制台入口)
      ├─ console-frontend / console-hub
      ├─ core-tenant / core-workflow / core-agent / core-link /
      │   core-aitools / core-knowledge / core-database / core-rpa
      └─ 自带基础设施 mysql/postgres/redis/minio (仅内部网络，不占宿主端口)
```

**关键决策**：不使用官方 `docker-compose-with-auth-rpa.yaml`（all-in-one，会自带**第二套** casdoor+RPA，端口冲突且 RPA 为空），而是**只部署核心 `docker-compose.yaml`**，把控制台认证指向现有 casdoor、把 RPA 指向现有 astron-rpa。

| 项 | 值 |
|---|---|
| Astron Agent 控制台 | http://<server_ip>/ |
| 复用 Casdoor | http://<server_ip>:8000 |
| 复用 RPA（nginx） | http://<server_ip>:32742 |
| Casdoor 组织 | `example-org` |
| Casdoor 新应用 | `astron-agent-app`（Client ID：`<CASDOOR_CLIENT_ID>`） |
| RPA OpenAPI API Key | `<RPA_API_KEY>`（`Authorization: Bearer`） |

### 1.1 两套系统的网络与端口隔离（为什么 MySQL/Redis 各有一套）

两个 compose 项目各自运行在**独立的 docker 网络**上，互不可见、互不干扰：

| 项目 | 网络 | 自带基础设施（仅内部） |
|---|---|---|
| astron-rpa | `docker_rpa-opensource-network` | redis（`redis:7-alpine`）、minio、casdoor；MySQL 为外部原生实例 |
| astron-agent | `astronagent_astron-agent-network` | mysql（`astron-agent-mysql`）、postgres、redis（`redis:7`）、minio |

**真正发布到宿主（host）的端口只有这几个**（其余都是容器内部端口，`docker ps` 里显示为裸 `6379/tcp` 之类，**没有** `0.0.0.0:x->` 前缀）：

| 宿主端口 | 容器 | 用途 |
|---|---|---|
| `80` | astron-agent-nginx | agent 控制台 |
| `18998` / `18999` | astron-agent-minio | agent 对象存储 / 控制台 |
| `8000` | rpa-opensource-casdoor | casdoor 认证（被 agent 复用） |
| `32742` | rpa-opensource-openresty-nginx | astron-rpa 前端（HC RPA） |
| `3306` | （外部原生 MySQL） | astron-rpa 数据库 |

**常见疑问解答**：
- "agent 和 rpa 各有一个 redis / mysql，都写 6379 / 3306，会冲突吗？" → **不会**。它们在两个隔离网络里，端口只在各自网络内部按服务名互通；宿主上没有对应监听（可用 `ss -tlnp | grep :6379` 验证）。
- 每套系统自带的 DB/Redis/MinIO 只服务自己的 compose 项目，**复用的是 Casdoor（认证）和 RPA（流程执行），不是数据层**，所以 agent 仍需要自己的 mysql/postgres 存平台元数据。
- 排查端口冲突/占用时，只看**发布到宿主的端口表**（上面 4 个容器 + 原生 3306），内部端口无关。

---

## 2. astron-rpa 侧：MySQL 密码含 `@` 导致 Python 服务 500

### 现象
HC RPA 客户端「设置 → API keys」页面 500。openapi-service 日志：

```
Can't connect to MySQL server on '<密码@后段>@<server_ip>'
```

### 根因
数据库密码 `<OLD_DB_PASSWORD_with_at>` 含 `@`。Python 服务 `DATABASE_URL=mysql+aiomysql://rpa:<OLD_DB_PASSWORD_with_at>@host` 被 SQLAlchemy/pymysql 把 `@` 后的密码尾段解析成主机名 → 连不上。

Java 服务（robot/resource）走 `ATLAS_URL` 且已用 URL 编码（`@` → `%40`，即 `<OLD_DB_PASSWORD_with_at>` 编码后）所以没事；casdoor 用 Go DSN 格式能容忍 `@`。

### 修复（改密码，一劳永逸）
1. 以 root 执行 `ALTER USER 'rpa'@'%' IDENTIFIED BY '<DB_PASSWORD>'; FLUSH PRIVILEGES;`
2. 修改 `/usr/local/src/astron-rpa-1.1.6/docker/.env`（共 4 行）：
   - `DATABASE_PASSWORD="<DB_PASSWORD>"`
   - `ATLAS_URL=mysql://rpa:<DB_PASSWORD>@<server_ip>:3306/rpa?charset=utf8mb4&parseTime=True`
   - `ATLAS_HOST_URL=...`（同上）
   - `CASDOOR_DATABASE_PASSWORD=<DB_PASSWORD>`
3. `docker compose up -d` 重建 casdoor/ai/openapi/resource/robot/rpa-auth
4. compose 第 133/158 行 `DATABASE_URL` **无需改动**（密码无特殊字符后直接可用）

> ⚠️ 提醒：所有手头连接 MySQL 的工具/脚本（pymysql、DBeaver 等）都要换成新密码。

---

## 3. astron-rpa 侧：docker compose 重建后 nginx 502

### 现象
重建后端容器后，客户端报 502 Bad Gateway。

### 根因
nginx 的 `upstream` 是**静态服务名**，只在 nginx 启动时解析一次并缓存容器 IP。`docker compose up -d` 重建后端后容器 IP 变化，nginx 仍指向已销毁的旧 IP。

### 修复
```bash
docker compose restart openresty-nginx
```

> 💡 教训：以后只要重建过后端容器而 nginx 没重启，就可能再遇 502，重启 nginx 即可。

### 3.1 astron-agent 的 nginx 有同样的坑（模型管理/平台账号管理空白或 502）

**astron-agent 的控制台 nginx 同样使用静态 `upstream`**（指向 `console-hub`）。调试 console-hub（重建容器换 IP）后，nginx 仍缓存旧 IP（如 `172.19.0.8`，而 console-hub 实际在 `172.19.0.9`），导致：
- 「平台账号管理」「模型管理」等页面**空白**或报错
- 控制台 API 返回 502

**排查**：`docker inspect astron-agent-console-hub` 看当前 IP，对比 nginx 日志里的 upstream IP；`curl http://<server_ip>/console-api/api/model/rsa/public-key` 返回 502 即命中。

**修复**：
```bash
docker restart astron-agent-nginx
```

> 凡是"重建了某容器后、nginx 却没重启"造成的 502/空白页，都先重启对应 nginx（astron-rpa 的 `openresty-nginx` 或 astron-agent 的 `nginx`）。

---

## 4. WSL2 拉取 ghcr.io 镜像龟速/断流（关键网络坑）

### 现象
- ghcr.io 直连极慢（core-tenant 134MB 拉了约 24 分钟）且中途 `connection reset by peer`
- ghcr 国内镜像（ghcr.nju.edu.cn）也几乎无流量（实测 ~4KB/s）

### 根因
Windows 上代理只监听 `127.0.0.1`，WSL2 处于 **NAT 模式**访问不到宿主机 localhost → 所有对外大流量下载都走不通。

### 修复（两步）
1. **Clash Verge 开启「允许局域网连接」**（Allow LAN），端口 `7897`
2. **给 docker 守护进程配置代理**：
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/http-proxy.conf <<'EOF'
[Service]
Environment="HTTP_PROXY=http://<wsl_gateway_ip>:7897"
Environment="HTTPS_PROXY=http://<wsl_gateway_ip>:7897"
Environment="NO_PROXY=localhost,127.0.0.1,172.26.0.0/16"
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker
```
> `<wsl_gateway_ip>` 是 WSL2 的默认网关（Windows 宿主 IP），`172.26.0.0/16` 是 WSL2 内网段（放行容器间互访）。

验证：`docker info` 应显示 `HTTP Proxy: http://<wsl_gateway_ip>:7897`。

### 备用：ghcr 国内镜像（如需要）
docker 对 `ghcr.nju.edu.cn` 会解析到 IPv6 导致不可达，需钉 IPv4：
```bash
echo "210.28.130.20 ghcr.nju.edu.cn" | sudo tee -a /etc/hosts
docker pull ghcr.nju.edu.cn/iflytek/astron-agent/<img>:latest
docker tag ghcr.nju.edu.cn/iflytek/astron-agent/<img>:latest ghcr.io/iflytek/astron-agent/<img>:latest
```

### 4.1 镜像版本固定（生产/测试服务器必做）

**为什么**：`:latest` 是**浮动 tag**，会被持续推送更新。实测本地 `:latest` 的 manifest digest 与官方 `v1.1.5`/`v1.1.6` tag **都不一致**（拉取时点的 latest 是一个更新的临时构建）。生产必须固定，否则每次 `pull` 版本都在漂移、不可复现。

**固定到哪个版本**（两个项目版本号体系不同）：
| 项目 | 镜像 | 固定版本 | 说明 |
|---|---|---|---|
| astron-rpa | ai/openapi/resource/robot/rpa-auth | `v1.1.6` | 业务镜像；基础设施本来就固定（redis:7-alpine、minio:RELEASE.2025-06-13…、openresty:1.27.1.1-alpine、casdoor:v2.67.0）；`atlas:latest` 为一次性迁移工具可留 |
| astron-agent | 全部 `astron-agent/*` | `v1.1.2` | 通过 `ASTRON_AGENT_VERSION` 控制 |

**改法**：
```bash
# astron-rpa：docker-compose.yml 里 5 个业务镜像 :latest -> :v1.1.6（按需替换）
# astron-agent：.env 增加/修改一行
ASTRON_AGENT_VERSION=v1.1.2
```

**应用/部署到新服务器**：
```bash
docker compose pull && docker compose up -d   # astron-rpa
docker compose -f docker-compose.yaml pull && docker compose -f docker-compose.yaml up -d  # astron-agent
```
> 数据在 named volume 中，`up -d` 不会丢数据，版本变化会重建容器。

**如何核对镜像版本 tag 与 digest**（确认 latest 对应哪个版本）：
```bash
docker image inspect ghcr.io/iflytek/astron-rpa/<img>:latest --format '{{index .RepoDigests 0}}'
# 再用 ghcr 的 tags/list + manifests/<tag> 的 Docker-Content-Digest 头比对
```
> 简单说：直接 `docker compose config` 看解析出的镜像，确认非 `:latest` 即可。

---

## 5. Astron Agent `.env` 修改

文件：`/usr/local/src/astron-agent/docker/astronAgent/.env`（由 `.env.example` 复制后修改）

| 配置项 | 原值 | 改为 | 说明 |
|---|---|---|---|
| `HOST_BASE_ADDRESS` | `http://localhost` | `http://<server_ip>` | 控制台访问地址 |
| `CONSOLE_CASDOOR_URL` | `${HOST_BASE_ADDRESS}:${CASDOOR_PORT}` | `http://<server_ip>:8000` | 复用现有 casdoor |
| `CONSOLE_CASDOOR_ID` | `astron-agent-client` | `<CASDOOR_CLIENT_ID>` | casdoor 应用 Client ID |
| `CONSOLE_CASDOOR_APP` | `astron-agent-app` | `astron-agent-app` | 在 casdoor 中新建的应用名 |
| `CONSOLE_CASDOOR_ORG` | `built-in` | `example-org` | 复用 RPA 的组织 |
| `RPA_URL` | `https://newapi.iflyrpa.com` | `http://<server_ip>:32742` | 指向现有 RPA |
| `OAUTH2_JWK_SET_URI` | `http://casdoor:8000/.well-known/jwks` | `http://<server_ip>:8000/.well-known/jwks` | 不部署自带 casdoor，必须指向外部 |
| `TENANT_ID` | `680ab54f` | `680ab54f`（保持） | DB 已持久化，不能改 |
| `TENANT_KEY` / `TENANT_SECRET` | 仓库公开默认值 | **换成新随机值** | 见下文"坑" |

> `XIAOWU_RPA_TASK_CREATE_URL` / `XIAOWU_RPA_TASK_QUERY_URL` 在 compose 中由 `RPA_URL` **自动派生**为
> `http://<server_ip>:32742/api/rpa-openapi/workflows/execute-async` 与 `.../api/rpa-openapi/executions`，无需手改。

### 在 casdoor 中新建应用 `astron-agent-app`
1. 登录 casdoor 管理后台 http://<server_ip>:8000（admin）
2. 应用管理 → 添加：
   - Name：`astron-agent-app`
   - Organization：`example-org`
   - Redirect URLs（**两种都填**，casdoor 按字符串匹配）：
     ```
     http://<server_ip>/callback
     http://<server_ip>:80/callback
     ```
3. 保存后记录 Client ID / Client Secret

---

## 6. Astron Agent `docker-compose.yaml` 修改

文件：`/usr/local/src/astron-agent/docker/astronAgent/docker-compose.yaml`

### 6.1 `core-tenant` 崩溃：缺引导凭据
现象：`server start failed: load tenant bootstrap credentials failed: TENANT_KEY ... required`

修复：给 `core-tenant` 服务的 `environment:` 补三项：
```yaml
      TENANT_ID: "680ab54f"
      TENANT_KEY: "<新随机32位hex>"
      TENANT_SECRET: "<新随机32位hex>"
```
> ⚠️ 该 compose **不使用 env_file**，每个服务只靠显式 `environment:` 传参，`core-tenant` 原定义漏了这三项。

### 6.2 `core-tenant`：公开默认凭据被拒绝
现象：`... published legacy tenant credentials cannot be used`

原因：`.env.example` 里那组 `TENANT_KEY/SECRET` 是**公开仓库默认值**，软件出于安全拒绝使用。

修复：换成新随机值（`python3 -c "import secrets; print(secrets.token_hex(16))"`）。
同时更新 `.env` 中的 `TENANT_KEY/TENANT_SECRET`（含重复出现处）与 `docker-compose.yaml`。

> ⚠️ **TENANT_ID 必须保持 `680ab54f`** —— 之前某次部分启动已把该 ID 的引导数据持久化进数据库，改动会报
> `TENANT_ID must remain 680ab54f because persisted bootstrap data refers to it`。

### 6.3 `console-hub` 崩溃：skill.sandbox 安全配置（两道关卡）
现象：`APPLICATION FAILED TO START ... Property: skill.sandbox.artifactUploadTokenSourceConfigured ... must be configured`

给 `console-hub` 的 `environment:` 补两项（Spring 宽松绑定：`.` → `_`，驼峰 → 下划线大写）：
```yaml
      SKILL_SANDBOX_ARTIFACT_UPLOAD_TOKEN: "<随机32位hex>"
      SKILL_SANDBOX_RUNTIME_CREDENTIAL_TOKEN: "<随机32位hex>"
```
第一道缺失报 `artifactUploadTokenSourceConfigured`，补上后第二道报 `runtime-credential.tokenSourceConfigured`，**两个都要配**。

### 6.4 `core-workflow` 高 CPU/崩溃循环：worker 缺 Tenant 引导凭据

**现象**：WSL2 CPU 接近 100%，进程列表里大量 `/opt/core/workflow/.venv/bin/python3 ... multiprocessing.spawn` 子进程（每个 ~80% CPU）+ 大量 `<defunct>` 僵尸，且 PID 不断增长。`docker ps` 显示 `astron-agent-core-workflow` 为 `unhealthy`。

**日志**：
```
RuntimeError: Tenant bootstrap credentials are missing or invalid
Application startup failed. Exiting.
```

**根因**：与 6.1 相同 —— compose **不用 env_file**，`core-workflow` 的 `environment:` 漏了 `TENANT_ID/TENANT_KEY/TENANT_SECRET`，导致其 Python worker 进程启动即崩，主进程不断 fork 重生 → 死循环占满 CPU。

**修复**：给 `core-workflow` 的 `environment:` 补三项（与 core-tenant 相同的值）：
```yaml
      TENANT_ID: "680ab54f"
      TENANT_KEY: "<新随机32位hex，与 .env / core-tenant 一致>"
      TENANT_SECRET: "<新随机32位hex，与 .env / core-tenant 一致>"
```
然后 `docker compose -f docker-compose.yaml up -d core-workflow` 重建，等待 30~60s 变 `healthy`。

> ⚠️ **重要教训**：所有 astron-agent 的 core 服务（tenant / workflow / agent / link / aitools / knowledge / database / rpa）都可能需要 Tenant 引导凭据。**凡是出现 `Tenant bootstrap credentials ... missing/invalid` 的崩溃/高 CPU，就给对应服务的 `environment:` 补上 TENANT_ID/TENANT_KEY/TENANT_SECRET 再重建。** 排查顺序：`docker logs <容器> --since 20m | grep "Tenant bootstrap"`。
> 修复后验证：`docker ps` 不再 `unhealthy`、`ps -eo pcpu --sort=-pcpu` 无 ~80% 的 spawn 进程、`uptime` 负载回落。

---

## 7. RPA 调用鉴权（core-rpa → execute-async）

astron-agent 的 `core-rpa`（源码 `core/plugin/rpa/infra/xiaowu/tasks.py`）调用 RPA 时：

```http
POST http://<server_ip>:32742/api/rpa-openapi/workflows/execute-async
Authorization: Bearer <RPA OpenAPI API Key>
Content-Type: application/json

{ "project_id": "...", "exec_position": "...", "params": {...} }
```

- 任务查询：`GET {XIAOWU_RPA_TASK_QUERY_URL}/{task_id}`，同样带 Bearer
- API key 在 astron-rpa 客户端「设置 → API keys」生成

### 7.1 关键：agent 看不到 RPA 应用？「发版」≠「开通外部调用」

**现象**：在 HC RPA 客户端发版了新应用，但 Astron Agent「资源管理 → 晓悟RPA」列表里始终不出现（之前靠手工 `INSERT INTO openai_workflows` 才能绕过）。

**根因（代码定位）**：
- agent 侧列表只读 RPA 库的 `openai_workflows`（属于 `openapi-service`，按 API Key 对应的 `user_id` 过滤）
- 该表**唯一写入入口**是 `POST /api/rpa-openapi/workflows/upsert`
- 客户端里**只有「外部调用配置」弹窗**会调用它（`web-app/.../views/Home/components/modals/McpConfigModal/index.vue` → `setRobotIsExternalCall`）
- 「发版」走的是 robot-service（`robot_design`/`robot_version`/`robot_execute`），**不会写** `openai_workflows`

**正确操作**：

> **执行器 → 应用列表 → 目标应用所在行末尾的 `⋯` → 「外部调用配置」→ 填写必填项（名称/简介；`parameters` 每项 `varDescribe` 不能为空）→ 打开“允许外部调用”→ 保存**

⚠️ 入口**仅在“来源=本地”的行**出现（`useRobotTableOption.tsx`：`sourceName === '本地' ? localMoreOpts : marketMoreOpts`，“本地”由 `robot_execute.data_source = 'create'` 映射）。若应用行来自市场，则没有这一项。

**只读核对**：
```sql
-- 应出现该应用且 status=1；user_id 必须与 agent 使用的 API Key 属于同一用户
SELECT project_id, name, user_id, status FROM openai_workflows;
-- 执行器列表的来源（create=本地，deploy/market=非本地）
SELECT id, robot_id, name, data_source FROM robot_execute WHERE name LIKE '%应用名%';
```

---

## 8. 过程中的环境坑（写给后续操作）

1. **`wsl bash -lc '...'` 透传会吞掉 `$` 与引号内特殊字符**
   - shell 变量赋值、`for` 循环变量、awk 的 `$1`、heredoc 中 `${VAR}` 都可能被清空/破坏
   - 对策：改用**字面完整路径**、`sed` 按**行号**替换、避免在命令里依赖 `$`
2. **`docker pull` 无 TTY 时不显示进度条**
   - 只有真实终端才有动态进度；命令末尾别加 `| tail`（会缓冲到结束才输出，误以为卡死）
3. **`docker images` 看不到拉取中的镜像**：镜像整拉完才出现，判断进度用 `docker pull` 自身输出或 `du` 观测
4. **内存偏紧**：astron-agent 自带 mysql/postgres/redis/minio 等约 15 容器，WSL2 建议 ≥ 16GB 内存；`free -g` 观察
5. `core-workflow` 曾长期 `health: starting`，若一直不 healthy 需查其健康检查与日志
6. 若某容器反复 `Restarting`，先 `docker logs <容器> --tail 30` 看启动报错，多数是缺某个环境变量配置

---

## 9. 部署/回滚要点速查

```bash
# Astron Agent 启动 / 停止 / 查看
cd /usr/local/src/astron-agent/docker/astronAgent
docker compose -f docker-compose.yaml up -d
docker compose -f docker-compose.yaml down
docker compose -f docker-compose.yaml ps

# 修改 .env 或 docker-compose.yaml 后应用
docker compose -f docker-compose.yaml up -d   # 会自动重建受影响容器

# astron-rpa 相关
cd /usr/local/src/astron-rpa-1.1.6/docker
docker compose up -d          # 重启后端（改动 .env 后）
docker compose restart openresty-nginx   # 502 时执行
```

**主要配置/备份文件**：
- `astron-rpa`: `/usr/local/src/astron-rpa-1.1.6/docker/.env`（含 `<DB_PASSWORD>` 新密码、ATLAS_URL 等）
- `astron-agent`: `/usr/local/src/astron-agent/docker/astronAgent/.env`、`docker-compose.yaml`
- docker 代理: `/etc/systemd/system/docker.service.d/http-proxy.conf`
- `/etc/hosts`: 已钉 `ghcr.nju.edu.cn` IPv4

---

## 10. 后续待办
- [ ] 控制台登录（casdoor / `example-org`）验证通过
- [ ] 「平台账号管理 → AI Ability Chat」配置 DeepSeek（OpenAI 兼容：base_url + model + api_key）
- [ ] 验证 RPA 工具调用（agent 触发一个 RPA 流程，确认 core-rpa 带 Bearer key 成功打到 execute-async）
- [ ] 观察 `core-workflow` 健康状态
