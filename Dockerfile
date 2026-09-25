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
WORKDIR /app
ENV NODE_ENV=production STORAGE=supabase EMAIL_MODE=preview BROWSER_HEADLESS=false
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist/src ./dist/src
COPY --chown=pwuser:pwuser package.json ./
USER pwuser
CMD ["xvfb-run", "-a", "node", "dist/src/index.js", "--run-once"]
