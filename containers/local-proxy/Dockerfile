FROM cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8

RUN ["apk", "add", "--no-cache", "nodejs=22.23.2-r0"]
COPY entrypoint.mjs /local-proxy-entrypoint.mjs
ENTRYPOINT ["node", "/local-proxy-entrypoint.mjs"]
