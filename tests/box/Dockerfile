# The herdr-chat test box: the real Herdr app (the official Linux release) and
# herdr-core on a virtual X display, offline, with Node for the chat's host.
# Nothing in it reaches the person's screen, keyboard, pointer or files; a
# worktree is mounted read-only and copied in. See tests/box/README.md.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
# Xvfb + xdotool + python3-xlib: the display and real X input (XTest). librsvg: the cursor
# SVGs (box record). Mesa: software Vulkan/GL
# (the app renders on the CPU; there is no GPU here). ffmpeg: videos from shots.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git openssl jq procps bash zsh lsof iproute2 vim-tiny patch diffutils \
      xvfb xauth x11-utils xdotool xclip xsel python3-xlib librsvg2-bin \
      mesa-vulkan-drivers libvulkan1 libegl1 libgl1-mesa-dri \
      libxcb1 libxkbcommon0 libxkbcommon-x11-0 libwayland-client0 libfontconfig1 libfreetype6 \
      fonts-dejavu-core fonts-noto-color-emoji \
      ffmpeg imagemagick python3 \
    && rm -rf /var/lib/apt/lists/*
ARG HERDR_APP=0.1.16
ARG HERDR_CORE=0.1.21
ARG NODE=24.11.1
RUN set -e; arch=$(uname -m); case $arch in aarch64) a=aarch64 n=arm64 ;; x86_64) a=x86_64 n=x64 ;; *) exit 1 ;; esac; \
    mkdir -p /opt/herdr /opt/node; \
    curl -fsSL "https://releases.herdr.dev/app/${HERDR_APP}/herdr-app-linux-${a}.tar.gz" | tar xz -C /opt/herdr; \
    curl -fsSL "https://releases.herdr.dev/core/${HERDR_CORE}/herdr-core-linux-${a}.tar.gz" | tar xz -C /opt/herdr; \
    curl -fsSL "https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-${n}.tar.xz" | tar xJ -C /opt/node --strip-components=1; \
    ln -s /opt/herdr/herdr-app/herdr-app /usr/local/bin/herdr-app; \
    ln -s /opt/herdr/herdr-core /usr/local/bin/herdr-core; ln -s /opt/herdr/herdr-core /usr/local/bin/hc; \
    ln -s /opt/node/bin/node /usr/local/bin/node; ln -s /opt/node/bin/npm /usr/local/bin/npm; ln -s /opt/node/bin/npx /usr/local/bin/npx; \
    herdr-app --version; hc --version; node --version
# Links the app would open are logged, never opened.
RUN printf '#!/bin/sh\necho "$*" >> /tmp/opened.log\n' > /usr/local/bin/xdg-open && chmod +x /usr/local/bin/xdg-open
COPY image/ /opt/box/
# The box user is uid 1000 (Ubuntu ships `ubuntu` there: renamed, so files it writes are the host
# user's on a Linux host too).
RUN chmod +x /opt/box/*.sh /opt/box/*.py \
 && usermod -l box -d /home/box -m ubuntu && groupmod -n box ubuntu
USER box
# A person's shell has its rc files: without ~/.zshrc, zsh -i stops at its first-run wizard.
RUN printf '# test box\n' > /home/box/.zshrc && printf '# test box\n' > /home/box/.zprofile
WORKDIR /home/box
ENTRYPOINT ["/opt/box/entry.sh"]
