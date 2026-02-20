#!/bin/sh
# If Let's Encrypt cert doesn't exist yet, create a self-signed placeholder
# so nginx can start and serve the ACME challenge on port 80
CERT_DIR="/etc/letsencrypt/live/theymademe.co.uk"
if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
    echo "No SSL cert found — generating self-signed placeholder..."
    mkdir -p "$CERT_DIR"
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
        -keyout "$CERT_DIR/privkey.pem" \
        -out "$CERT_DIR/fullchain.pem" \
        -subj "/CN=theymademe.co.uk" 2>/dev/null
    echo "Self-signed cert created. Certbot will replace it with a real one."
fi

# Run the default nginx entrypoint
exec /docker-entrypoint.sh "$@"
