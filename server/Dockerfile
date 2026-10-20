# efeu Cloud als Container (für Profis und NAS). Gebaut wird vorher mit: npm run build:server
FROM node:24-slim
WORKDIR /app
COPY dist-server/efeu-server.mjs /app/efeu-server.mjs
ENV EFEU_DATA=/data EFEU_HOST=0.0.0.0 EFEU_PORT=8080 NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "/app/efeu-server.mjs"]
