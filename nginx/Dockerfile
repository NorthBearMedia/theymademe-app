FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY conf.d/default.conf /etc/nginx/conf.d/default.conf
COPY frontend/ /var/www/frontend/
