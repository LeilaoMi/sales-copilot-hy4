# 销冠助手 · 同步后端容器化
# 构建：docker build -t sales-copilot .
# 运行：docker run -d --name sales-copilot -p 8080:8080 \
#         -e SYNC_TOKEN=你自己的长令牌 \
#         -v $(pwd)/sync-data:/app/data \
#         --restart unless-stopped sales-copilot
#
# 不带 SYNC_TOKEN 就是「多人模式」：任意 ≥8 位令牌各自独立存一份，全员共用一台服务器。
# 带 SYNC_TOKEN 就是「专属模式」：只认这一个令牌，最省心。

FROM node:20-alpine

WORKDIR /app
COPY . .

# 数据目录挂卷后，容器重建数据不丢
VOLUME ["/app/data"]
ENV PORT=8080
EXPOSE 8080

# 用非 root 用户跑，减小风险
RUN addgroup -S app && adduser -S -G app app \
 && mkdir -p /app/data && chown -R app:app /app
USER app

CMD ["node", "server.js"]
