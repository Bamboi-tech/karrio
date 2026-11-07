from django.apps import AppConfig


class GraphConfig(AppConfig):
    name = 'karrio.server.graph'

    def ready(self):
        from karrio.server.graph import warm_cache

        warm_cache.register_signals()
