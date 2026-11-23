# Shared HTTP Security Headers — included at server level and inside every
# location block that defines its own add_header directive (nginx drops
# inherited add_header directives whenever a child block defines any).
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(self), camera=(self), microphone=()" always;
add_header Strict-Transport-Security $kmc_hsts_header always;
