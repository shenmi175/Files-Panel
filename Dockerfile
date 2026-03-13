FROM rust:1.86-bookworm AS builder
WORKDIR /app

COPY Cargo.toml Cargo.toml
COPY src src
COPY static static

RUN cargo build --release

FROM debian:bookworm-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssh-client sshpass \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/files-panel /usr/local/bin/files-panel
COPY --from=builder /app/static /app/static

ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

CMD ["files-panel"]
