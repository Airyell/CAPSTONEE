FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libgl1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-ocr.txt .
RUN pip install --no-cache-dir -r requirements-ocr.txt
COPY . .

CMD gunicorn ocr_server:app --bind 0.0.0.0:$PORT --workers 1 --timeout 180 --preload