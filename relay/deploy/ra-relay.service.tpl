# ============================================================================
# dsh-remote-access 中继 systemd 单元（由 install.sh 渲染后写入
# /etc/systemd/system/ra-relay.service）
# ============================================================================
[Unit]
Description=dsh-remote-access relay (phone remote access WebSocket bridge)
Documentation=file:///opt/ra-relay/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ra-relay
Group=ra-relay
WorkingDirectory=@RELAY_DIR@
EnvironmentFile=@ENV_FILE@
ExecStart=@NODE@ @RELAY_DIR@/server.mjs

Restart=always
RestartSec=3
TimeoutStopSec=10

StandardOutput=journal
StandardError=journal
SyslogIdentifier=ra-relay

# --- 最小权限硬化 -----------------------------------------------------------
# 中继是无状态转发组件（不落盘、不读用户数据、不做信任判断），所以可以锁得很紧。
# 注意：刻意不启用 MemoryDenyWriteExecute —— 它会打断 V8 的 JIT。
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
# AF_NETLINK/AF_UNIX 保留给 glibc 的名字解析（nss-resolve），删掉可能让 DNS 变慢。
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK

[Install]
WantedBy=multi-user.target
