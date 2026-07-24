# pm-agent: the only place project secrets (deploy key, provider OAuth token)
# ever appear (see docs/pm-system-plan.md). Deliberately carries NO project
# language toolchains — all project code builds/runs only in the project's
# own containers via the mounted rootless docker socket.
FROM node:22-bookworm-slim

ARG DELTA_VERSION=0.18.2
ARG DOCKER_VERSION=27.4.1
ARG COMPOSE_VERSION=v2.32.1

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      curl \
      ripgrep \
      fd-find \
      jq \
      fzf \
      bat \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
    && ln -s "$(command -v batcat)" /usr/local/bin/bat

# git-delta: no Debian bookworm apt package, install the .deb release directly.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) DELTA_ARCH=amd64 ;; \
      arm64) DELTA_ARCH=arm64 ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/delta.deb \
      "https://github.com/dandavison/delta/releases/download/${DELTA_VERSION}/git-delta_${DELTA_VERSION}_${DELTA_ARCH}.deb"; \
    dpkg -i /tmp/delta.deb; \
    rm -f /tmp/delta.deb

# Docker CLI (client only — the daemon is the project's rootless dockerd,
# reached over the mounted socket) + the compose plugin.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) DOCKER_ARCH=x86_64 ;; \
      arm64) DOCKER_ARCH=aarch64 ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/docker.tgz \
      "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VERSION}.tgz"; \
    tar -xzf /tmp/docker.tgz -C /tmp docker/docker; \
    mv /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker.tgz /tmp/docker

RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) COMPOSE_ARCH=x86_64 ;; \
      arm64) COMPOSE_ARCH=aarch64 ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    mkdir -p /usr/local/lib/docker/cli-plugins; \
    curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}"; \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

RUN npm install -g @anthropic-ai/claude-code

# Antigravity CLI: its installer drops the binary at ~/.local/bin/agy (same
# path used by roles/dev_tools/tasks/runtime_tools.yml on the host).
ENV PATH="/root/.local/bin:${PATH}"
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

WORKDIR /workspace
CMD ["bash"]
