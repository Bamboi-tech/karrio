# -*- encoding: utf-8 -*-
import decouple

KARRIO_HOST = decouple.config("KARRIO_HTTP_HOST", default="0.0.0.0")
KARRIO_PORT = decouple.config("KARRIO_HTTP_PORT", default=5002)

bind = f"{KARRIO_HOST}:{KARRIO_PORT}"
accesslog = "-"
# "debug" (the old hard-coded value) logs every request twice plus internals
# and was the bulk of the 1.9 GB journal on the production VM.
loglevel = decouple.config("GUNICORN_LOG_LEVEL", default="info")
capture_output = True
enable_stdio_inheritance = True
workers = decouple.config("KARRIO_WORKERS", default=2, cast=int)

# Worker model. Django's ASGI handler runs every sync view/middleware through
# sync_to_async(thread_sensitive=True), i.e. ONE request at a time per process:
# with 2 uvicorn workers the whole API had 2 request slots (6 concurrent
# get_shipments -> 2 finish at 0.94 s, 4 at 1.72 s). Nothing in the server needs
# ASGI (no async views, channels or websockets; apps/api/karrio/server/wsgi.py
# exists), so the default is WSGI + gthread: `workers` processes x `threads`
# threads, all IO-bound work (Postgres, Redis, ERP relay, carrier HTTP) overlaps.
# KARRIO_ASGI=True restores the previous uvicorn setup (entrypoint picks the
# matching app module).
KARRIO_ASGI = decouple.config("KARRIO_ASGI", default=False, cast=bool)
if KARRIO_ASGI:
    worker_class = "karrio.server.workers.UvicornWorker"
else:
    worker_class = "gthread"
    threads = decouple.config("KARRIO_THREADS", default=8, cast=int)

# Request lifecycle. gthread only kills a worker whose main loop stops
# heartbeating, so a slow ERP/carrier call (30 s read timeout) does not trip
# `timeout`. keepalive > 2 s (gunicorn default) lets Caddy's upstream
# connection pool reuse connections instead of reconnecting per request.
timeout = 60
graceful_timeout = 30
keepalive = 15
# Recycle workers periodically (jitter avoids all workers restarting at once);
# bounds slow memory growth from carrier SDK caches and Sentry spans.
max_requests = 1000
max_requests_jitter = 100
# Import Django once in the master and fork: faster worker (re)starts, shared
# code pages between workers, and a broken settings module fails at boot
# instead of in a restart loop.
preload_app = True


def _close_django_db_connections():
    from django.db import connections

    connections.close_all()


def when_ready(server):
    # preload_app imports Django in the master and some apps touch the DB at
    # import time (Django's "Accessing the database during app initialization"
    # warning). A Postgres socket inherited across fork() would be shared by
    # every worker -> protocol errors. Close it in the master before forking.
    _close_django_db_connections()


def post_fork(server, worker):
    # Belt and braces: whatever survived when_ready is closed per worker
    # before it serves a request, so each worker opens its own connection.
    _close_django_db_connections()
