import sys
import threading
import time

import requests
from astronverse.scheduler import ComponentType
from astronverse.scheduler.config import Config
from astronverse.scheduler.core.executor.executor import ExecutorManager
from astronverse.scheduler.core.picker.picker import Picker
from astronverse.scheduler.core.servers.normal_server import TriggerServer, VNCServer
from astronverse.scheduler.logger import logger
from astronverse.scheduler.utils.utils import (
    PortStatus,
    check_port,
    classify_port,
    describe_port_advice,
    describe_port_status,
)


class Svc:
    def __init__(self):
        """程序上下文管理类"""
        # 0. 服务对应端口
        self.port_lock = threading.Lock()
        self.port_dict: dict = {}

        # 1. 配置

        # 运行配置 静态
        self.config: Config = None

        # 端口号:
        self.__local_port__: int = 13158
        # 路由端口[随机分配]
        self.rpa_route_port: int = self.get_validate_port(ComponentType.ROUTE)
        # 调度器端口[随机分配]
        self.scheduler_port: int = self.get_validate_port(ComponentType.SCHEDULER)
        # trigger端口[随机分配]
        self.trigger_port: int = self.get_validate_port(ComponentType.TRIGGER)
        # 浏览器通信端口[固定分配]
        self.connector_port: int = 9082
        self.port_dict[ComponentType.BROWSER_CONNECTOR.name.lower()] = self.connector_port
        # 拾取框[固定分配]
        self.rpa_hl_port: int = 11001
        # 虚拟桌面
        self.win_virtual_port: int = self.get_validate_port()

        # 2. 核心服务

        # 本地路由是否启动标识
        self.route_server_is_start = False
        # 执行器
        self.executor_mg = ExecutorManager(self)
        # pick
        self.picker = Picker(self)
        # 触发器
        self.trigger_server = TriggerServer(self)
        # nav服务
        if sys.platform == "win32":
            self.vnc_server = VNCServer(self)
        else:
            self.vnc_server = None

        # 3. 核心模式

        # 是否是终端模式
        self.terminal_mod = False
        self.start_watch = False
        self.terminal_task_stop = False

        # 是否是在虚拟环境中运行[虚拟环境中运行，执行器不会创建虚拟环境]
        self.is_venv = False

        # 4. 全局状态
        self.pip_download_ing = False

    def set_config(self, config):
        self.config = config
        self.is_venv = True if "venv" in self.config.python_base else False
        self.picker.init()

    def get_validate_port(self, component_type: ComponentType = None) -> int:
        """
        获取一个本地可用的端口
        """
        with self.port_lock:
            while True:
                self.__local_port__ += 1
                # 长时间运行的端口资源问题
                if self.__local_port__ >= 65500:
                    self.__local_port__ = 13158
                if check_port(self.__local_port__):
                    if component_type is not None:
                        self.port_dict[component_type.name.lower()] = self.__local_port__
                    return self.__local_port__

    def collect_bound_ports(self) -> list:
        """
        收集启动阶段需要占用的端口清单

        返回：[(用途, 端口)]
        """
        ports = [
            ("本地路由(网关)", self.rpa_route_port),
            ("调度服务", self.scheduler_port),
            ("触发器服务", self.trigger_port),
            ("浏览器通信桥", self.connector_port),
            ("元素拾取高亮", self.rpa_hl_port),
            ("虚拟桌面", self.win_virtual_port),
        ]
        if self.vnc_server:
            ports.append(("虚拟桌面VNC", self.vnc_server.vnc_port))
            ports.append(("虚拟桌面VNC-WS", self.vnc_server.vnc_ws_port))
        return ports

    def precheck_ports(self) -> list:
        """
        启动前端口预检

        端口是硬性依赖，不可用时不做动态规避，交由上层提示用户处理。
        返回不可用端口清单：[(用途, 端口, PortStatus)]，为空表示全部可用。
        """
        bad_ports = []
        for name, port in self.collect_bound_ports():
            status = classify_port(port)
            if status != PortStatus.FREE:
                bad_ports.append((name, port, status))
        return bad_ports

    def precheck_ports_message(self) -> str:
        """
        启动前端口预检，返回面向用户的失败说明

        按不可用原因分组，避免同一段建议在多个端口上重复堆叠。
        全部可用时返回空字符串。
        """
        bad_ports = self.precheck_ports()
        if not bad_ports:
            return ""

        grouped: dict = {}
        for name, port, status in bad_ports:
            grouped.setdefault(status, []).append("{} {}".format(port, name))

        lines = ["启动失败：客户端所需端口不可用，无法正常启动。"]
        for status, items in grouped.items():
            lines.append(
                "· {}（{}）：{}".format(describe_port_status(status), "、".join(items), describe_port_advice(status))
            )
        return "\n".join(lines)

    def register_server(self):
        def register_component(component, port: int):
            try:
                url = "http://127.0.0.1:{}/rpa-local-route/registry".format(self.rpa_route_port)
                data = {"module_name": component, "port": str(port)}
                response = requests.post(
                    url=url,
                    json=data,
                )
                logger.info("register_component: {} => {}".format(data, response.text))
                if "OK" in response.text:
                    pass
                else:
                    raise Exception("route register error : {} {} => {}".format(component, port, response.text))
            except Exception as e:
                logger.exception("register_component error: {}".format(e))

        if len(self.port_dict) == 0:
            return

        if not self.route_server_is_start:
            return

        # 等待本地路由加载完成
        while check_port(port=self.rpa_route_port):
            time.sleep(0.1)
        for k, v in self.port_dict.items():
            register_component(k, v)


_svc = Svc()


def get_svc() -> Svc:
    """
    获取全局svc
    """
    return _svc
