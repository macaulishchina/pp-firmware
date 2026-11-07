import { useEsp } from "../esp/EspContext";
import type { TabId } from "../types";
import type { LucideIcon } from "lucide-react";

import { Settings, SlidersHorizontal, SquareChevronRight, Timer } from "lucide-react";
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
  onConfigure,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  onConfigure: () => Promise<void>;
}) {
  const { busy } = useEsp();

  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-background/95 px-4" aria-label="固件中心导航">
      <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3">
      <button
        type="button"
        className="flex shrink-0 items-center"
        onClick={() => onTabChange("quickstart")}
        aria-label="PP 固件中心首页"
      >
        <span className="text-lg font-semibold tracking-tight">PP <span className="text-muted-foreground font-normal">固件中心</span></span>
      </button>
      <div className="ml-auto flex items-center gap-6">
        <Tabs value={activeTab}>
        <TabsList variant="rounded">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id} onClick={() => onTabChange(id)}>
              <Icon className="h-4 w-4" aria-hidden /> {label}
            </TabsTrigger>
          ))}
        </TabsList>
        </Tabs>
        <button type="button" disabled={busy} onClick={() => void onConfigure()} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
          <SlidersHorizontal size={16} aria-hidden /> USB 配置
        </button>
      </div>
      </div>
      </nav>
  );
}
