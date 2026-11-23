# MaxMind GeoLite2 databases for the 5-Layer Nepal Sovereign Geo-Gate

Place the free MaxMind downloads here (the backend mounts this directory
read-only at `/app/geoip`):

| File | Purpose |
| --- | --- |
| `GeoLite2-Country.mmdb` | Country verdict (`GEOIP_COUNTRY_DB`) |
| `GeoLite2-ASN.mmdb` | Hosting/VPN ASN denylist (`GEOIP_ASN_DB`, `GEOIP_BLOCKED_ASNS`) |

The `.mmdb` files are intentionally not committed. Without them:

* `GEO_GATE_MODE=monitor` (default) lets traffic through and reports
  `country_unknown` in `/api/geo/access-check`.
* `GEO_GATE_MODE=enforce` fails closed for every public (non-private) client.

`/api/health` always reports the observed database availability indirectly
through `geo_gate_mode`; `/api/geo/access-check` returns `country_db_available`.
