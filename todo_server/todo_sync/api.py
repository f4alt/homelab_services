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

    @app.post("/sync")
    def sync_once():
        result = service.run_once()
        return jsonify({"message": "Todos synced.", "sync": result.to_dict()})

    @app.get("/tasks")
    def get_tasks():
        tasks = [task.to_dict() for task in service.get_local_tasks()]
        return jsonify({"tasks": tasks})

    @app.get("/time-since")
    def get_time_since():
        return jsonify({"items": service.get_time_since_items()})

    @app.post("/tasks/update")
    def update_task():
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "Invalid JSON data"}), 400

        uid = data.get("uid")
        status = data.get("status")
        if not uid:
            return jsonify({"error": "uid is required"}), 400
        if not status:
            return jsonify({"error": "status is required"}), 400
        if status not in VALID_STATUSES:
            return jsonify({"error": f"status must be one of {sorted(VALID_STATUSES)}"}), 400

        task = service.update_local_task(uid=uid, status=status)
        if task is None:
            return jsonify({"error": "Task not found"}), 404

        return jsonify({"task": task.to_dict()})

    return app
