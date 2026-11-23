# Shared server-level configuration for every KMC-GIS-SERVER nginx listener.
# Included by default.conf (HTTP :80) and optionally tls.conf (HTTPS :443).

# Only upload routes may exceed this; every other request stays small.
client_max_body_size 2m;
client_body_buffer_size 512k;
client_body_timeout 600s;

# Production HTTP Security Headers (re-included in every location with add_header)
include /etc/nginx/kmc-security-headers.inc;
add_header X-Cache-Status $upstream_cache_status always;

# Spatial Payload Compression (GeoJSON, MVT Vector Tiles, JSON)
gzip on;
gzip_proxied any;
gzip_vary on;
gzip_min_length 1024;
gzip_comp_level 5;
gzip_types
    application/json
    application/geo+json
    application/vnd.mapbox-vector-tile
    application/x-protobuf
    application/javascript
    text/css
    text/plain;

# Container Liveness Probe
location = /nginx-health {
    access_log off;
    default_type application/json;
    return 200 '{"status":"healthy","gateway":"kmc-nginx"}';
}

# Block sensitive dotfiles & Docker/Swarm secret artifacts. ACME HTTP-01
# challenges must stay reachable when certificates are issued via webroot.
location ^~ /.well-known/acme-challenge/ {
    root /var/www/letsencrypt;
}

location ~ /\.(?!well-known/) {
    deny all;
    return 404;
}

location ^~ /secrets/ {
    deny all;
    return 404;
}

# Internal subrequest for the 5-Layer Nepal Geo-Gate
# (client-IP resolution -> GeoLite2 country -> ASN denylist -> signed cookie
# -> GeoPortal maintenance kill-switch, all evaluated by FastAPI).
location = /_geo_verify {
    internal;
    proxy_pass $backend_origin/api/geo-access/verify;
    proxy_http_version 1.1;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
    proxy_set_header Cookie $http_cookie;
}

# Zero-copy X-Accel-Redirect streaming for clipped offline bundles
location /internal_offline_bundles/ {
    internal;
    alias /var/kmc_uploads/offline_bundles/;
    include /etc/nginx/kmc-security-headers.inc;
    add_header Cache-Control "private, max-age=3600" always;
}

# Nepal Geo-Gated Million-Feature Map (/geoportal/map)
location ^~ /geoportal/map {
    auth_request /_geo_verify;
    proxy_pass $geoportal_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
}

# Public GeoPortal Landing Page (exact match)
location = /geoportal {
    proxy_pass $geoportal_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
}

# Public GeoPortal Subpaths & Static Chunks
location ^~ /geoportal/ {
    proxy_pass $geoportal_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
}

# Unload beacon endpoint: the browser cannot set an Authorization header on
# navigator.sendBeacon, so the token may arrive in the query string. Disable
# access logging for this exact route so the token never reaches a log file.
location = /api/tracking/status {
    access_log off;
    proxy_pass $backend_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
}

# Authentication endpoints: strict brute-force throttling.
location ~ ^/api/auth/(login|refresh)$ {
    limit_req zone=auth_limit burst=5 nodelay;
    proxy_pass $backend_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
}

# Dedicated SSE stream for upload progress events
location ~ ^/api/uploads/.*/events$ {
    limit_req zone=api_limit burst=100 nodelay;
    proxy_buffering off;
    proxy_cache off;
    proxy_connect_timeout 60s;
    proxy_send_timeout 3600s;
    proxy_read_timeout 3600s;
    proxy_pass $backend_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
}

# Streaming upload routes only. `/api/uploads/init` and status lookups stay
# on the 2 MB cap; only chunk/complete/direct-upload endpoints may stream a
# full geospatial archive.
location ~ ^/api/(uploads/[^/]+/(chunk|complete)|tiles/upload|layers/upload|projects/[^/]+/tiles/upload)$ {
    limit_req zone=upload_limit burst=300 nodelay;
    client_max_body_size 0;
    client_body_timeout 7200s;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_cache off;
    proxy_connect_timeout 300s;
    proxy_send_timeout 7200s;
    proxy_read_timeout 7200s;
    proxy_pass $backend_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
}

