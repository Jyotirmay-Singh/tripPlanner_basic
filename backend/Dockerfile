# Trip Splitter FastAPI backend image.
# All runtime deps (incl. bcrypt for hashing and python-multipart for receipt uploads) are
# pinned in requirements.txt.
FROM python:3.11-slim

WORKDIR /app

# Install dependencies first so this layer is cached across code-only changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code. .dockerignore keeps out .venv, caches, logs, tests, and .env.
COPY . .

EXPOSE 8000

# MONGO_URL and the rest of the env are injected by docker-compose (environment + env_file).
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
