FROM python:3.10-slim

# create data directory for persistnet storage
RUN mkdir -p /data

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# ensure environment variable for DB
ENV DB_PATH=/data/inventory.db
ENV PYTHONUNBUFFERED=1

# Expose API on 5000 and UI on 5001
EXPOSE 5000 5001

# Start only API by default (compose can run the optional UI separately)
CMD ["python", "api.py"]
