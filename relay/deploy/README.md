# 中继部署包

把手机远端的公网中继从「cloudflared 免费隧道」迁到一台自有 VPS。

## 为什么是这个形状

| 决策 | 原因 |
|---|---|
| **独立端口 8443**，不用 443 路径前缀 | DSH 前端有大量根锚定请求（`/api/...`、客户端模块合并请求）。挂路径前缀时这些请求会**逃出前缀**打到主站 → 白屏。独立端口 = 干净的 origin，PWA 与 Service Worker scope 都正常。 |
| **写 `/etc/caddy/acli.d/sites/`**，不碰主 Caddyfile | 这台机器的 Caddy 由 ACLI 托管，主 Caddyfile 尾部已有 `import "/etc/caddy/acli.d/sites/*.caddy"`，注释写明「Owners requiring an independent high-port listener contribute full sites」。**这是 ACLI 官方留给我们的扩展点**，所以主配置一个字都不用改，也不会被 ACLI 重写时覆盖。 |
| **TLS 交给 Caddy，中继只听 127.0.0.1** | 证书是 Let's Encrypt 给裸 IP 签的短期证书（`shortlived` profile，7 天自动续）。站点片段的 `tls` 段与 443 站点保持一致，Caddy 复用同一张证书，续期自动。中继本身不碰证书、不暴露端口。 |
| **`ws` 依赖一起打包** | `ws` 零运行时依赖、196K。打包进去后服务器侧**不需要 npm install**，绕开境内机器访问 npm registry 这个常见翻车点。 |
| **`flush_interval -1`** | 中继是实时桥（WebSocket + 流式响应）。这行关掉 Caddy 的攒包，与 `be5dadf`（流式响应被缓冲导致 499）是同一类防线。 |

## 部署（三步）

```bash
# 1) Mac：打包（自带依赖）
cd ~/.dsh/plugin-src/dsh-kite/relay/deploy
./build-bundle.sh

# 2) 上传并安装（服务器上以 root 跑，幂等、失败自动回滚）
#    ★ PUBLIC_IP 必填：它写进 Caddy 站点片段，并作为 IP 证书的校验目标。
#      脚本刻意不设默认值 —— 部署环境信息不该硬编码进仓库，缺省时直接报错并给出用法。
scp dist/ra-relay.tar.gz user@<VPS_IP>:/tmp/
ssh user@<VPS_IP> 'tar xzf /tmp/ra-relay.tar.gz -C /tmp && sudo PUBLIC_IP=<VPS_IP> /tmp/ra-relay/install.sh'

# 3) Mac：把插件指向新中继（用第 2 步输出的令牌）
./switch-relay.sh --url wss://<VPS_IP>:8443 \
                  --public https://<VPS_IP>:8443 \
                  --token <第 2 步输出的令牌>
```

然后**重启 DSH NEXT**（重启会中断当前对话会话，正常）。

## 唯一的控制台动作

云厂商控制台 → 这台实例的**防火墙 / 安全组** → 放行 **TCP 8443**。

云防火墙在控制台侧，服务器内部查不到、脚本也改不了。

**未放行时的表现是「丢包」而不是「拒绝」**（实测：对未放行端口做 TCP 连接，75 秒后超时；如果是放行但没服务，会立刻收到 RST 秒失败）。这个区别很有用——**超时 = 云防火墙，秒拒 = 服务没起来**。

另：云厂商的公网 IP 是 NAT 的、不在网卡上，所以在机器上 `curl https://<VPS_IP>:8443` **会真的出网卡、真的撞云防火墙**——它测的不是本机链路。`install.sh` 因此改用 `curl --connect-to <VPS_IP>:8443:127.0.0.1:8443` 强制走回环来验证 Caddy 与证书，把外部可达性降级为**提示**而非成败判据。放行后从外网再验一次：

```bash
# 在 Mac 上
curl -sS -o /dev/null -w '%{http_code}\n' https://<VPS_IP>:8443/healthz   # 期望 200
```

## 验证清单

```bash
# 服务器上
systemctl status ra-relay                    # active (running)
curl -sS http://127.0.0.1:8787/healthz       # 中继本体
# 经 Caddy，强制走回环（不依赖云防火墙是否放行）：
curl -sS --connect-to <VPS_IP>:8443:127.0.0.1:8443 https://<VPS_IP>:8443/healthz
journalctl -u ra-relay -n 50                 # 中继日志
journalctl -u caddy -n 50                    # Caddy 日志（看证书是否复用成功）

# Mac 上
./switch-relay.sh 之后重启 DSH → 面板「手机远程」应显示中继已连接
```

## 回滚

```bash
# 服务器上：完整卸载（移除片段 + 停用中继 + 删 /opt/ra-relay）
sudo /tmp/ra-relay/install.sh --uninstall

# Mac 上：切回本机自测中继
cd ~/.dsh/plugin-src/dsh-kite/relay/deploy
./switch-relay.sh --url ws://127.0.0.1:8787 --token "$(cat ../.local-token)"
```

配置文件每次改写前都会备份到 `cordis.patch.yml.bak.<时间戳>`。

## 已知风险

| 风险 | 处置 |
|---|---|
| Caddy 在 :8443 上**不复用**现有 IP 证书，而去新申请 | 站点片段的 `tls` 段与 443 站点逐字一致，按 Caddy 的证书复用规则应当复用。若仍失败，`install.sh` 的**回环**自检会失败并**自动回滚**（移除片段 + 停用中继），主 Caddyfile 从未被改。 |
| `systemctl restart caddy` 有约 1 秒中断 | 主 Caddyfile 里是 `admin off`，`caddy reload` 走不通（它要连 admin API），只能 restart。ACLI 上其他 owner 的站点会短暂不可用。 |
| 8443 未在云防火墙放行 | 安装**不会失败**，只在结尾提示。表现为：服务器端回环验证正常，外部连接 75 秒超时（丢包）。放行即可，不需要重装。 |
| 中继重启后手机需重连 | 设备票据 12h，过期凭 IndexedDB 私钥免扫码重连；不会丢配对。 |

## 变更记录

- **2026-10-02** 修文档：第 2 步的安装命令漏了 `PUBLIC_IP`，照抄会直接被脚本挡下（`缺少 PUBLIC_IP 环境变量`）。守卫本身是对的（环境信息不入库），漏的是文档没把变量带上。
- **2026-10-01** 修 `install.sh` 第 6 步的误判：原实现用 `curl https://<公网IP>:8443` 自检，而云厂商公网 IP 是 NAT 的、不在网卡上，该请求会真的出网卡撞云防火墙 → 超时 → 把一次成功的安装判为失败并回滚（真机事故）。现改为 `--connect-to` 强制回环验证链路，外部可达性降级为提示。

## 文件清单

| 文件 | 位置 | 作用 |
|---|---|---|
| `build-bundle.sh` | Mac | 打包（含 `ws` 依赖） |
| `ra-relay.service.tpl` | → `/etc/systemd/system/ra-relay.service` | systemd 单元（最小权限硬化） |
| `ra-relay.caddy.tpl` | → `/etc/caddy/acli.d/sites/ra-relay.caddy` | Caddy 站点片段 |
| `install.sh` | 服务器 | 安装 / 更新 / 卸载，带预检与自动回滚 |
| `switch-relay.sh` | Mac | 改写插件配置并备份 |
| `/etc/ra-relay/env` | 服务器 | 令牌与端口（0600） |
