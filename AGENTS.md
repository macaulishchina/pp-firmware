# PP firmware website

- Read README.local.md; preserve upstream ESP Launchpad attribution and pinned lockfile.
- Firmware source stays in the PA ai_passport/firmware project. Never create a second agent or compile firmware in this server.
- config/pp.toml is the single public directory. tools/publish.py owns local publication, checksum validation and immutable versions.
- Keep candidates, debug artifacts, device dumps and private TLS material out of public files and Git. Never mount the CA private key into nginx.
- Reuse EspContext/esptool-js for transport. Verify every published part before any write, preserve explicit confirmation, and never replay uncertain writes.
- Browser installation talks to the operator's computer; a server-side USB connection is not required. Never flash real hardware as an automated test.
- Build with npm ci/npm run build. Test affected contracts and browser behavior; synthetic success is not hardware acceptance.
- Only this website's Compose project may be restarted here; PA and other services are independent.
- PP interaction studies share `public/pp-demo/core/` and its state model. Add declarative scenes in `scenarios.js`; do not copy a new device shell for each feature. See `docs/pp-demo-framework.md`.
- The PP study targets PC mouse/keyboard only. Keep it entirely simulated: no microphone, serial, PA requests or paid inference.
- Demo previews are intentionally fast: edit `public/pp-demo/` directly and refresh. Compose mounts this source directory read-only and nginx disables caching. Do not build, copy to dist, run acceptance suites or redeploy for routine demo UI changes unless the user explicitly asks. Existing tests are available for a later stabilization pass.
- PP business ingress belongs on PA port 8047. Port 9443 is for the firmware website, not future business forwarding. Prefer HTTP/WS unless HTTPS/WSS is specifically necessary (browser USB remains a secure-context requirement); do not change live ingress as part of a demo UI task.
