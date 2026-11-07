import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@espressif/dashboard-ui-components";
import { EspProvider, useEsp } from "./esp/EspContext";
import { getWebSerialSupportIssue } from "./lib/serial";
import { Navbar } from "./components/Navbar";
import { WebSerialUnsupported } from "./components/WebSerialUnsupported";

import { QuickStartTab } from "./components/tabs/QuickStartTab";

import { ConsoleTab } from "./components/tabs/ConsoleTab";
import { SettingsTab } from "./components/tabs/SettingsTab";

import { FlashStatusDialog, type AppFlashLinks } from "./components/modals/FlashStatusDialog";
import type { TabId } from "./types";
import { DeviceConnection } from "./components/DeviceConnection";

function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div className={active ? "fade-in-down" : "hidden"}>{children}</div>;
}

function getInitialTab(): TabId { return "quickstart"; }

function Launchpad() {
  const [activeTab, setActiveTab] = useState<TabId>(getInitialTab);
  const [flashModalOpen, setFlashModalOpen] = useState(false);
  const [flashLinks, setFlashLinks] = useState<AppFlashLinks>({});
  const { fitTerminal, connected, chipDesc, busy, disconnect } = useEsp();
  const [setupError, setSetupError] = useState("");
  const changingPage = useRef(false);
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

  async function openConfiguration() {
    if (busy || changingPage.current) return;
    changingPage.current = true;
    setSetupError("");
    try {
      await disconnect();
      window.location.assign("/pp-setup.html");
    } catch (error) {
      setSetupError(`无法释放串口：${error instanceof Error ? error.message : String(error)}`);
      changingPage.current = false;
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar activeTab={activeTab} onTabChange={setActiveTab} onConfigure={openConfiguration} />

      <main className={`flex-1 ${activeTab === "home" ? "" : "container mx-auto w-full max-w-6xl px-4 py-6"}`}>
        {setupError && <div className="mb-5"><Alert type="error" title="USB 配置暂未打开">{setupError}</Alert></div>}
        {activeTab !== "quickstart" && <div className="mb-6"><DeviceConnection /></div>}
        <TabPanel active={activeTab === "quickstart"}>
          <QuickStartTab goToConsole={goToConsole} onFlashStatus={showFlashStatus} onConfigure={openConfiguration} />
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
