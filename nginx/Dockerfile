FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
# Store configs as .template so nginx doesn't auto-load them
# The entrypoint will copy the right one to default.conf
COPY conf.d/default.conf /etc/nginx/conf.d/ssl.conf.template
COPY conf.d/http-only.conf /etc/nginx/conf.d/http-only.conf.template
COPY frontend/ /var/www/frontend/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
