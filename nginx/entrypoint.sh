#!/bin/sh
CERT_DIR="/etc/letsencrypt/live/theymademe.co.uk"
CONF_DIR="/etc/nginx/conf.d"

# Check if a real Let's Encrypt cert exists
if [ -f "$CERT_DIR/fullchain.pem" ] && [ -d "/etc/letsencrypt/archive/theymademe.co.uk" ]; then
    echo "SSL certificate found — using HTTPS config."
    cp "$CONF_DIR/ssl.conf.template" "$CONF_DIR/default.conf"
else
    echo "No SSL certificate yet — using HTTP-only config for bootstrap."
    cp "$CONF_DIR/http-only.conf.template" "$CONF_DIR/default.conf"

    # Background watcher: when certbot provisions the real cert, switch to SSL and reload
    (
        echo "Watching for Let's Encrypt certificate..."
        while true; do
            sleep 10
            if [ -f "$CERT_DIR/fullchain.pem" ] && [ -d "/etc/letsencrypt/archive/theymademe.co.uk" ]; then
                echo "Real certificate detected! Switching to HTTPS config..."
                cp "$CONF_DIR/ssl.conf.template" "$CONF_DIR/default.conf"
                sleep 2
                nginx -s reload
                echo "Nginx reloaded with SSL. Site is now serving HTTPS."
                break
            fi
        done
    ) &
fi

# Run the default nginx entrypoint
exec /docker-entrypoint.sh "$@"
