import json

from strawberry.extensions import SchemaExtension

from karrio.server.graph.tests.base import GraphTestCase
import karrio.server.graph.schema as schema


class TestSchemaExtensions(GraphTestCase):
    def test_cache_extensions_are_instances(self):
        # A factory in this list is called as ext(execution_context=None) by
        # the pinned strawberry, which ParserCache/ValidationCache reject;
        # the dev environment may run a newer strawberry that calls ext() and
        # hides that, so the shape is checked here rather than the behaviour.
        for extension in schema.schema.extensions:
            self.assertIsInstance(extension, SchemaExtension)

    def test_query_executes_through_the_view(self):
        response = self.client.post(
            "/graphql",
            data=json.dumps({"query": "{ __typename }"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"data": {"__typename": "Query"}})
