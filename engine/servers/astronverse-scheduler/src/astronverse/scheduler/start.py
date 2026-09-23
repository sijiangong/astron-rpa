import argparse
import sys
import time
import traceback
from pathlib import Path
import uvicorn
from astronverse.scheduler.logger import logger
from astronverse.baseline.config.config import load_config
from astronverse.scheduler.apis import route
from astronverse.scheduler.config import Config
from astronverse.scheduler.core.schduler.init import linux_env_check, win_env_check
from astronverse.scheduler.core.server import ServerManager
from astronverse.scheduler.core.servers.async_server import (
    CheckPickProcessAliveServer,
    CheckStartPidExitsServer,
    RpaSchedulerAsyncServer,
    TerminalAsyncServer,
)
from astronverse.scheduler.core.servers.core_server import (
    RpaBrowserConnectorServer,
    RpaRouteServer,
)
from astronverse.scheduler.core.setup.setup import Process
from astronverse.scheduler.core.svc import get_svc
from astronverse.scheduler.utils.utils import EmitType, check_port, emit_to_front
from fastapi import FastAPI

# 0. app实例化，并做初始化
app = FastAPI()
route.handler(app)

# 端口预检失败时的进程退出码（客户端据此弹出启动失败提示）
PORT_PRECHECK_FAILED_EXIT_CODE = 4


def start(args):
    try:
        # 2. 读取配置，并解析到上下文
        conf_path = Path(args.conf.strip('"').replace("\\\\", "\\")).resolve()
        conf_data = load_config(conf_path)

        Config.conf_file = conf_path
        Config.remote_addr = conf_data.get("remote_addr")
        svc = get_svc()
        svc.set_config(Config)

        # 3. 环境检测
        Process.kill_all_zombie()
        win_env_check(svc)
        linux_env_check()

        # 3.5 端口预检
        # 端口被占用或被系统保留时直接退出：否则子进程会反复重启、界面会一直停在启动页且无任何提示
        precheck_message = svc.precheck_ports_message()
        if precheck_message:
            logger.error("port precheck failed: {}".format(precheck_message))
            emit_to_front(EmitType.ALERT, msg={"msg": precheck_message, "type": "error"})
            sys.exit(PORT_PRECHECK_FAILED_EXIT_CODE)

        # 4. 服务注册与启动
        server_mg = ServerManager(svc)
        server_mg.register(RpaRouteServer(svc))
        server_mg.register(RpaBrowserConnectorServer(svc))
        server_mg.register(RpaSchedulerAsyncServer(svc))
        server_mg.register(TerminalAsyncServer(svc))
        server_mg.register(CheckPickProcessAliveServer(svc))
        server_mg.register(CheckStartPidExitsServer(svc))
        server_mg.register(svc.trigger_server)
        if svc.vnc_server:
            server_mg.register(svc.vnc_server)
        server_mg.run()

        # 5. 等待本地网关加载完成，并注册服务
        while check_port(port=svc.rpa_route_port):  # 等待本地路由加载完成
            time.sleep(0.1)
        svc.route_server_is_start = True
        svc.register_server()

        # 6. 向前端发送完成初始化完成消息, 写到了 startup 方法里面

        # 7. 启动服务
        uvicorn.run(
            app="astronverse.scheduler.start:app",
            host="0.0.0.0",
            port=svc.scheduler_port,
            workers=1,
        )
    except Exception as e:
        logger.error("astronverse.scheduler error: {} traceback: {}".format(e, traceback.format_exc()))
