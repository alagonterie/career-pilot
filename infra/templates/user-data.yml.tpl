#cloud-config

write_files:
  - path: /etc/systemd/system/cloudflared.service
    permissions: 0644
    owner: root
    content: |
      [Unit]
      Description=Cloudflare Tunnel
      After=network.target

      [Service]
      TimeoutStartSec=0
      Restart=always
      ExecStartPre=-/usr/bin/docker exec %n stop
      ExecStartPre=-/usr/bin/docker rm %n
      ExecStartPre=/usr/bin/docker pull cloudflare/cloudflared:latest
      ExecStart=/usr/bin/docker run --rm --name %n cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${cloudflare_tunnel_token}

      [Install]
      WantedBy=multi-user.target

runcmd:
  - systemctl daemon-reload
  - systemctl enable cloudflared.service
  - systemctl start cloudflared.service
  - mkdir -p /var/lib/google
  - curl -L "https://github.com/docker/compose/releases/download/v2.24.5/docker-compose-linux-x86_64" -o /var/lib/google/docker-compose
  - chmod +x /var/lib/google/docker-compose
