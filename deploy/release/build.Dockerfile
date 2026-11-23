FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git openssl xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --silent --show-error --location \
      https://nodejs.org/download/release/v24.13.0/node-v24.13.0-linux-x64.tar.xz \
      --output /tmp/node.tar.xz \
    && echo 'e798599612f4bb71333a3397ab0d095fd62214e115aea45aa858a145fc72d67e  /tmp/node.tar.xz' | sha256sum --check \
    && tar -xJf /tmp/node.tar.xz -C /opt \
    && rm /tmp/node.tar.xz

ENV PATH=/opt/node-v24.13.0-linux-x64/bin:$PATH
