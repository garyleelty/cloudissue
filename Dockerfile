# ---------- 依赖构建层 ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- 运行层 ----------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# 非 root 运行
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared ./shared
COPY db ./db
COPY mcp-server ./mcp-server
COPY server ./server
COPY public ./public

USER app
EXPOSE 5173

# 容器内自检：经 MCP 链路探测数据库
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5173/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
