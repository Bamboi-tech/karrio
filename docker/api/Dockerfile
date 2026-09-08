# The base image compilation
FROM python:3.12.10-slim AS compile-image

ARG REQUIREMENTS="requirements.txt"
ARG REGISTRY_TOKEN
ARG REGISTRY_TOKEN_NAME

RUN apt-get update -y && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /karrio/venv
ENV PATH="/karrio/venv/bin:$PATH"

# Copy requirements first for better layer caching
COPY "${REQUIREMENTS}" /temp/
COPY . /temp/app/
RUN cd /temp/app && \
    pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir dumb-init && \
    pip install --no-cache-dir -r "/temp/${REQUIREMENTS}"

# The runtime image
FROM python:3.12.10-slim AS build-image

LABEL maintainer=hello@karrio.io
LABEL org.opencontainers.image.title="karrio server"
LABEL org.opencontainers.image.description="karrio server runtime image"
LABEL org.opencontainers.image.url="https://karrio.io"
LABEL org.opencontainers.image.documentation="https://docs.karrio.io"
LABEL org.opencontainers.image.source="https://github.com/karrioapi/karrio"
LABEL org.opencontainers.image.vendor="team karrio"
LABEL org.opencontainers.image.authors="hello@karrio.io"

ENV DEBUG_MODE=False
ENV USE_HTTPS=False
ENV ALLOWED_HOSTS=*
ENV KARRIO_WORKERS=2
ENV BACKGROUND_WORKERS=2
ENV DETACHED_WORKER=False
ENV WORK_DIR=/karrio/app
ENV LOG_DIR=/karrio/log
ENV WORKER_DB_DIR=/karrio/data
ENV STATIC_ROOT_DIR=/karrio/static
# Build-time collectstatic output; the entrypoint syncs it into STATIC_ROOT_DIR
# (a runtime volume that would hide files baked into the image at that path).
ENV STATIC_BUILD_DIR=/karrio/staticfiles
ENV KARRIO_PLUGINS=/karrio/plugins
ENV ENABLE_ALL_PLUGINS_BY_DEFAULT=True

RUN apt-get update -y && apt-get install -y --no-install-recommends \
    libpango1.0-0 libpangoft2-1.0-0 gcc zint curl \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m karrio -d /karrio
USER karrio

COPY --chown=karrio:karrio --from=compile-image /karrio/ /karrio/
RUN mkdir -p $WORK_DIR $LOG_DIR $WORKER_DB_DIR $STATIC_ROOT_DIR $STATIC_BUILD_DIR $KARRIO_PLUGINS
COPY apps/api/gunicorn-cfg.py docker/api/entrypoint docker/api/worker $WORK_DIR/
COPY --chown=karrio:karrio plugins/ $KARRIO_PLUGINS/

WORKDIR $WORK_DIR

# Make sure we use the virtualenv:
ENV PATH="/karrio/venv/bin:$PATH"

# Collect + compress static files once, at build time. WhiteNoise's
# CompressedManifestStaticFilesStorage gzips and brotlis every file (~80 s of
# CPU for ~4 000 files / 95 MB) -- done on every boot this was most of the
# ~5 min deploy 502 window on the shared-core VM. Needs no database or
# secrets: a *.sqlite3 DATABASE_NAME selects the sqlite backend, which
# collectstatic never queries (the empty file it creates is removed).
RUN SECRET_KEY=build-only DATABASE_NAME=build.sqlite3 STATIC_ROOT_DIR=$STATIC_BUILD_DIR \
    karrio collectstatic --noinput 1>/dev/null \
    && rm -f $WORK_DIR/build.sqlite3

ENTRYPOINT ["/karrio/venv/bin/dumb-init", "--"]
CMD ["./entrypoint"]
