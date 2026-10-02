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
Environment=OWNER_STATE_DIR=/var/lib/ra-relay
StateDirectory=ra-relay
ExecStart=@NODE@ @RELAY_DIR@/server.mjs

Restart=always
RestartSec=3
TimeoutStopSec=10

# --- 资源上限（2026-10-02 审查）---------------------------------------------
# ★ 中继是单进程 Node：连接器跑在【用户自己的机器】上，但中继侧要为每条挂起的
#   请求/桥保留缓冲（MAX_PHONE_BUFFER_BYTES 8 MiB/桥、MAX_BODY_BYTES 8 MiB/请求），
#   所以「内存放大」的账单最终打在用户机器上（同一条隧道两端一起涨）。
#   给中继一个硬上限：最坏情况它只死自己（Restart=always 会拉起），
#   而不是把同机其他服务一起拖进 OOM。512M 对单进程转发足够（常态几十 MB）。
#   TasksMax 一并收口：Node 线程 + libuv 线程池正常在两位数以内，256 是宽裕的上限，
#   防止异常路径下线程/任务数失控。
MemoryMax=512M
TasksMax=256

StandardOutput=journal
StandardError=journal
SyslogIdentifier=ra-relay

# --- 最小权限硬化 -----------------------------------------------------------
# 中继是轻状态转发组件：唯一落盘是 owners.json（Pair-Proof 设备归属表），
# 通过 StateDirectory=ra-relay 拿到 /var/lib/ra-relay 的专用写权限 —— 不开
# ReadWritePaths 大门，不让它接触任何用户数据。不做信任判断之外的安全职责。
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
