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
    # Mark this as self-signed so the reload watcher knows to check
    touch "$CERT_DIR/.self-signed"
    echo "Self-signed cert created. Certbot will replace it with a real one."
fi

# Background process: if we started with a self-signed cert, watch for the
# real cert from certbot and reload nginx when it appears
if [ -f "$CERT_DIR/.self-signed" ]; then
    (
        echo "Watching for real Let's Encrypt certificate..."
        while [ -f "$CERT_DIR/.self-signed" ]; do
            sleep 10
            # Check if certbot replaced our self-signed cert (archive dir = real cert)
            if [ -d "/etc/letsencrypt/archive/theymademe.co.uk" ]; then
                echo "Real certificate detected! Reloading nginx..."
                rm -f "$CERT_DIR/.self-signed"
                nginx -s reload
                echo "Nginx reloaded with real Let's Encrypt certificate."
                break
            fi
        done
    ) &
fi

# Run the default nginx entrypoint
exec /docker-entrypoint.sh "$@"
