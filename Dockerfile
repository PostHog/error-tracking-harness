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
COPY fixtures/cli-rollup-4/package.json fixtures/cli-rollup-4/pnpm-workspace.yaml fixtures/cli-rollup-4/pnpm-lock.yaml fixtures/cli-rollup-4/
COPY fixtures/vite-8-isolated/package.json fixtures/vite-8-isolated/pnpm-workspace.yaml fixtures/vite-8-isolated/pnpm-lock.yaml fixtures/vite-8-isolated/
COPY fixtures/next-14/package.json fixtures/next-14/pnpm-workspace.yaml fixtures/next-14/pnpm-lock.yaml fixtures/next-14/
COPY fixtures/next-15/package.json fixtures/next-15/pnpm-workspace.yaml fixtures/next-15/pnpm-lock.yaml fixtures/next-15/
COPY fixtures/next-16-webpack/package.json fixtures/next-16-webpack/pnpm-workspace.yaml fixtures/next-16-webpack/pnpm-lock.yaml fixtures/next-16-webpack/
COPY fixtures/next-16-turbopack/package.json fixtures/next-16-turbopack/pnpm-workspace.yaml fixtures/next-16-turbopack/pnpm-lock.yaml fixtures/next-16-turbopack/
# Build scripts run only where a fixture's pnpm-workspace.yaml allows them: @posthog/cli's
# postinstall, which downloads the binary the plugins resolve when given no path.
RUN for fixture in fixtures/*/; do (cd "$fixture" && pnpm install --frozen-lockfile); done \
    && pnpm store prune
# pnpm runs a package's build script once and reuses the package from its store for the next
# fixture without the files that script produced, so each fixture's shim must be checked and
# rebuilt where the binary is missing. A fixture without @posthog/cli (cli mode) has no shim.
RUN set -eu; for fixture in fixtures/*/; do \
        shim=""; for candidate in node_modules/.bin/posthog-cli node_modules/.pnpm/node_modules/.bin/posthog-cli; do \
            [ -e "$fixture$candidate" ] && shim="$candidate" && break; done; \
        [ -n "$shim" ] || continue; \
        (cd "$fixture" && ("$shim" --version >/dev/null 2>&1 || pnpm rebuild @posthog/cli) && "$shim" --version); \
    done

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
