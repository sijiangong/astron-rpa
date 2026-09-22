# 使用官方Python镜像作为基础镜像
FROM python:3.13-slim

# 设置工作目录
WORKDIR /app

# 设置环境变量
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# 构建参数：默认值与上游一致（官方源），国内构建可用 --build-arg / compose build.args 覆盖
ARG APT_MIRROR=deb.debian.org
ARG PIP_INDEX_URL=https://pypi.org/simple

# 安装系统依赖（APT_MIRROR 指向国内镜像可显著加速；兼容 deb822 与老式 sources.list）
RUN set -eux; \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        if [ -f "$f" ]; then sed -i "s|deb.debian.org|${APT_MIRROR}|g" "$f"; fi; \
    done; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# 升级pip
RUN pip install --upgrade pip -i "${PIP_INDEX_URL}"

# 复制项目依赖文件
COPY backend/ai-service/pyproject.toml backend/ai-service/uv.lock ./

# 安装项目依赖（同样走 ARG 指定的索引）
RUN pip install --no-cache-dir -i "${PIP_INDEX_URL}" -e .

# 复制项目代码
COPY backend/ai-service/app/ ./app/

# 复制配置文件（如果存在）
# COPY docker/.env ./.env

# 暴露端口
EXPOSE 8010


# 启动应用
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010", "--proxy-headers", "--workers", "4"]