# ---- 构建阶段 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 优先复制依赖清单以利用层缓存
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npm run build

# ---- verify 阶段：一次性验收（类型检查 + 单元测试 + 构建 + Playwright e2e）----
FROM build AS verify
# Playwright 仅需 Chromium；--with-deps 需要 apt，slim 镜像自带 apt
RUN npx playwright install --with-deps chromium
ENV CI=true
CMD ["npm", "run", "verify"]

# ---- 页面发布阶段：纯静态 nginx，无任何后端接口 ----
FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
