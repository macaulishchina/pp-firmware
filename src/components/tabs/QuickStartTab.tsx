import { useEffect, useRef, useState } from "react";
import {
  Alert, Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@espressif/dashboard-ui-components";
import { Download, FileCheck2, Usb, ShieldCheck } from "lucide-react";
import { useEsp } from "../../esp/EspContext";
import { getApp, loadLaunchpadConfig, type LaunchpadConfig } from "../../lib/tomlConfig";
import { resolvePublishedParts } from "../../lib/publishedFirmware";
import type { AppFlashLinks } from "../modals/FlashStatusDialog";

export function QuickStartTab({goToConsole, onFlashStatus}: {
  goToConsole: () => void;
  onFlashStatus: (links: AppFlashLinks) => void;
}) {
  const esp = useEsp();
  const [config, setConfig] = useState<LaunchpadConfig | null>(null);
  const [selected, setSelected] = useState("");
  const [loadError, setLoadError] = useState("");
  const [flashError, setFlashError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const app = config && selected ? getApp(config, selected) : undefined;
  const matchedChip = app?.chipsets.find(chip => chip.replace(/-/g, "").toLowerCase() === esp.chipName.replace(/-/g, "").toLowerCase());
  useEffect(() => {
    let stopped = false;
    loadLaunchpadConfig().then(result => {
      if (stopped) return;
      setConfig(result.config);
      setSelected(result.config.supported_apps?.[0] ?? "");
    }).catch(error => { if (!stopped) setLoadError(String(error.message ?? error)); });
    return () => { stopped = true; };
  }, []);
  useEffect(() => { esp.setConsoleBaudrateOverride(app?.console_baudrate); }, [app, esp.setConsoleBaudrateOverride]);

  async function install() {
    if (!app || !matchedChip || !esp.connected || submitting.current) return;
    submitting.current = true;
    setPending(true); setConfirm(false); setFlashError("");
    let written = false;
    try {
      const image = app.image[matchedChip.toLowerCase()];
      const parts = resolvePublishedParts(image);
      const result = await esp.downloadAndFlashParts(parts, {eraseAll: false});
      if (!result.ok) throw new Error(result.error || "安装未完成，请查看串口日志。");
      written = true;
      goToConsole();
      await esp.resetDevice();
      onFlashStatus({});
    } catch (error) {
      setFlashError(`${written ? "镜像已经写入并校验，但重启未完成。请在串口日志页重启设备，无需重新刷写。 " : ""}${error instanceof Error ? error.message : String(error)}`);
    } finally {
      submitting.current = false; setPending(false);
    }
  }

  if (loadError) return <Alert type="error" title="固件目录加载失败">{loadError}。请刷新页面重试。</Alert>;
  if (!app || !config) return <p className="text-muted-foreground">正在读取固件目录…</p>;
  const files = app.image[app.chipsets[0]?.toLowerCase()];
  return <div className="space-y-6">
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">固件目录</h1>
      <p className="text-sm text-muted-foreground">选择版本，查看说明，然后通过当前电脑的 USB 为 PP 安装固件。</p>
    </header>
    <section className="rounded-xl border border-border bg-card p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <label htmlFor="firmware-select" className="text-xs font-medium text-muted-foreground">已发布固件</label>
          <Select value={selected} onValueChange={name => {setSelected(name); setFlashError("");}} disabled={pending || esp.busy}>
            <SelectTrigger id="firmware-select" className="min-w-[280px]" aria-label="选择固件"><SelectValue /></SelectTrigger>
            <SelectContent>{config.supported_apps.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <span className="rounded-full bg-amber-500/10 px-3 py-1 text-xs text-amber-700">{app.acceptance === "verified" ? "真机已验收" : "已发布 · 真机待验收"}</span>
      </div>
      <p className="text-sm leading-7">{app.description}</p>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-5 text-sm">
        <div><dt className="text-xs text-muted-foreground mb-1">版本</dt><dd>{app.version}</dd></div>
        <div><dt className="text-xs text-muted-foreground mb-1">目标设备</dt><dd>{app.board}</dd></div>
        <div><dt className="text-xs text-muted-foreground mb-1">芯片</dt><dd>{app.chipsets.join(" / ")}</dd></div>
        <div><dt className="text-xs text-muted-foreground mb-1">镜像</dt><dd>{files?.parts?.length ?? 0} 个 · SHA256 校验</dd></div>
      </dl>
      <div className="flex flex-wrap gap-3 border-t border-border pt-5">
        {app.download && <a className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm hover:bg-muted" href={app.download} download><Download size={16}/>下载刷写包</a>}
        {app.readme?.text && <a className="inline-flex items-center gap-2 px-3 py-2 text-sm underline underline-offset-4" href={app.readme.text} target="_blank" rel="noreferrer">操作说明</a>}
        {app.manifest && <a className="inline-flex items-center gap-2 px-3 py-2 text-sm underline underline-offset-4" href={app.manifest} target="_blank" rel="noreferrer"><FileCheck2 size={16}/>镜像清单</a>}
      </div>
    </section>
    <section className="rounded-xl border border-border p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <h2 className="font-semibold">USB 安装</h2>
          <p className="text-sm text-muted-foreground">{esp.connected ? `已连接：${esp.chipDesc}` : "请先连接设备。选择串口前不会下载或写入固件。"}</p>
        </div>
        <Button color="secondary" disabled={!esp.connected || !matchedChip || esp.busy || pending} onClick={() => setConfirm(true)}><Usb size={16}/>{pending ? "正在校验与安装…" : "安装到 PP"}</Button>
      </div>
      {esp.connected && !matchedChip && <Alert type="error" title="芯片不兼容">当前设备与所选固件不匹配，不会写入。</Alert>}
      <div className="text-xs leading-6 text-muted-foreground flex gap-2"><ShieldCheck size={16} className="shrink-0 mt-1"/><p>安装会替换设备当前固件。按清单分段写入，不执行整片擦除；写入区域仍会被覆盖。当前版本尚未完成真机验收。</p></div>
      {flashError && <Alert type="error" title="安装需要处理">{flashError} 系统不会自动重新刷写。</Alert>}
    </section>
    <p className="text-xs text-muted-foreground">首次使用局域网 HTTPS：<a className="underline underline-offset-4" href="/certs/pp-firmware-ca.crt" download>下载本地 CA 证书</a>，仅在你自己的电脑上确认并信任。构建、发布与证书说明见管理员部署文档。</p>
    <Dialog open={confirm} onOpenChange={setConfirm}>
      <DialogContent>
        <DialogHeader><DialogTitle>确认安装 {selected}</DialogTitle></DialogHeader>
        <p className="text-sm leading-7">目标：{app.board}，当前芯片：{esp.chipDesc}。即将替换运行固件；此版本真机待验收。确认设备及版本后再继续，安装期间不要断电或拔线。</p>
        <DialogFooter><Button variant="outline" onClick={() => setConfirm(false)}>取消</Button><Button onClick={() => void install()} disabled={pending || !matchedChip}>确认并安装</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
