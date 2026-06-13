FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml README.md ./
COPY todo_sync ./todo_sync

RUN pip install --no-cache-dir .

ENV TODO_DIRECTORY=/data/todo_files \
    CALDAV_URL=https://radicale:5232/ \
    CALDAV_USERNAME=todo \
    CALDAV_PASSWORD=todo \
    CALDAV_VERIFY_SSL=false \
    SYNC_STATE_FILE=/data/todo_files/.todo-sync-state.json \
    API_HOST=0.0.0.0 \
    API_PORT=5000

EXPOSE 5000

CMD ["todo-sync", "serve"]
