FROM python:3.12-slim@sha256:dd29372629eeba2dd003fd9e9d35a5b8236c44727875a0364254b5127af88e65

WORKDIR /app

COPY pyproject.toml README.md ./
COPY todo_sync ./todo_sync

RUN pip install --no-cache-dir .

EXPOSE 5000

CMD ["todo-sync", "serve"]
