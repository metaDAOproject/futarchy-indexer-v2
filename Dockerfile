FROM oven/bun:latest as base
WORKDIR /app

# Install git (needed for git dependencies), vault CLI, and jq
RUN apt-get update && \
    apt-get install -y git gpg wget lsb-release jq && \
    wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" > /etc/apt/sources.list.d/hashicorp.list && \
    apt-get update && \
    apt-get install -y vault && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY . .

ENV NODE_ENV=production
RUN cd packages/database && bun install --frozen-lockfile
RUN bun install --frozen-lockfile

COPY vault-entrypoint.sh /usr/local/bin/vault-entrypoint.sh
RUN chmod +x /usr/local/bin/vault-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/vault-entrypoint.sh"]
CMD ["bun", "run", "start"]
