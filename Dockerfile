# check=error=true
FROM node:24.22.3-bookworm-slim
WORKDIR /app
COPY dist/ /app/
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4174
# A small young generation keeps the host near 100 MB under load (Pi-friendly).
ENTRYPOINT ["node", "--max-semi-space-size=2", "/app/server.mjs", "--host-only", "--data", "/data"]
