# 引擎依赖（`engine/uv.lock`）变更记录

> 适用范围：`engine/`（Python 执行核心）的依赖声明与 `uv.lock` 锁文件。
> 目的：把"某次依赖增删"的**原因、影响与验证方式**留在仓库里，避免以后只看到一份 diff 却猜不出缘由，也避免重复讨论同一个问题。

---

## 变更索引

| 日期 | 变更 | 关联提交 |
|---|---|---|
| 2026-09-15 | 同步 `engine/uv.lock`：移除 `astronverse-database` 及其 4 个数据库驱动 | 本次提交 |
| 2026-02-11 | 从 `engine/pyproject.toml`、`engine/requirements.txt`、`build.bat` 移除 `astronverse-database` | `1516880f` |
| 2026-02-11 | `engine/meta_json.py` 新增 `skipped_verse = ["astronverse-database"]` | `b08ff0ee` (#534) |

---

## 2026-09-15：`uv.lock` 同步清理 `astronverse-database` 依赖

### 改了什么

`engine/uv.lock`：**删除 103 行 / 新增 2 行**，移除 5 个 `[[package]]` 条目，并删除根包 `engine` 中对 `astronverse-database` 的依赖声明。

| 包 | 移除前版本 | 来源 |
|---|---|---|
| `astronverse-database` | 1.0.1 | 本仓库组件（`components/astronverse-database`，editable 本地包） |
| `cx-oracle` | 8.3.0 | 第三方，Oracle 驱动 |
| `psycopg2-binary` | 2.9.11 | 第三方，PostgreSQL 驱动 |
| `pymysql` | 1.1.2 | 第三方，MySQL 驱动 |
| `pyodbc` | 5.3.0 | 第三方，ODBC 驱动 |

新增的 2 行是 `brotlicffi` 1.2.0.0 的两条 `cp314` wheel（uv 重新解析依赖时补入的构建产物），与本次删除无关。

### 为什么删

按因果顺序，这件事分三步：

**1）该组件目前未接入引擎，不是对外可用的能力**

- `engine/components/astronverse-database/config.yaml` 与 `meta.json` 均为 **0 字节**，即没有注册任何原子能力；
- `engine/meta_json.py` 中 `skipped_verse = ["astronverse-database"]` 明确跳过该目录，不参与 meta 的生成与上传（`engine/README.md` / `engine/README.zh.md` 的工作流程一节已记录这一跳过行为）。

**2）2026-02-11 的 `1516880f` 已把它从依赖和构建成员中摘除**

- `engine/pyproject.toml`、`engine/requirements.txt` 删除该依赖；
- `build.bat` 在遍历 `components/*` 组装 uv workspace members 时显式排除 `astronverse-database`。

**3）但该提交漏更新 `uv.lock`**

锁文件里因此残留上述 5 个包：其中 4 个数据库驱动**仅由 `astronverse-database` 引入**，在依赖图里成了孤儿。本次重新执行 `uv lock`，让锁文件与 `pyproject.toml` 对齐 —— 这也是本次变更的全部目的，**不是**新做出的功能/兼容性决策。

### 影响范围

- 引擎运行时不再携带 `cx_Oracle` / `psycopg2` / `pymysql` / `pyodbc`：安装体积与构建时长下降。其中 `cx-oracle` 需要本机 Oracle 客户端、`psycopg2` 需要编译环境，不再作为引擎依赖对用户环境更友好。
- 组件源码目录 `engine/components/astronverse-database/` **保留不动**（未删除、未改动），其 `src/astronverse/database/core_win.py` 里仍有 `import cx_Oracle / psycopg2 / pymysql / pyodbc`，只是当前不在引擎依赖图中。
- 这 4 个驱动在整个仓库中**只被该组件引用**（全仓库 `.py` / `.toml` 检索确认无其它使用点），因此移除不影响其它组件与后端服务。
- 用户工程若需要连接数据库，应在**应用编辑界面的「Python 包管理」**里按应用添加对应驱动：记录写入 `c_require` 表、安装到该应用独立的 `venvs/<project_id>/venv`，而不是依赖引擎的全局环境。

### 如何验证

```bash
cd engine
uv lock --check          # 退出码 0 表示锁文件与 pyproject.toml 一致
grep -n "astronverse-database\|cx-oracle\|psycopg2\|pymysql\|pyodbc" uv.lock   # 应无输出
```

本次执行结果：`uv lock --check` 退出码 0（Resolved 339 packages），`grep` 无输出。

### 若要恢复该组件

需**同时**还原以下四处，缺一处就会再次出现"声明与锁文件不一致"或组件静默不可用：

1. `engine/pyproject.toml` 的 `dependencies`，以及 `[tool.uv.sources]` 中的本地路径映射；
2. `engine/requirements.txt`；
3. `build.bat` 中 `components/*` 的 workspace members 排除条件；
4. `engine/meta_json.py` 的 `skipped_verse`。

还原后需重新执行 `uv lock` 与 `uv sync`，并核对 `README`/本文档的说明同步更新。

---

## 后续变更怎么记

新增条目请沿用上面的小节结构，并同步更新文首的「变更索引」表，四要素缺一不可：

**改了什么包 → 为什么改 → 影响范围 → 怎么验证**

只写"同步锁文件"这类结论是不够的：看的人无法据此判断该不该跟着升级、有没有回滚风险。
