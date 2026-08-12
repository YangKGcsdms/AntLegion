# antlegion.dev — landing page

Single-file landing + `llms.txt`, served by Caddy on the site VPS.

Deploy an update:

```bash
scp deploy/site/index.html deploy/site/llms.txt root@149.28.54.52:/var/www/antlegion/
```

Caddyfile lives at `/etc/caddy/Caddyfile` on the box (apex serves
`/var/www/antlegion`, `www` 301s to apex, TLS auto via Let's Encrypt).
Firewall: 22/80/443 only.
