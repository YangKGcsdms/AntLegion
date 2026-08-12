# AntLegion MVP node — Ubuntu 24.04 + Node 20 + the two published packages.
# One image, four roles: the bus core and three pi-agent (DCU) containers
# pick their role via `command:` in docker-compose.yml.

FROM ubuntu:24.04 AS base

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

FROM base

ARG BUS_PKG=@antlegion/bus@latest
ARG ANT_PKG=@antlegion/ant@latest
RUN npm install -g ${BUS_PKG} ${ANT_PKG} && npm cache clean --force

WORKDIR /work
# default role: print help (compose overrides per service)
CMD ["ant", "--help"]
