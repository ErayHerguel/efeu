# efeu Cloud als Container (für Profis und NAS). Vorher bauen: npm run build && npm run build:server
# Start: docker run -d --restart unless-stopped -p 8080:8080 -v efeu-daten:/data <image>
# HTTPS übernimmt ein Proxy davor (z. B. Caddy oder der des NAS).
FROM node:24-slim
WORKDIR /app
COPY dist-server/efeu-server.mjs /app/efeu-server.mjs
COPY dist-server/efeu-web.tar.gz /tmp/efeu-web.tar.gz
RUN mkdir /app/web && tar -xzf /tmp/efeu-web.tar.gz -C /app/web && rm /tmp/efeu-web.tar.gz
ENV EFEU_DATA=/data EFEU_HOST=0.0.0.0 EFEU_PORT=8080 NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "/app/efeu-server.mjs"]
