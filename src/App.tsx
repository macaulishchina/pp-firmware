import { useEffect, useMemo, useRef, useState } from "react";
import { Button, IconTextActionCard } from "@espressif/dashboard-ui-components";
import { EspProvider, useEsp } from "./esp/EspContext";
import { getWebSerialSupportIssue } from "./lib/serial";
import { Navbar } from "./components/Navbar";
import { WebSerialUnsupported } from "./components/WebSerialUnsupported";

import { QuickStartTab } from "./components/tabs/QuickStartTab";

import { ConsoleTab } from "./components/tabs/ConsoleTab";
import { SettingsTab } from "./components/tabs/SettingsTab";

import { FlashStatusDialog, type AppFlashLinks } from "./components/modals/FlashStatusDialog";
import type { TabId } from "./types";
import { Cpu, Plug } from "lucide-react";

function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div className={active ? "fade-in-down" : "hidden"}>{children}</div>;
}

function getInitialTab(): TabId { return "quickstart"; }

function Launchpad() {
  const [activeTab, setActiveTab] = useState<TabId>(getInitialTab);
  const [flashModalOpen, setFlashModalOpen] = useState(false);
  const [flashLinks, setFlashLinks] = useState<AppFlashLinks>({});
  const { fitTerminal, connected, chipDesc, busy, connect } = useEsp();
  const deviceReady = connected && chipDesc !== "default";
  const wasDeviceReady = useRef(deviceReady);

  // The terminal is rendered in a hidden panel; re-fit it when shown.
  useEffect(() => {
    if (activeTab === "console") requestAnimationFrame(fitTerminal);
  }, [activeTab, fitTerminal]);

  // Redirect only when a new connection successfully identifies the device.
  useEffect(() => {
    if (
      !wasDeviceReady.current &&
      deviceReady &&
      (activeTab === "home" || activeTab === "settings" || activeTab === "about")
    ) {
      setActiveTab("console");
    }
    wasDeviceReady.current = deviceReady;
  }, [activeTab, deviceReady]);

  const goToConsole = () => setActiveTab("console");
  const showFlashStatus = (links: AppFlashLinks) => {
    setFlashLinks(links);
    setFlashModalOpen(true);
  };

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar activeTab={activeTab} onTabChange={setActiveTab} />

      <main className={`flex-1 ${activeTab === "home" ? "" : "container mx-auto w-full max-w-6xl px-4 py-6"}`}>
        {activeTab !== "about" && activeTab !== "home" && !connected && (
          <div className="mb-4 space-y-2">
          <IconTextActionCard 
            icon={<Cpu />} 
            title={"连接 PP"}
            description={"通过数据线将 PP 连接到当前电脑，在 Chrome 或 Edge 中选择 USB JTAG/serial 串口。连接会进入下载模式，不会立即安装固件。"}
            color="secondary" size="lg" variant="solid" 
            actions={<Button disabled={busy} color="secondary" fullWidth={false} variant="default" onClick={() => void connect()}> <Plug className="h-5 w-5" aria-hidden /> 连接设备</Button>} />
          </div>
        )}



        <TabPanel active={activeTab === "quickstart"}>
          <QuickStartTab goToConsole={goToConsole} onFlashStatus={showFlashStatus} />
        </TabPanel>

        <TabPanel active={activeTab === "console"}>
          <ConsoleTab />
        </TabPanel>
        <TabPanel active={activeTab === "settings"}>
          <SettingsTab />
        </TabPanel>

      </main>

      <div className="mt-auto py-3 text-center text-muted-foreground">
      <span className="text-xs">基于开源 ESP Launchpad · 本地固件目录</span>
      </div>

      <FlashStatusDialog
        open={flashModalOpen}
        onOpenChange={setFlashModalOpen}
        links={flashLinks}
      />
    </div>
  );
}

export default function App() {
  const issue = useMemo(() => getWebSerialSupportIssue(), []);
  if (issue) return <WebSerialUnsupported issue={issue} />;
  return (
    <EspProvider>
      <Launchpad />
    </EspProvider>
  );
}
