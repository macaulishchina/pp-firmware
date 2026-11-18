import { useState } from "react";
import { Button } from "@espressif/dashboard-ui-components";
import { Plug, Unplug } from "lucide-react";
import { useEsp } from "../esp/EspContext";

/** One connection control shared by installation, console and connection settings. */
export function DeviceConnection() {
  const esp = useEsp();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const ready = esp.connected && esp.chipDesc !== "default";

  async function changeConnection() {
    if (working || esp.busy) return;
    setWorking(true);
    setError("");
    try {
      if (esp.connected) await esp.disconnect();
      else {
        const result = await esp.connect();
        if (!result.ok) setError(result.error || "未能连接设备，请检查串口是否被占用。");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  }

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-muted/40 px-4 py-3">
      <div className="min-w-0 space-y-1" aria-live="polite">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className={`h-2 w-2 shrink-0 rounded-full ${ready ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
          {working ? "正在处理连接…" : ready ? "设备已连接" : esp.connected ? "串口已打开" : "尚未连接设备"}
        </p>
        <p className="break-words text-xs text-muted-foreground">
          {ready ? esp.chipDesc : "通过 USB 数据线连接 PP，使用桌面 Chrome 或 Edge 选择串口。"}
        </p>
      </div>
      <Button variant="outline" fullWidth={false} disabled={working || esp.busy} onClick={() => void changeConnection()}>
        {esp.connected ? <Unplug size={16} /> : <Plug size={16} />}
        {esp.connected ? "断开连接" : "连接设备"}
      </Button>
    </div>
    {error && <p role="status" className="text-sm text-muted-foreground">{error}</p>}
  </div>;
}
