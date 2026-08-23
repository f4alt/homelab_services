import logging
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from api import create_app, run_server


class InventoryApiTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "inventory.db")
        self.app = create_app(self.db_path)
        self.client = self.app.test_client()

    def tearDown(self):
        self.temp_dir.cleanup()

    def create_item(self, **overrides):
        payload = {
            "object_name": "AA Batteries",
            "qnty": 8,
            "location": "Utility drawer",
            "category_tags": ["power", "small"],
        }
        payload.update(overrides)
        return self.client.post("/items", json=payload)

    def test_root_serves_debug_interface(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Inventory Manager", response.data)
        self.assertIn(b"/static/app.js", response.data)

    def test_app_creation_initializes_its_configured_database(self):
        self.assertTrue(os.path.exists(self.db_path))

    def test_import_does_not_initialize_a_database(self):
        project_dir = os.path.dirname(os.path.dirname(__file__))
        environment = os.environ.copy()
        environment["PYTHONPATH"] = project_dir

        with tempfile.TemporaryDirectory() as working_dir:
            configured_db_path = os.path.join(working_dir, "configured.db")
            environment["DB_PATH"] = configured_db_path
            result = subprocess.run(
                [sys.executable, "-c", "import api"],
                cwd=working_dir,
                env=environment,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(os.path.exists(configured_db_path))

    def test_server_suppresses_routine_access_logs(self):
        with (
            patch("api.create_app") as create_app_mock,
            patch("api.logging.getLogger") as get_logger,
            patch.dict(os.environ, {"API_PORT": "5100"}),
        ):
            run_server()

        get_logger.assert_called_once_with("werkzeug")
        get_logger.return_value.setLevel.assert_called_once_with(logging.WARNING)
        create_app_mock.return_value.run.assert_called_once_with(host="0.0.0.0", port=5100)

    def test_create_get_list_update_delete_item(self):
        create_response = self.create_item()
        self.assertEqual(create_response.status_code, 201)
        created = create_response.get_json()["item"]
        self.assertEqual(created["object_name"], "AA Batteries")
        self.assertEqual(created["category_tags"], ["power", "small"])

        item_id = created["id"]
        get_response = self.client.get(f"/items/{item_id}")
        self.assertEqual(get_response.status_code, 200)
        self.assertEqual(get_response.get_json()["item"]["qnty"], 8)

        list_response = self.client.get("/items")
        self.assertEqual(list_response.status_code, 200)
        self.assertEqual(list_response.get_json()["count"], 1)

        update_response = self.client.put(f"/items/{item_id}", json={"qnty": 10})
        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.get_json()["item"]["qnty"], 10)
        self.assertEqual(update_response.get_json()["item"]["object_name"], "AA Batteries")

        delete_response = self.client.delete(f"/items/{item_id}")
        self.assertEqual(delete_response.status_code, 200)
        self.assertEqual(delete_response.get_json(), {"message": "deleted", "id": item_id})

        missing_response = self.client.get(f"/items/{item_id}")
        self.assertEqual(missing_response.status_code, 404)

    def test_create_validation_rejects_missing_and_invalid_fields(self):
        missing_response = self.client.post("/items", json={"object_name": "Tape"})
        self.assertEqual(missing_response.status_code, 400)
        self.assertIn("qnty is required", missing_response.get_json()["error"]["details"])

        invalid_response = self.client.post(
            "/items",
            json={
                "object_name": " ",
                "qnty": -1,
                "location": 123,
                "category_tags": ["tools", 42],
            },
        )
        self.assertEqual(invalid_response.status_code, 400)
        details = invalid_response.get_json()["error"]["details"]
        self.assertIn("object_name must be a non-empty string", details)
        self.assertIn("qnty must be greater than or equal to 0", details)
        self.assertIn("location must be a string", details)
        self.assertIn("category_tags must be a list of strings", details)

    def test_malformed_and_non_object_json_return_400(self):
        malformed_response = self.client.post(
            "/items",
            data="{",
            content_type="application/json",
        )
        self.assertEqual(malformed_response.status_code, 400)
        self.assertEqual(malformed_response.get_json()["error"]["code"], "bad_request")

        array_response = self.client.post("/items", json=[])
        self.assertEqual(array_response.status_code, 400)
        self.assertEqual(array_response.get_json()["error"]["code"], "bad_request")

    def test_update_validation_and_missing_item(self):
        created = self.create_item().get_json()["item"]

        empty_response = self.client.put(f"/items/{created['id']}", json={})
        self.assertEqual(empty_response.status_code, 400)

        bad_response = self.client.put(f"/items/{created['id']}", json={"qnty": "many"})
        self.assertEqual(bad_response.status_code, 400)

        missing_response = self.client.put("/items/999", json={"qnty": 1})
        self.assertEqual(missing_response.status_code, 404)

    def test_delete_missing_item_returns_404(self):
        response = self.client.delete("/items/999")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"]["code"], "not_found")

    def test_search_query_matches_name_location_and_tags(self):
        self.create_item(object_name="Hammer", location="Garage", category_tags=["tools"])
        self.create_item(object_name="Flour", location="Pantry", category_tags=["baking"])

        name_response = self.client.get("/items?q=hamm")
        self.assertEqual(name_response.status_code, 200)
        self.assertEqual(name_response.get_json()["count"], 1)
        self.assertEqual(name_response.get_json()["items"][0]["object_name"], "Hammer")

        location_response = self.client.get("/items?q=pantry")
        self.assertEqual(location_response.get_json()["items"][0]["object_name"], "Flour")

        tag_response = self.client.get("/items?q=tools")
        self.assertEqual(tag_response.get_json()["items"][0]["object_name"], "Hammer")

        all_response = self.client.get("/items?q=*")
        self.assertEqual(all_response.get_json()["count"], 2)

    def test_search_preserves_normalization_fuzzy_thresholds_and_ordering(self):
        self.create_item(object_name="Hammer", location="Garage", category_tags=["tools"])
        self.create_item(object_name="Flour", location="Pantry", category_tags=["baking"])

        normalized_response = self.client.get("/items", query_string={"q": " HaMr "})
        self.assertEqual(
            [item["object_name"] for item in normalized_response.get_json()["items"]],
            ["Hammer"],
        )

        short_fuzzy_response = self.client.get("/items", query_string={"q": "hm"})
        self.assertEqual(short_fuzzy_response.get_json()["count"], 1)

        long_fuzzy_response = self.client.get("/items", query_string={"q": "hammre"})
        self.assertEqual(long_fuzzy_response.get_json()["count"], 0)

        wildcard_response = self.client.get("/items", query_string={"q": " * "})
        self.assertEqual(
            [item["object_name"] for item in wildcard_response.get_json()["items"]],
            ["Flour", "Hammer"],
        )

        empty_response = self.client.get("/items", query_string={"q": "  "})
        self.assertEqual(empty_response.get_json(), {"items": [], "count": 0})


if __name__ == "__main__":
    unittest.main()
