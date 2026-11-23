"""5-Layer Nepal Sovereign Geo-Gate evaluation.

Layers: client-IP resolution, MaxMind GeoLite2 country check, ASN denylist,
signed IP-bound cookie, and the GeoPortal maintenance kill-switch (enforced by
the caller). GeoLite2 databases are optional at runtime: when absent the gate
reports the database as unavailable and honours `GEO_GATE_MODE`.
"""

import hashlib
import hmac
import ipaddress
import os
import threading
import time
from typing import Any, Dict, List, Optional

from .config import settings

try:  # GeoLite2 parsing is a hard requirement only when GEO_GATE_MODE=enforce.
    import maxminddb
except ImportError:  # pragma: no cover - exercised only on images without the wheel
    maxminddb = None

GEO_COOKIE_NAME = "kmc_geo_pass"
GEO_COOKIE_MAX_AGE = 86400
NEPAL_ISO_CODE = "NP"

_reader_lock = threading.Lock()
_reader_cache: Dict[str, tuple] = {}


def _open_reader(path: str):
    if maxminddb is None or not path:
        return None
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    with _reader_lock:
        cached = _reader_cache.get(path)
        if cached and cached[0] == mtime:
            return cached[1]
        try:
            reader = maxminddb.open_database(path)
        except Exception:  # noqa: BLE001 - a corrupt mmdb must not crash requests
            reader = None
        _reader_cache[path] = (mtime, reader)
        return reader


def _lookup(path: str, ip: str) -> Optional[Dict[str, Any]]:
    reader = _open_reader(path)
    if reader is None:
        return None
    try:
        record = reader.get(ip)
    except (ValueError, TypeError):
        return None
    return record if isinstance(record, dict) else None


def _parse_ip(raw: str) -> Optional[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    text_val = (raw or "").strip()
    if not text_val:
        return None
    if text_val.startswith("[") and "]" in text_val:
        text_val = text_val[1 : text_val.index("]")]
    elif text_val.count(":") == 1:
        text_val = text_val.split(":", 1)[0]
    try:
        return ipaddress.ip_address(text_val)
    except ValueError:
        return None


def _trusted_proxy_networks() -> List[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    networks: List[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for part in (settings.trusted_proxy_cidrs or "").split(","):
        cidr = part.strip()
        if not cidr:
            continue
        try:
            networks.append(ipaddress.ip_network(cidr, strict=False))
        except ValueError:
            continue
    return networks


def _is_trusted_proxy(address: Optional[ipaddress.IPv4Address | ipaddress.IPv6Address]) -> bool:
    if address is None:
        return False
    return any(address in net for net in _trusted_proxy_networks())


def resolve_client_ip(request) -> Optional[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Returns the validated client address.

    Only trusts `X-Real-IP` / `X-Forwarded-For` when the direct peer
    (`request.client.host`) belongs to `TRUSTED_PROXY_CIDRS`; otherwise
    returns the direct peer address to prevent header spoofing.
    """
    peer_host = getattr(getattr(request, "client", None), "host", None) or ""
    peer_ip = _parse_ip(peer_host)

    if _is_trusted_proxy(peer_ip):
        raw = (request.headers.get("x-real-ip") or "").strip()
        if not raw:
            raw = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        forwarded_ip = _parse_ip(raw)
        if forwarded_ip is not None:
            return forwarded_ip

    return peer_ip


def _country_code(ip: str) -> Optional[str]:
    record = _lookup(settings.geoip_country_db, ip)
    if not record:
        return None
    code = record.get("country", {}).get("iso_code") or record.get("registered_country", {}).get("iso_code")
    return str(code).upper() if code else None


def _asn(ip: str) -> Optional[int]:
    record = _lookup(settings.geoip_asn_db, ip)
    if not record:
        return None
    value = record.get("autonomous_system_number")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _country_db_available() -> bool:
    return _open_reader(settings.geoip_country_db) is not None


def evaluate(request) -> Dict[str, Any]:
    """Evaluates the sovereign gate for one request, checking blocked ASNs before cookies."""
    mode = settings.geo_gate_mode
    address = resolve_client_ip(request)
    verdict: Dict[str, Any] = {
        "mode": mode,
        "client_ip": str(address) if address else "",
        "country": None,
        "asn": None,
        "cookie_valid": False,
        "country_db_available": _country_db_available(),
        "reason": "",
        "allowed": False,
    }

    if mode == "off":
        verdict.update(allowed=True, reason="geo_gate_disabled")
        return verdict

    if address is None:
        verdict.update(allowed=mode == "monitor", reason="client_ip_unresolved")
        return verdict

    if address.is_private or address.is_loopback or address.is_link_local:
        verdict.update(allowed=True, reason="private_network")
        return verdict

    ip_str = str(address)
    asn = _asn(ip_str)
    verdict["asn"] = asn

    if asn is not None and asn in settings.geoip_blocked_asns:
        verdict.update(allowed=False, reason="blocked_asn")
        return verdict

    cookie = verify_cookie(request, ip_str)
    if cookie is not None:
        verdict.update(
            allowed=True,
            cookie_valid=True,
            country=cookie.get("country"),
            reason="signed_cookie",
        )
        return verdict

    country = _country_code(ip_str)
    verdict["country"] = country

    if country is None:
        verdict.update(allowed=mode == "monitor", reason="country_unknown")
        return verdict

    if country != NEPAL_ISO_CODE:
        verdict.update(allowed=False, reason="non_nepal_origin")
        return verdict

    verdict.update(allowed=True, reason="nepal_verified")
    return verdict


def _cookie_signature(key: bytes, issued_at: int, country: str, ip: str) -> str:
    payload = f"{issued_at}.{country}.{ip}".encode("utf-8")
    return hmac.new(key, payload, hashlib.sha256).hexdigest()[:32]


def issue_cookie_value(request, verdict: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """Mints an IP-bound signed pass cookie for a verified Nepal client."""
    verdict = verdict or evaluate(request)
    if not verdict.get("allowed"):
        return None
    country = verdict.get("country") or NEPAL_ISO_CODE
    issued_at = int(time.time())
    key = settings.secret_key.encode("utf-8")
    signature = _cookie_signature(key, issued_at, country, verdict.get("client_ip") or "")
    return f"v1.{issued_at}.{country}.{signature}"


def verify_cookie(request, client_ip: Optional[str] = None) -> Optional[Dict[str, Any]]:
    raw = request.cookies.get(GEO_COOKIE_NAME)
    if not raw:
        return None
    parts = raw.split(".")
    if len(parts) != 4 or parts[0] != "v1":
        return None
    try:
        issued_at = int(parts[1])
    except ValueError:
        return None
    country, signature = parts[2], parts[3]
    if client_ip is None:
        address = resolve_client_ip(request)
        if address is None:
            return None
        client_ip = str(address)
    now = time.time()
    if issued_at > now + 60 or now - issued_at > GEO_COOKIE_MAX_AGE:
        return None
    key = settings.secret_key.encode("utf-8")
    expected = _cookie_signature(key, issued_at, country, client_ip)
    if not hmac.compare_digest(signature, expected):
        return None
    return {"issued_at": issued_at, "country": country}
