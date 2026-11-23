ARG BUILD_IMAGE=ai-membership-store-t232-builder:local
FROM ${BUILD_IMAGE}

COPY --from=docker.io/library/caddy:2.6.2@sha256:7992b931b7da3cf0840dd69ea74b2c67d423faf03408da8abdc31b7590a239a7 /usr/bin/caddy /usr/local/bin/caddy
RUN sed -i 's/^Components:.*/Components: main/' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends python3 systemd \
    && rm -rf /var/lib/apt/lists/*
