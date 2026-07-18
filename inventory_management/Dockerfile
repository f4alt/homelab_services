FROM python:3.10-slim

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
