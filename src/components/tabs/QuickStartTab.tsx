import { useEffect, useRef, useState } from "react";
import {
  Alert, Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@espressif/dashboard-ui-components";
import { Download, FileCheck2, Usb, ShieldCheck, ArrowRight, SlidersHorizontal, Check } from "lucide-react";
import { useEsp } from "../../esp/EspContext";
import { getApp, loadLaunchpadConfig, type LaunchpadConfig } from "../../lib/tomlConfig";
import { resolvePublishedParts } from "../../lib/publishedFirmware";
import type { AppFlashLinks } from "../modals/FlashStatusDialog";
import { DeviceConnection } from "../DeviceConnection";

export function QuickStartTab({goToConsole, onFlashStatus, onConfigure}: {
  goToConsole: () => void;
  onFlashStatus: (links: AppFlashLinks) => void;
  onConfigure: () => Promise<void>;
}) {
  const esp = useEsp();
  const [config, setConfig] = useState<LaunchpadConfig | null>(null);
  const [selected, setSelected] = useState("");
  const [loadError, setLoadError] = useState("");
  const [flashError, setFlashError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [installed, setInstalled] = useState("");
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
      setInstalled(selected);
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
  return <div className="space-y-5">
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">固件目录</h1>
      <p className="text-sm text-muted-foreground">选择固件，连接设备安装，再完成终端配置。</p>
    </header>
    <section className="rounded-xl border border-border bg-card p-6 space-y-5">
      <h2 className="flex items-center gap-3 text-sm font-semibold"><span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">1</span>选择固件</h2>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <label htmlFor="firmware-select" className="text-xs font-medium text-muted-foreground">已发布固件</label>
          <Select value={selected} onValueChange={name => {setSelected(name); setFlashError("");}} disabled={pending || esp.busy}>
            <SelectTrigger id="firmware-select" className="w-[320px] max-w-full" aria-label="选择固件"><SelectValue /></SelectTrigger>
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
    <section className="rounded-xl border border-border bg-card p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="flex items-center gap-3 text-sm font-semibold"><span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">2</span>USB 安装</h2>
        <button type="button" className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" onClick={goToConsole}>查看串口日志</button>
      </div>
      <DeviceConnection />
      {esp.connected && esp.chipName !== "default" && !matchedChip && <Alert type="error" title="芯片不兼容">当前设备与所选固件不匹配，不会写入。</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div className="flex max-w-xl items-start gap-2 text-xs leading-6 text-muted-foreground"><ShieldCheck size={16} className="mt-1 shrink-0"/><p>连接只用于识别设备；确认安装后才校验并写入固件，保留 NVS 配置。</p></div>
        <Button color="secondary" fullWidth={false} disabled={!esp.connected || !matchedChip || esp.busy || pending} onClick={() => setConfirm(true)}><Usb size={16}/>{pending ? "正在校验与安装…" : "安装到 PP"}</Button>
      </div>
      {installed === selected && <p role="status" className="flex items-center gap-2 text-sm text-emerald-700"><Check size={16} />镜像已写入并校验。请核对 PP 屏幕，再按需要完成下方配置。</p>}
      {flashError && <Alert type="error" title="安装需要处理">{flashError} 系统不会自动重新刷写。</Alert>}
    </section>
    <section className="rounded-xl border border-border bg-card p-6 space-y-5">
      <h2 className="flex items-center gap-3 text-sm font-semibold"><span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">3</span>配置与使用</h2>
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div className="max-w-xl space-y-2">
          <p className="text-sm">安装 PA-Terminal 后，通过 USB 写入 Wi-Fi、PA 配对文件和 CA 证书。</p>
          <p className="text-xs leading-6 text-muted-foreground">配对文件在 PA 配置后台生成，有效期 10 分钟。进入配置页时会先断开当前串口。PPDemo 系列可在设备上直接使用。</p>
        </div>
        <Button variant="outline" fullWidth={false} disabled={esp.busy || pending} onClick={() => void onConfigure()}><SlidersHorizontal size={16}/>打开 USB 配置<ArrowRight size={16}/></Button>
      </div>
      <p className="border-t border-border pt-4 text-xs leading-6 text-muted-foreground">首次使用或配置设备时，可<a className="ml-1 underline underline-offset-4" href="/certs/pp-firmware-ca.crt" download>下载 CA 证书</a>；仅在自己的电脑上确认并信任。</p>
    </section>
    <Dialog open={confirm} onOpenChange={setConfirm}>
      <DialogContent>
        <DialogHeader><DialogTitle>确认安装 {selected}</DialogTitle></DialogHeader>
        <p className="text-sm leading-7">目标：{app.board}，当前芯片：{esp.chipDesc}。即将替换运行固件；此版本真机待验收。确认设备及版本后再继续，安装期间不要断电或拔线。</p>
        <DialogFooter><Button variant="outline" onClick={() => setConfirm(false)}>取消</Button><Button onClick={() => void install()} disabled={pending || !matchedChip}>确认并安装</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