# FastAPI Backend REST API, WebSocket/SSE & native MVT/raster tile engine
location /api/ {
    limit_req zone=api_limit burst=100 nodelay;
    client_max_body_size 2m;
    proxy_buffering off;
    proxy_cache off;
    proxy_connect_timeout 60s;
    proxy_send_timeout 600s;
    proxy_read_timeout 600s;
    proxy_pass $backend_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
}

# OGC API - Features (QGIS per-layer read + Toggle Editing). FastAPI enforces
# HTTP Basic / Bearer authentication on every request and reuses the REST
# permission, audit and persistence pipeline for writes.
location = /ogc {
    return 301 /ogc/;
}

location /ogc/ {
    limit_req zone=api_limit burst=100 nodelay;
    client_max_body_size 8m;
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
    proxy_pass $backend_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
}

# Rust Martin High-Speed MVT Server (Nepal Geo-Gated)
location = /martin {
    return 301 /martin/;
}

location /martin/ {
    auth_request /_geo_verify;
    limit_req zone=tiles_limit burst=300 nodelay;
    rewrite ^/martin/(.*)$ /$1 break;
    proxy_read_timeout 300s;
    proxy_pass $martin_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;

    # Edge Proxy Caching for Vector Tiles (Sub-millisecond Edge Delivery)
    proxy_cache mvt_cache;
    proxy_cache_key "$request_method$request_uri";
    proxy_cache_valid 200 204 24h;
    proxy_cache_valid 404 1m;
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
    proxy_cache_lock on; # Prevents thundering herd / dog-piling PostgreSQL
    proxy_cache_lock_timeout 5s;
    proxy_ignore_headers Cache-Control Expires Set-Cookie;

    include /etc/nginx/kmc-security-headers.inc;
    add_header X-Cache-Status $upstream_cache_status always;
}

# High-Performance MBTiles Raster Tile Engine (Nepal Geo-Gated)
location /tiles/data/ {
    auth_request /_geo_verify;
    limit_req zone=tiles_limit burst=300 nodelay;
    rewrite ^/tiles/data/(.*)$ /api/tiles/data/$1 break;
    proxy_pass $backend_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;

    # Edge Proxy Caching for Backend MBTiles
    proxy_cache mvt_cache;
    proxy_cache_key "$request_method$request_uri";
    proxy_cache_valid 200 204 24h;
    proxy_cache_valid 404 1m;
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
    proxy_cache_lock on; # Prevents thundering herd / dog-piling PostgreSQL
    proxy_cache_lock_timeout 5s;
    proxy_ignore_headers Cache-Control Expires Set-Cookie;

    include /etc/nginx/kmc-security-headers.inc;
    add_header X-Cache-Status $upstream_cache_status always;
}

# TileServer-GL UAV Orthophoto MBTiles (Nepal Geo-Gated)
location = /tiles {
    return 301 /tiles/;
}

location /tiles/ {
    auth_request /_geo_verify;
    limit_req zone=tiles_limit burst=300 nodelay;
    rewrite ^/tiles/(.*)$ /$1 break;
    proxy_pass $tileserver_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;

    # Edge Proxy Caching for UAV Orthophoto MBTiles
    proxy_cache mvt_cache;
    proxy_cache_key "$request_method$request_uri";
    proxy_cache_valid 200 204 24h;
    proxy_cache_valid 404 1m;
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
    proxy_cache_lock on; # Prevents thundering herd / dog-piling PostgreSQL
    proxy_cache_lock_timeout 5s;
    proxy_ignore_headers Cache-Control Expires Set-Cookie;

    include /etc/nginx/kmc-security-headers.inc;
    add_header X-Cache-Status $upstream_cache_status always;
}

# GeoServer Enterprise OGC WMS / WFS-T / WMTS (Nepal Geo-Gated)
location = /geoserver {
    return 301 /geoserver/;
}

location /geoserver/ {
    auth_request /_geo_verify;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_pass $geoserver_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
}

# Root strictly directs to the single authentic "Enter the Geo World of KMC" portal
location = / {
    return 302 /geoportal;
}

# Authenticated Field Data Collection PWA & Admin Console (/ -> frontend:3000)
location / {
    proxy_pass $frontend_origin$uri$is_args$args;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $kmc_forwarded_proto;
    proxy_set_header X-Forwarded-Host $kmc_forwarded_host;
}
