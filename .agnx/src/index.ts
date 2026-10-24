// 场景：TabTin Sub App 入口 — 薄壳 + ensure + iframe。
import type { WorkspaceAppHostApi, WorkspaceAppModule } from "@agnx-lab/app-sdk";
import {
  TABTIN_APP_ID,
  TABTIN_ENSURE_TOOL_REL,
  TABTIN_OPEN_COMMAND_ID,
  TABTIN_PANEL_ID,
} from "./constants";
import { bindTabtinHost, TabTinPanel } from "./panel";

export const appId = TABTIN_APP_ID;

function openTab(
  host: WorkspaceAppHostApi,
  context?: {
    serverId?: string;
    workspaceId?: string;
    currentPathname?: string | null;
  },
): void {
  host.openMiniAppTab({
    appId: TABTIN_APP_ID,
    panelId: TABTIN_PANEL_ID,
    serverId: context?.serverId,
    workspaceId: context?.workspaceId,
    currentPathname: context?.currentPathname,
  });
}

export function activate(host: WorkspaceAppHostApi): void {
  bindTabtinHost(host);

  host.registerMiniApp({
    id: TABTIN_PANEL_ID,
    appId: TABTIN_APP_ID,
    title: "TabTin",
    component: TabTinPanel,
    iframeShortcutCapture: true,
    isolation: {
      mode: "iframe",
      sidecarTools: [TABTIN_ENSURE_TOOL_REL],
      note: "Tab iframe 加载 tabtin-web；Django 后端由 ensure sidecar 拉起",
    },
  });

  host.registerCommand({
    id: TABTIN_OPEN_COMMAND_ID,
    appId: TABTIN_APP_ID,
    title: "TabTin",
    keywords: ["tabtin", "agent", "工作台", "多人协同", "ai"],
    sidebarAction: {
      defaultVisible: true,
      label: "TabTin",
      order: 60,
    },
    run: (context) => {
      openTab(host, context);
    },
  });
}

const moduleExport: WorkspaceAppModule = {
  appId: TABTIN_APP_ID,
  activate,
};

export default moduleExport;

export { TABTIN_APP_ID, TABTIN_OPEN_COMMAND_ID, TABTIN_PANEL_ID } from "./constants";
export { TabTinPanel } from "./panel";
