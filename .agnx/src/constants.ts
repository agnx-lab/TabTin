// 场景：TabTin Sub App 常量（AppId / 命令 / 面板 / ensure 相对路径 / 端口）。
export const TABTIN_APP_ID = "tabtin";
export const TABTIN_PANEL_ID = "tabtin.main";
export const TABTIN_OPEN_COMMAND_ID = "tabtin.open";

/** 短跑 sidecar：复用或拉起 TabTin（Django 后端 + tabtin-web Vite），对外统一 8107。 */
export const TABTIN_ENSURE_TOOL_REL = ".agnx/tools/ensure-tabtin-web.mjs";

/** 对外入口端口（tabtin-web 前端）。 */
export const DEFAULT_TABTIN_PORT = 8107;
