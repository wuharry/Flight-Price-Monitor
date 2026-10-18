FROM apify/actor-node-playwright-chrome:24-1.63.0-slim@sha256:cbbf90af87e417e1f5da0a53cfa57e5d9a3073458308b9722009ee924c7d345c
WORKDIR /home/myuser
COPY --chown=myuser:myuser package.json pnpm-lock.yaml ./
RUN npx --yes pnpm@10.23.0 install --frozen-lockfile --prod=false
COPY --chown=myuser:myuser tsconfig.json ./
COPY --chown=myuser:myuser src ./src
COPY --chown=myuser:myuser THIRD_PARTY_NOTICES.txt ./THIRD_PARTY_NOTICES.txt
RUN npx --yes pnpm@10.23.0 exec esbuild src/apify/main.ts --bundle --platform=node --format=esm --packages=external --outfile=actor-dist/main.js
ENV NODE_OPTIONS="--max-old-space-size=512"
CMD ["node", "actor-dist/main.js"]
