FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

CMD ["node", "bin/perchai-2api.js", "serve"]
