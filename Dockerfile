FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
WORKDIR /app
RUN npm install --global pnpm@10.23.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN pnpm test
RUN pnpm prune --prod

FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production STORAGE=supabase EMAIL_MODE=preview BROWSER_HEADLESS=false
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist/src ./dist/src
COPY --from=build --chown=pwuser:pwuser /app/dist/scripts/test-gmail.js ./dist/scripts/test-gmail.js
COPY --chown=pwuser:pwuser package.json ./
COPY --chown=pwuser:pwuser scripts/container-start.sh scripts/container-smoke.mjs ./scripts/
# Windows checkouts may use CRLF; the Linux entry script must use LF.
RUN sed -i 's/\r$//' scripts/container-start.sh
USER pwuser
# Fail the build if the actual runtime user cannot start Xvfb and headed Chromium.
RUN timeout --kill-after=5s 45s /usr/bin/tini -s -g -- xvfb-run -a -e /dev/stderr node scripts/container-smoke.mjs
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["/bin/sh", "scripts/container-start.sh"]
