# PA-Terminal 0.2.7-preview.2

在 PA 配置后台的「AI Passport → 播报传输」选择 24 kHz 或 16 kHz，并单独开启 ADPCM 压缩。设置支持默认值和单台覆盖，从下一次播报生效。默认是 24 kHz PCM。

启用压缩时，PP 缓存压缩块，播放前逐块解码。24 kHz 与 16 kHz 的压缩音频载荷分别约为 12.3 KB/s 和 8.2 KB/s。播报传输设置需要配套 PA 更新。

## 安装与验证

用 USB 数据线连接 PP，在桌面 Chrome 或 Edge 的固件中心选择「PA-Terminal · 0.2.7-preview.2」。安装器先核对分区布局，兼容时保留 Wi-Fi、配对和历史记录。

通过协议、主机音频、ESP-IDF 构建及合成语音集成检查。真机弱网表现、音质和内存占用待验收。
