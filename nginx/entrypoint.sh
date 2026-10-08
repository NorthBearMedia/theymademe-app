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

# Pick up RENEWED certificates.
# certbot (a separate container) renews the files on disk, but nginx only reads a
# certificate at start or reload. Without this the old certificate keeps being served
# from memory until it expires — which took the live site down on 21 Sep 2026.
# Reload every 6 hours (a reload is graceful and cheap); skip if the config test fails
# so a bad config can never take the site down.
(
    while true; do
        sleep 21600
        if nginx -t >/dev/null 2>&1; then
            nginx -s reload && echo "Periodic reload done — certificates refreshed."
        else
            echo "Periodic reload skipped: nginx config test failed."
        fi
    done
) &

# Run the default nginx entrypoint
exec /docker-entrypoint.sh "$@"
