# caddy ingress: public DNS for the on-instance TLS terminator. Only when
# ingress_mode = "caddy" AND caddy_manage_dns (the domain's public hosted
# zone must already exist in this account). cloudflare mode manages DNS in
# the Cloudflare dashboard instead — nothing is created here.

data "aws_route53_zone" "public" {
  count = var.ingress_mode == "caddy" && var.caddy_manage_dns ? 1 : 0

  name         = var.domain
  private_zone = false
}

resource "aws_route53_record" "memex" {
  count = var.ingress_mode == "caddy" && var.caddy_manage_dns ? 1 : 0

  zone_id = data.aws_route53_zone.public[0].zone_id
  name    = "${var.memex_subdomain}.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.memex.public_ip]
}
