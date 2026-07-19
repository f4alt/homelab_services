FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml README.md ./
COPY todo_sync ./todo_sync

RUN pip install --no-cache-dir .

EXPOSE 5000

CMD ["todo-sync", "serve"]
