import { useEsp } from "../esp/EspContext";
import type { TabId } from "../types";
import type { LucideIcon } from "lucide-react";

import { Plug, Unplug, Settings, SquareChevronRight, Timer } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@espressif/dashboard-ui-components";


interface NavItem {
  id: TabId;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  {id: "quickstart", label: "固件目录", icon: Timer},
  {id: "console", label: "串口日志", icon: SquareChevronRight},
  {id: "settings", label: "连接设置", icon: Settings},
];

export function Navbar({
  activeTab,
  onTabChange,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}) {
  const { connected, chipDesc, busy, connect, disconnect } = useEsp();
  const deviceReady = connected && chipDesc !== "default";

  return (
    <nav className="sticky top-0 z-50 flex items-center gap-4 border-b border-border bg-background px-4 py-2">
      <button
        type="button"
        className="flex shrink-0 items-center"
        onClick={() => onTabChange("quickstart")}
        aria-label="PP 固件中心首页"
      >
        <span className="text-lg font-semibold tracking-tight">PP <span className="text-muted-foreground font-normal">固件中心</span></span>
      </button>
      <a href="/pp-setup.html" className="shrink-0 text-sm text-muted-foreground hover:text-foreground">PA 终端配置</a>
      <div className="ml-auto flex w-[70%] items-center">
        <Tabs value={activeTab} className="w-full">
        <TabsList variant="rounded" className="w-full">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id} onClick={() => onTabChange(id)}>
              <Icon className="h-4 w-4" aria-hidden /> {label}
            </TabsTrigger>
          ))}
      {deviceReady ? (
          <TabsTrigger disabled={busy} onClick={() => void disconnect()} value="disconnect">
            <Unplug className="h-4 w-4" aria-hidden />
            断开连接
          </TabsTrigger>
        ) : (
          <TabsTrigger disabled={busy} onClick={() => void connect()} value="connect">
           <Plug className="h-4 w-4" aria-hidden />
            连接设备
          </TabsTrigger>
        )}
        </TabsList>
        </Tabs>
      </div>
      </nav>
  );
}
