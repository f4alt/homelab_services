FROM python:3.10-slim@sha256:a78e4529630cfe8c5199cafd6e0c28ee1579a13f86274396d8b6b2d80367aa3a

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY api.py .
COPY static/ static/
COPY templates/ templates/

# ensure environment variable for DB
ENV DB_PATH=/data/inventory.db
ENV PYTHONUNBUFFERED=1

# Expose the API and optional debug GUI
EXPOSE 5000

CMD ["python", "api.py"]
