FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY conf.d/default.conf /etc/nginx/conf.d/default.conf.ssl
COPY conf.d/http-only.conf /etc/nginx/conf.d/http-only.conf
COPY frontend/ /var/www/frontend/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
