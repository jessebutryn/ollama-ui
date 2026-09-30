FROM nginx:1.27-alpine

# Vendor the front-end libraries into the image so the UI works offline.
ADD https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js /usr/share/nginx/html/vendor/marked.min.js
ADD https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js /usr/share/nginx/html/vendor/purify.min.js
ADD https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/highlight.min.js /usr/share/nginx/html/vendor/highlight.min.js
ADD https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/github-dark.min.css /usr/share/nginx/html/vendor/github-dark.min.css
RUN chmod -R a+r /usr/share/nginx/html/vendor

COPY public/ /usr/share/nginx/html/
# Files in /etc/nginx/templates are run through envsubst at container start.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

ENV OLLAMA_URL=http://127.0.0.1:11434 \
    LISTEN_PORT=3000

EXPOSE 3000
