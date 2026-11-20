# PP firmware workspace

- Read site/README.local.md; preserve upstream ESP Launchpad attribution and pinned lockfile.
- Firmware source stays in the PA ai_passport/firmware project. Never create a second agent or compile firmware in this server.
- site/config/pp.toml is the public catalog. site/tools/publish.py owns local publication, checksum validation and immutable versions.
- Update the public release files and matching catalog together. Advance upstream submodule commits explicitly after verification.
- Keep candidates, debug artifacts, device dumps and private TLS material out of public files and Git. Never mount the CA private key into nginx.
- Reuse EspContext/esptool-js for transport. Verify every published part before any write, preserve explicit confirmation, and never replay uncertain writes.
- Browser installation talks to the operator's computer; a server-side USB connection is not required. Never flash real hardware as an automated test.
- Build with npm ci/npm run build from site/. Test affected contracts and browser behavior; synthetic success is not hardware acceptance.
- Only this website's Compose project may be restarted here; PA and other services are independent.
- PP business ingress belongs on PA port 8047. Port 9443 serves the firmware center and PassportSim. Prefer HTTP/WS unless HTTPS/WSS is necessary. Browser USB requires a secure context.
- For PP iteration work, use `site/docs/pp-iteration.md`. Run affected stages with `site/tools/pp_lab.py` and test device UI and button interactions in PassportSim using actual firmware. Keep cases in `site/tools/sim/scenes.json` and evidence private. Verify physical buttons, display, sound and power behavior on hardware.
