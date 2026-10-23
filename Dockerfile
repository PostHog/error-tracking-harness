# The rig: every fixture installed, every supported posthog-cli baked in, the harness on top.
# Callers mount the one thing they changed (plugin tarballs at /subject, or a CLI binary) and
# run with --network none. See README.md.
FROM node:24-bookworm

RUN npm install -g pnpm@11.7.0 && npm cache clean --force

WORKDIR /rig

# Layer 1: dependencies and binaries. Keyed on the lockfiles and cli-versions.txt only.
COPY fixtures/webpack-5.112/package.json fixtures/webpack-5.112/pnpm-workspace.yaml fixtures/webpack-5.112/pnpm-lock.yaml fixtures/webpack-5.112/
COPY fixtures/rollup-4/package.json fixtures/rollup-4/pnpm-workspace.yaml fixtures/rollup-4/pnpm-lock.yaml fixtures/rollup-4/
COPY fixtures/vite-8/package.json fixtures/vite-8/pnpm-workspace.yaml fixtures/vite-8/pnpm-lock.yaml fixtures/vite-8/
RUN for fixture in fixtures/*/; do (cd "$fixture" && pnpm install --frozen-lockfile --ignore-scripts); done \
    && pnpm store prune

COPY cli-versions.txt .
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in amd64) triple=x86_64-unknown-linux-gnu ;; arm64) triple=aarch64-unknown-linux-gnu ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; esac; \
    for version in $(cat cli-versions.txt); do \
        mkdir -p "/opt/posthog-cli/$version"; \
        curl -fsSL "https://github.com/PostHog/posthog/releases/download/posthog-cli/v$version/posthog-cli-$triple.tar.gz" \
            | tar -xz --strip-components=1 -C "/opt/posthog-cli/$version"; \
        "/opt/posthog-cli/$version/posthog-cli" --version; \
    done

# Layer 2: sources, cases and the harness. Cheap to rebuild.
COPY harness harness
COPY fixtures fixtures

ENV HARNESS_CLI_DIR=/opt/posthog-cli
# /subject and /artifacts are picked up when mounted; arguments narrow the matrix (see README).
ENTRYPOINT ["node", "/rig/harness/run.mjs"]
