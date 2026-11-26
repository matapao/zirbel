# check=error=true
# The Node of .nvmrc, pinned by digest (Dependabot moves it).
FROM node:26.13.1-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9
WORKDIR /app
COPY dist/ /app/
# The image's node user, by its ids, which the host resolves the same way.
RUN mkdir /data && chown 1000:1000 /data
USER 1000:1000
VOLUME ["/data"]
EXPOSE 4174
# A small young generation keeps the host near 100 MB under load (Pi-friendly).
ENTRYPOINT ["node", "--max-semi-space-size=2", "/app/server.mjs", "--host-only", "--data", "/data"]
