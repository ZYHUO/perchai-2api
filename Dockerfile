FROM node:22-alpine AS runtime

WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

CMD ["node", "bin/perchai-2api.js", "serve"]

FROM runtime AS cli

ARG PERCH_CLI_PACKAGE_VERSION=2.4.125
RUN npm install --prefix /opt/perchai-cli --omit=dev --ignore-scripts --no-audit --no-fund perchai-cli@${PERCH_CLI_PACKAGE_VERSION}

ENV PERCH_BACKEND=cli \
    PERCH_CLI_ENTRY=/opt/perchai-cli/node_modules/perchai-cli/dist/perch.mjs
