import os

import requests
from flask import Flask, jsonify, render_template, request


API_URL = os.environ.get("API_URL", "http://127.0.0.1:5000").rstrip("/")
REQUEST_TIMEOUT = float(os.environ.get("API_TIMEOUT", "5"))

app = Flask(__name__, template_folder="templates", static_folder="static")


def api_request(method, path, **kwargs):
    try:
        response = requests.request(
            method,
            f"{API_URL}{path}",
            timeout=REQUEST_TIMEOUT,
            **kwargs,
        )
    except requests.RequestException as exc:
        return jsonify({"error": {"code": "api_unavailable", "message": str(exc)}}), 502

    return response.text, response.status_code, {"Content-Type": "application/json"}


@app.route("/", methods=["GET"])
def index():
    return render_template("index.html")


@app.route("/search")
def search():
    query = request.args.get("q", "")
    return api_request("GET", "/items", params={"q": query})


@app.route("/create", methods=["POST"])
def create():
    return api_request("POST", "/items", json=request.get_json(silent=True) or {})


@app.route("/update", methods=["PUT"])
def update():
    data = request.get_json(silent=True) or {}
    item_id = data.get("id")
    if item_id is None:
        return jsonify({"error": {"code": "bad_request", "message": "id is required"}}), 400

    item_data = {key: value for key, value in data.items() if key != "id"}
    return api_request("PUT", f"/items/{item_id}", json=item_data)


@app.route("/delete", methods=["DELETE"])
def delete():
    data = request.get_json(silent=True) or {}
    item_id = data.get("id")
    if item_id is None:
        return jsonify({"error": {"code": "bad_request", "message": "id is required"}}), 400
    return api_request("DELETE", f"/items/{item_id}")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("WEB_PORT", "5001")))
