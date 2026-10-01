# ============================================================================
# dsh-remote-access 中继 —— Caddy 站点片段（独立高端口监听器）
#
# 由 relay/deploy/install.sh 安装到 /etc/caddy/acli.d/sites/ra-relay.caddy。
# 这是 ACLI 的官方扩展点（主 Caddyfile 尾部 import "/etc/caddy/acli.d/sites/*.caddy"），
# 因此本文件不修改主 Caddyfile 的任何一行。
#
# TLS 说明（勿改）：ACLI 给服务器公网 IP（@）签的是 Let's Encrypt 短期 IP 证书，
# 只有 shortlived profile 才为裸 IP 签发；disable_tlsalpn_challenge 是因为
# 挑战走 80 端口的 HTTP-01。本段与 443 站点的 tls 段保持一致，Caddy 会复用同一张证书。
#
# 手动卸载：删除本文件后 systemctl restart caddy。
# ============================================================================
https://@PUBLIC_IP@:@PUBLIC_PORT@ {
	tls {
		issuer acme {
			profile shortlived
			disable_tlsalpn_challenge
		}
	}

	# 中继是实时桥（WebSocket + 流式响应），必须关闭攒包：
	# flush_interval -1 让每个 write 立刻下发。
	# ★ 这是 2026-10-01「手机发消息 499」事故的同类防线，不要改成默认值。
	reverse_proxy 127.0.0.1:@RELAY_PORT@ {
		flush_interval -1
	}
}
