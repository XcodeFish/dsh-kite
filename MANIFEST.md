# dsh-kite

- 更名说明: 本项目原名 dsh-remote-access，2026-10-01 起更名 dsh-kite 并首发到 GitHub
- 版本号  : 0.1.0
- 打包    : 重新打包请用 `./pack.sh --verify`（自动重生成本清单的 tar 包）

## 本包内容

```
.gitignore
DEPLOY.md
MANIFEST.md
README.md
admin/menu-entry.js
admin/panel-client.js
admin/panel.js
admin/qr.js
approvals/responders.js
cordis.patch.yml
docs/HANDOVER.md
docs/v0.2-zcode-alignment.md
host-adapter.js
identity/device-store.js
identity/keys.js
identity/pairing.js
identity/ticket.js
index.js
pack.sh
package.json
policy/audit.js
policy/methods.js
policy/presets.js
proxy/loopback-credential.js
proxy/reverse-proxy.js
proxy/upgrade.js
proxy/ws-codec.js
relay/deploy/README.md
relay/deploy/build-bundle.sh
relay/deploy/install.sh
relay/deploy/ra-relay.caddy.tpl
relay/deploy/ra-relay.service.tpl
relay/deploy/switch-relay.sh
relay/package-lock.json
relay/package.json
relay/server.mjs
relay/start-local.sh
sync.sh
test/admin-auth.test.mjs
test/audit.test.mjs
test/auth-fallback.verify.mjs
test/browser-sim.verify.mjs
test/config-keys.test.mjs
test/credential.test.mjs
test/device-store.test.mjs
test/e2e.test.mjs
test/frame-drop-observability.test.mjs
test/frames.test.mjs
test/full-chain.e2e.mjs
test/gzip.verify.mjs
test/menu-qr.test.mjs
test/owner-lock.test.mjs
test/pair-flow.verify.mjs
test/pair.e2e.mjs
test/pairing.test.mjs
test/panel.e2e.mjs
test/policy.test.mjs
test/probe-host-api.mjs
test/qr-decode.verify.mjs
test/relay.integration.test.mjs
test/reverse-proxy.test.mjs
test/session-stream.probe.mjs
test/ticket.test.mjs
test/upgrade-backpressure.test.mjs
test/upgrade-fragmentation.test.mjs
test/ws-codec.test.mjs
test/ws-mux.verify.mjs
transport/adapter.js
transport/e2e.js
transport/frames.js
transport/owner-lock.js
transport/relay-client.js
```

## 安装（见 DEPLOY.md §1）

```bash
DSH_HOME="$HOME/.dsh" node \
  '/Applications/DSH NEXT.app/Contents/Resources/app/lib/plugin-cli.js' \
  desktop add "link:<本包解压后的绝对路径>"
# 然后重启 DSH NEXT
```
