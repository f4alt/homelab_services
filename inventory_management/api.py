import json
import os
import sqlite3
from contextlib import closing

from flask import Flask, jsonify, request
from rapidfuzz import fuzz


DEFAULT_DB_PATH = os.path.join("data", "inventory.db")
ITEM_FIELDS = ("object_name", "qnty", "location", "category_tags")


class ApiError(Exception):
    def __init__(self, message, status_code=400, code="bad_request", details=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.details = details or []


def create_app(db_path=None, initialize=True):
    app = Flask(__name__)
    app.config["DB_PATH"] = db_path or os.environ.get("DB_PATH", DEFAULT_DB_PATH)
    app.config["DB_INITIALIZED"] = False

    @app.before_request
    def ensure_db_initialized():
        if not app.config["DB_INITIALIZED"]:
            init_db(app.config["DB_PATH"])
            app.config["DB_INITIALIZED"] = True

    @app.errorhandler(ApiError)
    def handle_api_error(error):
        payload = {
            "error": {
                "code": error.code,
                "message": error.message,
            }
        }
        if error.details:
            payload["error"]["details"] = error.details
        return jsonify(payload), error.status_code

    @app.errorhandler(404)
    def handle_not_found(_error):
        return jsonify({"error": {"code": "not_found", "message": "Resource not found"}}), 404

    @app.errorhandler(405)
    def handle_method_not_allowed(_error):
        return (
            jsonify({"error": {"code": "method_not_allowed", "message": "Method not allowed"}}),
            405,
        )

    @app.errorhandler(Exception)
    def handle_unexpected_error(error):
        app.logger.exception("Unhandled API error: %s", error)
        return (
            jsonify({"error": {"code": "internal_error", "message": "Internal server error"}}),
            500,
        )

    @app.route("/items", methods=["POST"])
    def create_item():
        data = get_json_body()
        item_data = validate_item_payload(data, require_all=True)

        with closing(get_db_connection(app.config["DB_PATH"])) as conn:
            cursor = conn.execute(
                """
                INSERT INTO items (object_name, qnty, location, category_tags)
                VALUES (?, ?, ?, ?)
                """,
                (
                    item_data["object_name"],
                    item_data["qnty"],
                    item_data["location"],
                    json.dumps(item_data["category_tags"]),
                ),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM items WHERE id = ?", (cursor.lastrowid,)).fetchone()

        return jsonify({"item": serialize_item(row)}), 201

    @app.route("/items", methods=["GET"])
    def list_items():
        query = request.args.get("q")
        with closing(get_db_connection(app.config["DB_PATH"])) as conn:
            rows = conn.execute("SELECT * FROM items ORDER BY lower(object_name), id").fetchall()

        items = [serialize_item(row) for row in rows]
        if query is not None:
            items = search_items(items, query.strip())
        return jsonify({"items": items, "count": len(items)})

    @app.route("/items/<int:item_id>", methods=["GET"])
    def get_item(item_id):
        item = fetch_item_or_404(app.config["DB_PATH"], item_id)
        return jsonify({"item": item})

    @app.route("/items/<int:item_id>", methods=["PUT"])
    def update_item(item_id):
        data = get_json_body()
        item_data = validate_item_payload(data, require_all=False)
        if not item_data:
            raise ApiError("At least one item field is required", details=list(ITEM_FIELDS))

        assignments = []
        values = []
        for key in ITEM_FIELDS:
            if key not in item_data:
                continue
            assignments.append(f"{key} = ?")
            values.append(json.dumps(item_data[key]) if key == "category_tags" else item_data[key])
        values.append(item_id)

        with closing(get_db_connection(app.config["DB_PATH"])) as conn:
            cursor = conn.execute(
                f"UPDATE items SET {', '.join(assignments)} WHERE id = ?",
                values,
            )
            if cursor.rowcount == 0:
                raise ApiError(f"Item {item_id} was not found", status_code=404, code="not_found")
            conn.commit()
            row = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()

        return jsonify({"item": serialize_item(row)})

    @app.route("/items/<int:item_id>", methods=["DELETE"])
    def delete_item(item_id):
        with closing(get_db_connection(app.config["DB_PATH"])) as conn:
            cursor = conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
            if cursor.rowcount == 0:
                raise ApiError(f"Item {item_id} was not found", status_code=404, code="not_found")
            conn.commit()

        return jsonify({"message": "deleted", "id": item_id})

    if initialize:
        init_db(app.config["DB_PATH"])
        app.config["DB_INITIALIZED"] = True
    return app


def get_db_connection(db_path):
    db_dir = os.path.dirname(db_path)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path=None):
    resolved_db_path = db_path or os.environ.get("DB_PATH", DEFAULT_DB_PATH)
    with closing(get_db_connection(resolved_db_path)) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                object_name TEXT NOT NULL,
                qnty INTEGER NOT NULL,
                location TEXT,
                category_tags TEXT NOT NULL DEFAULT '[]'
            )
            """
        )
        conn.commit()


def get_json_body():
    if not request.is_json:
        raise ApiError("Request body must be JSON")
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Request body must be a JSON object")
    return data


def validate_item_payload(data, require_all):
    errors = []
    validated = {}

    unknown_fields = sorted(set(data) - set(ITEM_FIELDS))
    if unknown_fields:
        errors.append(f"Unknown field(s): {', '.join(unknown_fields)}")

    required_fields = ("object_name", "qnty") if require_all else ()
    for field in required_fields:
        if field not in data:
            errors.append(f"{field} is required")

    if "object_name" in data:
        if not isinstance(data["object_name"], str) or not data["object_name"].strip():
            errors.append("object_name must be a non-empty string")
        else:
            validated["object_name"] = data["object_name"].strip()

    if "qnty" in data:
        if isinstance(data["qnty"], bool) or not isinstance(data["qnty"], int):
            errors.append("qnty must be an integer")
        elif data["qnty"] < 0:
            errors.append("qnty must be greater than or equal to 0")
        else:
            validated["qnty"] = data["qnty"]

    if "location" in data:
        if data["location"] is None:
            validated["location"] = ""
        elif not isinstance(data["location"], str):
            errors.append("location must be a string")
        else:
            validated["location"] = data["location"].strip()
    elif require_all:
        validated["location"] = ""

    if "category_tags" in data:
        if not isinstance(data["category_tags"], list):
            errors.append("category_tags must be a list of strings")
        else:
            tags = []
            for tag in data["category_tags"]:
                if not isinstance(tag, str):
                    errors.append("category_tags must be a list of strings")
                    break
                tag = tag.strip()
                if tag:
                    tags.append(tag)
            validated["category_tags"] = tags
    elif require_all:
        validated["category_tags"] = []

    if errors:
        raise ApiError("Invalid item payload", details=errors)
    return validated


def serialize_item(row):
    tags = row["category_tags"] or "[]"
    try:
        category_tags = json.loads(tags)
    except json.JSONDecodeError:
        category_tags = []

    return {
        "id": row["id"],
        "object_name": row["object_name"],
        "qnty": row["qnty"],
        "location": row["location"] or "",
        "category_tags": category_tags,
    }


def fetch_item_or_404(db_path, item_id):
    with closing(get_db_connection(db_path)) as conn:
        row = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        raise ApiError(f"Item {item_id} was not found", status_code=404, code="not_found")
    return serialize_item(row)


def search_items(items, query):
    if query == "*":
        return items
    if not query:
        return []

    normalized_query = query.lower()
    return [item for item in items if item_matches(item, normalized_query)]


def item_matches(item, query):
    fields = [item.get("object_name", ""), item.get("location", "")]
    fields.extend(item.get("category_tags", []))

    if len(query) < 3:
        threshold = 60
        scorer = fuzz.partial_ratio
    elif len(query) < 6:
        threshold = 75
        scorer = fuzz.partial_ratio
    else:
        threshold = 88
        scorer = fuzz.ratio

    for field in fields:
        value = str(field).lower()
        if not value:
            continue
        if query in value or scorer(query, value) >= threshold:
            return True
    return False


app = create_app(initialize=False)


if __name__ == "__main__":
    init_db(app.config["DB_PATH"])
    app.config["DB_INITIALIZED"] = True
    app.run(host="0.0.0.0", port=int(os.environ.get("API_PORT", "5000")))
