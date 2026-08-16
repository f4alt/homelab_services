FROM python:3.10-slim@sha256:a45c323edaa44976ef63b9a85e0d3bd7bbf31676029dccfbc119f88a65311852

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
