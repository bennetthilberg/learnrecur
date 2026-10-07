FROM rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97 AS build
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY Cargo.toml Cargo.lock rust-toolchain.toml .version ./
COPY build ./build
COPY ftl ./ftl
COPY proto ./proto
COPY rslib ./rslib
COPY pylib/rsbridge ./pylib/rsbridge
COPY tools/minilints ./tools/minilints
ENV CARGO_BUILD_JOBS=2
RUN cargo build --locked --release -p anki-sync-server

FROM python:3.13.13-slim-bookworm@sha256:355bfa66770995d7e9a0da4b3473b44d0cb451f6b56f5615ad9c39e3c4eca03f
RUN apt-get update && apt-get install -y --no-install-recommends age && rm -rf /var/lib/apt/lists/*
ARG BUILD_REVISION
LABEL org.opencontainers.image.source="https://github.com/bennetthilberg/learnrecur" org.opencontainers.image.revision=$BUILD_REVISION
RUN test -n "$BUILD_REVISION" && printf '%s\n' "$BUILD_REVISION" > /build-revision
WORKDIR /app
COPY --from=build /source/target/release/anki-sync-server /usr/local/bin/anki-sync-server
COPY pylib/anki/learnrecur_skill_import.py /app/anki/learnrecur_skill_import.py
COPY pylib/anki/learnrecur_batches.py /app/anki/learnrecur_batches.py
COPY pylib/anki/learnrecur_limits.py /app/anki/learnrecur_limits.py
COPY learnrecur/companion /app/learnrecur/companion
COPY learnrecur/fixtures /app/learnrecur/fixtures
COPY learnrecur/deploy/backup.py learnrecur/deploy/container.py learnrecur/deploy/run_sync_server.py learnrecur/deploy/recovery.py /app/learnrecur/deploy/
COPY LICENSE /app/LICENSE
RUN python -c "import learnrecur.companion.server, learnrecur.companion.jobs"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10001:10001
ENTRYPOINT ["python", "-m", "learnrecur.deploy.container"]
