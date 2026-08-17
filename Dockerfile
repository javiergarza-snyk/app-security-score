# Ephemeral scan sandbox: clones + builds + scans an untrusted public repo
# entirely inside this container. No host paths are ever bind-mounted in —
# only an anonymous, per-run Docker volume is shared between the two stages.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      python3 \
      python3-venv \
      python3-pip \
      build-essential \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Trust any corporate root CA dropped in docker/certs/ (see docker/certs/README.md).
# Lets the build survive TLS-inspecting proxies (e.g. Zscaler) without baking a
# specific corporate cert into the portable Dockerfile itself.
COPY docker/certs/ /usr/local/share/ca-certificates/extra/
RUN update-ca-certificates || true
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

RUN corepack enable \
    && npm install -g snyk@latest \
    && pip install --break-system-packages --no-cache-dir uv

WORKDIR /app
COPY docker/lib.mjs docker/install.mjs docker/scan.mjs ./

ENV WORK_DIR=/work
