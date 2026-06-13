from flask import Flask, jsonify, request

from .config import Settings
from .models import VALID_STATUSES
from .sync import SyncService


def create_app(settings=None):
    settings = settings or Settings.from_env()
    service = SyncService(settings)
    app = Flask(__name__)

    if settings.enable_cors:
        from flask_cors import CORS

        CORS(app)

    @app.get("/health")
    def health():
        return jsonify({"status": "ok"})

    @app.route("/sync", methods=["GET", "POST"])
    def sync_once():
        result = service.run_once()
        return jsonify({"message": "Todos synced.", "sync": result.to_dict()})

    @app.get("/tasks")
    def get_tasks():
        tasks = [task.to_dict() for task in service.get_local_tasks()]
        return jsonify({"tasks": tasks})

    @app.post("/tasks/update")
    def update_task():
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "Invalid JSON data"}), 400

        uid = data.get("uid")
        content = data.get("content")
        status = data.get("status")
        source_file = data.get("source_file")
        if not uid and not content:
            return jsonify({"error": "uid or content is required"}), 400
        if not status:
            return jsonify({"error": "status is required"}), 400
        if status not in VALID_STATUSES:
            return jsonify({"error": f"status must be one of {sorted(VALID_STATUSES)}"}), 400

        task = service.update_local_task(content=content, status=status, source_file=source_file, uid=uid)
        if task is None:
            return jsonify({"error": "Task not found or ambiguous; include uid or source_file"}), 404

        return jsonify({"task": task.to_dict()})

    return app
