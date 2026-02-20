FROM nginx:1.27-alpine
RUN apk add --no-cache openssl
RUN rm -f /etc/nginx/conf.d/default.conf
COPY conf.d/default.conf /etc/nginx/conf.d/default.conf
COPY frontend/ /var/www/frontend/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
